# Install
npm install

# Export everything from Shopify
npm run export

# Export one entity
npm run export:products

# Dry-run WooCommerce import (no API writes)
npm run import:dry

# Fix WordPress permalinks (required for REST API on Docker/localhost)
npm run woo:fix-permalinks

# Test WooCommerce API keys
npm run woo:test

# Live import (requires .env WooCommerce keys)
cp .env.example .env   # fill in WOO_URL, WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET
node scripts/import-woocommerce.mjs --entity products
# Images import one product at a time (avoids PHP timeout). If still slow:
#   node scripts/import-woocommerce.mjs --entity products --skip-images
#   npm run import:images

# Local Docker: npm run woo:fix-permalinks (enables /wp-json/ + PHP 120s timeout)
node scripts/import-woocommerce.mjs --entity customers
node scripts/import-woocommerce.mjs --entity orders
# Production (Kinsta/Cloudflare)
# If API calls are challenged, add a Cloudflare WAF/Bot bypass for:
#   Path starts with /wp-json/
#   AND User-Agent contains PeptologyMigration/1.0 (or your WOO_USER_AGENT)
# You can also restrict by your source IP for extra safety.
