#!/usr/bin/env node
import { dirname } from "path";
import { config } from "./lib/config.mjs";
import { parseArgs, printHelp } from "./lib/cli.mjs";
import { readJson, writeJson, ensureDir } from "./lib/fs-utils.mjs";
import {
  productToWoo,
  customerToWoo,
  orderToWoo,
} from "./lib/transform.mjs";
import {
  createWooClient,
  batchCreate,
  batchUpdate,
  createOne,
  updateOne,
  extractBatchResults,
  verifyWooCredentials,
} from "./lib/woo-client.mjs";

const ENTITIES = ["products", "customers", "orders"];

function loadMappings(options = {}) {
  const empty = { products: {}, customers: {}, orders: {}, variants: {} };
  if (options.fresh && !options.entity) {
    return { ...empty };
  }
  const loaded =
    readJson(config.paths.mappings, { ...empty }) || { ...empty };
  if (options.fresh && options.entity && ENTITIES.includes(options.entity)) {
    loaded[options.entity] = {};
  }
  return loaded;
}

function logBatchErrors(batchResponse, label) {
  for (const op of ["create", "update"]) {
    const items = batchResponse?.[op] || [];
    for (const item of items) {
      if (item?.error) {
        const msg = item.error.message || JSON.stringify(item.error);
        console.error(`  ${label} ${op} error: ${msg}`);
      }
    }
  }
}

async function wooResourceExists(woo, resource, id) {
  try {
    await woo.get(`${resource}/${id}`);
    return true;
  } catch {
    return false;
  }
}

