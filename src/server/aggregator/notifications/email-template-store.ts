import { AP_TABLES as tables } from "../db/tables.ts";
import { safeString, type RuntimeEnv } from "../runtime.ts";
import { readSenderSettings, sendTransactionalEmail } from "./transactional.ts";
import {
  extractTemplateVariables,
  parseJsonArray,
  renderEmailTemplate,
  validateTemplateVariables,
} from "./templates.ts";

type Row = Record<string, unknown>;
type TemplateInput = Record<string, unknown>;

const parseObject = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const parseValue = (value: unknown) => {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const all = async (env: RuntimeEnv, sql: string, values: unknown[] = []) => {
  if (!env.DB) return [];
  const result = await env.DB.prepare(sql).bind(...values).all?.();
  return (result?.results ?? []) as Row[];
};

const first = async (env: RuntimeEnv, sql: string, values: unknown[] = []) => {
  if (!env.DB) return null;
  return (await env.DB.prepare(sql).bind(...values).first?.() ?? null) as Row | null;
};

const templateFromRow = (row: Row) => ({
  key: String(row.key),
  displayName: String(row.display_name),
  eventType: String(row.event_type),
  audience: String(row.audience),
  locale: String(row.locale),
  channel: String(row.channel),
  enabled: Number(row.enabled) === 1,
  subject: String(row.subject),
  preheader: safeString(row.preheader),
  htmlBody: String(row.html_body),
  textBody: String(row.text_body),
  requiredVariables: parseJsonArray(row.required_variables_json),
  samplePayload: parseObject(row.sample_payload_json),
  updatedBy: safeString(row.updated_by),
  updatedAt: String(row.updated_at),
});

export type ManagedEmailTemplate = ReturnType<typeof templateFromRow>;

export const listManagedEmailTemplates = async (env: RuntimeEnv) =>
  (await all(
    env,
    `SELECT * FROM ${tables.emailTemplates}
     WHERE enabled = 1
     ORDER BY event_type, audience, locale, display_name`,
  )).map(templateFromRow);

export const getManagedEmailTemplate = async (env: RuntimeEnv, key: string) => {
  const row = await first(
    env,
    `SELECT * FROM ${tables.emailTemplates} WHERE key = ? AND enabled = 1`,
    [key],
  );
  return row ? templateFromRow(row) : null;
};

export const listEmailTemplateWorkspace = async (env: RuntimeEnv) =>
  (await listManagedEmailTemplates(env)).map((template) => ({
    key: template.key,
    live: template,
    draft: null,
    hasDraft: false,
  }));

const validKey = (value: string) => /^[a-z0-9][a-z0-9_.-]{1,119}$/.test(value);
const validVariable = (value: string) => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value);

const validate = (next: ManagedEmailTemplate) => {
  if (!next.subject || !next.htmlBody || !next.textBody) {
    return { ok: false as const, message: "Subject, HTML body, and text body are required." };
  }
  if (
    /^marketing(?:\.|$)/i.test(next.eventType) &&
    !next.requiredVariables.includes("unsubscribeUrl")
  ) {
    return {
      ok: false as const,
      message: "Marketing email templates must include unsubscribeUrl.",
    };
  }
  const validation = validateTemplateVariables({
    subject: next.subject,
    htmlBody: next.htmlBody,
    textBody: next.textBody,
    requiredVariables: next.requiredVariables,
  });
  if (!validation.ok) return validation;
  const used = extractTemplateVariables([next.subject, next.htmlBody, next.textBody]);
  const missing = next.requiredVariables.filter((variable) => !used.includes(variable));
  return missing.length
    ? { ok: false as const, message: `Required variables are not used: ${missing.join(", ")}.` }
    : { ok: true as const };
};

