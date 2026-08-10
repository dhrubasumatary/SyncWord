import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  assetSourceKey,
  assertArtifactKind,
  canTransitionRenderJob,
  canonicalJson,
  deriveRenderCallbackToken,
  exportArtifactKey,
  idempotencyDecision,
  normalizeIdempotencyKey,
  parseExportSpec,
  parseProjectDocument,
  projectRouteAuthorization,
  renderBlockReason,
  renderRequestFingerprint,
  revisionDocumentKey,
  sha256Hex,
} from "../shared/project-contract.mjs";
import {
  prepareRevisionAdvanceBatch,
  revisionAdvanceCommitted,
} from "../shared/project-store.mjs";

const MAX_PROJECT_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 90 * 1024 * 1024;
const MAX_EXPORT_BYTES = 500 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ProjectEnv = {
  DB?: D1Database;
  MEDIA?: R2Bucket;
  RENDERER_REVISION?: string;
};

type JsonRecord = Record<string, unknown>;

type ProjectRow = {
  id: string;
  title: string;
  status: string;
  headRevisionId: string | null;
  capabilityHash: string;
  createdAt: string;
  updatedAt: string;
};

type AssetRow = {
  id: string;
  projectId: string;
  sourceAssetId: string | null;
  kind: string;
  status: string;
  originalName: string;
  contentType: string;
  byteSize: number;
  sourceR2Key: string;
  sourceEtag: string | null;
  sha256: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  finalizedAt: string | null;
};

type RevisionRow = {
  id: string;
  projectId: string;
  parentRevisionId: string | null;
  sourceAssetId: string;
  schemaVersion: number;
  documentR2Key: string;
  documentHash: string;
  captionStatus: string;
  captionLanguage: string;
  changeSummary: string;
  createdBy: string;
  createdAt: string;
};

type RenderJobRow = {
  id: string;
  projectId: string;
  revisionId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  callbackCapabilityHash: string;
  exportSpecJson: string;
  rendererRevision: string;
  status: string;
  progress: number;
  message: string;
  failureCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

type ExportArtifactRow = {
  id: string;
  renderJobId: string;
  projectId: string;
  revisionId: string;
  kind: string;
  r2Key: string;
  contentType: string;
  byteSize: number;
  etag: string;
  sha256: string | null;
  codecManifestJson: string | null;
  createdAt: string;
};

class ProjectApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: JsonRecord;

  constructor(status: number, code: string, message: string, details?: JsonRecord) {
    super(message);
    this.name = "ProjectApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

function asObject(value: unknown, path = "body"): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectApiError(400, "invalid_request", `${path} must be an object.`);
  }
  return value as JsonRecord;
}

