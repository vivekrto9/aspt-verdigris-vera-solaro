import { getRuntimeConfigValue } from "../aggregator/runtime-config.ts";
import { googleCalendarRequest } from "../aggregator/integrations/google.ts";
import { assertPreviewBookingRecipient, assertTestCalendar, calendarBusy, generateCalendarSlots, getSharedCalendar, validateCalendarRules } from "../aggregator/integrations/google-calendar.ts";
import type { CalendarSettings } from "../aggregator/integrations/google-calendar.ts";
import { all, changeCount, first, run, runStatements, safeString, sha256Hex } from "./db.ts";
import type { VeraEnv, VeraRow } from "./types.ts";

export const selectedVeraSchedulingProvider = async (env: VeraEnv) => {
  const provider = await getRuntimeConfigValue(env, "ACTIVE_SCHEDULING_PROVIDER") || "calendly";
  if (provider !== "calendly" && provider !== "google_calendar") throw new Error("Selected scheduling provider is unavailable.");
  return provider;
};

export const veraCalendarSettings = async (env: VeraEnv, booking?: VeraRow): Promise<CalendarSettings> => {
  const settings = booking ? {
    calendar_id: safeString(booking.scheduling_calendar_id),
    timezone: safeString(booking.scheduling_timezone),
    rules_json: safeString(booking.scheduling_rules_json),
  } : await getSharedCalendar(env);
  if (!settings?.calendar_id || !settings.timezone) throw new Error("Finish Google Calendar booking setup in AstroPages.");
  validateCalendarRules(JSON.parse(settings.rules_json));
  await assertTestCalendar(env, settings.calendar_id);
  return settings;
};

export const listVeraGoogleTimes = async (env: VeraEnv, minutes: number, start: number, end: number, booking?: VeraRow) => {
  const settings = await veraCalendarSettings(env, booking);
  const rules = validateCalendarRules(JSON.parse(settings.rules_json));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 7 * 86400000) throw new Error("Select a date range of up to seven days.");
  const now = Date.now();
  start = Math.max(start, now + rules.minimumNoticeMinutes! * 60000);
  end = Math.min(end, now + rules.bookingHorizonDays! * 86400000);
  if (end <= start) return { settings, rules, times: [] };
  const bookingId = safeString(booking?.id);
  const busy = await calendarBusy(env, settings.calendar_id, start - rules.bufferBefore * 60000, end + rules.bufferAfter * 60000, "", settings.timezone, bookingId);
  const reservations = await all(env, `SELECT start_ms, end_ms FROM ap_vera_scheduling_reservations
    WHERE booking_id != ? AND (expires_at IS NULL OR expires_at > ?)
      AND start_ms < ? AND end_ms > ?`, [bookingId, new Date().toISOString(), end + rules.bufferAfter * 60000, start - rules.bufferBefore * 60000]);
  busy.push(...reservations.map((row) => ({ start: Number(row.start_ms), end: Number(row.end_ms) })));
  return { settings, rules, times: generateCalendarSlots({ start, end, minutes, timezone: settings.timezone, rules, busy }).map((startAt) => ({ startAt, schedulingUrl: "" })) };
};

export const checkVeraGoogleSlot = async (env: VeraEnv, minutes: number, startAt: string, booking?: VeraRow, email?: string) => {
  try {
    if (email) await assertPreviewBookingRecipient(env, email);
    const start = Date.parse(startAt);
    const available = await listVeraGoogleTimes(env, minutes, start, start + minutes * 60000, booking);
    return { ok: true as const, status: 200, available: available.times.some((slot) => slot.startAt === startAt), settings: available.settings, rules: available.rules, missingSecretNames: [] as string[] };
  } catch (error) {
    return { ok: false as const, status: 503, message: error instanceof Error ? error.message : "Google Calendar is unavailable.", missingSecretNames: [] as string[] };
  }
};

const eventIdFor = async (env: VeraEnv, bookingId: string, startAt: string) =>
  "ap" + await sha256Hex([String(env.ASTROPAGES_PROJECT_ID || "local"), String(env.ASTROPAGES_SITE_ENVIRONMENT || "local"), bookingId, startAt].join("\n"));
const reference = (calendar: string, id: string) => `google-calendar:${encodeURIComponent(calendar)}/${id}`;
export const isVeraGoogleEventReference = (value: string) => /^google-calendar:[^/]+\/ap[a-f0-9]{64}$/.test(value);
type Event = { id?: string; etag?: string; status?: string; hangoutLink?: string; start?: { dateTime?: string }; end?: { dateTime?: string }; extendedProperties?: { private?: { astropagesBookingId?: string; astropagesProjectId?: string; astropagesEnvironment?: string } } };
const ownsEvent = (env: VeraEnv, booking: VeraRow, event: Event) =>
  event.extendedProperties?.private?.astropagesBookingId === safeString(booking.id)
  && event.extendedProperties.private.astropagesProjectId === String(env.ASTROPAGES_PROJECT_ID || "local")
  && event.extendedProperties.private.astropagesEnvironment === String(env.ASTROPAGES_SITE_ENVIRONMENT || "local");

