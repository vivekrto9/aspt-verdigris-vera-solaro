import { linkNewsletterLead } from "../aggregator/lead-records.ts";
import { getManagedEmailTemplate } from "../aggregator/notifications/email-template-store.ts";
import { readSenderSettings, sendTransactionalEmail, selectedEmailProvider } from "../aggregator/notifications/transactional.ts";
import { renderEmailTemplate } from "../aggregator/notifications/templates.ts";
import {
  all,
  changeCount,
  first,
  isValidEmail,
  normalizeEmail,
  nowIso,
  parseObject,
  randomToken,
  run,
  safeString,
  secureId,
  sha256Hex,
  timingSafeHexEqual,
} from "./db.ts";
import {
  createUnsubscribeToken,
  encryptVeraPrivateJson,
  verifyUnsubscribeToken,
} from "./security.ts";
import type { VeraEnv, VeraRow } from "./types.ts";
import { VERA_TABLES as tables } from "./types.ts";

const templateKeyPattern = /^[a-z0-9][a-z0-9_.-]{1,119}$/;
const eventTypePattern = /^[a-z][a-z0-9_.-]{1,119}$/;
const confirmationTtlMs = 24 * 60 * 60 * 1000;

const siteOrigin = (env: VeraEnv) => {
  const configured = safeString(env.ASTROPAGES_SITE_URL) || safeString(env.SITE_ORIGIN) || safeString(env.SITE_URL);
  try {
    const url = new URL(configured);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
  } catch {
    return "";
  }
};

const safePayload = (value: Record<string, unknown>) => {
  const payload: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 40)) {
    if (/password|card|cvv|authorization|session|private|birth/i.test(key)) continue;
    if (typeof entry === "string") {
      const limit = key === "campaignBody" ? 20_000 : 4_000;
      payload[key] = (key === "campaignBody" ? entry : entry.replace(/[<>\r\n]/g, " ")).slice(0, limit);
    } else if (typeof entry === "number" && Number.isFinite(entry)) payload[key] = entry;
    else if (typeof entry === "boolean") payload[key] = entry;
  }
  return payload;
};

export const enqueueVeraEmail = async ({
  env,
  eventType,
  templateKey,
  recipientEmail,
  recipientName = "",
  payload,
  idempotencyKey,
  availableAt = nowIso(),
}: {
  env: VeraEnv;
  eventType: string;
  templateKey: string;
  recipientEmail: string;
  recipientName?: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  availableAt?: string;
}) => {
  const normalized = normalizeEmail(recipientEmail);
  if (
    !isValidEmail(normalized) || !templateKeyPattern.test(templateKey) ||
    !eventTypePattern.test(eventType) || !safeString(idempotencyKey)
  ) {
    return { ok: false as const, message: "Email outbox input is invalid." };
  }
  const existing = await first(env, `SELECT id, status FROM ${tables.emailOutbox}
    WHERE idempotency_key = ?`, [idempotencyKey]);
  if (existing) return { ok: true as const, outboxId: safeString(existing.id), status: safeString(existing.status), alreadyQueued: true };
  const id = secureId("vmail");
  const now = nowIso();
  await run(env, `INSERT INTO ${tables.emailOutbox}
    (id, event_type, template_key, recipient_email, recipient_name, payload_json,
     status, attempt_count, max_attempts, available_at, locked_at, sent_at,
     provider_message_id, last_error_code, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 5, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING`, [
    id, eventType, templateKey, normalized, safeString(recipientName).slice(0, 120) || null,
    JSON.stringify(safePayload(payload)), availableAt, safeString(idempotencyKey).slice(0, 160), now, now,
  ]);
  const persisted = await first(env, `SELECT id, status FROM ${tables.emailOutbox}
    WHERE idempotency_key = ?`, [idempotencyKey]);
  const outboxId = safeString(persisted?.id) || id;
  if (safeString(persisted?.id) === id && env.EMAIL_QUEUE?.send) {
    try {
      await env.EMAIL_QUEUE.send({ version: 1, kind: "vera-email-outbox", outboxId });
    } catch (error) {
      console.error("Vera email Queue wake-up failed; scheduled delivery will retry.", error);
    }
  }
  return {
    ok: true as const,
    outboxId,
    status: safeString(persisted?.status) || "pending",
    alreadyQueued: safeString(persisted?.id) !== id,
  };
};

