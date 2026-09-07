import { getBookingPreviewPolicy } from "./booking-preview-policy.ts";
import { googleCalendarRequest } from "./google.ts";
import type { RuntimeEnv } from "../runtime.ts";

export type CalendarRules = {
  weekly: Record<string, Array<{ start: number; end: number }>>;
  minimumNoticeMinutes?: number; bookingHorizonDays?: number;
  blackoutDates: string[]; bufferBefore: number; bufferAfter: number; slotStepMinutes: number;
};
export type CalendarSettings = { advisor_slug?: string; calendar_id: string; timezone: string; rules_json: string };
type Busy = { start: number; end: number };
const minute = 60_000;
const database = (env: RuntimeEnv) => { if (!env.DB) throw new Error("Booking storage is unavailable."); return env.DB; };
export const validateCalendarRules = (input: unknown): CalendarRules => {
  if (!input || typeof input !== "object") throw new Error("Availability rules are required.");
  const rules = input as CalendarRules;
  if (!rules.weekly || typeof rules.weekly !== "object" || Array.isArray(rules.weekly)) throw new Error("Weekly availability is required.");
  for (const [day, windows] of Object.entries(rules.weekly)) {
    if (!/^[0-6]$/.test(day) || !Array.isArray(windows) || windows.length > 8) throw new Error("Invalid weekly availability.");
    const sorted = [...windows].sort((a, b) => a.start - b.start);
    if (sorted.some((window, index) => index > 0 && window.start < sorted[index - 1].end)) throw new Error("Working hours cannot overlap.");
    for (const window of windows) if (!Number.isInteger(window.start) || !Number.isInteger(window.end) || window.start < 0 || window.end > 1440 || window.end <= window.start) throw new Error("Invalid working hours.");
  }
  if (!Array.isArray(rules.blackoutDates) || rules.blackoutDates.length > 366 || rules.blackoutDates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error("Invalid blackout dates.");
  if (![rules.bufferBefore, rules.bufferAfter].every((value) => Number.isInteger(value) && value >= 0 && value <= 180)) throw new Error("Buffers must be between 0 and 180 minutes.");
  if (!Number.isInteger(rules.slotStepMinutes) || rules.slotStepMinutes < 1 || rules.slotStepMinutes > 1440) throw new Error("Start-time spacing must be a whole number from 1 to 1440 minutes.");
  const minimumNoticeMinutes = rules.minimumNoticeMinutes ?? 5;
  const bookingHorizonDays = rules.bookingHorizonDays ?? 7;
  if (!Number.isInteger(minimumNoticeMinutes) || minimumNoticeMinutes < 5 || minimumNoticeMinutes > 10080) throw new Error("Minimum notice must be 5 to 10080 minutes.");
  if (!Number.isInteger(bookingHorizonDays) || bookingHorizonDays < 1 || bookingHorizonDays > 90) throw new Error("Booking window must be 1 to 90 days.");
  return { ...rules, minimumNoticeMinutes, bookingHorizonDays };
};
export const getSharedCalendar = async (env: RuntimeEnv): Promise<CalendarSettings | null> => {
  const query = database(env).prepare("SELECT * FROM ap_shared_calendar_settings WHERE id = 1");
  if (!query.first) throw new Error("Booking storage is unavailable.");
  return await query.first() as CalendarSettings | null;
};

export const assertTestCalendar = async (env: RuntimeEnv, calendarId: string) => {
  if (String(env.ASTROPAGES_SITE_ENVIRONMENT) === "production") return;
  const allowed = (await getBookingPreviewPolicy(env)).calendarIds;
  if (!calendarId || !allowed.includes(calendarId)) throw new Error("Preview booking requires an explicitly allowlisted test calendar.");
};
export const assertPreviewBookingRecipient = async (env: RuntimeEnv, email: string) => {
  if (String(env.ASTROPAGES_SITE_ENVIRONMENT) === "production") return;
  const recipient = String(email).trim().toLowerCase();
  const allowed = (await getBookingPreviewPolicy(env)).recipients;
  if (!recipient || !allowed.includes(recipient)) throw new Error("Use an allowed preview test recipient before continuing to payment.");
};
type CalendarEvent = {
  id?: string; summary?: string; status?: string; transparency?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: { astropagesBookingId?: string; astropagesAdvisorSlug?: string; astropagesBlockAll?: string } };
};
// Expand recurring and all-day events, preserving timezone and cancellation semantics.
const eventTime = (value: { dateTime?: string; date?: string } | undefined, timezone: string) => {
  if (value?.dateTime) return Date.parse(value.dateTime);
  if (!value?.date || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return NaN;
  const desired = Date.parse(value.date + "T00:00:00Z");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let result = desired;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(formatter.formatToParts(result).map((part) => [part.type, part.value]));
    const displayed = Date.parse(p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute + ":" + p.second + "Z");
    if (displayed === desired) return result;
    result += desired - displayed;
  }
  throw new Error("Calendar all-day event timezone could not be verified.");
};
export const calendarBusy = async (
  env: RuntimeEnv, calendarId: string, start: number, end: number,
  _advisor: string, timezone: string, excludeBookingId = "",
): Promise<Busy[]> => {
  await assertTestCalendar(env, calendarId);
  const busy: Busy[] = [];
  let pageToken = "";
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(),
      singleEvents: "true", showDeleted: "false", maxResults: "250", timeZone: timezone,
      fields: "items(id,summary,status,transparency,start,end,extendedProperties),nextPageToken,timeZone",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await googleCalendarRequest(env, "/calendars/" + encodeURIComponent(calendarId) + "/events?" + params);
    if (!response.ok) throw new Error(`Calendar availability failed (HTTP ${response.status}). Check permissions.`);
    const data = await response.json() as { items?: CalendarEvent[]; nextPageToken?: string; timeZone?: string };
    if (!Array.isArray(data.items)) throw new Error("Calendar returned invalid availability.");
    for (const event of data.items) {
      if (event.status === "cancelled" || event.transparency === "transparent") continue;
      const tags = event.extendedProperties?.private;
      if (excludeBookingId && tags?.astropagesBookingId === excludeBookingId) continue;
      // Vera is a single practitioner: ordinary busy events also block bookings.
      const interval = { start: eventTime(event.start, data.timeZone || timezone), end: eventTime(event.end, data.timeZone || timezone) };
      if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.end <= interval.start) throw new Error("Calendar returned invalid event times.");
      busy.push(interval);
    }
    pageToken = data.nextPageToken || "";
    if (!pageToken) return busy;
  }
  throw new Error("Too many calendar events to verify availability. Narrow the date range.");
};
export const generateCalendarSlots = (input: {
  start: number; end: number; minutes: number; timezone: string; rules: CalendarRules; busy: Busy[];
}) => {
  const { rules, start, end, minutes, busy } = input;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 7 * 86400000 || !Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error("Invalid availability range.");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: input.timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const slots: string[] = [];
  for (let at = Math.ceil(start / minute) * minute; at + minutes * minute <= end; at += minute) {
    const parts = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = Number(parts.hour) * 60 + Number(parts.minute);
    if (rules.blackoutDates.includes(date)) continue;
    const windows = rules.weekly[String(days.indexOf(parts.weekday))] ?? [];
    if (!windows.some((window) => time >= window.start + rules.bufferBefore && time + minutes + rules.bufferAfter <= window.end && (time - window.start) % rules.slotStepMinutes === 0)) continue;
    const endParts = Object.fromEntries(formatter.formatToParts(at + minutes * minute).map((part) => [part.type, part.value]));
    // Do not straddle a daylight-saving transition or the configured local day.
    if (endParts.day !== parts.day || Number(endParts.hour) * 60 + Number(endParts.minute) !== time + minutes) continue;
    const reservedStart = at - rules.bufferBefore * minute;
    const reservedEnd = at + (minutes + rules.bufferAfter) * minute;
    if (!busy.some((item) => item.start < reservedEnd && item.end > reservedStart)) slots.push(new Date(at).toISOString());
  }
  return slots;
};
