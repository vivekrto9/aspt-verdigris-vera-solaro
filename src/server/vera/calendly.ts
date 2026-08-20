import { resolveSecretBinding } from "../aggregator/runtime-bindings.ts";
import {
  all,
  fetchForEnv,
  first,
  changeCount,
  hmacSha256Hex,
  nowIso,
  parseObject,
  run,
  runStatements,
  safeString,
  secureId,
  sha256Hex,
  timingSafeHexEqual,
} from "./db.ts";
import { enqueueVeraEmail } from "./email.ts";
import { getVeraBookingAccess } from "./security.ts";
import type { VeraEnv, VeraRow } from "./types.ts";
import { VERA_TABLES as tables } from "./types.ts";

const eventTypePattern = /^https:\/\/api\.calendly\.com\/event_types\/[A-Za-z0-9_-]+$/;
const scheduledEventPattern = /^https:\/\/api\.calendly\.com\/scheduled_events\/[A-Za-z0-9_-]+$/;
const inviteePattern = /^https:\/\/api\.calendly\.com\/scheduled_events\/[A-Za-z0-9_-]+\/invitees\/[A-Za-z0-9_-]+$/;
const terminalBookingStatuses = new Set(["cancelled", "expired", "completed", "refunded"]);
const schedulingReconciliationError = "Calendly scheduled the sitting, but local reconciliation is required.";
const schedulingRetryClaim = "Calendly scheduling retry is in progress.";
const staffSchedulingRetryClaim = "Calendly staff scheduling retry is in progress.";
const schedulingRetryClaimTtlMs = 5 * 60_000;
const calendlyReadTimeoutMs = 5_000;
const calendlyWriteTimeoutMs = 8_000;

const calendlyToken = (env: VeraEnv) => resolveSecretBinding(env, "CALENDLY_API_TOKEN");

const sanitizeProviderError = (status: number, payload: Record<string, unknown>) => {
  const title = safeString(payload.title) || safeString(payload.message);
  const detail = safeString(payload.detail);
  return [`Calendly returned HTTP ${status}.`, title, detail].filter(Boolean).join(" ").slice(0, 500);
};

export const validateCalendlyMapping = async ({
  env,
  eventTypeUri,
  durationMinutes,
}: {
  env: VeraEnv;
  eventTypeUri: string;
  durationMinutes: number;
}) => {
  const token = await calendlyToken(env);
  if (!token) {
    return { ok: false as const, status: 503, message: "Calendly is not configured.", missingSecretNames: ["CALENDLY_API_TOKEN"] };
  }
  if (!eventTypePattern.test(eventTypeUri)) {
    return { ok: false as const, status: 400, message: "Calendly event type URI is invalid.", missingSecretNames: [] };
  }
  let response: Response;
  try {
    response = await fetchForEnv(env)(eventTypeUri, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(calendlyReadTimeoutMs),
    });
  } catch {
    return {
      ok: false as const,
      status: 502,
      message: "Calendly event type validation is temporarily unavailable.",
      missingSecretNames: [] as string[],
    };
  }
  const payload = parseObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    return { ok: false as const, status: response.status, message: sanitizeProviderError(response.status, payload), missingSecretNames: [] };
  }
  const resource = parseObject(payload.resource || payload);
  // A shared event type serves sittings of different lengths, so the exact
  // duration is only demanded when the caller maps one event type per sitting.
  const durationRequired = durationMinutes > 0;
  if (resource.active !== true || (durationRequired && Number(resource.duration) !== durationMinutes)) {
    return {
      ok: false as const,
      status: 409,
      message: durationRequired
        ? `Calendly event type must be active and exactly ${durationMinutes} minutes.`
        : "Calendly event type must be active.",
      missingSecretNames: [],
    };
  }
  return { ok: true as const, status: 200, message: "Calendly mapping is valid.", missingSecretNames: [] };
};

export const listCalendlyTimes = async ({
  env,
  eventTypeUri,
  startTime,
  endTime,
}: {
  env: VeraEnv;
  eventTypeUri: string;
  startTime: string;
  endTime: string;
}) => {
  const token = await calendlyToken(env);
  if (!token || !eventTypePattern.test(eventTypeUri)) {
    return {
      ok: false as const,
      status: 503,
      message: "Calendly availability is not configured for this sitting.",
      missingSecretNames: token ? [] : ["CALENDLY_API_TOKEN"],
      times: [] as Array<{ startAt: string; schedulingUrl: string }>,
    };
  }
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (
    !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
    end <= start || end.getTime() - start.getTime() > 7 * 24 * 60 * 60 * 1000
  ) {
    return { ok: false as const, status: 400, message: "Availability range must be valid and no longer than seven days.", missingSecretNames: [], times: [] };
  }
  const url = new URL("https://api.calendly.com/event_type_available_times");
  url.searchParams.set("event_type", eventTypeUri);
  url.searchParams.set("start_time", start.toISOString());
  url.searchParams.set("end_time", end.toISOString());
  let response: Response;
  try {
    response = await fetchForEnv(env)(url, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(calendlyReadTimeoutMs),
    });
  } catch {
    return {
      ok: false as const,
      status: 502,
      message: "Calendly availability is temporarily unavailable.",
      missingSecretNames: [] as string[],
      times: [] as Array<{ startAt: string; schedulingUrl: string }>,
    };
  }
  const payload = parseObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    return { ok: false as const, status: response.status, message: sanitizeProviderError(response.status, payload), missingSecretNames: [], times: [] };
  }
  const collection = Array.isArray(payload.collection) ? payload.collection : [];
  return {
    ok: true as const,
    status: 200,
    message: "Calendly availability loaded.",
    missingSecretNames: [],
    times: collection.map((entry) => {
      const row = parseObject(entry);
      const parsed = new Date(safeString(row.start_time));
      return {
        startAt: Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "",
        schedulingUrl: safeString(row.scheduling_url),
      };
    }).filter((slot) => slot.startAt),
  };
};

export const calendlySlotIsAvailable = async ({
  env,
  eventTypeUri,
  startAt,
}: {
  env: VeraEnv;
  eventTypeUri: string;
  startAt: string;
}) => {
  const selected = new Date(startAt);
  if (!Number.isFinite(selected.getTime())) {
    return { ok: false as const, available: false, status: 400, message: "Selected time is invalid.", missingSecretNames: [] as string[] };
  }
  const availability = await listCalendlyTimes({
    env,
    eventTypeUri,
    startTime: new Date(selected.getTime() - 60_000).toISOString(),
    endTime: new Date(selected.getTime() + 24 * 60 * 60 * 1000 - 60_000).toISOString(),
  });
  if (!availability.ok) return { ...availability, available: false };
  return {
    ...availability,
    available: availability.times.some((slot) =>
      new Date(slot.startAt).getTime() === selected.getTime()
    ),
  };
};

