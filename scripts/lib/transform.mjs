/**
 * Transform Shopify export records into WooCommerce REST API payloads.
 */

export function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.filter(Boolean);
  if (typeof tags === "string") {
    return tags.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

export function shopifyIdNumeric(gid) {
  if (!gid) return null;
  const match = String(gid).match(/\/(\d+)$/);
  return match ? match[1] : null;
}

export function generateSku(variant, handle) {
  if (variant?.sku) return variant.sku;
  const variantId = shopifyIdNumeric(variant?.id);
  if (variantId) return `shopify-${variantId}`;
  return handle || `shopify-product-${Date.now()}`;
}

export function mapProductStatus(shopifyStatus) {
  return shopifyStatus === "ACTIVE" ? "publish" : "draft";
}

export function mapOrderStatus(financialStatus, fulfillmentStatus, cancelledAt) {
  if (cancelledAt) return "cancelled";
  const financial = String(financialStatus || "").toUpperCase();
  const fulfillment = String(fulfillmentStatus || "").toUpperCase();

  if (financial === "REFUNDED" || financial === "PARTIALLY_REFUNDED") {
    return "refunded";
  }
  if (financial === "VOIDED") return "cancelled";
  if (fulfillment === "FULFILLED") return "completed";
  if (financial === "PAID" || financial === "PARTIALLY_PAID") {
    return fulfillment === "UNFULFILLED" ? "processing" : "completed";
  }
  if (financial === "PENDING" || financial === "AUTHORIZED") {
    return "on-hold";
  }
  return "pending";
}

export function mapAddress(addr, email) {
  if (!addr) {
    return { email: email || "" };
  }
  return {
    first_name: addr.firstName || "",
    last_name: addr.lastName || "",
    company: addr.company || "",
    address_1: addr.address1 || "",
    address_2: addr.address2 || "",
    city: addr.city || "",
    state: addr.provinceCode || addr.province || "",
    postcode: addr.zip || "",
    country: addr.countryCodeV2 || addr.country || "",
    email: email || "",
    phone: addr.phone || "",
  };
}

export function mapCustomerAddress(addr) {
  if (!addr) return {};
  return {
    first_name: addr.firstName || "",
    last_name: addr.lastName || "",
    company: addr.company || "",
    address_1: addr.address1 || "",
    address_2: addr.address2 || "",
    city: addr.city || "",
    state: addr.province || "",
    postcode: addr.zip || "",
    country: addr.country || "",
    phone: addr.phone || "",
  };
}

/** Request a smaller image from Shopify CDN to avoid PHP/ImageMagick timeouts on import. */
export function resizeShopifyImageUrl(url, width = 800) {
  if (!url || !url.includes("cdn.shopify.com")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}width=${width}`;
}

/** WordPress/WooCommerce often blocks SVG uploads via REST. */
export function isWooSupportedImageUrl(url) {
  if (!url) return false;
  const path = url.split("?")[0].toLowerCase();
  return ![".svg", ".svgz"].some((ext) => path.endsWith(ext));
}

export function buildProductImages(product, localImages = []) {
  const raw = [];
  if (localImages.length) {
    for (const img of localImages) {
      if (img.url) raw.push({ src: img.url, alt: img.alt || "" });
    }
  } else {
    for (const { node } of product.media?.edges || []) {
      if (node?.image?.url) {
        raw.push({ src: node.image.url, alt: node.image.altText || "" });
      }
    }
  }

  const images = [];
  const skipped = [];
  for (const img of raw) {
    if (!isWooSupportedImageUrl(img.src)) {
      skipped.push(img.src);
      continue;
    }
    images.push({
      src: resizeShopifyImageUrl(img.src),
      alt: img.alt,
    });
  }
  return { images, skipped };
}

/**
 * WooCommerce requires an email. Shopify phone-only customers get a stable placeholder.
 */
export function resolveCustomerEmail(customer) {
  const existing = customer.email?.trim();
  if (existing) return existing;

  const domain = process.env.IMPORT_EMAIL_DOMAIN || "import.customer.local";
  const id = shopifyIdNumeric(customer.id);
  const phoneDigits = (customer.phone || "").replace(/\D/g, "");

  if (phoneDigits) {
    return `phone+${phoneDigits}@${domain}`;
  }
  return `shopify+${id}@${domain}`;
}

export function productToWoo(product, { localImages = [], skipImages = false } = {}) {
  const variants = product.variants?.edges?.map((e) => e.node) || [];
  const primaryVariant = variants[0];
  const sku = generateSku(primaryVariant, product.handle);
  const categories =
    product.collections?.edges?.map((e) => ({ name: e.node.title })) || [];

  const { images, skipped: skippedImages } = skipImages
    ? { images: [], skipped: [] }
    : buildProductImages(product, localImages);

  const payload = {
    name: product.title,
    slug: product.handle,
    type: variants.length > 1 ? "variable" : "simple",
    status: mapProductStatus(product.status),
    description: product.descriptionHtml || "",
    short_description: "",
    sku,
    regular_price: primaryVariant?.price || "0",
    manage_stock: true,
    stock_quantity: primaryVariant?.inventoryQuantity ?? 0,
    categories,
    images,
    tags: normalizeTags(product.tags).map((name) => ({ name })),
    meta_data: [
      { key: "_shopify_product_id", value: String(product.id) },
      { key: "_shopify_handle", value: String(product.handle) },
    ],
  };

  if (primaryVariant?.compareAtPrice) {
    payload.sale_price = primaryVariant.price;
    payload.regular_price = primaryVariant.compareAtPrice;
  }

  if (product.seo?.title) {
    payload.meta_data.push({ key: "_yoast_wpseo_title", value: product.seo.title });
  }
  if (product.seo?.description) {
    payload.meta_data.push({
      key: "_yoast_wpseo_metadesc",
      value: product.seo.description,
    });
  }

  const weight = primaryVariant?.inventoryItem?.measurement?.weight;
  if (weight?.value) {
    payload.weight = String(weight.value);
  }

  return { payload, variants, shopifyId: product.id, skippedImages };
}

export function customerToWoo(customer) {
  const addressList = Array.isArray(customer.addresses)
    ? customer.addresses
    : customer.addresses?.edges?.map((e) => e.node) || [];
  const billing = mapCustomerAddress(
    customer.defaultAddress || addressList[0]
  );
  const shipping = billing;
  const email = resolveCustomerEmail(customer);
  const syntheticEmail = !customer.email?.trim();

  return {
    email,
    first_name: customer.firstName || billing.first_name || "",
    last_name: customer.lastName || billing.last_name || "",
    billing: { ...billing, email, phone: customer.phone || billing.phone },
    shipping: { ...shipping, email },
    meta_data: [
      { key: "_shopify_customer_id", value: String(customer.id) },
      { key: "_shopify_orders_count", value: String(customer.numberOfOrders ?? 0) },
      {
        key: "_shopify_total_spent",
        value: String(customer.amountSpent?.amount ?? "0"),
      },
      ...(syntheticEmail
        ? [
            { key: "_import_synthetic_email", value: "true" },
            { key: "_shopify_phone", value: String(customer.phone || "") },
          ]
        : []),
    ],
  };
}

export function resolveOrderEmail(order) {
  const direct = order.email?.trim() || order.customer?.email?.trim();
  if (direct) return direct;
  if (order.customer?.id || order.phone) {
    return resolveCustomerEmail({
      id: order.customer?.id || `order-${shopifyIdNumeric(order.id)}`,
      phone: order.phone || order.billingAddress?.phone || "",
      email: null,
    });
  }
  return `guest+${shopifyIdNumeric(order.id)}@${process.env.IMPORT_EMAIL_DOMAIN || "import.customer.local"}`;
}

export function lineItemSku(item) {
  if (item.sku) return item.sku;
  if (item.variant?.sku) return item.variant.sku;
  const variantId = shopifyIdNumeric(item.variant?.id);
  if (variantId) return `shopify-${variantId}`;
  if (item.product?.handle) return item.product.handle;
  return `shopify-line-${shopifyIdNumeric(item.id)}`;
}

export function orderToWoo(order, mappings) {
  const lineItems = [];
  const lineEdges = order.lineItems?.edges || [];
  const orderEmail = resolveOrderEmail(order);

  for (const { node: item } of lineEdges) {
    const productGid = item.variant?.product?.id || item.product?.id;
    const wooProductId = productGid ? mappings.products[productGid] : null;
    const qty = item.quantity || 1;
    const unitPrice = item.originalUnitPriceSet?.shopMoney?.amount || "0";
    const lineTotal = item.discountedTotalSet?.shopMoney?.amount || String(Number(unitPrice) * qty);
    const sku = lineItemSku(item);

    const lineItem = {
      name: item.title,
      quantity: qty,
      subtotal: lineTotal,
      total: lineTotal,
      sku,
      meta_data: [{ key: "_shopify_line_item_id", value: String(item.id) }],
    };

    if (wooProductId) {
      lineItem.product_id = wooProductId;
    }

    lineItems.push(lineItem);
  }

  const shippingLines = (order.shippingLines?.edges || []).map(({ node }) => ({
    method_id: "flat_rate",
    method_title: node.title || "Shipping",
    total: node.originalPriceSet?.shopMoney?.amount || "0",
  }));

  const customerGid = order.customer?.id;
  const customerId = customerGid ? mappings.customers[customerGid] : null;

  const gateway = order.paymentGatewayNames?.[0] || "shopify";
  const status = mapOrderStatus(
    order.displayFinancialStatus,
    order.displayFulfillmentStatus,
    order.cancelledAt
  );

  return {
    status,
    customer_id: customerId || 0,
    billing: mapAddress(order.billingAddress, orderEmail),
    shipping: mapAddress(order.shippingAddress, orderEmail),
    line_items: lineItems,
    shipping_lines: shippingLines,
    customer_note: order.note || "",
    payment_method: "shopify_import",
    payment_method_title: gateway,
    // Historical import — do not run payment flow (avoids duplicate notification emails)
    set_paid: false,
    meta_data: [
      { key: "_shopify_order_id", value: order.id },
      { key: "_shopify_order_name", value: order.name },
      { key: "_shopify_created_at", value: order.createdAt },
      { key: "_shopify_financial_status", value: order.displayFinancialStatus },
      {
        key: "_shopify_fulfillment_status",
        value: order.displayFulfillmentStatus,
      },
      {
        key: "_shopify_total",
        value: order.totalPriceSet?.shopMoney?.amount || "0",
      },
    ],
    shopifyId: order.id,
  };
}
