import type { APIRoute } from "astro";
import { exportWorkspaceAuthoredState } from "../../../../../server/generated-site/workspace-authored-state.ts";
import { requireWorkspaceAuth, workspaceError, workspaceResponse } from "./auth.ts";
export const prerender = false;
export const GET: APIRoute = async (context) => {
  const auth = await requireWorkspaceAuth(context);
  if (!auth.ok) return auth.response;
  try { return workspaceResponse(await exportWorkspaceAuthoredState(auth.options)); }
  catch { return workspaceError(409,"Checkpoint capture failed; retain the workspace and verify authored state and canonical Project Asset mappings."); }
};
