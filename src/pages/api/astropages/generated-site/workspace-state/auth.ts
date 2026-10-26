import type { APIContext } from "astro";
import { verifyRuntimeConfigSyncJwt } from "../../../../../server/aggregator/admin-sso.ts";
import { getRuntimeEnv } from "../../../../../server/generated-site/request.ts";
import type { WorkspaceOptions } from "../../../../../server/generated-site/workspace-authored-state.ts";
import { validateBlobReferences } from "../../../../../server/generated-site/workspace-state/validation.ts";

export const workspaceResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json","cache-control":"private, no-store"}});
export const workspaceError = (status: number, message: string) => workspaceResponse({status:"error",message},status);

export const requireWorkspaceAuth = async (context: APIContext) => {
  let env = await getRuntimeEnv(context);
  try { const workers = await import("cloudflare:workers"); env = {...env,...workers.env}; } catch { /* Local Astro has no Workers module. */ }
  const required = ["ASTROPAGES_PROJECT_ID","ASTROPAGES_SITE_ENVIRONMENT","ASTROPAGES_WORKSPACE_GENERATION_ID","ASTROPAGES_WORKSPACE_COMMIT_SHA","ASTROPAGES_WORKSPACE_TEMPLATE_COMMIT_SHA","ASTROPAGES_WORKSPACE_MIGRATION_DIGEST"];
  if (required.some((key) => typeof env[key] !== "string" || !(env[key] as string).trim()) || env.ASTROPAGES_SITE_ENVIRONMENT !== "preview" || !/^[a-f0-9]{40}$/.test(String(env.ASTROPAGES_WORKSPACE_COMMIT_SHA)) || !/^[a-f0-9]{40}$/.test(String(env.ASTROPAGES_WORKSPACE_TEMPLATE_COMMIT_SHA)) || !/^[a-f0-9]{64}$/.test(String(env.ASTROPAGES_WORKSPACE_MIGRATION_DIGEST))) return {ok:false as const,response:workspaceError(403,"Workspace checkpoint identity is not configured.")};
  const token = context.request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? "";
  if (token.split(".").length !== 3) return {ok:false as const,response:workspaceError(401,"Generation-bound checkpoint authentication is required.")};
  try {
    const claims = await verifyRuntimeConfigSyncJwt(token,env.ASTROPAGES_SSO_PUBLIC_JWK) as unknown as Record<string,unknown>;
    const now = Math.floor(Date.now()/1000);
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || Number(claims.iat)>now+30 || Number(claims.exp)<=now || Number(claims.exp)-Number(claims.iat)>90 || Number(claims.exp)<=Number(claims.iat) || typeof claims.jti !== "string" || !claims.jti) throw new Error("Invalid bounded claims");
    if (claims.projectId !== env.ASTROPAGES_PROJECT_ID || claims.environment !== env.ASTROPAGES_SITE_ENVIRONMENT || claims.generationId !== env.ASTROPAGES_WORKSPACE_GENERATION_ID || claims.commitSha !== env.ASTROPAGES_WORKSPACE_COMMIT_SHA || context.request.headers.get("x-astropages-generation-id") !== claims.generationId || typeof claims.workspaceFingerprint !== "string" || !claims.workspaceFingerprint || context.request.headers.get("x-astropages-workspace-fingerprint") !== claims.workspaceFingerprint) return {ok:false as const,response:workspaceError(403,"Checkpoint token target is invalid.")};
    const options: WorkspaceOptions = {
      env,
      identity:{templateCommitSha:String(env.ASTROPAGES_WORKSPACE_TEMPLATE_COMMIT_SHA),migrationDigest:String(env.ASTROPAGES_WORKSPACE_MIGRATION_DIGEST)},
      blobs:{ async verify(blob) {
        try { validateBlobReferences([blob]); } catch { return false; }
        const bucket = env.ASTROPAGES_WORKSPACE_CANONICAL_ASSETS as {get(key:string):Promise<{arrayBuffer():Promise<ArrayBuffer>;httpMetadata?:{contentType?:string}} | null>} | undefined;
        if (!bucket) return false;
        const object = await bucket.get(blob.canonicalObjectKey);
        if (!object || object.httpMetadata?.contentType !== blob.mimeType) return false;
        const bytes = await object.arrayBuffer();
        if (bytes.byteLength !== blob.size) return false;
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map((byte) => byte.toString(16).padStart(2,"0")).join("");
        return digest === blob.sha256;
      }},
    };
    return {ok:true as const,options};
  } catch { return {ok:false as const,response:workspaceError(401,"Checkpoint token is invalid.")}; }
};
