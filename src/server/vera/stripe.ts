import { recordVeraPaymentAnalytics } from "./analytics.ts";
import { markLeadConvertedBySourceReference } from "../aggregator/lead-records.ts";
import { resolveSecretBinding } from "../aggregator/runtime-bindings.ts";
import { quoteBookingPayment, type VeraPaymentKind } from "./catalog.ts";
import { schedulePaidVeraBooking } from "./calendly.ts";
import { expireStaleVeraBookings } from "./bookings.ts";
import {
  all,
  changeCount,
  fetchForEnv,
  first,
  hmacSha256Hex,
  nowIso,
  parseObject,
  randomToken,
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

const paymentIntentPattern = /^pi_[A-Za-z0-9_]+$/;
const refundPattern = /^re_[A-Za-z0-9_]+$/;
const paymentPreparationHoldMs = 60 * 60_000;
const stripeProviderTimeoutMs = 8_000;

const stripeSecret = (env: VeraEnv) => resolveSecretBinding(env, "STRIPE_SECRET_KEY");
const stripePublishable = async (env: VeraEnv) => {
  const configured = await first(env, `SELECT value FROM ap_runtime_config
    WHERE key = 'STRIPE_PUBLISHABLE_KEY' AND status = 'active'`);
  return safeString(configured?.value) || safeString(env.PUBLIC_STRIPE_PUBLISHABLE_KEY);
};

const stripeStatus = (value: unknown) => {
  const status = safeString(value);
  if (["requires_payment_method", "requires_action", "processing", "succeeded", "canceled", "cancelled"].includes(status)) {
    return status === "canceled" ? "cancelled" : status;
  }
  return "requires_payment_method";
};

const providerError = (status: number, payload: Record<string, unknown>) => {
  const error = parseObject(payload.error);
  const code = safeString(error.code) || safeString(error.type) || `http_${status}`;
  return { message: "Stripe could not prepare this payment.", code: code.slice(0, 120) };
};

// Hosted Stripe Checkout, the way the base template takes payment: the session
// is created with the secret key alone and the reader is sent to Stripe's own
// page, so no publishable key ever has to reach the browser.
export const createVeraCheckoutSession = async ({
  env,
  bookingId,
  amountCents,
  currency,
  productName,
  successUrl,
  cancelUrl,
  customerEmail,
  idempotencyKey,
  attemptId,
}: {
  env: VeraEnv;
  bookingId: string;
  amountCents: number;
  currency: string;
  productName: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  idempotencyKey: string;
  attemptId: string;
}) => {
  const body = new URLSearchParams({
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(amountCents),
    "line_items[0][price_data][product_data][name]": productName,
    "metadata[booking_id]": bookingId,
    "metadata[attempt_id]": attemptId,
    "payment_intent_data[metadata][booking_id]": bookingId,
    "payment_intent_data[metadata][attempt_id]": attemptId,
  });
  if (customerEmail) body.set("customer_email", customerEmail);
  const result = await stripeRequest({
    env,
    path: "/v1/checkout/sessions",
    idempotencyKey,
    body,
  });
  if (!result.ok) return result;
  const session = result.payload;
  const url = safeString(session.url);
  const id = safeString(session.id);
  if (!url || !id) {
    return { ok: false as const, status: 502, message: "Stripe returned an invalid checkout session.", missingSecretNames: [] };
  }
  return {
    ok: true as const,
    status: 200,
    message: "Stripe checkout session is ready.",
    checkout: { sessionId: id, url, amountCents, currency },
  };
};

const stripeRequest = async ({
  env,
  path,
  method = "POST",
  body,
  idempotencyKey,
}: {
  env: VeraEnv;
  path: string;
  method?: "GET" | "POST";
  body?: URLSearchParams;
  idempotencyKey?: string;
}) => {
  const secret = await stripeSecret(env);
  if (!secret) {
    return {
      ok: false as const,
      status: 503,
      payload: {},
      message: "Stripe is not configured.",
      code: "provider_not_configured",
      missingSecretNames: ["STRIPE_SECRET_KEY"],
    };
  }
  let response: Response;
  try {
    response = await fetchForEnv(env)(`https://api.stripe.com${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${secret}`,
        ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body,
      signal: AbortSignal.timeout(stripeProviderTimeoutMs),
    });
  } catch {
    return {
      ok: false as const,
      status: 502,
      payload: {},
      message: "Stripe is temporarily unavailable.",
      code: "provider_unavailable",
      missingSecretNames: [] as string[],
    };
  }
  const payload = parseObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    const error = providerError(response.status, payload);
    return { ok: false as const, status: response.status, payload, ...error, missingSecretNames: [] as string[] };
  }
  return { ok: true as const, status: response.status, payload, missingSecretNames: [] as string[] };
};

