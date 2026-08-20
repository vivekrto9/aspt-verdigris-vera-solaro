import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async () =>
  new Response(
    JSON.stringify({
      status: "ready",
      state: "ready",
      feature: "aspt-verdigris-vera-solaro.generated-site.health",
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
