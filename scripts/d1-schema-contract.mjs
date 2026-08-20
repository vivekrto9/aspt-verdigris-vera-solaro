import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const schemaContract = {
  schemaPath: "database/d1/001_initial_site_schema.sql",
  migrationsDir: "migrations",
  requiredTables: {
    ap_runtime_config: ["key", "value", "status", "updated_at"],
    ap_business_settings: ["key", "value_json", "updated_at"],
    ap_asset_records: ["asset_id", "current_revision_id", "display_name", "origin", "visibility", "protected", "replaceable", "deleted_at"],
    ap_asset_revisions: ["revision_id", "asset_id", "revision_number", "storage_key", "content_hash", "file_name", "mime_type", "size_bytes", "status", "scan_status"],
    ap_asset_aliases: ["alias", "asset_id", "origin", "protected"],
    ap_asset_events: ["event_id", "asset_id", "revision_id", "operation", "actor_type", "created_at"],
    ap_asset_release_state: ["environment", "current_revision_number", "current_asset_hash", "current_snapshot_hash", "active_asset_count", "deleted_asset_count"],
    ap_admin_sessions: ["id", "subject", "role", "session_token_hash", "csrf_token_hash", "expires_at", "revoked_at"],
    ap_admin_sso_exchanges: ["id", "jti", "subject", "project_id", "environment", "role", "target_path", "expires_at"],
    ap_content_revision_log: ["id", "revision_number", "source", "actor_type", "operation", "collection", "entry", "locale"],
    ap_content_environment_state: ["environment", "current_revision_number", "current_published_hash", "current_snapshot_hash"],
    ap_emdash_bootstrap_state: ["template_key", "template_version", "builder_registry_hash", "expected_collections", "expected_fields", "expected_entries"],
    ap_customer_accounts: ["id", "email", "display_name", "password_hash", "password_salt", "created_at", "updated_at"],
    ap_customer_sessions: ["id", "account_id", "session_token_hash", "csrf_token_hash", "expires_at", "revoked_at"],
    ap_customer_password_resets: ["id", "account_id", "reset_token_hash", "expires_at", "used_at", "created_at"],
    ap_business_events: ["id", "event_type", "aggregate_type", "aggregate_id", "payload_json", "created_at"],
    ap_leads: ["id", "status", "kind", "source", "full_name", "email", "phone", "details_json", "dedupe_key", "created_at"],
    ap_email_templates: ["key", "display_name", "event_type", "audience", "locale", "subject", "html_body", "text_body", "required_variables_json", "sample_payload_json"],
    ap_email_events: ["event_type", "audience", "email_type", "enabled", "schedule_json", "updated_at"],
    ap_email_variable_mappings: ["variable_key", "source_type", "source_path", "enabled", "updated_at"],
  },
  requiredViews: {
    ap_sales_transactions_v1: ["transaction_id", "reference", "kind_key", "kind_label", "item_key", "item_label", "owner_key", "owner_label", "amount_minor", "refunded_minor", "currency", "payment_status", "payment_provider", "business_status", "fulfillment_status", "created_at", "paid_at", "updated_at"],
    ap_sales_dimensions_v1: ["transaction_id", "dimension_key", "dimension_label", "value_key", "value_label"],
  },
  requiredIndexes: [
    "idx_ap_admin_sessions_token",
    "idx_ap_asset_revisions_asset",
    "idx_ap_asset_events_asset",
    "idx_ap_admin_sessions_subject",
    "idx_ap_admin_sso_exchanges_jti",
    "idx_ap_admin_sso_exchanges_project",
    "idx_ap_content_revision_log_revision",
    "idx_ap_content_revision_log_target",
    "idx_ap_content_revision_log_source",
    "idx_ap_customer_accounts_email",
    "idx_ap_customer_sessions_token",
    "idx_ap_customer_sessions_account",
    "idx_ap_customer_password_resets_token",
    "idx_ap_customer_password_resets_account",
    "idx_ap_business_events_aggregate",
    "idx_ap_leads_dedupe",
    "idx_ap_leads_status",
    "idx_ap_leads_kind",
    "idx_ap_leads_email",
    "idx_ap_leads_created",
    "idx_ap_email_templates_event",
    "idx_ap_email_templates_event_audience_locale",
  ],
  forbiddenTables: [
    "ap_report_orders",
    "ap_puja_orders",
    "ap_product_orders",
    "ap_consultation_bookings",
    "ap_payment_attempts",
    "ap_notification_outbox",
    "ap_integration_events",
    "ap_admin_audit_events",
  ],
};

export const readMigrationFiles = (root = process.cwd()) =>
  readdirSync(join(root, schemaContract.migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(root, schemaContract.migrationsDir, file), "utf8"))
    .join("\n");

export const extractTableColumns = (schema, tableName) => {
  const match = new RegExp(
    `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${tableName}\\s*\\(([^;]+?)\\);`,
    "ims",
  ).exec(schema);
  if (!match) return undefined;
  return match[1]
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/)[0])
    .filter((column) => !["FOREIGN", "CONSTRAINT", "PRIMARY"].includes(column));
};

export const validateD1Schema = (root = process.cwd()) => {
  const failures = [];
  let migration = "";
  try {
    migration = readMigrationFiles(root);
  } catch {
    failures.push(`${schemaContract.migrationsDir} migrations are missing`);
    return failures;
  }

  for (const tableName of schemaContract.forbiddenTables) {
    if (new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${tableName}\\b`, "im").test(migration)) {
      failures.push(`Vera Solaro must not create legacy table ${tableName}`);
    }
  }

  for (const [tableName, columns] of Object.entries(schemaContract.requiredTables)) {
    const actualColumns = extractTableColumns(migration, tableName);
    if (!actualColumns) {
      failures.push(`${schemaContract.migrationsDir} must create ${tableName}`);
      continue;
    }
    for (const column of columns) {
      if (!actualColumns.includes(column)) {
        failures.push(`${tableName} must include ${column}`);
      }
    }
  }

  for (const indexName of schemaContract.requiredIndexes) {
    if (!new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${indexName}\\b`, "im").test(migration)) {
      failures.push(`${schemaContract.migrationsDir} must create ${indexName}`);
    }
  }

  if (schemaContract.requiredViews) {
    for (const [viewName] of Object.entries(schemaContract.requiredViews)) {
      if (!new RegExp(`CREATE\\s+VIEW\\s+IF\\s+NOT\\s+EXISTS\\s+${viewName}\\b`, "im").test(migration)) {
        failures.push(`${schemaContract.migrationsDir} must create view ${viewName}`);
      }
    }
  }

  return failures;
};
