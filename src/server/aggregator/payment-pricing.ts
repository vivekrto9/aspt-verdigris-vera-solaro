import type { RuntimeEnv } from "./runtime.ts";
import { paymentCountryFromRequest } from "./payment-country.ts";
import { PaymentPreferenceError, readPaymentPreference, resolvePaymentCurrency, type PaymentCurrency } from "./payment-preference.ts";

const stateKey = Symbol.for("astropages.payment.request");
type CurrencyContext = { currency: PaymentCurrency; revision: number };
type PricingEnv = RuntimeEnv & { [stateKey]?: { request?: Request; policy?: Promise<CurrencyContext> } };

export const withPaymentRequest = <T extends RuntimeEnv>(env: T, request?: Request): T =>
  ({ ...env, [stateKey]: { request } }) as T;

const loadCurrencyContext = async (env: RuntimeEnv): Promise<CurrencyContext> => {
  const setting = await readPaymentPreference(env);
  const country = paymentCountryFromRequest(
    (env as PricingEnv)[stateKey]?.request as (Request & { cf?: { country?: unknown } }) | undefined,
    import.meta.env?.DEV === true,
  );
  return { currency: resolvePaymentCurrency(setting.payment_preference, country), revision: setting.revision };
};

export const getCurrencyContext = (env: RuntimeEnv): Promise<CurrencyContext> => {
  const scoped = (env as PricingEnv)[stateKey];
  return scoped ? scoped.policy ??= loadCurrencyContext(env) : loadCurrencyContext(env);
};

export const priceCatalogRow = async (env: RuntimeEnv, row: Record<string, unknown>) => {
  const { currency } = await getCurrencyContext(env);
  const amount = row[currency === "INR" ? "price_inr_cents" : "price_usd_cents"];
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new PaymentPreferenceError(503, "PAYMENT_PRICE_UNAVAILABLE", `${currency} pricing is not configured for this service.`);
  }
  return { ...row, price_cents: amount, currency };
};

export const depositForCurrency = async (env: RuntimeEnv) => {
  const { currency } = await getCurrencyContext(env);
  const row = env.DB?.prepare("SELECT value_json FROM ap_business_settings WHERE key = 'vera_payment_pricing' LIMIT 1").bind();
  const value = row?.first ? await row.first() as { value_json?: string } | null : null;
  let pricing: Record<string, unknown> = {};
  try { pricing = JSON.parse(String(value?.value_json || "{}")); } catch { /* validated below */ }
  const amount = pricing[currency === "INR" ? "deposit_inr_cents" : "deposit_usd_cents"];
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new PaymentPreferenceError(503, "PAYMENT_PRICE_UNAVAILABLE", `${currency} deposit pricing is not configured.`);
  }
  return { amount, currency };
};
