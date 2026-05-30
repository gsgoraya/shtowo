Peptology Import Apology
========================

One-time plugin to email customers who received accidental WooCommerce emails during Shopify migration import.

Install
-------
1. Zip the `peptology-import-apology` folder (the folder itself must be inside the zip).
2. WordPress Admin → Plugins → Add New → Upload Plugin → Activate.
3. Tools → Import Apology Emails

Who receives the email
--------------------
- WooCommerce customers with `_shopify_customer_id` user meta (imported from Shopify)
- Excludes `_import_synthetic_email` placeholder accounts
- Excludes addresses ending with your import placeholder domain (default: import.customer.local)

Before sending
--------------
- Edit subject/body on the admin screen
- Run "Dry run" first
- Click "Send next batch" until all pending customers are processed

Uninstall
---------
Deactivate and delete the plugin when finished. Sent log is stored in option `peptology_apology_sent_log`.
