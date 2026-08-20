import tzlookup from "tz-lookup";

import {
  platformGooglePlacesSecretBinding,
  resolveSecretBinding,
} from "../aggregator/runtime-bindings.ts";
import { fetchForEnv, parseObject, safeString } from "./db.ts";
import { decryptVeraPrivateJson, encryptVeraPrivateJson } from "./security.ts";
import type { VeraEnv } from "./types.ts";

export const VERA_BIRTH_TIME_APPROXIMATIONS = [
  "Small hours",
  "Morning",
  "Around midday",
  "Afternoon",
  "Evening",
  "No idea at all",
] as const;

const veraBirthTimeApproximationSet = new Set<string>(VERA_BIRTH_TIME_APPROXIMATIONS);

export const normalizeVeraBirthTimeApproximation = (value: unknown) => {
  const approximation = safeString(value);
  return veraBirthTimeApproximationSet.has(approximation) ? approximation : "";
};

const PLACE_TOKEN_KIND = "vera_birth_place_v1";
const PLACE_TOKEN_TTL_MS = 2 * 60 * 60_000;
const placesProviderTimeoutMs = 5_000;

const bounded = (value: unknown, limit: number) => safeString(value).slice(0, limit);

const validDate = (value: unknown) => {
  const date = bounded(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const parsed = new Date(`${date}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date && parsed.getTime() <= Date.now()
    ? date
    : "";
};

const validTime = (value: unknown) => {
  const time = bounded(value, 5);
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : "";
};

const validTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

const timezoneOffset = (timezone: string, date: string, time: string) => {
  const instant = new Date(`${date}T${time || "12:00"}:00.000Z`);
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(instant).find((entry) => entry.type === "timeZoneName")?.value || "";
  if (part === "GMT") return "UTC+00:00";
  if (/^GMT[+-]\d{2}:\d{2}$/.test(part)) return part.replace("GMT", "UTC");
  throw new Error("Timezone offset is unavailable.");
};

const placesKey = (env: VeraEnv) => resolveSecretBinding(env, "GOOGLE_PLACES_API_KEY");

const missingPlaces = () => ({
  ok: false as const,
  status: 503,
  message: "Place search is temporarily unavailable.",
  missingSecretNames: [platformGooglePlacesSecretBinding],
});

export const autocompleteVeraPlaces = async ({
  env,
  input,
  sessionToken,
  language = "en",
}: {
  env: VeraEnv;
  input: unknown;
  sessionToken?: unknown;
  language?: unknown;
}) => {
  const query = bounded(input, 120);
  if (query.length < 2) {
    return { ok: false as const, status: 400, message: "Enter at least two characters to search places." };
  }
  const key = await placesKey(env);
  if (!key) return missingPlaces();
  const params = new URLSearchParams({
    input: query,
    key,
    language: /^[a-z]{2}(?:-[A-Z]{2})?$/.test(bounded(language, 8)) ? bounded(language, 8) : "en",
    types: "(cities)",
  });
  const providerSessionToken = bounded(sessionToken, 128);
  if (providerSessionToken) params.set("sessiontoken", providerSessionToken);
  try {
    const response = await fetchForEnv(env)(`https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(placesProviderTimeoutMs),
    });
    const payload = parseObject(await response.json().catch(() => ({})));
    const providerStatus = safeString(payload.status);
    if (!response.ok || !["OK", "ZERO_RESULTS"].includes(providerStatus)) {
      return { ok: false as const, status: 502, message: "Place suggestions are temporarily unavailable." };
    }
    const predictions = (Array.isArray(payload.predictions) ? payload.predictions : [])
      .map((entry) => {
        const prediction = parseObject(entry);
        const formatting = parseObject(prediction.structured_formatting);
        return {
          placeId: bounded(prediction.place_id, 180),
          description: bounded(prediction.description, 300),
          mainText: bounded(formatting.main_text, 180),
          secondaryText: bounded(formatting.secondary_text, 180),
        };
      })
      .filter((entry) => entry.placeId && entry.description)
      .slice(0, 8);
    return { ok: true as const, status: 200, message: "Place suggestions loaded.", predictions };
  } catch {
    return { ok: false as const, status: 502, message: "Place suggestions are temporarily unavailable." };
  }
};

