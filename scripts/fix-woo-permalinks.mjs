#!/usr/bin/env node
/**
 * Fix WordPress permalinks so /wp-json/ works (required for WooCommerce REST on HTTP).
 *
 * For Docker: set WOO_DOCKER_CONTAINER=my-wordpress-site-wordpress-1 in .env
 */
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { config, ROOT } from "./lib/config.mjs";
import dotenv from "dotenv";
import { join } from "path";

dotenv.config({ path: join(ROOT, ".env") });

const HTACCESS = `# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
`;

const container = process.env.WOO_DOCKER_CONTAINER || "my-wordpress-site-wordpress-1";
const dbContainer = process.env.WOO_DOCKER_DB_CONTAINER || "my-wordpress-site-db-1";

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

async function checkWpJson() {
  const base = config.woo.url?.replace(/\/$/, "") || "http://localhost:8080";
  const res = await fetch(`${base}/wp-json/`);
  return res.ok;
}

async function main() {
  try {
    run(`docker exec ${container} test -f /var/www/html/wp-config.php`);
  } catch {
    console.error(
      `Docker container "${container}" not found. Set WOO_DOCKER_CONTAINER in .env`
    );
    process.exit(1);
  }

  const htaccessPath = "/var/www/html/.htaccess";
  run(
    `docker exec ${container} bash -c 'cat > ${htaccessPath} << "EOF"\n${HTACCESS}\nEOF'`
  );

  try {
    run(
      `docker exec ${dbContainer} sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "UPDATE wp_options SET option_value = \\"/%postname%/\\" WHERE option_name = \\"permalink_structure\\";"'`
    );
  } catch {
    console.warn("Could not update permalink_structure in DB (may need manual save in WP Admin)");
  }

  try {
    run(
      `docker exec ${container} bash -c 'echo "max_execution_time = 120" > /usr/local/etc/php/conf.d/migration.ini'`
    );
    console.log("Set PHP max_execution_time=120");
  } catch {
    console.warn("Could not set PHP max_execution_time in container");
  }

  if (await checkWpJson()) {
    console.log("\n✓ /wp-json/ is reachable. Run: npm run woo:test");
  } else {
    console.log("\n✗ /wp-json/ still not reachable. In WP Admin: Settings → Permalinks → Post name → Save");
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
