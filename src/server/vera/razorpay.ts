import { getRuntimeConfigValue } from "../aggregator/runtime-config.ts";
import { resolveSecretBinding } from "../aggregator/runtime-bindings.ts";
import { quoteBookingPayment, type VeraPaymentKind } from "./catalog.ts";
import { expireStaleVeraBookings } from "./bookings.ts";
import { all, changeCount, fetchForEnv, first, hmacSha256Hex, nowIso, parseObject, run, runStatements, safeString, secureId, sha256Hex, timingSafeHexEqual } from "./db.ts";
import { getVeraBookingAccess } from "./security.ts";
import { applySucceededRefundState, processPaymentSucceeded, recordNonSuccessPaymentEvent } from "./stripe.ts";
import type { VeraEnv, VeraRow } from "./types.ts";
import { VERA_TABLES as tables } from "./types.ts";

const orderPattern = /^order_[A-Za-z0-9_]+$/;
const paymentPattern = /^pay_[A-Za-z0-9_]+$/;
const refundPattern = /^rfnd_[A-Za-z0-9_]+$/;

const keyId = (env: VeraEnv) => getRuntimeConfigValue(env, "RAZORPAY_KEY_ID");
const keySecret = (env: VeraEnv) => resolveSecretBinding(env, "RAZORPAY_KEY_SECRET");
const webhookSecret = (env: VeraEnv) => resolveSecretBinding(env, "RAZORPAY_WEBHOOK_SECRET");
const basicAuthorization = (id: string, secret: string) => ["Basic", btoa(`${id}:${secret}`)].join(" ");

export const createRazorpayCheckoutForBooking = async ({ env, request, bookingId, manageToken, kind }: {
  env: VeraEnv; request: Request; bookingId: string; manageToken: string; kind: VeraPaymentKind;
}) => {
  const [id, secret, signingSecret] = await Promise.all([keyId(env), keySecret(env), webhookSecret(env)]);
  const missingSecretNames = [id ? "" : "RAZORPAY_KEY_ID", secret ? "" : "RAZORPAY_KEY_SECRET", signingSecret ? "" : "RAZORPAY_WEBHOOK_SECRET"].filter(Boolean);
  if (missingSecretNames.length) return { ok: false as const, status: 503, message: "Razorpay checkout and its signed webhook must be configured before payment can open.", missingSecretNames };
  await expireStaleVeraBookings(env);
  const access = await getVeraBookingAccess({ env, request, bookingId, manageToken, requireCsrf: true });
  if (!access.ok) return access;
  const booking = access.booking;
  if (!["deposit", "full", "balance"].includes(kind)) return { ok: false as const, status: 400, message: "Payment kind is invalid." };
  if (safeString(booking.currency) !== "INR") return { ok: false as const, status: 409, message: "Razorpay only accepts saved INR bookings." };
  if (kind === "balance" && !access.accountAccess) return { ok: false as const, status: 403, message: "An authenticated account is required for balance payment." };
  if (safeString(booking.payment_state) === "unpaid" && kind !== safeString(booking.payment_option)) {
    return { ok: false as const, status: 409, message: "Payment kind must match the booking choice." };
  }
  const amountCents = quoteBookingPayment({ paymentState: safeString(booking.payment_state), balanceCents: Number(booking.balance_cents), depositCents: Number(booking.deposit_cents || 650_000), kind });
  if (amountCents < 50) return { ok: false as const, status: 409, message: "No eligible Razorpay balance remains for this payment kind." };
  const idempotencyKey = `vera-razorpay:${bookingId}:${kind}:${amountCents}`;
  let attempt = await first(env, `SELECT * FROM ${tables.paymentAttempts} WHERE idempotency_key = ?`, [idempotencyKey]);
  const attemptId = safeString(attempt?.id) || secureId("vpay");
  if (attempt?.provider_order_id) {
    return { ok: true as const, status: 200, message: "Razorpay order is ready.", checkout: { provider: "razorpay", orderId: safeString(attempt.provider_order_id), keyId: id, amountCents, currency: "INR", bookingNumber: safeString(booking.booking_number), customerEmail: safeString(booking.email), customerName: safeString(booking.customer_name) } };
  }
  if (!attempt) {
    const now = nowIso();
    await run(env, `INSERT INTO ${tables.paymentAttempts} (id,booking_id,kind,provider,provider_payment_intent_id,provider_order_id,idempotency_key,amount_cents,currency,status,last_error_code,created_at,updated_at) VALUES (?,?,?,'razorpay',NULL,NULL,?,?,'INR','creating',NULL,?,?)`, [attemptId, bookingId, kind, idempotencyKey, amountCents, now, now]);
    attempt = await first(env, `SELECT * FROM ${tables.paymentAttempts} WHERE id = ?`, [attemptId]);
  }
  let response: Response;
  try {
    response = await fetchForEnv(env)("https://api.razorpay.com/v1/orders", { method: "POST", headers: { authorization: basicAuthorization(id, secret), "content-type": "application/json" }, body: JSON.stringify({ amount: amountCents, currency: "INR", receipt: safeString(booking.booking_number), notes: { bookingId, attemptId, kind, template: "vera-solaro" } }), signal: AbortSignal.timeout(8_000) });
  } catch {
    return { ok: false as const, status: 502, message: "Razorpay is temporarily unavailable.", missingSecretNames: [] };
  }
  const payload = parseObject(await response.json().catch(() => ({})));
  const orderId = safeString(payload.id);
  if (!response.ok || !orderPattern.test(orderId) || Number(payload.amount) !== amountCents || safeString(payload.currency).toUpperCase() !== "INR") {
    await run(env, `UPDATE ${tables.paymentAttempts} SET status='failed',last_error_code='razorpay_order_failed',updated_at=? WHERE id=?`, [nowIso(), attemptId]);
    return { ok: false as const, status: response.ok ? 502 : response.status, message: "Razorpay could not prepare this payment.", missingSecretNames: [] };
  }
  await run(env, `UPDATE ${tables.paymentAttempts} SET provider_order_id=?,status='requires_action',last_error_code=NULL,updated_at=? WHERE id=?`, [orderId, nowIso(), attemptId]);
  return { ok: true as const, status: 200, message: "Razorpay order is ready.", checkout: { provider: "razorpay", orderId, keyId: id, amountCents, currency: "INR", bookingNumber: safeString(booking.booking_number), customerEmail: safeString(booking.email), customerName: safeString(booking.customer_name) } };
};

