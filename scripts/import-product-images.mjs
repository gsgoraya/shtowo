#!/usr/bin/env node
/**
 * Add product images in a second pass (one product per request).
 * Use after: npm run import:products  (which skips images by default)
 */
import { config } from "./lib/config.mjs";
import { parseArgs } from "./lib/cli.mjs";
import { readJson } from "./lib/fs-utils.mjs";
import { productToWoo } from "./lib/transform.mjs";
import { createWooClient, updateOne, verifyWooCredentials } from "./lib/woo-client.mjs";

async function wooHasImages(woo, wooId) {
  const response = await woo.get(`products/${wooId}`, { _fields: "id,images" });
  return (response.data.images?.length || 0) > 0;
}

async function main() {
  const options = parseArgs();
  const products = readJson(config.paths.products, []);
  const mappings = readJson(config.paths.mappings, { products: {} });
  const limited = options.limit ? products.slice(0, options.limit) : products;

  if (!products.length) {
    console.error("No export/products.json. Run: npm run export:products");
    process.exit(1);
  }

  await verifyWooCredentials();
  const woo = await createWooClient();

  if (options.missingOnly) {
    console.log("Only products without images in WooCommerce will be updated.");
  } else if (!options.force) {
    console.log("Updating all mapped products. Use --missing-only to skip products that already have images.");
  }

  const stats = {
    updated: 0,
    skippedNoMapping: 0,
    skippedNoShopifyImages: 0,
    skippedHasImages: 0,
    failed: 0,
  };

  for (const product of limited) {
    const wooId = mappings.products[product.id];
    if (!wooId) {
      console.log(`  Skip (not mapped): ${product.title}`);
      stats.skippedNoMapping++;
      continue;
    }

    const { payload, skippedImages } = productToWoo(product, {
      localImages: product._localImages || [],
      skipImages: false,
    });

    if (skippedImages?.length) {
      console.warn(
        `  Unsupported image type for ${product.title}: ${skippedImages.map((u) => u.split("/").pop()).join(", ")}`
      );
    }

    if (!payload.images?.length) {
      stats.skippedNoShopifyImages++;
      continue;
    }

    if (options.missingOnly && !options.force) {
      try {
        if (await wooHasImages(woo, wooId)) {
          stats.skippedHasImages++;
          continue;
        }
      } catch (err) {
        console.error(
          `  Failed to check: ${product.title} — ${err.response?.data?.message || err.message}`
        );
        stats.failed++;
        continue;
      }
    }

    if (options.dryRun) {
      console.log(`  [dry-run] images for ${product.title} → WC #${wooId}`);
      stats.updated++;
      continue;
    }

    try {
      await updateOne(woo, "products", wooId, { images: payload.images });
      console.log(`  Images: ${product.title} (WC #${wooId})`);
      stats.updated++;
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error(`  Failed: ${product.title} — ${msg}`);
      if (/invalid image|not allowed to upload this file type/i.test(msg)) {
        console.error("    Tip: product may use SVG — upload PNG/JPG manually in WP admin");
      }
      stats.failed++;
    }
  }

  console.log("\nSummary");
  console.log(`  Updated:                 ${stats.updated}`);
  console.log(`  Skipped (has images):    ${stats.skippedHasImages}`);
  console.log(`  Skipped (no mapping):    ${stats.skippedNoMapping}`);
  console.log(`  Skipped (no Shopify img): ${stats.skippedNoShopifyImages}`);
  console.log(`  Failed:                  ${stats.failed}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
