-- The reading room is opened at signup, so the welcome note greets the reader
-- instead of asking them to prove the address before they can get in.
UPDATE ap_email_templates
SET html_body = '<p>Dear {{customerName}},</p><p>Keep every chart, recording, written summary and receipt in one quiet place.</p><p><a href="{{accountUrl}}">Open my reading room</a></p>',
    text_body = 'Dear {{customerName}}, Keep every chart, recording, written summary and receipt in one quiet place. Open my reading room {{accountUrl}}',
    required_variables_json = '["customerName","accountUrl"]',
    sample_payload_json = '{"customerName":"Marguerite","accountUrl":"https://example.com/account"}',
    updated_by = 'system',
    updated_at = '2026-08-18T00:00:00.000Z'
WHERE key = 'customer_welcome_en';