// Deterministic IDs allow recovery after a lost response without a second event.
export const createVeraGoogleEvent = async ({ env, booking, startAt }: { env: VeraEnv; booking: VeraRow; startAt: string }) => {
  let writeAttempted = false;
  let operationClaimed = false;
  try {
    if (!["paid", "deposit_paid"].includes(safeString(booking.payment_state))) throw new Error("Verified payment is required before scheduling.");
    const operation = startAt === safeString(booking.selected_start_at) ? "create" : "reschedule";
    const claimed = await run(env, "UPDATE ap_vera_bookings SET scheduling_attempted = 1, scheduling_operation = ? WHERE id = ? AND (scheduling_operation IS NULL OR (? = 'reschedule' AND scheduling_operation = 'reschedule')) AND status IN ('pending_payment', 'payment_action_required', 'confirmed', 'reschedule_pending') AND payment_state IN ('paid', 'deposit_paid') AND cancelled_at IS NULL AND NOT EXISTS (SELECT 1 FROM ap_vera_refunds WHERE booking_id = ? AND status IN ('pending', 'succeeded'))", [operation, booking.id, operation, booking.id]);
    if (changeCount(claimed) !== 1) throw new Error("The booking changed before scheduling.");
    operationClaimed = true;
    const settings = await veraCalendarSettings(env, booking);
    await assertPreviewBookingRecipient(env, safeString(booking.email));
    const minutes = (Date.parse(safeString(booking.selected_end_at)) - Date.parse(safeString(booking.selected_start_at))) / 60000;
    const endAt = new Date(Date.parse(startAt) + minutes * 60000).toISOString();
    const id = await eventIdFor(env, safeString(booking.id), startAt);
    const path = `/calendars/${encodeURIComponent(settings.calendar_id)}/events`;
    let response = await googleCalendarRequest(env, `${path}/${id}`);
    if (response.status === 404) {
      // Recheck real busy events immediately before creating, but do not reapply
      // minimum notice to an already-paid, locally reserved appointment.
      if (Date.parse(startAt) <= Date.now()) throw new Error("The selected time has passed. Contact support.");
      const rules = validateCalendarRules(JSON.parse(settings.rules_json));
      const busy = await calendarBusy(env, settings.calendar_id, Date.parse(startAt) - rules.bufferBefore * 60000, Date.parse(endAt) + rules.bufferAfter * 60000, "", settings.timezone, safeString(booking.id));
      if (busy.length) throw new Error("Google Calendar is now busy. Your payment is retained; contact support.");
      const held = await first(env, `SELECT id FROM ap_vera_scheduling_reservations WHERE booking_id = ?
        AND start_ms <= ? AND end_ms >= ? AND (expires_at IS NULL OR expires_at > ?)`,
      [booking.id, Date.parse(startAt) - rules.bufferBefore * 60000, Date.parse(endAt) + rules.bufferAfter * 60000, new Date().toISOString()]);
      if (!held) throw new Error("The booking reservation needs reconciliation.");
      writeAttempted = true;
      try {
        response = await googleCalendarRequest(env, `${path}?sendUpdates=all`, {
          method: "POST", body: JSON.stringify({ id,
            summary: `${String(env.ASTROPAGES_SITE_ENVIRONMENT) === "production" ? "" : "[TEST] "}Vera — Consultation ${safeString(booking.booking_number)}`,
            start: { dateTime: startAt, timeZone: settings.timezone }, end: { dateTime: endAt, timeZone: settings.timezone },
            attendees: [{ email: safeString(booking.email) }],
            extendedProperties: { private: { astropagesBookingId: safeString(booking.id), astropagesProjectId: String(env.ASTROPAGES_PROJECT_ID || "local"), astropagesEnvironment: String(env.ASTROPAGES_SITE_ENVIRONMENT || "local") } },
          }),
        });
      } catch {
        response = await googleCalendarRequest(env, `${path}/${id}`);
      }
      if (response.status === 409) response = await googleCalendarRequest(env, `${path}/${id}`);
    }
    if (!response.ok) throw new Error("Google Calendar could not confirm the booking. Check permissions or reconcile before retrying.");
    const event = await response.json() as Event;
    if (event.id !== id || event.status === "cancelled" || !ownsEvent(env, booking, event)
      || Date.parse(event.start?.dateTime || "") !== Date.parse(startAt) || Date.parse(event.end?.dateTime || "") !== Date.parse(endAt)) throw new Error("Google Calendar event does not match this booking. Contact support.");
    return { ok: true as const, status: 200, message: "Google Calendar booking confirmed.", result: {
      eventUri: reference(settings.calendar_id, id), inviteeUri: reference(settings.calendar_id, id), startAt, endAt,
      cancelUrl: "", rescheduleUrl: "", meetingUrl: event.hangoutLink?.startsWith("https://meet.google.com/") ? event.hangoutLink : "",
    } };
  } catch (error) {
    return { ok: false as const, status: operationClaimed ? 502 : 409, message: error instanceof Error ? error.message : "Google Calendar needs reconciliation.", outcomeUnknown: writeAttempted, operationClaimed, missingSecretNames: [] as string[] };
  }
};

