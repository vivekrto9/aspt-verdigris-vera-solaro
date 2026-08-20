-- The reset note was three bare lines and said nothing about what to do if the
-- request was not yours. It now carries the same shape as the rest of the Vera
-- post: an opening, the one thing to press, what it is good for, a plain way out
-- if it was not you, and the signature. Only the two variables the aggregator
-- sends are used, since the renderer rejects any token it was not promised.
UPDATE ap_email_templates
SET subject = 'Find your way back.',
    preheader = 'One hour, one link, and your current password works until you use it.',
    html_body = '<p>Dear {{customerName}},</p><p>Somebody asked for a new password on your account. If that was you, the link below sets one.</p><p><a href="{{resetUrl}}">Choose a new password →</a></p><p>Good for<br>One hour from the moment this was sent</p><p>If it wasn''t you, do nothing whatsoever. Your current password still works and nothing has changed.</p><p>Vera</p><p>Via delle Stelle 12, Trieste · This link was asked for from the sign-in page and can be used once.</p>',
    text_body = 'Dear {{customerName}}, Somebody asked for a new password on your account. If that was you, the link below sets one. Choose a new password → {{resetUrl}} Good for One hour from the moment this was sent If it wasn''t you, do nothing whatsoever. Your current password still works and nothing has changed. Vera Via delle Stelle 12, Trieste · This link was asked for from the sign-in page and can be used once.',
    required_variables_json = '["customerName","resetUrl"]',
    sample_payload_json = '{"customerName":"Marguerite","resetUrl":"https://example.com/reset-password?token=example"}',
    updated_by = 'system',
    updated_at = '2026-08-19T00:00:00.000Z'
WHERE key = 'customer_password_reset_en';
