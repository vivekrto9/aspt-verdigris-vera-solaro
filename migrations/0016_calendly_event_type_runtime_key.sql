INSERT INTO ap_runtime_config (key, value, provider_key, scope, status, updated_at)
SELECT 'CALENDLY_EVENT_TYPE_URI', value, 'calendly', 'site', 'active', '2026-08-26T00:00:00.000Z'
FROM ap_runtime_config
WHERE key = 'CALENDLY_30_MIN_EVENT_TYPE_URI'
ON CONFLICT(key) DO UPDATE SET
  value = CASE
    WHEN trim(ap_runtime_config.value) <> '' THEN ap_runtime_config.value
    ELSE excluded.value
  END,
  provider_key = 'calendly',
  scope = 'site',
  status = 'active',
  updated_at = excluded.updated_at;

INSERT INTO ap_runtime_config (key, value, provider_key, scope, status, updated_at)
VALUES ('CALENDLY_EVENT_TYPE_URI', '', 'calendly', 'site', 'active', '2026-08-26T00:00:00.000Z')
ON CONFLICT(key) DO UPDATE SET
  provider_key = 'calendly',
  scope = 'site',
  status = 'active',
  updated_at = excluded.updated_at;

DELETE FROM ap_runtime_config WHERE key = 'CALENDLY_30_MIN_EVENT_TYPE_URI';
