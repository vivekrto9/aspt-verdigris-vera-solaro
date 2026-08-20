import { isActiveLocale } from "../../data/localization-contract.ts";
import leadsManifest from "../../../astropages/leads.manifest.json" with { type: "json" };
import { AP_TABLES } from "./db/tables.ts";
import { createId, nowIso, safeString, type RuntimeEnv } from "./runtime.ts";

const EMAIL_MAX_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
const NAME_MAX_LENGTH = 120;
const KEY_MAX_LENGTH = 80;
const PATH_MAX_LENGTH = 200;
const DETAIL_VALUE_MAX_LENGTH = 500;

export const LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "lost", "spam"] as const;

const ATTRIBUTION_ALLOWLIST = ["utmSource", "utmMedium", "utmCampaign", "utmTerm", "utmContent", "referrer"] as const;
const LEAD_SOURCE_FIELDS = leadsManifest.sources as Record<string, readonly string[]>;

export const normalizeLeadEmail = (value: unknown) => safeString(value).toLowerCase();

export const isValidLeadEmail = (email: string) =>
  email.length > 3 && email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email);

export const normalizeLeadPhone = (value: unknown) => {
  const raw = safeString(value);
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return "";
  return raw.startsWith("+") ? `+${digits}` : digits;
};

export const isValidLeadPhone = (normalizedPhone: string) => {
  const digits = normalizedPhone.replace(/[^0-9]/g, "");
  return digits.length >= PHONE_MIN_DIGITS && digits.length <= PHONE_MAX_DIGITS;
};

const normalizeLocale = (value: unknown) => {
  const locale = safeString(value).toLowerCase();
  return isActiveLocale(locale) ? locale : "en";
};

const boundedString = (value: unknown, maxLength: number) => safeString(value).slice(0, maxLength);

const slugString = (value: unknown, maxLength = KEY_MAX_LENGTH) =>
  boundedString(value, maxLength).toLowerCase().replace(/[^a-z0-9/_-]/g, "");

export const isSupportedLeadSource = (value: unknown) =>
  Object.prototype.hasOwnProperty.call(LEAD_SOURCE_FIELDS, slugString(value));

const allowlistedJson = (value: unknown, allowlist: readonly string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
  const record = value as Record<string, unknown>;
  const picked: Record<string, string> = {};
  for (const key of allowlist) {
    const entry = record[key];
    if (typeof entry === "string" && entry.trim()) {
      picked[key] = entry.trim().slice(0, DETAIL_VALUE_MAX_LENGTH);
    }
  }
  return JSON.stringify(picked);
};

const detailsJson = (value: unknown, source: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
  const record = value as Record<string, unknown>;
  const allowed = new Set(["tool", ...(LEAD_SOURCE_FIELDS[slugString(source)] ?? [])]);
  const picked: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!allowed.has(key)) continue;
    if (typeof entry === "string" && entry.trim()) picked[key] = entry.trim().slice(0, DETAIL_VALUE_MAX_LENGTH);
    else if (typeof entry === "boolean") picked[key] = entry;
    else if (typeof entry === "number" && Number.isFinite(entry)) picked[key] = entry;
  }
  return JSON.stringify(picked);
};

export type LeadSubmission = {
  kind: string;
  source?: unknown;
  formKey?: unknown;
  pagePath?: unknown;
  locale?: unknown;
  fullName?: unknown;
  email?: unknown;
  phone?: unknown;
  whatsapp?: unknown;
  consentContact?: unknown;
  consentMarketing?: unknown;
  details?: unknown;
  attribution?: unknown;
  idempotencyKey?: unknown;
  customerAccountId?: string;
  sourceReferenceType?: string;
  sourceReferenceId?: string;
  dedupeKey?: string;
};

export type LeadCreateResult =
  | { ok: true; leadId: string; alreadyExists: boolean }
  | { ok: false; message: string };

export type BusinessLeadSubmission = {
  kind: string;
  source: string;
  formKey: string;
  pagePath?: string;
  locale?: unknown;
  fullName?: unknown;
  email?: unknown;
  phone?: unknown;
  whatsapp?: unknown;
  consentMarketing?: unknown;
  customerAccountId?: string;
  sourceReferenceType: string;
  sourceReferenceId: string;
  details?: unknown;
};

const missingLeadsTable = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`no such table: ${AP_TABLES.leads}`);
};

export const isMissingLeadsTableError = missingLeadsTable;

