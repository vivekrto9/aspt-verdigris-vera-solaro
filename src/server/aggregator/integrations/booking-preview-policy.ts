import type { RuntimeEnv } from "../runtime.ts";

export const getBookingPreviewPolicy = async (env: RuntimeEnv) => {
  const row = await env.DB?.prepare("SELECT calendar_ids_json, recipients_json FROM ap_booking_preview_policy WHERE id = 1").first?.() as { calendar_ids_json: string; recipients_json: string } | null;
  const split = (value: unknown) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  return row ? { calendarIds: JSON.parse(row.calendar_ids_json) as string[], recipients: JSON.parse(row.recipients_json) as string[] }
    : { calendarIds: split(env.ASTROPAGES_TEST_CALENDAR_IDS), recipients: split(env.ASTROPAGES_TEST_EMAIL_RECIPIENTS).map((item) => item.toLowerCase()) };
};