const retryAt = (attempt: number, now: Date) =>
  new Date(now.getTime() + Math.min(6 * 60, 5 * (2 ** Math.max(0, attempt - 1))) * 60_000).toISOString();

const markOutboxFailure = async (
  env: VeraEnv,
  row: VeraRow,
  code: string,
  now: Date,
  stopRetry = false,
) => {
  const attempt = Number(row.attempt_count) + 1;
  const dead = stopRetry || attempt >= Number(row.max_attempts || 5);
  await run(env, `UPDATE ${tables.emailOutbox}
    SET status = ?, attempt_count = ?, available_at = ?, locked_at = NULL,
      last_error_code = ?, updated_at = ? WHERE id = ?`, [
    dead ? "dead" : "retry", attempt, retryAt(attempt, now), code, now.toISOString(), safeString(row.id),
  ]);
  if (safeString(row.event_type) === "vera.newsletter.dispatch") {
    await run(env, `UPDATE ${tables.newsletterDeliveries}
      SET status = ?, updated_at = ? WHERE outbox_id = ?`, [
      dead ? "failed" : "queued", now.toISOString(), safeString(row.id),
    ]);
  }
  await run(env, `UPDATE ${tables.followUps}
    SET status = ?, updated_at = ? WHERE outbox_id = ?`, [
    dead ? "cancelled" : "queued", now.toISOString(), safeString(row.id),
  ]);
};