export const createLead = async ({
  env,
  submission,
}: {
  env: RuntimeEnv;
  submission: LeadSubmission;
}): Promise<LeadCreateResult> => {
  if (!env.DB) {
    return { ok: false, message: "Lead capture is temporarily unavailable." };
  }

  const email = normalizeLeadEmail(submission.email);
  const phone = normalizeLeadPhone(submission.phone);
  const whatsapp = normalizeLeadPhone(submission.whatsapp);
  const hasEmail = Boolean(email) && isValidLeadEmail(email);
  const hasPhone = Boolean(phone) && isValidLeadPhone(phone);
  const hasWhatsapp = Boolean(whatsapp) && isValidLeadPhone(whatsapp);

  if (email && !hasEmail) {
    return { ok: false, message: "Please enter a valid email address." };
  }
  if ((phone && !hasPhone) || (whatsapp && !hasWhatsapp)) {
    return { ok: false, message: "Please enter a valid phone number." };
  }
  if (!hasEmail && !hasPhone && !hasWhatsapp) {
    return { ok: false, message: "Please share an email, phone, or WhatsApp number." };
  }
  if (submission.consentContact !== true) {
    return { ok: false, message: "Contact consent is required." };
  }

  const kind = slugString(submission.kind);
  if (!kind) {
    return { ok: false, message: "Lead kind is required." };
  }

  const idempotencyKey = boundedString(submission.idempotencyKey, KEY_MAX_LENGTH);
  const dedupeKey =
    submission.dedupeKey ??
    (idempotencyKey ? `${kind}:idem:${idempotencyKey}` : `${kind}:${createId("lead")}`);
  const timestamp = nowIso();
  const leadId = createId("lead");

  const existing = await env.DB
    .prepare(`SELECT id FROM ${AP_TABLES.leads} WHERE dedupe_key = ? LIMIT 1`)
    .bind(dedupeKey)
    .first?.() as { id: string } | null | undefined;

  await env.DB
    .prepare(`
      INSERT INTO ${AP_TABLES.leads} (
        id, status, kind, source, form_key, page_path, locale,
        full_name, email, normalized_email, phone, normalized_phone,
        whatsapp, normalized_whatsapp,
        consent_contact, consent_marketing, consent_at,
        customer_account_id, source_reference_type, source_reference_id,
        attribution_json, details_json, idempotency_key,
        dedupe_key, created_at, updated_at
      ) VALUES (?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        full_name = CASE WHEN excluded.full_name != '' THEN excluded.full_name ELSE ${AP_TABLES.leads}.full_name END,
        email = CASE WHEN excluded.email != '' THEN excluded.email ELSE ${AP_TABLES.leads}.email END,
        normalized_email = CASE WHEN excluded.normalized_email != '' THEN excluded.normalized_email ELSE ${AP_TABLES.leads}.normalized_email END,
        phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE ${AP_TABLES.leads}.phone END,
        normalized_phone = CASE WHEN excluded.normalized_phone != '' THEN excluded.normalized_phone ELSE ${AP_TABLES.leads}.normalized_phone END,
        whatsapp = CASE WHEN excluded.whatsapp != '' THEN excluded.whatsapp ELSE ${AP_TABLES.leads}.whatsapp END,
        normalized_whatsapp = CASE WHEN excluded.normalized_whatsapp != '' THEN excluded.normalized_whatsapp ELSE ${AP_TABLES.leads}.normalized_whatsapp END,
        consent_marketing = CASE WHEN excluded.consent_marketing = 1 THEN 1 ELSE ${AP_TABLES.leads}.consent_marketing END,
        locale = excluded.locale,
        updated_at = excluded.updated_at
    `)
    .bind(
      leadId,
      kind,
      slugString(submission.source) || "website",
      slugString(submission.formKey),
      boundedString(submission.pagePath, PATH_MAX_LENGTH),
      normalizeLocale(submission.locale),
      boundedString(submission.fullName, NAME_MAX_LENGTH),
      hasEmail ? email : "",
      hasEmail ? email : "",
      hasPhone ? boundedString(submission.phone, 32) : "",
      hasPhone ? phone : "",
      hasWhatsapp ? boundedString(submission.whatsapp, 32) : "",
      hasWhatsapp ? whatsapp : "",
      1,
      submission.consentMarketing === true ? 1 : 0,
      timestamp,
      submission.customerAccountId ?? null,
      boundedString(submission.sourceReferenceType, KEY_MAX_LENGTH),
      boundedString(submission.sourceReferenceId, KEY_MAX_LENGTH),
      allowlistedJson(submission.attribution, ATTRIBUTION_ALLOWLIST),
      detailsJson(submission.details, submission.source),
      idempotencyKey,
      dedupeKey,
      timestamp,
      timestamp,
    )
    .run?.();

  const persisted = await env.DB
    .prepare(`SELECT id FROM ${AP_TABLES.leads} WHERE dedupe_key = ? LIMIT 1`)
    .bind(dedupeKey)
    .first?.() as { id: string } | null | undefined;
  const resolvedLeadId = persisted?.id ?? existing?.id ?? leadId;
  const alreadyExists = Boolean(existing);

  if (!alreadyExists) {
    await env.DB
      .prepare(`
        INSERT INTO ${AP_TABLES.businessEvents} (
          id, event_type, aggregate_type, aggregate_id,
          locale, correlation_id, payload_json, created_at
        ) VALUES (?, 'lead.created', 'lead', ?, ?, ?, ?, ?)
      `)
      .bind(
        createId("evt"),
        resolvedLeadId,
        normalizeLocale(submission.locale),
        resolvedLeadId,
        JSON.stringify({
          kind,
          source: slugString(submission.source) || "website",
          formKey: slugString(submission.formKey),
        }),
        timestamp,
      )
      .run?.();
  }

  return { ok: true, leadId: resolvedLeadId, alreadyExists };
};

