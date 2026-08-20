import { getCustomerSession } from "../aggregator/customer-auth.ts";
import { all, changeCount, first, normalizeEmail, nowIso, run, runStatements, safeString, secureId } from "./db.ts";
import { decryptVeraPrivateJson, getVeraBookingAccess } from "./security.ts";
import { enqueueVeraEmail } from "./email.ts";
import { normalizeVeraBirthTimeApproximation } from "./places.ts";
import type { VeraEnv, VeraRow } from "./types.ts";
import { VERA_TABLES as tables } from "./types.ts";

const requireAccount = async (env: VeraEnv, request: Request, mutate = false) => {
  const session = await getCustomerSession(env, request);
  if (!session) return { ok: false as const, status: 401, message: "Customer login is required." };
  if (mutate && request.headers.get("x-csrf-token") !== session.csrfToken) {
    return { ok: false as const, status: 403, message: "Security token is invalid. Refresh and try again." };
  }
  return { ok: true as const, session };
};

export const getVeraAccountPortal = async (env: VeraEnv, request: Request) => {
  const auth = await requireAccount(env, request);
  if (!auth.ok) return auth;
  const accountId = auth.session.account.id;
  const accountEmail = normalizeEmail(auth.session.account.email);
  if (accountEmail && env.DB) {
    const claimableBookings = await all(env, `SELECT id FROM ${tables.bookings}
      WHERE account_id IS NULL AND normalized_email = ?`, [accountEmail]);
    const claimedAt = nowIso();
    await runStatements(env, [
      env.DB.prepare(`UPDATE ${tables.bookings}
        SET account_id = ?, manage_token_hash = NULL,
          manage_token_expires_at = NULL, updated_at = ?
        WHERE account_id IS NULL AND normalized_email = ?`)
        .bind(accountId, claimedAt, accountEmail),
      env.DB.prepare(`UPDATE ${tables.waitlist}
        SET account_id = ?, updated_at = ?
        WHERE account_id IS NULL AND normalized_email = ?`)
        .bind(accountId, claimedAt, accountEmail),
      ...claimableBookings.map((booking) => env.DB!.prepare(`INSERT INTO ${tables.bookingEvents}
        (id, booking_id, event_type, actor_type, metadata_json, created_at)
        SELECT ?, ?, 'account.claimed', 'customer', '{}', ?
        WHERE EXISTS (
          SELECT 1 FROM ${tables.bookings} WHERE id = ? AND account_id = ?
        )`)
        .bind(secureId("vbe"), safeString(booking.id), claimedAt, safeString(booking.id), accountId)),
    ]);
  }
  if (env.DB) {
    const completedBookings = await all(env, `SELECT id FROM ${tables.bookings}
      WHERE account_id = ? AND status = 'completed'`, [accountId]);
    if (completedBookings.length) {
      const openedAt = nowIso();
      await runStatements(env, completedBookings.map((booking) => env.DB!.prepare(`INSERT OR IGNORE INTO ${tables.messageThreads}
        (id, account_id, booking_id, subject, status, created_at, updated_at)
        VALUES (?, ?, ?, 'One follow-up question', 'open', ?, ?)`)
        .bind(secureId("vthread"), accountId, safeString(booking.id), openedAt, openedAt)));
    }
  }
  const [bookings, invoices, reports, files, threads, waitlist] = await Promise.all([
    all(env, `SELECT id, booking_number, service_slug, mode, status, payment_state,
      selected_start_at, selected_end_at, price_cents, gift_applied_cents, paid_cents,
      balance_cents, currency, free_reschedule_used, reschedule_count,
      calendly_meeting_url, calendly_reschedule_url, cancelled_at,
      scheduling_error, encrypted_intake, created_at, updated_at
      FROM ${tables.bookings} WHERE account_id = ? ORDER BY selected_start_at DESC`, [accountId]),
    all(env, `SELECT id, booking_id, invoice_number, status, amount_cents, currency,
      issued_at, updated_at FROM ${tables.invoices}
      WHERE booking_id IN (SELECT id FROM ${tables.bookings} WHERE account_id = ?)
      ORDER BY issued_at DESC`, [accountId]),
    all(env, `SELECT id, booking_id, title, encrypted_payload, published_at, updated_at
      FROM ${tables.reports} WHERE account_id = ? AND status = 'published'
      ORDER BY published_at DESC`, [accountId]),
    all(env, `SELECT id, booking_id, report_id, kind, file_name, content_type,
      size_bytes, created_at FROM ${tables.privateFiles}
      WHERE account_id = ? ORDER BY created_at DESC`, [accountId]),
    all(env, `SELECT id, booking_id, subject, status, created_at, updated_at
      FROM ${tables.messageThreads} WHERE account_id = ? ORDER BY updated_at DESC`, [accountId]),
    all(env, `SELECT id, service_slug, mode, earliest_date, latest_date, short_notice,
      status, created_at, updated_at FROM ${tables.waitlist}
      WHERE account_id = ? ORDER BY created_at DESC`, [accountId]),
  ]);
  const renderedReports = await Promise.all(reports.map(async (report) => ({
    id: safeString(report.id),
    bookingId: safeString(report.booking_id),
    title: safeString(report.title),
    content: safeString(report.encrypted_payload)
      ? await decryptVeraPrivateJson(env, safeString(report.encrypted_payload)).catch(() => null)
      : null,
    publishedAt: safeString(report.published_at),
    updatedAt: safeString(report.updated_at),
  })));
  const renderedBookings = await Promise.all(bookings.map(async (booking) => {
    const { encrypted_intake: encryptedIntake, ...publicBooking } = booking;
    const privateIntake = safeString(encryptedIntake)
      ? await decryptVeraPrivateJson(env, safeString(encryptedIntake)).catch(() => null)
      : null;
    const intake = privateIntake && typeof privateIntake === "object" && !Array.isArray(privateIntake)
      ? privateIntake as VeraRow
      : null;
    const birthTimeUnknown = intake?.birthTimeUnknown === true;
    const birthTimeApproximation = birthTimeUnknown
      ? normalizeVeraBirthTimeApproximation(intake?.birthTimeApproximation)
      : "";
    return {
      ...publicBooking,
      intake: intake
        ? {
            birthDate: safeString(intake.birthDate),
            birthTime: safeString(intake.birthTime),
            birthTimeUnknown,
            ...(birthTimeApproximation ? { birthTimeApproximation } : {}),
            birthPlace: safeString(intake.birthPlace),
          }
        : null,
    };
  }));
  return {
    ok: true as const,
    status: 200,
    account: auth.session.account,
    csrfToken: auth.session.csrfToken,
    bookings: renderedBookings,
    invoices,
    reports: renderedReports,
    files,
    threads,
    waitlist,
  };
};

