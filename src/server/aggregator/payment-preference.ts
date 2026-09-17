import type { RuntimeEnv } from "./runtime.ts";

export type PaymentPreference = "USD" | "INR" | "AUTO";
export type PaymentCurrency = "USD" | "INR";
export const paymentPreferences = ["USD", "INR", "AUTO"] as const;
export const paymentPreferenceKey = "payment_preference";

export class PaymentPreferenceError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const isPaymentPreference = (value: unknown): value is PaymentPreference =>
  typeof value === "string" && paymentPreferences.some((entry) => entry === value);

export const resolvePaymentCurrency = (
  preference: PaymentPreference,
  trustedCountry?: unknown,
): PaymentCurrency => preference === "AUTO"
  ? (typeof trustedCountry === "string" && trustedCountry.toUpperCase() === "IN" ? "INR" : "USD")
  : preference;

type SettingRow = { value_json: string; updated_at: string };

const parseRow = (row: SettingRow | null) => {
  if (!row) {
    throw new PaymentPreferenceError(503, "PAYMENT_SETTINGS_UNAVAILABLE", "Apply the payment-preference migration before using this feature.");
  }
  let value: Record<string, unknown> | undefined;
  try {
    value = JSON.parse(row.value_json) as Record<string, unknown>;
  } catch {
    // Validated below without exposing persisted data.
  }
  if (!value || value.schemaVersion !== 1 || !isPaymentPreference(value.value)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
    throw new PaymentPreferenceError(503, "PAYMENT_SETTINGS_UNAVAILABLE", "Stored payment preference is invalid.");
  }
  return {
    payment_preference: value.value as PaymentPreference,
    revision: value.revision as number,
    updatedAt: row.updated_at,
  };
};

const first = async (env: RuntimeEnv, sql: string, values: unknown[]) => {
  if (!env.DB) throw new PaymentPreferenceError(503, "PAYMENT_SETTINGS_UNAVAILABLE", "Payment settings storage is unavailable.");
  const prepared = env.DB.prepare(sql).bind(...values);
  if (!prepared.first) throw new PaymentPreferenceError(503, "PAYMENT_SETTINGS_UNAVAILABLE", "Payment settings storage is unavailable.");
  return prepared.first() as Promise<SettingRow | null>;
};

export const readPaymentPreference = async (env: RuntimeEnv) => parseRow(await first(
  env,
  "SELECT value_json, updated_at FROM ap_business_settings WHERE key = ? LIMIT 1",
  [paymentPreferenceKey],
));

export const updatePaymentPreference = async (env: RuntimeEnv, input: unknown) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PaymentPreferenceError(400, "PAYMENT_INVALID_INPUT", "A preference update object is required.");
  }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["payment_preference", "expectedRevision"].includes(key))
    || !isPaymentPreference(body.payment_preference) || !Number.isSafeInteger(body.expectedRevision)
    || Number(body.expectedRevision) < 1 || Number(body.expectedRevision) >= Number.MAX_SAFE_INTEGER) {
    throw new PaymentPreferenceError(400, "PAYMENT_INVALID_INPUT", "Use USD, INR or AUTO and a valid expectedRevision; other fields are not supported.");
  }
  const existing = await readPaymentPreference(env);
  if (existing.revision !== body.expectedRevision) {
    throw new PaymentPreferenceError(409, "PAYMENT_REVISION_CONFLICT", "Reload the current preference before saving.");
  }
  const nextValue = JSON.stringify({ value: body.payment_preference, schemaVersion: 1, revision: existing.revision + 1 });
  const updated = await first(
    env,
    `UPDATE ap_business_settings SET value_json = ?, updated_at = ?
     WHERE key = ? AND json_extract(value_json, '$.revision') = ? RETURNING value_json, updated_at`,
    [nextValue, new Date().toISOString(), paymentPreferenceKey, existing.revision],
  );
  if (!updated) throw new PaymentPreferenceError(409, "PAYMENT_REVISION_CONFLICT", "Reload the current preference before saving.");
  return parseRow(updated);
};