const getEventLocation = async (env: VeraEnv, token: string, eventTypeUri: string) => {
  let response: Response;
  try {
    response = await fetchForEnv(env)(eventTypeUri, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(calendlyReadTimeoutMs),
    });
  } catch {
    return {};
  }
  if (!response.ok) return {};
  const payload = parseObject(await response.json().catch(() => ({})));
  const resource = parseObject(payload.resource || payload);
  const locations = Array.isArray(resource.locations) ? resource.locations : [];
  const location = parseObject(locations[0]);
  return safeString(location.kind) ? { kind: safeString(location.kind) } : {};
};

const calendlyResult = (resource: VeraRow) => {
  const eventValue = resource.event || resource.scheduled_event;
  const event = parseObject(eventValue);
  const location = parseObject(event.location || resource.location);
  const inviteeUri = safeString(resource.uri);
  return {
    inviteeUri,
    eventUri: safeString(eventValue) || safeString(event.uri) ||
      (inviteeUri.includes("/invitees/") ? inviteeUri.slice(0, inviteeUri.indexOf("/invitees/")) : ""),
    startAt: safeString(event.start_time),
    endAt: safeString(event.end_time),
    cancelUrl: safeString(resource.cancel_url),
    rescheduleUrl: safeString(resource.reschedule_url),
    meetingUrl: safeString(location.join_url) || safeString(location.url),
  };
};

const schedulingFollowUps = (booking: VeraRow, startAt: string, endAt: string) => {
  const now = Date.now();
  const postSessionAt = new Date(new Date(endAt).getTime() + 24 * 60 * 60 * 1000).toISOString();
  return [
    {
      kind: "intake_reminder",
      dueAt: new Date(Math.max(now + 5 * 60 * 1000, new Date(startAt).getTime() - 14 * 24 * 60 * 60 * 1000)).toISOString(),
    },
    { kind: "session_reminder", dueAt: new Date(new Date(startAt).getTime() - 24 * 60 * 60 * 1000).toISOString() },
    { kind: "post_session", dueAt: postSessionAt },
    ...(Number(booking.balance_cents) > 0 ? [{ kind: "balance_reminder", dueAt: postSessionAt }] : []),
  ].filter((entry) => new Date(entry.dueAt).getTime() > now);
};

const calendlyAuditId = async (
  bookingId: string,
  eventType: string,
  eventUri: string,
  inviteeUri: string,
) => `vbe_cal_${(await sha256Hex([bookingId, eventType, eventUri, inviteeUri].join("\n"))).slice(0, 40)}`;

const markSchedulingActionRequired = async ({
  env,
  bookingId,
  expectedBooking,
  message,
  result,
  eventType = "calendly.reconciliation_required",
  metadata = {},
}: {
  env: VeraEnv;
  bookingId: string;
  expectedBooking: VeraRow;
  message: string;
  result?: ReturnType<typeof calendlyResult>;
  eventType?: string;
  metadata?: Record<string, unknown>;
}) => {
  const now = nowIso();
  const eventUri = safeString(result?.eventUri);
  const inviteeUri = safeString(result?.inviteeUri);
  const auditId = await calendlyAuditId(bookingId, eventType, eventUri, inviteeUri);
  const [updated] = await runStatements(env, [
    env.DB!.prepare(`UPDATE ${tables.bookings}
      SET status = 'payment_action_required', scheduling_error = ?,
        calendly_event_uri = COALESCE(calendly_event_uri, ?),
        calendly_invitee_uri = COALESCE(calendly_invitee_uri, ?),
        calendly_cancel_url = COALESCE(calendly_cancel_url, ?),
        calendly_reschedule_url = COALESCE(calendly_reschedule_url, ?),
        calendly_meeting_url = COALESCE(calendly_meeting_url, ?), updated_at = ?
      WHERE id = ? AND status NOT IN ('cancelled', 'expired', 'completed', 'refunded')
        AND status = ?
        AND COALESCE(calendly_event_uri, '') = ?
        AND COALESCE(calendly_invitee_uri, '') = ?`)
      .bind(
        message.slice(0, 500), eventUri || null, inviteeUri || null,
        safeString(result?.cancelUrl) || null, safeString(result?.rescheduleUrl) || null,
        safeString(result?.meetingUrl) || null, now, bookingId,
        safeString(expectedBooking.status),
        safeString(expectedBooking.calendly_event_uri),
        safeString(expectedBooking.calendly_invitee_uri),
      ),
    env.DB!.prepare(`INSERT INTO ${tables.bookingEvents}
      (id, booking_id, event_type, actor_type, metadata_json, created_at)
      VALUES (?, ?, ?, 'system', ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(auditId, bookingId, eventType, JSON.stringify(metadata), now),
  ]);
  if (changeCount(updated) !== 1) return;

  const booking = await first(env, `SELECT booking.*, service.name AS service_name
    FROM ${tables.bookings} booking
    JOIN ${tables.services} service ON service.slug = booking.service_slug
    WHERE booking.id = ?`, [bookingId]);
  const configuredOrigin = safeString(env.ASTROPAGES_SITE_URL) || safeString(env.SITE_ORIGIN) || safeString(env.SITE_URL);
  let confirmationUrl = "";
  try {
    confirmationUrl = new URL(`/booking/${encodeURIComponent(bookingId)}/confirmation`, configuredOrigin).toString();
  } catch {
    confirmationUrl = "";
  }
  if (!booking || !confirmationUrl) return;
  await enqueueVeraEmail({
    env,
    eventType: "vera.booking.scheduling_action_required",
    templateKey: "vera_booking_action_required_en",
    recipientEmail: safeString(booking.email),
    recipientName: safeString(booking.customer_name),
    payload: {
      customerName: safeString(booking.customer_name),
      bookingNumber: safeString(booking.booking_number),
      serviceName: safeString(booking.service_name),
      selectedSlot: safeString(booking.selected_start_at),
      confirmationUrl,
    },
    idempotencyKey: `booking-scheduling-action-required:${bookingId}`,
  }).catch(() => undefined);
};

const persistScheduledBooking = async ({
  env,
  booking,
  result,
  auditEventType = "calendly.scheduled",
}: {
  env: VeraEnv;
  booking: VeraRow;
  result: ReturnType<typeof calendlyResult>;
  auditEventType?: string;
}) => {
  const bookingId = safeString(booking.id);
  const expectedStart = new Date(safeString(booking.selected_start_at));
  const expectedEnd = new Date(safeString(booking.selected_end_at));
  const providerStart = new Date(result.startAt || safeString(booking.selected_start_at));
  const providerEnd = new Date(result.endAt || safeString(booking.selected_end_at));
  if (
    !scheduledEventPattern.test(result.eventUri) || !inviteePattern.test(result.inviteeUri) ||
    !Number.isFinite(providerStart.getTime()) || !Number.isFinite(providerEnd.getTime()) ||
    providerStart.getTime() !== expectedStart.getTime() || providerEnd.getTime() !== expectedEnd.getTime()
  ) {
    return { ok: false as const, status: 502, message: "Calendly returned a sitting that does not match the authoritative booking." };
  }
  const startAt = providerStart.toISOString();
  const endAt = providerEnd.toISOString();
  const now = nowIso();
  const auditId = await calendlyAuditId(bookingId, auditEventType, result.eventUri, result.inviteeUri);
  const followUps = schedulingFollowUps(booking, startAt, endAt);
  const results = await runStatements(env, [
    env.DB!.prepare(`UPDATE ${tables.bookings}
      SET status = 'confirmed', selected_start_at = ?, selected_end_at = ?,
        calendly_event_uri = ?, calendly_invitee_uri = ?, calendly_cancel_url = ?,
        calendly_reschedule_url = ?, calendly_meeting_url = ?, scheduling_error = NULL,
        confirmed_at = COALESCE(confirmed_at, ?), hold_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('pending_payment', 'payment_action_required')
        AND payment_state IN ('deposit_paid', 'paid') AND cancelled_at IS NULL
        AND (calendly_event_uri IS NULL OR calendly_event_uri = ?)
        AND NOT EXISTS (
          SELECT 1 FROM ${tables.refunds}
          WHERE booking_id = ? AND status IN ('pending', 'succeeded')
        )`)
      .bind(
        startAt, endAt, result.eventUri, result.inviteeUri, result.cancelUrl || null,
        result.rescheduleUrl || null, result.meetingUrl || null, now, now,
        bookingId, result.eventUri, bookingId,
      ),
    env.DB!.prepare(`UPDATE ${tables.bookingHolds} SET expires_at = NULL
      WHERE booking_id = ? AND EXISTS (
        SELECT 1 FROM ${tables.bookings}
        WHERE id = ? AND status = 'confirmed' AND calendly_event_uri = ?
      )`).bind(bookingId, bookingId, result.eventUri),
    env.DB!.prepare(`INSERT INTO ${tables.bookingEvents}
      (id, booking_id, event_type, actor_type, metadata_json, created_at)
      SELECT ?, ?, ?, 'provider', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM ${tables.bookings}
        WHERE id = ? AND status = 'confirmed' AND calendly_event_uri = ?
      ) ON CONFLICT(id) DO NOTHING`)
      .bind(
        auditId, bookingId, auditEventType, JSON.stringify({ eventUri: result.eventUri }),
        now, bookingId, result.eventUri,
      ),
    ...followUps.map((followUp) => env.DB!.prepare(`INSERT INTO ${tables.followUps}
      (id, booking_id, kind, due_at, status, outbox_id, created_at, updated_at)
      SELECT ?, ?, ?, ?, 'pending', NULL, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM ${tables.bookings}
        WHERE id = ? AND status = 'confirmed' AND calendly_event_uri = ?
      ) ON CONFLICT(booking_id, kind, due_at) DO NOTHING`)
      .bind(
        secureId("vfollow"), bookingId, followUp.kind, followUp.dueAt, now, now,
        bookingId, result.eventUri,
      )),
  ]);
  if (changeCount(results[0]) !== 1) {
    const current = await first(env, `SELECT status, calendly_event_uri FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
    if (safeString(current?.status) === "confirmed" && safeString(current?.calendly_event_uri) === result.eventUri) {
      return { ok: true as const, status: 200, message: "Booking is already scheduled.", alreadyScheduled: true };
    }
    return { ok: false as const, status: 409, message: "The booking changed before Calendly reconciliation completed." };
  }
  return { ok: true as const, status: 200, message: "Booking scheduled.", alreadyScheduled: false };
};

