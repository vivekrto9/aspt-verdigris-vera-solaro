type GeoRequest = Request & { cf?: { country?: unknown } };

/** Production geography is owned only by Cloudflare request metadata. */
export const paymentCountryFromRequest = (request?: GeoRequest, development = false): unknown => {
  if (!request) return undefined;
  const hostname = new URL(request.url).hostname;
  if (!development) return request.cf?.country;

  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) return undefined;
  if (!hostname.endsWith(".trycloudflare.com") || !request.headers.has("cf-ray")) return undefined;
  const country = request.headers.get("cf-ipcountry")?.trim().toUpperCase();
  return country && /^[A-Z]{2}$/.test(country) ? country : undefined;
};