function stringValue(
  value: unknown,
  path: string,
  maximumLength: number,
  { optional = false }: { optional?: boolean } = {},
): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") {
    throw new ProjectApiError(400, "invalid_request", `${path} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new ProjectApiError(400, "invalid_request", `${path} must not be empty.`);
  }
  if (normalized.length > maximumLength) {
    throw new ProjectApiError(
      400,
      "invalid_request",
      `${path} must be at most ${maximumLength} characters.`,
    );
  }
  return normalized;
}

function uuidValue(value: unknown, path: string): string {
  const id = stringValue(value, path, 36);
  if (!id || !UUID_PATTERN.test(id)) {
    throw new ProjectApiError(400, "invalid_request", `${path} must be a UUID.`);
  }
  return id.toLowerCase();
}

function nullableUuidValue(value: unknown, path: string): string | null {
  if (value === null) return null;
  return uuidValue(value, path);
}

async function readBoundedJson(
  request: Request,
  maximumBytes = MAX_PROJECT_DOCUMENT_BYTES,
): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) {
      throw new ProjectApiError(400, "invalid_content_length", "Content-Length is invalid.");
    }
    if (parsedLength > maximumBytes) {
      throw new ProjectApiError(413, "request_too_large", "The JSON request is too large.");
    }
  }
  if (!request.body) {
    throw new ProjectApiError(400, "invalid_request", "A JSON body is required.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel("request too large");
      throw new ProjectApiError(413, "request_too_large", "The JSON request is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProjectApiError(400, "invalid_json", "Send valid UTF-8 JSON.");
  }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64) return false;
  let mismatch = 0;
  for (let index = 0; index < 64; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function capabilityMatches(
  request: Request,
  expectedHash: string,
): Promise<boolean> {
  const supplied = bearerToken(request);
  if (!supplied) return false;
  const suppliedHash = await sha256Hex(supplied);
  return constantTimeHexEqual(expectedHash, suppliedHash);
}

async function hasProjectCapability(
  request: Request,
  project: ProjectRow,
): Promise<boolean> {
  return capabilityMatches(request, project.capabilityHash);
}

function requireBucket(bucket: R2Bucket | undefined): R2Bucket {
  if (!bucket) {
    throw new ProjectApiError(
      503,
      "media_storage_unavailable",
      "Project object storage is not provisioned.",
    );
  }
  return bucket;
}

const PROJECT_SELECT = `
  SELECT
    id,
    title,
    status,
    head_revision_id AS headRevisionId,
    capability_hash AS capabilityHash,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM projects
`;

const ASSET_SELECT = `
  SELECT
    id,
    project_id AS projectId,
    source_asset_id AS sourceAssetId,
    kind,
    status,
    original_name AS originalName,
    content_type AS contentType,
    byte_size AS byteSize,
    source_r2_key AS sourceR2Key,
    source_etag AS sourceEtag,
    sha256,
    duration_ms AS durationMs,
    width,
    height,
    created_at AS createdAt,
    finalized_at AS finalizedAt
  FROM assets
`;

const REVISION_SELECT = `
  SELECT
    id,
    project_id AS projectId,
    parent_revision_id AS parentRevisionId,
    source_asset_id AS sourceAssetId,
    schema_version AS schemaVersion,
    document_r2_key AS documentR2Key,
    document_hash AS documentHash,
    caption_status AS captionStatus,
    caption_language AS captionLanguage,
    change_summary AS changeSummary,
    created_by AS createdBy,
    created_at AS createdAt
  FROM project_revisions
`;

const RENDER_JOB_SELECT = `
  SELECT
    id,
    project_id AS projectId,
    revision_id AS revisionId,
    idempotency_key AS idempotencyKey,
    request_fingerprint AS requestFingerprint,
    callback_capability_hash AS callbackCapabilityHash,
    export_spec_json AS exportSpecJson,
    renderer_revision AS rendererRevision,
    status,
    progress,
    message,
    failure_code AS failureCode,
    created_at AS createdAt,
    started_at AS startedAt,
    completed_at AS completedAt,
    updated_at AS updatedAt
  FROM render_jobs
`;

const EXPORT_ARTIFACT_SELECT = `
  SELECT
    id,
    render_job_id AS renderJobId,
    project_id AS projectId,
    revision_id AS revisionId,
    kind,
    r2_key AS r2Key,
    content_type AS contentType,
    byte_size AS byteSize,
    etag,
    sha256,
    codec_manifest_json AS codecManifestJson,
    created_at AS createdAt
  FROM export_artifacts
`;

async function getProject(db: D1Database, projectId: string): Promise<ProjectRow | null> {
  return db
    .prepare(`${PROJECT_SELECT} WHERE id = ?1`)
    .bind(projectId)
    .first<ProjectRow>();
}

function publicProject(project: ProjectRow) {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    headRevisionId: project.headRevisionId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function publicAsset(asset: AssetRow) {
  return {
    id: asset.id,
    projectId: asset.projectId,
    sourceAssetId: asset.sourceAssetId,
    kind: asset.kind,
    status: asset.status,
    originalName: asset.originalName,
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    storage: { provider: "r2", key: asset.sourceR2Key, etag: asset.sourceEtag },
    sha256: asset.sha256,
    durationMs: asset.durationMs,
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt,
    finalizedAt: asset.finalizedAt,
    uploadUrl:
      asset.status === "pending"
        ? `/api/projects/${asset.projectId}/assets/${asset.id}/source`
        : undefined,
  };
}

function publicRevision(revision: RevisionRow) {
  return {
    id: revision.id,
    projectId: revision.projectId,
    parentRevisionId: revision.parentRevisionId,
    sourceAssetId: revision.sourceAssetId,
    schemaVersion: revision.schemaVersion,
    documentHash: revision.documentHash,
    documentRef: { provider: "r2", key: revision.documentR2Key },
    captionStatus: revision.captionStatus,
    captionLanguage: revision.captionLanguage,
    changeSummary: revision.changeSummary,
    createdBy: revision.createdBy,
    createdAt: revision.createdAt,
  };
}

function publicRenderJob(job: RenderJobRow) {
  let exportSpec: unknown = null;
  try {
    exportSpec = JSON.parse(job.exportSpecJson);
  } catch {
    exportSpec = null;
  }
  return {
    id: job.id,
    projectId: job.projectId,
    revisionId: job.revisionId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    failureCode: job.failureCode,
    exportSpec,
    rendererRevision: job.rendererRevision,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  };
}

function renderJobAcceptance(
  job: RenderJobRow,
  callbackCapabilityToken: string,
  idempotentReplay: boolean,
) {
  return {
    ...publicRenderJob(job),
    idempotentReplay,
    callbackCapabilityToken,
    callback: {
      stateUrl: `/api/projects/${job.projectId}/render-jobs/${job.id}/state`,
      artifactBaseUrl: `/api/projects/${job.projectId}/render-jobs/${job.id}/artifacts`,
    },
  };
}

function publicArtifact(artifact: ExportArtifactRow) {
  let codecManifest: unknown = null;
  try {
    codecManifest = artifact.codecManifestJson
      ? JSON.parse(artifact.codecManifestJson)
      : null;
  } catch {
    codecManifest = null;
  }
  return {
    id: artifact.id,
    renderJobId: artifact.renderJobId,
    projectId: artifact.projectId,
    revisionId: artifact.revisionId,
    kind: artifact.kind,
    storage: { provider: "r2", key: artifact.r2Key, etag: artifact.etag },
    contentType: artifact.contentType,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
    codecManifest,
    createdAt: artifact.createdAt,
    contentUrl: `/api/projects/${artifact.projectId}/exports/${artifact.id}/content`,
  };
}

async function createProject(request: Request, db: D1Database): Promise<Response> {
  const input = asObject(await readBoundedJson(request, 32 * 1024));
  const title = stringValue(input.title, "title", 120);
  if (!title) throw new ProjectApiError(400, "invalid_request", "title is required.");
  const id = crypto.randomUUID();
  const capabilityToken = randomToken();
  const capabilityHash = await sha256Hex(capabilityToken);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO projects
        (id, title, status, head_revision_id, capability_hash, created_at, updated_at)
       VALUES (?1, ?2, 'active', NULL, ?3, ?4, ?4)`,
    )
    .bind(id, title, capabilityHash, now)
    .run();
  const project = await getProject(db, id);
  if (!project) throw new Error("Created project could not be read back.");
  return json({ ...publicProject(project), capabilityToken }, 201);
}