export const createCalendlyInviteeForBooking = async ({
  env,
  booking,
  startAt,
}: {
  env: VeraEnv;
  booking: VeraRow;
  startAt: string;
}) => {
  const token = await calendlyToken(env);
  if (!token) {
    return {
      ok: false as const,
      status: 503,
      message: "Calendly is not configured.",
      missingSecretNames: ["CALENDLY_API_TOKEN"],
    };
  }
  const eventTypeUri = safeString(booking.calendly_event_type_uri);
  if (!eventTypePattern.test(eventTypeUri)) {
    return { ok: false as const, status: 409, message: "Calendly event mapping is invalid.", missingSecretNames: [] as string[] };
  }
  const selected = new Date(startAt);
  if (!Number.isFinite(selected.getTime())) {
    return { ok: false as const, status: 400, message: "Calendly start time is invalid.", missingSecretNames: [] as string[] };
  }
  let response: Response;
  try {
    const location = await getEventLocation(env, token, eventTypeUri);
    response = await fetchForEnv(env)("https://api.calendly.com/invitees", {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        event_type: eventTypeUri,
        start_time: selected.toISOString(),
        invitee: {
          name: safeString(booking.customer_name),
          email: safeString(booking.email),
          timezone: safeString(booking.customer_timezone) || "UTC",
        },
        tracking: { utm_content: safeString(booking.id) },
        ...(safeString(location.kind) ? { location } : {}),
      }),
      signal: AbortSignal.timeout(calendlyWriteTimeoutMs),
    });
  } catch {
    return {
      ok: false as const,
      status: 502,
      message: "Calendly replacement scheduling outcome is unknown and requires staff reconciliation.",
      missingSecretNames: [] as string[],
      outcomeUnknown: true as const,
    };
  }
  const payload = parseObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    return {
      ok: false as const,
      status: response.status,
      message: sanitizeProviderError(response.status, payload),
      missingSecretNames: [] as string[],
    };
  }
  const result = calendlyResult(parseObject(payload.resource || payload));
  if (!scheduledEventPattern.test(result.eventUri) || !result.inviteeUri) {
    return { ok: false as const, status: 502, message: "Calendly returned an invalid replacement booking.", missingSecretNames: [] as string[] };
  }
  return { ok: true as const, status: 201, message: "Calendly invitee created.", result, missingSecretNames: [] as string[] };
};

