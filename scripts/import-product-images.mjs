#!/usr/bin/env node
/**
 * Add product images in a second pass (one product per request).
 * Use after: node scripts/import-woocommerce.mjs --entity products --skip-images
 */
import { config } from "./lib/config.mjs";
import { parseArgs } from "./lib/cli.mjs";
import { readJson, writeJson } from "./lib/fs-utils.mjs";
import { productToWoo } from "./lib/transform.mjs";
import { createWooClient, updateOne, verifyWooCredentials } from "./lib/woo-client.mjs";

async function main() {
  const options = parseArgs();
  const products = readJson(config.paths.products, []);
  const mappings = readJson(config.paths.mappings, { products: {} });
  const limited = options.limit ? products.slice(0, options.limit) : products;

  await verifyWooCredentials();
  const woo = await createWooClient();

  let done = 0;
  for (const product of limited) {
    const wooId = mappings.products[product.id];
    if (!wooId) {
      console.log(`  Skip (not imported): ${product.title}`);
      continue;
    }

    const { payload } = productToWoo(product, {
      localImages: product._localImages || [],
      skipImages: false,
    });

    if (!payload.images?.length) continue;

    if (options.dryRun) {
      console.log(`  [dry-run] images for ${product.title}`);
      done++;
      continue;
    }

    try {
      await updateOne(woo, "products", wooId, { images: payload.images });
      console.log(`  Images: ${product.title}`);
      done++;
    } catch (err) {
      console.error(
        `  Failed: ${product.title} — ${err.response?.data?.message || err.message}`
      );
    }
  }

  console.log(`\nDone. ${done} product(s) processed.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
