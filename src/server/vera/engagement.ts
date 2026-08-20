import { getCustomerSession } from "../aggregator/customer-auth.ts";
import {
  isValidLeadPhone,
  linkBusinessLead,
  normalizeLeadPhone,
} from "../aggregator/lead-records.ts";
import { isVeraMode, normalizeVeraServiceSlug } from "./catalog.ts";
import {
  first,
  isValidEmail,
  normalizeEmail,
  nowIso,
  run,
  safeString,
  secureId,
} from "./db.ts";
import type { VeraEnv } from "./types.ts";
import { VERA_TABLES as tables } from "./types.ts";

const accountForEmail = async (env: VeraEnv, request: Request, email: string) => {
  const session = await getCustomerSession(env, request);
  return session && normalizeEmail(session.account.email) === email ? session.account.id : null;
};

const contactFields = (input: Record<string, unknown>) => {
  const customerName = safeString(input.name).slice(0, 120);
  const email = normalizeEmail(input.email);
  const rawPhone = safeString(input.phone).slice(0, 32);
  const phone = normalizeLeadPhone(rawPhone);
  if (customerName.length < 2 || !isValidEmail(email)) {
    return { ok: false as const, message: "Name and a valid email address are required." };
  }
  if (phone && !isValidLeadPhone(phone)) {
    return { ok: false as const, message: "Enter a valid phone number." };
  }
  if (input.consentContact !== true) {
    return { ok: false as const, message: "Contact consent is required." };
  }
  return { ok: true as const, customerName, email, rawPhone, phone };
};

export const submitVeraContact = async ({
  env,
  request,
  input,
}: {
  env: VeraEnv;
  request: Request;
  input: Record<string, unknown>;
}) => {
  if (safeString(input.website)) {
    return { ok: true as const, status: 202, message: "Message received." };
  }
  const contact = contactFields(input);
  if (!contact.ok) return { ...contact, status: 400 };
  const topic = safeString(input.topic).slice(0, 120);
  const message = safeString(input.message).slice(0, 5_000);
  if (!topic || message.length < 10) {
    return { ok: false as const, status: 400, message: "Choose a topic and write a message." };
  }
  const id = secureId("vcontact");
  const now = nowIso();
  const accountId = await accountForEmail(env, request, contact.email);
  await run(env, `INSERT INTO ${tables.contacts}
    (id, account_id, customer_name, email, normalized_email, phone, topic,
     message, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`, [
    id, accountId, contact.customerName, contact.email, contact.email,
    contact.phone || null, topic, message, now, now,
  ]);
  await linkBusinessLead({
    env,
    submission: {
      kind: "contact",
      source: "contact",
      formKey: "vera-contact",
      pagePath: "/contact",
      fullName: contact.customerName,
      email: contact.email,
      phone: contact.rawPhone,
      consentMarketing: input.consentMarketing === true,
      customerAccountId: accountId || undefined,
      sourceReferenceType: "vera_contact_request",
      sourceReferenceId: id,
      details: { topic },
    },
  });
  return { ok: true as const, status: 201, message: "Message received.", requestId: id };
};

export const joinVeraWaitlist = async ({
  env,
  request,
  input,
}: {
  env: VeraEnv;
  request: Request;
  input: Record<string, unknown>;
}) => {
  if (safeString(input.website)) {
    return { ok: true as const, status: 202, message: "Waitlist request received." };
  }
  const contact = contactFields(input);
  if (!contact.ok) return { ...contact, status: 400 };
  const serviceSlug = safeString(input.serviceSlug)
    ? normalizeVeraServiceSlug(input.serviceSlug)
    : "";
  const mode = safeString(input.mode);
  if (safeString(input.serviceSlug) && !serviceSlug) {
    return { ok: false as const, status: 400, message: "Waitlist sitting is invalid." };
  }
  if (mode && !isVeraMode(mode)) {
    return { ok: false as const, status: 400, message: "Waitlist format is invalid." };
  }
  const earliestDate = safeString(input.earliestDate);
  const latestDate = safeString(input.latestDate);
  if (
    (earliestDate && !/^\d{4}-\d{2}-\d{2}$/.test(earliestDate)) ||
    (latestDate && !/^\d{4}-\d{2}-\d{2}$/.test(latestDate)) ||
    (earliestDate && latestDate && earliestDate > latestDate)
  ) {
    return { ok: false as const, status: 400, message: "Waitlist date range is invalid." };
  }
  const existing = await first(env, `SELECT id FROM ${tables.waitlist}
    WHERE normalized_email = ? AND IFNULL(service_slug, '') = ?
      AND IFNULL(mode, '') = ? AND status = 'active'`, [contact.email, serviceSlug, mode]);
  const id = safeString(existing?.id) || secureId("vwait");
  const now = nowIso();
  const accountId = await accountForEmail(env, request, contact.email);
  const service = serviceSlug
    ? await first(env, `SELECT name FROM ${tables.services} WHERE slug = ?`, [serviceSlug])
    : null;
  if (existing) {
    await run(env, `UPDATE ${tables.waitlist}
      SET account_id = COALESCE(?, account_id), customer_name = ?, phone = ?,
        earliest_date = ?, latest_date = ?, short_notice = ?, updated_at = ?
      WHERE id = ?`, [
      accountId, contact.customerName, contact.phone || null, earliestDate || null,
      latestDate || null, input.shortNotice === false ? 0 : 1, now, id,
    ]);
  } else {
    await run(env, `INSERT INTO ${tables.waitlist}
      (id, account_id, customer_name, email, normalized_email, phone, service_slug,
       mode, earliest_date, latest_date, short_notice, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`, [
      id, accountId, contact.customerName, contact.email, contact.email,
      contact.phone || null, serviceSlug || null, mode || null,
      earliestDate || null, latestDate || null, input.shortNotice === false ? 0 : 1,
      now, now,
    ]);
  }
  await linkBusinessLead({
    env,
    submission: {
      kind: "waitlist",
      source: "waitlist",
      formKey: "vera-waitlist",
      pagePath: "/booking",
      fullName: contact.customerName,
      email: contact.email,
      phone: contact.rawPhone,
      consentMarketing: input.consentMarketing === true,
      customerAccountId: accountId || undefined,
      sourceReferenceType: "vera_waitlist_entry",
      sourceReferenceId: id,
      details: {
        serviceSlug,
        serviceName: safeString(service?.name),
        consultationMode: mode,
        earliestDate,
        latestDate,
        shortNotice: input.shortNotice === false ? false : true,
      },
    },
  });
  const position = await first(env, `SELECT COUNT(*) AS position
    FROM ${tables.waitlist} entry
    WHERE entry.status = 'active' AND (
      entry.created_at < (SELECT created_at FROM ${tables.waitlist} WHERE id = ?)
      OR (
        entry.created_at = (SELECT created_at FROM ${tables.waitlist} WHERE id = ?)
        AND entry.id <= ?
      )
    )`, [id, id, id]);
  const active = await first(env, `SELECT COUNT(*) AS count FROM ${tables.waitlist}
    WHERE status = 'active'`);
  return {
    ok: true as const,
    status: existing ? 200 : 201,
    message: "Waitlist request received.",
    waitlistId: id,
    waitPosition: Number(position?.position || 0),
    activeWaitlistCount: Number(active?.count || 0),
  };
};
