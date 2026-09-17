import { all, first, safeString } from "./db.ts";
import type { VeraEnv, VeraRow } from "./types.ts";
import { VERA_TABLES as tables } from "./types.ts";
import { depositForCurrency, priceCatalogRow } from "../aggregator/payment-pricing.ts";

export const VERA_HOLD_MINUTES = 12;
/** Historical USD defaults retained only for compatibility with old callers/tests. */
export const VERA_DEPOSIT_CENTS = 8_000;
export const VERA_CURRENCY = "USD";
export const VERA_SERVICE_SLUGS = ["natal-hour", "year-ahead", "two-charts"] as const;
export const VERA_MODES = ["call", "in_person"] as const;
export type VeraServiceSlug = typeof VERA_SERVICE_SLUGS[number];
export type VeraMode = typeof VERA_MODES[number];
export type VeraPaymentKind = "deposit" | "full" | "balance";

const serviceAliases: Record<string, VeraServiceSlug> = {
  natal: "natal-hour",
  "natal-hour": "natal-hour",
  year: "year-ahead",
  "year-ahead": "year-ahead",
  two: "two-charts",
  "two-charts": "two-charts",
};

export const normalizeVeraServiceSlug = (value: unknown) =>
  serviceAliases[safeString(value).toLowerCase()] ?? "";

export const isVeraServiceSlug = (value: unknown): value is VeraServiceSlug =>
  Boolean(normalizeVeraServiceSlug(value));

export const isVeraMode = (value: unknown): value is VeraMode =>
  VERA_MODES.includes(safeString(value) as VeraMode);

const rowToService = async (env: VeraEnv, row: VeraRow) => {
  const priced: Record<string, unknown> = await priceCatalogRow(env, row);
  return {
    slug: safeString(priced.slug) as VeraServiceSlug,
    name: safeString(priced.name),
    durationMinutes: Number(priced.duration_minutes),
    priceCents: Number(priced.price_cents),
    currency: safeString(priced.currency),
  };
};

export const listVeraCatalog = async (env: VeraEnv) => {
  const services = await all(env, `SELECT slug, name, duration_minutes, price_cents, currency,
      price_inr_cents, price_usd_cents
    FROM ${tables.services} WHERE active = 1 AND duration_minutes = 30 ORDER BY sort_order`);
  const deposit = await depositForCurrency(env);
  const shared = await first(env, `SELECT value FROM ap_runtime_config
    WHERE key = ? AND status = 'active'`, [SHARED_CALENDLY_RUNTIME_KEY]);
  const stripeRow = await first(env, `SELECT value FROM ap_runtime_config
    WHERE key = 'STRIPE_PUBLISHABLE_KEY' AND status = 'active'`);
  const waitlist = await first(env, `SELECT COUNT(*) AS count FROM ${tables.waitlist}
    WHERE status = 'active'`);
  const sharedUri = safeString(shared?.value) || safeString(env[SHARED_CALENDLY_RUNTIME_KEY]);
  return {
    services: await Promise.all(services.map((row) => rowToService(env, row))),
    modes: [{ key: "call" }],
    depositCents: deposit.amount,
    currency: deposit.currency,
    holdMinutes: VERA_HOLD_MINUTES,
    stripePublishableKey: safeString(stripeRow?.value) || safeString(env.PUBLIC_STRIPE_PUBLISHABLE_KEY),
    activeWaitlistCount: Number(waitlist?.count || 0),
    calendlyReady: services.length === VERA_SERVICE_SLUGS.length &&
      /^https:\/\/api\.calendly\.com\/event_types\/[A-Za-z0-9_-]+$/.test(sharedUri),
  };
};

export const SHARED_CALENDLY_RUNTIME_KEY = "CALENDLY_EVENT_TYPE_URI";

export const getVeraSelection = async (
  env: VeraEnv,
  serviceSlug: unknown,
  mode: unknown,
) => {
  const normalizedSlug = normalizeVeraServiceSlug(serviceSlug);
  if (!normalizedSlug || safeString(mode) !== "call") return null;
  const row = await first(env, `SELECT
      service.slug, service.name, service.duration_minutes, service.price_cents, service.currency,
      service.price_inr_cents, service.price_usd_cents
    FROM ${tables.services} service
    WHERE service.slug = ? AND service.active = 1 AND service.duration_minutes = 30`, [normalizedSlug]);
  if (!row) return null;
  const shared = await first(env, `SELECT value FROM ap_runtime_config
    WHERE key = ? AND status = 'active'`, [SHARED_CALENDLY_RUNTIME_KEY]);
  const [service, deposit] = await Promise.all([rowToService(env, row), depositForCurrency(env)]);
  return {
    ...service,
    depositCents: deposit.amount,
    mode: "call" as const,
    eventTypeUri: safeString(shared?.value) || safeString(env[SHARED_CALENDLY_RUNTIME_KEY]),
  };
};

export const quoteInitialPayment = ({
  priceCents,
  depositCents = 8_000,
  giftAvailableCents = 0,
  paymentOption,
}: {
  priceCents: number;
  depositCents?: number;
  giftAvailableCents?: number;
  paymentOption: "deposit" | "full";
}) => {
  let giftAppliedCents = Math.max(0, Math.min(priceCents, Math.floor(giftAvailableCents)));
  const provisionalRemainder = priceCents - giftAppliedCents;
  if (provisionalRemainder > 0 && provisionalRemainder < 50) {
    giftAppliedCents = Math.max(0, giftAppliedCents - (50 - provisionalRemainder));
  }
  const totalDueCents = priceCents - giftAppliedCents;
  const payNowCents = paymentOption === "full"
    ? totalDueCents
    : Math.min(depositCents, totalDueCents);
  return { priceCents, giftAppliedCents, totalDueCents, payNowCents, balanceCents: totalDueCents };
};

export const quoteBookingPayment = ({
  paymentState,
  balanceCents,
  depositCents = 8_000,
  kind,
}: {
  paymentState: string;
  balanceCents: number;
  depositCents?: number;
  kind: VeraPaymentKind;
}) => {
  const remaining = Math.max(0, Math.floor(balanceCents));
  if (remaining === 0) return 0;
  if (kind === "deposit") {
    if (paymentState !== "unpaid") return 0;
    return Math.min(depositCents, remaining);
  }
  if (kind === "full" && paymentState !== "unpaid") return 0;
  if (kind === "balance" && paymentState === "unpaid") return 0;
  return remaining;
};

export const canUseFreeReschedule = ({
  freeRescheduleUsed,
  scheduledStartAt,
  now = new Date(),
}: {
  freeRescheduleUsed: boolean;
  scheduledStartAt: string;
  now?: Date;
}) => {
  const start = new Date(scheduledStartAt).getTime();
  return !freeRescheduleUsed && Number.isFinite(start) && start - now.getTime() >= 72 * 60 * 60 * 1000;
};

export const bookingSlotStarts = (startAt: string, durationMinutes: number) => {
  const start = new Date(startAt).getTime();
  if (!Number.isFinite(start) || durationMinutes < 1) return [];
  const slots: string[] = [];
  for (let offset = 0; offset < durationMinutes; offset += 30) {
    slots.push(new Date(start + offset * 60_000).toISOString());
  }
  return slots;
};
