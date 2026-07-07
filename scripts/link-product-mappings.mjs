#!/usr/bin/env node
import { join } from "path";
import { writeFileSync } from "fs";
import { config } from "./lib/config.mjs";
import { readJson, writeJson, ensureDir } from "./lib/fs-utils.mjs";
import { createWooClient, updateOne } from "./lib/woo-client.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const options = { help: false, apply: false, json: null, csv: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--json" && argv[i + 1]) options.json = argv[++i];
    else if (arg === "--csv" && argv[i + 1]) options.csv = argv[++i];
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/link-product-mappings.mjs [options]

Match WooCommerce products to Shopify export by slug, handle meta, or title.
Updates mappings/shopify-to-woo.json and Woo _shopify_product_id / _shopify_handle meta.

Options:
  --apply       Write mappings and update WooCommerce (default: dry-run only)
  --json PATH   Proposal report JSON (default: export/link-proposals.json)
  --csv PATH    Proposal CSV (default: export/link-proposals.csv)
  -h, --help    Show this help

Run on Kinsta (same host as Woo API). Dry-run first, then --apply.
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

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Known Shopify renames: old Woo title fragment → current export title */
const TITLE_ALIASES = [
  ["ret a 10", "rta 10"],
  ["ret a 20", "rta 20"],
  ["ret a 30", "rta 30"],
  ["tir z 30", "tz 30"],
  ["tirz 30", "tz 30"],
];

function titleAliasMatch(wooName, shopifyTitle) {
  const wooNorm = normalizeName(wooName);
  const shopNorm = normalizeName(shopifyTitle);
  if (wooNorm === shopNorm) return true;
  for (const [from, to] of TITLE_ALIASES) {
    if (wooNorm.includes(from) && shopNorm.includes(to)) return true;
  }
  return false;
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

function buildShopifyCatalog(products) {
  const byId = new Map();
  const byHandle = new Map();
  const byTitle = new Map();

  for (const product of products) {
    const id = normalizeShopifyId(product.id);
    byId.set(id, product);
    if (product.handle) byHandle.set(product.handle, product);
    const titleKey = normalizeName(product.title);
    if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, product);
  }

  return { byId, byHandle, byTitle, ids: new Set(byId.keys()) };
}

function reverseMappings(mappings) {
  const wooToShopify = new Map();
  for (const [shopifyId, wooId] of Object.entries(mappings.products || {})) {
    wooToShopify.set(Number(wooId), shopifyId);
  }
  return wooToShopify;
}

function wooIdsInMappings(mappings) {
  return new Set(
    Object.values(mappings.products || {}).map((id) => Number(id))
  );
}

function isWooStaleForLink(woo, exportShopifyIds) {
  const metaId = normalizeShopifyId(metaValue(woo, "_shopify_product_id"));
  if (!metaId) return true;
  return !exportShopifyIds.has(metaId);
}

function findMatchReason(woo, shopify) {
  const handle = shopify.handle;
  const shopifyHandleMeta = metaValue(woo, "_shopify_handle");

  if (woo.slug && handle && woo.slug === handle) {
    return "slug_equals_shopify_handle";
  }
  if (shopifyHandleMeta && handle && shopifyHandleMeta === handle) {
    return "woo_shopify_handle_meta";
  }
  if (titleAliasMatch(woo.name, shopify.title)) {
    return "title_or_alias";
  }
  return null;
}