function saveMappings(mappings) {
  ensureDir(dirname(config.paths.mappings));
  writeJson(config.paths.mappings, mappings);
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function importProducts(woo, options, mappings) {
  const products = readJson(config.paths.products, []);
  if (!products.length) {
    console.log("No products in export. Run export first.");
    return 0;
  }

  const limited = options.limit ? products.slice(0, options.limit) : products;
  const withImages = !options.skipImages;

  if (withImages) {
    console.log("Importing products one at a time (images use resized Shopify URLs)...");
    let imported = 0;
    for (const product of limited) {
      const { payload, shopifyId, skippedImages } = productToWoo(product, {
        localImages: product._localImages || [],
        skipImages: false,
      });
      if (skippedImages?.length) {
        console.warn(
          `  Skipping unsupported image type for ${product.title}: ${skippedImages.map((u) => u.split("/").pop()).join(", ")}`
        );
      }
      const existingWooId = mappings.products[shopifyId];

      if (options.dryRun) {
        console.log(`  [dry-run] ${product.title}`);
        imported++;
        continue;
      }

      try {
        let wooId = existingWooId;
        if (wooId && !(await wooResourceExists(woo, "products", wooId))) {
          console.warn(
            `  Stale mapping for ${product.title} (WC #${wooId} not on this site) — creating new`
          );
          delete mappings.products[shopifyId];
          wooId = null;
        }

        if (wooId) {
          const { sku, ...updatePayload } = payload;
          await updateOne(woo, "products", wooId, updatePayload);
          console.log(`  Updated: ${product.title}`);
        } else {
          try {
            const created = await createOne(woo, "products", payload);
            mappings.products[shopifyId] = created.id;
            console.log(`  Created: ${product.title} (id ${created.id})`);
          } catch (createErr) {
            const createMsg =
              createErr.response?.data?.message || createErr.message;
            if (
              payload.images?.length &&
              /invalid image|not allowed to upload this file type/i.test(createMsg)
            ) {
              const { images, ...withoutImages } = payload;
              const created = await createOne(woo, "products", withoutImages);
              mappings.products[shopifyId] = created.id;
              console.warn(
                `  Created without image (unsupported type): ${product.title} (id ${created.id})`
              );
            } else {
              throw createErr;
            }
          }
        }
        imported++;
        saveMappings(mappings);
      } catch (err) {
        const msg = err.response?.data?.message || err.message;
        console.error(`  Failed: ${product.title} — ${msg}`);
        if (err.response?.data?.data?.error?.message?.includes("Maximum execution time")) {
          console.error(
            "    Tip: run with --skip-images, then: node scripts/import-product-images.mjs"
          );
        }
      }
    }
    return imported;
  }

  let imported = 0;
  for (const batch of chunk(limited, options.batchSize)) {
    const toCreate = [];
    const toUpdate = [];
    const createIds = [];
    const updateIds = [];

    for (const product of batch) {
      const { payload, shopifyId } = productToWoo(product, { skipImages: true });

      const existingWooId = mappings.products[shopifyId];
      if (existingWooId) {
        toUpdate.push({ id: existingWooId, ...payload });
        updateIds.push(shopifyId);
      } else {
        toCreate.push(payload);
        createIds.push(shopifyId);
      }
    }

    if (options.dryRun) {
      console.log(
        `  [dry-run] products batch: ${toCreate.length} create, ${toUpdate.length} update`
      );
      imported += batch.length;
      continue;
    }

    if (toCreate.length) {
      const result = await batchCreate(woo, "products", toCreate);
      const newMap = extractBatchResults(result, createIds);
      Object.assign(mappings.products, newMap);
      console.log(`  Created ${Object.keys(newMap).length} products`);
    }

    if (toUpdate.length) {
      await batchUpdate(woo, "products", toUpdate);
      console.log(`  Updated ${toUpdate.length} products`);
    }

    imported += batch.length;
    saveMappings(mappings);
  }

  return imported;
}

async function importCustomers(woo, options, mappings) {
  const customers = readJson(config.paths.customers, []);
  if (!customers.length) {
    console.log("No customers in export. Run export first.");
    return 0;
  }

  const limited = options.limit ? customers.slice(0, options.limit) : customers;
  let imported = 0;

  for (const batch of chunk(limited, options.batchSize)) {
    const toCreate = [];
    const toUpdate = [];
    const createIds = [];
    const updateIds = [];

    for (const customer of batch) {
      const payload = customerToWoo(customer);
      if (!customer.email?.trim()) {
        console.warn(
          `  Placeholder email for ${customer.firstName || "customer"} ${customer.lastName || ""}: ${payload.email}`
        );
      }
      const existingWooId = mappings.customers[customer.id];

      if (existingWooId) {
        toUpdate.push({ id: existingWooId, ...payload });
        updateIds.push(customer.id);
      } else {
        toCreate.push(payload);
        createIds.push(customer.id);
      }
    }

    if (options.dryRun) {
      console.log(
        `  [dry-run] customers batch: ${toCreate.length} create, ${toUpdate.length} update`
      );
      imported += batch.length;
      continue;
    }

    if (toCreate.length) {
      const result = await batchCreate(woo, "customers", toCreate);
      const newMap = extractBatchResults(result, createIds);
      Object.assign(mappings.customers, newMap);
      console.log(`  Created ${Object.keys(newMap).length} customers`);
    }

    if (toUpdate.length) {
      await batchUpdate(woo, "customers", toUpdate);
      console.log(`  Updated ${toUpdate.length} customers`);
    }

    imported += batch.length;
    saveMappings(mappings);
  }

  return imported;
}

async function importOrders(woo, options, mappings) {
  const orders = readJson(config.paths.orders, []);
  if (!orders.length) {
    console.log("No orders in export. Run export first.");
    return 0;
  }

  const limited = options.limit ? orders.slice(0, options.limit) : orders;
  let created = 0;
  let updated = 0;
  let failed = 0;

  console.log("Importing orders one at a time (avoids silent batch failures)...");

  for (const order of limited) {
    const { shopifyId, ...payload } = orderToWoo(order, mappings);
    let wooId = mappings.orders[shopifyId];

    if (options.dryRun) {
      console.log(`  [dry-run] ${order.name || shopifyId}`);
      created++;
      continue;
    }

    try {
      if (wooId && !(await wooResourceExists(woo, "orders", wooId))) {
        console.warn(
          `  Stale mapping for ${order.name} (WC #${wooId} deleted) — creating new`
        );
        delete mappings.orders[shopifyId];
        wooId = null;
      }

      if (wooId) {
        await updateOne(woo, "orders", wooId, payload);
        console.log(`  Updated: ${order.name}`);
        updated++;
      } else {
        const result = await createOne(woo, "orders", payload);
        mappings.orders[shopifyId] = result.id;
        console.log(`  Created: ${order.name} (id ${result.id})`);
        created++;
      }
      saveMappings(mappings);
    } catch (err) {
      failed++;
      const msg = err.response?.data?.message || err.message;
      console.error(`  Failed: ${order.name || shopifyId} — ${msg}`);
      if (err.response?.data?.data?.params) {
        console.error(`    ${JSON.stringify(err.response.data.data.params)}`);
      }
    }
  }

  console.log(`  Summary: ${created} created, ${updated} updated, ${failed} failed`);
  return created + updated;
}

async function main() {
  const options = parseArgs();
  if (options.entity === "products" && !options.skipImages && options.batchSize === 25) {
    options.batchSize = 1;
  }
  if (options.help) {
    printHelp("import");
    process.exit(0);
  }

  const entities = options.entity ? [options.entity] : ENTITIES;
  for (const e of entities) {
    if (!ENTITIES.includes(e)) {
      console.error(`Unknown entity: ${e}. Use products, customers, or orders.`);
      process.exit(1);
    }
  }

  const mappings = loadMappings(options);
  if (options.fresh) {
    if (options.entity) {
      console.log(`Using --fresh: cleared mappings for ${options.entity} only`);
    } else {
      console.log("Using --fresh: ignoring all existing mappings");
    }
  }
  let woo = null;

  if (!options.dryRun) {
    await verifyWooCredentials();
    woo = await createWooClient();
    console.log(`WooCommerce: ${config.woo.url}`);
  } else {
    console.log("Dry run — no WooCommerce API calls");
  }

  const manifest = readJson(config.paths.manifest, {});
  manifest.importedAt = manifest.importedAt || {};

  for (const entity of entities) {
    console.log(`\nImporting ${entity}...`);
    let count = 0;

    if (entity === "products") count = await importProducts(woo, options, mappings);
    if (entity === "customers") count = await importCustomers(woo, options, mappings);
    if (entity === "orders") count = await importOrders(woo, options, mappings);

    manifest.importedAt[entity] = new Date().toISOString();
    manifest.importCounts = manifest.importCounts || {};
    manifest.importCounts[entity] = count;
    console.log(`Imported ${count} ${entity}`);
  }

  if (!options.dryRun) {
    saveMappings(mappings);
    writeJson(config.paths.manifest, {
      ...manifest,
      mappingsFile: config.paths.mappings,
    });
  }

  console.log("\nImport complete.");
  if (!options.dryRun) {
    console.log(`Mappings: ${config.paths.mappings}`);
  }
}

main().catch((err) => {
  console.error("Import failed:", err.message);
  if (err.response?.data) {
    console.error(JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
