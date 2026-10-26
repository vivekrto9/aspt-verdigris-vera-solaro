import type { APIRoute } from "astro";
import { inspectWorkspaceAuthoredState } from "../../../../../server/generated-site/workspace-authored-state.ts";
import { requireWorkspaceAuth, workspaceError, workspaceResponse } from "./auth.ts";
export const prerender = false;
export const GET: APIRoute = async (context) => {
  const auth = await requireWorkspaceAuth(context);
  if (!auth.ok) return auth.response;
  try { return workspaceResponse({status:"ready",data:await inspectWorkspaceAuthoredState(auth.options)}); }
  catch { return workspaceError(409,"Workspace authored state could not be verified; keep authoring read-only."); }
};
