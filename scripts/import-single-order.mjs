#!/usr/bin/env node
/**
 * Import or retry one Shopify order by name (e.g. #1110) or Shopify GID.
 */
import { config } from "./lib/config.mjs";
import { readJson, writeJson, ensureDir } from "./lib/fs-utils.mjs";
import { dirname } from "path";
import { orderToWoo } from "./lib/transform.mjs";
import {
  createWooClient,
  createOne,
  updateOne,
  verifyWooCredentials,
} from "./lib/woo-client.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const options = { help: false, dryRun: false, name: null, shopifyId: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--name" && argv[i + 1]) options.name = argv[++i];
    else if (arg === "--shopify-id" && argv[i + 1]) options.shopifyId = argv[++i];
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/import-single-order.mjs --name "#1110" [options]

Options:
  --name NAME           Shopify order name (e.g. #1110)
  --shopify-id GID      Shopify order GID
  --dry-run             Build payload only, no API write
  -h, --help            Show help
`);
}

async function wooResourceExists(woo, resource, id) {
  try {
    await woo.get(`${resource}/${id}`);
    return true;
  } catch (err) {
    if (err.response?.status === 404) return false;
    throw err;
  }
}

function saveMappings(mappings) {
  ensureDir(dirname(config.paths.mappings));
  writeJson(config.paths.mappings, mappings);
}

function normalizeOrderName(name) {
  const s = String(name).trim();
  return s.startsWith("#") ? s : `#${s}`;
}

async function main() {
  const options = parseArgs();
  if (options.help || (!options.name && !options.shopifyId)) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  const orders = readJson(config.paths.orders, []);
  if (!orders.length) {
    console.error("No export/orders.json. Run: npm run export:orders");
    process.exit(1);
  }

  const order = options.shopifyId
    ? orders.find((o) => o.id === options.shopifyId)
    : orders.find((o) => o.name === normalizeOrderName(options.name));

  if (!order) {
    console.error(`Order not found in export: ${options.name || options.shopifyId}`);
    process.exit(1);
  }

  const mappings = readJson(config.paths.mappings, {
    products: {},
    customers: {},
    orders: {},
    variants: {},
  });

  const { shopifyId, ...payload } = orderToWoo(order, mappings);
  const customerGid = order.customer?.id;
  const customerMapped = customerGid ? mappings.customers[customerGid] : null;

  console.log(`Order: ${order.name}`);
  console.log(`Shopify ID: ${shopifyId}`);
  console.log(`Customer: ${order.email || order.customer?.email || "(none)"}`);
  console.log(`Woo customer_id: ${payload.customer_id}${customerMapped ? "" : " (guest — customer not in mappings)"}`);
  console.log(`Line items: ${payload.line_items?.length}`);
  console.log(`Payload size: ${JSON.stringify(payload).length} bytes`);
  console.log(`Status: ${payload.status}, set_paid: ${payload.set_paid}`);

  for (const li of payload.line_items || []) {
    console.log(
      `  - ${li.name} x${li.quantity} sku=${li.sku} product_id=${li.product_id || "none"}`
    );
  }

  if (!customerMapped && customerGid) {
    console.warn(
      `\nWarning: customer ${customerGid} is not mapped. Run: npm run import:customers`
    );
  }

  if (options.dryRun) {
    console.log("\n[dry-run] No API call.");
    return;
  }

  await verifyWooCredentials();
  const woo = await createWooClient();

  let wooId = mappings.orders[shopifyId];
  if (wooId && !(await wooResourceExists(woo, "orders", wooId))) {
    console.warn(`Stale mapping WC #${wooId} — will create new`);
    delete mappings.orders[shopifyId];
    wooId = null;
  }

  try {
    if (wooId) {
      await updateOne(woo, "orders", wooId, payload);
      console.log(`\nUpdated WooCommerce order #${wooId}`);
    } else {
      const result = await createOne(woo, "orders", payload);
      mappings.orders[shopifyId] = result.id;
      saveMappings(mappings);
      console.log(`\nCreated WooCommerce order #${result.id}`);
    }
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    console.error(`\nFailed (HTTP ${status || "?"}): ${msg}`);
    if (status === 502) {
      console.error(`
502 = gateway timeout (Kinsta/PHP), not invalid order data.
Common causes: Woo emails, webhooks, or plugins running on order create.

Try:
  1. Retry: node scripts/import-single-order.mjs --name "${order.name}"
  2. Check WP Admin → WooCommerce → Orders for a partial duplicate
  3. Temporarily disable nonessential plugins / Woo emails, then retry
`);
    }
    if (err.response?.data) {
      console.error("Response:", JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
