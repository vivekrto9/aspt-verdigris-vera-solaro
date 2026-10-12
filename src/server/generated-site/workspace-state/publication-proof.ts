import type { AuthoredStateEnvelopeV1 } from "../workspace-authored-state.ts";
import type { Payload } from "./validation.ts";
import { buildAssetPublicProjectionFromRows, type AssetSnapshotRow } from "../project-assets.ts";

export type WorkspaceCheckpointProofV1 = {
  schemaVersion: "workspace-checkpoint-proof.v1";
  templateCommitSha: string;
  migrationDigest: string;
  authoredRevision: number;
  fingerprint: string;
  envelopeDigest: string;
  contentProofHash: string;
  assetProofHash: string;
};

/** Only the validated, canonically ordered Task9 observation may enter here.
 * Export time and operational release history are intentionally not proof inputs.
 */
export const publicationProof = async (
  envelope: AuthoredStateEnvelopeV1,
  fingerprint: string,
  digest: (value: unknown) => Promise<string>,
): Promise<WorkspaceCheckpointProofV1> => {
  const assets = (envelope.domains.find((domain) => domain.kind === "assets")!.payload as Payload).tables;
  const rows = assets.ap_asset_records.filter((row) => row.deleted_at === null).flatMap((record) => {
    const revision = assets.ap_asset_revisions.find((row) => row.revision_id === record.current_revision_id);
    const media = assets.media.find((row) => row.id === record.asset_id);
    // Match snapshotRows' inner joins and readiness filter, without another read.
    if (!revision || revision.status !== "ready" || !media) return [];
    return [{
      ...record, ...revision, asset_id: record.asset_id,
      alt_text: media.alt, caption: media.caption,
      aliases: JSON.stringify(assets.ap_asset_aliases.filter((row) => row.asset_id === record.asset_id).map((row) => row.alias)),
    } as AssetSnapshotRow];
  });
  const active = buildAssetPublicProjectionFromRows(rows);
  const identity = { schemaVersion: "workspace-checkpoint-proof.v1" as const, templateCommitSha: envelope.templateCommitSha, migrationDigest: envelope.migrationDigest };
  return {
    ...identity, authoredRevision: envelope.authoredRevision, fingerprint, envelopeDigest: envelope.envelopeDigest,
    contentProofHash: await digest({ ...identity, domains: envelope.domains.filter((domain) => domain.kind !== "assets") }),
    assetProofHash: await digest({ ...identity, activeAssets: active }),
  };
};