export const linkBusinessLead = async ({
  env,
  submission,
}: {
  env: RuntimeEnv;
  submission: BusinessLeadSubmission;
}) => {
  try {
    return await createLead({
      env,
      submission: {
        ...submission,
        consentContact: true,
        dedupeKey: `${slugString(submission.sourceReferenceType)}:${boundedString(submission.sourceReferenceId, KEY_MAX_LENGTH)}`,
      },
    });
  } catch (error) {
    console.warn("[astropages.leads] business lead link skipped", {
      sourceReferenceType: slugString(submission.sourceReferenceType),
      sourceReferenceId: boundedString(submission.sourceReferenceId, KEY_MAX_LENGTH),
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false as const, message: "Lead linking was skipped.", skipped: true as const };
  }
};

export const markLeadConvertedBySourceReference = async ({
  env,
  sourceReferenceType,
  sourceReferenceId,
  conversionReference,
}: {
  env: RuntimeEnv;
  sourceReferenceType: string;
  sourceReferenceId: string;
  conversionReference: string;
}) => {
  if (!env.DB) return { changed: false as const, skipped: true as const };
  try {
    const timestamp = nowIso();
    await env.DB.prepare(`
      UPDATE ${AP_TABLES.leads}
      SET status = 'converted', conversion_reference = ?, status_changed_at = ?, updated_at = ?
      WHERE source_reference_type = ? AND source_reference_id = ? AND status != 'converted'
    `).bind(
      boundedString(conversionReference, KEY_MAX_LENGTH),
      timestamp,
      timestamp,
      boundedString(sourceReferenceType, KEY_MAX_LENGTH),
      boundedString(sourceReferenceId, KEY_MAX_LENGTH),
    ).run?.();
    return { changed: true as const };
  } catch (error) {
    console.warn("[astropages.leads] conversion link skipped", {
      sourceReferenceType: slugString(sourceReferenceType),
      sourceReferenceId: boundedString(sourceReferenceId, KEY_MAX_LENGTH),
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { changed: false as const, skipped: true as const };
  }
};

export const newsletterLeadDedupeKey = (normalizedEmail: string) => `newsletter:${normalizedEmail}`;

export const linkNewsletterLead = async ({
  env,
  email,
  locale,
  source,
  subscriptionId,
}: {
  env: RuntimeEnv;
  email: string;
  locale: string;
  source: string;
  subscriptionId: string;
}): Promise<LeadCreateResult | { ok: false; message: string; skipped: true }> => {
  try {
    return await createLead({
      env,
      submission: {
        kind: "newsletter",
        source,
        formKey: "newsletter",
        locale,
        email,
        consentContact: true,
        consentMarketing: true,
        sourceReferenceType: "newsletter_subscription",
        sourceReferenceId: subscriptionId,
        dedupeKey: newsletterLeadDedupeKey(normalizeLeadEmail(email)),
      },
    });
  } catch (error) {
    if (missingLeadsTable(error)) {
      return { ok: false, message: "Leads are not enabled yet.", skipped: true };
    }
    throw error;
  }
};
