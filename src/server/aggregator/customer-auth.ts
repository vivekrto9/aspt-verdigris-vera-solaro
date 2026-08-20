import { AP_TABLES as tables } from "./db/tables.ts";
import { createId, nowIso, safeString, type RuntimeEnv } from "./runtime.ts";
import { enqueueVeraEmail } from "../vera/email.ts";
import type { VeraEnv } from "../vera/types.ts";

type Row = Record<string, unknown>;

const encoder = new TextEncoder();
const sessionCookieName = "ap_customer_session";
const csrfCookieName = "ap_customer_csrf";
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000;
const passwordResetTtlMs = 60 * 60 * 1000;
const passwordIterations = 100_000;

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string) => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const sha256Hex = async (value: string) =>
  toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const randomHex = (bytes = 32) => {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return [...array].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const first = async <T extends Row = Row>(env: RuntimeEnv, sql: string, values: unknown[] = []) => {
  if (!env.DB) return null;
  const statement = env.DB.prepare(sql).bind(...values) as {
    first?: <Result = T>() => Promise<Result | null>;
  };
  return await statement.first?.<T>() ?? null;
};

const run = async (env: RuntimeEnv, sql: string, values: unknown[] = []) => {
  if (!env.DB) return;
  return await env.DB.prepare(sql).bind(...values).run?.();
};

const changeCount = (result: unknown) => {
  if (!result || typeof result !== "object") return 0;
  const changes = Number((result as { meta?: { changes?: unknown } }).meta?.changes);
  return Number.isFinite(changes) ? changes : 0;
};

const normalizeEmail = (email: unknown) => safeString(email).toLowerCase();

const requestOrigin = (env: RuntimeEnv, request: Request) => {
  const configured = safeString(env.ASTROPAGES_SITE_URL) || safeString(env.SITE_ORIGIN) || safeString(env.SITE_URL);
  try {
    const url = new URL(configured);
    if (["http:", "https:"].includes(url.protocol)) return url.origin;
  } catch {
    // The request origin remains the safe same-site fallback.
  }
  return new URL(request.url).origin;
};

// Mirrors the Pandit reference: the reset link is handed back over the API only when
// the caller is on the developer's own machine, so a deployed origin never echoes it.
const isLocalRequest = (request: Request) => {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
};

const hashPassword = async (password: string, salt = randomHex(16)) => {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: fromHex(salt),
      iterations: passwordIterations,
    },
    keyMaterial,
    256,
  );
  return { salt, hash: toHex(bits) };
};

const timingSafeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
};

const cookieValue = (request: Request, name: string) => {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? "";
};

const cookieSuffix = (request: Request) => {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
};

const csrfCookieSuffix = (request: Request) => {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `Path=/; SameSite=Lax${secure}`;
};

const accountFromRow = (row: Row) => ({
  id: String(row.id),
  email: String(row.email),
  displayName: String(row.display_name ?? ""),
  phone: row.phone ? String(row.phone) : "",
  defaultLanguage: row.default_language ? String(row.default_language) : "English",
  createdAt: String(row.created_at ?? ""),
  updatedAt: String(row.updated_at ?? ""),
});

export type CustomerAccount = ReturnType<typeof accountFromRow>;

const getCustomerAccountById = async (env: RuntimeEnv, accountId: string) => {
  const row = await first(env, `SELECT * FROM ${tables.customerAccounts} WHERE id = ?`, [accountId]);
  return row ? accountFromRow(row) : null;
};

const enqueueCustomerEmail = async ({
  env,
  eventType,
  templateKey,
  recipientEmail,
  recipientName,
  payload,
  idempotencyKey,
}: {
  env: RuntimeEnv;
  eventType: string;
  templateKey: string;
  recipientEmail: string;
  recipientName: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}) => enqueueVeraEmail({
  env: env as VeraEnv,
  eventType,
  templateKey,
  recipientEmail,
  recipientName,
  payload,
  idempotencyKey,
});