const retrievePaymentIntent = async (env: VeraEnv, paymentIntentId: string) =>
  stripeRequest({
    env,
    path: `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
    method: "GET",
  });

// Hosted checkout for a booking: same access guard and amount quote as the
// inline intent path, but the reader is handed a Stripe-hosted page instead of
// card fields, so no publishable key is needed.
export const createStripeCheckoutForBooking = async ({
  env,
  request,
  bookingId,
  manageToken,
  kind,
  origin,
}: {
  env: VeraEnv;
  request: Request;
  bookingId: string;
  manageToken: string;
  kind: VeraPaymentKind;
  origin: string;
}) => {
  const [secret, webhookSecret] = await Promise.all([
    stripeSecret(env),
    resolveSecretBinding(env, "STRIPE_WEBHOOK_SECRET"),
  ]);
  const missingSecretNames = [
    ...(secret ? [] : ["STRIPE_SECRET_KEY"]),
    ...(webhookSecret ? [] : ["STRIPE_WEBHOOK_SECRET"]),
  ];
  if (missingSecretNames.length > 0) {
    return {
      ok: false as const,
      status: 503,
      message: "Stripe checkout and its signed webhook must be configured before payment can open.",
      missingSecretNames,
    };
  }
  await expireStaleVeraBookings(env);
  const access = await getVeraBookingAccess({ env, request, bookingId, manageToken, requireCsrf: true });
  if (!access.ok) return access;
  const booking = access.booking;
  if (!(["deposit", "full", "balance"] as string[]).includes(kind)) {
    return { ok: false as const, status: 400, message: "Payment kind is invalid." };
  }
  const amountCents = quoteBookingPayment({
    paymentState: safeString(booking.payment_state),
    balanceCents: Number(booking.balance_cents),
    kind,
  });
  if (amountCents < 50) {
    return { ok: false as const, status: 409, message: "No eligible Stripe balance remains for this payment kind." };
  }
  // The attempt row is what the webhook matches on, exactly as the base template
  // does: without it a completed checkout has nothing local to mark paid.
  const idempotencyKey = `vera-checkout:${bookingId}:${kind}:${amountCents}`;
  const existingAttempt = await first(env, `SELECT * FROM ${tables.paymentAttempts}
    WHERE idempotency_key = ?`, [idempotencyKey]);
  const attemptId = safeString(existingAttempt?.id) || secureId("vpay");
  const attemptNow = nowIso();
  if (!existingAttempt) {
    await run(env, `INSERT INTO ${tables.paymentAttempts}
      (id, booking_id, kind, provider, provider_payment_intent_id, idempotency_key,
       amount_cents, currency, status, last_error_code, created_at, updated_at)
      VALUES (?, ?, ?, 'stripe', NULL, ?, ?, ?, 'creating', NULL, ?, ?)`, [
      attemptId, bookingId, kind, idempotencyKey, amountCents,
      safeString(booking.currency).toUpperCase(), attemptNow, attemptNow,
    ]);
  }

  const session = await createVeraCheckoutSession({
    env,
    bookingId,
    amountCents,
    currency: safeString(booking.currency) || "USD",
    productName: safeString(booking.service_name) || "Vera Solaro sitting",
    successUrl: `${origin}/booking/${encodeURIComponent(bookingId)}/confirmation?token=${encodeURIComponent(manageToken)}&payment=processing`,
    cancelUrl: `${origin}/booking/${encodeURIComponent(bookingId)}/confirmation?token=${encodeURIComponent(manageToken)}&payment=cancelled`,
    customerEmail: safeString(booking.email) || undefined,
    idempotencyKey,
    attemptId,
  });
  if (!session.ok) {
    await run(env, `UPDATE ${tables.paymentAttempts}
      SET status = 'failed', last_error_code = 'checkout_session_failed', updated_at = ?
      WHERE id = ?`, [nowIso(), attemptId]).catch(() => undefined);
    return session;
  }
  await run(env, `UPDATE ${tables.paymentAttempts}
    SET status = 'processing', last_error_code = NULL, updated_at = ?
    WHERE id = ? AND status = 'creating'`, [nowIso(), attemptId]);
  return session;
};

export const createStripePaymentIntent = async ({
  env,
  request,
  bookingId,
  manageToken,
  kind,
}: {
  env: VeraEnv;
  request: Request;
  bookingId: string;
  manageToken: string;
  kind: VeraPaymentKind;
}) => {
  const publishableKey = await stripePublishable(env);
  const secret = await stripeSecret(env);
  const missing = [
    secret ? "" : "STRIPE_SECRET_KEY",
    publishableKey ? "" : "STRIPE_PUBLISHABLE_KEY",
  ].filter(Boolean);
  if (missing.length) {
    return { ok: false as const, status: 503, message: "Stripe is not configured.", missingSecretNames: missing };
  }
  await expireStaleVeraBookings(env);
  const access = await getVeraBookingAccess({ env, request, bookingId, manageToken, requireCsrf: true });
  if (!access.ok) return access;
  const booking = access.booking;
  if (!(["deposit", "full", "balance"] as string[]).includes(kind)) {
    return { ok: false as const, status: 400, message: "Payment kind is invalid." };
  }
  const bookingStatus = safeString(booking.status);
  if (kind === "balance") {
    if (
      !access.accountAccess ||
      request.headers.get("x-csrf-token") !== safeString(access.session?.csrfToken)
    ) {
      return { ok: false as const, status: 403, message: "An authenticated account and security token are required for balance payment." };
    }
    if (
      !["confirmed", "completed"].includes(bookingStatus) ||
      safeString(booking.cancelled_at) ||
      ["partially_refunded", "refunded"].includes(safeString(booking.payment_state))
    ) {
      return { ok: false as const, status: 409, message: "A cancelled or refunded booking cannot accept a balance payment." };
    }
    const activeRefund = await first(env, `SELECT id FROM ${tables.refunds}
      WHERE booking_id = ? AND status IN ('pending', 'succeeded') LIMIT 1`, [bookingId]);
    if (activeRefund) {
      return { ok: false as const, status: 409, message: "A booking with an active refund cannot accept a balance payment." };
    }
  }
  const eligibleCompletedBalance = Boolean(
    kind === "balance" && bookingStatus === "completed" && Number(booking.balance_cents) > 0 &&
    !safeString(booking.cancelled_at) && !["partially_refunded", "refunded"].includes(safeString(booking.payment_state)),
  );
  if (["cancelled", "expired", "completed", "refunded"].includes(bookingStatus) && !eligibleCompletedBalance) {
    return { ok: false as const, status: 409, message: "This booking cannot accept another payment." };
  }
  if (
    safeString(booking.payment_state) === "unpaid" &&
    kind !== safeString(booking.payment_option)
  ) {
    return { ok: false as const, status: 409, message: "Payment kind must match the booking choice." };
  }
  const amountCents = quoteBookingPayment({
    paymentState: safeString(booking.payment_state),
    balanceCents: Number(booking.balance_cents),
    kind,
  });
  if (amountCents < 50) {
    return { ok: false as const, status: 409, message: "No eligible Stripe balance remains for this payment kind." };
  }
  let paymentHoldExpiresAt = safeString(booking.hold_expires_at);
  if (safeString(booking.payment_state) === "unpaid") {
    if (safeString(booking.status) !== "pending_payment") {
      return { ok: false as const, status: 409, message: "This booking cannot accept another payment." };
    }
    paymentHoldExpiresAt = new Date(Date.now() + paymentPreparationHoldMs).toISOString();
    const holdResults = await runStatements(env, [
      env.DB!.prepare(`UPDATE ${tables.bookings}
        SET hold_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending_payment' AND payment_state = 'unpaid'`)
        .bind(paymentHoldExpiresAt, nowIso(), bookingId),
      env.DB!.prepare(`UPDATE ${tables.bookingHolds}
        SET expires_at = ? WHERE booking_id = ? AND EXISTS (
          SELECT 1 FROM ${tables.bookings}
          WHERE id = ? AND status = 'pending_payment' AND payment_state = 'unpaid'
            AND hold_expires_at = ?
        )`)
        .bind(paymentHoldExpiresAt, bookingId, bookingId, paymentHoldExpiresAt),
    ]);
    if (changeCount(holdResults[0]) !== 1) {
      return { ok: false as const, status: 409, message: "This booking can no longer accept a payment." };
    }
  }
  const idempotencyKey = `vera-payment:${bookingId}:${kind}:${Number(booking.paid_cents)}:${Number(booking.balance_cents)}`;
  let attempt = await first(env, `SELECT * FROM ${tables.paymentAttempts}
    WHERE idempotency_key = ?`, [idempotencyKey]);
  const attemptId = safeString(attempt?.id) || secureId("vpay");
  const now = nowIso();
  if (!attempt) {
    await run(env, `INSERT INTO ${tables.paymentAttempts}
      (id, booking_id, kind, provider, provider_payment_intent_id, idempotency_key,
       amount_cents, currency, status, last_error_code, created_at, updated_at)
      VALUES (?, ?, ?, 'stripe', NULL, ?, ?, ?, 'creating', NULL, ?, ?)`, [
      attemptId, bookingId, kind, idempotencyKey, amountCents,
      safeString(booking.currency).toUpperCase(), now, now,
    ]);
  }
  const existingIntentId = safeString(attempt?.provider_payment_intent_id);
  const result = existingIntentId && paymentIntentPattern.test(existingIntentId)
    ? await retrievePaymentIntent(env, existingIntentId)
    : await stripeRequest({
      env,
      path: "/v1/payment_intents",
      idempotencyKey,
      body: new URLSearchParams({
        amount: String(amountCents),
        currency: safeString(booking.currency).toLowerCase(),
        "automatic_payment_methods[enabled]": "true",
        "automatic_payment_methods[allow_redirects]": "never",
        "metadata[booking_id]": bookingId,
        "metadata[attempt_id]": attemptId,
        "metadata[payment_kind]": kind,
      }),
    });
  if (!result.ok) {
    await run(env, `UPDATE ${tables.paymentAttempts}
      SET status = 'failed', last_error_code = ?, updated_at = ? WHERE id = ?`, [
      result.code, nowIso(), attemptId,
    ]);
    return result;
  }
  const intent = result.payload;
  const intentId = safeString(intent.id);
  const clientSecret = safeString(intent.client_secret);
  if (
    !paymentIntentPattern.test(intentId) || !clientSecret ||
    Number(intent.amount) !== amountCents ||
    safeString(intent.currency).toUpperCase() !== safeString(booking.currency).toUpperCase()
  ) {
    await run(env, `UPDATE ${tables.paymentAttempts}
      SET status = 'failed', last_error_code = 'provider_contract_mismatch', updated_at = ? WHERE id = ?`, [nowIso(), attemptId]);
    return { ok: false as const, status: 502, message: "Stripe returned an invalid payment intent.", missingSecretNames: [] };
  }
  await run(env, `UPDATE ${tables.paymentAttempts}
    SET provider_payment_intent_id = ?, status = ?, last_error_code = NULL, updated_at = ?
    WHERE id = ?`, [intentId, stripeStatus(intent.status), nowIso(), attemptId]);
  return {
    ok: true as const,
    status: 200,
    message: "Stripe payment intent is ready.",
    payment: {
      attemptId,
      paymentIntentId: intentId,
      clientSecret,
      publishableKey,
      amountCents,
      currency: safeString(booking.currency),
      kind,
      holdExpiresAt: paymentHoldExpiresAt,
    },
  };
};