function toCsvRow(values) {
  return values
    .map((v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

function removeStaleMappingsForWooId(mappings, wooId, keepShopifyId) {
  const removed = [];
  for (const [shopifyId, mappedWooId] of Object.entries(mappings.products || {})) {
    if (Number(mappedWooId) === Number(wooId) && shopifyId !== keepShopifyId) {
      delete mappings.products[shopifyId];
      removed.push(shopifyId);
    }
  }
  return removed;
}

async function applyLink(woo, mappings, link) {
  const removed = removeStaleMappingsForWooId(
    mappings,
    link.woo_id,
    link.shopify_id
  );

  mappings.products[link.shopify_id] = link.woo_id;

  await updateOne(woo, "products", link.woo_id, {
    meta_data: [
      { key: "_shopify_product_id", value: link.shopify_id },
      { key: "_shopify_handle", value: link.shopify_handle },
    ],
  });

  return removed;
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }

  const shopifyProducts = readJson(config.paths.products, []);
  if (!shopifyProducts.length) {
    console.error("No export/products.json. Run: npm run export:products");
    process.exit(1);
  }

  const mappings = readJson(config.paths.mappings, {
    products: {},
    customers: {},
    orders: {},
    variants: {},
  });
  mappings.products = mappings.products || {};

  const catalog = buildShopifyCatalog(shopifyProducts);
  const wooToShopify = reverseMappings(mappings);
  const mappedWooIds = wooIdsInMappings(mappings);

  const woo = await createWooClient({ silent: true });
  console.log(`Fetching WooCommerce products from ${config.woo.url}...`);
  const wooProducts = await fetchAllWooProducts(woo);
  const wooById = new Map(wooProducts.map((p) => [p.id, p]));

  const claimedWooIds = new Set();
  const alreadyLinked = [];

  for (const shopify of shopifyProducts) {
    const shopifyId = normalizeShopifyId(shopify.id);
    const mappedWooId = mappings.products[shopifyId];

    if (mappedWooId && wooById.has(mappedWooId)) {
      const woo = wooById.get(mappedWooId);
      const metaId = normalizeShopifyId(metaValue(woo, "_shopify_product_id"));
      if (metaId === shopifyId) {
        claimedWooIds.add(mappedWooId);
        alreadyLinked.push({
          shopify_id: shopifyId,
          shopify_title: shopify.title,
          woo_id: mappedWooId,
          woo_name: woo.name,
        });
      }
    }
  }

  const proposals = [];
  const skipped = [];

  for (const shopify of shopifyProducts) {
    const shopifyId = normalizeShopifyId(shopify.id);

    if (mappings.products[shopifyId]) {
      const wooId = mappings.products[shopifyId];
      const woo = wooById.get(wooId);
      if (woo) {
        const metaId = normalizeShopifyId(metaValue(woo, "_shopify_product_id"));
        if (metaId === shopifyId) continue;
      }
    }

    let best = null;

    for (const woo of wooProducts) {
      if (claimedWooIds.has(woo.id)) continue;

      const mappedShopifyForWoo = wooToShopify.get(woo.id);
      if (
        mappedShopifyForWoo &&
        catalog.ids.has(mappedShopifyForWoo) &&
        mappedShopifyForWoo !== shopifyId
      ) {
        continue;
      }

      const reason = findMatchReason(woo, shopify);
      if (!reason) continue;

      const stale = isWooStaleForLink(woo, catalog.ids);
      const hasNoMeta = !metaValue(woo, "_shopify_product_id");
      if (!stale && !hasNoMeta && mappedShopifyForWoo === shopifyId) continue;

      const score =
        reason === "slug_equals_shopify_handle"
          ? 3
          : reason === "woo_shopify_handle_meta"
            ? 2
            : 1;

      if (!best || score > best.score) {
        best = { woo, reason, score, stale, hasNoMeta };
      }
    }

    if (!best) {
      skipped.push({
        shopify_id: shopifyId,
        shopify_title: shopify.title,
        shopify_handle: shopify.handle,
        reason: "no_woo_match",
      });
      continue;
    }

    const conflict = [...proposals].find((p) => p.woo_id === best.woo.id);
    if (conflict) {
      skipped.push({
        shopify_id: shopifyId,
        shopify_title: shopify.title,
        shopify_handle: shopify.handle,
        reason: "woo_id_already_proposed",
        conflicts_with: conflict.shopify_title,
      });
      continue;
    }

    proposals.push({
      shopify_id: shopifyId,
      shopify_title: shopify.title,
      shopify_handle: shopify.handle,
      woo_id: best.woo.id,
      woo_name: best.woo.name,
      woo_slug: best.woo.slug,
      match_reason: best.reason,
      woo_stale_shopify_meta: best.stale,
      woo_missing_shopify_meta: best.hasNoMeta,
      old_shopify_id: normalizeShopifyId(
        metaValue(best.woo, "_shopify_product_id")
      ),
    });
    claimedWooIds.add(best.woo.id);
  }

  console.log(`\nShopify export: ${shopifyProducts.length} products`);
  console.log(`WooCommerce:    ${wooProducts.length} products`);
  console.log(`Already linked: ${alreadyLinked.length}`);
  console.log(`Proposed links: ${proposals.length}`);
  console.log(`Unmatched:      ${skipped.length}`);

  if (proposals.length) {
    console.log("\nProposed mappings (Shopify → WooCommerce):");
    for (const p of proposals) {
      console.log(`  ${p.shopify_title} → WC #${p.woo_id} "${p.woo_name}"`);
      console.log(
        `    match: ${p.match_reason}` +
          (p.old_shopify_id ? ` | was ${p.old_shopify_id}` : " | no prior meta")
      );
    }
  }

  if (skipped.length) {
    console.log("\nNo automatic match (will be created on import):");
    for (const s of skipped) {
      if (s.reason === "no_woo_match") {
        console.log(`  ${s.shopify_title} (${s.shopify_handle})`);
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.apply ? "apply" : "dry-run",
    wooUrl: config.woo.url,
    alreadyLinked,
    proposals,
    skipped,
  };

  const jsonPath = options.json || join(config.paths.exportDir, "link-proposals.json");
  const csvPath = options.csv || join(config.paths.exportDir, "link-proposals.csv");
  writeJson(jsonPath, report);

  const csvRows = [
    toCsvRow([
      "shopify_id",
      "shopify_title",
      "shopify_handle",
      "woo_id",
      "woo_name",
      "woo_slug",
      "match_reason",
      "old_shopify_id",
    ]),
  ];
  for (const p of proposals) {
    csvRows.push(
      toCsvRow([
        p.shopify_id,
        p.shopify_title,
        p.shopify_handle,
        p.woo_id,
        p.woo_name,
        p.woo_slug,
        p.match_reason,
        p.old_shopify_id || "",
      ])
    );
  }
  ensureDir(config.paths.exportDir);
  writeFileSync(csvPath, `${csvRows.join("\n")}\n`, "utf8");

  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${csvPath}`);

  if (!options.apply) {
    console.log("\nDry run only. Re-run with --apply to save mappings and update Woo meta.");
    return;
  }

  if (!proposals.length) {
    console.log("\nNothing to apply.");
    return;
  }

  console.log("\nApplying links...");
  const applied = [];

  for (const link of proposals) {
    const removed = await applyLink(woo, mappings, link);
    applied.push({ ...link, removed_stale_mappings: removed });
    console.log(`  Linked ${link.shopify_title} → WC #${link.woo_id}`);
    if (removed.length) {
      console.log(`    Removed stale mapping(s): ${removed.join(", ")}`);
    }
  }

  writeJson(config.paths.mappings, mappings);
  report.applied = applied;
  writeJson(jsonPath, report);

  console.log(`\nUpdated ${config.paths.mappings}`);
  console.log("Next: npm run import:products  (update linked + create remaining new products)");
  console.log("Then: npm run audit:products");
}

main().catch((err) => {
  console.error(err.response?.data?.message || err.message);
  process.exit(1);
});