export const processEmailOutbox = async ({
  env,
  limit = 10,
  now = new Date(),
}: {
  env: VeraEnv;
  limit?: number;
  now?: Date;
}) => {
  const batchSize = Math.max(1, Math.min(50, Math.floor(limit)));
  const staleLock = new Date(now.getTime() - 10 * 60_000).toISOString();
  const rows = await all(env, `SELECT * FROM ${tables.emailOutbox}
    WHERE (
      (status IN ('pending', 'retry') AND available_at <= ?)
      OR (status = 'processing' AND locked_at < ?)
    )
    ORDER BY available_at, created_at LIMIT ?`, [now.toISOString(), staleLock, batchSize]);
  let sent = 0;
  let retried = 0;
  let suppressed = 0;
  const missing = new Set<string>();
  for (const row of rows) {
    const provider = row.delivery_provider === "gmail" || row.delivery_provider === "ses" ? row.delivery_provider : await selectedEmailProvider(env);
    const claimed = await run(env, `UPDATE ${tables.emailOutbox}
      SET status = 'processing', locked_at = ?, updated_at = ?, delivery_provider = ?
      WHERE id = ? AND (
        (status IN ('pending', 'retry') AND available_at <= ?)
        OR (status = 'processing' AND locked_at < ?)
      )`, [now.toISOString(), now.toISOString(), provider, safeString(row.id), now.toISOString(), staleLock]);
    if (changeCount(claimed) !== 1) continue;
    if (provider === "gmail" && row.status === "processing") {
      await markOutboxFailure(env, row, "gmail_delivery_unknown", now, true);
      retried += 1;
      continue;
    }
    const normalizedEmail = normalizeEmail(row.recipient_email);
    const suppression = await first(env, `SELECT reason FROM ${tables.emailSuppressions}
      WHERE normalized_email = ?`, [normalizedEmail]);
    const payload = parseObject(row.payload_json);
    const subscriptionId = safeString(payload.subscriptionId);
    const activeSubscription = subscriptionId
      ? await first(env, `SELECT status FROM ${tables.newsletterSubscriptions} WHERE id = ?`, [subscriptionId])
      : null;
    const marketingEvent = safeString(row.event_type) === "vera.newsletter.dispatch";
    const suppressionReason = safeString(suppression?.reason);
    const recipientSuppressed = Boolean(suppressionReason) &&
      (suppressionReason !== "unsubscribe" || marketingEvent);
    const marketingInactive = marketingEvent &&
      safeString(activeSubscription?.status) !== "subscribed";
    if (recipientSuppressed || marketingInactive) {
      await run(env, `UPDATE ${tables.emailOutbox}
        SET status = 'cancelled', locked_at = NULL, last_error_code = ?, updated_at = ? WHERE id = ?`, [
        recipientSuppressed ? "recipient_suppressed" : "subscription_inactive", now.toISOString(), safeString(row.id),
      ]);
      await run(env, `UPDATE ${tables.newsletterDeliveries}
        SET status = 'cancelled', updated_at = ? WHERE outbox_id = ?`, [now.toISOString(), safeString(row.id)]);
      await run(env, `UPDATE ${tables.followUps}
        SET status = 'cancelled', updated_at = ? WHERE outbox_id = ?`, [now.toISOString(), safeString(row.id)]);
      suppressed += 1;
      continue;
    }
    const template = await getManagedEmailTemplate(env, safeString(row.template_key));
    if (!template) {
      await markOutboxFailure(env, row, "template_missing", now);
      retried += 1;
      continue;
    }
    const rendered = renderEmailTemplate({ template, payload });
    if (!rendered.ok) {
      await markOutboxFailure(env, row, "template_render_failed", now);
      retried += 1;
      continue;
    }
    const sender = await readSenderSettings(env, provider);
    if (!sender.senderEmail) {
      missing.add(provider === "gmail" ? "GMAIL_SENDER_EMAIL" : "SES_SENDER_EMAIL");
      await markOutboxFailure(env, row, "provider_not_configured", now);
      retried += 1;
      continue;
    }
    const result = await sendTransactionalEmail({
      env, provider,
      message: {
        to: [{ email: normalizedEmail, name: safeString(row.recipient_name) || undefined }],
        sender: { email: sender.senderEmail, name: sender.senderName },
        subject: rendered.subject,
        html: rendered.htmlBody,
        text: rendered.textBody,
        tags: [safeString(row.template_key), "vera"],
      },
    });
    if (!result.ok) {
      for (const name of ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
        if (result.message.includes(name)) missing.add(name);
      }
      const unknown = "outcomeUnknown" in result && result.outcomeUnknown === true;
      await markOutboxFailure(env, row, unknown ? "gmail_delivery_unknown" : result.message.includes("setup is incomplete") ? "provider_not_configured" : "provider_send_failed", now, unknown);
      retried += 1;
      continue;
    }
    await run(env, `UPDATE ${tables.emailOutbox}
      SET status = 'sent', attempt_count = attempt_count + 1, locked_at = NULL,
        sent_at = ?, provider_message_id = ?, last_error_code = NULL, updated_at = ?
      WHERE id = ?`, [now.toISOString(), result.providerMessageId, now.toISOString(), safeString(row.id)]);
    await run(env, `UPDATE ${tables.newsletterDeliveries}
      SET status = 'sent', updated_at = ? WHERE outbox_id = ?`, [now.toISOString(), safeString(row.id)]);
    await run(env, `UPDATE ${tables.followUps}
      SET status = 'sent', updated_at = ? WHERE outbox_id = ?`, [now.toISOString(), safeString(row.id)]);
    sent += 1;
  }
  return {
    ok: missing.size === 0,
    processed: sent + retried + suppressed,
    sent,
    retried,
    suppressed,
    missingSecretNames: [...missing],
  };
};

