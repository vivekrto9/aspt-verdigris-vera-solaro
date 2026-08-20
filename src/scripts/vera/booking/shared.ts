// Shared spine for the split booking wizard. The four routes render their own step
// server-side and pull only the helpers they need from here, so nothing has to know
// about the panels the single-page version used to switch between.

export type UnknownRecord = Record<string, unknown>;

type ApiEnvelope = {
  status?: string;
  state?: string;
  message?: string;
  data?: UnknownRecord;
};

export class RequestFailure extends Error {
  status: number;
  state: string;

  constructor(status: number, state = "error", message = "") {
    super(message || state);
    this.status = status;
    this.state = state;
  }
}

export const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
export const asRecords = (value: unknown) => Array.isArray(value) ? value.map(asRecord) : [];
export const asText = (value: unknown) => typeof value === "string" ? value : "";
export const asNumber = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

export const apiBase = "/api/astropages/generated-site/vera";

export const requestJson = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const envelope = await response.json().catch(() => ({})) as ApiEnvelope;
  if (!response.ok || envelope.status !== "ready") {
    throw new RequestFailure(response.status, envelope.state || envelope.status || "error", envelope.message || "");
  }
  return asRecord(envelope.data);
};

export const track = (event: string, payload: UnknownRecord) => {
  (window as { astroPagesTrack?: (name: string, data: UnknownRecord) => void }).astroPagesTrack?.(event, payload);
};

// The step-1 choice used to live in closure state. It now has to survive a real
// navigation, so it is written down before the reader is sent to the details route.
const selectionStorageKey = "vera-solaro:booking-selection";
const accessStorageKey = "vera-solaro:booking-access";

export type BookingSelection = {
  serviceSlug: string;
  mode: string;
  startAt: string;
  timezone: string;
  slotLabel: string;
};

export const rememberSelection = (selection: BookingSelection) => {
  try {
    sessionStorage.setItem(selectionStorageKey, JSON.stringify(selection));
  } catch {
    // The reader can still continue; the details route re-checks the slot anyway.
  }
};

export const readSelection = (): BookingSelection | null => {
  try {
    const stored = asRecord(JSON.parse(sessionStorage.getItem(selectionStorageKey) || "{}"));
    const serviceSlug = asText(stored.serviceSlug);
    const startAt = asText(stored.startAt);
    if (!serviceSlug || !startAt) return null;
    return {
      serviceSlug,
      mode: asText(stored.mode) || "call",
      startAt,
      timezone: asText(stored.timezone),
      slotLabel: asText(stored.slotLabel),
    };
  } catch {
    return null;
  }
};

export const forgetSelection = () => {
  try {
    sessionStorage.removeItem(selectionStorageKey);
  } catch {
    // Nothing else is persisted.
  }
};

export type BookingAccess = {
  bookingId: string;
  manageToken: string;
  holdExpiresAt: string;
  customerTimezone: string;
  paymentOption: string;
};

// The server also holds this token in an HttpOnly cookie so the SSR routes can read
// the booking. This copy is what the browser's own API calls send as a bearer.
export const rememberAccess = (access: BookingAccess) => {
  try {
    sessionStorage.setItem(accessStorageKey, JSON.stringify(access));
  } catch {
    // The current page retains the opaque token when storage is unavailable.
  }
};

export const readAccess = (bookingId = ""): BookingAccess | null => {
  try {
    const stored = asRecord(JSON.parse(sessionStorage.getItem(accessStorageKey) || "{}"));
    const storedId = asText(stored.bookingId);
    const manageToken = asText(stored.manageToken);
    if (!storedId || !manageToken) return null;
    if (bookingId && storedId !== bookingId) return null;
    const access = {
      bookingId: storedId,
      manageToken,
      holdExpiresAt: asText(stored.holdExpiresAt),
      customerTimezone: asText(stored.customerTimezone),
      paymentOption: asText(stored.paymentOption) === "full" ? "full" : "deposit",
    };
    // Older split-route builds stored the sitter's name here. Rewrite the record
    // without it as soon as it is read; booking PII belongs only on the server.
    sessionStorage.setItem(accessStorageKey, JSON.stringify(access));
    return access;
  } catch {
    return null;
  }
};

export const forgetAccess = () => {
  try {
    sessionStorage.removeItem(accessStorageKey);
  } catch {
    // Nothing else is persisted.
  }
};

// Browsers still hand back the pre-rename zone ids, and a sitter in Kolkata should not
// be told their hours are in Calcutta.
const renamedZones = new Map([
  ["Asia/Calcutta", "Asia/Kolkata"],
  ["Asia/Katmandu", "Asia/Kathmandu"],
  ["Asia/Rangoon", "Asia/Yangon"],
  ["Europe/Kiev", "Europe/Kyiv"],
  ["America/Buenos_Aires", "America/Argentina/Buenos_Aires"],
]);

export const browserTimezone = (() => {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    return renamedZones.get(zone) || zone || "Europe/Rome";
  } catch {
    return "Europe/Rome";
  }
})();

export const zoneLabel = (zone: string) => {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(new Date());
    return parts.find((part) => part.type === "timeZoneName")?.value || zone;
  } catch {
    return zone;
  }
};

export const formatMoney = (cents: number, code = "USD") => {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code || "USD",
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
};

export const formatDuration = (minutes: number) => {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} minutes`;
  if (!rest) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${hours}h ${rest}m`;
};

export const fillTemplate = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? "");

export const setText = (selector: string, value: string) => {
  const node = document.querySelector<HTMLElement>(selector);
  if (node) node.textContent = value;
};

export const slotDateLabel = (startAt: string, zone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(startAt));

export const slotTimeLabel = (startAt: string, zone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(startAt));

// The richer "WHEN" line on the payment/confirmation summary cards: full date, year,
// and the zone's abbreviation at that specific instant (DST can differ from "now").
// Used both server-side (Europe/Rome, at render time) and client-side (the reader's
// own zone, on hydration) so the two renders read identically.
export const formatSittingWhen = (startAt: string, zone: string) => {
  const instant = new Date(startAt);
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: zone,
  }).format(instant);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: zone,
  }).format(instant);
  let abbreviation = "";
  try {
    abbreviation = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(instant).find((part) => part.type === "timeZoneName")?.value || "";
  } catch {
    abbreviation = "";
  }
  return `${date} · ${time}${abbreviation ? ` ${abbreviation}` : ""}`;
};

export const loadCatalog = async () => asRecord(await requestJson(`${apiBase}/catalog`));

export const serviceRow = (catalog: UnknownRecord, slug: string) =>
  asRecords(catalog.services).find((row) => asText(row.slug) === slug) ?? {};
