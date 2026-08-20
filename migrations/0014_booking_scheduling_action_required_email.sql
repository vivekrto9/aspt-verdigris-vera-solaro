-- Match the shared Single Astrologer booking outcome contract: a verified
-- payment that cannot be scheduled automatically gets its own managed email.

INSERT INTO ap_email_events
  (event_type, audience, email_type, enabled, schedule_json, updated_at)
VALUES
  (
    'vera.booking.scheduling_action_required',
    'customer',
    'transactional',
    1,
    '{}',
    '2026-08-19T00:00:00.000Z'
  )
ON CONFLICT(event_type) DO UPDATE SET
  audience = excluded.audience,
  email_type = excluded.email_type,
  enabled = 1,
  updated_at = excluded.updated_at;

INSERT INTO ap_email_variable_mappings
  (variable_key, source_type, source_path, enabled, updated_at)
VALUES
  ('selectedSlot', 'event_payload', 'selectedSlot', 1, '2026-08-19T00:00:00.000Z')
ON CONFLICT(variable_key) DO UPDATE SET
  source_type = excluded.source_type,
  source_path = excluded.source_path,
  enabled = 1,
  updated_at = excluded.updated_at;

INSERT INTO ap_email_templates (
  key, display_name, event_type, audience, locale, channel, enabled, subject,
  preheader, html_body, text_body, required_variables_json, sample_payload_json,
  updated_by, updated_at
) VALUES (
  'vera_booking_action_required_en',
  'Vera scheduling action required',
  'vera.booking.scheduling_action_required',
  'customer',
  'en',
  'email',
  1,
  'Payment confirmed — scheduling assistance required',
  'Your payment is safe and your selected time remains protected.',
  '<p>Dear {{customerName}},</p><p>Your payment for <strong>{{serviceName}}</strong> is confirmed.</p><p>Calendly could not create the appointment automatically for <strong>{{selectedSlot}}</strong>, but that selected time remains protected in Vera''s booking system.</p><p>Do not pay or book again.</p><p>Reference<br>{{bookingNumber}}</p><p><a href="{{confirmationUrl}}">View your booking status</a></p><p>Vera will help finalize the appointment once the scheduling connection is corrected.</p>',
  'Dear {{customerName}}, Your payment for {{serviceName}} is confirmed. Calendly could not create the appointment automatically for {{selectedSlot}}, but that selected time remains protected in Vera''s booking system. Do not pay or book again. Reference {{bookingNumber}} View your booking status {{confirmationUrl}} Vera will help finalize the appointment once the scheduling connection is corrected.',
  '["customerName","bookingNumber","serviceName","selectedSlot","confirmationUrl"]',
  '{"customerName":"Marguerite","bookingNumber":"VS-013-YA","serviceName":"The Natal Hour","selectedSlot":"Wednesday 19 August 2026, 7:00pm","confirmationUrl":"https://example.com/booking/vbooking_example/confirmation"}',
  'system:booking-email-manifest',
  '2026-08-19T00:00:00.000Z'
)
ON CONFLICT(key) DO UPDATE SET
  display_name = excluded.display_name,
  event_type = excluded.event_type,
  audience = excluded.audience,
  locale = excluded.locale,
  channel = excluded.channel,
  enabled = excluded.enabled,
  subject = excluded.subject,
  preheader = excluded.preheader,
  html_body = excluded.html_body,
  text_body = excluded.text_body,
  required_variables_json = excluded.required_variables_json,
  sample_payload_json = excluded.sample_payload_json,
  updated_by = excluded.updated_by,
  updated_at = excluded.updated_at;

-- The current booking flow is full-payment only. Keep the successful outcome
-- email on the same confirmed-appointment contract as Single Astrologer.
UPDATE ap_email_templates
SET
  subject = 'Your {{serviceName}} sitting is confirmed',
  preheader = 'Your payment is verified and your Calendly appointment is confirmed.',
  html_body = '<p>Dear {{customerName}},</p><p>Your payment is verified and your <strong>{{serviceName}}</strong> sitting is confirmed for <strong>{{scheduledDateTime}}</strong>.</p><p>Reference<br>{{bookingNumber}}</p><p><a href="{{confirmationUrl}}">Open appointment details</a></p><p>You can review, reschedule or cancel the appointment from its secure details page.</p>',
  text_body = 'Dear {{customerName}}, Your payment is verified and your {{serviceName}} sitting is confirmed for {{scheduledDateTime}}. Reference {{bookingNumber}} Open appointment details {{confirmationUrl}} You can review, reschedule or cancel the appointment from its secure details page.',
  required_variables_json = '["customerName","bookingNumber","serviceName","scheduledDateTime","confirmationUrl"]',
  sample_payload_json = '{"customerName":"Marguerite","bookingNumber":"VS-013-YA","serviceName":"The Natal Hour","scheduledDateTime":"Wednesday 19 August 2026, 7:00pm","confirmationUrl":"https://example.com/booking/vbooking_example/confirmation"}',
  updated_by = 'system:booking-email-manifest',
  updated_at = '2026-08-19T00:00:00.000Z'
WHERE key = 'vera_booking_confirmed_en'
  AND event_type = 'vera.booking.confirmed';