async function createAsset(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
  project: ProjectRow,
): Promise<Response> {
  void bucket;
  const input = asObject(await readBoundedJson(request, 32 * 1024));
  const originalName = stringValue(input.originalName, "originalName", 255);
  const contentType = stringValue(input.contentType, "contentType", 120);
  const byteSize = Number(input.byteSize);
  const kind = input.kind === undefined ? "source_video" : stringValue(input.kind, "kind", 32);
  if (!originalName || !contentType || !kind) {
    throw new ProjectApiError(400, "invalid_request", "Asset metadata is incomplete.");
  }
  if (!Number.isInteger(byteSize) || byteSize <= 0 || byteSize > MAX_SOURCE_BYTES) {
    throw new ProjectApiError(
      413,
      "asset_too_large",
      "Source assets must be between 1 byte and 90 MB.",
    );
  }
  if (kind === "source_video" && !contentType.startsWith("video/")) {
    throw new ProjectApiError(415, "unsupported_asset_type", "A source video content type is required.");
  }
  if (kind === "source_audio" && !contentType.startsWith("audio/")) {
    throw new ProjectApiError(415, "unsupported_asset_type", "A source audio content type is required.");
  }
  if (!new Set(["source_video", "source_audio"]).has(kind)) {
    throw new ProjectApiError(400, "invalid_asset_kind", "kind must be source_video or source_audio.");
  }
  const id = crypto.randomUUID();
  const sourceR2Key = assetSourceKey(project.id, id, originalName);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO assets
        (id, project_id, kind, status, original_name, content_type, byte_size,
         source_r2_key, created_at)
       VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(id, project.id, kind, originalName, contentType, byteSize, sourceR2Key, now)
    .run();
  const asset = await getAsset(db, project.id, id);
  if (!asset) throw new Error("Created asset could not be read back.");
  return json(publicAsset(asset), 201);
}

async function getAsset(
  db: D1Database,
  projectId: string,
  assetId: string,
): Promise<AssetRow | null> {
  return db
    .prepare(`${ASSET_SELECT} WHERE project_id = ?1 AND id = ?2`)
    .bind(projectId, assetId)
    .first<AssetRow>();
}

async function listAssets(db: D1Database, projectId: string): Promise<Response> {
  const result = await db
    .prepare(`${ASSET_SELECT} WHERE project_id = ?1 ORDER BY created_at ASC LIMIT 250`)
    .bind(projectId)
    .all<AssetRow>();
  return json({ assets: result.results.map(publicAsset) });
}

