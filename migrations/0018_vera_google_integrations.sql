CREATE TABLE IF NOT EXISTS ap_shared_calendar_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  calendar_id TEXT NOT NULL,
  timezone TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Existing bookings belong to Calendly, regardless of the current selection.
ALTER TABLE ap_vera_bookings ADD COLUMN scheduling_provider TEXT NOT NULL DEFAULT 'calendly';
ALTER TABLE ap_vera_bookings ADD COLUMN scheduling_calendar_id TEXT;
ALTER TABLE ap_vera_bookings ADD COLUMN scheduling_timezone TEXT;
ALTER TABLE ap_vera_bookings ADD COLUMN scheduling_rules_json TEXT;
ALTER TABLE ap_vera_bookings ADD COLUMN scheduling_buffer_before INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ap_vera_bookings ADD COLUMN scheduling_buffer_after INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ap_vera_bookings ADD COLUMN scheduling_attempted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ap_vera_bookings ADD COLUMN scheduling_operation TEXT;
ALTER TABLE ap_vera_bookings ADD COLUMN analytics_client_id TEXT;
ALTER TABLE ap_vera_bookings ADD COLUMN analytics_provider TEXT;
ALTER TABLE ap_vera_bookings ADD COLUMN analytics_session_id TEXT;
ALTER TABLE ap_vera_email_outbox ADD COLUMN delivery_provider TEXT;

-- Interval reservations supplement the legacy 30-minute holds. They protect
-- arbitrary Google slot spacing and buffers, including cross-provider overlap.
CREATE TABLE ap_vera_scheduling_reservations (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES ap_vera_bookings(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
  expires_at TEXT,
  CHECK (id = booking_id OR id = booking_id || ':reschedule')
);
CREATE INDEX ap_vera_reservation_range ON ap_vera_scheduling_reservations(start_ms, end_ms);
INSERT INTO ap_vera_scheduling_reservations (id, booking_id, start_ms, end_ms, expires_at)
SELECT id, id,
  CAST(ROUND((julianday(selected_start_at) - 2440587.5) * 86400000) AS INTEGER),
  CAST(ROUND((julianday(selected_end_at) - 2440587.5) * 86400000) AS INTEGER),
  CASE WHEN payment_state IN ('paid', 'deposit_paid') THEN NULL ELSE hold_expires_at END
FROM ap_vera_bookings
WHERE status NOT IN ('cancelled', 'expired', 'refunded', 'completed')
  AND julianday(selected_end_at) > julianday(selected_start_at);

CREATE TRIGGER ap_vera_reservation_insert_guard BEFORE INSERT ON ap_vera_scheduling_reservations
BEGIN
  SELECT RAISE(ABORT, 'vera_slot_unavailable') WHERE EXISTS (
    SELECT 1 FROM ap_vera_scheduling_reservations r
    WHERE r.booking_id != NEW.booking_id AND r.start_ms < NEW.end_ms AND r.end_ms > NEW.start_ms
      AND EXISTS (SELECT 1 FROM ap_vera_bookings b WHERE b.id IN (r.booking_id, NEW.booking_id) AND b.scheduling_provider = 'google_calendar')
      AND (r.expires_at IS NULL OR julianday(r.expires_at) > julianday('now'))
  );
END;
CREATE TRIGGER ap_vera_reservation_update_guard BEFORE UPDATE ON ap_vera_scheduling_reservations
BEGIN
  SELECT RAISE(ABORT, 'vera_slot_unavailable') WHERE EXISTS (
    SELECT 1 FROM ap_vera_scheduling_reservations r
    WHERE r.booking_id != NEW.booking_id AND r.start_ms < NEW.end_ms AND r.end_ms > NEW.start_ms
      AND EXISTS (SELECT 1 FROM ap_vera_bookings b WHERE b.id IN (r.booking_id, NEW.booking_id) AND b.scheduling_provider = 'google_calendar')
      AND (r.expires_at IS NULL OR julianday(r.expires_at) > julianday('now'))
  );
END;
CREATE TRIGGER ap_vera_booking_reservation_insert AFTER INSERT ON ap_vera_bookings
WHEN NEW.status NOT IN ('cancelled', 'expired', 'refunded', 'completed')
BEGIN
  INSERT INTO ap_vera_scheduling_reservations (id, booking_id, start_ms, end_ms, expires_at)
  VALUES (NEW.id, NEW.id,
    CAST(ROUND((julianday(NEW.selected_start_at) - 2440587.5) * 86400000) AS INTEGER) - NEW.scheduling_buffer_before * 60000,
    CAST(ROUND((julianday(NEW.selected_end_at) - 2440587.5) * 86400000) AS INTEGER) + NEW.scheduling_buffer_after * 60000,
    CASE WHEN NEW.payment_state IN ('paid', 'deposit_paid') THEN NULL ELSE NEW.hold_expires_at END);
END;
CREATE TRIGGER ap_vera_booking_reservation_update
AFTER UPDATE OF status, payment_state, selected_start_at, selected_end_at, hold_expires_at ON ap_vera_bookings
BEGIN
  DELETE FROM ap_vera_scheduling_reservations WHERE booking_id = NEW.id
    AND NEW.status IN ('cancelled', 'expired', 'refunded', 'completed');
  INSERT INTO ap_vera_scheduling_reservations (id, booking_id, start_ms, end_ms, expires_at)
  SELECT NEW.id, NEW.id,
    CAST(ROUND((julianday(NEW.selected_start_at) - 2440587.5) * 86400000) AS INTEGER) - NEW.scheduling_buffer_before * 60000,
    CAST(ROUND((julianday(NEW.selected_end_at) - 2440587.5) * 86400000) AS INTEGER) + NEW.scheduling_buffer_after * 60000,
    CASE WHEN NEW.payment_state IN ('paid', 'deposit_paid') THEN NULL ELSE NEW.hold_expires_at END
  WHERE NEW.status NOT IN ('cancelled', 'expired', 'refunded', 'completed')
  ON CONFLICT(id) DO UPDATE SET start_ms = excluded.start_ms, end_ms = excluded.end_ms, expires_at = excluded.expires_at;
END;