export const processRazorpayWebhook = async ({ env, body, signatureHeader, eventIdHeader = "" }: { env: VeraEnv; body: string; signatureHeader: string; eventIdHeader?: string }) => {
  if (!env.DB?.batch) return { ok: false as const, status: 503, message: "Atomic payment storage is not ready.", missingSecretNames: [] };
  const secret = await webhookSecret(env);
  if (!secret) return { ok: false as const, status: 503, message: "Razorpay webhook signing is not configured.", missingSecretNames: ["RAZORPAY_WEBHOOK_SECRET"] };
  if (!signatureHeader || !timingSafeHexEqual(await hmacSha256Hex(secret, body), signatureHeader)) return { ok: false as const, status: 403, message: "Invalid Razorpay webhook signature.", missingSecretNames: [] };
  let event: VeraRow;
  try { event = JSON.parse(body) as VeraRow; } catch { return { ok: false as const, status: 400, message: "Razorpay webhook payload is invalid.", missingSecretNames: [] }; }
  const eventType = safeString(event.event);
  if (["refund.processed", "refund.failed"].includes(eventType)) {
    const payload = parseObject(event.payload);
    const refund = parseObject(parseObject(payload.refund).entity);
    const providerRefundId = safeString(refund.id);
    const paymentId = safeString(refund.payment_id);
    if (!refundPattern.test(providerRefundId) || !paymentPattern.test(paymentId)) return { ok: false as const, status: 400, message: "Razorpay refund reference is invalid.", missingSecretNames: [] };
    const record = await first(env, `SELECT refund.*, attempt.provider_payment_intent_id
      FROM ${tables.refunds} refund JOIN ${tables.paymentAttempts} attempt ON attempt.id = refund.payment_attempt_id
      WHERE refund.provider_refund_id = ?`, [providerRefundId]);
    if (!record) return { ok: true as const, status: 200, message: "Unknown Razorpay refund ignored.", missingSecretNames: [] };
    if (safeString(record.provider_payment_intent_id) !== paymentId || Number(record.amount_cents) !== Number(refund.amount) || safeString(record.currency) !== "INR") {
      return { ok: false as const, status: 409, message: "Razorpay refund did not match the authoritative refund.", missingSecretNames: [] };
    }
    const eventId = eventIdHeader || `${eventType}:${providerRefundId}`;
    if (await first(env, `SELECT id FROM ${tables.paymentEvents} WHERE provider_event_id = ?`, [eventId])) return { ok: true as const, status: 200, message: "Razorpay event already processed.", missingSecretNames: [] };
    const now = nowIso();
    await runStatements(env, [
      env.DB!.prepare(`INSERT INTO ${tables.paymentEvents} (id,provider_event_id,provider_payment_intent_id,booking_id,event_type,payload_hash,processed_at) VALUES (?,?,?,?,?,?,?)`).bind(secureId("vpe"), eventId, paymentId, safeString(record.booking_id), eventType, await sha256Hex(body), now),
      env.DB!.prepare(`UPDATE ${tables.refunds} SET status = CASE WHEN status='succeeded' THEN 'succeeded' ELSE ? END, updated_at=? WHERE id=?`).bind(eventType === "refund.processed" ? "succeeded" : "failed", now, safeString(record.id)),
    ]);
    if (eventType === "refund.processed") await applySucceededRefundState(env, safeString(record.booking_id), now);
    return { ok: true as const, status: 200, message: "Razorpay refund event processed.", missingSecretNames: [] };
  }
  if (!["payment.captured", "payment.failed"].includes(eventType)) return { ok: true as const, status: 200, message: "Razorpay event ignored.", missingSecretNames: [] };
  const payload = parseObject(event.payload); const payment = parseObject(parseObject(payload.payment).entity); const notes = parseObject(payment.notes);
  const paymentId = safeString(payment.id); const orderId = safeString(payment.order_id); const attemptId = safeString(notes.attemptId); const bookingId = safeString(notes.bookingId);
  if (!paymentPattern.test(paymentId) || !orderPattern.test(orderId)) return { ok: false as const, status: 400, message: "Razorpay payment reference is invalid.", missingSecretNames: [] };
  const attempt = await first(env, `SELECT * FROM ${tables.paymentAttempts} WHERE id = ?`, [attemptId]);
  if (!attempt || safeString(attempt.provider) !== "razorpay" || safeString(attempt.booking_id) !== bookingId || safeString(attempt.provider_order_id) !== orderId || Number(attempt.amount_cents) !== Number(payment.amount) || safeString(attempt.currency) !== safeString(payment.currency).toUpperCase()) {
    return { ok: false as const, status: 409, message: "Razorpay payment did not match the authoritative attempt.", missingSecretNames: [] };
  }
  const eventId = eventIdHeader || `${eventType}:${paymentId}`;
  if (await first(env, `SELECT id FROM ${tables.paymentEvents} WHERE provider_event_id = ?`, [eventId])) return { ok: true as const, status: 200, message: "Razorpay event already processed.", missingSecretNames: [] };
  const payloadHash = await sha256Hex(body);
  await run(env, `UPDATE ${tables.paymentAttempts} SET provider_payment_intent_id=?,updated_at=? WHERE id=? AND (provider_payment_intent_id IS NULL OR provider_payment_intent_id=?)`, [paymentId, nowIso(), attemptId, paymentId]);
  if (eventType === "payment.captured") return { ...(await processPaymentSucceeded({ env, eventId, eventType, intent: { id: paymentId, amount: Number(payment.amount), currency: safeString(payment.currency) }, attempt, payloadHash })), missingSecretNames: [] };
  await recordNonSuccessPaymentEvent({ env, eventId, eventType, paymentIntentId: paymentId, attempt, payloadHash, attemptStatus: "failed", errorCode: safeString(parseObject(payment.error).code) || "razorpay_payment_failed" });
  return { ok: true as const, status: 200, message: "Razorpay payment event processed.", missingSecretNames: [] };
};