export const schedulePaidVeraBooking = async (env: VeraEnv, bookingId: string) => {
  const booking = await first(env, `SELECT * FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
  if (!booking) return { ok: false as const, status: 404, message: "Booking was not found." };
  if (!["deposit_paid", "paid"].includes(safeString(booking.payment_state))) {
    return { ok: false as const, status: 409, message: "Verified payment is required before scheduling." };
  }
  if (terminalBookingStatuses.has(safeString(booking.status)) || safeString(booking.cancelled_at)) {
    return { ok: false as const, status: 409, message: "A terminal booking cannot be scheduled." };
  }
  if (safeString(booking.calendly_event_uri)) {
    return safeString(booking.status) === "confirmed"
      ? { ok: true as const, status: 200, message: "Booking is already scheduled.", booking, alreadyScheduled: true }
      : { ok: false as const, status: 409, message: "The existing Calendly event requires reconciliation before retrying." };
  }
  if (!["pending_payment", "payment_action_required"].includes(safeString(booking.status))) {
    return { ok: false as const, status: 409, message: "This booking is not eligible for Calendly scheduling." };
  }
  const activeRefund = await first(env, `SELECT id FROM ${tables.refunds}
    WHERE booking_id = ? AND status IN ('pending', 'succeeded') LIMIT 1`, [bookingId]);
  if (activeRefund) {
    return { ok: false as const, status: 409, message: "A booking with an active refund cannot be scheduled." };
  }
  const token = await calendlyToken(env);
  if (!token) {
    await markSchedulingActionRequired({
      env,
      bookingId,
      expectedBooking: booking,
      message: "Calendly API access is not configured.",
      eventType: "calendly.schedule_provider_unavailable",
    });
    return { ok: false as const, status: 503, message: "Calendly is not configured.", missingSecretNames: ["CALENDLY_API_TOKEN"] };
  }
  const eventTypeUri = safeString(booking.calendly_event_type_uri);
  if (!eventTypePattern.test(eventTypeUri)) {
    await markSchedulingActionRequired({
      env,
      bookingId,
      expectedBooking: booking,
      message: "Calendly event mapping is invalid.",
      eventType: "calendly.schedule_mapping_invalid",
    });
    return { ok: false as const, status: 409, message: "Calendly event mapping is invalid." };
  }
  let response: Response;
  try {
    const location = await getEventLocation(env, token, eventTypeUri);
    response = await fetchForEnv(env)("https://api.calendly.com/invitees", {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        event_type: eventTypeUri,
        start_time: safeString(booking.selected_start_at),
        invitee: {
          name: safeString(booking.customer_name),
          email: safeString(booking.email),
          timezone: safeString(booking.customer_timezone) || "UTC",
        },
        tracking: { utm_content: bookingId },
        ...(safeString(location.kind) ? { location } : {}),
      }),
      signal: AbortSignal.timeout(calendlyWriteTimeoutMs),
    });
  } catch {
    const message = "Calendly scheduling outcome is unknown and requires staff reconciliation.";
    await markSchedulingActionRequired({
      env,
      bookingId,
      expectedBooking: booking,
      message,
      eventType: "calendly.schedule_outcome_unknown",
      metadata: { reason: message },
    });
    return { ok: false as const, status: 502, message };
  }
  const payload = parseObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    const message = sanitizeProviderError(response.status, payload);
    await markSchedulingActionRequired({
      env,
      bookingId,
      expectedBooking: booking,
      message,
      eventType: "calendly.schedule_failed",
      metadata: { reason: message },
    });
    return { ok: false as const, status: 502, message };
  }
  const result = calendlyResult(parseObject(payload.resource || payload));
  const persisted = await persistScheduledBooking({ env, booking, result });
  if (!persisted.ok) {
    await markSchedulingActionRequired({
      env,
      bookingId,
      expectedBooking: booking,
      message: schedulingReconciliationError,
      result,
      metadata: { reason: persisted.message, eventUri: result.eventUri },
    });
    return { ...persisted, status: 502 };
  }
  return { ...persisted, result };
};

const retrieveCalendlyInviteeForReconciliation = async (env: VeraEnv, inviteeUri: string) => {
  const token = await calendlyToken(env);
  if (!token) {
    return { ok: false as const, status: 503, message: "Calendly is not configured.", missingSecretNames: ["CALENDLY_API_TOKEN"] };
  }
  if (!inviteePattern.test(inviteeUri)) {
    return { ok: false as const, status: 409, message: "The stored Calendly invitee reference is invalid.", missingSecretNames: [] as string[] };
  }
  let inviteeResponse: Response;
  try {
    inviteeResponse = await fetchForEnv(env)(inviteeUri, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(calendlyReadTimeoutMs),
    });
  } catch {
    return { ok: false as const, status: 502, message: "Calendly reconciliation is temporarily unavailable.", missingSecretNames: [] as string[] };
  }
  const inviteePayload = parseObject(await inviteeResponse.json().catch(() => ({})));
  if (!inviteeResponse.ok) {
    return {
      ok: false as const,
      status: inviteeResponse.status,
      message: sanitizeProviderError(inviteeResponse.status, inviteePayload),
      missingSecretNames: [] as string[],
    };
  }
  const invitee = parseObject(inviteePayload.resource || inviteePayload);
  if (safeString(invitee.status) !== "active") {
    return { ok: false as const, status: 409, message: "The Calendly invitee is not active.", missingSecretNames: [] as string[] };
  }
  const eventUri = safeString(invitee.event) || safeString(parseObject(invitee.event).uri) ||
    inviteeUri.slice(0, inviteeUri.indexOf("/invitees/"));
  if (!scheduledEventPattern.test(eventUri)) {
    return { ok: false as const, status: 409, message: "The Calendly event reference is invalid.", missingSecretNames: [] as string[] };
  }
  let eventResponse: Response;
  try {
    eventResponse = await fetchForEnv(env)(eventUri, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(calendlyReadTimeoutMs),
    });
  } catch {
    return { ok: false as const, status: 502, message: "Calendly reconciliation is temporarily unavailable.", missingSecretNames: [] as string[] };
  }
  const eventPayload = parseObject(await eventResponse.json().catch(() => ({})));
  if (!eventResponse.ok) {
    return {
      ok: false as const,
      status: eventResponse.status,
      message: sanitizeProviderError(eventResponse.status, eventPayload),
      missingSecretNames: [] as string[],
    };
  }
  const event = parseObject(eventPayload.resource || eventPayload);
  const location = parseObject(event.location);
  const tracking = parseObject(invitee.tracking);
  return {
    ok: true as const,
    status: 200,
    missingSecretNames: [] as string[],
    result: {
      eventUri,
      inviteeUri,
      startAt: safeString(event.start_time),
      endAt: safeString(event.end_time),
      cancelUrl: safeString(invitee.cancel_url),
      rescheduleUrl: safeString(invitee.reschedule_url),
      meetingUrl: safeString(location.join_url) || safeString(location.url),
      inviteeEmail: safeString(invitee.email).toLowerCase(),
      trackingBookingId: safeString(tracking.utm_content),
    },
  };
};

export const retryPaidVeraBookingScheduling = async ({
  env,
  request,
  bookingId,
  manageToken,
}: {
  env: VeraEnv;
  request: Request;
  bookingId: string;
  manageToken: string;
}) => {
  const access = await getVeraBookingAccess({ env, request, bookingId, manageToken, requireCsrf: true });
  if (!access.ok) return access;
  const booking = access.booking;
  if (safeString(booking.status) === "confirmed" && safeString(booking.calendly_event_uri)) {
    return {
      ok: true as const,
      status: 200,
      message: "Booking is already scheduled.",
      reconciliation: { state: "already_confirmed", providerCreateAttempted: false },
    };
  }
  if (
    safeString(booking.status) !== "payment_action_required" ||
    !["deposit_paid", "paid"].includes(safeString(booking.payment_state)) ||
    safeString(booking.cancelled_at) ||
    new Date(safeString(booking.selected_start_at)).getTime() <= Date.now()
  ) {
    return { ok: false as const, status: 409, message: "This booking is not eligible for scheduling retry." };
  }
  const refund = await first(env, `SELECT id FROM ${tables.refunds}
    WHERE booking_id = ? AND status IN ('pending', 'succeeded') LIMIT 1`, [bookingId]);
  if (refund) {
    return { ok: false as const, status: 409, message: "A booking with an active refund cannot be scheduled." };
  }
  if (Number(booking.total_due_cents) > 0) {
    const payment = await first(env, `SELECT id FROM ${tables.paymentAttempts}
      WHERE booking_id = ? AND status = 'succeeded' LIMIT 1`, [bookingId]);
    if (!payment) {
      return { ok: false as const, status: 409, message: "A verified successful payment is required before retrying scheduling." };
    }
  }
  const schedulingError = safeString(booking.scheduling_error);
  if (!schedulingError) {
    return { ok: false as const, status: 409, message: "This action-required booking is not a Calendly scheduling failure." };
  }
  if (
    schedulingError === schedulingRetryClaim &&
    new Date(safeString(booking.updated_at)).getTime() > Date.now() - schedulingRetryClaimTtlMs
  ) {
    return { ok: false as const, status: 409, message: "A scheduling retry is already in progress. Refresh before trying again." };
  }
  const auditedSchedulingFailure = await first(env, `SELECT id, event_type, created_at FROM ${tables.bookingEvents}
    WHERE booking_id = ? AND created_at = ? AND event_type IN (
      'calendly.schedule_failed',
      'calendly.schedule_provider_unavailable',
      'calendly.schedule_mapping_invalid',
      'calendly.reconciliation_required'
    ) ORDER BY created_at DESC, id DESC LIMIT 1`, [bookingId, safeString(booking.updated_at)]);
  if (!auditedSchedulingFailure) {
    return { ok: false as const, status: 409, message: "This action-required booking is not an audited scheduling failure." };
  }

  const inviteeUri = safeString(booking.calendly_invitee_uri);
  if (schedulingError === schedulingReconciliationError && !inviteeUri) {
    return { ok: false as const, status: 409, message: "The Calendly create outcome requires staff reconciliation before retrying." };
  }
  if (safeString(booking.calendly_event_uri) || inviteeUri) {
    if (schedulingError !== schedulingReconciliationError || !inviteeUri) {
      return { ok: false as const, status: 409, message: "The existing provider event requires staff reconciliation." };
    }
    const provider = await retrieveCalendlyInviteeForReconciliation(env, inviteeUri);
    if (!provider.ok) return provider;
    const result = await persistScheduledBooking({
      env,
      booking,
      result: provider.result,
      auditEventType: "calendly.reconciled",
    });
    if (!result.ok) return result;
    return {
      ok: true as const,
      status: 200,
      message: result.message,
      reconciliation: {
        state: result.alreadyScheduled ? "already_confirmed" : "scheduled",
        providerCreateAttempted: false,
      },
    };
  }

  const claimed = await run(env, `UPDATE ${tables.bookings}
    SET scheduling_error = ?, updated_at = ?
    WHERE id = ? AND status = 'payment_action_required'
      AND scheduling_error = ? AND calendly_event_uri IS NULL AND calendly_invitee_uri IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${tables.refunds}
        WHERE booking_id = ? AND status IN ('pending', 'succeeded')
      )`, [
    schedulingRetryClaim,
    nowIso(),
    bookingId,
    schedulingError,
    bookingId,
  ]);
  if (changeCount(claimed) !== 1) {
    const current = await first(env, `SELECT status, calendly_event_uri FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
    if (safeString(current?.status) === "confirmed" && safeString(current?.calendly_event_uri)) {
      return {
        ok: true as const,
        status: 200,
        message: "Booking is already scheduled.",
        reconciliation: { state: "already_confirmed", providerCreateAttempted: false },
      };
    }
    return { ok: false as const, status: 409, message: "A scheduling retry is already in progress. Refresh before trying again." };
  }

  const result = await schedulePaidVeraBooking(env, bookingId);
  if (!result.ok) return result;
  return {
    ok: true as const,
    status: 200,
    message: result.message,
    reconciliation: {
      state: result.alreadyScheduled ? "already_confirmed" : "scheduled",
      providerCreateAttempted: true,
    },
  };
};

