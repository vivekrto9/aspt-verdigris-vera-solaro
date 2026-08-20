WITH required_tables(name) AS (
  VALUES
    ('_emdash_migrations'),
    ('_emdash_api_tokens'),
    ('users'),
    ('media'),
    ('content'),
    ('ap_runtime_config'),
    ('ap_business_settings'),
    ('ap_admin_sessions'),
    ('ap_admin_sso_exchanges'),
    ('ap_customer_accounts'),
    ('ap_customer_sessions'),
    ('ap_customer_password_resets'),
    ('ap_business_events'),
    ('ap_leads'),
    ('ap_email_templates'),
    ('ap_email_events'),
    ('ap_email_variable_mappings')
)
SELECT name
FROM required_tables
WHERE NOT EXISTS (
  SELECT 1
  FROM sqlite_master
  WHERE type = 'table'
    AND sqlite_master.name = required_tables.name
);
