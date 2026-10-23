import type { APIRoute } from "astro";
import { importWorkspaceAuthoredState, workspaceCheckpointMaxBytes } from "../../../../../server/generated-site/workspace-authored-state.ts";
import { requireWorkspaceAuth, workspaceError, workspaceResponse } from "./auth.ts";
export const prerender = false;
const maxBytes = workspaceCheckpointMaxBytes;
export const POST: APIRoute = async (context) => {
  const auth = await requireWorkspaceAuth(context);
  if (!auth.ok) return auth.response;
  if (context.request.headers.get("content-encoding") && context.request.headers.get("content-encoding") !== "identity") return workspaceError(400,"Compressed checkpoints are not accepted.");
  if (Number(context.request.headers.get("content-length"))>maxBytes) return workspaceError(413,"Checkpoint body exceeds the supported limit.");
  let envelope: unknown;
  try {
    const reader = context.request.body?.getReader();
    if (!reader) return workspaceError(400,"Checkpoint JSON is required.");
    const decoder = new TextDecoder("utf-8",{fatal:true});
    let bytes=0; let text="";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes>maxBytes) { await reader.cancel(); return workspaceError(413,"Checkpoint body exceeds the supported limit."); }
      text += decoder.decode(chunk.value,{stream:true});
    }
    text += decoder.decode();
    envelope = JSON.parse(text);
  } catch { return workspaceError(400,"Checkpoint body is not valid JSON."); }
  try { return workspaceResponse({status:"ready",data:await importWorkspaceAuthoredState({...auth.options,envelope})}); }
  catch { return workspaceError(400,"Checkpoint validation or atomic import failed; do not mark the workspace ready."); }
};
