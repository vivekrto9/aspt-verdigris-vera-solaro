import { veraAnalyticsContext } from "./analytics.ts";
import { selectedVeraSchedulingProvider, checkVeraGoogleSlot, reserveVeraGoogleReschedule, releaseVeraGoogleReschedule } from "./google-calendar.ts";
import { getCustomerSession } from "../aggregator/customer-auth.ts";
import {
  linkBusinessLead,
  markLeadConvertedBySourceReference,
  normalizeLeadPhone,
  isValidLeadPhone,
} from "../aggregator/lead-records.ts";
import {
  bookingSlotStarts,
  canUseFreeReschedule,
  getVeraSelection,
  isVeraMode,
  quoteInitialPayment,
  VERA_HOLD_MINUTES,
} from "./catalog.ts";
import {
  calendlySlotIsAvailable,
  cancelCalendlyEvent,
  createCalendlyInviteeForBooking,
  schedulePaidVeraBooking,
} from "./calendly.ts";
import {
  all,
  changeCount,
  first,
  isValidEmail,
  normalizeEmail,
  nowIso,
  randomToken,
  run,
  runStatements,
  safeString,
  secureId,
  sha256Hex,
} from "./db.ts";
import { enqueueVeraEmail } from "./email.ts";
import {
  normalizeVeraBirthTimeApproximation,
  normalizeVeraBirthDate,
  normalizeVeraBirthTime,
  verifyVeraBirthPlaceSelection,
} from "./places.ts";
import {
  createBookingManageToken,
  decryptVeraPrivateJson,
  encryptVeraPrivateJson,
  getVeraBookingAccess,
  giftCodeHash,
  veraBookingManageTokenExpiresAt,
} from "./security.ts";
import { createStripeRefund } from "./stripe.ts";
import { deriveVeraBookingConfirmationState } from "./booking-confirmation.ts";
import type { VeraEnv, VeraRow } from "./types.ts";
import { VERA_TABLES as tables } from "./types.ts";

const bookingNumber = () => `VS-${randomToken(5).toUpperCase()}`;

const publicOrigin = (env: VeraEnv) => {
  const configured = safeString(env.ASTROPAGES_SITE_URL) || safeString(env.SITE_ORIGIN) || safeString(env.SITE_URL);
  try {
    return new URL(configured).origin;
  } catch {
    return "";
  }
};

const bookingAccountUrl = (env: VeraEnv) => {
  const origin = publicOrigin(env);
  if (!origin) return "";
  return new URL("/account", origin).toString();
};

const bookingConfirmationUrl = (env: VeraEnv, bookingId: string) => {
  const origin = publicOrigin(env);
  if (!origin) return "";
  return new URL(`/booking/${encodeURIComponent(bookingId)}/confirmation`, origin).toString();
};

const enqueueBookingConfirmedEmail = async (env: VeraEnv, bookingId: string) => {
  const booking = await first(env, `SELECT booking.*, service.name AS service_name
    FROM ${tables.bookings} booking
    JOIN ${tables.services} service ON service.slug = booking.service_slug
    WHERE booking.id = ?`, [bookingId]);
  if (!booking || safeString(booking.status) !== "confirmed") return;
  const confirmationUrl = bookingConfirmationUrl(env, bookingId);
  if (!confirmationUrl) return;
  await enqueueVeraEmail({
    env,
    eventType: "vera.booking.confirmed",
    templateKey: "vera_booking_confirmed_en",
    recipientEmail: safeString(booking.email),
    recipientName: safeString(booking.customer_name),
    payload: {
      customerName: safeString(booking.customer_name),
      bookingNumber: safeString(booking.booking_number),
      serviceName: safeString(booking.service_name),
      scheduledDateTime: safeString(booking.selected_start_at),
      confirmationUrl,
    },
    idempotencyKey: `booking-confirmed:${bookingId}`,
  }).catch(() => undefined);
};

const validTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

const publicBooking = (row: VeraRow) => ({
  id: safeString(row.id),
  bookingNumber: safeString(row.booking_number),
  serviceSlug: safeString(row.service_slug),
  mode: safeString(row.mode),
  status: safeString(row.status),
  paymentState: safeString(row.payment_state),
  paymentOption: safeString(row.payment_option),
  holdExpiresAt: safeString(row.hold_expires_at),
  selectedStartAt: safeString(row.selected_start_at),
  selectedEndAt: safeString(row.selected_end_at),
  priceCents: Number(row.price_cents),
  giftAppliedCents: Number(row.gift_applied_cents),
  paidCents: Number(row.paid_cents),
  balanceCents: Number(row.balance_cents),
  currency: safeString(row.currency),
  freeRescheduleUsed: Number(row.free_reschedule_used) === 1,
  rescheduleCount: Number(row.reschedule_count),
  schedulingProvider: safeString(row.scheduling_provider) || "calendly",
  calendlyMeetingUrl: safeString(row.calendly_meeting_url),
  calendlyRescheduleUrl: safeString(row.calendly_reschedule_url),
  createdAt: safeString(row.created_at),
  updatedAt: safeString(row.updated_at),
});

const slotConflict = async (
  env: VeraEnv,
  startAt: string,
  durationMinutes: number,
  now: string,
  excludeBookingId = "",
) => {
  const segments = bookingSlotStarts(startAt, durationMinutes);
  if (segments.length === 0) return true;
  const placeholders = segments.map(() => "?").join(",");
  const exclusion = excludeBookingId ? "AND booking_id != ?" : "";
  const row = await first(env, `SELECT slot_start_at FROM ${tables.bookingHolds}
    WHERE slot_start_at IN (${placeholders})
      AND (expires_at IS NULL OR expires_at > ?)
      ${exclusion} LIMIT 1`, [...segments, now, ...(excludeBookingId ? [excludeBookingId] : [])]);
  return Boolean(row);
};

export const expireStaleVeraBookings = async (env: VeraEnv, now = new Date()) => {
  const timestamp = now.toISOString();
  const stale = await all(env, `SELECT id FROM ${tables.bookings}
    WHERE status IN ('pending_payment', 'payment_action_required')
      AND payment_state = 'unpaid' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?
    ORDER BY hold_expires_at LIMIT 100`, [timestamp]);
  for (const row of stale) {
    const bookingId = safeString(row.id);
    await runStatements(env, [
      env.DB!.prepare(`UPDATE ${tables.bookings}
        SET status = 'expired', updated_at = ?
        WHERE id = ? AND payment_state = 'unpaid'`).bind(timestamp, bookingId),
      env.DB!.prepare(`DELETE FROM ${tables.bookingHolds} WHERE booking_id = ?`).bind(bookingId),
      env.DB!.prepare(`UPDATE ${tables.giftRedemptions}
        SET status = 'released', released_at = ?
        WHERE booking_id = ? AND status = 'reserved'`).bind(timestamp, bookingId),
      env.DB!.prepare(`INSERT INTO ${tables.bookingEvents}
        (id, booking_id, event_type, actor_type, metadata_json, created_at)
        VALUES (?, ?, 'booking.expired', 'system', '{}', ?)`)
        .bind(secureId("vbe"), bookingId, timestamp),
    ]);
  }
  return stale.length;
};

