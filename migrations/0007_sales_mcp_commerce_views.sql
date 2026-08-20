-- Sales MCP: canonical commerce views for base template
CREATE VIEW IF NOT EXISTS ap_sales_transactions_v1 AS
SELECT
  '' AS transaction_id,
  '' AS reference,
  'report_order' AS kind_key,
  'Paid report orders' AS kind_label,
  '' AS item_key,
  '' AS item_label,
  NULL AS owner_key,
  NULL AS owner_label,
  0 AS amount_minor,
  0 AS refunded_minor,
  'USD' AS currency,
  'pending' AS payment_status,
  '' AS payment_provider,
  '' AS business_status,
  '' AS fulfillment_status,
  '1970-01-01T00:00:00.000Z' AS created_at,
  '1970-01-01T00:00:00.000Z' AS paid_at,
  '1970-01-01T00:00:00.000Z' AS updated_at
WHERE 1 = 0;

CREATE VIEW IF NOT EXISTS ap_sales_dimensions_v1 AS
SELECT
  '' AS transaction_id,
  'report_type' AS dimension_key,
  'Report type' AS dimension_label,
  '' AS value_key,
  '' AS value_label
WHERE 1 = 0;