export const cancelVeraGoogleEvent = async (env: VeraEnv, eventUri: string) => {
  try {
    if (!isVeraGoogleEventReference(eventUri)) throw new Error("Invalid Google Calendar event reference.");
    const [encodedCalendar, id] = eventUri.slice("google-calendar:".length).split("/");
    const calendar = decodeURIComponent(encodedCalendar);
    await assertTestCalendar(env, calendar);
    const path = `/calendars/${encodedCalendar}/events/${id}`;
    const response = await googleCalendarRequest(env, path);
    if (response.status === 404 || response.status === 410) return { ok: true as const, status: 200, message: "Event is already absent.", missingSecretNames: [] as string[] };
    if (!response.ok) throw new Error("Google Calendar cancellation could not be verified.");
    const event = await response.json() as Event;
    const booking = await first(env, "SELECT * FROM ap_vera_bookings WHERE id = ? AND scheduling_provider = 'google_calendar' AND scheduling_calendar_id = ?", [event.extendedProperties?.private?.astropagesBookingId || "", calendar]);
    if (!booking || !ownsEvent(env, booking, event) || !event.etag || event.id !== id) throw new Error("Event ownership could not be verified.");
    if (event.status === "cancelled") return { ok: true as const, status: 200, message: "Event is already cancelled.", missingSecretNames: [] as string[] };
    await assertPreviewBookingRecipient(env, safeString(booking.email));
    const removed = await googleCalendarRequest(env, `${path}?sendUpdates=all`, { method: "DELETE", headers: { "If-Match": event.etag } });
    if (!removed.ok && removed.status !== 410) throw new Error("Google Calendar cancellation needs reconciliation.");
    return { ok: true as const, status: 200, message: "Google Calendar event cancelled.", missingSecretNames: [] as string[] };
  } catch {
    return { ok: false as const, status: 502, message: "Google Calendar cancellation needs reconciliation before releasing the booking.", outcomeUnknown: true as const, missingSecretNames: [] as string[] };
  }
};

export const reserveVeraGoogleReschedule = async (env: VeraEnv, booking: VeraRow, startAt: string, minutes: number) => {
  const rules = validateCalendarRules(JSON.parse(safeString(booking.scheduling_rules_json)));
  const claimed = await run(env, "UPDATE ap_vera_bookings SET scheduling_operation = 'reschedule' WHERE id = ? AND scheduling_operation IS NULL AND status IN ('confirmed', 'reschedule_pending') AND cancelled_at IS NULL", [booking.id]);
  if (changeCount(claimed) !== 1) throw new Error("Another calendar operation needs reconciliation.");
  // A permanent second reservation preserves both times until provider and DB
  // agree. Never overwrite an unresolved replacement with a different slot.
  try {
    await run(env, `INSERT INTO ap_vera_scheduling_reservations (id, booking_id, start_ms, end_ms, expires_at)
      VALUES (?, ?, ?, ?, NULL)`, [`${booking.id}:reschedule`, booking.id, Date.parse(startAt) - rules.bufferBefore * 60000, Date.parse(startAt) + (minutes + rules.bufferAfter) * 60000]);
  } catch (error) {
    await run(env, "UPDATE ap_vera_bookings SET scheduling_operation = NULL WHERE id = ? AND scheduling_operation = 'reschedule'", [booking.id]);
    throw error;
  }
};

export const releaseVeraGoogleReschedule = async (env: VeraEnv, bookingId: string) => runStatements(env, [
  env.DB!.prepare("DELETE FROM ap_vera_scheduling_reservations WHERE id = ?").bind(bookingId + ":reschedule"),
  env.DB!.prepare("UPDATE ap_vera_bookings SET scheduling_operation = NULL WHERE id = ? AND scheduling_operation = 'reschedule'").bind(bookingId),
]);