export const createVeraBooking = async ({
  env,
  request,
  input,
}: {
  env: VeraEnv;
  request: Request;
  input: Record<string, unknown>;
}) => {
  if (!env.DB?.batch) {
    return { ok: false as const, status: 503, message: "Atomic booking storage is not ready." };
  }
  await expireStaleVeraBookings(env);
  const idempotencyKey = safeString(input.idempotencyKey).slice(0, 120);
  if (!/^[A-Za-z0-9_.:-]{12,120}$/.test(idempotencyKey)) {
    return { ok: false as const, status: 400, message: "A valid idempotency key is required." };
  }
  const existing = await first(env, `SELECT * FROM ${tables.bookings}
    WHERE request_idempotency_key = ?`, [idempotencyKey]);
  if (existing) {
    const token = await createBookingManageToken(env, safeString(existing.id));
    return token
      ? { ok: true as const, status: 200, booking: publicBooking(existing), manageToken: token, alreadyExists: true }
      : { ok: false as const, status: 503, message: "Booking access security is not configured.", missingSecretNames: ["EMDASH_ENCRYPTION_KEY"] };
  }
  const selection = await getVeraSelection(env, input.serviceSlug, input.mode);
  if (!selection || !isVeraMode(input.mode)) {
    return { ok: false as const, status: 400, message: "Select a valid sitting and format." };
  }
  const schedulingProvider = await selectedVeraSchedulingProvider(env);
  if (schedulingProvider === "calendly" && !selection.eventTypeUri) {
    return { ok: false as const, status: 503, message: "Calendly is not configured for 30-minute sittings.", missingSecretNames: ["CALENDLY_EVENT_TYPE_URI"] };
  }
  const name = safeString(input.name).slice(0, 120);
  const email = normalizeEmail(input.email);
  const rawPhone = safeString(input.phone).slice(0, 32);
  const phone = normalizeLeadPhone(rawPhone);
  const timezone = safeString(input.timezone).slice(0, 80);
  const paymentOption = safeString(input.paymentOption);
  if (name.length < 2 || !isValidEmail(email)) {
    return { ok: false as const, status: 400, message: "Name and a valid email address are required." };
  }
  if (phone && !isValidLeadPhone(phone)) {
    return { ok: false as const, status: 400, message: "Enter a valid phone number." };
  }
  if (!timezone || !validTimezone(timezone)) {
    return { ok: false as const, status: 400, message: "Select a valid timezone." };
  }
  if (!["deposit", "full"].includes(paymentOption)) {
    return { ok: false as const, status: 400, message: "Choose deposit or full payment." };
  }
  if (input.consentContact !== true) {
    return { ok: false as const, status: 400, message: "Contact consent is required." };
  }
  const selectedDate = new Date(safeString(input.startAt));
  if (!Number.isFinite(selectedDate.getTime()) || selectedDate.getTime() <= Date.now()) {
    return { ok: false as const, status: 400, message: "Select an available future time." };
  }
  const startAt = selectedDate.toISOString();
  const endAt = new Date(selectedDate.getTime() + selection.durationMinutes * 60_000).toISOString();
  const providerSlot = schedulingProvider === "google_calendar"
    ? await checkVeraGoogleSlot(env, selection.durationMinutes, startAt, undefined, email)
    : await calendlySlotIsAvailable({ env, eventTypeUri: selection.eventTypeUri, startAt });
  if (!providerSlot.ok) return providerSlot;
  if (!providerSlot.available) {
    return { ok: false as const, status: 409, message: "That time is no longer available." };
  }
  const now = new Date();
  const nowValue = now.toISOString();
  if (await slotConflict(env, startAt, selection.durationMinutes, nowValue)) {
    return { ok: false as const, status: 409, message: "That time is already on hold." };
  }
  const giftHash = await giftCodeHash(input.giftCode);
  const gift = giftHash
    ? await first(env, `SELECT * FROM ${tables.giftCertificates}
        WHERE code_hash = ? AND status = 'active'
          AND (expires_at IS NULL OR expires_at > ?)`, [giftHash, nowValue])
    : null;
  if (safeString(input.giftCode) && !gift) {
    return { ok: false as const, status: 400, message: "Gift certificate is invalid or unavailable." };
  }
  const quote = quoteInitialPayment({
    priceCents: selection.priceCents,
    giftAvailableCents: Number(gift?.remaining_amount_cents || 0),
    paymentOption: paymentOption as "deposit" | "full",
  });
  const bookingId = secureId("vbooking");
  const manageTokenExpiresAt = veraBookingManageTokenExpiresAt(now);
  const manageToken = await createBookingManageToken(env, bookingId, manageTokenExpiresAt);
  if (!manageToken) {
    return { ok: false as const, status: 503, message: "Booking access security is not configured.", missingSecretNames: ["EMDASH_ENCRYPTION_KEY"] };
  }
  const intakeInput = input.intake && typeof input.intake === "object" && !Array.isArray(input.intake)
    ? input.intake as Record<string, unknown>
    : {};
  const birthDate = normalizeVeraBirthDate(intakeInput.birthDate);
  const gender = safeString(intakeInput.gender);
  const birthTimeUnknown = intakeInput.birthTimeUnknown === true;
  const birthTime = birthTimeUnknown ? "" : normalizeVeraBirthTime(intakeInput.birthTime);
  const rawBirthTimeApproximation = safeString(intakeInput.birthTimeApproximation);
  const birthTimeApproximation = birthTimeUnknown
    ? normalizeVeraBirthTimeApproximation(rawBirthTimeApproximation)
    : "";
  if (
    !birthDate ||
    (!birthTimeUnknown && !birthTime) ||
    (birthTimeUnknown && !birthTimeApproximation) ||
    (!birthTimeUnknown && rawBirthTimeApproximation)
  ) {
    return { ok: false as const, status: 400, message: "Enter a valid birth date and time, or mark the birth time unknown." };
  }
  const resolvedPlace = await verifyVeraBirthPlaceSelection({
    env,
    token: intakeInput.placeSelectionToken,
    birthDate,
    birthTime,
    birthTimeUnknown,
  });
  if (!resolvedPlace) {
    return { ok: false as const, status: 400, message: "Select the birth place from Google Places again." };
  }
  const intake = {
    birthDate,
    ...(gender ? { gender } : {}),
    birthTime,
    birthTimeUnknown,
    ...(birthTimeUnknown ? { birthTimeApproximation } : {}),
    birthPlace: resolvedPlace.formattedAddress,
    birthPlaceId: resolvedPlace.placeId,
    birthLatitude: resolvedPlace.latitude,
    birthLongitude: resolvedPlace.longitude,
    birthTimezone: resolvedPlace.timezone,
    birthTimezoneOffset: resolvedPlace.timezoneOffset,
    focus: safeString(intakeInput.focus).slice(0, 2_000),
  };
  const encryptedIntake = await encryptVeraPrivateJson(env, intake);
  if (!encryptedIntake) {
    return { ok: false as const, status: 503, message: "Private intake storage is not configured.", missingSecretNames: ["EMDASH_ENCRYPTION_KEY"] };
  }
  const session = await getCustomerSession(env, request);
  const accountId = session && normalizeEmail(session.account.email) === email ? session.account.id : null;
  const fullyGifted = quote.totalDueCents === 0;
  const holdExpiresAt = fullyGifted
    ? null
    : new Date(now.getTime() + VERA_HOLD_MINUTES * 60_000).toISOString();
  const analytics = await veraAnalyticsContext(env, request);
  const calendar = "settings" in providerSlot ? providerSlot.settings : null;
  const calendarRules = "rules" in providerSlot ? providerSlot.rules : null;
  const number = bookingNumber();
  const statements = [
    env.DB.prepare(`INSERT INTO ${tables.bookings}
      (id, booking_number, request_idempotency_key, account_id, service_slug, mode,
       status, payment_state, payment_option, customer_name, email, normalized_email,
       phone, customer_timezone, selected_start_at, selected_end_at, price_cents,
       gift_applied_cents, total_due_cents, paid_cents, balance_cents, currency,
       gift_certificate_id, manage_token_hash, manage_token_expires_at, encrypted_intake,
       calendly_event_type_uri, hold_expires_at, created_at, updated_at,
       scheduling_provider, scheduling_calendar_id, scheduling_timezone, scheduling_rules_json,
       scheduling_buffer_before, scheduling_buffer_after, analytics_client_id, analytics_provider, analytics_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        bookingId, number, idempotencyKey, accountId, selection.slug, input.mode,
        fullyGifted ? "payment_action_required" : "pending_payment",
        fullyGifted ? "paid" : "unpaid", paymentOption, name, email, email,
        phone || null, timezone, startAt, endAt, selection.priceCents,
        quote.giftAppliedCents, quote.totalDueCents, quote.balanceCents,
        selection.currency, gift ? safeString(gift.id) : null,
        await sha256Hex(manageToken), manageTokenExpiresAt, encryptedIntake,
        selection.eventTypeUri, holdExpiresAt, nowValue, nowValue,
        schedulingProvider, calendar?.calendar_id ?? null, calendar?.timezone ?? null, calendar?.rules_json ?? null,
        calendarRules?.bufferBefore ?? 0, calendarRules?.bufferAfter ?? 0, analytics.clientId, analytics.provider, analytics.sessionId,
      ),
    ...bookingSlotStarts(startAt, selection.durationMinutes).map((slot) =>
      env.DB!.prepare(`INSERT INTO ${tables.bookingHolds}
        (slot_start_at, booking_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
        .bind(slot, bookingId, holdExpiresAt, nowValue)
    ),
    env.DB.prepare(`INSERT INTO ${tables.bookingEvents}
      (id, booking_id, event_type, actor_type, metadata_json, created_at)
      VALUES (?, ?, 'booking.created', 'customer', ?, ?)`)
      .bind(secureId("vbe"), bookingId, JSON.stringify({ paymentOption }), nowValue),
  ];
  if (gift && quote.giftAppliedCents > 0) {
    statements.push(
      env.DB.prepare(`INSERT INTO ${tables.giftRedemptions}
        (id, gift_certificate_id, booking_id, amount_cents, status, created_at, applied_at, released_at)
        VALUES (?, ?, ?, ?, 'reserved', ?, NULL, NULL)`)
        .bind(secureId("vgiftred"), safeString(gift.id), bookingId, quote.giftAppliedCents, nowValue),
    );
    if (fullyGifted) {
      statements.push(
        env.DB.prepare(`UPDATE ${tables.giftRedemptions}
          SET status = 'applied', applied_at = ? WHERE booking_id = ?`)
          .bind(nowValue, bookingId),
      );
    }
  }
  try {
    await runStatements(env, statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return {
      ok: false as const,
      status: 409,
      message: message.includes("vera_gift_unavailable")
        ? "Gift certificate is no longer available."
        : "That time was just reserved. Choose another time.",
    };
  }
  await linkBusinessLead({
    env,
    submission: {
      kind: "consultation",
      source: "consultation_booking",
      formKey: "vera-booking",
      pagePath: "/booking",
      locale: "en",
      fullName: name,
      email,
      phone: rawPhone,
      consentMarketing: input.consentMarketing === true,
      customerAccountId: accountId || undefined,
      sourceReferenceType: "vera_booking",
      sourceReferenceId: bookingId,
      details: {
        bookingNumber: number,
        serviceSlug: selection.slug,
        serviceName: selection.name,
        consultationMode: input.mode === "in_person" ? "in person" : "call",
        consultationDate: startAt.slice(0, 10),
        consultationSlot: startAt,
        paymentOption,
        amountCents: selection.priceCents,
        currency: selection.currency,
      },
    },
  });
  if (fullyGifted) {
    await markLeadConvertedBySourceReference({
      env,
      sourceReferenceType: "vera_booking",
      sourceReferenceId: bookingId,
      conversionReference: `gift:${safeString(gift?.id)}`,
    });
    const scheduled = await schedulePaidVeraBooking(env, bookingId);
    if (scheduled.ok) await enqueueBookingConfirmedEmail(env, bookingId);
  }
  const persisted = await first(env, `SELECT * FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
  return {
    ok: true as const,
    status: 201,
    booking: publicBooking(persisted || { id: bookingId }),
    manageToken,
    alreadyExists: false,
    payNowCents: quote.payNowCents,
    holdExpiresAt,
  };
};

export const getVeraBookingStatus = async ({
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
  await expireStaleVeraBookings(env);
  const access = await getVeraBookingAccess({ env, request, bookingId, manageToken });
  if (!access.ok) return access;
  const privateIntake = safeString(access.booking.encrypted_intake)
    ? await decryptVeraPrivateJson(env, safeString(access.booking.encrypted_intake)).catch(() => null)
    : null;
  const intake = privateIntake && typeof privateIntake === "object" && !Array.isArray(privateIntake)
    ? privateIntake as VeraRow
    : null;
  const birthTimeUnknown = intake?.birthTimeUnknown === true;
  const birthTimeApproximation = birthTimeUnknown
    ? normalizeVeraBirthTimeApproximation(intake?.birthTimeApproximation)
    : "";
  const latestAttempt = await first(env, `SELECT status FROM ${tables.paymentAttempts}
    WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1`, [bookingId]);
  const booking = publicBooking(access.booking);
  return {
    ok: true as const,
    status: 200,
    booking: {
      ...booking,
      birthTimeUnknown,
      ...(birthTimeApproximation ? { birthTimeApproximation } : {}),
      confirmationState: deriveVeraBookingConfirmationState({
        bookingStatus: booking.status,
        paymentState: booking.paymentState,
        paymentAttemptStatus: safeString(latestAttempt?.status),
      }),
    },
  };
};

export const updateVeraBookingQuote = async ({
  env,
  request,
  bookingId,
  manageToken,
  input,
}: {
  env: VeraEnv;
  request: Request;
  bookingId: string;
  manageToken: string;
  input: Record<string, unknown>;
}) => {
  if (!env.DB?.batch) {
    return { ok: false as const, status: 503, message: "Atomic booking quotes are not ready." };
  }
  await expireStaleVeraBookings(env);
  const access = await getVeraBookingAccess({ env, request, bookingId, manageToken, requireCsrf: true });
  if (!access.ok) return access;
  if (!access.tokenAccess) {
    return { ok: false as const, status: 403, message: "The booking manage token is required to change payment details." };
  }
  const booking = access.booking;
  const now = new Date();
  const nowValue = now.toISOString();
  if (
    safeString(booking.status) !== "pending_payment" ||
    safeString(booking.payment_state) !== "unpaid" ||
    !safeString(booking.hold_expires_at) ||
    new Date(safeString(booking.hold_expires_at)).getTime() <= now.getTime()
  ) {
    return { ok: false as const, status: 409, message: "Only an active unpaid hold can change its payment quote." };
  }
  const paymentOption = safeString(input.paymentOption) || safeString(booking.payment_option);
  if (!["deposit", "full"].includes(paymentOption)) {
    return { ok: false as const, status: 400, message: "Choose deposit or full payment." };
  }
  const lockedAttempt = await first(env, `SELECT id FROM ${tables.paymentAttempts}
    WHERE booking_id = ? AND (
      provider_payment_intent_id IS NOT NULL OR status NOT IN ('failed', 'cancelled')
    ) LIMIT 1`, [bookingId]);
  if (lockedAttempt) {
    return { ok: false as const, status: 409, message: "Payment details are fixed after Stripe payment preparation begins." };
  }
  const currentRedemption = await first(env, `SELECT redemption.*, gift.code_hash
    FROM ${tables.giftRedemptions} redemption
    JOIN ${tables.giftCertificates} gift ON gift.id = redemption.gift_certificate_id
    WHERE redemption.booking_id = ? AND redemption.status = 'reserved'`, [bookingId]);
  const removeGift = input.removeGift === true;
  const submittedCode = safeString(input.giftCode);
  const submittedHash = submittedCode ? await giftCodeHash(submittedCode) : "";
  let selectedGift: VeraRow | null = currentRedemption
    ? {
        id: currentRedemption.gift_certificate_id,
        code_hash: currentRedemption.code_hash,
        remaining_amount_cents: currentRedemption.amount_cents,
      }
    : null;
  if (removeGift) {
    selectedGift = null;
  } else if (submittedCode) {
    selectedGift = submittedHash
      ? await first(env, `SELECT * FROM ${tables.giftCertificates}
          WHERE code_hash = ? AND status = 'active'
            AND (expires_at IS NULL OR expires_at > ?)`, [submittedHash, nowValue])
      : null;
    if (!selectedGift && submittedHash === safeString(currentRedemption?.code_hash)) {
      selectedGift = {
        id: currentRedemption?.gift_certificate_id,
        code_hash: currentRedemption?.code_hash,
        remaining_amount_cents: currentRedemption?.amount_cents,
      };
    }
    if (!selectedGift) {
      return { ok: false as const, status: 400, message: "Gift certificate is invalid or unavailable." };
    }
  }
  const sameGift = Boolean(
    currentRedemption && selectedGift &&
    safeString(currentRedemption.gift_certificate_id) === safeString(selectedGift.id),
  );
  const giftAvailableCents = sameGift
    ? Number(currentRedemption?.amount_cents || 0)
    : Number(selectedGift?.remaining_amount_cents || 0);
  const quote = quoteInitialPayment({
    priceCents: Number(booking.price_cents),
    giftAvailableCents,
    paymentOption: paymentOption as "deposit" | "full",
  });
  const fullyGifted = quote.totalDueCents === 0;
  const statements = [];
  if (currentRedemption && !sameGift) {
    statements.push(
      env.DB.prepare(`UPDATE ${tables.giftRedemptions}
        SET status = 'released', released_at = ? WHERE id = ? AND status = 'reserved'`)
        .bind(nowValue, safeString(currentRedemption.id)),
      env.DB.prepare(`DELETE FROM ${tables.giftRedemptions}
        WHERE id = ? AND status = 'released'`).bind(safeString(currentRedemption.id)),
    );
  }
  if (selectedGift && !sameGift && quote.giftAppliedCents > 0) {
    statements.push(
      env.DB.prepare(`INSERT INTO ${tables.giftRedemptions}
        (id, gift_certificate_id, booking_id, amount_cents, status, created_at, applied_at, released_at)
        VALUES (?, ?, ?, ?, 'reserved', ?, NULL, NULL)`)
        .bind(secureId("vgiftred"), safeString(selectedGift.id), bookingId, quote.giftAppliedCents, nowValue),
    );
  }
  statements.push(
    env.DB.prepare(`UPDATE ${tables.bookings}
      SET payment_option = ?, gift_certificate_id = ?, gift_applied_cents = ?,
        total_due_cents = ?, balance_cents = ?, payment_state = ?, status = ?,
        hold_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_payment' AND payment_state = 'unpaid'
        AND hold_expires_at > ?`)
      .bind(
        paymentOption,
        selectedGift ? safeString(selectedGift.id) : null,
        quote.giftAppliedCents,
        quote.totalDueCents,
        quote.balanceCents,
        fullyGifted ? "paid" : "unpaid",
        fullyGifted ? "payment_action_required" : "pending_payment",
        fullyGifted ? null : safeString(booking.hold_expires_at),
        nowValue,
        bookingId,
        nowValue,
      ),
    env.DB.prepare(`INSERT INTO ${tables.bookingEvents}
      (id, booking_id, event_type, actor_type, metadata_json, created_at)
      VALUES (?, ?, 'booking.quote_updated', 'customer', ?, ?)`)
      .bind(secureId("vbe"), bookingId, JSON.stringify({ paymentOption, giftAppliedCents: quote.giftAppliedCents }), nowValue),
  );
  if (fullyGifted) {
    statements.push(
      env.DB.prepare(`UPDATE ${tables.giftRedemptions}
        SET status = 'applied', applied_at = ? WHERE booking_id = ? AND status = 'reserved'`)
        .bind(nowValue, bookingId),
      env.DB.prepare(`UPDATE ${tables.bookingHolds}
        SET expires_at = NULL WHERE booking_id = ?`).bind(bookingId),
    );
  }
  try {
    await runStatements(env, statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return {
      ok: false as const,
      status: 409,
      message: message.includes("vera_payment_selection_locked")
        ? "Payment details are fixed after Stripe payment preparation begins."
        : message.includes("vera_gift_unavailable")
          ? "Gift certificate is no longer available."
          : "The booking quote changed. Refresh and try again.",
    };
  }
  if (fullyGifted) {
    await markLeadConvertedBySourceReference({
      env,
      sourceReferenceType: "vera_booking",
      sourceReferenceId: bookingId,
      conversionReference: `gift:${safeString(selectedGift?.id)}`,
    });
    const scheduled = await schedulePaidVeraBooking(env, bookingId);
    if (scheduled.ok) await enqueueBookingConfirmedEmail(env, bookingId);
  }
  const persisted = await first(env, `SELECT * FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
  return {
    ok: true as const,
    status: 200,
    message: fullyGifted ? "Gift certificate covered the booking." : "Booking quote updated.",
    booking: publicBooking(persisted || booking),
    quote: {
      paymentOption,
      priceCents: quote.priceCents,
      giftAppliedCents: quote.giftAppliedCents,
      totalDueCents: quote.totalDueCents,
      payNowCents: quote.payNowCents,
      balanceCents: quote.balanceCents,
      currency: safeString(booking.currency),
      fullyGifted,
      holdExpiresAt: fullyGifted ? null : safeString(booking.hold_expires_at),
    },
  };
};

export const requestFreeVeraReschedule = async ({
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
  if (safeString(booking.status) === "reschedule_pending") {
    return {
      ok: true as const,
      status: 200,
      message: "Reschedule is already authorized.",
      completionPath: `/api/astropages/generated-site/vera/bookings/${encodeURIComponent(bookingId)}/reschedule`,
      recoveryRescheduleUrl: safeString(booking.calendly_reschedule_url),
    };
  }
  if (
    safeString(booking.status) !== "confirmed" ||
    !canUseFreeReschedule({
      freeRescheduleUsed: Number(booking.free_reschedule_used) === 1,
      scheduledStartAt: safeString(booking.selected_start_at),
    })
  ) {
    return { ok: false as const, status: 409, message: "The free reschedule is available once, until 72 hours before the sitting." };
  }
  const providerUrl = /^https:\/\//.test(safeString(booking.calendly_reschedule_url))
    ? safeString(booking.calendly_reschedule_url)
    : "";
  const now = nowIso();
  await runStatements(env, [
    env.DB!.prepare(`UPDATE ${tables.bookings}
      SET status = 'reschedule_pending', updated_at = ? WHERE id = ?`).bind(now, bookingId),
    env.DB!.prepare(`INSERT INTO ${tables.rescheduleRequests}
      (id, booking_id, status, policy, previous_start_at, replacement_start_at,
       provider_reschedule_url, authorized_at, completed_at)
      VALUES (?, ?, 'authorized', 'one_free_until_72h', ?, NULL, ?, ?, NULL)`)
      .bind(secureId("vreschedule"), bookingId, safeString(booking.selected_start_at), providerUrl, now),
    env.DB!.prepare(`INSERT INTO ${tables.bookingEvents}
      (id, booking_id, event_type, actor_type, metadata_json, created_at)
      VALUES (?, ?, 'reschedule.authorized', 'customer', ?, ?)`)
      .bind(secureId("vbe"), bookingId, JSON.stringify({ policy: "one_free_until_72h" }), now),
  ]);
  return {
    ok: true as const,
    status: 200,
    message: "Reschedule authorized. Choose a new time here.",
    completionPath: `/api/astropages/generated-site/vera/bookings/${encodeURIComponent(bookingId)}/reschedule`,
    recoveryRescheduleUrl: providerUrl,
  };
};

const rescheduleFollowUps = ({
  booking,
  startAt,
  endAt,
  now,
}: {
  booking: VeraRow;
  startAt: string;
  endAt: string;
  now: Date;
}) => [
  {
    kind: "intake_reminder",
    dueAt: new Date(Math.max(
      now.getTime() + 5 * 60_000,
      new Date(startAt).getTime() - 14 * 24 * 60 * 60_000,
    )).toISOString(),
  },
  { kind: "session_reminder", dueAt: new Date(new Date(startAt).getTime() - 24 * 60 * 60_000).toISOString() },
  { kind: "post_session", dueAt: new Date(new Date(endAt).getTime() + 24 * 60 * 60_000).toISOString() },
  ...(Number(booking.balance_cents) > 0
    ? [{ kind: "balance_reminder", dueAt: new Date(new Date(endAt).getTime() + 24 * 60 * 60_000).toISOString() }]
    : []),
].filter((entry) => new Date(entry.dueAt).getTime() > now.getTime());

export const completeVeraReschedule = async ({
  env,
  request,
  bookingId,
  manageToken,
  newStartAt,
}: {
  env: VeraEnv;
  request: Request;
  bookingId: string;
  manageToken: string;
  newStartAt: unknown;
}) => {
  if (!env.DB?.batch) {
    return { ok: false as const, status: 503, message: "Atomic rescheduling storage is not ready." };
  }
  const access = await getVeraBookingAccess({ env, request, bookingId, manageToken, requireCsrf: true });
  if (!access.ok) return access;
  const booking = access.booking;
  if (
    !["confirmed", "reschedule_pending"].includes(safeString(booking.status)) ||
    !["deposit_paid", "paid"].includes(safeString(booking.payment_state))
  ) {
    return { ok: false as const, status: 409, message: "Only a confirmed, paid sitting can be rescheduled." };
  }
  if (!canUseFreeReschedule({
    freeRescheduleUsed: Number(booking.free_reschedule_used) === 1,
    scheduledStartAt: safeString(booking.selected_start_at),
  })) {
    return { ok: false as const, status: 409, message: "The free reschedule is available once, until 72 hours before the sitting." };
  }
  const selected = new Date(safeString(newStartAt));
  if (!Number.isFinite(selected.getTime()) || selected.getTime() <= Date.now()) {
    return { ok: false as const, status: 400, message: "Choose a valid future time." };
  }
  const startAt = selected.toISOString();
  if (startAt === safeString(booking.selected_start_at)) {
    return { ok: false as const, status: 409, message: "Choose a different time for the sitting." };
  }
  const service = await first(env, `SELECT name, duration_minutes FROM ${tables.services}
    WHERE slug = ? AND active = 1`, [safeString(booking.service_slug)]);
  const durationMinutes = Number(service?.duration_minutes);
  if (![30, 90, 120].includes(durationMinutes)) {
    return { ok: false as const, status: 409, message: "The sitting duration is not configured." };
  }
  const eventTypeUri = safeString(booking.calendly_event_type_uri);
  const googleCalendar = booking.scheduling_provider === "google_calendar";
  const providerSlot = googleCalendar
    ? await checkVeraGoogleSlot(env, durationMinutes, startAt, booking, safeString(booking.email))
    : await calendlySlotIsAvailable({ env, eventTypeUri, startAt });
  if (!providerSlot.ok) return providerSlot;
  if (!providerSlot.available) {
    return { ok: false as const, status: 409, message: "That time is no longer available." };
  }
  const now = new Date();
  const nowValue = now.toISOString();
  if (await slotConflict(env, startAt, durationMinutes, nowValue, bookingId)) {
    return { ok: false as const, status: 409, message: "That time is already reserved." };
  }
  const oldEventUri = safeString(booking.calendly_event_uri);
  if (!oldEventUri) {
    return { ok: false as const, status: 409, message: "The existing Calendly sitting is not available for replacement." };
  }
  let reschedule = await first(env, `SELECT * FROM ${tables.rescheduleRequests}
    WHERE booking_id = ? AND status = 'authorized'
    ORDER BY authorized_at DESC LIMIT 1`, [bookingId]);
  if (!reschedule) {
    const requestId = secureId("vreschedule");
    try {
      await runStatements(env, [
        env.DB.prepare(`UPDATE ${tables.bookings}
          SET status = 'reschedule_pending', updated_at = ?
          WHERE id = ? AND status = 'confirmed'`).bind(nowValue, bookingId),
        env.DB.prepare(`INSERT INTO ${tables.rescheduleRequests}
          (id, booking_id, status, policy, previous_start_at, replacement_start_at,
           provider_reschedule_url, authorized_at, completed_at)
          VALUES (?, ?, 'authorized', 'one_free_until_72h', ?, NULL, ?, ?, NULL)`)
          .bind(
            requestId,
            bookingId,
            safeString(booking.selected_start_at),
            safeString(booking.calendly_reschedule_url) || null,
            nowValue,
          ),
        env.DB.prepare(`INSERT INTO ${tables.bookingEvents}
          (id, booking_id, event_type, actor_type, metadata_json, created_at)
          VALUES (?, ?, 'reschedule.authorized', 'customer', ?, ?)`)
          .bind(secureId("vbe"), bookingId, JSON.stringify({ policy: "one_free_until_72h" }), nowValue),
      ]);
      reschedule = { id: requestId };
    } catch {
      return { ok: false as const, status: 409, message: "This reschedule could not be authorized. Refresh and try again." };
    }
  }
  if (googleCalendar) {
    try { await reserveVeraGoogleReschedule(env, booking, startAt, durationMinutes); }
    catch { return { ok: false as const, status: 409, message: "That time is reserved, or an earlier reschedule needs reconciliation." }; }
  }
  const created = await createCalendlyInviteeForBooking({ env, booking, startAt });
  if (!created.ok) {
    if ("outcomeUnknown" in created && created.outcomeUnknown) {
      const failureAt = nowIso();
      const failureMessage = "Calendar replacement scheduling outcome is unknown and requires staff reconciliation.";
      await runStatements(env, [
        env.DB.prepare(`UPDATE ${tables.bookings}
          SET status = 'payment_action_required', scheduling_error = ?, updated_at = ?
          WHERE id = ? AND status = 'reschedule_pending'`)
          .bind(failureMessage, failureAt, bookingId),
        env.DB.prepare(`INSERT INTO ${tables.bookingEvents}
          (id, booking_id, event_type, actor_type, metadata_json, created_at)
          VALUES (?, ?, 'reschedule.create_outcome_unknown', 'system', ?, ?)`)
          .bind(
            secureId("vbe"),
            bookingId,
            JSON.stringify({ replacementStartAt: startAt, rescheduleRequestId: safeString(reschedule.id) }),
            failureAt,
          ),
      ]);
      return { ...created, message: "The reschedule needs staff reconciliation. Do not submit it again." };
    }
    if (googleCalendar) await releaseVeraGoogleReschedule(env, bookingId);
    return created;
  }
  const replacement = created.result;
  const providerStart = replacement.startAt ? new Date(replacement.startAt).toISOString() : startAt;
  const expectedEndAt = new Date(selected.getTime() + durationMinutes * 60_000).toISOString();
  const providerEnd = replacement.endAt ? new Date(replacement.endAt).toISOString() : expectedEndAt;
  if (providerStart !== startAt || providerEnd !== expectedEndAt) {
    await cancelCalendlyEvent(env, replacement.eventUri, "Replacement time did not match the requested sitting").catch(() => undefined);
    return { ok: false as const, status: 502, message: "Calendly returned a different time than requested. Choose the slot again." };
  }
  const oldReservation = googleCalendar ? [env.DB.prepare("UPDATE ap_vera_scheduling_reservations SET start_ms = ?, end_ms = ? WHERE id = ?").bind(Date.parse(safeString(booking.selected_start_at)) - Number(booking.scheduling_buffer_before || 0) * 60000, Date.parse(safeString(booking.selected_end_at)) + Number(booking.scheduling_buffer_after || 0) * 60000, bookingId + ":reschedule")] : [];
  const followUps = rescheduleFollowUps({ booking, startAt, endAt: expectedEndAt, now });
  const metadata = JSON.stringify({
    previousStartAt: safeString(booking.selected_start_at),
    replacementStartAt: startAt,
    replacementEventUri: replacement.eventUri,
  });
  try {
    await runStatements(env, [
      ...oldReservation,
      env.DB.prepare(`UPDATE ${tables.emailOutbox}
        SET status = 'cancelled', locked_at = NULL, last_error_code = 'booking_rescheduled', updated_at = ?
        WHERE id IN (
          SELECT outbox_id FROM ${tables.followUps}
          WHERE booking_id = ? AND status = 'queued' AND outbox_id IS NOT NULL
        ) AND status IN ('pending', 'retry')`).bind(nowValue, bookingId),
      env.DB.prepare(`UPDATE ${tables.followUps}
        SET status = 'cancelled', updated_at = ?
        WHERE booking_id = ? AND status IN ('pending', 'queued')`).bind(nowValue, bookingId),
      env.DB.prepare(`DELETE FROM ${tables.bookingHolds} WHERE booking_id = ?`).bind(bookingId),
      ...bookingSlotStarts(startAt, durationMinutes).map((slot) =>
        env.DB!.prepare(`INSERT INTO ${tables.bookingHolds}
          (slot_start_at, booking_id, expires_at, created_at) VALUES (?, ?, NULL, ?)`)
          .bind(slot, bookingId, nowValue)
      ),
      ...followUps.map((followUp) => env.DB!.prepare(`INSERT INTO ${tables.followUps}
        (id, booking_id, kind, due_at, status, outbox_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)
        ON CONFLICT(booking_id, kind, due_at) DO NOTHING`)
        .bind(secureId("vfollow"), bookingId, followUp.kind, followUp.dueAt, nowValue, nowValue)),
      env.DB.prepare(`UPDATE ${tables.bookings}
        SET status = 'confirmed', selected_start_at = ?, selected_end_at = ?,
          calendly_event_uri = ?, calendly_invitee_uri = ?, calendly_cancel_url = ?,
          calendly_reschedule_url = ?, calendly_meeting_url = ?, scheduling_error = NULL,
          free_reschedule_used = 1, reschedule_count = reschedule_count + 1,
          hold_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .bind(
          startAt,
          expectedEndAt,
          replacement.eventUri,
          replacement.inviteeUri,
          replacement.cancelUrl || null,
          replacement.rescheduleUrl || null,
          replacement.meetingUrl || null,
          nowValue,
          bookingId,
        ),
      env.DB.prepare(`UPDATE ${tables.rescheduleRequests}
        SET status = 'completed', replacement_start_at = ?, completed_at = ?
        WHERE id = ? AND status = 'authorized'`)
        .bind(startAt, nowValue, safeString(reschedule.id)),
      env.DB.prepare(`INSERT INTO ${tables.bookingEvents}
        (id, booking_id, event_type, actor_type, metadata_json, created_at)
        VALUES (?, ?, 'reschedule.completed', 'customer', ?, ?)`)
        .bind(secureId("vbe"), bookingId, metadata, nowValue),
    ]);
  } catch {
    const compensated = await cancelCalendlyEvent(
      env,
      replacement.eventUri,
      "Replacement could not be committed",
    ).catch(() => ({ ok: false as const }));
    if (googleCalendar && compensated.ok) await releaseVeraGoogleReschedule(env, bookingId);
    const failureAt = nowIso();
    const failureMessage = compensated.ok
      ? "Replacement was released because the selected time was taken."
      : "Replacement and original calendar events require staff reconciliation.";
    await runStatements(env, [
      env.DB.prepare(`UPDATE ${tables.bookings}
        SET status = ?, scheduling_error = ?, updated_at = ? WHERE id = ?`)
        .bind(compensated.ok ? "reschedule_pending" : "payment_action_required", failureMessage, failureAt, bookingId),
      env.DB.prepare(`INSERT INTO ${tables.bookingEvents}
        (id, booking_id, event_type, actor_type, metadata_json, created_at)
        VALUES (?, ?, ?, 'system', ?, ?)`)
        .bind(
          secureId("vbe"),
          bookingId,
          compensated.ok ? "reschedule.compensated" : "reschedule.reconciliation_required",
          JSON.stringify({ replacementEventUri: replacement.eventUri }),
          failureAt,
        ),
    ]).catch(() => undefined);
    return {
      ok: false as const,
      status: compensated.ok ? 409 : 502,
      message: compensated.ok
        ? "That time was reserved by someone else. Choose another time."
        : "The reschedule needs staff attention. Do not submit it again.",
    };
  }
  const cancellation = await cancelCalendlyEvent(env, oldEventUri, "Replaced through Vera's account portal");
  if (googleCalendar && cancellation.ok) await releaseVeraGoogleReschedule(env, bookingId);
  let actionRequired = false;
  if (!cancellation.ok) {
    actionRequired = true;
    const failureAt = nowIso();
    await runStatements(env, [
      env.DB.prepare(`UPDATE ${tables.bookings}
        SET status = 'payment_action_required', scheduling_error = ?, updated_at = ? WHERE id = ?`)
        .bind("Replacement is confirmed; the original calendar event still needs staff cancellation.", failureAt, bookingId),
      env.DB.prepare(`INSERT INTO ${tables.bookingEvents}
        (id, booking_id, event_type, actor_type, metadata_json, created_at)
        VALUES (?, ?, 'reschedule.old_event_cancel_failed', 'system', ?, ?)`)
        .bind(secureId("vbe"), bookingId, JSON.stringify({ oldEventUri }), failureAt),
    ]);
  }
  const accountUrl = bookingAccountUrl(env);
  if (accountUrl) {
    await enqueueVeraEmail({
      env,
      eventType: "vera.booking.rescheduled",
      templateKey: "vera_booking_rescheduled_en",
      recipientEmail: safeString(booking.email),
      recipientName: safeString(booking.customer_name),
      payload: {
        customerName: safeString(booking.customer_name),
        bookingNumber: safeString(booking.booking_number),
        serviceName: safeString(service?.name),
        scheduledDateTime: startAt,
        accountUrl,
      },
      idempotencyKey: `booking-rescheduled:${bookingId}:${startAt}`,
    }).catch(() => undefined);
  }
  const persisted = await first(env, `SELECT * FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
  return {
    ok: true as const,
    status: actionRequired ? 202 : 200,
    message: actionRequired
      ? "Your new sitting is confirmed. Vera's staff will remove the original calendar event."
      : "Your sitting has been rescheduled.",
    booking: publicBooking(persisted || booking),
    actionRequired,
    recoveryRescheduleUrl: safeString(persisted?.calendly_reschedule_url),
  };
};

export const cancelVeraBooking = async ({
  env,
  request,
  bookingId,
  manageToken,
  reason,
}: {
  env: VeraEnv;
  request: Request;
  bookingId: string;
  manageToken: string;
  reason: string;
}) => {
  const access = await getVeraBookingAccess({ env, request, bookingId, manageToken, requireCsrf: true });
  if (!access.ok) return access;
  const booking = access.booking;
  if (safeString(booking.status) === "payment_action_required" && safeString(booking.cancelled_at)) {
    const refund = await first(env, `SELECT id, status FROM ${tables.refunds}
      WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1`, [bookingId]);
    return {
      ok: true as const,
      status: 202,
      message: "Cancellation is recorded and needs staff attention.",
      cancellationState: "action_required",
      refundState: safeString(refund?.status) || "action_required",
      refundId: safeString(refund?.id),
    };
  }
  if (["cancelled", "expired", "completed", "refunded"].includes(safeString(booking.status))) {
    return { ok: false as const, status: 409, message: "This booking can no longer be cancelled." };
  }
  if (booking.scheduling_provider === "google_calendar") {
    const replacement = await first(env, "SELECT id FROM ap_vera_scheduling_reservations WHERE id = ?", [bookingId + ":reschedule"]);
    if (replacement || (Number(booking.scheduling_attempted) && !booking.calendly_event_uri)) return { ok: false as const, status: 409, message: "Calendar scheduling must be reconciled before cancellation." };
  }
  if (booking.scheduling_provider === "google_calendar") {
    const claim = await run(env, "UPDATE ap_vera_bookings SET scheduling_operation = 'cancel' WHERE id = ? AND (scheduling_operation IS NULL OR scheduling_operation = 'cancel') AND status NOT IN ('cancelled', 'expired', 'completed', 'refunded')", [bookingId]);
    if (changeCount(claim) !== 1) return { ok: false as const, status: 409, message: "Another calendar operation is in progress or needs reconciliation." };
  }
  const paid = ["deposit_paid", "paid", "partially_refunded"].includes(safeString(booking.payment_state)) &&
    Number(booking.paid_cents) > 0;
  const refundEligible = paid &&
    new Date(safeString(booking.selected_start_at)).getTime() - Date.now() >= 72 * 60 * 60_000;
  const eventUri = safeString(booking.calendly_event_uri);
  if (eventUri) {
    const provider = await cancelCalendlyEvent(env, eventUri, reason);
    if (!provider.ok) {
      const failureAt = nowIso();
      await runStatements(env, [
        env.DB!.prepare(`UPDATE ${tables.bookings}
          SET status = 'payment_action_required', scheduling_error = ?, updated_at = ? WHERE id = ?`)
          .bind("Calendly cancellation requires staff action.", failureAt, bookingId),
        env.DB!.prepare(`INSERT INTO ${tables.bookingEvents}
          (id, booking_id, event_type, actor_type, metadata_json, created_at)
          VALUES (?, ?, 'cancellation.provider_action_required', 'system', '{}', ?)`)
          .bind(secureId("vbe"), bookingId, failureAt),
      ]);
      return {
        ok: true as const,
        status: 202,
        message: "Cancellation needs staff attention; do not submit it again.",
        cancellationState: "action_required",
        refundEligible,
        refundState: refundEligible ? "waiting_for_cancellation" : "not_applicable",
      };
    }
  }
  const now = nowIso();
  await runStatements(env, [
    env.DB!.prepare(`UPDATE ${tables.emailOutbox}
      SET status = 'cancelled', locked_at = NULL, last_error_code = 'booking_cancelled', updated_at = ?
      WHERE id IN (
        SELECT outbox_id FROM ${tables.followUps}
        WHERE booking_id = ? AND status = 'queued' AND outbox_id IS NOT NULL
      ) AND status IN ('pending', 'retry')`).bind(now, bookingId),
    env.DB!.prepare(`UPDATE ${tables.followUps}
      SET status = 'cancelled', updated_at = ?
      WHERE booking_id = ? AND status IN ('pending', 'queued')`).bind(now, bookingId),
    env.DB!.prepare(`UPDATE ${tables.bookings}
      SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ?,
        scheduling_error = NULL, updated_at = ? WHERE id = ?`)
      .bind(now, safeString(reason).slice(0, 500) || null, now, bookingId),
    env.DB!.prepare(`DELETE FROM ${tables.bookingHolds} WHERE booking_id = ?`).bind(bookingId),
    env.DB!.prepare(`UPDATE ${tables.giftRedemptions}
      SET status = 'released', released_at = ?
      WHERE booking_id = ? AND status IN ('reserved', 'applied')`).bind(now, bookingId),
    env.DB!.prepare(`INSERT INTO ${tables.bookingEvents}
      (id, booking_id, event_type, actor_type, metadata_json, created_at)
      VALUES (?, ?, 'booking.cancelled', 'customer', ?, ?)`)
      .bind(secureId("vbe"), bookingId, JSON.stringify({ refundEligible, paid }), now),
  ]);
  let refundState = refundEligible ? "processing" : paid ? "deposit_retained" : "not_applicable";
  let refundId = "";
  if (refundEligible) {
    const refund = await createStripeRefund({
      env,
      bookingId,
      amountCents: Number(booking.paid_cents),
      reason: "Customer cancelled at least 72 hours before the sitting.",
    });
    if (refund.ok) {
      refundId = safeString(refund.refundId);
    } else {
      refundState = "action_required";
      const failureAt = nowIso();
      await runStatements(env, [
        env.DB!.prepare(`UPDATE ${tables.bookings}
          SET status = 'payment_action_required', scheduling_error = ?, updated_at = ? WHERE id = ?`)
          .bind("Eligible cancellation refund requires staff action.", failureAt, bookingId),
        env.DB!.prepare(`INSERT INTO ${tables.bookingEvents}
          (id, booking_id, event_type, actor_type, metadata_json, created_at)
          VALUES (?, ?, 'cancellation.refund_action_required', 'system', ?, ?)`)
          .bind(secureId("vbe"), bookingId, JSON.stringify({ reason: safeString(refund.message) }), failureAt),
      ]);
    }
  }
  if (!paid) {
    return {
      ok: true as const,
      status: 200,
      message: "Unpaid hold released.",
      cancellationState: "hold_released",
      refundEligible: false,
      refundState: "not_applicable",
    };
  }
  const accountUrl = bookingAccountUrl(env);
  if (accountUrl) {
    const service = await first(env, `SELECT name FROM ${tables.services} WHERE slug = ?`, [safeString(booking.service_slug)]);
    await enqueueVeraEmail({
      env,
      eventType: "vera.booking.cancelled",
      templateKey: "vera_booking_cancelled_en",
      recipientEmail: safeString(booking.email),
      recipientName: safeString(booking.customer_name),
      payload: {
        customerName: safeString(booking.customer_name),
        bookingNumber: safeString(booking.booking_number),
        serviceName: safeString(service?.name),
        accountUrl,
      },
      idempotencyKey: `booking-cancelled:${bookingId}`,
    }).catch(() => undefined);
  }
  return {
    ok: true as const,
    status: refundState === "action_required" ? 202 : 200,
    message: refundState === "processing"
      ? "Booking cancelled. Your full eligible payment refund is processing."
      : refundState === "action_required"
        ? "Booking cancelled. The eligible refund needs staff attention."
        : "Booking cancelled after the free-refund window; the deposit is retained.",
    cancellationState: refundState === "action_required" ? "action_required" : "cancelled",
    refundEligible,
    refundState,
    refundId,
  };
};
