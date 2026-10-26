import { first, safeString } from "./db.ts";
import type { VeraPaymentKind } from "./catalog.ts";
import { createRazorpayCheckoutForBooking, createRazorpayRefund } from "./razorpay.ts";
import { createStripeCheckoutForBooking, createStripeRefund } from "./stripe.ts";
import type { VeraEnv } from "./types.ts";
import { VERA_TABLES as tables } from "./types.ts";

export const createVeraCheckoutForBooking = async (input: { env: VeraEnv; request: Request; bookingId: string; manageToken: string; kind: VeraPaymentKind; origin: string }) => {
  const booking = await first(input.env, `SELECT currency FROM ${tables.bookings} WHERE id = ?`, [input.bookingId]);
  const currency = safeString(booking?.currency);
  if (currency === "INR") return createRazorpayCheckoutForBooking(input);
  if (currency === "USD") return createStripeCheckoutForBooking(input);
  return { ok: false as const, status: 409, message: "The saved booking currency is unsupported." };
};

export const createVeraRefund = async (input: { env: VeraEnv; bookingId: string; paymentAttemptId?: string; amountCents?: number; reason: string }) => {
  const exact = safeString(input.paymentAttemptId);
  const attempt = await first(input.env, `SELECT provider,currency FROM ${tables.paymentAttempts} WHERE booking_id=? AND status='succeeded' AND (?='' OR id=?) ORDER BY created_at DESC LIMIT 1`, [input.bookingId, exact, exact]);
  const provider = safeString(attempt?.provider);
  const currency = safeString(attempt?.currency);
  if (provider === "razorpay" && currency === "INR") return createRazorpayRefund(input);
  if (provider === "stripe" && currency === "USD") return createStripeRefund(input);
  return { ok: false as const, status: 404, message: "A refundable provider payment was not found.", missingSecretNames: [] };
};
