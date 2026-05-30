<?php
/**
 * Plugin Name: Peptology Import Apology
 * Description: Send a one-time apology email to Shopify-imported customers who may have received accidental WooCommerce notification emails during migration.
 * Version: 1.0.0
 * Author: Peptology
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * WC requires at least: 7.0
 */

defined( 'ABSPATH' ) || exit;

final class Peptology_Import_Apology {

	const META_SHOPIFY_ID     = '_shopify_customer_id';
	const META_SYNTHETIC      = '_import_synthetic_email';
	const OPTION_SENT         = 'peptology_apology_sent_log';
	const OPTION_SETTINGS     = 'peptology_apology_settings';
	const NONCE_ACTION        = 'peptology_apology_send';
	const BATCH_SIZE          = 25;

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'admin_menu' ) );
		add_action( 'admin_post_peptology_apology_send_batch', array( __CLASS__, 'handle_send_batch' ) );
		add_action( 'admin_post_peptology_apology_save_settings', array( __CLASS__, 'handle_save_settings' ) );
	}

	public static function admin_menu() {
		add_management_page(
			'Import Apology Emails',
			'Import Apology Emails',
			'manage_woocommerce',
			'peptology-import-apology',
			array( __CLASS__, 'render_admin_page' )
		);
	}

	public static function default_settings() {
		return array(
			'subject'         => 'Please disregard our recent email — no new order was placed',
			'exclude_domain'  => 'import.customer.local',
			'from_name'       => get_bloginfo( 'name' ),
			'body'            => self::default_body(),
		);
	}

	public static function default_body() {
		return "Hello {first_name},\n\n"
			. "We're writing to apologize for an automated email you may have received from us recently.\n\n"
			. "During a behind-the-scenes store migration, our system re-sent notification emails for historical orders that were imported from our previous platform. "
			. "This was a technical replay only — it does not mean a new order was created, charged, or shipped.\n\n"
			. "If you received an order confirmation or similar message, please disregard it. No action is required on your part.\n\n"
			. "We're sorry for the confusion and appreciate your understanding.\n\n"
			. "Kind regards,\n"
			. "{site_name}";
	}

	public static function get_settings() {
		return wp_parse_args( get_option( self::OPTION_SETTINGS, array() ), self::default_settings() );
	}

	/**
	 * Customers imported from Shopify with a real (non-placeholder) email.
	 *
	 * @return WP_User[]
	 */
	public static function get_target_customers() {
		$settings = self::get_settings();
		$exclude  = strtolower( trim( $settings['exclude_domain'] ) );

		$users = get_users(
			array(
				'role'       => 'customer',
				'meta_query' => array(
					array(
						'key'     => self::META_SHOPIFY_ID,
						'compare' => 'EXISTS',
					),
				),
				'number'     => -1,
				'fields'     => 'all',
			)
		);

		$targets = array();
		foreach ( $users as $user ) {
			if ( ! is_email( $user->user_email ) ) {
				continue;
			}
			if ( get_user_meta( $user->ID, self::META_SYNTHETIC, true ) ) {
				continue;
			}
			$email_lower = strtolower( $user->user_email );
			if ( $exclude ) {
				$suffix = '@' . $exclude;
				if ( substr( $email_lower, -strlen( $suffix ) ) === $suffix ) {
					continue;
				}
			}
			if ( false !== strpos( $email_lower, '@import.' ) ) {
				continue;
			}
			$targets[] = $user;
		}

		return $targets;
	}

	public static function personalize( $template, WP_User $user ) {
		$first = get_user_meta( $user->ID, 'first_name', true );
		if ( ! $first ) {
			$first = $user->display_name;
		}
		return str_replace(
			array( '{first_name}', '{email}', '{site_name}' ),
			array( $first, $user->user_email, get_bloginfo( 'name' ) ),
			$template
		);
	}

	public static function send_to_user( WP_User $user, $settings ) {
		$subject = self::personalize( $settings['subject'], $user );
		$body    = self::personalize( $settings['body'], $user );

		$headers = array( 'Content-Type: text/plain; charset=UTF-8' );
		if ( ! empty( $settings['from_name'] ) ) {
			$from_email = get_option( 'admin_email' );
			$headers[]  = 'From: ' . $settings['from_name'] . ' <' . $from_email . '>';
		}

		return wp_mail( $user->user_email, $subject, $body, $headers );
	}

	public static function get_sent_log() {
		$log = get_option( self::OPTION_SENT, array() );
		return is_array( $log ) ? $log : array();
	}

	public static function already_sent( $user_id ) {
		$log = self::get_sent_log();
		return isset( $log[ (int) $user_id ] );
	}

	public static function mark_sent( $user_id ) {
		$log              = self::get_sent_log();
		$log[ (int) $user_id ] = time();
		update_option( self::OPTION_SENT, $log, false );
	}

	public static function handle_save_settings() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'Unauthorized', 'peptology-import-apology' ) );
		}
		check_admin_referer( 'peptology_apology_save_settings' );

		$settings = array(
			'subject'        => sanitize_text_field( wp_unslash( $_POST['subject'] ?? '' ) ),
			'exclude_domain' => sanitize_text_field( wp_unslash( $_POST['exclude_domain'] ?? '' ) ),
			'from_name'      => sanitize_text_field( wp_unslash( $_POST['from_name'] ?? '' ) ),
			'body'           => sanitize_textarea_field( wp_unslash( $_POST['body'] ?? '' ) ),
		);
		update_option( self::OPTION_SETTINGS, $settings );

		wp_safe_redirect( add_query_arg( 'settings-updated', '1', admin_url( 'tools.php?page=peptology-import-apology' ) ) );
		exit;
	}

	public static function handle_send_batch() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'Unauthorized', 'peptology-import-apology' ) );
		}
		check_admin_referer( self::NONCE_ACTION );

		$dry_run  = ! empty( $_POST['dry_run'] );
		$offset   = max( 0, (int) ( $_POST['offset'] ?? 0 ) );
		$settings = self::get_settings();
		$all      = self::get_target_customers();
		$slice    = array_slice( $all, $offset, self::BATCH_SIZE );

		$sent   = 0;
		$failed = 0;
		$skipped = 0;

		foreach ( $slice as $user ) {
			if ( self::already_sent( $user->ID ) ) {
				$skipped++;
				continue;
			}
			if ( $dry_run ) {
				$sent++;
				continue;
			}
			if ( self::send_to_user( $user, $settings ) ) {
				self::mark_sent( $user->ID );
				$sent++;
			} else {
				$failed++;
			}
		}

		$next_offset = $offset + self::BATCH_SIZE;
		$done        = $next_offset >= count( $all );

		$redirect_args = array(
			'page'       => 'peptology-import-apology',
			'batch-done' => $done ? '1' : '0',
			'sent'       => $sent,
			'failed'     => $failed,
			'skipped'    => $skipped,
			'offset'     => $done ? count( $all ) : $next_offset,
			'total'      => count( $all ),
			'dry'        => $dry_run ? '1' : '0',
		);

		wp_safe_redirect( add_query_arg( $redirect_args, admin_url( 'tools.php' ) ) );
		exit;
	}

	public static function render_admin_page() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			return;
		}

		$settings  = self::get_settings();
		$targets   = self::get_target_customers();
		$sent_log  = self::get_sent_log();
		$pending   = 0;
		foreach ( $targets as $u ) {
			if ( ! self::already_sent( $u->ID ) ) {
				$pending++;
			}
		}

		?>
		<div class="wrap">
			<h1>Import Apology Emails</h1>

			<?php if ( isset( $_GET['settings-updated'] ) ) : ?>
				<div class="notice notice-success"><p>Settings saved.</p></div>
			<?php endif; ?>

			<?php if ( isset( $_GET['batch-done'] ) ) : ?>
				<div class="notice notice-info">
					<p>
						<?php if ( '1' === $_GET['dry'] ) : ?>
							<strong>Dry run batch:</strong>
						<?php else : ?>
							<strong>Batch sent:</strong>
						<?php endif; ?>
						<?php echo (int) $_GET['sent']; ?> processed,
						<?php echo (int) $_GET['failed']; ?> failed,
						<?php echo (int) $_GET['skipped']; ?> skipped (already sent).
						<?php if ( '1' === $_GET['batch-done'] ) : ?>
							<br>All <?php echo (int) $_GET['total']; ?> target customers processed.
						<?php else : ?>
							<br>Progress: <?php echo (int) $_GET['offset']; ?> / <?php echo (int) $_GET['total']; ?> —
							click <strong>Send next batch</strong> again to continue.
						<?php endif; ?>
					</p>
				</div>
			<?php endif; ?>

			<div class="card" style="max-width: 720px; padding: 16px; margin-bottom: 20px;">
				<h2>Audience</h2>
				<p>Emails are <strong>not</strong> sent to every WooCommerce customer — only those imported from Shopify (user meta <code><?php echo esc_html( self::META_SHOPIFY_ID ); ?></code>) with a <strong>real</strong> email address.</p>
				<p>Native WooCommerce signups, staff, and placeholder import accounts are excluded.</p>
				<ul>
					<li><strong><?php echo count( $targets ); ?></strong> eligible customers</li>
					<li><strong><?php echo (int) $pending; ?></strong> pending (not yet sent)</li>
					<li><strong><?php echo count( $sent_log ); ?></strong> already sent (logged)</li>
				</ul>
				<p>Placeholder import addresses (e.g. <code>@<?php echo esc_html( $settings['exclude_domain'] ); ?></code>) are excluded.</p>
			</div>

			<h2>Email content</h2>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<?php wp_nonce_field( 'peptology_apology_save_settings' ); ?>
				<input type="hidden" name="action" value="peptology_apology_save_settings" />
				<table class="form-table">
					<tr>
						<th><label for="subject">Subject</label></th>
						<td><input type="text" class="large-text" name="subject" id="subject" value="<?php echo esc_attr( $settings['subject'] ); ?>" /></td>
					</tr>
					<tr>
						<th><label for="from_name">From name</label></th>
						<td><input type="text" class="regular-text" name="from_name" id="from_name" value="<?php echo esc_attr( $settings['from_name'] ); ?>" /></td>
					</tr>
					<tr>
						<th><label for="exclude_domain">Exclude email domain</label></th>
						<td><input type="text" class="regular-text" name="exclude_domain" id="exclude_domain" value="<?php echo esc_attr( $settings['exclude_domain'] ); ?>" />
						<p class="description">Skip addresses ending with this domain (placeholder imports).</p></td>
					</tr>
					<tr>
						<th><label for="body">Message</label></th>
						<td>
							<textarea name="body" id="body" rows="14" class="large-text code"><?php echo esc_textarea( $settings['body'] ); ?></textarea>
							<p class="description">Placeholders: <code>{first_name}</code>, <code>{email}</code>, <code>{site_name}</code></p>
						</td>
					</tr>
				</table>
				<?php submit_button( 'Save message' ); ?>
			</form>

			<h2>Send</h2>
			<p><strong>Tip:</strong> Run a dry run first. Sending is batched (<?php echo (int) self::BATCH_SIZE; ?> per click) to avoid timeouts.</p>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block; margin-right: 8px;">
				<?php wp_nonce_field( self::NONCE_ACTION ); ?>
				<input type="hidden" name="action" value="peptology_apology_send_batch" />
				<input type="hidden" name="offset" value="0" />
				<input type="hidden" name="dry_run" value="1" />
				<?php submit_button( 'Dry run (first batch only)', 'secondary', 'submit', false ); ?>
			</form>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block;" onsubmit="return confirm('Send apology emails to the next batch of customers?');">
				<?php wp_nonce_field( self::NONCE_ACTION ); ?>
				<input type="hidden" name="action" value="peptology_apology_send_batch" />
				<input type="hidden" name="offset" value="<?php echo isset( $_GET['offset'] ) && '0' === $_GET['batch-done'] ? (int) $_GET['offset'] : 0; ?>" />
				<?php submit_button( 'Send next batch (' . (int) self::BATCH_SIZE . ')', 'primary', 'submit', false ); ?>
			</form>
		</div>
		<?php
	}
}

Peptology_Import_Apology::init();