const staffReconciliationState = (row: VeraRow) => {
  const eventType = safeString(row.last_event_type);
  if (["calendly.schedule_outcome_unknown", "calendly.staff_retry_requested"].includes(eventType)) {
    return "provider_create_outcome_unknown";
  }
  if (eventType === "calendly.reconciliation_required") return "provider_event_reconciliation";
  if ([
    "calendly.schedule_failed",
    "calendly.schedule_provider_unavailable",
    "calendly.schedule_mapping_invalid",
  ].includes(eventType)) return "provider_create_retryable";
  if (eventType === "reschedule.create_outcome_unknown") return "replacement_create_outcome_unknown";
  if (eventType === "reschedule.old_event_cancel_failed") return "original_event_cancel_reconciliation";
  if (eventType === "cancellation.provider_action_required" || eventType === "invitee.canceled") {
    return "cancellation_reconciliation";
  }
  return "provider_action_required";
};

export const listCalendlyStaffReconciliations = async (
  env: VeraEnv,
  input: Record<string, unknown> = {},
) => {
  const requestedLimit = Number(input.limit);
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 50;
  const rows = await all(env, `SELECT
      booking.id, booking.booking_number, booking.status, booking.payment_state,
      booking.selected_start_at, booking.updated_at, booking.calendly_event_uri,
      booking.calendly_invitee_uri, booking.scheduling_error,
      (SELECT event.event_type FROM ${tables.bookingEvents} event
        WHERE event.booking_id = booking.id
        ORDER BY event.created_at DESC, event.id DESC LIMIT 1) AS last_event_type
    FROM ${tables.bookings} booking
    WHERE booking.status = 'payment_action_required'
      AND booking.scheduling_error IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM ${tables.bookingEvents} event
        WHERE event.booking_id = booking.id AND (
          event.event_type LIKE 'calendly.%' OR
          event.event_type LIKE 'reschedule.%' OR
          event.event_type = 'cancellation.provider_action_required' OR
          event.event_type IN ('invitee.created', 'invitee.canceled')
        )
      )
    ORDER BY booking.updated_at, booking.id LIMIT ?`, [limit]);
  return {
    items: rows.map((row) => {
      const state = staffReconciliationState(row);
      const options = state === "provider_create_retryable"
        ? ["retry_create"]
        : state === "provider_create_outcome_unknown" || state === "provider_event_reconciliation"
          ? ["reconcile_invitee", "confirm_absent_and_retry"]
          : state === "replacement_create_outcome_unknown"
            ? ["reconcile_invitee"]
            : [];
      return {
        bookingId: safeString(row.id),
        bookingNumber: safeString(row.booking_number),
        state,
        status: safeString(row.status),
        paymentState: safeString(row.payment_state),
        selectedStartAt: safeString(row.selected_start_at),
        hasEventReference: Boolean(safeString(row.calendly_event_uri)),
        hasInviteeReference: Boolean(safeString(row.calendly_invitee_uri)),
        resolutionOptions: options,
        updatedAt: safeString(row.updated_at),
      };
    }),
    limit,
  };
};