export const saveManagedEmailTemplate = async ({
  env,
  input,
  actor,
}: {
  env: RuntimeEnv;
  input: TemplateInput;
  actor: string;
}) => {
  if (!env.DB) return { ok: false as const, message: "Runtime database is not available." };
  const key = safeString(input.key);
  if (!validKey(key)) return { ok: false as const, message: "Template key is invalid." };
  const current = await getManagedEmailTemplate(env, key);
  const requiredVariables = Array.isArray(input.requiredVariables)
    ? [...new Set(input.requiredVariables.map(safeString).filter(validVariable))]
    : current?.requiredVariables ?? [];
  const next = {
    key,
    displayName: safeString(input.displayName) || current?.displayName || key,
    eventType: current?.eventType || safeString(input.eventType) || "custom.event",
    audience: safeString(input.audience) || current?.audience || "customer",
    locale: safeString(input.locale) || current?.locale || "en",
    channel: "email",
    enabled: true,
    subject: typeof input.subject === "string" ? input.subject.trim() : current?.subject ?? "",
    preheader: typeof input.preheader === "string" ? input.preheader : current?.preheader ?? "",
    htmlBody: typeof input.htmlBody === "string" ? input.htmlBody : current?.htmlBody ?? "",
    textBody: typeof input.textBody === "string" ? input.textBody : current?.textBody ?? "",
    requiredVariables,
    samplePayload: parseObject(input.samplePayload ?? current?.samplePayload ?? {}),
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  } satisfies ManagedEmailTemplate;
  const validation = validate(next);
  if (!validation.ok) return validation;

  const approved = new Set(
    (await listEmailVariableMappings(env)).map((mapping) => mapping.key),
  );
  const unapproved = next.requiredVariables.filter((variable) => !approved.has(variable));
  if (unapproved.length) {
    return {
      ok: false as const,
      message: `Email template uses unapproved variables: ${unapproved.join(", ")}.`,
    };
  }

  const event = await first(
    env,
    `SELECT event_type FROM ${tables.emailEvents} WHERE event_type = ?`,
    [next.eventType],
  );
  if (!event) {
    return {
      ok: false as const,
      message: `Create the ${next.eventType} email event before saving its template.`,
    };
  }

  await env.DB.prepare(`INSERT INTO ${tables.emailTemplates} (
    key, display_name, event_type, audience, locale, channel, enabled, subject,
    preheader, html_body, text_body, required_variables_json, sample_payload_json,
    updated_by, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'email', 1, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    display_name=excluded.display_name,
    event_type=excluded.event_type,
    audience=excluded.audience,
    locale=excluded.locale,
    channel='email',
    enabled=1,
    subject=excluded.subject,
    preheader=excluded.preheader,
    html_body=excluded.html_body,
    text_body=excluded.text_body,
    required_variables_json=excluded.required_variables_json,
    sample_payload_json=excluded.sample_payload_json,
    updated_by=excluded.updated_by,
    updated_at=excluded.updated_at`).bind(
    next.key,
    next.displayName,
    next.eventType,
    next.audience,
    next.locale,
    next.subject,
    next.preheader,
    next.htmlBody,
    next.textBody,
    JSON.stringify(next.requiredVariables),
    JSON.stringify(next.samplePayload),
    actor,
    next.updatedAt,
  ).run?.();
  await env.DB.prepare(
    `UPDATE ${tables.emailEvents} SET enabled = 1, updated_at = ? WHERE event_type = ?`,
  ).bind(next.updatedAt, next.eventType).run?.();
  return { ok: true as const, template: await getManagedEmailTemplate(env, key) };
};

export const renderManagedEmailTemplate = async ({
  env,
  key,
  payload,
}: {
  env: RuntimeEnv;
  key: string;
  payload?: Record<string, unknown>;
}) => {
  const template = await getManagedEmailTemplate(env, key);
  if (!template) return { ok: false as const, message: "Email template was not found." };
  const resolvedPayload = payload ?? template.samplePayload;
  const rendered = renderEmailTemplate({ template, payload: resolvedPayload });
  return rendered.ok ? { ...rendered, template, payload: resolvedPayload } : rendered;
};

export const sendManagedEmailTemplateTest = async ({
  env,
  key,
  recipient,
  payload,
}: {
  env: RuntimeEnv;
  key: string;
  recipient: string;
  payload?: Record<string, unknown>;
}) => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { ok: false as const, message: "A valid test recipient is required." };
  }
  const rendered = await renderManagedEmailTemplate({ env, key, payload });
  if (!rendered.ok) return rendered;
  const settings = await readSenderSettings(env);
  if (!settings.senderEmail) {
    return { ok: false as const, message: "Selected email sender is not configured." };
  }
  return sendTransactionalEmail({
    env,
    message: {
      to: [{ email: recipient }],
      sender: { email: settings.senderEmail, name: settings.senderName },
      subject: `[TEST] ${rendered.subject}`,
      html: rendered.htmlBody,
      text: rendered.textBody,
      tags: [key, "astropages_test"],
    },
  });
};