export const resendVeraBookingReceipt = async (
  env: VeraEnv,
  request: Request,
  input: Record<string, unknown>,
) => {
  const auth = await requireAccount(env, request, true);
  if (!auth.ok) return auth;
  const bookingId = safeString(input.bookingId);
  const booking = bookingId
    ? await first(env, `SELECT booking.id, booking.booking_number, booking.customer_name,
        booking.email, booking.selected_start_at, booking.price_cents,
        booking.paid_cents, booking.balance_cents, booking.currency,
        service.name AS service_name
      FROM ${tables.bookings} booking
      JOIN ${tables.services} service ON service.slug = booking.service_slug
      WHERE booking.id = ? AND booking.account_id = ?`, [bookingId, auth.session.account.id])
    : null;
  if (!booking) {
    return { ok: false as const, status: 404, message: "Booking receipt was not found." };
  }
  const origin = new URL(request.url).origin;
  const queued = await enqueueVeraEmail({
    env,
    eventType: "vera.receipt.issued",
    templateKey: "vera_receipt_en",
    recipientEmail: safeString(booking.email),
    recipientName: safeString(booking.customer_name),
    payload: {
      customerName: safeString(booking.customer_name),
      bookingNumber: safeString(booking.booking_number),
      serviceName: safeString(booking.service_name),
      scheduledDateTime: safeString(booking.selected_start_at),
      priceAmount: new Intl.NumberFormat("en-US", { style: "currency", currency: safeString(booking.currency) || "USD" })
        .format(Number(booking.price_cents) / 100),
      paidAmount: new Intl.NumberFormat("en-US", { style: "currency", currency: safeString(booking.currency) || "USD" })
        .format(Number(booking.paid_cents) / 100),
      balanceAmount: new Intl.NumberFormat("en-US", { style: "currency", currency: safeString(booking.currency) || "USD" })
        .format(Number(booking.balance_cents) / 100),
      accountUrl: `${origin}/account`,
    },
    idempotencyKey: `receipt-resend:${bookingId}:${Math.floor(Date.now() / 300_000)}`,
  });
  return queued.ok
    ? { ok: true as const, status: 202, message: "Booking receipt queued." }
    : { ok: false as const, status: 400, message: queued.message };
};

