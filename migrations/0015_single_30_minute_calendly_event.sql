-- Match the Solstice booking contract: every public sitting is 30 minutes and
-- resolves one canonical Calendly event type from runtime configuration.

UPDATE ap_vera_services
SET duration_minutes = 30,
    updated_at = '2026-08-24T00:00:00.000Z'
WHERE slug IN ('natal-hour', 'year-ahead', 'two-charts');

UPDATE ap_vera_calendly_mappings
SET event_type_uri = NULL,
    active = 0,
    updated_at = '2026-08-24T00:00:00.000Z';

DELETE FROM ap_runtime_config WHERE key LIKE 'VERA_CALENDLY_%';

INSERT INTO ap_runtime_config (key, value, provider_key, scope, status, updated_at)
VALUES ('CALENDLY_30_MIN_EVENT_TYPE_URI', '', 'calendly', 'site', 'active', '2026-08-24T00:00:00.000Z')
ON CONFLICT(key) DO UPDATE SET provider_key = 'calendly', scope = 'site', status = 'active', updated_at = excluded.updated_at;
