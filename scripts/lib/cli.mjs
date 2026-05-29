export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dryRun: false,
    resume: false,
    entity: null,
    limit: null,
    includeDrafts: false,
    skipImages: false,
    batchSize: 25,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--skip-images") options.skipImages = true;
    else if (arg === "--include-drafts") options.includeDrafts = true;
    else if (arg === "--entity" && argv[i + 1]) options.entity = argv[++i];
    else if (arg === "--limit" && argv[i + 1]) options.limit = Number(argv[++i]);
    else if (arg === "--batch-size" && argv[i + 1]) options.batchSize = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") options.help = true;
  }

  return options;
}

export function printHelp(script) {
  const usage =
    script === "export"
      ? `Usage: node scripts/export-shopify.mjs [options]

Options:
  --entity products|customers|orders   Export only one entity (default: all)
  --limit N                            Stop after N records per entity
  --resume                             Continue from last cursor in manifest
  --include-drafts                     Include non-ACTIVE products
  --dry-run                            Fetch but do not write files
`
      : `Usage: node scripts/import-woocommerce.mjs [options]

Options:
  --entity products|customers|orders   Import only one entity (default: all)
  --dry-run                            Transform only, no WooCommerce writes
  --skip-images                        Skip product images (fast; run import-product-images later)
  --batch-size N                       Items per batch (default: 1 for products with images, 25 otherwise)
  --limit N                            Import only first N records
`;
  console.log(usage);
}