export const createRazorpayRefund = async ({ env, bookingId, paymentAttemptId, amountCents, reason }: {
  env: VeraEnv; bookingId: string; paymentAttemptId?: string; amountCents?: number; reason: string;
}) => {
  const [id, secret] = await Promise.all([keyId(env), keySecret(env)]);
  const missingSecretNames = [id ? "" : "RAZORPAY_KEY_ID", secret ? "" : "RAZORPAY_KEY_SECRET"].filter(Boolean);
  if (missingSecretNames.length) return { ok: false as const, status: 503, message: "Razorpay is not configured.", missingSecretNames };
  const exactAttemptId = safeString(paymentAttemptId);
  const attempts = await all(env, `SELECT attempt.*, MAX(0, attempt.amount_cents - COALESCE((SELECT SUM(refund.amount_cents) FROM ${tables.refunds} refund WHERE refund.payment_attempt_id=attempt.id AND refund.status IN ('pending','succeeded')),0)) AS refundable_cents FROM ${tables.paymentAttempts} attempt WHERE attempt.booking_id=? AND attempt.provider='razorpay' AND attempt.currency='INR' AND attempt.status='succeeded' AND (?='' OR attempt.id=?) ORDER BY attempt.created_at DESC, attempt.id DESC`, [bookingId, exactAttemptId, exactAttemptId]);
  if (!attempts.length) return { ok: false as const, status: 404, message: "A refundable Razorpay payment was not found.", missingSecretNames: [] };
  const totalRefundable = attempts.reduce((sum, attempt) => sum + Number(attempt.refundable_cents), 0);
  const requestedAmount = amountCents === undefined ? totalRefundable : Math.floor(amountCents);
  if (requestedAmount < 1 || requestedAmount > totalRefundable) return { ok: false as const, status: 409, message: "Refund amount exceeds the refundable payment.", missingSecretNames: [] };
  let remaining = requestedAmount;
  const submitted: Array<{ refundId: string; providerRefundId: string; amountCents: number }> = [];
  for (const attempt of attempts) {
    if (!remaining) break;
    const amount = Math.min(remaining, Number(attempt.refundable_cents));
    if (amount < 1) continue;
    const attemptId = safeString(attempt.id);
    const failures = await first(env, `SELECT COUNT(*) AS count FROM ${tables.refunds} WHERE payment_attempt_id=? AND status IN ('failed','cancelled')`, [attemptId]);
    const active = Number(attempt.amount_cents) - Number(attempt.refundable_cents);
    const idempotencyKey = `vera-razorpay-refund:${attemptId}:${active}:${amount}:try${Number(failures?.count) + 1}`;
    const refundId = secureId("vrefund");
    const now = nowIso();
    const inserted = await run(env, `INSERT INTO ${tables.refunds} (id,booking_id,payment_attempt_id,provider_refund_id,amount_cents,currency,reason,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,NULL,?,'INR',?,'pending',?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`, [refundId, bookingId, attemptId, amount, safeString(reason).slice(0, 500) || "requested_by_customer", idempotencyKey, now, now]);
    if (changeCount(inserted) !== 1) return { ok: false as const, status: 409, message: "A concurrent refund changed this payment.", missingSecretNames: [], partialRefunds: submitted };
    let response: Response;
    try {
      response = await fetchForEnv(env)(`https://api.razorpay.com/v1/payments/${encodeURIComponent(safeString(attempt.provider_payment_intent_id))}/refund`, { method: "POST", headers: { authorization: basicAuthorization(id, secret), "content-type": "application/json", "X-Razorpay-Idempotency-Key": idempotencyKey }, body: JSON.stringify({ amount, speed: "normal", notes: { bookingId, refundId, attemptId } }), signal: AbortSignal.timeout(8_000) });
    } catch {
      return { ok: false as const, status: 502, message: "Razorpay refund outcome is unknown; staff reconciliation is required.", missingSecretNames: [], partialRefunds: submitted };
    }
    const payload = parseObject(await response.json().catch(() => ({})));
    const providerRefundId = safeString(payload.id);
    if (!response.ok || !refundPattern.test(providerRefundId) || safeString(payload.payment_id) !== safeString(attempt.provider_payment_intent_id) || Number(payload.amount) !== amount) {
      if (response.status < 500) await run(env, `UPDATE ${tables.refunds} SET status='failed',updated_at=? WHERE id=?`, [nowIso(), refundId]);
      return { ok: false as const, status: response.ok ? 502 : response.status, message: "Razorpay refund could not be verified.", missingSecretNames: [], partialRefunds: submitted };
    }
    await run(env, `UPDATE ${tables.refunds} SET provider_refund_id=?,updated_at=? WHERE id=?`, [providerRefundId, nowIso(), refundId]);
    submitted.push({ refundId, providerRefundId, amountCents: amount });
    remaining -= amount;
  }
  return { ok: true as const, status: 202, message: "Refund submitted; Razorpay webhook confirmation is pending.", refundId: submitted[0]?.refundId || "", providerRefundId: submitted[0]?.providerRefundId || "", refunds: submitted, missingSecretNames: [] };
};
