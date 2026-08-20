import { getVeraBookingStatus } from "./bookings.ts";
import type { VeraEnv } from "./types.ts";

// The manage token is the guest's only claim on a booking. The wizard keeps it in
// sessionStorage for its API calls, but confirmation renders server-side, so the
// same token is mirrored into an HttpOnly cookie scoped to /booking. The API keeps
// reading the Authorization header exactly as before — this cookie is never sent to
// /api paths, so state-changing calls still require the explicit bearer header and
// cannot be driven cross-origin.
export const VERA_BOOKING_ACCESS_COOKIE = "ap_vera_booking_access";

const cookieSuffix = (request: Request) => {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `Path=/booking; HttpOnly; SameSite=Lax${secure}`;
};

const cookieValue = (request: Request, name: string) =>
  (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? "";

// One booking is in flight at a time, so the cookie carries the booking it belongs to
// and is only honoured for that id.
export const buildVeraBookingAccessCookie = ({
  request,
  bookingId,
  manageToken,
  expiresAt,
}: {
  request: Request;
  bookingId: string;
  manageToken: string;
  expiresAt?: string;
}) => {
  const expires = new Date(String(expiresAt ?? ""));
  const expiry = Number.isFinite(expires.getTime())
    ? `; Expires=${expires.toUTCString()}`
    : "";
  const value = encodeURIComponent(`${bookingId}.${manageToken}`);
  return `${VERA_BOOKING_ACCESS_COOKIE}=${value}${expiry}; ${cookieSuffix(request)}`;
};

export const clearVeraBookingAccessCookie = (request: Request) =>
  `${VERA_BOOKING_ACCESS_COOKIE}=; Max-Age=0; ${cookieSuffix(request)}`;

export const readVeraBookingManageToken = (request: Request, bookingId: string) => {
  const raw = decodeURIComponent(cookieValue(request, VERA_BOOKING_ACCESS_COOKIE));
  const separator = raw.indexOf(".");
  if (separator >= 1 && bookingId && raw.slice(0, separator) === bookingId) {
    return raw.slice(separator + 1);
  }

  // Match the base single-astrologer return contract. This fallback lets Stripe
  // return an existing guest booking even when it predates the access cookie or
  // the browser did not retain that cookie across the hosted checkout.
  return new URL(request.url).searchParams.get("token")?.trim() ?? "";
};

// Server-side equivalent of the wizard's status poll. A signed-in owner is resolved by
// session inside getVeraBookingAccess, so a reader who lost the cookie still gets in.
export const loadVeraBookingForPage = async ({
  env,
  request,
  bookingId,
}: {
  env: VeraEnv;
  request: Request;
  bookingId: string;
}) => getVeraBookingStatus({
  env,
  request,
  bookingId,
  manageToken: readVeraBookingManageToken(request, bookingId),
});