export const dispatchDueFollowUps = async ({
  env,
  limit = 50,
  now = new Date(),
}: {
  env: VeraEnv;
  limit?: number;
  now?: Date;
}) => {
  const origin = siteOrigin(env);
  if (!origin) {
    return { ok: false as const, dispatched: 0, missingSecretNames: ["ASTROPAGES_SITE_URL"] };
  }
  const rows = await all(env, `SELECT follow_up.*, booking.booking_number,
      booking.customer_name, booking.email, booking.mode, booking.status AS booking_status,
      booking.selected_start_at, booking.balance_cents, booking.calendly_meeting_url,
      service.name AS service_name
    FROM ${tables.followUps} follow_up
    JOIN ${tables.bookings} booking ON booking.id = follow_up.booking_id
    JOIN ${tables.services} service ON service.slug = booking.service_slug
    WHERE follow_up.status = 'pending' AND follow_up.due_at <= ?
    ORDER BY follow_up.due_at LIMIT ?`, [now.toISOString(), Math.max(1, Math.min(200, Math.floor(limit)))]);
  let dispatched = 0;
  for (const row of rows) {
    const followUpId = safeString(row.id);
    const bookingId = safeString(row.booking_id);
    const terminal = ["cancelled", "expired", "refunded"].includes(safeString(row.booking_status));
    const balanceResolved = safeString(row.kind) === "balance_reminder" && Number(row.balance_cents) <= 0;
    if (terminal || balanceResolved) {
      await run(env, `UPDATE ${tables.followUps}
        SET status = 'cancelled', updated_at = ? WHERE id = ?`, [now.toISOString(), followUpId]);
      continue;
    }
    const accountUrl = new URL("/account", origin);
    const common = {
      customerName: safeString(row.customer_name),
      bookingNumber: safeString(row.booking_number),
      serviceName: safeString(row.service_name),
      scheduledDateTime: safeString(row.selected_start_at),
      balanceAmount: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
        .format(Number(row.balance_cents) / 100),
      meetingDetails: safeString(row.mode) === "call"
        ? safeString(row.calendly_meeting_url)
        : "Reading room, Via delle Stelle 12 — second floor",
      accountUrl: accountUrl.toString(),
      bookingId,
    };
    const workflows: Record<string, readonly [string, string]> = {
      balance_reminder: ["vera.booking.balance_reminder", "vera_balance_reminder_en"],
      intake_reminder: ["vera.booking.intake_reminder", "vera_intake_reminder_en"],
      session_reminder: ["vera.booking.session_reminder", "vera_session_reminder_en"],
      post_session: ["vera.booking.post_session", "vera_post_session_en"],
    };
    const workflow = workflows[safeString(row.kind)];
    if (!workflow) {
      await run(env, `UPDATE ${tables.followUps}
        SET status = 'cancelled', updated_at = ? WHERE id = ?`, [now.toISOString(), followUpId]);
      continue;
    }
    const queued = await enqueueVeraEmail({
      env,
      eventType: workflow[0],
      templateKey: workflow[1],
      recipientEmail: safeString(row.email),
      recipientName: safeString(row.customer_name),
      payload: common,
      idempotencyKey: `follow-up:${followUpId}`,
    });
    if (!queued.ok) continue;
    await run(env, `UPDATE ${tables.followUps}
      SET status = 'queued', outbox_id = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`, [queued.outboxId, now.toISOString(), followUpId]);
    dispatched += queued.alreadyQueued ? 0 : 1;
  }
  return { ok: true as const, dispatched, missingSecretNames: [] as string[] };
};

const confirmationUrl = (env: VeraEnv, id: string, token: string) => {
  const origin = siteOrigin(env);
  if (!origin) return "";
  const url = new URL("/api/astropages/generated-site/vera/newsletter/confirm", origin);
  url.searchParams.set("id", id);
  url.searchParams.set("token", token);
  return url.toString();
};

