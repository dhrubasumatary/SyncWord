export const INSERT_REVISION_AT_HEAD_SQL = `
  INSERT INTO project_revisions
    (id, project_id, parent_revision_id, source_asset_id, schema_version,
     document_r2_key, document_hash, caption_status, caption_language,
     change_summary, created_by, created_at)
  SELECT ?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
  FROM projects
  WHERE id = ?1
    AND status = 'active'
    AND ((head_revision_id IS NULL AND ?3 IS NULL) OR head_revision_id = ?3)
`;

export const ADVANCE_PROJECT_HEAD_SQL = `
  UPDATE projects
  SET head_revision_id = ?2, updated_at = ?4
  WHERE id = ?1
    AND status = 'active'
    AND ((head_revision_id IS NULL AND ?3 IS NULL) OR head_revision_id = ?3)
    AND EXISTS (
      SELECT 1 FROM project_revisions
      WHERE id = ?2 AND project_id = ?1
    )
`;

export function prepareRevisionAdvanceBatch(database, revision) {
  return [
    database.prepare(INSERT_REVISION_AT_HEAD_SQL).bind(
      revision.projectId,
      revision.id,
      revision.parentRevisionId,
      revision.sourceAssetId,
      revision.schemaVersion,
      revision.documentR2Key,
      revision.documentHash,
      revision.captionStatus,
      revision.captionLanguage,
      revision.changeSummary,
      revision.createdBy,
      revision.createdAt,
    ),
    database.prepare(ADVANCE_PROJECT_HEAD_SQL).bind(
      revision.projectId,
      revision.id,
      revision.parentRevisionId,
      revision.createdAt,
    ),
  ];
}

export function revisionAdvanceCommitted(batchResults) {
  return (
    Number(batchResults?.[0]?.meta?.changes ?? 0) === 1 &&
    Number(batchResults?.[1]?.meta?.changes ?? 0) === 1
  );
}