export const resolveCalendlyStaffReconciliation = async (
  env: VeraEnv,
  input: Record<string, unknown>,
) => {
  const bookingId = safeString(input.bookingId);
  const resolution = safeString(input.resolution);
  const operationId = safeString(input.operationId);
  if (!/^vbooking_[A-Za-z0-9]+$/.test(bookingId) || !/^[A-Za-z0-9._:-]{8,128}$/.test(operationId)) {
    return { ok: false as const, status: 400, message: "Calendly reconciliation request is invalid." };
  }
  const booking = await first(env, `SELECT * FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
  if (!booking) return { ok: false as const, status: 404, message: "Booking was not found." };
  if (safeString(booking.status) === "confirmed" && safeString(booking.calendly_event_uri)) {
    return {
      ok: true as const,
      status: 200,
      message: "Booking is already scheduled.",
      reconciliation: { bookingId, state: "already_confirmed", providerCreateAttempted: false },
    };
  }
  if (
    safeString(booking.status) !== "payment_action_required" ||
    !["deposit_paid", "paid"].includes(safeString(booking.payment_state)) ||
    safeString(booking.cancelled_at) ||
    terminalBookingStatuses.has(safeString(booking.status))
  ) {
    return { ok: false as const, status: 409, message: "This booking cannot be reconciled with Calendly." };
  }
  const refund = await first(env, `SELECT id FROM ${tables.refunds}
    WHERE booking_id = ? AND status IN ('pending', 'succeeded') LIMIT 1`, [bookingId]);
  if (refund) return { ok: false as const, status: 409, message: "A booking with an active refund cannot be scheduled." };

  if (resolution === "reconcile_invitee") {
    const inviteeUri = safeString(input.inviteeUri) || safeString(booking.calendly_invitee_uri);
    const provider = await retrieveCalendlyInviteeForReconciliation(env, inviteeUri);
    if (!provider.ok) return provider;
    const ownershipMatches = provider.result.trackingBookingId === bookingId ||
      provider.result.inviteeEmail === safeString(booking.normalized_email).toLowerCase();
    if (!ownershipMatches) {
      return { ok: false as const, status: 409, message: "Calendly invitee ownership did not match the booking." };
    }
    const result = await persistScheduledBooking({
      env,
      booking,
      result: provider.result,
      auditEventType: "calendly.staff_reconciled",
    });
    if (!result.ok) return result;
    return {
      ok: true as const,
      status: 200,
      message: result.message,
      reconciliation: {
        bookingId,
        state: result.alreadyScheduled ? "already_confirmed" : "scheduled",
        providerCreateAttempted: false,
      },
    };
  }

  if (!["retry_create", "confirm_absent_and_retry"].includes(resolution)) {
    return { ok: false as const, status: 400, message: "Calendly reconciliation resolution is invalid." };
  }
  const latestEvent = await first(env, `SELECT event_type FROM ${tables.bookingEvents}
    WHERE booking_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [bookingId]);
  const eventType = safeString(latestEvent?.event_type);
  const retryable = [
    "calendly.schedule_failed",
    "calendly.schedule_provider_unavailable",
    "calendly.schedule_mapping_invalid",
  ].includes(eventType);
  const ambiguous = eventType === "calendly.schedule_outcome_unknown";
  if (
    (resolution === "retry_create" && !retryable) ||
    (resolution === "confirm_absent_and_retry" && (!ambiguous || input.providerAbsenceConfirmed !== true)) ||
    safeString(booking.calendly_event_uri) || safeString(booking.calendly_invitee_uri) ||
    new Date(safeString(booking.selected_start_at)).getTime() <= Date.now()
  ) {
    return { ok: false as const, status: 409, message: "Calendly create cannot be retried for this reconciliation state." };
  }
  const requestAuditId = `vbe_calops_${(await sha256Hex([bookingId, operationId].join("\n"))).slice(0, 40)}`;
  const inserted = await run(env, `INSERT INTO ${tables.bookingEvents}
    (id, booking_id, event_type, actor_type, metadata_json, created_at)
    VALUES (?, ?, 'calendly.staff_retry_requested', 'staff', ?, ?)
    ON CONFLICT(id) DO NOTHING`, [
    requestAuditId,
    bookingId,
    JSON.stringify({ operationId, resolution, providerAbsenceConfirmed: resolution === "confirm_absent_and_retry" }),
    nowIso(),
  ]);
  if (changeCount(inserted) !== 1) {
    const current = await first(env, `SELECT status, calendly_event_uri FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
    return {
      ok: true as const,
      status: safeString(current?.status) === "confirmed" ? 200 : 202,
      message: "Calendly reconciliation operation was already accepted.",
      reconciliation: {
        bookingId,
        state: safeString(current?.status) === "confirmed" ? "already_confirmed" : "already_requested",
        providerCreateAttempted: false,
      },
    };
  }
  const claimed = await run(env, `UPDATE ${tables.bookings}
    SET scheduling_error = ?, updated_at = ?
    WHERE id = ? AND status = 'payment_action_required' AND scheduling_error = ?
      AND calendly_event_uri IS NULL AND calendly_invitee_uri IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${tables.refunds}
        WHERE booking_id = ? AND status IN ('pending', 'succeeded')
      )`, [
    staffSchedulingRetryClaim,
    nowIso(),
    bookingId,
    safeString(booking.scheduling_error),
    bookingId,
  ]);
  if (changeCount(claimed) !== 1) {
    const current = await first(env, `SELECT status, calendly_event_uri FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
    if (safeString(current?.status) === "confirmed" && safeString(current?.calendly_event_uri)) {
      return {
        ok: true as const,
        status: 200,
        message: "Booking is already scheduled.",
        reconciliation: { bookingId, state: "already_confirmed", providerCreateAttempted: false },
      };
    }
    return { ok: false as const, status: 409, message: "Another Calendly reconciliation is already in progress." };
  }
  const result = await schedulePaidVeraBooking(env, bookingId);
  if (!result.ok) return result;
  return {
    ok: true as const,
    status: 200,
    message: result.message,
    reconciliation: {
      bookingId,
      state: result.alreadyScheduled ? "already_confirmed" : "scheduled",
      providerCreateAttempted: true,
    },
  };
};

