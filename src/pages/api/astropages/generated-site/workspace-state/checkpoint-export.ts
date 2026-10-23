import type { APIRoute } from "astro";
import { exportWorkspaceCheckpointProof } from "../../../../../server/generated-site/workspace-authored-state.ts";
import { requireWorkspaceAuth, workspaceError, workspaceResponse } from "./auth.ts";
export const prerender = false;
export const GET: APIRoute = async (context) => {
  const auth = await requireWorkspaceAuth(context);
  if (!auth.ok) return auth.response;
  try { return workspaceResponse(await exportWorkspaceCheckpointProof(auth.options)); }
  catch { return workspaceError(409,"Checkpoint proof could not be verified; retain the workspace read-only."); }
};
