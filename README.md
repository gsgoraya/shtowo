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

# Production / new site: do not reuse mappings from local Docker (causes "Invalid ID")
# rm mappings/shopify-to-woo.json
# node scripts/import-woocommerce.mjs --entity products --fresh

# Re-import orders after deleting them in WooCommerce (keeps product/customer mappings):
# node scripts/import-woocommerce.mjs --entity orders --fresh

node scripts/import-woocommerce.mjs --entity customers
# Phone-only Shopify customers get placeholder emails (see IMPORT_EMAIL_DOMAIN in .env)
# Products with .svg images import without image (upload PNG/JPG manually or enable SVG in WP)

## Apology emails (accidental import notifications)

If customers received WooCommerce emails during import, install the plugin in
`wordpress-plugin/peptology-import-apology/` (zip folder → WP Admin → Plugins → Upload).
Then: **Tools → Import Apology Emails** — dry run first, then send in batches.
node scripts/import-woocommerce.mjs --entity orders
# Production (Kinsta/Cloudflare)
# If API calls are challenged, add a Cloudflare WAF/Bot bypass for:
#   Path starts with /wp-json/
#   AND User-Agent contains PeptologyMigration/1.0 (or your WOO_USER_AGENT)
# You can also restrict by your source IP for extra safety.