const createCustomerSession = async ({ env, accountId, request }: { env: RuntimeEnv; accountId: string; request: Request }) => {
  const token = randomHex(32);
  const csrf = randomHex(24);
  const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
  const now = nowIso();
  await run(
    env,
    `INSERT INTO ${tables.customerSessions} (
      id, account_id, session_token_hash, csrf_token_hash, expires_at,
      last_seen_at, revoked_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    [createId("csess"), accountId, await sha256Hex(token), await sha256Hex(csrf), expiresAt, now, now],
  );
  return {
    csrfToken: csrf,
    cookies: [
      `${sessionCookieName}=${token}; Expires=${new Date(expiresAt).toUTCString()}; ${cookieSuffix(request)}`,
      `${csrfCookieName}=${csrf}; Expires=${new Date(expiresAt).toUTCString()}; ${csrfCookieSuffix(request)}`,
    ],
  };
};

export const signupCustomer = async ({
  env,
  request,
  displayName,
  email,
  phone,
  password,
  createSession = true,
}: {
  env: RuntimeEnv;
  request: Request;
  displayName: unknown;
  email: unknown;
  phone?: unknown;
  password: unknown;
  createSession?: boolean;
}) => {
  if (!env.DB) return { ok: false as const, message: "Customer account storage is not ready." };
  const normalizedEmail = normalizeEmail(email);
  const name = safeString(displayName);
  const rawPassword = safeString(password);
  if (!name) return { ok: false as const, message: "Full name is required." };
  if (!normalizedEmail || !normalizedEmail.includes("@")) return { ok: false as const, message: "Enter a valid email address." };
  if (rawPassword.length < 8) return { ok: false as const, message: "Password must be at least 8 characters." };

  const now = nowIso();
  const accountId = createId("acct");
  const accountUrl = new URL("/account", requestOrigin(env, request)).toString();
  const passwordResult = await hashPassword(rawPassword);

  // A reader who already owns the email and gives its password is simply let
  // back in, so a second signup never strands them on their own account.
  const existing = await first(env, `SELECT * FROM ${tables.customerAccounts} WHERE email = ?`, [normalizedEmail]);
  if (existing) {
    const existingCheck = await hashPassword(rawPassword, String(existing.password_salt ?? ""));
    if (!timingSafeEqual(existingCheck.hash, String(existing.password_hash ?? ""))) {
      return { ok: false as const, message: "That email is already in the book. Log in instead." };
    }
    const account = accountFromRow(existing);
    if (!createSession) {
      return { ok: true as const, account, cookies: [] as string[], csrfToken: "", created: false as const };
    }
    const session = await createCustomerSession({ env, accountId: account.id, request });
    return {
      ok: true as const,
      account,
      cookies: session.cookies,
      csrfToken: session.csrfToken,
      created: false as const,
    };
  }

  try {
    await run(
      env,
      `INSERT INTO ${tables.customerAccounts} (
        id, email, display_name, phone, password_hash, password_salt,
        default_language, email_verified_at, email_verification_token_hash,
        email_verification_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [
        accountId,
        normalizedEmail,
        name,
        safeString(phone) || null,
        passwordResult.hash,
        passwordResult.salt,
        "English",
        now,
        now,
        now,
      ],
    );
  } catch (error) {
    console.error("Customer account could not be created.", error);
    return { ok: false as const, message: "That account could not be made. Check the details and try again." };
  }

  const account = await getCustomerAccountById(env, accountId);
  if (!account) return { ok: false as const, message: "Account could not be created." };

  // The welcome note is a courtesy, never a gate: a failed send must not undo a
  // good account or keep the reader out of the room they just made.
  const queued = await enqueueCustomerEmail({
    env,
    eventType: "customer.welcome",
    templateKey: "customer_welcome_en",
    recipientEmail: normalizedEmail,
    recipientName: name,
    payload: {
      customerName: name,
      accountUrl,
    },
    idempotencyKey: `customer-welcome:${accountId}`,
  });
  if (!queued.ok) console.error("Customer welcome email could not be queued.", queued.message);

  if (!createSession) {
    return { ok: true as const, account, cookies: [] as string[], csrfToken: "", created: true as const };
  }
  const session = await createCustomerSession({ env, accountId, request });
  return {
    ok: true as const,
    account,
    cookies: session.cookies,
    csrfToken: session.csrfToken,
    created: true as const,
  };
};

