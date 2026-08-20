const sql = (value) => `'${String(value ?? "").replaceAll("'", "''")}'`;

export const buildTemplateAssetRevisionSeedSql = (asset, timestamp) => {
  if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 0) {
    throw new Error("Template asset size must be a non-negative safe integer.");
  }

  const nextRevisionNumber = `COALESCE((
    SELECT MAX(revision_number) + 1
    FROM ap_asset_revisions
    WHERE asset_id = ${sql(asset.assetId)}
  ), 1)`;

  return `INSERT INTO ap_asset_revisions (
    revision_id, asset_id, revision_number, storage_key, content_hash, etag,
    file_name, mime_type, size_bytes, status, scan_status, created_at
  ) VALUES (
    ${sql(asset.revisionId)}, ${sql(asset.assetId)}, ${nextRevisionNumber},
    ${sql(asset.storageKey)}, ${sql(asset.contentHash)}, ${sql(asset.contentHash)},
    ${sql(asset.fileName)}, ${sql(asset.mimeType)}, ${asset.sizeBytes},
    'ready', 'clean', ${sql(timestamp)}
  ) ON CONFLICT(revision_id) DO UPDATE SET
    status = 'ready',
    scan_status = 'clean';`;
};
