import { getAdminSession } from "../server/aggregator/admin-sso.ts";
import type { RuntimeEnv } from "../server/aggregator/runtime.ts";

export type BuilderRole = "owner" | "admin" | "editor" | "viewer";

type BuilderAccessOptions = {
  requireCsrf?: boolean;
  requirePublish?: boolean;
};

export type BuilderAccessResult =
  | {
      ok: true;
      subject: string;
      role: BuilderRole;
      csrfToken: string;
      canPublish: boolean;
    }
  | {
      ok: false;
      status: 401 | 403;
      response: Response;
    };

export type BuilderAccess = BuilderAccessResult;

const allowedRoles = new Set<BuilderRole>(["owner", "admin", "editor"]);
const publisherRoles = new Set<BuilderRole>(["owner", "admin"]);
export const builderCsrfToken = "aspt-verdigris-vera-solaro-builder";

const error = (message: string, status: 401 | 403) =>
  new Response(message, { status });

const resolveHeaderSubjectAndRole = (request: Request) => ({
  subject:
    request.headers.get("x-astropages-admin-subject") ??
    request.headers.get("x-astropages-user-id") ??
    "",
  role: request.headers.get("x-astropages-role") ?? "",
});

const evaluateBuilderAccess = (
  request: Request,
  subject: string,
  role: string,
  csrfToken: string,
  options: BuilderAccessOptions = {},
): BuilderAccessResult => {
  if (!subject) {
    return {
      ok: false,
      status: 401,
      response: error("AstroPages SSO is required for Builder access.", 401),
    };
  }

  if (!allowedRoles.has(role as BuilderRole)) {
    return {
      ok: false,
      status: 403,
      response: error("This AstroPages role cannot access Builder.", 403),
    };
  }

  if (options.requirePublish && !publisherRoles.has(role as BuilderRole)) {
    return {
      ok: false,
      status: 403,
      response: error("This AstroPages role cannot publish Builder changes.", 403),
    };
  }

  if (
    options.requireCsrf &&
    request.headers.get("x-astropages-builder-csrf") !== csrfToken
  ) {
    return {
      ok: false,
      status: 403,
      response: error("Builder mutation token is required.", 403),
    };
  }

  return {
    ok: true,
    subject,
    role: role as BuilderRole,
    csrfToken,
    canPublish: publisherRoles.has(role as BuilderRole),
  };
};

export function requireBuilderAccess(
  request: Request,
  options?: BuilderAccessOptions,
): BuilderAccessResult;
export function requireBuilderAccess(
  env: RuntimeEnv,
  request: Request,
  options?: BuilderAccessOptions,
): Promise<BuilderAccessResult>;
export function requireBuilderAccess(
  envOrRequest: RuntimeEnv | Request,
  requestOrOptions?: Request | BuilderAccessOptions,
  maybeOptions: BuilderAccessOptions = {},
): BuilderAccessResult | Promise<BuilderAccessResult> {
  const hasEnv = requestOrOptions instanceof Request;
  const request = hasEnv ? requestOrOptions : envOrRequest as Request;
  const options = hasEnv ? maybeOptions : requestOrOptions as BuilderAccessOptions | undefined;

  const headerAuth = resolveHeaderSubjectAndRole(request);
  if (headerAuth.subject || !hasEnv) {
    return evaluateBuilderAccess(request, headerAuth.subject, headerAuth.role, builderCsrfToken, options);
  }

  return (async () => {
    const session = await getAdminSession(envOrRequest as RuntimeEnv, request);
    return evaluateBuilderAccess(
      request,
      session?.subject ?? "",
      session?.role ?? "",
      session?.csrfToken ?? "",
      options,
    );
  })();
}