export const verifyCustomerEmail = async ({
  env,
  token,
}: {
  env: RuntimeEnv;
  token: unknown;
}) => {
  if (!env.DB) return { ok: false as const, message: "Customer account storage is not ready." };
  const rawToken = safeString(token);
  if (!rawToken) return { ok: false as const, message: "Email verification is invalid or expired." };
  const now = nowIso();
  const result = await run(
    env,
    `UPDATE ${tables.customerAccounts}
      SET email_verified_at = ?, email_verification_token_hash = NULL,
        email_verification_expires_at = NULL, updated_at = ?
      WHERE email_verification_token_hash = ?
        AND email_verified_at IS NULL
        AND email_verification_expires_at > ?`,
    [now, now, await sha256Hex(rawToken), now],
  );
  return changeCount(result) === 1
    ? { ok: true as const, message: "Email verified." }
    : { ok: false as const, message: "Email verification is invalid or expired." };
};

export const loginCustomer = async ({
  env,
  request,
  email,
  password,
}: {
  env: RuntimeEnv;
  request: Request;
  email: unknown;
  password: unknown;
}) => {
  if (!env.DB) return { ok: false as const, message: "Customer account storage is not ready." };
  const normalizedEmail = normalizeEmail(email);
  const rawPassword = safeString(password);
  if (!normalizedEmail || !rawPassword) return { ok: false as const, message: "Email and password are required." };
  const row = await first(env, `SELECT * FROM ${tables.customerAccounts} WHERE email = ?`, [normalizedEmail]);
  if (!row) return { ok: false as const, message: "Email or password is incorrect." };
  const passwordResult = await hashPassword(rawPassword, String(row.password_salt ?? ""));
  if (!timingSafeEqual(passwordResult.hash, String(row.password_hash ?? ""))) {
    return { ok: false as const, message: "Email or password is incorrect." };
  }
  const account = accountFromRow(row);
  const session = await createCustomerSession({ env, accountId: account.id, request });
  return { ok: true as const, account, cookies: session.cookies, csrfToken: session.csrfToken };
};

export const requestCustomerPasswordReset = async ({
  env,
  request,
  email,
}: {
  env: RuntimeEnv;
  request: Request;
  email: unknown;
}) => {
  if (!env.DB) return { ok: false as const, message: "Customer account storage is not ready." };
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return { ok: false as const, message: "Enter a valid email address." };
  }

  const row = await first(env, `SELECT * FROM ${tables.customerAccounts} WHERE email = ?`, [normalizedEmail]);
  const genericMessage = "If an account exists for this email, password reset instructions will be available shortly.";
  if (!row) return { ok: true as const, message: genericMessage, emailSent: false, resetUrl: "" };

  const token = randomHex(32);
  const resetUrl = `${requestOrigin(env, request)}/reset-password?token=${encodeURIComponent(token)}`;
  const now = nowIso();
  const expiresAt = new Date(Date.now() + passwordResetTtlMs).toISOString();
  const resetId = createId("cpwr");
  let emailSent = false;
  try {
    await run(env, `UPDATE ${tables.customerPasswordResets}
      SET used_at = ? WHERE account_id = ? AND used_at IS NULL`, [now, String(row.id)]);
    await run(
      env,
      `INSERT INTO ${tables.customerPasswordResets} (
        id, account_id, reset_token_hash, expires_at, used_at, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?)`,
      [resetId, String(row.id), await sha256Hex(token), expiresAt, now],
    );
    const queued = await enqueueCustomerEmail({
      env,
      eventType: "customer.password_reset",
      templateKey: "customer_password_reset_en",
      recipientEmail: normalizedEmail,
      recipientName: safeString(row.display_name),
      payload: {
        customerName: safeString(row.display_name),
        resetUrl,
      },
      idempotencyKey: `customer-password-reset:${resetId}`,
    });
    if (!queued.ok) throw new Error(queued.message);
    emailSent = true;
  } catch (error) {
    await run(env, `UPDATE ${tables.customerPasswordResets}
      SET used_at = ? WHERE id = ? AND used_at IS NULL`, [nowIso(), resetId]).catch(() => undefined);
    console.error("Customer password reset email could not be queued.", error);
  }

  return {
    ok: true as const,
    message: genericMessage,
    emailSent,
    // A failed queue attempt marks the reset used above, so the link is already dead
    // and is withheld rather than handed back as something the reader could follow.
    resetUrl: emailSent && isLocalRequest(request) ? resetUrl : "",
  };
};

