#!/usr/bin/env node
import { createWriteStream } from "fs";
import { join } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { config } from "./lib/config.mjs";
import { parseArgs, printHelp } from "./lib/cli.mjs";
import { ensureDir, readJson, writeJson, sleep } from "./lib/fs-utils.mjs";
import {
  ShopifyClient,
  PRODUCTS_QUERY,
  CUSTOMERS_QUERY,
  ORDERS_QUERY,
} from "./lib/shopify-client.mjs";
import { shopifyIdNumeric } from "./lib/transform.mjs";

const ENTITIES = ["products", "customers", "orders"];

async function downloadImage(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  await pipeline(Readable.from(Buffer.from(buffer)), createWriteStream(destPath));
}

async function downloadProductMedia(product, mediaDir) {
  const localImages = [];
  const mediaEdges = product.media?.edges || [];
  const productKey = product.handle || shopifyIdNumeric(product.id);

  for (let i = 0; i < mediaEdges.length; i++) {
    const node = mediaEdges[i].node;
    if (!node?.image?.url) continue;

    const url = node.image.url;
    const ext = url.match(/\.(jpe?g|png|gif|webp)/i)?.[1] || "jpg";
    const filename = `${productKey}-${i}.${ext}`;
    const localPath = join(mediaDir, filename);

    try {
      await downloadImage(url, localPath);
      localImages.push({
        url,
        alt: node.image.altText || "",
        localPath: `media/${filename}`,
      });
    } catch (err) {
      console.warn(`  Warning: could not download image for ${product.title}: ${err.message}`);
      localImages.push({ url, alt: node.image.altText || "" });
    }
    await sleep(100);
  }

  return localImages;
}

async function exportProducts(client, options, manifest) {
  const queryFilter = options.includeDrafts ? null : "status:active";
  const startCursor = options.resume ? manifest.cursors?.products : null;

  console.log("Exporting products...");
  const { nodes, endCursor, hasNextPage } = await client.paginate(
    "products",
    PRODUCTS_QUERY,
    { query: queryFilter },
    {
      pageSize: 50,
      limit: options.limit,
      startCursor,
    }
  );

  ensureDir(config.paths.mediaDir);
  const productsWithMedia = [];

  for (const product of nodes) {
    const localImages = await downloadProductMedia(product, config.paths.mediaDir);
    productsWithMedia.push({ ...product, _localImages: localImages });
    process.stdout.write(`  ${product.title}\n`);
  }

  manifest.cursors = manifest.cursors || {};
  manifest.cursors.products = hasNextPage ? endCursor : null;
  manifest.counts = manifest.counts || {};
  manifest.counts.products = productsWithMedia.length;
  manifest.exportedAt = manifest.exportedAt || {};
  manifest.exportedAt.products = new Date().toISOString();

  if (!options.dryRun) {
    writeJson(config.paths.products, productsWithMedia);
  }

  console.log(`Exported ${productsWithMedia.length} products`);
  return productsWithMedia.length;
}

async function exportCustomers(client, options, manifest) {
  const startCursor = options.resume ? manifest.cursors?.customers : null;

  console.log("Exporting customers...");
  const { nodes, endCursor, hasNextPage } = await client.paginate(
    "customers",
    CUSTOMERS_QUERY,
    {},
    { pageSize: 100, limit: options.limit, startCursor }
  );

  manifest.cursors = manifest.cursors || {};
  manifest.cursors.customers = hasNextPage ? endCursor : null;
  manifest.counts = manifest.counts || {};
  manifest.counts.customers = nodes.length;
  manifest.exportedAt = manifest.exportedAt || {};
  manifest.exportedAt.customers = new Date().toISOString();

  if (!options.dryRun) {
    writeJson(config.paths.customers, nodes);
  }

  console.log(`Exported ${nodes.length} customers`);
  return nodes.length;
}

async function exportOrders(client, options, manifest) {
  const startCursor = options.resume ? manifest.cursors?.orders : null;

  console.log("Exporting orders...");
  const { nodes, endCursor, hasNextPage } = await client.paginate(
    "orders",
    ORDERS_QUERY,
    {},
    { pageSize: 50, limit: options.limit, startCursor }
  );

  manifest.cursors = manifest.cursors || {};
  manifest.cursors.orders = hasNextPage ? endCursor : null;
  manifest.counts = manifest.counts || {};
  manifest.counts.orders = nodes.length;
  manifest.exportedAt = manifest.exportedAt || {};
  manifest.exportedAt.orders = new Date().toISOString();

  if (!options.dryRun) {
    writeJson(config.paths.orders, nodes);
  }

  console.log(`Exported ${nodes.length} orders`);
  return nodes.length;
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp("export");
    process.exit(0);
  }

  const entities = options.entity ? [options.entity] : ENTITIES;
  for (const e of entities) {
    if (!ENTITIES.includes(e)) {
      console.error(`Unknown entity: ${e}. Use products, customers, or orders.`);
      process.exit(1);
    }
  }

  ensureDir(config.paths.exportDir);
  const manifest =
    readJson(config.paths.manifest, {
      store: config.shopify.store,
      apiVersion: config.shopify.apiVersion,
      cursors: {},
      counts: {},
      exportedAt: {},
    }) || {};

  manifest.store = config.shopify.store;
  manifest.apiVersion = config.shopify.apiVersion;

  const client = new ShopifyClient();

  for (const entity of entities) {
    if (entity === "products") await exportProducts(client, options, manifest);
    if (entity === "customers") await exportCustomers(client, options, manifest);
    if (entity === "orders") await exportOrders(client, options, manifest);
  }

  if (!options.dryRun) {
    const existing = readJson(config.paths.manifest, {});
    writeJson(config.paths.manifest, {
      ...existing,
      ...manifest,
      cursors: { ...existing.cursors, ...manifest.cursors },
      counts: { ...existing.counts, ...manifest.counts },
      exportedAt: { ...existing.exportedAt, ...manifest.exportedAt },
    });
    console.log(`\nManifest written to ${config.paths.manifest}`);
  }

  console.log("Export complete.");
}

main().catch((err) => {
  console.error("Export failed:", err.message);
  process.exit(1);
});