export const claimVeraBookingToAccount = async (
  env: VeraEnv,
  request: Request,
  input: Record<string, unknown>,
) => {
  const auth = await requireAccount(env, request, true);
  if (!auth.ok) return auth;
  const bookingId = safeString(input.bookingId);
  const manageToken = safeString(input.manageToken);
  if (!bookingId || !manageToken) {
    return { ok: false as const, status: 400, message: "Booking access is invalid." };
  }
  const access = await getVeraBookingAccess({ env, request, bookingId, manageToken });
  if (!access.ok) return access;
  const accountId = auth.session.account.id;
  const accountEmail = normalizeEmail(auth.session.account.email);
  if (!accountEmail || normalizeEmail(access.booking.normalized_email) !== accountEmail) {
    return { ok: false as const, status: 403, message: "Booking access is invalid." };
  }
  const currentAccountId = safeString(access.booking.account_id);
  if (currentAccountId && currentAccountId !== accountId) {
    return { ok: false as const, status: 409, message: "Booking access is invalid." };
  }
  if (currentAccountId === accountId) {
    await run(env, `UPDATE ${tables.bookings}
      SET manage_token_hash = NULL, manage_token_expires_at = NULL, updated_at = ?
      WHERE id = ? AND account_id = ?`, [nowIso(), bookingId, accountId]);
    return { ok: true as const, status: 200, bookingId, claimed: false };
  }
  const claimedAt = nowIso();
  await runStatements(env, [
    env.DB!.prepare(`UPDATE ${tables.bookings}
      SET account_id = ?, manage_token_hash = NULL,
        manage_token_expires_at = NULL, updated_at = ?
      WHERE id = ? AND account_id IS NULL AND normalized_email = ?`)
      .bind(accountId, claimedAt, bookingId, accountEmail),
    env.DB!.prepare(`INSERT INTO ${tables.bookingEvents}
      (id, booking_id, event_type, actor_type, metadata_json, created_at)
      SELECT ?, ?, 'account.claimed', 'customer', '{}', ?
      WHERE EXISTS (
        SELECT 1 FROM ${tables.bookings} WHERE id = ? AND account_id = ?
      )`)
      .bind(secureId("vbe"), bookingId, claimedAt, bookingId, accountId),
  ]);
  const claimed = await first(env, `SELECT id FROM ${tables.bookings}
    WHERE id = ? AND account_id = ?`, [bookingId, accountId]);
  return claimed
    ? { ok: true as const, status: 200, bookingId, claimed: true }
    : { ok: false as const, status: 409, message: "Booking access is invalid." };
};