export const resolveVeraPlaceDetails = async ({
  env,
  placeId,
  sessionToken,
  birthDate,
  birthTime,
  birthTimeUnknown = false,
}: {
  env: VeraEnv;
  placeId: unknown;
  sessionToken?: unknown;
  birthDate: unknown;
  birthTime?: unknown;
  birthTimeUnknown?: unknown;
}) => {
  const resolvedPlaceId = bounded(placeId, 180);
  const date = validDate(birthDate);
  const unknownTime = birthTimeUnknown === true || safeString(birthTimeUnknown) === "true";
  const time = unknownTime ? "" : validTime(birthTime);
  if (!resolvedPlaceId) return { ok: false as const, status: 400, message: "Place id is required." };
  if (!date) return { ok: false as const, status: 400, message: "A valid birth date is required to resolve the place." };
  if (!unknownTime && !time) {
    return { ok: false as const, status: 400, message: "Enter a valid birth time or mark it unknown." };
  }
  const key = await placesKey(env);
  if (!key) return missingPlaces();
  const params = new URLSearchParams({
    place_id: resolvedPlaceId,
    fields: "place_id,formatted_address,geometry",
    key,
  });
  const providerSessionToken = bounded(sessionToken, 128);
  if (providerSessionToken) params.set("sessiontoken", providerSessionToken);
  try {
    const response = await fetchForEnv(env)(`https://maps.googleapis.com/maps/api/place/details/json?${params}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(placesProviderTimeoutMs),
    });
    const payload = parseObject(await response.json().catch(() => ({})));
    const result = parseObject(payload.result);
    const geometry = parseObject(result.geometry);
    const location = parseObject(geometry.location);
    const latitude = Number(location.lat);
    const longitude = Number(location.lng);
    if (
      !response.ok || safeString(payload.status) !== "OK" ||
      bounded(result.place_id, 180) !== resolvedPlaceId ||
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    ) {
      return { ok: false as const, status: 422, message: "Select a valid Google Places result." };
    }
    const timezone = tzlookup(latitude, longitude);
    const place = {
      placeId: resolvedPlaceId,
      formattedAddress: bounded(result.formatted_address, 300),
      latitude,
      longitude,
      timezone,
      timezoneOffset: timezoneOffset(timezone, date, time),
    };
    if (!place.formattedAddress || !validTimezone(timezone)) {
      return { ok: false as const, status: 422, message: "Place details did not include a usable address and timezone." };
    }
    const issuedAt = Date.now();
    const selectionToken = await encryptVeraPrivateJson(env, {
      kind: PLACE_TOKEN_KIND,
      issuedAt,
      birthDate: date,
      birthTime: time,
      birthTimeUnknown: unknownTime,
      place,
    });
    if (!selectionToken) {
      return {
        ok: false as const,
        status: 503,
        message: "Private place verification is not configured.",
        missingSecretNames: ["EMDASH_ENCRYPTION_KEY"],
      };
    }
    return {
      ok: true as const,
      status: 200,
      message: "Birth place resolved.",
      place,
      selectionToken,
      expiresAt: new Date(issuedAt + PLACE_TOKEN_TTL_MS).toISOString(),
    };
  } catch {
    return { ok: false as const, status: 502, message: "Place details are temporarily unavailable." };
  }
};

export const verifyVeraBirthPlaceSelection = async ({
  env,
  token,
  birthDate,
  birthTime,
  birthTimeUnknown,
  now = new Date(),
}: {
  env: VeraEnv;
  token: unknown;
  birthDate: unknown;
  birthTime: unknown;
  birthTimeUnknown: boolean;
  now?: Date;
}) => {
  const value = bounded(token, 4_096);
  const date = validDate(birthDate);
  const time = birthTimeUnknown ? "" : validTime(birthTime);
  if (!value || !date || (!birthTimeUnknown && !time)) return null;
  try {
    const payload = await decryptVeraPrivateJson(env, value);
    const issuedAt = Number(payload.issuedAt);
    const place = parseObject(payload.place);
    const latitude = Number(place.latitude);
    const longitude = Number(place.longitude);
    const timezone = bounded(place.timezone, 100);
    if (
      payload.kind !== PLACE_TOKEN_KIND ||
      !Number.isFinite(issuedAt) || issuedAt > now.getTime() + 5 * 60_000 ||
      now.getTime() - issuedAt > PLACE_TOKEN_TTL_MS ||
      payload.birthDate !== date || payload.birthTime !== time ||
      payload.birthTimeUnknown !== birthTimeUnknown ||
      !bounded(place.placeId, 180) || !bounded(place.formattedAddress, 300) ||
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      !validTimezone(timezone)
    ) return null;
    return {
      placeId: bounded(place.placeId, 180),
      formattedAddress: bounded(place.formattedAddress, 300),
      latitude,
      longitude,
      timezone,
      timezoneOffset: bounded(place.timezoneOffset, 16),
    };
  } catch {
    return null;
  }
};

export const normalizeVeraBirthDate = validDate;
export const normalizeVeraBirthTime = validTime;
