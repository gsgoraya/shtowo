import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..", "..");

dotenv.config({ path: join(ROOT, ".env") });

function loadAccessToken() {
  if (process.env.SHOPIFY_ACCESS_TOKEN) {
    return process.env.SHOPIFY_ACCESS_TOKEN;
  }
  const tokenPath = join(ROOT, ".access_token");
  if (existsSync(tokenPath)) {
    const data = JSON.parse(readFileSync(tokenPath, "utf8"));
    return data.access_token;
  }
  throw new Error(
    "Shopify access token not found. Set SHOPIFY_ACCESS_TOKEN or create .access_token"
  );
}

export const config = {
  shopify: {
    store: process.env.SHOPIFY_STORE || "peyufj-jz.myshopify.com",
    accessToken: loadAccessToken(),
    apiVersion: process.env.SHOPIFY_API_VERSION || "2025-01",
    get graphqlUrl() {
      return `https://${this.store}/admin/api/${this.apiVersion}/graphql.json`;
    },
  },
  woo: {
    url: process.env.WOO_URL || "",
    consumerKey: process.env.WOO_CONSUMER_KEY || "",
    consumerSecret: process.env.WOO_CONSUMER_SECRET || "",
  },
  paths: {
    exportDir: join(ROOT, process.env.EXPORT_DIR || "export"),
    mediaDir: join(ROOT, process.env.EXPORT_DIR || "export", "media"),
    manifest: join(ROOT, process.env.EXPORT_DIR || "export", "manifest.json"),
    products: join(ROOT, process.env.EXPORT_DIR || "export", "products.json"),
    customers: join(ROOT, process.env.EXPORT_DIR || "export", "customers.json"),
    orders: join(ROOT, process.env.EXPORT_DIR || "export", "orders.json"),
    mappings: join(ROOT, process.env.MAPPINGS_FILE || "mappings/shopify-to-woo.json"),
  },
};
