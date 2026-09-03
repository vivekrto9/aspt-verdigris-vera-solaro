import type { APIRoute } from "astro";
import { requireContentReleaseServiceAuth } from "./content-release/auth.ts";
import { readBookingSettings, saveBookingSettings, previewBookingSlots } from "../../../../server/aggregator/integrations/booking-settings.ts";
export const prerender = false;
const handle: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, "booking-management");
  if (!auth.ok) return auth.response;
  // Management must always be scoped to a bound project and environment.
  if (!auth.env.ASTROPAGES_PROJECT_ID || !auth.env.ASTROPAGES_SITE_ENVIRONMENT) return Response.json({ message: "Project runtime bindings are missing." }, { status: 503 });
  try {
    let body: unknown;
    if (context.request.method !== "GET") {
      const text = await context.request.text();
      if (text.length > 20000) return Response.json({ message: "Settings are too large." }, { status: 413 });
      body = JSON.parse(text);
    }
    const data = context.request.method === "GET" ? await readBookingSettings(auth.env)
      : context.request.method === "PUT" ? await saveBookingSettings(auth.env, body)
      : await previewBookingSlots(auth.env, body);
    return Response.json({ data }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "Booking setup unavailable." }, { status: context.request.method === "GET" ? 503 : 400, headers: { "cache-control": "no-store" } });
  }
};
export const GET = handle;
export const PUT = handle;
export const POST = handle;
