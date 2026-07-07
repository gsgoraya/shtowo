#!/usr/bin/env node
import { join } from "path";
import { writeFileSync } from "fs";
import { config } from "./lib/config.mjs";
import { readJson, writeJson, ensureDir } from "./lib/fs-utils.mjs";
import { createWooClient } from "./lib/woo-client.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const options = { help: false, json: null, csv: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json" && argv[i + 1]) options.json = argv[++i];
    else if (arg === "--csv" && argv[i + 1]) options.csv = argv[++i];
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/audit-product-sync.mjs [options]

Compare WooCommerce products against export/products.json and report extras.

Options:
  --json PATH   Write full report JSON (default: export/woo-product-audit.json)
  --csv PATH    Write CSV of problem products (default: export/woo-product-audit.csv)
  -h, --help    Show this help
`);
}

function metaValue(product, key) {
  const entry = product.meta_data?.find((m) => m.key === key);
  return entry?.value != null ? String(entry.value) : null;
}

function normalizeShopifyId(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (s.startsWith("gid://")) return s;
  return `gid://shopify/Product/${s}`;
}

async function fetchAllWooProducts(woo) {
  const all = [];
  let page = 1;

  while (true) {
    const response = await woo.get("products", {
      per_page: 100,
      page,
      status: "any",
    });
    all.push(...response.data);

    const totalPages = Number.parseInt(response.headers["x-wp-totalpages"] || "1", 10);
    if (page >= totalPages) break;
    page++;
  }

  return all;
}