export const subscribeVeraNewsletter = async ({
  env,
  email,
  displayName,
  locale = "en",
  source = "website",
  birthDate,
  birthTime,
}: {
  env: VeraEnv;
  email: unknown;
  displayName?: unknown;
  locale?: unknown;
  source?: unknown;
  birthDate?: unknown;
  birthTime?: unknown;
}) => {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) return { ok: false as const, status: 400, message: "Enter a valid email address." };
  const optionalBirthDate = safeString(birthDate).slice(0, 80);
  const optionalBirthTime = safeString(birthTime).slice(0, 80);
  const birthDetailsEncrypted = optionalBirthDate || optionalBirthTime
    ? await encryptVeraPrivateJson(env, {
        birthDate: optionalBirthDate,
        birthTime: optionalBirthTime,
      })
    : null;
  if ((optionalBirthDate || optionalBirthTime) && !birthDetailsEncrypted) {
    return {
      ok: false as const,
      status: 503,
      message: "Private newsletter details are not configured.",
      missingSecretNames: ["EMDASH_ENCRYPTION_KEY"],
    };
  }
  const origin = siteOrigin(env);
  if (!origin) {
    return { ok: false as const, status: 503, message: "Newsletter confirmation is not configured.", missingSecretNames: ["ASTROPAGES_SITE_URL"] };
  }
  const blocked = await first(env, `SELECT reason FROM ${tables.emailSuppressions}
    WHERE normalized_email = ? AND reason IN ('bounce', 'complaint', 'manual')`, [normalized]);
  if (blocked) return { ok: true as const, status: 202, message: "If eligible, confirmation instructions will be sent." };
  const existing = await first(env, `SELECT * FROM ${tables.newsletterSubscriptions}
    WHERE normalized_email = ?`, [normalized]);
  if (safeString(existing?.status) === "subscribed") {
    return { ok: true as const, status: 202, message: "If eligible, confirmation instructions will be sent." };
  }
  const id = safeString(existing?.id) || secureId("vsub");
  const token = randomToken(32);
  const tokenHash = await sha256Hex(`vera-confirm:v1:${id}:${token}`);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + confirmationTtlMs).toISOString();
  await run(env, `INSERT INTO ${tables.newsletterSubscriptions}
    (id, email, normalized_email, display_name, locale, source, birth_details_encrypted, status, consent_at,
     confirmation_token_hash, confirmation_expires_at, confirmation_sent_at,
     confirmed_at, unsubscribed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, ?, ?)
    ON CONFLICT(normalized_email) DO UPDATE SET
      email = excluded.email, display_name = excluded.display_name,
      locale = excluded.locale, source = excluded.source, status = 'pending',
      birth_details_encrypted = COALESCE(
        excluded.birth_details_encrypted,
        ${tables.newsletterSubscriptions}.birth_details_encrypted
      ),
      consent_at = excluded.consent_at,
      confirmation_token_hash = excluded.confirmation_token_hash,
      confirmation_expires_at = excluded.confirmation_expires_at,
      confirmation_sent_at = excluded.confirmation_sent_at,
      unsubscribed_at = NULL, updated_at = excluded.updated_at`, [
    id, normalized, normalized, safeString(displayName).slice(0, 120) || null,
    safeString(locale).slice(0, 10) || "en", safeString(source).slice(0, 80) || "website",
    birthDetailsEncrypted, now.toISOString(), tokenHash, expiresAt, now.toISOString(),
    now.toISOString(), now.toISOString(),
  ]);
  await run(env, `DELETE FROM ${tables.emailSuppressions}
    WHERE normalized_email = ? AND reason = 'unsubscribe'`, [normalized]);
  const queued = await enqueueVeraEmail({
    env,
    eventType: "vera.newsletter.confirm",
    templateKey: "vera_newsletter_confirm_en",
    recipientEmail: normalized,
    recipientName: safeString(displayName),
    payload: {
      customerName: safeString(displayName) || "Reader",
      confirmationUrl: confirmationUrl(env, id, token),
      subscriptionId: id,
    },
    idempotencyKey: `newsletter-confirm:${id}:${tokenHash.slice(0, 16)}`,
  });
  return queued.ok
    ? { ok: true as const, status: 202, message: "Check your email to confirm the subscription." }
    : { ok: false as const, status: 503, message: queued.message };
};