export const completeElapsedVeraBookings = async (env: VeraEnv, now = new Date()) => {
  if (!env.DB?.batch) {
    return { ok: false as const, status: 503, message: "Atomic booking lifecycle storage is not ready.", completed: 0 };
  }
  const cutoff = nowIso(now);
  const due = await all(env, `SELECT id, selected_end_at FROM ${tables.bookings}
    WHERE status = 'confirmed' AND selected_end_at <= ?
    ORDER BY selected_end_at, id LIMIT 50`, [cutoff]);
  if (due.length === 0) {
    return { ok: true as const, status: 200, message: "No confirmed bookings are due for completion.", completed: 0 };
  }

  const statements = [];
  for (const booking of due) {
    const bookingId = safeString(booking.id);
    const selectedEndAt = safeString(booking.selected_end_at);
    const auditId = `vbe_complete_${(await sha256Hex(bookingId)).slice(0, 40)}`;
    statements.push(
      env.DB.prepare(`UPDATE ${tables.bookings}
        SET status = 'completed', updated_at = ?
        WHERE id = ? AND status = 'confirmed' AND selected_end_at <= ?`)
        .bind(cutoff, bookingId, cutoff),
      env.DB.prepare(`INSERT INTO ${tables.bookingEvents}
        (id, booking_id, event_type, actor_type, metadata_json, created_at)
        SELECT ?, ?, 'booking.completed', 'system', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM ${tables.bookings}
          WHERE id = ? AND status = 'completed' AND updated_at = ?
        ) ON CONFLICT(id) DO NOTHING`)
        .bind(
          auditId,
          bookingId,
          JSON.stringify({ selectedEndAt, completedBy: "scheduled_lifecycle" }),
          cutoff,
          bookingId,
          cutoff,
        ),
    );
  }
  const results = await runStatements(env, statements);
  const completed = due.reduce(
    (count, _booking, index) => count + changeCount(results[index * 2]),
    0,
  );
  return { ok: true as const, status: 200, message: "Elapsed bookings completed.", completed };
};

export const cancelCalendlyEvent = async (env: VeraEnv, eventUri: string, reason: string) => {
  const token = await calendlyToken(env);
  if (!token) return { ok: false as const, status: 503, message: "Calendly is not configured.", missingSecretNames: ["CALENDLY_API_TOKEN"] };
  if (!scheduledEventPattern.test(eventUri)) return { ok: false as const, status: 409, message: "Scheduled event reference is invalid.", missingSecretNames: [] };
  const id = eventUri.split("/").pop() ?? "";
  let response: Response;
  try {
    response = await fetchForEnv(env)(`https://api.calendly.com/scheduled_events/${encodeURIComponent(id)}/cancellation`, {
      method: "POST",
      headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: reason.slice(0, 200) || "Cancelled by invitee" }),
      signal: AbortSignal.timeout(calendlyWriteTimeoutMs),
    });
  } catch {
    return {
      ok: false as const,
      status: 502,
      message: "Calendly cancellation outcome is unknown and requires reconciliation.",
      missingSecretNames: [] as string[],
      outcomeUnknown: true as const,
    };
  }
  const payload = parseObject(await response.json().catch(() => ({})));
  return response.ok
    ? { ok: true as const, status: 200, message: "Calendly event cancelled.", missingSecretNames: [] }
    : { ok: false as const, status: response.status, message: sanitizeProviderError(response.status, payload), missingSecretNames: [] };
};

export const verifyCalendlySignature = async ({
  body,
  signatureHeader,
  signingKey,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  body: string;
  signatureHeader: string;
  signingKey: string;
  nowSeconds?: number;
}) => {
  const timestamp = Number(signatureHeader.match(/(?:^|,)t=([^,]+)/)?.[1]);
  const signature = signatureHeader.match(/(?:^|,)v1=([^,]+)/)?.[1] ?? "";
  if (!signature || !Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > 300) return false;
  const expected = await hmacSha256Hex(signingKey, `${timestamp}.${body}`);
  return timingSafeHexEqual(expected, signature);
};