function toCsvRow(values) {
  return values
    .map((v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

function buildShopifyCatalog(products) {
  const byId = new Map();
  const byHandle = new Map();

  for (const product of products) {
    const id = normalizeShopifyId(product.id);
    byId.set(id, product);
    if (product.handle) byHandle.set(product.handle, product);
  }

  return { byId, byHandle, ids: new Set(byId.keys()) };
}

function reverseMappings(mappings) {
  const wooToShopify = {};
  for (const [shopifyId, wooId] of Object.entries(mappings.products || {})) {
    wooToShopify[wooId] = shopifyId;
  }
  return wooToShopify;
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }

  const shopifyProducts = readJson(config.paths.products, []);
  if (!shopifyProducts.length) {
    console.error("No export/products.json found. Run: npm run export:products");
    process.exit(1);
  }

  const mappings = readJson(config.paths.mappings, { products: {} });
  const wooToShopifyFromMapping = reverseMappings(mappings);
  const catalog = buildShopifyCatalog(shopifyProducts);

  const exportStatuses = {};
  for (const p of shopifyProducts) {
    exportStatuses[p.status] = (exportStatuses[p.status] || 0) + 1;
  }

  console.log(`Shopify export: ${shopifyProducts.length} products`);
  console.log(`  Statuses: ${Object.entries(exportStatuses).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (!exportStatuses.DRAFT && !exportStatuses.ARCHIVED) {
    console.log(
      "  Note: export appears active-only. Re-export with --include-drafts to compare drafts too."
    );
  }

  const woo = await createWooClient({ silent: true });
  console.log(`\nFetching WooCommerce products from ${config.woo.url}...`);
  const wooProducts = await fetchAllWooProducts(woo);
  console.log(`WooCommerce: ${wooProducts.length} products\n`);

  const wordpressOnly = [];
  const shopifyNotInExport = [];
  const mappingMismatch = [];
  const synced = [];

  const wooByShopifyId = new Map();

  for (const product of wooProducts) {
    const shopifyId = normalizeShopifyId(metaValue(product, "_shopify_product_id"));
    const mappedShopifyId = normalizeShopifyId(wooToShopifyFromMapping[product.id]);

    if (!shopifyId) {
      wordpressOnly.push({
        woo_id: product.id,
        name: product.name,
        slug: product.slug,
        status: product.status,
        sku: product.sku || "",
        reason: "no_shopify_meta",
        detail: "No _shopify_product_id meta — likely created manually in WordPress",
      });
      continue;
    }

    wooByShopifyId.set(shopifyId, product);

    if (mappedShopifyId && mappedShopifyId !== shopifyId) {
      mappingMismatch.push({
        woo_id: product.id,
        name: product.name,
        slug: product.slug,
        status: product.status,
        sku: product.sku || "",
        shopify_id: shopifyId,
        mapped_shopify_id: mappedShopifyId,
        reason: "mapping_meta_mismatch",
        detail: "Woo meta Shopify ID differs from mappings/shopify-to-woo.json",
      });
    } else if (mappedShopifyId && !catalog.ids.has(mappedShopifyId)) {
      mappingMismatch.push({
        woo_id: product.id,
        name: product.name,
        slug: product.slug,
        status: product.status,
        sku: product.sku || "",
        shopify_id: shopifyId,
        mapped_shopify_id: mappedShopifyId,
        reason: "mapped_id_missing_from_export",
        detail: "Mapping points to a Shopify product not in current export",
      });
    }

    if (!catalog.ids.has(shopifyId)) {
      const handle = metaValue(product, "_shopify_handle");
      const byHandle = handle ? catalog.byHandle.get(handle) : null;
      shopifyNotInExport.push({
        woo_id: product.id,
        name: product.name,
        slug: product.slug,
        status: product.status,
        sku: product.sku || "",
        shopify_id: shopifyId,
        shopify_handle: handle || "",
        reason: byHandle ? "shopify_id_changed" : "shopify_not_in_export",
        detail: byHandle
          ? `Handle "${handle}" exists in export under a different Shopify ID`
          : "Shopify product ID not found in export (deleted, draft, or archived)",
        export_match_handle: byHandle?.title || "",
      });
      continue;
    }

    synced.push({
      woo_id: product.id,
      name: product.name,
      shopify_id: shopifyId,
      shopify_title: catalog.byId.get(shopifyId)?.title || "",
    });
  }

  const missingInWoo = [];
  for (const shopifyProduct of shopifyProducts) {
    const shopifyId = normalizeShopifyId(shopifyProduct.id);
    const mappedWooId = mappings.products?.[shopifyId];
    const wooProduct = wooByShopifyId.get(shopifyId);

    if (!wooProduct && !mappedWooId) {
      missingInWoo.push({
        shopify_id: shopifyId,
        name: shopifyProduct.title,
        handle: shopifyProduct.handle,
        status: shopifyProduct.status,
        reason: "shopify_not_in_woocommerce",
        detail: "In Shopify export but no Woo product with matching _shopify_product_id",
      });
      continue;
    }

    if (!wooProduct && mappedWooId) {
      missingInWoo.push({
        shopify_id: shopifyId,
        name: shopifyProduct.title,
        handle: shopifyProduct.handle,
        status: shopifyProduct.status,
        mapped_woo_id: mappedWooId,
        reason: "mapping_points_to_missing_woo",
        detail: "Mapping exists but Woo product ID not found on site",
      });
    }
  }

  const extras = [...wordpressOnly, ...shopifyNotInExport];

  console.log("Summary");
  console.log(`  In sync:              ${synced.length}`);
  console.log(`  Extra on WordPress:   ${extras.length}`);
  console.log(`    No Shopify meta:    ${wordpressOnly.length}`);
  console.log(`    Stale Shopify link: ${shopifyNotInExport.length}`);
  console.log(`  Mapping issues:       ${mappingMismatch.length}`);
  console.log(`  Missing in WordPress: ${missingInWoo.length}`);

  if (extras.length) {
    console.log("\nExtra products on WordPress (not in current Shopify export):");
    for (const row of extras) {
      console.log(`  [${row.reason}] WC #${row.woo_id} — ${row.name}`);
      console.log(`    ${row.detail}`);
    }
  }

  if (mappingMismatch.length) {
    console.log("\nMapping issues:");
    for (const row of mappingMismatch) {
      console.log(`  WC #${row.woo_id} — ${row.name}: ${row.detail}`);
    }
  }

  if (missingInWoo.length) {
    console.log("\nShopify products missing from WordPress:");
    for (const row of missingInWoo) {
      console.log(`  [${row.status}] ${row.name} (${row.handle})`);
      console.log(`    ${row.detail}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    wooUrl: config.woo.url,
    counts: {
      shopify_export: shopifyProducts.length,
      woocommerce: wooProducts.length,
      synced: synced.length,
      extra_on_wordpress: extras.length,
      mapping_issues: mappingMismatch.length,
      missing_in_woocommerce: missingInWoo.length,
    },
    exportStatuses,
    synced,
    extra_on_wordpress: extras,
    mapping_issues: mappingMismatch,
    missing_in_woocommerce: missingInWoo,
  };

  const jsonPath = options.json || join(config.paths.exportDir, "woo-product-audit.json");
  const csvPath = options.csv || join(config.paths.exportDir, "woo-product-audit.csv");

  writeJson(jsonPath, report);

  const csvRows = [
    toCsvRow([
      "category",
      "woo_id",
      "name",
      "slug",
      "status",
      "sku",
      "shopify_id",
      "shopify_handle",
      "reason",
      "detail",
    ]),
  ];

  for (const row of extras) {
    csvRows.push(
      toCsvRow([
        "extra_on_wordpress",
        row.woo_id,
        row.name,
        row.slug,
        row.status,
        row.sku,
        row.shopify_id || "",
        row.shopify_handle || "",
        row.reason,
        row.detail,
      ])
    );
  }
  for (const row of mappingMismatch) {
    csvRows.push(
      toCsvRow([
        "mapping_issue",
        row.woo_id,
        row.name,
        row.slug,
        row.status,
        row.sku,
        row.shopify_id || row.mapped_shopify_id || "",
        "",
        row.reason,
        row.detail,
      ])
    );
  }
  for (const row of missingInWoo) {
    csvRows.push(
      toCsvRow([
        "missing_in_woocommerce",
        row.mapped_woo_id || "",
        row.name,
        row.handle,
        row.status,
        "",
        row.shopify_id,
        row.handle,
        row.reason,
        row.detail,
      ])
    );
  }

  ensureDir(config.paths.exportDir);
  writeFileSync(csvPath, `${csvRows.join("\n")}\n`, "utf8");

  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${csvPath}`);
}

main().catch((err) => {
  console.error(err.response?.data?.message || err.message);
  process.exit(1);
});