export const confirmVeraNewsletter = async ({
  env,
  subscriptionId,
  token,
}: {
  env: VeraEnv;
  subscriptionId: unknown;
  token: unknown;
}) => {
  const id = safeString(subscriptionId);
  const rawToken = safeString(token);
  const row = id ? await first(env, `SELECT * FROM ${tables.newsletterSubscriptions} WHERE id = ?`, [id]) : null;
  if (!row || !rawToken || safeString(row.status) !== "pending") {
    return { ok: false as const, status: 400, message: "Confirmation link is invalid or expired." };
  }
  const expected = await sha256Hex(`vera-confirm:v1:${id}:${rawToken}`);
  if (
    !timingSafeHexEqual(expected, safeString(row.confirmation_token_hash)) ||
    new Date(safeString(row.confirmation_expires_at)).getTime() < Date.now()
  ) {
    return { ok: false as const, status: 400, message: "Confirmation link is invalid or expired." };
  }
  const now = nowIso();
  await run(env, `UPDATE ${tables.newsletterSubscriptions}
    SET status = 'subscribed', confirmed_at = ?, confirmation_token_hash = NULL,
      confirmation_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'pending'`, [now, now, id]);
  await linkNewsletterLead({
    env,
    email: safeString(row.email),
    locale: safeString(row.locale) || "en",
    source: "newsletter",
    subscriptionId: id,
  });
  return { ok: true as const, status: 200, message: "Subscription confirmed." };
};