const recordCalendlyWebhookDisposition = async ({
  env,
  bookingId,
  expectedBooking,
  auditId,
  eventType,
  eventUri,
  inviteeUri,
  rescheduled,
  disposition,
  reason,
  actionRequired = false,
}: {
  env: VeraEnv;
  bookingId: string;
  expectedBooking: VeraRow;
  auditId: string;
  eventType: string;
  eventUri: string;
  inviteeUri: string;
  rescheduled: boolean;
  disposition: string;
  reason: string;
  actionRequired?: boolean;
}) => {
  const now = nowIso();
  const metadata = JSON.stringify({
    eventUri,
    inviteeUri,
    rescheduled,
    disposition,
    reason,
  });
  await runStatements(env, [
    ...(actionRequired ? [env.DB!.prepare(`UPDATE ${tables.bookings}
      SET status = 'payment_action_required', scheduling_error = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('cancelled', 'expired', 'completed', 'refunded')
        AND status = ?
        AND COALESCE(calendly_event_uri, '') = ?
        AND COALESCE(calendly_invitee_uri, '') = ?`)
      .bind(
        reason.slice(0, 500), now, bookingId,
        safeString(expectedBooking.status),
        safeString(expectedBooking.calendly_event_uri),
        safeString(expectedBooking.calendly_invitee_uri),
      )] : []),
    env.DB!.prepare(`INSERT INTO ${tables.bookingEvents}
      (id, booking_id, event_type, actor_type, metadata_json, created_at)
      VALUES (?, ?, ?, 'provider', ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(auditId, bookingId, eventType, metadata, now),
  ]);
};

export const processCalendlyWebhook = async ({
  env,
  body,
  signatureHeader,
}: {
  env: VeraEnv;
  body: string;
  signatureHeader: string;
}) => {
  const signingKey = await resolveSecretBinding(env, "CALENDLY_WEBHOOK_SIGNING_KEY");
  if (!signingKey) return { ok: false as const, status: 503, message: "Calendly webhook signing is not configured.", missingSecretNames: ["CALENDLY_WEBHOOK_SIGNING_KEY"] };
  if (!await verifyCalendlySignature({ body, signatureHeader, signingKey })) {
    return { ok: false as const, status: 403, message: "Invalid Calendly webhook signature.", missingSecretNames: [] };
  }
  let event: VeraRow;
  try {
    event = JSON.parse(body) as VeraRow;
  } catch {
    return { ok: false as const, status: 400, message: "Calendly webhook payload is invalid.", missingSecretNames: [] };
  }
  const eventType = safeString(event.event);
  if (!["invitee.created", "invitee.canceled"].includes(eventType)) {
    return { ok: true as const, status: 200, message: "Calendly webhook ignored.", missingSecretNames: [] };
  }
  const payload = parseObject(event.payload);
  const scheduled = parseObject(payload.scheduled_event);
  const tracking = parseObject(payload.tracking);
  const eventUri = safeString(payload.event) || safeString(parseObject(payload.event).uri) || safeString(scheduled.uri);
  const inviteeUri = safeString(payload.uri);
  const bookingId = safeString(tracking.utm_content);
  const booking = bookingId
    ? await first(env, `SELECT * FROM ${tables.bookings} WHERE id = ?`, [bookingId])
    : await first(env, `SELECT * FROM ${tables.bookings}
        WHERE calendly_event_uri = ? OR calendly_invitee_uri = ? LIMIT 1`, [eventUri, inviteeUri]);
  if (!booking) return { ok: true as const, status: 200, message: "Calendly webhook ignored.", missingSecretNames: [] };
  const resolvedBookingId = safeString(booking.id);
  const rescheduled = payload.rescheduled === true;
  const currentEventUri = safeString(booking.calendly_event_uri);
  const currentInviteeUri = safeString(booking.calendly_invitee_uri);
  const auditId = await calendlyAuditId(resolvedBookingId, eventType, eventUri, inviteeUri);
  if (await first(env, `SELECT id FROM ${tables.bookingEvents} WHERE id = ?`, [auditId])) {
    return { ok: true as const, status: 200, message: "Calendly event already processed.", missingSecretNames: [] };
  }
  if (terminalBookingStatuses.has(safeString(booking.status))) {
    await recordCalendlyWebhookDisposition({
      env,
      bookingId: resolvedBookingId,
      expectedBooking: booking,
      auditId,
      eventType,
      eventUri,
      inviteeUri,
      rescheduled,
      disposition: "terminal_ignored",
      reason: "Terminal bookings are never changed by Calendly webhooks.",
    });
    return { ok: true as const, status: 200, message: "Terminal booking Calendly event audited.", missingSecretNames: [] };
  }
  if (eventType === "invitee.canceled") {
    if (currentEventUri && eventUri && currentEventUri !== eventUri) {
      await recordCalendlyWebhookDisposition({
        env,
        bookingId: resolvedBookingId,
        expectedBooking: booking,
        auditId,
        eventType,
        eventUri,
        inviteeUri,
        rescheduled,
        disposition: "stale_event_ignored",
        reason: "The cancellation belongs to an older Calendly event.",
      });
      return { ok: true as const, status: 200, message: "Older Calendly cancellation audited.", missingSecretNames: [] };
    }
    const authorizedReschedule = rescheduled
      ? await first(env, `SELECT id FROM ${tables.rescheduleRequests}
          WHERE booking_id = ? AND status = 'authorized'
          ORDER BY authorized_at DESC LIMIT 1`, [resolvedBookingId])
      : null;
    const expectedRescheduleCancellation = Boolean(
      authorizedReschedule && safeString(booking.status) === "reschedule_pending" &&
      ["deposit_paid", "paid"].includes(safeString(booking.payment_state)) &&
      currentEventUri && currentEventUri === eventUri &&
      (!currentInviteeUri || !inviteeUri || currentInviteeUri === inviteeUri),
    );
    if (expectedRescheduleCancellation) {
      await recordCalendlyWebhookDisposition({
        env,
        bookingId: resolvedBookingId,
        expectedBooking: booking,
        auditId,
        eventType,
        eventUri,
        inviteeUri,
        rescheduled,
        disposition: "authorized_reschedule_observed",
        reason: "The site-authorized reschedule is waiting for its replacement event.",
      });
      return { ok: true as const, status: 200, message: "Authorized Calendly reschedule cancellation audited.", missingSecretNames: [] };
    }
    await recordCalendlyWebhookDisposition({
      env,
      bookingId: resolvedBookingId,
      expectedBooking: booking,
      auditId,
      eventType,
      eventUri,
      inviteeUri,
      rescheduled,
      disposition: "policy_action_required",
      reason: "Calendly cancellation requires site cancellation and refund policy reconciliation.",
      actionRequired: true,
    });
    return { ok: true as const, status: 202, message: "Calendly cancellation requires staff reconciliation.", missingSecretNames: [] };
  }

  const matchesCurrentProviderEvent = Boolean(
    currentEventUri && currentEventUri === eventUri &&
    currentInviteeUri && currentInviteeUri === inviteeUri,
  );
  if (
    matchesCurrentProviderEvent && safeString(booking.status) === "confirmed" &&
    ["deposit_paid", "paid"].includes(safeString(booking.payment_state))
  ) {
    await recordCalendlyWebhookDisposition({
      env,
      bookingId: resolvedBookingId,
      expectedBooking: booking,
      auditId,
      eventType,
      eventUri,
      inviteeUri,
      rescheduled,
      disposition: "expected_server_event",
      reason: "Calendly confirmed the provider event already committed by the site.",
    });
    return { ok: true as const, status: 200, message: "Expected Calendly event audited.", missingSecretNames: [] };
  }

  if (
    matchesCurrentProviderEvent && safeString(booking.status) === "payment_action_required" &&
    safeString(booking.scheduling_error) === schedulingReconciliationError
  ) {
    const provider = await retrieveCalendlyInviteeForReconciliation(env, inviteeUri);
    if (provider.ok && provider.result.eventUri === eventUri) {
      const reconciled = await persistScheduledBooking({
        env,
        booking,
        result: provider.result,
        auditEventType: eventType,
      });
      if (reconciled.ok) {
        return { ok: true as const, status: 200, message: "Calendly event reconciled.", missingSecretNames: [] };
      }
      await recordCalendlyWebhookDisposition({
        env,
        bookingId: resolvedBookingId,
        expectedBooking: booking,
        auditId,
        eventType,
        eventUri,
        inviteeUri,
        rescheduled,
        disposition: "expected_event_reconciliation_failed",
        reason: reconciled.message,
        actionRequired: true,
      });
      return { ok: true as const, status: 202, message: "Calendly event requires staff reconciliation.", missingSecretNames: [] };
    }
    await recordCalendlyWebhookDisposition({
      env,
      bookingId: resolvedBookingId,
      expectedBooking: booking,
      auditId,
      eventType,
      eventUri,
      inviteeUri,
      rescheduled,
      disposition: "expected_event_reconciliation_failed",
      reason: provider.ok
        ? "Calendly invitee resolved to a different scheduled event."
        : provider.message,
      actionRequired: true,
    });
    return { ok: true as const, status: 202, message: "Calendly event requires staff reconciliation.", missingSecretNames: [] };
  }
  await recordCalendlyWebhookDisposition({
    env,
    bookingId: resolvedBookingId,
    expectedBooking: booking,
    auditId,
    eventType,
    eventUri,
    inviteeUri,
    rescheduled,
    disposition: "unexpected_event_action_required",
    reason: "Calendly created an event that was not already committed or awaiting exact server-created reconciliation.",
    actionRequired: true,
  });
  return { ok: true as const, status: 202, message: "Unexpected Calendly event requires staff reconciliation.", missingSecretNames: [] };
};