export const verifyStripeSignature = async ({
  body,
  signatureHeader,
  signingSecret,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  body: string;
  signatureHeader: string;
  signingSecret: string;
  nowSeconds?: number;
}) => {
  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = Number(parts.find((part) => part.startsWith("t="))?.slice(2));
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > 300 || signatures.length === 0) return false;
  const expected = await hmacSha256Hex(signingSecret, `${timestamp}.${body}`);
  return signatures.some((signature) => timingSafeHexEqual(expected, signature));
};

const recordNonSuccessPaymentEvent = async ({
  env,
  eventId,
  eventType,
  paymentIntentId,
  attempt,
  payloadHash,
  attemptStatus,
  errorCode,
}: {
  env: VeraEnv;
  eventId: string;
  eventType: string;
  paymentIntentId: string;
  attempt: VeraRow;
  payloadHash: string;
  attemptStatus: string;
  errorCode?: string;
}) => {
  const now = nowIso();
  await runStatements(env, [
    env.DB!.prepare(`INSERT INTO ${tables.paymentEvents}
      (id, provider_event_id, provider_payment_intent_id, booking_id, event_type, payload_hash, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(secureId("vpe"), eventId, paymentIntentId, safeString(attempt.booking_id), eventType, payloadHash, now),
    env.DB!.prepare(`UPDATE ${tables.paymentAttempts}
      SET status = ?, last_error_code = ?, updated_at = ? WHERE id = ? AND status != 'succeeded'`)
      .bind(attemptStatus, errorCode || null, now, safeString(attempt.id)),
  ]);
};

const processPaymentSucceeded = async ({
  env,
  eventId,
  eventType,
  intent,
  attempt,
  payloadHash,
}: {
  env: VeraEnv;
  eventId: string;
  eventType: string;
  intent: VeraRow;
  attempt: VeraRow;
  payloadHash: string;
}) => {
  const amount = Number(intent.amount_received || intent.amount);
  const expectedAmount = Number(attempt.amount_cents);
  const currency = safeString(intent.currency).toUpperCase();
  if (amount !== expectedAmount || currency !== safeString(attempt.currency).toUpperCase()) {
    return { ok: false as const, status: 409, message: "Stripe payment amount did not match the authoritative attempt." };
  }
  const bookingId = safeString(attempt.booking_id);
  const booking = await first(env, `SELECT * FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
  if (!booking) return { ok: true as const, status: 200, message: "Unknown booking payment ignored." };
  // A late payment cannot reacquire an expired slot held by another visitor.
  // Record it through the existing terminal-payment refund recovery below.
  if (booking.payment_state === "unpaid" && booking.hold_expires_at && Date.parse(safeString(booking.hold_expires_at)) <= Date.now()) {
    const expired = await run(env, `UPDATE ${tables.bookings} SET status = 'expired' WHERE id = ? AND status IN ('pending_payment', 'payment_action_required') AND payment_state = 'unpaid'`, [bookingId]);
    if (changeCount(expired) === 1) booking.status = "expired";
  }
  const now = nowIso();
  const invoiceNumber = `VSI-${randomToken(6).toUpperCase()}`;
  const paymentIntentId = safeString(intent.id);
  const wasTerminal = ["cancelled", "expired", "completed", "refunded"].includes(safeString(booking.status));
  const paymentResults = await runStatements(env, [
    env.DB!.prepare(`UPDATE ${tables.bookings}
      SET paid_cents = MIN(total_due_cents, paid_cents + ?),
        balance_cents = MAX(0, total_due_cents - MIN(total_due_cents, paid_cents + ?)),
        payment_state = CASE
          WHEN total_due_cents - MIN(total_due_cents, paid_cents + ?) = 0 THEN 'paid'
          ELSE 'deposit_paid'
        END,
        hold_expires_at = NULL, updated_at = ?
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM ${tables.paymentAttempts}
        WHERE id = ? AND status != 'succeeded'
      )`).bind(amount, amount, amount, now, bookingId, safeString(attempt.id)),
    env.DB!.prepare(`UPDATE ${tables.paymentAttempts}
      SET status = 'succeeded', last_error_code = NULL, updated_at = ?
      WHERE id = ?`).bind(now, safeString(attempt.id)),
    env.DB!.prepare(`INSERT INTO ${tables.paymentEvents}
      (id, provider_event_id, provider_payment_intent_id, booking_id, event_type, payload_hash, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(secureId("vpe"), eventId, paymentIntentId, bookingId, eventType, payloadHash, now),
    env.DB!.prepare(`UPDATE ${tables.bookingHolds}
      SET expires_at = NULL WHERE booking_id = ?`).bind(bookingId),
    env.DB!.prepare(`UPDATE ${tables.giftRedemptions}
      SET status = 'applied', applied_at = ? WHERE booking_id = ? AND status = 'reserved'`).bind(now, bookingId),
    env.DB!.prepare(`INSERT INTO ${tables.invoices}
      (id, booking_id, payment_attempt_id, invoice_number, status, amount_cents,
       currency, provider_payment_intent_id, issued_at, updated_at)
      VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?)
      ON CONFLICT(payment_attempt_id) DO NOTHING`)
      .bind(secureId("vinvoice"), bookingId, safeString(attempt.id), invoiceNumber, amount, currency, paymentIntentId, now, now),
    env.DB!.prepare(`INSERT INTO ${tables.bookingEvents}
      (id, booking_id, event_type, actor_type, metadata_json, created_at)
      VALUES (?, ?, 'payment.succeeded', 'provider', ?, ?)`)
      .bind(secureId("vbe"), bookingId, JSON.stringify({ attemptId: safeString(attempt.id), kind: safeString(attempt.kind), amountCents: amount }), now),
  ]);
  const paymentApplied = changeCount(paymentResults[0]) === 1;
  if (paymentApplied) {
    await markLeadConvertedBySourceReference({
      env,
      sourceReferenceType: "vera_booking",
      sourceReferenceId: bookingId,
      conversionReference: paymentIntentId,
    });
  }
  const afterPayment = await first(env, `SELECT status, cancelled_at, selected_start_at
    FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
  const terminalStatus = safeString(afterPayment?.status);
  if (paymentApplied && ["cancelled", "expired", "refunded"].includes(terminalStatus)) {
    const recovery = await createStripeRefund({
      env,
      bookingId,
      paymentAttemptId: safeString(attempt.id),
      amountCents: amount,
      reason: `automatic_late_payment_recovery:${terminalStatus}`,
    }).catch(() => ({
      ok: false as const,
      status: 502,
      message: "Automatic late-payment refund failed.",
      missingSecretNames: [] as string[],
    }));
    const recoveryEventType = recovery.ok
      ? "payment.late_terminal_refund_submitted"
      : "payment.late_terminal_action_required";
    const recoveryAuditId = `vbe_late_${(await sha256Hex(`${bookingId}\n${eventId}`)).slice(0, 40)}`;
    await run(env, `INSERT INTO ${tables.bookingEvents}
      (id, booking_id, event_type, actor_type, metadata_json, created_at)
      VALUES (?, ?, ?, 'system', ?, ?) ON CONFLICT(id) DO NOTHING`, [
      recoveryAuditId,
      bookingId,
      recoveryEventType,
      JSON.stringify({
        terminalStatus,
        providerPaymentIntentId: paymentIntentId,
        recoveryStatus: recovery.ok ? "refund_submitted" : "staff_action_required",
        refundId: "refundId" in recovery ? safeString(recovery.refundId) : "",
        providerRefundId: "providerRefundId" in recovery ? safeString(recovery.providerRefundId) : "",
      }),
      nowIso(),
    ]);
    return {
      ok: true as const,
      status: 200,
      message: recovery.ok
        ? "Late terminal payment recorded and submitted for refund."
        : "Late terminal payment recorded for staff refund action.",
    };
  }
  if (paymentApplied) await recordVeraPaymentAnalytics(env, booking, attempt);
  const canSchedule = Boolean(
    paymentApplied && !wasTerminal && ["pending_payment", "payment_action_required"].includes(terminalStatus) &&
    !safeString(afterPayment?.cancelled_at) &&
    new Date(safeString(afterPayment?.selected_start_at)).getTime() > Date.now(),
  );
  if (canSchedule) {
    const scheduled = await schedulePaidVeraBooking(env, bookingId);
    if (scheduled.ok) {
      const current = await first(env, `SELECT booking.*, service.name AS service_name
        FROM ${tables.bookings} booking JOIN ${tables.services} service
          ON service.slug = booking.service_slug WHERE booking.id = ?`, [bookingId]);
      if (current) {
        const origin = safeString(env.ASTROPAGES_SITE_URL) || safeString(env.SITE_ORIGIN) || safeString(env.SITE_URL);
        let confirmationUrl = "";
        try {
          confirmationUrl = new URL(`/booking/${encodeURIComponent(bookingId)}/confirmation`, origin).toString();
        } catch {
          confirmationUrl = "";
        }
        if (confirmationUrl) {
          await enqueueVeraEmail({
            env,
            eventType: "vera.booking.confirmed",
            templateKey: "vera_booking_confirmed_en",
            recipientEmail: safeString(current.email),
            recipientName: safeString(current.customer_name),
            payload: {
              customerName: safeString(current.customer_name),
              bookingNumber: safeString(current.booking_number),
              serviceName: safeString(current.service_name),
              scheduledDateTime: safeString(current.selected_start_at),
              confirmationUrl,
            },
            idempotencyKey: `booking-confirmed:${bookingId}`,
          }).catch(() => undefined);
        }
      }
    }
  }
  return {
    ok: true as const,
    status: 200,
    message: wasTerminal ? "Payment recorded without reopening the completed or terminal booking." : "Stripe payment processed.",
  };
};

const applySucceededRefundState = async (
  env: VeraEnv,
  bookingId: string,
  updatedAt = nowIso(),
) => {
  const totals = await first(env, `SELECT
    COALESCE(SUM(refund.amount_cents), 0) AS refunded_cents,
    booking.paid_cents AS paid_cents
    FROM ${tables.bookings} booking
    LEFT JOIN ${tables.refunds} refund
      ON refund.booking_id = booking.id AND refund.status = 'succeeded'
    WHERE booking.id = ? GROUP BY booking.id`, [bookingId]);
  const fullyRefunded = Number(totals?.refunded_cents) >= Number(totals?.paid_cents);
  await runStatements(env, [
    env.DB!.prepare(`UPDATE ${tables.bookings}
      SET payment_state = ?, status = CASE WHEN ? = 1 THEN 'refunded' ELSE status END,
        updated_at = ? WHERE id = ?`)
      .bind(fullyRefunded ? "refunded" : "partially_refunded", fullyRefunded ? 1 : 0, updatedAt, bookingId),
    env.DB!.prepare(`UPDATE ${tables.invoices}
      SET status = ?, updated_at = ? WHERE booking_id = ?`)
      .bind(fullyRefunded ? "refunded" : "partially_refunded", updatedAt, bookingId),
  ]);
};

const processRefundEvent = async ({
  env,
  eventId,
  eventType,
  refund,
  payloadHash,
}: {
  env: VeraEnv;
  eventId: string;
  eventType: string;
  refund: VeraRow;
  payloadHash: string;
}) => {
  const providerRefundId = safeString(refund.id);
  if (!refundPattern.test(providerRefundId)) {
    return { ok: false as const, status: 400, message: "Stripe refund reference is invalid." };
  }
  const metadata = parseObject(refund.metadata);
  const metadataRefundId = safeString(metadata.refund_id);
  let record = await first(env, `SELECT * FROM ${tables.refunds}
    WHERE provider_refund_id = ?`, [providerRefundId]);
  if (!record && metadataRefundId) {
    record = await first(env, `SELECT * FROM ${tables.refunds}
      WHERE id = ? AND (provider_refund_id IS NULL OR provider_refund_id = ?)`, [metadataRefundId, providerRefundId]);
  }
  if (!record) return { ok: true as const, status: 200, message: "Unknown refund ignored." };
  const attempt = await first(env, `SELECT provider_payment_intent_id FROM ${tables.paymentAttempts}
    WHERE id = ? AND booking_id = ?`, [safeString(record.payment_attempt_id), safeString(record.booking_id)]);
  const webhookPaymentIntentId = safeString(refund.payment_intent);
  if (
    !attempt ||
    (webhookPaymentIntentId && webhookPaymentIntentId !== safeString(attempt.provider_payment_intent_id)) ||
    (safeString(metadata.booking_id) && safeString(metadata.booking_id) !== safeString(record.booking_id)) ||
    (metadataRefundId && metadataRefundId !== safeString(record.id))
  ) {
    return { ok: false as const, status: 409, message: "Stripe refund ownership did not match the authoritative refund." };
  }
  if (
    Number(refund.amount) !== Number(record.amount_cents) ||
    (safeString(refund.currency) && safeString(refund.currency).toUpperCase() !== safeString(record.currency).toUpperCase())
  ) {
    return { ok: false as const, status: 409, message: "Stripe refund amount did not match the authoritative refund." };
  }
  const providerStatus = safeString(refund.status);
  const status = providerStatus === "succeeded"
    ? "succeeded"
    : providerStatus === "failed"
      ? "failed"
      : providerStatus === "canceled"
        ? "cancelled"
        : "pending";
  const requiresAction = providerStatus === "requires_action";
  const now = nowIso();
  await runStatements(env, [
    env.DB!.prepare(`INSERT INTO ${tables.paymentEvents}
      (id, provider_event_id, provider_payment_intent_id, booking_id, event_type, payload_hash, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        secureId("vpe"), eventId, webhookPaymentIntentId,
        safeString(record.booking_id), eventType, payloadHash, now,
      ),
    env.DB!.prepare(`UPDATE ${tables.refunds}
      SET provider_refund_id = COALESCE(provider_refund_id, ?), status = CASE
        WHEN status = 'succeeded' THEN 'succeeded'
        WHEN status IN ('failed', 'cancelled') AND ? != 'succeeded' THEN status
        ELSE ?
      END, updated_at = ? WHERE id = ?`)
      .bind(providerRefundId, status, status, now, safeString(record.id)),
    ...(requiresAction ? [env.DB!.prepare(`INSERT INTO ${tables.bookingEvents}
      (id, booking_id, event_type, actor_type, metadata_json, created_at)
      VALUES (?, ?, 'refund.action_required', 'provider', ?, ?)
      ON CONFLICT(id) DO NOTHING`).bind(
      `vbe_refund_${(await sha256Hex(eventId)).slice(0, 40)}`,
      safeString(record.booking_id),
      JSON.stringify({ providerRefundId, refundId: safeString(record.id) }),
      now,
    )] : []),
  ]);
  if (status === "succeeded") {
    await applySucceededRefundState(env, safeString(record.booking_id), now);
  }
  return { ok: true as const, status: 200, message: "Stripe refund processed." };
};

export const processStripeWebhook = async ({
  env,
  body,
  signatureHeader,
}: {
  env: VeraEnv;
  body: string;
  signatureHeader: string;
}) => {
  if (!env.DB?.batch) return { ok: false as const, status: 503, message: "Atomic payment storage is not ready.", missingSecretNames: [] };
  const signingSecret = await resolveSecretBinding(env, "STRIPE_WEBHOOK_SECRET");
  if (!signingSecret) {
    return { ok: false as const, status: 503, message: "Stripe webhook signing is not configured.", missingSecretNames: ["STRIPE_WEBHOOK_SECRET"] };
  }
  if (!await verifyStripeSignature({ body, signatureHeader, signingSecret })) {
    return { ok: false as const, status: 403, message: "Invalid Stripe webhook signature.", missingSecretNames: [] };
  }
  let event: VeraRow;
  try {
    event = JSON.parse(body) as VeraRow;
  } catch {
    return { ok: false as const, status: 400, message: "Stripe webhook payload is invalid.", missingSecretNames: [] };
  }
  const eventId = safeString(event.id);
  const eventType = safeString(event.type);
  if (!eventId || !eventType) return { ok: false as const, status: 400, message: "Stripe webhook event is invalid.", missingSecretNames: [] };
  if (await first(env, `SELECT id FROM ${tables.paymentEvents} WHERE provider_event_id = ?`, [eventId])) {
    return { ok: true as const, status: 200, message: "Stripe event already processed.", missingSecretNames: [] };
  }
  const data = parseObject(event.data);
  const object = parseObject(data.object);
  const payloadHash = await sha256Hex(body);
  if (["refund.created", "refund.updated", "refund.failed"].includes(eventType)) {
    return { ...(await processRefundEvent({ env, eventId, eventType, refund: object, payloadHash })), missingSecretNames: [] };
  }
  // Match the Single Western checkout contract: the signed Checkout Session is
  // authoritative, so payment does not depend on PaymentIntent webhook ordering.
  if (eventType.startsWith("checkout.session.")) {
    const sessionAttemptId = safeString(parseObject(object.metadata).attempt_id);
    const sessionIntentId = safeString(object.payment_intent);
    if (sessionAttemptId && paymentIntentPattern.test(sessionIntentId)) {
      await run(env, `UPDATE ${tables.paymentAttempts}
        SET provider_payment_intent_id = ?, updated_at = ?
        WHERE id = ? AND (provider_payment_intent_id IS NULL OR provider_payment_intent_id = ?)`, [
        sessionIntentId, nowIso(), sessionAttemptId, sessionIntentId,
      ]);
    }
    const attempt = sessionAttemptId
      ? await first(env, `SELECT * FROM ${tables.paymentAttempts} WHERE id = ?`, [sessionAttemptId])
      : null;
    const paidSession = ["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(eventType) &&
      safeString(object.payment_status) === "paid";
    const sessionMatchesAttempt = Boolean(
      attempt &&
      safeString(attempt.booking_id) === safeString(parseObject(object.metadata).booking_id) &&
      Number(attempt.amount_cents) === Number(object.amount_total) &&
      safeString(attempt.currency).toUpperCase() === safeString(object.currency).toUpperCase(),
    );
    if (paidSession && attempt && sessionMatchesAttempt && paymentIntentPattern.test(sessionIntentId)) {
      const intent = {
        id: sessionIntentId,
        status: "succeeded",
        amount_received: Number(object.amount_total),
        currency: safeString(object.currency),
      };
        return {
          ...(await processPaymentSucceeded({ env, eventId, eventType, intent, attempt, payloadHash })),
          missingSecretNames: [],
        };
    }
    if (
      ["checkout.session.expired", "checkout.session.async_payment_failed"].includes(eventType) &&
      attempt
    ) {
      await recordNonSuccessPaymentEvent({
        env,
        eventId,
        eventType,
        paymentIntentId: sessionIntentId,
        attempt,
        payloadHash,
        attemptStatus: "failed",
        errorCode: eventType === "checkout.session.expired"
          ? "checkout_session_expired"
          : "checkout_session_async_payment_failed",
      });
    }
    return { ok: true as const, status: 200, message: "Stripe checkout session recorded.", missingSecretNames: [] };
  }
  if (!["payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.processing", "payment_intent.canceled"].includes(eventType)) {
    return { ok: true as const, status: 200, message: "Stripe event ignored.", missingSecretNames: [] };
  }
  const paymentIntentId = safeString(object.id);
  if (!paymentIntentPattern.test(paymentIntentId)) {
    return { ok: false as const, status: 400, message: "Stripe payment intent reference is invalid.", missingSecretNames: [] };
  }
  const attempt = await first(env, `SELECT * FROM ${tables.paymentAttempts}
    WHERE provider_payment_intent_id = ?`, [paymentIntentId]);
  if (!attempt) return { ok: true as const, status: 200, message: "Unknown Stripe payment ignored.", missingSecretNames: [] };
  if (eventType === "payment_intent.succeeded") {
    return { ...(await processPaymentSucceeded({ env, eventId, eventType, intent: object, attempt, payloadHash })), missingSecretNames: [] };
  }
  const lastError = parseObject(object.last_payment_error);
  await recordNonSuccessPaymentEvent({
    env,
    eventId,
    eventType,
    paymentIntentId,
    attempt,
    payloadHash,
    attemptStatus: eventType === "payment_intent.processing"
      ? "processing"
      : eventType === "payment_intent.canceled" ? "cancelled" : "failed",
    errorCode: safeString(lastError.code).slice(0, 120),
  });
  return { ok: true as const, status: 200, message: "Stripe payment event processed.", missingSecretNames: [] };
};

const reconcilePendingStripeRefund = async (env: VeraEnv, record: VeraRow) => {
  const refundId = safeString(record.id);
  const bookingId = safeString(record.booking_id);
  const attempt = await first(env, `SELECT provider_payment_intent_id FROM ${tables.paymentAttempts}
    WHERE id = ? AND booking_id = ? AND status = 'succeeded'`, [safeString(record.payment_attempt_id), bookingId]);
  const paymentIntentId = safeString(attempt?.provider_payment_intent_id);
  if (!paymentIntentPattern.test(paymentIntentId)) {
    return {
      ok: false as const,
      status: 409,
      message: "The pending refund no longer matches an authoritative Stripe payment.",
      missingSecretNames: [] as string[],
    };
  }
  const knownProviderRefundId = safeString(record.provider_refund_id);
  const result = knownProviderRefundId && refundPattern.test(knownProviderRefundId)
    ? await stripeRequest({
      env,
      path: `/v1/refunds/${encodeURIComponent(knownProviderRefundId)}`,
      method: "GET",
    })
    : await stripeRequest({
      env,
      path: "/v1/refunds",
      idempotencyKey: safeString(record.idempotency_key),
      body: new URLSearchParams({
        payment_intent: paymentIntentId,
        amount: String(Number(record.amount_cents)),
        reason: "requested_by_customer",
        "metadata[booking_id]": bookingId,
        "metadata[refund_id]": refundId,
      }),
    });
  if (!result.ok) {
    return {
      ...result,
      message: "Stripe refund outcome is still unknown; retry reconciliation with the same refund request.",
      refundId,
      providerRefundId: knownProviderRefundId,
      alreadyExists: true,
      reconciled: false,
    };
  }
  const payload = result.payload;
  const providerRefundId = safeString(payload.id);
  const metadata = parseObject(payload.metadata);
  if (
    !refundPattern.test(providerRefundId) ||
    (knownProviderRefundId && providerRefundId !== knownProviderRefundId) ||
    safeString(payload.payment_intent) !== paymentIntentId ||
    Number(payload.amount) !== Number(record.amount_cents) ||
    safeString(payload.currency).toUpperCase() !== safeString(record.currency).toUpperCase() ||
    safeString(metadata.booking_id) !== bookingId ||
    safeString(metadata.refund_id) !== refundId
  ) {
    return {
      ok: false as const,
      status: 409,
      message: "Stripe refund reconciliation did not match the authoritative refund.",
      refundId,
      providerRefundId: knownProviderRefundId,
      missingSecretNames: [] as string[],
      alreadyExists: true,
      reconciled: false,
    };
  }
  const providerStatus = safeString(payload.status);
  const status = providerStatus === "succeeded"
    ? "succeeded"
    : providerStatus === "failed"
      ? "failed"
      : providerStatus === "canceled"
        ? "cancelled"
        : "pending";
  const updatedAt = nowIso();
  await run(env, `UPDATE ${tables.refunds}
    SET provider_refund_id = COALESCE(provider_refund_id, ?), status = CASE
      WHEN status = 'succeeded' THEN 'succeeded'
      WHEN status IN ('failed', 'cancelled') AND ? != 'succeeded' THEN status
      ELSE ?
    END, updated_at = ? WHERE id = ?`, [providerRefundId, status, status, updatedAt, refundId]);
  if (status === "succeeded") await applySucceededRefundState(env, bookingId, updatedAt);
  if (status === "failed" || status === "cancelled") {
    return {
      ok: false as const,
      status: 409,
      message: "Stripe did not complete the pending refund; a new refund may now be submitted.",
      refundId,
      providerRefundId,
      missingSecretNames: [] as string[],
      alreadyExists: true,
      reconciled: true,
    };
  }
  return {
    ok: true as const,
    status: status === "succeeded" ? 200 : 202,
    message: status === "succeeded"
      ? "Refund reconciliation confirmed completion."
      : "Refund reconciliation confirmed that Stripe is still processing it.",
    refundId,
    providerRefundId,
    missingSecretNames: [] as string[],
    alreadyExists: true,
    reconciled: true,
  };
};

export const createStripeRefund = async ({
  env,
  bookingId,
  paymentAttemptId,
  amountCents,
  reason,
}: {
  env: VeraEnv;
  bookingId: string;
  paymentAttemptId?: string;
  amountCents?: number;
  reason: string;
}) => {
  if (!await stripeSecret(env)) {
    return { ok: false as const, status: 503, message: "Stripe is not configured.", missingSecretNames: ["STRIPE_SECRET_KEY"] };
  }
  const exactAttemptId = safeString(paymentAttemptId);
  const attempts = await all(env, `SELECT attempt.*,
      MAX(0, attempt.amount_cents - COALESCE((
        SELECT SUM(refund.amount_cents) FROM ${tables.refunds} refund
        WHERE refund.payment_attempt_id = attempt.id AND refund.status IN ('pending', 'succeeded')
      ), 0)) AS refundable_cents
    FROM ${tables.paymentAttempts} attempt
    WHERE attempt.booking_id = ? AND attempt.status = 'succeeded'
      AND (? = '' OR attempt.id = ?)
    ORDER BY attempt.created_at DESC, attempt.id DESC`, [bookingId, exactAttemptId, exactAttemptId]);
  if (attempts.length === 0) {
    return { ok: false as const, status: 404, message: "A refundable Stripe payment was not found.", missingSecretNames: [] };
  }
  const totalRefundable = attempts.reduce((sum, attempt) => sum + Number(attempt.refundable_cents), 0);
  if (totalRefundable === 0) {
    const existingRefund = await first(env, `SELECT *
      FROM ${tables.refunds}
      WHERE booking_id = ? AND (? = '' OR payment_attempt_id = ?)
        AND status IN ('pending', 'succeeded')
      ORDER BY created_at DESC LIMIT 1`, [bookingId, exactAttemptId, exactAttemptId]);
    if (!existingRefund) {
      return { ok: false as const, status: 409, message: "No refundable Stripe payment remains.", missingSecretNames: [] };
    }
    if (safeString(existingRefund.status) === "pending") {
      return reconcilePendingStripeRefund(env, existingRefund);
    }
    return {
      ok: true as const,
      status: 200,
      message: "Refund is already complete.",
      refundId: safeString(existingRefund.id),
      providerRefundId: safeString(existingRefund.provider_refund_id),
      missingSecretNames: [] as string[],
      alreadyExists: true,
    };
  }
  const requestedAmount = amountCents === undefined ? totalRefundable : Math.floor(amountCents);
  if (requestedAmount < 1 || requestedAmount > totalRefundable) {
    return { ok: false as const, status: 409, message: "Refund amount exceeds the refundable payment.", missingSecretNames: [] };
  }
  let remaining = requestedAmount;
  const submitted: Array<{ refundId: string; providerRefundId: string; amountCents: number }> = [];
  for (const attempt of attempts) {
    if (remaining === 0) break;
    const amount = Math.min(remaining, Number(attempt.refundable_cents));
    if (amount < 1) continue;
    const attemptId = safeString(attempt.id);
    const alreadyActive = Number(attempt.amount_cents) - Number(attempt.refundable_cents);
    const failures = await first(env, `SELECT COUNT(*) AS count FROM ${tables.refunds}
      WHERE payment_attempt_id = ? AND status IN ('failed', 'cancelled')`, [attemptId]);
    const idempotencyKey = `vera-refund:${attemptId}:${alreadyActive}:${amount}:try${Number(failures?.count) + 1}`;
    const refundId = secureId("vrefund");
    const now = nowIso();
    const inserted = await run(env, `INSERT INTO ${tables.refunds}
      (id, booking_id, payment_attempt_id, provider_refund_id, amount_cents,
       currency, reason, status, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING`, [
      refundId, bookingId, attemptId, amount, safeString(attempt.currency),
      safeString(reason).slice(0, 500) || "requested_by_customer", idempotencyKey, now, now,
    ]);
    if (changeCount(inserted) !== 1) {
      const existing = await first(env, `SELECT id, provider_refund_id FROM ${tables.refunds}
        WHERE idempotency_key = ?`, [idempotencyKey]);
      if (!existing) {
        return { ok: false as const, status: 409, message: "A concurrent refund changed this payment.", missingSecretNames: [], partialRefunds: submitted };
      }
      submitted.push({
        refundId: safeString(existing.id),
        providerRefundId: safeString(existing.provider_refund_id),
        amountCents: amount,
      });
      remaining -= amount;
      continue;
    }
    const result = await stripeRequest({
      env,
      path: "/v1/refunds",
      idempotencyKey,
      body: new URLSearchParams({
        payment_intent: safeString(attempt.provider_payment_intent_id),
        amount: String(amount),
        reason: "requested_by_customer",
        "metadata[booking_id]": bookingId,
        "metadata[refund_id]": refundId,
      }),
    });
    if (!result.ok) {
      const outcomeUnknown = result.code === "provider_unavailable" || result.status >= 500;
      if (!outcomeUnknown) {
        await run(env, `UPDATE ${tables.refunds}
          SET status = 'failed', updated_at = ? WHERE id = ?`, [nowIso(), refundId]);
      }
      return {
        ...result,
        ...(outcomeUnknown ? { message: "Stripe refund outcome is unknown; staff reconciliation is required before retrying." } : {}),
        partialRefunds: submitted,
      };
    }
    const providerRefundId = safeString(result.payload.id);
    if (!refundPattern.test(providerRefundId)) {
      return { ok: false as const, status: 502, message: "Stripe refund outcome requires staff reconciliation.", missingSecretNames: [], partialRefunds: submitted };
    }
    await run(env, `UPDATE ${tables.refunds}
      SET provider_refund_id = ?, updated_at = ? WHERE id = ?`, [providerRefundId, nowIso(), refundId]);
    submitted.push({ refundId, providerRefundId, amountCents: amount });
    remaining -= amount;
  }
  const primary = submitted[0];
  return {
    ok: true as const,
    status: 202,
    message: "Refund submitted; Stripe webhook confirmation is pending.",
    refundId: primary?.refundId || "",
    providerRefundId: primary?.providerRefundId || "",
    refunds: submitted,
    missingSecretNames: [],
  };
};
