import { config } from "./config.mjs";
import { sleep } from "./fs-utils.mjs";

export class ShopifyClient {
  constructor() {
    this.url = config.shopify.graphqlUrl;
    this.token = config.shopify.accessToken;
  }

  async query(graphql, variables = {}) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": this.token,
      },
      body: JSON.stringify({ query: graphql, variables }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Shopify HTTP ${response.status}: ${text}`);
    }

    const json = await response.json();

    if (json.errors?.length) {
      throw new Error(
        `Shopify GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`
      );
    }

    await this.throttle(json.extensions?.cost?.throttleStatus);
    return json.data;
  }

  async throttle(status) {
    if (!status) return;
    const { currentlyAvailable, restoreRate } = status;
    if (currentlyAvailable < 200) {
      const waitMs = Math.ceil((200 - currentlyAvailable) / restoreRate) * 1000;
      await sleep(Math.min(waitMs, 5000));
    } else {
      await sleep(250);
    }
  }

  async paginate(connectionPath, query, variables, { pageSize = 50, limit = null, startCursor = null } = {}) {
    const all = [];
    let after = startCursor;
    let hasNextPage = true;

    while (hasNextPage) {
      const data = await this.query(query, { ...variables, first: pageSize, after });
      const parts = connectionPath.split(".");
      let connection = data;
      for (const part of parts) {
        connection = connection?.[part];
      }

      if (!connection) {
        throw new Error(`Connection not found at path: ${connectionPath}`);
      }

      const nodes = connection.edges.map((e) => e.node);
      all.push(...nodes);

      hasNextPage = connection.pageInfo.hasNextPage;
      after = connection.pageInfo.endCursor;

      if (limit !== null && all.length >= limit) {
        return {
          nodes: all.slice(0, limit),
          endCursor: after,
          hasNextPage: all.length < limit ? false : hasNextPage,
        };
      }

      if (!hasNextPage) break;
    }

    return { nodes: all, endCursor: after, hasNextPage: false };
  }
}

export const PRODUCTS_QUERY = `
  query ExportProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          descriptionHtml
          status
          productType
          vendor
          tags
          seo { title description }
          collections(first: 20) {
            edges { node { id title } }
          }
          media(first: 20) {
            edges {
              node {
                ... on MediaImage {
                  id
                  image { url altText width height }
                }
              }
            }
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                price
                compareAtPrice
                inventoryQuantity
                barcode
                inventoryItem {
                  measurement {
                    weight { value unit }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const CUSTOMERS_QUERY = `
  query ExportCustomers($first: Int!, $after: String) {
    customers(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          email
          firstName
          lastName
          phone
          tags
          createdAt
          numberOfOrders
          amountSpent { amount currencyCode }
          defaultAddress {
            address1 address2 city province country zip phone company
            firstName lastName
          }
          addresses {
            address1 address2 city province country zip phone company
            firstName lastName
          }
        }
      }
    }
  }
`;

export const ORDERS_QUERY = `
  query ExportOrders($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          createdAt
          processedAt
          cancelledAt
          displayFinancialStatus
          displayFulfillmentStatus
          email
          phone
          note
          tags
          paymentGatewayNames
          discountCodes
          customer { id email firstName lastName }
          billingAddress {
            address1 address2 city provinceCode countryCodeV2 zip
            firstName lastName phone company
          }
          shippingAddress {
            address1 address2 city provinceCode countryCodeV2 zip
            firstName lastName phone company
          }
          totalPriceSet { shopMoney { amount currencyCode } }
          subtotalPriceSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
          totalShippingPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 100) {
            edges {
              node {
                id
                title
                sku
                quantity
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                discountedTotalSet { shopMoney { amount currencyCode } }
                variant { id sku product { id } }
                product { id handle }
              }
            }
          }
          shippingLines(first: 20) {
            edges {
              node {
                title
                originalPriceSet { shopMoney { amount currencyCode } }
              }
            }
          }
          transactions(first: 20) {
            gateway
            status
            amountSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  }
`;
