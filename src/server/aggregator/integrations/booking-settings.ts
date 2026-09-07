import type { RuntimeEnv } from "../runtime.ts";
import { googleCalendarRequest } from "./google.ts";
import { validateCalendarRules, generateCalendarSlots, calendarBusy, getSharedCalendar } from "./google-calendar.ts";
import { getBookingPreviewPolicy } from "./booking-preview-policy.ts";

type Calendar = { id: string; summary: string; timeZone: string; accessRole: string };
export const writableBookingCalendars = async (env: RuntimeEnv) => {
  const calendars: Calendar[] = [];
  let pageToken = "";
  let pages = 0;
  do {
    const response = await googleCalendarRequest(env, "/users/me/calendarList?maxResults=250" + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""));
    if (!response.ok) throw new Error("Reconnect Google Calendar and apply credentials to this environment.");
    const data = await response.json() as { items?: Calendar[]; nextPageToken?: string };
    calendars.push(...(data.items ?? []).filter((item) => ["owner", "writer"].includes(item.accessRole)));
    pageToken = data.nextPageToken || "";
    if (++pages > 20) throw new Error("Too many calendars. Contact support.");
  } while (pageToken);
  return calendars;
};

export const readBookingSettings = async (env: RuntimeEnv) => {
  if (!env.DB) throw new Error("Booking storage is unavailable.");
  const calendars = await writableBookingCalendars(env);
  const sharedSettings = await getSharedCalendar(env);
  const previewPolicy = await getBookingPreviewPolicy(env);
  const production = String(env.ASTROPAGES_SITE_ENVIRONMENT) === "production";
  let ready = false;
  if (sharedSettings) {
    try {
      const rules = validateCalendarRules(JSON.parse(sharedSettings.rules_json));
      ready = Object.values(rules.weekly).some((windows) => windows.length > 0)
        && calendars.some((calendar) => calendar.id === sharedSettings.calendar_id)
        && (production || (previewPolicy.calendarIds.includes(sharedSettings.calendar_id) && previewPolicy.recipients.length > 0));
    } catch { /* Invalid saved rules need owner review. */ }
  }
  const rows = await env.DB.prepare("SELECT DISTINCT duration_minutes AS minutes FROM ap_vera_services WHERE active = 1 ORDER BY minutes").all?.<{ minutes?: number }>() ?? { results: [] };
  const durations = (rows.results ?? []).map((row) => Number(row.minutes)).filter((minutes) => Number.isInteger(minutes) && minutes > 0 && minutes <= 240);
  return { scope: "shared-v1" as const, calendars, sharedSettings, durations, previewPolicy, ready };
};

export const saveBookingSettings = async (env: RuntimeEnv, input: unknown) => {
  if (!input || typeof input !== "object") throw new Error("Booking settings are required.");
  const body = input as { advisor?: string; calendarId?: string; timezone?: string; rules?: unknown; previewPolicy?: { recipients?: unknown } };
  if (body.advisor) throw new Error("Booking setup now uses shared hours. Refresh AstroPages before saving.");
  if (!body.calendarId || body.calendarId.length > 255) throw new Error("Select a writable calendar.");
  if (!body.timezone || body.timezone.length > 100) throw new Error("Select a timezone.");
  new Intl.DateTimeFormat("en", { timeZone: body.timezone }).format();
  const rules = validateCalendarRules(body.rules);
  if (!Object.values(rules.weekly).some((windows) => windows.length)) throw new Error("Add working hours for at least one day.");
  const calendars = await writableBookingCalendars(env);
  if (!calendars.some((calendar) => calendar.id === body.calendarId)) throw new Error("Calendar write access is required.");
  const policy = body.previewPolicy;
  let nextPolicy = await getBookingPreviewPolicy(env);
  if (String(env.ASTROPAGES_SITE_ENVIRONMENT) !== "production") {
    if (!policy || !Array.isArray(policy.recipients)) throw new Error("Add at least one preview test recipient.");
    if (!policy.recipients.length || policy.recipients.length > 50 || policy.recipients.some((email) => typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error("Enter valid test recipient emails.");
    nextPolicy = { calendarIds: [body.calendarId], recipients: (policy.recipients as string[]).map((email) => email.toLowerCase()) };
  }
  if (!env.DB) throw new Error("Booking storage is unavailable.");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO ap_shared_calendar_settings (id, calendar_id, timezone, rules_json, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET calendar_id = excluded.calendar_id, timezone = excluded.timezone, rules_json = excluded.rules_json, updated_at = excluded.updated_at")
    .bind(body.calendarId, body.timezone, JSON.stringify(rules), now).run();
  await env.DB.prepare("INSERT INTO ap_booking_preview_policy (id, calendar_ids_json, recipients_json, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET calendar_ids_json = excluded.calendar_ids_json, recipients_json = excluded.recipients_json, updated_at = excluded.updated_at")
    .bind(JSON.stringify(nextPolicy.calendarIds), JSON.stringify(nextPolicy.recipients), now).run();
  return readBookingSettings(env);
};

// This is a shared-hours sample, not a particular advisor's live availability.
export const previewBookingSlots = async (env: RuntimeEnv, input: unknown) => {
  const body = input as { minutes?: number; start?: string };
  if (!Number.isInteger(body?.minutes) || body.minutes! < 1 || body.minutes! > 1440) throw new Error("Select a consultation duration.");
  const settings = await getSharedCalendar(env);
  if (!settings) throw new Error("Save shared working hours first.");
  const rules = validateCalendarRules(JSON.parse(settings.rules_json));
  const now = Date.now();
  const requestedStart = body.start ? Date.parse(body.start) : now;
  if (!Number.isFinite(requestedStart) || requestedStart > now + 90 * 86400000) throw new Error("Invalid preview date.");
  const start = Math.max(requestedStart, now + (rules.minimumNoticeMinutes ?? 5) * 60000);
  const end = Math.min(start + 7 * 86400000, now + (rules.bookingHorizonDays ?? 7) * 86400000);
  if (end <= start) return { slots: [], timezone: settings.timezone };
  const busy = await calendarBusy(env, settings.calendar_id, start - rules.bufferBefore * 60000, end + rules.bufferAfter * 60000, "", settings.timezone);
  const slots = generateCalendarSlots({ start, end, minutes: body.minutes!, timezone: settings.timezone, rules, busy });
  return { slots: slots.slice(0, 100).map((startTime) => ({ startTime })), timezone: settings.timezone };
};