export const listEmailEvents = async (env: RuntimeEnv) =>
  (await all(env, `SELECT * FROM ${tables.emailEvents} ORDER BY event_type`)).map((row) => ({
    eventType: String(row.event_type),
    audience: String(row.audience),
    emailType: String(row.email_type),
    enabled: Number(row.enabled) === 1,
    schedule: parseObject(row.schedule_json),
  }));

export const saveEmailEvent = async (env: RuntimeEnv, input: Record<string, unknown>) => {
  if (!env.DB) throw new Error("Runtime database is not available.");
  const eventType = safeString(input.eventType);
  const audience = safeString(input.audience) || "customer";
  const emailType = safeString(input.emailType) || "transactional";
  if (
    !/^[a-z][a-z0-9_.-]{1,119}$/.test(eventType) ||
    !["transactional", "scheduled", "reminder", "follow_up", "notification", "marketing"]
      .includes(emailType)
  ) {
    throw new Error("Email event contract is invalid.");
  }
  await env.DB.prepare(`INSERT INTO ${tables.emailEvents} (
    event_type, audience, email_type, enabled, schedule_json, updated_at
  ) VALUES (?, ?, ?, 1, ?, ?)
  ON CONFLICT(event_type) DO UPDATE SET
    audience=excluded.audience,
    email_type=excluded.email_type,
    enabled=1,
    schedule_json=excluded.schedule_json,
    updated_at=excluded.updated_at`).bind(
    eventType,
    audience,
    emailType,
    JSON.stringify(parseObject(input.schedule)),
    new Date().toISOString(),
  ).run?.();
  return { eventType, audience, emailType, enabled: true };
};

export const listEmailVariableMappings = async (env: RuntimeEnv) =>
  (await all(
    env,
    `SELECT * FROM ${tables.emailVariableMappings}
     WHERE enabled = 1
     ORDER BY variable_key`,
  )).map((row) => ({
    key: String(row.variable_key),
    sourceType: String(row.source_type),
    sourcePath: String(row.source_path),
    sampleValue: parseValue(row.sample_value_json),
  }));

export const saveEmailVariableMapping = async (
  env: RuntimeEnv,
  input: Record<string, unknown>,
) => {
  if (!env.DB) throw new Error("Runtime database is not available.");
  const key = safeString(input.variableKey) || safeString(input.key);
  const sourceType = safeString(input.sourceType);
  const sourcePath = safeString(input.sourcePath);
  if (
    !validVariable(key) ||
    !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(sourcePath)
  ) {
    throw new Error("Email variable mapping is invalid.");
  }
  if (
    /(?:password|secret|token|credential|private|payment|card|cvv|session|authorization)/i
      .test(`${key}.${sourcePath}`)
  ) {
    throw new Error("Sensitive fields cannot be used as email variables.");
  }
  if (
    sourceType === "business_setting" &&
    !/^notificationSettings\.(businessName|senderName|supportEmail|supportFooter)$/
      .test(sourcePath)
  ) {
    throw new Error("Business setting is not approved.");
  }
  if (
    sourceType === "generated_url" &&
    !/^urls\.(site|order|report|unsubscribe)$/.test(sourcePath)
  ) {
    throw new Error("Generated URL is not approved.");
  }
  if (!["event_payload", "business_setting", "generated_url"].includes(sourceType)) {
    throw new Error("Email variable source is not approved.");
  }
  await env.DB.prepare(`INSERT INTO ${tables.emailVariableMappings} (
    variable_key, source_type, source_path, sample_value_json, enabled, updated_at
  ) VALUES (?, ?, ?, ?, 1, ?)
  ON CONFLICT(variable_key) DO UPDATE SET
    source_type=excluded.source_type,
    source_path=excluded.source_path,
    sample_value_json=excluded.sample_value_json,
    enabled=1,
    updated_at=excluded.updated_at`).bind(
    key,
    sourceType,
    sourcePath,
    input.sampleValue === undefined ? null : JSON.stringify(input.sampleValue),
    new Date().toISOString(),
  ).run?.();
  return { key, sourceType, sourcePath };
};