export const unsubscribeVeraNewsletter = async ({ env, token }: { env: VeraEnv; token: unknown }) => {
  const id = await verifyUnsubscribeToken(env, token);
  if (!id) return { ok: false as const, status: 400, message: "Unsubscribe link is invalid." };
  const row = await first(env, `SELECT normalized_email FROM ${tables.newsletterSubscriptions} WHERE id = ?`, [id]);
  if (!row) return { ok: false as const, status: 400, message: "Unsubscribe link is invalid." };
  const now = nowIso();
  const normalized = normalizeEmail(row.normalized_email);
  await run(env, `UPDATE ${tables.newsletterSubscriptions}
    SET status = 'unsubscribed', birth_details_encrypted = NULL,
      unsubscribed_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
  await run(env, `INSERT INTO ${tables.emailSuppressions}
    (normalized_email, reason, provider_event_id, detail_code, created_at, updated_at)
    VALUES (?, 'unsubscribe', NULL, NULL, ?, ?)
    ON CONFLICT(normalized_email) DO UPDATE SET reason = 'unsubscribe', updated_at = excluded.updated_at`, [normalized, now, now]);
  await run(env, `UPDATE ${tables.emailOutbox}
    SET status = 'cancelled', last_error_code = 'subscription_inactive', updated_at = ?
    WHERE recipient_email = ? AND event_type = 'vera.newsletter.dispatch'
      AND status IN ('pending', 'retry')`, [now, normalized]);
  await run(env, `UPDATE ap_leads SET consent_marketing = 0, updated_at = ?
    WHERE normalized_email = ? AND kind = 'newsletter'`, [now, normalized]).catch(() => undefined);
  return { ok: true as const, status: 200, message: "You have been unsubscribed." };
};

export const suppressVeraEmail = async ({
  env,
  email,
  reason,
  providerEventId = "",
  detailCode = "",
}: {
  env: VeraEnv;
  email: unknown;
  reason: "bounce" | "complaint" | "manual";
  providerEventId?: string;
  detailCode?: string;
}) => {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) return { ok: false as const, message: "Suppression email is invalid." };
  const now = nowIso();
  await run(env, `INSERT INTO ${tables.emailSuppressions}
    (normalized_email, reason, provider_event_id, detail_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(normalized_email) DO UPDATE SET reason = excluded.reason,
      provider_event_id = excluded.provider_event_id, detail_code = excluded.detail_code,
      updated_at = excluded.updated_at`, [
    normalized, reason, safeString(providerEventId).slice(0, 160) || null,
    safeString(detailCode).slice(0, 120) || null, now, now,
  ]);
  await run(env, `UPDATE ${tables.newsletterSubscriptions}
    SET status = 'suppressed', updated_at = ? WHERE normalized_email = ?`, [now, normalized]);
  await run(env, `UPDATE ${tables.emailOutbox}
    SET status = 'cancelled', last_error_code = 'recipient_suppressed', updated_at = ?
    WHERE recipient_email = ? AND status IN ('pending', 'retry')`, [now, normalized]);
  return { ok: true as const };
};

export const dispatchDueCampaigns = async ({
  env,
  campaignLimit = 2,
  recipientBatchSize = 100,
  now = new Date(),
}: {
  env: VeraEnv;
  campaignLimit?: number;
  recipientBatchSize?: number;
  now?: Date;
}) => {
  if (!siteOrigin(env)) {
    return { ok: false as const, dispatched: 0, missingSecretNames: ["ASTROPAGES_SITE_URL"] };
  }
  const campaigns = await all(env, `SELECT * FROM ${tables.newsletterCampaigns}
    WHERE status IN ('scheduled', 'dispatching') AND scheduled_for <= ?
    ORDER BY scheduled_for LIMIT ?`, [now.toISOString(), Math.max(1, Math.min(10, campaignLimit))]);
  let dispatched = 0;
  for (const campaign of campaigns) {
    const campaignId = safeString(campaign.id);
    await run(env, `UPDATE ${tables.newsletterCampaigns}
      SET status = 'dispatching', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`, [
      now.toISOString(), now.toISOString(), campaignId,
    ]);
    const cursor = safeString(campaign.dispatch_cursor);
    const subscribers = await all(env, `SELECT subscription.*
      FROM ${tables.newsletterSubscriptions} subscription
      LEFT JOIN ${tables.emailSuppressions} suppression
        ON suppression.normalized_email = subscription.normalized_email
      WHERE subscription.status = 'subscribed' AND suppression.normalized_email IS NULL
        AND subscription.id > ?
      ORDER BY subscription.id LIMIT ?`, [cursor, Math.max(1, Math.min(500, recipientBatchSize))]);
    const campaignPayload = parseObject(campaign.payload_json);
    let lastId = cursor;
    for (const subscription of subscribers) {
      const subscriptionId = safeString(subscription.id);
      const unsubscribeToken = await createUnsubscribeToken(env, subscriptionId);
      if (!unsubscribeToken) {
        return { ok: false as const, dispatched, missingSecretNames: ["EMDASH_ENCRYPTION_KEY"] };
      }
      const unsubscribeUrl = new URL("/api/astropages/generated-site/vera/newsletter/unsubscribe", siteOrigin(env));
      unsubscribeUrl.searchParams.set("token", unsubscribeToken);
      const outbox = await enqueueVeraEmail({
        env,
        eventType: "vera.newsletter.dispatch",
        templateKey: safeString(campaign.template_key),
        recipientEmail: safeString(subscription.email),
        recipientName: safeString(subscription.display_name),
        payload: {
          ...campaignPayload,
          customerName: safeString(subscription.display_name) || "Reader",
          unsubscribeUrl: unsubscribeUrl.toString(),
          subscriptionId,
          campaignId,
        },
        idempotencyKey: `campaign:${campaignId}:subscription:${subscriptionId}`,
      });
      if (outbox.ok) {
        const deliveryId = secureId("vdelivery");
        await run(env, `INSERT INTO ${tables.newsletterDeliveries}
          (id, campaign_id, subscription_id, outbox_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'queued', ?, ?)
          ON CONFLICT(campaign_id, subscription_id) DO UPDATE SET
            outbox_id = COALESCE(${tables.newsletterDeliveries}.outbox_id, excluded.outbox_id),
            updated_at = excluded.updated_at`, [
          deliveryId, campaignId, subscriptionId, outbox.outboxId, now.toISOString(), now.toISOString(),
        ]);
        dispatched += outbox.alreadyQueued ? 0 : 1;
      }
      lastId = subscriptionId;
    }
    if (subscribers.length === 0) {
      await run(env, `UPDATE ${tables.newsletterCampaigns}
        SET status = 'sent', completed_at = ?, updated_at = ? WHERE id = ?`, [now.toISOString(), now.toISOString(), campaignId]);
    } else {
      await run(env, `UPDATE ${tables.newsletterCampaigns}
        SET dispatch_cursor = ?, updated_at = ? WHERE id = ?`, [lastId, now.toISOString(), campaignId]);
    }
  }
  return { ok: true as const, dispatched, missingSecretNames: [] as string[] };
};