async function uploadAssetSource(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
  projectId: string,
  assetId: string,
): Promise<Response> {
  const asset = await getAsset(db, projectId, assetId);
  if (!asset) throw new ProjectApiError(404, "asset_not_found", "Asset not found.");
  if (asset.status === "ready") return json(publicAsset(asset));
  if (!new Set(["pending", "failed"]).has(asset.status)) {
    throw new ProjectApiError(409, "asset_not_uploadable", `Asset is ${asset.status}.`);
  }
  if (!request.body) {
    throw new ProjectApiError(400, "asset_body_required", "Asset bytes are required.");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (!Number.isInteger(declaredLength) || declaredLength !== asset.byteSize) {
    throw new ProjectApiError(
      400,
      "asset_size_mismatch",
      "Content-Length must match the reserved asset size.",
    );
  }
  await bucket.put(asset.sourceR2Key, request.body, {
    httpMetadata: {
      contentType: asset.contentType,
      contentDisposition: `inline; filename="${asset.originalName.replaceAll('"', "")}"`,
    },
    customMetadata: { projectId, assetId },
  });
  const stored = await bucket.head(asset.sourceR2Key);
  if (!stored || stored.size !== asset.byteSize) {
    await bucket.delete(asset.sourceR2Key);
    throw new ProjectApiError(400, "asset_size_mismatch", "Stored asset size does not match.");
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE assets
       SET status = 'ready', source_etag = ?3, finalized_at = ?4
       WHERE project_id = ?1 AND id = ?2 AND status IN ('pending', 'failed')`,
    )
    .bind(projectId, assetId, stored.etag, now)
    .run();
  const finalized = await getAsset(db, projectId, assetId);
  if (!finalized) throw new Error("Finalized asset could not be read back.");
  return json(publicAsset(finalized), 201);
}

async function getRevision(
  db: D1Database,
  projectId: string,
  revisionId: string,
): Promise<RevisionRow | null> {
  return db
    .prepare(`${REVISION_SELECT} WHERE project_id = ?1 AND id = ?2`)
    .bind(projectId, revisionId)
    .first<RevisionRow>();
}

async function createRevision(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
  project: ProjectRow,
): Promise<Response> {
  if (project.status !== "active") {
    throw new ProjectApiError(409, "project_archived", "Archived projects cannot be revised.");
  }
  const input = asObject(await readBoundedJson(request));
  const baseRevisionId = nullableUuidValue(input.baseRevisionId, "baseRevisionId");
  let document: ReturnType<typeof parseProjectDocument>;
  try {
    document = parseProjectDocument(input.document);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ProjectApiError(400, "invalid_project_document", error.message);
    }
    throw error;
  }
  const asset = await getAsset(db, project.id, document.sourceAssetId);
  if (!asset) {
    throw new ProjectApiError(
      400,
      "source_asset_not_found",
      "The revision source asset does not belong to this project.",
    );
  }
  const changeSummary =
    stringValue(input.changeSummary, "changeSummary", 500, { optional: true }) ?? "";
  const createdBy =
    stringValue(input.createdBy, "createdBy", 64, { optional: true }) ?? "editor";
  const revisionId = crypto.randomUUID();
  const documentText = canonicalJson(document);
  if (new TextEncoder().encode(documentText).byteLength > MAX_PROJECT_DOCUMENT_BYTES) {
    throw new ProjectApiError(413, "project_document_too_large", "Project document exceeds 2 MB.");
  }
  const documentHash = await sha256Hex(documentText);
  const documentR2Key = revisionDocumentKey(project.id, revisionId);
  const now = new Date().toISOString();
  await bucket.put(documentR2Key, documentText, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { projectId: project.id, revisionId, documentHash },
  });

  let batchResult: D1Result[];
  try {
    batchResult = await db.batch(
      prepareRevisionAdvanceBatch(db, {
        projectId: project.id,
        id: revisionId,
        parentRevisionId: baseRevisionId,
        sourceAssetId: document.sourceAssetId,
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
        documentR2Key,
        documentHash,
        captionStatus: document.captionTrack.status,
        captionLanguage: document.captionTrack.languageCode,
        changeSummary,
        createdBy,
        createdAt: now,
      }),
    );
  } catch (error) {
    await bucket.delete(documentR2Key);
    throw error;
  }

  if (!revisionAdvanceCommitted(batchResult)) {
    await bucket.delete(documentR2Key);
    const current = await getProject(db, project.id);
    throw new ProjectApiError(
      409,
      "revision_conflict",
      "The project head changed before this revision was saved.",
      { expectedBaseRevisionId: current?.headRevisionId ?? null },
    );
  }
  const revision = await getRevision(db, project.id, revisionId);
  if (!revision) throw new Error("Created revision could not be read back.");
  return json({ ...publicRevision(revision), document }, 201);
}

async function listRevisions(db: D1Database, projectId: string): Promise<Response> {
  const result = await db
    .prepare(
      `${REVISION_SELECT} WHERE project_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 100`,
    )
    .bind(projectId)
    .all<RevisionRow>();
  return json({ revisions: result.results.map(publicRevision) });
}

async function loadRevisionDocument(
  bucket: R2Bucket,
  revision: RevisionRow,
): Promise<ReturnType<typeof parseProjectDocument>> {
  const object = await bucket.get(revision.documentR2Key);
  if (!object) {
    throw new ProjectApiError(
      503,
      "revision_document_missing",
      "The immutable revision document is missing from object storage.",
    );
  }
  if (object.size > MAX_PROJECT_DOCUMENT_BYTES) {
    throw new ProjectApiError(
      503,
      "revision_document_corrupt",
      "The immutable revision document exceeds its storage contract.",
    );
  }
  const text = await object.text();
  if ((await sha256Hex(text)) !== revision.documentHash) {
    throw new ProjectApiError(
      503,
      "revision_document_hash_mismatch",
      "The immutable revision document failed integrity verification.",
    );
  }
  try {
    return parseProjectDocument(JSON.parse(text));
  } catch {
    throw new ProjectApiError(
      503,
      "revision_document_corrupt",
      "The immutable revision document is invalid.",
    );
  }
}

async function showRevision(
  db: D1Database,
  bucket: R2Bucket,
  projectId: string,
  revisionId: string,
): Promise<Response> {
  const revision = await getRevision(db, projectId, revisionId);
  if (!revision) {
    throw new ProjectApiError(404, "revision_not_found", "Revision not found.");
  }
  const document = await loadRevisionDocument(bucket, revision);
  return json({ ...publicRevision(revision), document });
}

async function getRenderJob(
  db: D1Database,
  projectId: string,
  renderJobId: string,
): Promise<RenderJobRow | null> {
  return db
    .prepare(`${RENDER_JOB_SELECT} WHERE project_id = ?1 AND id = ?2`)
    .bind(projectId, renderJobId)
    .first<RenderJobRow>();
}

async function findRenderJobByIdempotencyKey(
  db: D1Database,
  projectId: string,
  idempotencyKey: string,
): Promise<RenderJobRow | null> {
  return db
    .prepare(`${RENDER_JOB_SELECT} WHERE project_id = ?1 AND idempotency_key = ?2`)
    .bind(projectId, idempotencyKey)
    .first<RenderJobRow>();
}

async function callbackCapabilityForJob(
  ownerCapability: string,
  job: RenderJobRow,
): Promise<string> {
  const token = await deriveRenderCallbackToken(
    ownerCapability,
    job.id,
    job.requestFingerprint,
  );
  const tokenHash = await sha256Hex(token);
  if (!constantTimeHexEqual(job.callbackCapabilityHash, tokenHash)) {
    throw new ProjectApiError(
      503,
      "render_callback_capability_corrupt",
      "The render callback capability failed integrity verification.",
    );
  }
  return token;
}

async function createRenderJob(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
  project: ProjectRow,
  rendererRevision: string,
): Promise<Response> {
  const input = asObject(await readBoundedJson(request, 64 * 1024));
  const revisionId = uuidValue(input.revisionId, "revisionId");
  const revision = await getRevision(db, project.id, revisionId);
  if (!revision) {
    throw new ProjectApiError(404, "revision_not_found", "Revision not found.");
  }
  const sourceAsset = await getAsset(db, project.id, revision.sourceAssetId);
  if (!sourceAsset || sourceAsset.status !== "ready") {
    throw new ProjectApiError(
      409,
      "source_asset_not_ready",
      "The revision source asset has not finalized.",
    );
  }
  const document = await loadRevisionDocument(bucket, revision);
  const blockReason = renderBlockReason(document);
  if (blockReason) {
    throw new ProjectApiError(
      409,
      "revision_not_renderable",
      "This revision has not passed the caption quality boundary.",
      { reason: blockReason, captionStatus: document.captionTrack.status },
    );
  }
  let exportSpec: ReturnType<typeof parseExportSpec>;
  try {
    exportSpec = parseExportSpec(input.exportSpec);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ProjectApiError(400, "invalid_export_spec", error.message);
    }
    throw error;
  }
  const fingerprint = await renderRequestFingerprint(
    project.id,
    revisionId,
    exportSpec,
    rendererRevision,
  );
  const headerKey = request.headers.get("idempotency-key") ?? undefined;
  if (headerKey && input.idempotencyKey && headerKey !== input.idempotencyKey) {
    throw new ProjectApiError(
      400,
      "idempotency_key_mismatch",
      "The header and body idempotency keys must match.",
    );
  }
  let idempotencyKey: string;
  try {
    idempotencyKey = normalizeIdempotencyKey(
      headerKey ?? input.idempotencyKey,
      fingerprint,
    );
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ProjectApiError(400, "invalid_idempotency_key", error.message);
    }
    throw error;
  }
  const existing = await findRenderJobByIdempotencyKey(db, project.id, idempotencyKey);
  const existingDecision = idempotencyDecision(existing?.requestFingerprint, fingerprint);
  if (existingDecision === "replay" && existing) {
    const callbackCapabilityToken = await callbackCapabilityForJob(
      bearerToken(request),
      existing,
    );
    return json(renderJobAcceptance(existing, callbackCapabilityToken, true));
  }
  if (existingDecision === "conflict") {
    throw new ProjectApiError(
      409,
      "idempotency_conflict",
      "This idempotency key already names a different render request.",
    );
  }

  const renderJobId = crypto.randomUUID();
  const callbackCapabilityToken = await deriveRenderCallbackToken(
    bearerToken(request),
    renderJobId,
    fingerprint,
  );
  const callbackCapabilityHash = await sha256Hex(callbackCapabilityToken);
  const now = new Date().toISOString();
  const exportSpecJson = canonicalJson(exportSpec);
  await db
    .prepare(
      `INSERT INTO render_jobs
        (id, project_id, revision_id, idempotency_key, request_fingerprint,
         callback_capability_hash, export_spec_json, renderer_revision, status,
         progress, message, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', 0, 'Queued for rendering', ?9, ?9)
       ON CONFLICT(project_id, idempotency_key) DO NOTHING`,
    )
    .bind(
      renderJobId,
      project.id,
      revisionId,
      idempotencyKey,
      fingerprint,
      callbackCapabilityHash,
      exportSpecJson,
      rendererRevision,
      now,
    )
    .run();
  const persisted = await findRenderJobByIdempotencyKey(db, project.id, idempotencyKey);
  if (!persisted) throw new Error("Created render job could not be read back.");
  if (persisted.requestFingerprint !== fingerprint) {
    throw new ProjectApiError(
      409,
      "idempotency_conflict",
      "This idempotency key already names a different render request.",
    );
  }
  const persistedCallbackCapabilityToken = await callbackCapabilityForJob(
    bearerToken(request),
    persisted,
  );
  return json(
    renderJobAcceptance(
      persisted,
      persistedCallbackCapabilityToken,
      persisted.id !== renderJobId,
    ),
    persisted.id === renderJobId ? 202 : 200,
  );
}

async function listArtifactsForJob(
  db: D1Database,
  projectId: string,
  renderJobId: string,
): Promise<ExportArtifactRow[]> {
  const result = await db
    .prepare(
      `${EXPORT_ARTIFACT_SELECT}
       WHERE project_id = ?1 AND render_job_id = ?2
       ORDER BY created_at ASC, id ASC`,
    )
    .bind(projectId, renderJobId)
    .all<ExportArtifactRow>();
  return result.results;
}

async function showRenderJob(
  db: D1Database,
  projectId: string,
  renderJobId: string,
): Promise<Response> {
  const job = await getRenderJob(db, projectId, renderJobId);
  if (!job) {
    throw new ProjectApiError(404, "render_job_not_found", "Render job not found.");
  }
  const artifacts = await listArtifactsForJob(db, projectId, renderJobId);
  return json({ ...publicRenderJob(job), artifacts: artifacts.map(publicArtifact) });
}

async function updateRenderJobState(
  request: Request,
  db: D1Database,
  projectId: string,
  renderJobId: string,
): Promise<Response> {
  const job = await getRenderJob(db, projectId, renderJobId);
  if (!job) {
    throw new ProjectApiError(404, "render_job_not_found", "Render job not found.");
  }
  if (!(await capabilityMatches(request, job.callbackCapabilityHash))) {
    throw new ProjectApiError(
      401,
      "render_callback_capability_invalid",
      "Render callback capability is invalid.",
    );
  }
  const input = asObject(await readBoundedJson(request, 32 * 1024));
  const nextStatus = stringValue(input.status, "status", 32);
  if (!nextStatus || !canTransitionRenderJob(job.status, nextStatus)) {
    throw new ProjectApiError(
      409,
      "invalid_render_transition",
      `Render job cannot transition from ${job.status} to ${nextStatus ?? "unknown"}.`,
    );
  }
  const progress = input.progress === undefined ? job.progress : Number(input.progress);
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    throw new ProjectApiError(400, "invalid_progress", "progress must be an integer from 0 to 100.");
  }
  const message =
    stringValue(input.message, "message", 500, { optional: true }) ?? job.message;
  const failureCode =
    input.failureCode === null
      ? null
      : (stringValue(input.failureCode, "failureCode", 100, { optional: true }) ??
        job.failureCode);
  const now = new Date().toISOString();
  const startedAt = nextStatus === "running" ? (job.startedAt ?? now) : job.startedAt;
  const terminal = new Set(["succeeded", "failed", "cancelled"]).has(nextStatus);
  const completedAt = terminal ? (job.completedAt ?? now) : null;
  const resolvedProgress = nextStatus === "succeeded" ? 100 : progress;
  const result = await db
    .prepare(
      `UPDATE render_jobs
       SET status = ?3, progress = ?4, message = ?5, failure_code = ?6,
           started_at = ?7, completed_at = ?8, updated_at = ?9
       WHERE project_id = ?1 AND id = ?2 AND status = ?10`,
    )
    .bind(
      projectId,
      renderJobId,
      nextStatus,
      resolvedProgress,
      message,
      failureCode,
      startedAt,
      completedAt,
      now,
      job.status,
    )
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new ProjectApiError(
      409,
      "render_state_conflict",
      "The render job changed before this state update was applied.",
    );
  }
  const updated = await getRenderJob(db, projectId, renderJobId);
  if (!updated) throw new Error("Updated render job could not be read back.");
  return json(publicRenderJob(updated));
}

function artifactContentType(kind: string, supplied: string | null): string {
  const defaults: Record<string, string> = {
    video: "video/mp4",
    captions_ass: "text/x-ssa; charset=utf-8",
    captions_srt: "application/x-subrip; charset=utf-8",
    captions_vtt: "text/vtt; charset=utf-8",
  };
  const contentType = (supplied ?? defaults[kind]).slice(0, 120);
  if (kind === "video" && !contentType.startsWith("video/")) {
    throw new ProjectApiError(415, "artifact_type_mismatch", "Video artifacts need a video content type.");
  }
  if (kind !== "video" && !contentType.startsWith("text/") && !contentType.startsWith("application/")) {
    throw new ProjectApiError(415, "artifact_type_mismatch", "Caption artifacts need a text content type.");
  }
  return contentType;
}

async function findArtifactByKind(
  db: D1Database,
  projectId: string,
  renderJobId: string,
  kind: string,
): Promise<ExportArtifactRow | null> {
  return db
    .prepare(
      `${EXPORT_ARTIFACT_SELECT}
       WHERE project_id = ?1 AND render_job_id = ?2 AND kind = ?3`,
    )
    .bind(projectId, renderJobId, kind)
    .first<ExportArtifactRow>();
}

async function uploadExportArtifact(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
  projectId: string,
  renderJobId: string,
  rawKind: string,
): Promise<Response> {
  let kind: string;
  try {
    kind = assertArtifactKind(rawKind);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ProjectApiError(404, "artifact_kind_unknown", error.message);
    }
    throw error;
  }
  const job = await getRenderJob(db, projectId, renderJobId);
  if (!job) {
    throw new ProjectApiError(404, "render_job_not_found", "Render job not found.");
  }
  if (!(await capabilityMatches(request, job.callbackCapabilityHash))) {
    throw new ProjectApiError(
      401,
      "render_callback_capability_invalid",
      "Render callback capability is invalid.",
    );
  }
  const existing = await findArtifactByKind(db, projectId, renderJobId, kind);
  if (existing) return json({ ...publicArtifact(existing), idempotentReplay: true });
  if (!new Set(["queued", "running"]).has(job.status)) {
    throw new ProjectApiError(409, "render_job_terminal", `Render job is ${job.status}.`);
  }
  if (!request.body) {
    throw new ProjectApiError(400, "artifact_body_required", "Artifact bytes are required.");
  }
  const byteSize = Number(request.headers.get("content-length"));
  if (!Number.isInteger(byteSize) || byteSize <= 0 || byteSize > MAX_EXPORT_BYTES) {
    throw new ProjectApiError(
      413,
      "artifact_size_invalid",
      "Artifact Content-Length must be between 1 byte and 500 MB.",
    );
  }
  const suppliedSha256 = request.headers.get("x-content-sha256");
  if (suppliedSha256 && !/^[0-9a-f]{64}$/i.test(suppliedSha256)) {
    throw new ProjectApiError(400, "artifact_hash_invalid", "x-content-sha256 must be a hex SHA-256 digest.");
  }
  const contentType = artifactContentType(kind, request.headers.get("content-type"));
  const artifactId = crypto.randomUUID();
  const r2Key = exportArtifactKey(projectId, renderJobId, artifactId, kind);
  await bucket.put(r2Key, request.body, {
    httpMetadata: { contentType },
    customMetadata: {
      projectId,
      renderJobId,
      revisionId: job.revisionId,
      artifactId,
      kind,
    },
  });
  const stored = await bucket.head(r2Key);
  if (!stored || stored.size !== byteSize) {
    await bucket.delete(r2Key);
    throw new ProjectApiError(400, "artifact_size_mismatch", "Stored artifact size does not match.");
  }
  const codecHeader = request.headers.get("x-syncword-codec-manifest");
  let codecManifestJson: string | null = null;
  if (codecHeader) {
    if (codecHeader.length > 4_096) {
      await bucket.delete(r2Key);
      throw new ProjectApiError(400, "codec_manifest_too_large", "Codec manifest is too large.");
    }
    try {
      codecManifestJson = canonicalJson(JSON.parse(codecHeader));
    } catch {
      await bucket.delete(r2Key);
      throw new ProjectApiError(400, "codec_manifest_invalid", "Codec manifest must be valid JSON.");
    }
  }
  const now = new Date().toISOString();
  const insert = await db
    .prepare(
      `INSERT INTO export_artifacts
        (id, render_job_id, project_id, revision_id, kind, r2_key, content_type,
         byte_size, etag, sha256, codec_manifest_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(render_job_id, kind) DO NOTHING`,
    )
    .bind(
      artifactId,
      renderJobId,
      projectId,
      job.revisionId,
      kind,
      r2Key,
      contentType,
      byteSize,
      stored.etag,
      suppliedSha256?.toLowerCase() ?? null,
      codecManifestJson,
      now,
    )
    .run();
  if (Number(insert.meta.changes ?? 0) !== 1) {
    await bucket.delete(r2Key);
  }
  const artifact = await findArtifactByKind(db, projectId, renderJobId, kind);
  if (!artifact) throw new Error("Created export artifact could not be read back.");
  return json(
    {
      ...publicArtifact(artifact),
      idempotentReplay: artifact.id !== artifactId,
    },
    artifact.id === artifactId ? 201 : 200,
  );
}

async function listExports(db: D1Database, projectId: string): Promise<Response> {
  const result = await db
    .prepare(
      `${EXPORT_ARTIFACT_SELECT}
       WHERE project_id = ?1
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
    )
    .bind(projectId)
    .all<ExportArtifactRow>();
  return json({ exports: result.results.map(publicArtifact) });
}

async function serveExportArtifact(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
  projectId: string,
  artifactId: string,
): Promise<Response> {
  const artifact = await db
    .prepare(`${EXPORT_ARTIFACT_SELECT} WHERE project_id = ?1 AND id = ?2`)
    .bind(projectId, artifactId)
    .first<ExportArtifactRow>();
  if (!artifact) {
    throw new ProjectApiError(404, "export_not_found", "Export artifact not found.");
  }
  const object = await bucket.get(artifact.r2Key, { range: request.headers });
  if (!object) {
    throw new ProjectApiError(503, "export_object_missing", "Export bytes are missing from object storage.");
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=60");
  const range = object.range;
  if (
    range &&
    "offset" in range &&
    "length" in range &&
    typeof range.offset === "number" &&
    typeof range.length === "number"
  ) {
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    );
    headers.set("content-length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}

async function routeProjectRequest(
  request: Request,
  env: ProjectEnv,
): Promise<Response> {
  const db = env.DB;
  if (!db) {
    throw new ProjectApiError(
      503,
      "project_database_unavailable",
      "Versioned project storage is not provisioned yet.",
    );
  }
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/projects") {
    return createProject(request, db);
  }
  const match = url.pathname.match(
    /^\/api\/projects\/([0-9a-f-]{36})(?:\/(.*))?$/i,
  );
  if (!match || !UUID_PATTERN.test(match[1])) {
    throw new ProjectApiError(404, "project_route_not_found", "Project route not found.");
  }
  const projectId = match[1].toLowerCase();
  const segments = (match[2] ?? "").split("/").filter(Boolean);
  const project = await getProject(db, projectId);
  if (!project) {
    throw new ProjectApiError(404, "project_not_found", "Project not found.");
  }

  if (projectRouteAuthorization(request.method, segments) === "render_callback") {
    const renderJobId = uuidValue(segments[1], "renderJobId");
    if (segments[2] === "state") {
      return updateRenderJobState(request, db, projectId, renderJobId);
    }
    return uploadExportArtifact(
      request,
      db,
      requireBucket(env.MEDIA),
      projectId,
      renderJobId,
      segments[3],
    );
  }

  if (!(await hasProjectCapability(request, project))) {
    throw new ProjectApiError(
      401,
      "project_capability_invalid",
      "Project capability is invalid.",
    );
  }

  if (segments.length === 0 && request.method === "GET") {
    return json(publicProject(project));
  }
  if (segments[0] === "assets") {
    if (segments.length === 1 && request.method === "POST") {
      return createAsset(request, db, requireBucket(env.MEDIA), project);
    }
    if (segments.length === 1 && request.method === "GET") {
      return listAssets(db, projectId);
    }
    if (
      segments.length === 3 &&
      segments[2] === "source" &&
      request.method === "PUT"
    ) {
      const assetId = uuidValue(segments[1], "assetId");
      return uploadAssetSource(
        request,
        db,
        requireBucket(env.MEDIA),
        projectId,
        assetId,
      );
    }
  }
  if (segments[0] === "revisions") {
    if (segments.length === 1 && request.method === "POST") {
      return createRevision(request, db, requireBucket(env.MEDIA), project);
    }
    if (segments.length === 1 && request.method === "GET") {
      return listRevisions(db, projectId);
    }
    if (segments.length === 2 && request.method === "GET") {
      const revisionId = uuidValue(segments[1], "revisionId");
      return showRevision(
        db,
        requireBucket(env.MEDIA),
        projectId,
        revisionId,
      );
    }
  }
  if (segments[0] === "render-jobs") {
    if (segments.length === 1 && request.method === "POST") {
      const rendererRevision =
        stringValue(
          env.RENDERER_REVISION ?? "syncword-render-v1",
          "RENDERER_REVISION",
          128,
        ) ?? "syncword-render-v1";
      return createRenderJob(
        request,
        db,
        requireBucket(env.MEDIA),
        project,
        rendererRevision,
      );
    }
    if (segments.length === 2 && request.method === "GET") {
      return showRenderJob(db, projectId, uuidValue(segments[1], "renderJobId"));
    }
  }
  if (segments[0] === "exports") {
    if (segments.length === 1 && request.method === "GET") {
      return listExports(db, projectId);
    }
    if (
      segments.length === 3 &&
      segments[2] === "content" &&
      request.method === "GET"
    ) {
      return serveExportArtifact(
        request,
        db,
        requireBucket(env.MEDIA),
        projectId,
        uuidValue(segments[1], "artifactId"),
      );
    }
  }
  throw new ProjectApiError(404, "project_route_not_found", "Project route not found.");
}

export async function handleProjectRequest(
  request: Request,
  env: ProjectEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/projects" && !url.pathname.startsWith("/api/projects/")) {
    return null;
  }
  try {
    return await routeProjectRequest(request, env);
  } catch (error) {
    if (error instanceof ProjectApiError) {
      return json(
        {
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        },
        error.status,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) {
      return json(
        {
          error: "Versioned project storage has not been migrated yet.",
          code: "project_database_uninitialized",
        },
        503,
      );
    }
    console.error(
      JSON.stringify({
        message: "project API request failed",
        error: message,
        method: request.method,
        path: url.pathname,
      }),
    );
    return json({ error: "Project request failed.", code: "internal_error" }, 500);
  }
}
