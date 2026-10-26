export const canonicalTemplateKey = "aspt-verdigris-vera-solaro" as const;
export const legacyContentReleaseTemplateKey = "aspt-verdigris-vera-solaro" as const;
export const contentReleaseExportTemplateKey = canonicalTemplateKey;
export const workspaceAuthoredStateSchemaVersion =
  "workspace-authored-state.v1" as const;
export const previewArtifactSchemaVersion = "preview-artifact.v1" as const;

export type ContentReleaseImportTemplateKey =
  | typeof canonicalTemplateKey
  | typeof legacyContentReleaseTemplateKey;

type ContentReleaseIdentity = {
  schemaVersion: 1;
  templateKey: ContentReleaseImportTemplateKey;
};

type CanonicalRuntimeIdentity<SchemaVersion extends string> = {
  schemaVersion: SchemaVersion;
  canonicalTemplateKey: typeof canonicalTemplateKey;
  templateCommitSha: string;
};

const commitShaPattern = /^[0-9a-f]{40}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const templateRuntimeFeature = (feature: string) =>
  `${canonicalTemplateKey}.${feature}`;

export const assertCanonicalTemplateKey = (
  value: unknown,
  label = "Runtime identity",
): typeof canonicalTemplateKey => {
  if (value !== canonicalTemplateKey) {
    throw new Error(`${label} canonical template key is invalid.`);
  }
  return value;
};

export const isContentReleaseIdentity = (
  value: unknown,
): value is ContentReleaseIdentity =>
  isRecord(value) &&
  value.schemaVersion === 1 &&
  (value.templateKey === canonicalTemplateKey ||
    value.templateKey === legacyContentReleaseTemplateKey);

export const assertContentReleaseIdentity = (
  value: unknown,
): ContentReleaseIdentity => {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Content release schema version is invalid.");
  }
  if (
    value.templateKey !== canonicalTemplateKey &&
    value.templateKey !== legacyContentReleaseTemplateKey
  ) {
    throw new Error("Content release template key is invalid.");
  }
  return value as ContentReleaseIdentity;
};

const assertCanonicalRuntimeIdentity = <SchemaVersion extends string>(
  value: unknown,
  expectedSchemaVersion: SchemaVersion,
  expectedCommitSha: string,
  label: string,
): CanonicalRuntimeIdentity<SchemaVersion> => {
  if (!commitShaPattern.test(expectedCommitSha)) {
    throw new Error(`${label} expected commit SHA is invalid.`);
  }
  if (!isRecord(value) || value.schemaVersion !== expectedSchemaVersion) {
    throw new Error(`${label} schema version is invalid.`);
  }
  assertCanonicalTemplateKey(value.canonicalTemplateKey, label);
  if (
    typeof value.templateCommitSha !== "string" ||
    !commitShaPattern.test(value.templateCommitSha) ||
    value.templateCommitSha !== expectedCommitSha
  ) {
    throw new Error(`${label} template commit SHA is invalid.`);
  }
  return value as CanonicalRuntimeIdentity<SchemaVersion>;
};

export const assertWorkspaceAuthoredStateIdentity = (
  value: unknown,
  expectedCommitSha: string,
) =>
  assertCanonicalRuntimeIdentity(
    value,
    workspaceAuthoredStateSchemaVersion,
    expectedCommitSha,
    "Workspace authored state",
  );

export const assertPreviewArtifactIdentity = (
  value: unknown,
  expectedCommitSha: string,
) =>
  assertCanonicalRuntimeIdentity(
    value,
    previewArtifactSchemaVersion,
    expectedCommitSha,
    "Preview artifact",
  );
