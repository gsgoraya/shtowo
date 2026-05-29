#!/usr/bin/env node
import { config } from "./lib/config.mjs";
import { createWooClient } from "./lib/woo-client.mjs";

const { url, consumerKey, consumerSecret } = config.woo;

if (!url || !consumerKey || !consumerSecret) {
  console.error("Missing WOO_URL, WOO_CONSUMER_KEY, or WOO_CONSUMER_SECRET in .env");
  process.exit(1);
}

const base = url.replace(/\/$/, "");

async function main() {
  console.log(`Store: ${base}\n`);

  const wpRes = await fetch(`${base}/wp-json/`);
  console.log(`${wpRes.ok ? "✓" : "✗"} /wp-json/ reachable (HTTP ${wpRes.status})`);
  if (!wpRes.ok) {
    console.log("  Fix: npm run woo:fix-permalinks");
    console.log("  Or: WP Admin → Settings → Permalinks → Post name → Save\n");
    process.exit(1);
  }

  try {
    const woo = await createWooClient({ silent: true });
    const products = await woo.get("products", { per_page: 1 });
    console.log("✓ WooCommerce GET /products (OAuth)");
    console.log(`  HTTP 200 — ${products.data.length} product(s) in sample`);

    const batch = await woo.post("products/batch", { create: [] });
    console.log("✓ WooCommerce POST /products/batch");
    console.log(`  HTTP 200 — batch endpoint accessible`);
  } catch (err) {
    console.log("✗ WooCommerce API");
    console.log(`  ${err.response?.data?.message || err.message}`);
    console.log(`
Regenerate keys: WooCommerce → Settings → Advanced → REST API
  - User: Administrator
  - Permissions: Read/Write
`);
    process.exit(1);
  }

  console.log("\nReady to import: node scripts/import-woocommerce.mjs --entity products");
}

main();