export const resetCustomerPassword = async ({
  env,
  token,
  password,
}: {
  env: RuntimeEnv;
  token: unknown;
  password: unknown;
}) => {
  if (!env.DB) return { ok: false as const, message: "Customer account storage is not ready." };
  const rawToken = safeString(token);
  const rawPassword = safeString(password);
  if (!rawToken) return { ok: false as const, message: "Reset link is invalid or expired." };
  if (rawPassword.length < 8) return { ok: false as const, message: "Password must be at least 8 characters." };

  const tokenHash = await sha256Hex(rawToken);
  const row = await first(
    env,
    `SELECT reset.*, account.email
       FROM ${tables.customerPasswordResets} reset
       JOIN ${tables.customerAccounts} account ON account.id = reset.account_id
      WHERE reset.reset_token_hash = ? AND reset.used_at IS NULL
      ORDER BY reset.created_at DESC
      LIMIT 1`,
    [tokenHash],
  );
  if (!row || new Date(String(row.expires_at)).getTime() < Date.now()) {
    return { ok: false as const, message: "Reset link is invalid or expired." };
  }

  const passwordResult = await hashPassword(rawPassword);
  const now = nowIso();
  const consumed = await run(
    env,
    `UPDATE ${tables.customerPasswordResets}
      SET used_at = ?
      WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
    [now, String(row.id), now],
  );
  if (changeCount(consumed) !== 1) {
    return { ok: false as const, message: "Reset link is invalid or expired." };
  }
  await run(
    env,
    `UPDATE ${tables.customerAccounts}
        SET password_hash = ?, password_salt = ?,
          email_verified_at = COALESCE(email_verified_at, ?),
          email_verification_token_hash = NULL,
          email_verification_expires_at = NULL,
          updated_at = ?
      WHERE id = ?`,
    [passwordResult.hash, passwordResult.salt, now, now, String(row.account_id)],
  );
  await run(env, `UPDATE ${tables.customerSessions} SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`, [
    now,
    String(row.account_id),
  ]);
  return { ok: true as const, message: "Password updated. Please login with your new password." };
};

export const getCustomerSession = async (env: RuntimeEnv, request: Request) => {
  const token = cookieValue(request, sessionCookieName);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const session = await first(
    env,
    `SELECT * FROM ${tables.customerSessions}
     WHERE session_token_hash = ? AND revoked_at IS NULL`,
    [tokenHash],
  );
  if (!session || new Date(String(session.expires_at)).getTime() < Date.now()) return null;
  const csrfToken = cookieValue(request, csrfCookieName);
  if (
    !csrfToken ||
    !timingSafeEqual(await sha256Hex(csrfToken), String(session.csrf_token_hash ?? ""))
  ) return null;
  const accountRow = await first(env, `SELECT * FROM ${tables.customerAccounts} WHERE id = ?`, [String(session.account_id)]);
  if (!accountRow || !safeString(accountRow.email_verified_at)) return null;
  const account = accountFromRow(accountRow);
  await run(env, `UPDATE ${tables.customerSessions} SET last_seen_at = ? WHERE id = ?`, [nowIso(), String(session.id)]);
  return {
    sessionId: String(session.id),
    account,
    csrfToken,
    csrfTokenHash: String(session.csrf_token_hash ?? ""),
  };
};

export const requireCustomerSession = async (env: RuntimeEnv, request: Request) => {
  const session = await getCustomerSession(env, request);
  if (!session) {
    return {
      ok: false as const,
      response: new Response("Customer login is required.", { status: 401 }),
    };
  }
  return { ok: true as const, session };
};

export const revokeCustomerSession = async (env: RuntimeEnv, request: Request) => {
  const token = cookieValue(request, sessionCookieName);
  if (token) {
    await run(env, `UPDATE ${tables.customerSessions} SET revoked_at = ? WHERE session_token_hash = ?`, [
      nowIso(),
      await sha256Hex(token),
    ]);
  }
  return [
    `${sessionCookieName}=; Max-Age=0; ${cookieSuffix(request)}`,
    `${csrfCookieName}=; Max-Age=0; ${csrfCookieSuffix(request)}`,
  ];
};
