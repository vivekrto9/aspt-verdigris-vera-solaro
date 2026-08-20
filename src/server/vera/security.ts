import { getCustomerSession } from "../aggregator/customer-auth.ts";
import { resolveSecretBinding } from "../aggregator/runtime-bindings.ts";
import { first, hmacSha256Hex, safeString, sha256Hex, timingSafeHexEqual } from "./db.ts";
import type { VeraEnv, VeraRow } from "./types.ts";
import { VERA_TABLES as tables } from "./types.ts";

const encoder = new TextEncoder();

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const privateDataKey = async (env: VeraEnv) => {
  const source = await resolveSecretBinding(env, "EMDASH_ENCRYPTION_KEY");
  if (!source) return null;
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`vera-solaro:private-data:v1:${source}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
};

export const encryptVeraPrivateJson = async (
  env: VeraEnv,
  payload: Record<string, unknown>,
) => {
  const key = await privateDataKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(encrypted))}`;
};

export const decryptVeraPrivateJson = async (env: VeraEnv, value: string) => {
  const [version, iv, encrypted] = value.split(":");
  if (version !== "v1" || !iv || !encrypted) throw new Error("Private data format is invalid.");
  const key = await privateDataKey(env);
  if (!key) throw new Error("Private data encryption is not configured.");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    key,
    fromBase64(encrypted),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
};

export const normalizedGiftCode = (value: unknown) =>
  safeString(value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 80);

export const giftCodeHash = async (value: unknown) => {
  const normalized = normalizedGiftCode(value);
  return normalized.length >= 8 ? sha256Hex(`vera-gift:v1:${normalized}`) : "";
};

const bookingManageTokenVersion = "v2";
const bookingManageTokenTtlMs = 7 * 24 * 60 * 60 * 1000;

export const veraBookingManageTokenExpiresAt = (now = new Date()) =>
  new Date(now.getTime() + bookingManageTokenTtlMs).toISOString();

export const createBookingManageToken = async (
  env: VeraEnv,
  bookingId: string,
  expiresAtInput?: string,
) => {
  const secret = await resolveSecretBinding(env, "EMDASH_ENCRYPTION_KEY");
  if (!secret) return "";
  const stored = expiresAtInput
    ? null
    : await first(env, `SELECT manage_token_hash, manage_token_expires_at
        FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
  const expiresAtIso = expiresAtInput || safeString(stored?.manage_token_expires_at);
  const expiresAt = new Date(expiresAtIso).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return "";
  const signature = await hmacSha256Hex(
    secret,
    `vera-booking-manage:${bookingManageTokenVersion}:${bookingId}:${expiresAt}`,
  );
  const token = `${bookingManageTokenVersion}.${expiresAt}.${signature}`;
  if (!stored) return token;
  const storedHash = safeString(stored.manage_token_hash);
  return storedHash && timingSafeHexEqual(storedHash, await sha256Hex(token)) ? token : "";
};

const verifyBookingManageToken = async (
  env: VeraEnv,
  bookingId: string,
  token: string,
) => {
  const [version, rawExpiresAt, signature, ...extra] = token.split(".");
  if (version !== bookingManageTokenVersion || extra.length > 0 || !/^\d{13}$/.test(rawExpiresAt) || !signature) {
    return false;
  }
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  const secret = await resolveSecretBinding(env, "EMDASH_ENCRYPTION_KEY");
  if (!secret) return false;
  const expected = await hmacSha256Hex(
    secret,
    `vera-booking-manage:${version}:${bookingId}:${expiresAt}`,
  );
  return timingSafeHexEqual(expected, signature);
};

export const getVeraBookingAccess = async ({
  env,
  request,
  bookingId,
  manageToken,
  requireCsrf = false,
}: {
  env: VeraEnv;
  request: Request;
  bookingId: string;
  manageToken?: string;
  requireCsrf?: boolean;
}) => {
  const booking = await first<VeraRow>(env, `SELECT * FROM ${tables.bookings} WHERE id = ?`, [bookingId]);
  if (!booking) return { ok: false as const, message: "Booking was not found.", status: 404 };
  const session = await getCustomerSession(env, request);
  const accountAccess = Boolean(
    session && safeString(booking.account_id) && safeString(booking.account_id) === session.account.id,
  );
  const suppliedToken = safeString(manageToken);
  const storedTokenHash = safeString(booking.manage_token_hash);
  const storedExpiresAt = new Date(safeString(booking.manage_token_expires_at)).getTime();
  const tokenAccess = Boolean(
    suppliedToken && storedTokenHash && Number.isFinite(storedExpiresAt) && storedExpiresAt > Date.now() &&
    await verifyBookingManageToken(env, bookingId, suppliedToken) &&
    timingSafeHexEqual(storedTokenHash, await sha256Hex(suppliedToken)),
  );
  if (!accountAccess && !tokenAccess) {
    return { ok: false as const, message: "Booking access is invalid.", status: 403 };
  }
  if (
    requireCsrf && accountAccess && !tokenAccess &&
    request.headers.get("x-csrf-token") !== session?.csrfToken
  ) {
    return { ok: false as const, message: "Security token is invalid. Refresh and try again.", status: 403 };
  }
  return { ok: true as const, booking, session, accountAccess, tokenAccess };
};

const unsubscribeSecret = async (env: VeraEnv) =>
  await resolveSecretBinding(env, "EMDASH_ENCRYPTION_KEY");

export const createUnsubscribeToken = async (env: VeraEnv, subscriptionId: string) => {
  const secret = await unsubscribeSecret(env);
  if (!secret) return "";
  const signature = await hmacSha256Hex(secret, `vera-newsletter:v1:${subscriptionId}`);
  return `${subscriptionId}.${signature}`;
};

export const verifyUnsubscribeToken = async (env: VeraEnv, token: unknown) => {
  const value = safeString(token);
  const splitAt = value.lastIndexOf(".");
  if (splitAt < 1) return "";
  const subscriptionId = value.slice(0, splitAt);
  const signature = value.slice(splitAt + 1);
  const secret = await unsubscribeSecret(env);
  if (!secret) return "";
  const expected = await hmacSha256Hex(secret, `vera-newsletter:v1:${subscriptionId}`);
  return timingSafeHexEqual(expected, signature) ? subscriptionId : "";
};
