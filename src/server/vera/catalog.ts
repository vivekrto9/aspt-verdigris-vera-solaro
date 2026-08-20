import { all, first, safeString } from "./db.ts";
import type { VeraEnv, VeraRow } from "./types.ts";
import { VERA_TABLES as tables } from "./types.ts";

export const VERA_HOLD_MINUTES = 12;
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

const rowToService = (row: VeraRow) => ({
  slug: safeString(row.slug) as VeraServiceSlug,
  name: safeString(row.name),
  durationMinutes: Number(row.duration_minutes),
  priceCents: Number(row.price_cents),
  currency: safeString(row.currency) || VERA_CURRENCY,
});

export const listVeraCatalog = async (env: VeraEnv) => {
  const services = await all(env, `SELECT slug, name, duration_minutes, price_cents, currency
    FROM ${tables.services} WHERE active = 1 ORDER BY sort_order`);
  const mappings = await all(env, `SELECT service_slug, mode, event_type_uri, active
    FROM ${tables.calendlyMappings} WHERE mode = 'call' ORDER BY service_slug`);
  const runtimeRows = await all(env, `SELECT key, value FROM ap_runtime_config
    WHERE (key LIKE 'VERA_CALENDLY_%' OR key = 'CALENDLY_30_MIN_EVENT_TYPE_URI')
      AND status = 'active'`);
  const stripeRow = await first(env, `SELECT value FROM ap_runtime_config
    WHERE key = 'STRIPE_PUBLISHABLE_KEY' AND status = 'active'`);
  const waitlist = await first(env, `SELECT COUNT(*) AS count FROM ${tables.waitlist}
    WHERE status = 'active'`);
  const runtimeMappings = new Map(runtimeRows.map((row) => [safeString(row.key), safeString(row.value)]));
  const sharedUri = runtimeMappings.get(SHARED_CALENDLY_RUNTIME_KEY) ||
    safeString(env[SHARED_CALENDLY_RUNTIME_KEY]);
  const resolvedMappings = mappings.map((row) => ({
    active: Number(row.active) === 1,
    resolvedUri: resolveCalendlyUri({
      perService: runtimeMappings.get(calendlyRuntimeKey(
        safeString(row.service_slug) as VeraServiceSlug,
        safeString(row.mode) as VeraMode,
      )),
      shared: sharedUri,
      rowValue: safeString(row.event_type_uri),
    }),
  }));
  return {
    services: services.map(rowToService),
    modes: [{ key: "call" }],
    depositCents: VERA_DEPOSIT_CENTS,
    holdMinutes: VERA_HOLD_MINUTES,
    stripePublishableKey: safeString(stripeRow?.value) || safeString(env.PUBLIC_STRIPE_PUBLISHABLE_KEY),
    activeWaitlistCount: Number(waitlist?.count || 0),
    calendlyReady: resolvedMappings.length === 3 && resolvedMappings.every((row) =>
      row.active && /^https:\/\/api\.calendly\.com\/event_types\/[A-Za-z0-9_-]+$/.test(row.resolvedUri)
    ),
  };
};

export const calendlyRuntimeKey = (serviceSlug: VeraServiceSlug, mode: VeraMode) =>
  `VERA_CALENDLY_${serviceSlug.replaceAll("-", "_").toUpperCase()}_${mode.toUpperCase()}_URI`;

export const SHARED_CALENDLY_RUNTIME_KEY = "CALENDLY_30_MIN_EVENT_TYPE_URI";

export const resolveCalendlyUri = ({
  perService,
  shared,
  rowValue,
}: {
  perService?: string;
  shared?: string;
  rowValue?: string;
}) => safeString(perService) || safeString(shared) || safeString(rowValue);

export const getVeraSelection = async (
  env: VeraEnv,
  serviceSlug: unknown,
  mode: unknown,
) => {
  const normalizedSlug = normalizeVeraServiceSlug(serviceSlug);
  if (!normalizedSlug || !isVeraMode(mode)) return null;
  const row = await first(env, `SELECT
      service.slug, service.name, service.duration_minutes, service.price_cents,
      service.currency, mapping.event_type_uri
    FROM ${tables.services} service
    JOIN ${tables.calendlyMappings} mapping
      ON mapping.service_slug = service.slug AND mapping.mode = ?
    WHERE service.slug = ? AND service.active = 1 AND mapping.active = 1`, [mode, normalizedSlug]);
  if (!row) return null;
  const [runtime, shared] = await Promise.all([
    first(env, `SELECT value FROM ap_runtime_config
      WHERE key = ? AND status = 'active'`, [calendlyRuntimeKey(normalizedSlug, mode)]),
    first(env, `SELECT value FROM ap_runtime_config
      WHERE key = ? AND status = 'active'`, [SHARED_CALENDLY_RUNTIME_KEY]),
  ]);
  return {
    ...rowToService(row),
    mode,
    eventTypeUri: resolveCalendlyUri({
      perService: safeString(runtime?.value),
      shared: safeString(shared?.value) || safeString(env[SHARED_CALENDLY_RUNTIME_KEY]),
      rowValue: safeString(row.event_type_uri),
    }),
  };
};

export const quoteInitialPayment = ({
  priceCents,
  giftAvailableCents = 0,
  paymentOption,
}: {
  priceCents: number;
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
    : Math.min(VERA_DEPOSIT_CENTS, totalDueCents);
  return { priceCents, giftAppliedCents, totalDueCents, payNowCents, balanceCents: totalDueCents };
};

export const quoteBookingPayment = ({
  paymentState,
  balanceCents,
  kind,
}: {
  paymentState: string;
  balanceCents: number;
  kind: VeraPaymentKind;
}) => {
  const remaining = Math.max(0, Math.floor(balanceCents));
  if (remaining === 0) return 0;
  if (kind === "deposit") {
    if (paymentState !== "unpaid") return 0;
    return Math.min(VERA_DEPOSIT_CENTS, remaining);
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
