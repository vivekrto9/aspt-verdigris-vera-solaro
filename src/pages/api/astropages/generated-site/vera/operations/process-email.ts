import type { APIRoute } from "astro";

import { requireContentReleaseServiceAuth } from "../../content-release/auth.ts";
import { dispatchDueCampaigns, dispatchDueFollowUps, processEmailOutbox } from "../../../../../../server/vera/email.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import type { VeraEnv } from "../../../../../../server/vera/types.ts";

export const prerender = false;
const feature = "vera.operations.process-email";

export const POST: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  const env = auth.env as VeraEnv;
  const campaigns = await dispatchDueCampaigns({ env });
  if (!campaigns.ok) return veraResultResponse(feature, campaigns);
  const followUps = await dispatchDueFollowUps({ env });
  if (!followUps.ok) return veraResultResponse(feature, followUps);
  const outbox = await processEmailOutbox({ env });
  return veraResultResponse(feature, {
    ok: outbox.ok,
    status: outbox.ok ? 200 : 503,
    message: outbox.ok ? "Due Vera email work processed." : "Email provider setup is incomplete.",
    missingSecretNames: outbox.missingSecretNames,
    campaigns,
    followUps,
    outbox,
  });
};
