import { bookingSlotStarts, getVeraSelection, isVeraMode } from "./catalog.ts";
import { listCalendlyTimes } from "./calendly.ts";
import { all, first, safeString, sha256Hex } from "./db.ts";
import type { VeraEnv } from "./types.ts";
import { VERA_TABLES as tables } from "./types.ts";

const availabilityCacheSeconds = 30;

const readCachedProviderAvailability = async (env: VeraEnv, key: string) => {
  const cache = env.SESSION as { get?: (key: string) => Promise<string | null> | string | null } | undefined;
  try {
    const raw = await cache?.get?.(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as { expiresAt?: unknown; times?: unknown };
    if (Number(value.expiresAt) <= Date.now() || !Array.isArray(value.times)) return null;
    const times = value.times.map((entry) => {
      const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      return { startAt: safeString(row.startAt), schedulingUrl: safeString(row.schedulingUrl) };
    }).filter((entry) => entry.startAt).slice(0, 100);
    return {
      ok: true as const,
      status: 200,
      message: "Calendly availability loaded.",
      missingSecretNames: [] as string[],
      times,
    };
  } catch {
    return null;
  }
};

const cacheProviderAvailability = async (
  env: VeraEnv,
  key: string,
  times: Array<{ startAt: string; schedulingUrl: string }>,
) => {
  const cache = env.SESSION as {
    put?: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<unknown> | unknown;
  } | undefined;
  try {
    await cache?.put?.(key, JSON.stringify({
      expiresAt: Date.now() + availabilityCacheSeconds * 1_000,
      times: times.slice(0, 100),
    }), { expirationTtl: availabilityCacheSeconds });
  } catch {
    // Provider availability remains valid for this response when KV is unavailable.
  }
};

export const listVeraAvailability = async ({
  env,
  serviceSlug,
  mode,
  startTime,
  endTime,
}: {
  env: VeraEnv;
  serviceSlug: unknown;
  mode: unknown;
  startTime: string;
  endTime: string;
}) => {
  const selection = await getVeraSelection(env, serviceSlug, mode);
  if (!selection || !isVeraMode(mode)) {
    return { ok: false as const, status: 400, message: "Select a valid sitting and format.", missingSecretNames: [] as string[] };
  }
  if (!selection.eventTypeUri) {
    return {
      ok: false as const,
      status: 503,
      message: "Calendly is not mapped for this sitting.",
      missingSecretNames: ["CALENDLY_30_MIN_EVENT_TYPE_URI"],
    };
  }
  const cacheKey = `vera:availability:${await sha256Hex([
    selection.eventTypeUri,
    startTime,
    endTime,
  ].join("\n"))}`;
  const provider = await readCachedProviderAvailability(env, cacheKey) || await listCalendlyTimes({
    env,
    eventTypeUri: selection.eventTypeUri,
    startTime,
    endTime,
  });
  if (!provider.ok) return provider;
  await cacheProviderAvailability(env, cacheKey, provider.times);
  const allSegments = [...new Set(provider.times.flatMap((slot) =>
    bookingSlotStarts(slot.startAt, selection.durationMinutes)
  ))];
  const waitlist = await first(env, `SELECT COUNT(*) AS count FROM ${tables.waitlist}
    WHERE status = 'active'`);
  const activeWaitlistCount = Number(waitlist?.count || 0);
  if (allSegments.length === 0) return { ...provider, service: selection, activeWaitlistCount, times: [] };
  const placeholders = allSegments.map(() => "?").join(",");
  const heldRows = await all(env, `SELECT slot_start_at FROM ${tables.bookingHolds}
    WHERE slot_start_at IN (${placeholders})
      AND (expires_at IS NULL OR expires_at > ?)`, [...allSegments, new Date().toISOString()]);
  const held = new Set(heldRows.map((row) => safeString(row.slot_start_at)));
  return {
    ...provider,
    service: selection,
    activeWaitlistCount,
    times: provider.times.filter((slot) =>
      bookingSlotStarts(slot.startAt, selection.durationMinutes).every((segment) => !held.has(segment))
    ),
  };
};
