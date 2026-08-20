import http from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const target = new URL(process.env.LOCAL_ADMIN_TARGET || "http://localhost:4321");
const port = Number(process.env.LOCAL_ADMIN_PROXY_PORT || 4322);
const subject = process.env.LOCAL_ADMIN_SUBJECT || "local-owner";
const role = process.env.LOCAL_ADMIN_ROLE || "owner";

const proxyOrigin = `http://localhost:${port}`;
const client = target.protocol === "https:" ? httpsRequest : httpRequest;

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const server = http.createServer((incoming, outgoing) => {
  const upstreamUrl = new URL(incoming.url ?? "/", target);
  const headers = { ...incoming.headers };
  for (const header of hopByHopHeaders) delete headers[header];

  headers.host = target.host;
  headers["x-forwarded-host"] = incoming.headers.host ?? `localhost:${port}`;
  headers["x-forwarded-proto"] = target.protocol.replace(":", "");
  headers["x-astropages-admin-subject"] = subject;
  headers["x-astropages-role"] = role;
  headers.cookie = [headers.cookie, "emdash-edit-mode=true"].filter(Boolean).join("; ");

  const upstream = client(
    upstreamUrl,
    {
      method: incoming.method,
      headers,
    },
    (response) => {
      const responseHeaders = { ...response.headers };
      const location = responseHeaders.location;
      if (typeof location === "string" && location.startsWith(target.origin)) {
        responseHeaders.location = location.replace(target.origin, proxyOrigin);
      }
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, responseHeaders);
      response.pipe(outgoing);
    },
  );

  upstream.on("error", (error) => {
    outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end(`Local admin proxy could not reach ${target.origin}: ${error.message}\n`);
  });

  incoming.pipe(upstream);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Vera Solaro local admin proxy`);
  console.log(`- Target: ${target.origin}`);
  console.log(`- Proxy:  ${proxyOrigin}`);
  console.log(`- SSO:    ${subject} (${role})`);
  console.log(``);
  console.log(`Open EmDash admin: ${proxyOrigin}/_emdash/admin`);
  console.log(`Open Content Studio launcher: ${proxyOrigin}/`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