export const getAuthorizedVeraFile = async (
  env: VeraEnv,
  request: Request,
  fileId: string,
) => {
  const auth = await requireAccount(env, request);
  if (!auth.ok) return auth;
  const file = await first(env, `SELECT * FROM ${tables.privateFiles}
    WHERE id = ? AND account_id = ?`, [fileId, auth.session.account.id]);
  if (!file) return { ok: false as const, status: 404, message: "File was not found." };
  const size = Number(file.size_bytes);
  if (!Number.isSafeInteger(size) || size < 1) {
    return { ok: false as const, status: 404, message: "File content is not available." };
  }
  const rangeHeader = safeString(request.headers.get("range"));
  let range: { offset: number; length: number } | undefined;
  if (rangeHeader) {
    const matched = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!matched || (!matched[1] && !matched[2])) {
      return {
        ok: false as const,
        status: 416,
        message: "Requested file range is invalid.",
        contentRange: `bytes */${size}`,
      };
    }
    if (!matched[1]) {
      const suffixLength = Number(matched[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) {
        return {
          ok: false as const,
          status: 416,
          message: "Requested file range is invalid.",
          contentRange: `bytes */${size}`,
        };
      }
      const length = Math.min(size, suffixLength);
      range = { offset: size - length, length };
    } else {
      const start = Number(matched[1]);
      const requestedEnd = matched[2] ? Number(matched[2]) : size - 1;
      if (
        !Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
        start < 0 || requestedEnd < start || start >= size
      ) {
        return {
          ok: false as const,
          status: 416,
          message: "Requested file range is invalid.",
          contentRange: `bytes */${size}`,
        };
      }
      const end = Math.min(requestedEnd, size - 1);
      range = { offset: start, length: end - start + 1 };
    }
  }
  const object = await env.MEDIA?.get?.(
    safeString(file.storage_key),
    range ? { range } : undefined,
  );
  if (!object?.body) return { ok: false as const, status: 404, message: "File content is not available." };
  return {
    ok: true as const,
    status: range ? 206 : 200,
    file,
    body: object.body,
    size,
    range: range
      ? { ...range, end: range.offset + range.length - 1 }
      : null,
  };
};

export const listVeraThreadMessages = async (
  env: VeraEnv,
  request: Request,
  threadId: string,
) => {
  const auth = await requireAccount(env, request);
  if (!auth.ok) return auth;
  const thread = await first(env, `SELECT id, subject, status FROM ${tables.messageThreads}
    WHERE id = ? AND account_id = ?`, [threadId, auth.session.account.id]);
  if (!thread) return { ok: false as const, status: 404, message: "Message thread was not found." };
  const messages = await all(env, `SELECT id, sender_role, body, read_at, created_at
    FROM ${tables.messages} WHERE thread_id = ? ORDER BY created_at`, [threadId]);
  return { ok: true as const, status: 200, thread, messages };
};

export const sendVeraCustomerMessage = async (
  env: VeraEnv,
  request: Request,
  input: Record<string, unknown>,
) => {
  const auth = await requireAccount(env, request, true);
  if (!auth.ok) return auth;
  const threadId = safeString(input.threadId);
  const body = safeString(input.body);
  if (!threadId || body.length < 1 || body.length > 5_000) {
    return { ok: false as const, status: 400, message: "Write a message of 5,000 characters or fewer." };
  }
  const thread = await first(env, `SELECT id FROM ${tables.messageThreads}
    WHERE id = ? AND account_id = ? AND status = 'open'`, [threadId, auth.session.account.id]);
  if (!thread) return { ok: false as const, status: 404, message: "Open message thread was not found." };
  const now = nowIso();
  let inserted;
  try {
    inserted = await run(env, `INSERT INTO ${tables.messages}
      (id, thread_id, sender_role, body, read_at, created_at)
      SELECT ?, ?, 'customer', ?, NULL, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM ${tables.messages}
        WHERE thread_id = ? AND sender_role = 'customer'
      )`, [secureId("vmessage"), threadId, body, now, threadId]);
  } catch {
    return { ok: false as const, status: 409, message: "The follow-up question has already been sent." };
  }
  if (changeCount(inserted) !== 1) {
    return { ok: false as const, status: 409, message: "The follow-up question has already been sent." };
  }
  await run(env, `UPDATE ${tables.messageThreads} SET updated_at = ? WHERE id = ?`, [now, threadId]);
  return { ok: true as const, status: 201, message: "Message sent." };
};
