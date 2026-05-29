import WooCommerceRestApiModule from "@woocommerce/woocommerce-rest-api";
import { config } from "./config.mjs";

const WooCommerceRestApi =
  WooCommerceRestApiModule.default ?? WooCommerceRestApiModule;

async function wpJsonAvailable(baseUrl) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/wp-json/`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * WooCommerce on HTTP only accepts OAuth 1.0a (not Basic auth or query-string keys).
 * The official client handles that automatically when isHttps is false.
 */
export async function verifyWooCredentials() {
  const woo = await createWooClient({ silent: true });
  try {
    await woo.get("products", { per_page: 1 });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(
      `WooCommerce API authentication failed (${msg}).\n` +
        `On http://localhost, WooCommerce requires OAuth (handled by this script when /wp-json/ works).\n` +
        `If /wp-json/ returns 404, run: npm run woo:fix-permalinks\n` +
        `Then regenerate keys if needed: WooCommerce → Settings → Advanced → REST API`
    );
  }
}

export async function createWooClient({ silent = false } = {}) {
  const { url, consumerKey, consumerSecret } = config.woo;
  if (!url || !consumerKey || !consumerSecret) {
    throw new Error(
      "WooCommerce credentials missing. Set WOO_URL, WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET in .env"
    );
  }

  const baseUrl = url.replace(/\/$/, "");
  const wpJsonOk = await wpJsonAvailable(baseUrl);

  if (!wpJsonOk) {
    throw new Error(
      "/wp-json/ is not available on your WordPress site.\n" +
        "WooCommerce REST API cannot authenticate over plain index.php URLs on HTTP.\n" +
        "Run: npm run woo:fix-permalinks\n" +
        "Or in WP Admin: Settings → Permalinks → Post name → Save"
    );
  }

  if (!silent) {
    console.log("Using /wp-json/wc/v3/ (OAuth on HTTP, Basic on HTTPS)");
  }

  // Do NOT pass headers via axiosConfig — the Woo library spreads axiosConfig last and
  // replaces options.headers, dropping Content-Type on POST. That creates empty "Product" shells.
  return new WooCommerceRestApi({
    url: baseUrl,
    consumerKey,
    consumerSecret,
    version: "wc/v3",
    timeout: 120000,
  });
}

export async function createOne(woo, resource, payload) {
  const response = await woo.post(resource, payload);
  return response.data;
}

export async function updateOne(woo, resource, id, payload) {
  const response = await woo.put(`${resource}/${id}`, payload);
  return response.data;
}

export async function batchCreate(woo, resource, items) {
  const response = await woo.post(`${resource}/batch`, { create: items });
  return response.data;
}

export async function batchUpdate(woo, resource, items) {
  const response = await woo.post(`${resource}/batch`, { update: items });
  return response.data;
}

export function extractBatchResults(batchResponse, shopifyIds, idField = "id") {
  const mapping = {};
  const created = batchResponse.create || [];
  for (let i = 0; i < created.length; i++) {
    const record = created[i];
    if (record?.id && shopifyIds[i]) {
      mapping[shopifyIds[i]] = record[idField];
    }
  }
  return mapping;
}
