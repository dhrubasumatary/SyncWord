import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  assetSourceKey,
  assertArtifactKind,
  canTransitionRenderJob,
  canonicalJson,
  deriveRenderCallbackToken,
  exportArtifactKey,
  idempotencyDecision,
  isSupportedLanguageCode,
  normalizeIdempotencyKey,
  parseExportSpec,
  parseProjectDocument,
  projectRouteAuthorization,
  renderBlockReason,
  renderRequestFingerprint,
  revisionDocumentKey,
  sha256Hex,
} from "../shared/project-contract.mjs";
import { evaluateCaptionCoverage } from "../shared/caption-coverage.mjs";
import {
  prepareRevisionAdvanceBatch,
  revisionAdvanceCommitted,
} from "../shared/project-store.mjs";

const MAX_PROJECT_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 90 * 1024 * 1024;
const MAX_EXPORT_BYTES = 500 * 1024 * 1024;
const PROJECT_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PROJECT_RENDER_PROTOCOL_VERSION = 1;
const DISPATCH_LEASE_MILLISECONDS = 15 * 60 * 1_000;
const DISPATCH_RETRY_DELAY_MILLISECONDS = 30 * 1_000;
const DEFAULT_RENDER_API = "https://syncword-render-dhrub404.onrender.com";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ProjectEnv = {
  DB?: D1Database;
  MEDIA?: R2Bucket;
  RENDER_API?: Fetcher;
  RENDER_API_URL?: string;
  RENDERER_REVISION?: string;
  PROCESSOR_REVISION?: string;
  SITES_BYPASS_BEARER_TOKEN?: string;
};

type JsonRecord = Record<string, unknown>;

type CoverageSnapshot = {
  complete?: boolean;
  speechIntervals?: unknown[];
  speechDurationSeconds?: number;
  policy?: {
    minimumCoverageRatio?: number;
    maximumUncoveredGapSeconds?: number;
  };
};

type CoverageCaptionCue = {
  text: string;
  startMs: number;
  endMs: number;
  words: Array<{ startMs: number; endMs: number }>;
};

type SpeechIntervalBaseline = Array<{ start: number; end: number }>;

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
  dispatchAttempts: number;
  dispatchedAt: string | null;
  dispatchError: string | null;
  dispatchLeaseExpiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

type ProcessingJobRow = {
  id: string;
  projectId: string;
  sourceAssetId: string;
  revisionId: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
  callbackCapabilityHash: string;
  language: string;
  mode: string;
  processorRevision: string;
  status: string;
  progress: number;
  message: string;
  failureCode: string | null;
  dispatchAttempts: number;
  dispatchedAt: string | null;
  dispatchError: string | null;
  dispatchLeaseExpiresAt: string | null;
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

function json(
  payload: unknown,
  status = 200,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = new Headers(additionalHeaders);
  headers.set("cache-control", "private, no-store");
  return Response.json(payload, {
    status,
    headers,
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

function immutableCoverageBlockReason(
  document: ReturnType<typeof parseProjectDocument>,
): string | null {
  const captionTrack = document.captionTrack as typeof document.captionTrack & {
    coverage?: CoverageSnapshot;
    cues: CoverageCaptionCue[];
  };
  const status = captionTrack.status;
  if (status !== "ready" && status !== "complete") return null;
  const coverage = captionTrack.coverage;
  const durationSeconds = document.durationMs / 1_000;
  if (
    !coverage ||
    coverage.complete !== true ||
    !Array.isArray(coverage.speechIntervals) ||
    coverage.speechIntervals.length === 0
  ) {
    return "speech_coverage_unverified";
  }
  const speechIntervalsAreValid = coverage.speechIntervals.every(
    (interval: unknown, index: number, intervals: unknown[]) => {
      if (!interval || typeof interval !== "object" || Array.isArray(interval)) {
        return false;
      }
      const record = interval as JsonRecord;
      const start = Number(record.start);
      const end = Number(record.end);
      const previous = intervals[index - 1];
      const previousEnd =
        previous && typeof previous === "object" && !Array.isArray(previous)
          ? Number((previous as JsonRecord).end)
          : 0;
      return (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        (index === 0 || start >= previousEnd) &&
        end > start &&
        end <= durationSeconds
      );
    },
  );
  const reportedSpeechDuration = Number(coverage.speechDurationSeconds);
  const computedSpeechDuration = coverage.speechIntervals.reduce(
    (sum: number, interval: unknown) => {
      const record = interval as JsonRecord;
      return sum + Number(record.end) - Number(record.start);
    },
    0,
  );
  const durationTolerance = Math.max(0.1, reportedSpeechDuration * 0.005);
  if (
    !speechIntervalsAreValid ||
    !Number.isFinite(reportedSpeechDuration) ||
    reportedSpeechDuration <= 0 ||
    !Number.isFinite(computedSpeechDuration) ||
    Math.abs(computedSpeechDuration - reportedSpeechDuration) > durationTolerance
  ) {
    return "speech_coverage_unverified";
  }
  const evaluated = evaluateCaptionCoverage(
    coverage.speechIntervals,
    captionTrack.cues.map((cue: CoverageCaptionCue) => ({
      text: cue.text,
      start: cue.startMs / 1_000,
      end: cue.endMs / 1_000,
      words: cue.words.map((word: CoverageCaptionCue["words"][number]) => ({
        start: word.startMs / 1_000,
        end: word.endMs / 1_000,
      })),
    })),
    { durationSeconds },
  );
  return evaluated.complete ? null : "speech_coverage_stale";
}

function speechIntervalBaseline(
  document: ReturnType<typeof parseProjectDocument>,
): SpeechIntervalBaseline | null {
  const captionTrack = document.captionTrack as typeof document.captionTrack & {
    coverage?: CoverageSnapshot;
  };
  const intervals = captionTrack.coverage?.speechIntervals;
  if (!Array.isArray(intervals)) return null;

  const baseline: SpeechIntervalBaseline = [];
  for (const interval of intervals) {
    if (!interval || typeof interval !== "object" || Array.isArray(interval)) {
      return null;
    }
    const record = interval as JsonRecord;
    const start = record.start;
    const end = record.end;
    const previous = baseline[baseline.length - 1];
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > document.durationMs / 1_000 ||
      (previous !== undefined && start < previous.end)
    ) {
      return null;
    }
    baseline.push({ start, end });
  }
  return baseline;
}

function speechIntervalBaselineSignature(
  document: ReturnType<typeof parseProjectDocument>,
): string | null {
  const baseline = speechIntervalBaseline(document);
  return baseline === null ? null : canonicalJson(baseline);
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

function projectSessionCookieName(projectId: string): string {
  return `syncword_project_${projectId.replaceAll("-", "_")}`;
}

function projectSessionCookie(projectId: string, capabilityToken: string): string {
  return [
    `${projectSessionCookieName(projectId)}=${capabilityToken}`,
    `Path=/api/projects/${projectId}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${PROJECT_SESSION_MAX_AGE_SECONDS}`,
  ].join("; ");
}

function cookieValue(request: Request, name: string): string {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return /^[0-9a-f]{64}$/i.test(value) ? value : "";
  }
  return "";
}

function ownerCapabilityToken(request: Request, projectId: string): string {
  return (
    bearerToken(request) ||
    cookieValue(request, projectSessionCookieName(projectId))
  );
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
  const supplied = ownerCapabilityToken(request, project.id);
  if (!supplied) return false;
  const suppliedHash = await sha256Hex(supplied);
  return constantTimeHexEqual(project.capabilityHash, suppliedHash);
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
    dispatch_attempts AS dispatchAttempts,
    dispatched_at AS dispatchedAt,
    dispatch_error AS dispatchError,
    dispatch_lease_expires_at AS dispatchLeaseExpiresAt,
    created_at AS createdAt,
    started_at AS startedAt,
    completed_at AS completedAt,
    updated_at AS updatedAt
  FROM render_jobs
`;

const PROCESSING_JOB_SELECT = `
  SELECT
    id,
    project_id AS projectId,
    source_asset_id AS sourceAssetId,
    revision_id AS revisionId,
    idempotency_key AS idempotencyKey,
    request_fingerprint AS requestFingerprint,
    callback_capability_hash AS callbackCapabilityHash,
    language,
    mode,
    processor_revision AS processorRevision,
    status,
    progress,
    message,
    failure_code AS failureCode,
    dispatch_attempts AS dispatchAttempts,
    dispatched_at AS dispatchedAt,
    dispatch_error AS dispatchError,
    dispatch_lease_expires_at AS dispatchLeaseExpiresAt,
    created_at AS createdAt,
    started_at AS startedAt,
    completed_at AS completedAt,
    updated_at AS updatedAt
  FROM processing_jobs
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
    contentUrl:
      asset.status === "ready"
        ? `/api/projects/${asset.projectId}/assets/${asset.id}/content`
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
    dispatch: {
      state: job.dispatchError ? "retryable" : job.dispatchedAt ? "dispatched" : "pending",
      attempts: job.dispatchAttempts,
      dispatchedAt: job.dispatchedAt,
      leaseExpiresAt: job.dispatchLeaseExpiresAt,
    },
    exportSpec,
    rendererRevision: job.rendererRevision,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  };
}

function publicProcessingJob(job: ProcessingJobRow) {
  return {
    id: job.id,
    projectId: job.projectId,
    sourceAssetId: job.sourceAssetId,
    revisionId: job.revisionId,
    language: job.language,
    mode: job.mode,
    processorRevision: job.processorRevision,
    status: job.status,
    progress: job.progress,
    message: job.message,
    failureCode: job.failureCode,
    dispatch: {
      state: job.dispatchError ? "retryable" : job.dispatchedAt ? "dispatched" : "pending",
      attempts: job.dispatchAttempts,
      dispatchedAt: job.dispatchedAt,
      leaseExpiresAt: job.dispatchLeaseExpiresAt,
    },
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  };
}

function renderJobAcceptance(
  job: RenderJobRow,
  idempotentReplay: boolean,
) {
  return {
    ...publicRenderJob(job),
    idempotentReplay,
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
  return json(
    {
      ...publicProject(project),
      session: { authenticated: true, transport: "http_only_cookie" },
    },
    201,
    { "set-cookie": projectSessionCookie(id, capabilityToken) },
  );
}

function establishProjectSession(
  request: Request,
  project: ProjectRow,
): Response {
  const capabilityToken = ownerCapabilityToken(request, project.id);
  if (!capabilityToken) {
    throw new ProjectApiError(
      401,
      "project_capability_invalid",
      "Project capability is invalid.",
    );
  }
  return json(
    {
      projectId: project.id,
      authenticated: true,
      transport: "http_only_cookie",
    },
    200,
    { "set-cookie": projectSessionCookie(project.id, capabilityToken) },
  );
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

async function serveAssetContent(request: Request, db: D1Database, bucket: R2Bucket,
  projectId: string, assetId: string): Promise<Response> {
  const asset = await getAsset(db, projectId, assetId);
  if (!asset || asset.status !== "ready") throw new ProjectApiError(404, "asset_not_found", "Ready asset not found.");
  const object = await bucket.get(asset.sourceR2Key, { range: request.headers });
  if (!object) throw new ProjectApiError(503, "source_object_missing", "Asset bytes are missing.");
  return renderInputObjectResponse(object);
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
  if (!baseRevisionId) {
    throw new ProjectApiError(
      409,
      "revision_base_required",
      "The first revision must come from the server caption processor.",
      { expectedBaseRevisionId: project.headRevisionId },
    );
  }
  if (project.headRevisionId !== baseRevisionId) {
    throw new ProjectApiError(
      409,
      "revision_conflict",
      "The project head changed before this revision was saved.",
      { expectedBaseRevisionId: project.headRevisionId },
    );
  }
  const baseRevision = await getRevision(db, project.id, baseRevisionId);
  if (!baseRevision) {
    throw new ProjectApiError(
      409,
      "revision_conflict",
      "The immutable base revision is unavailable.",
      { expectedBaseRevisionId: project.headRevisionId },
    );
  }
  const baseDocument = await loadRevisionDocument(bucket, baseRevision);
  if (document.sourceAssetId !== baseDocument.sourceAssetId) {
    throw new ProjectApiError(
      409,
      "revision_source_mismatch",
      "An editor revision must keep the immutable base source asset.",
      { baseRevisionId },
    );
  }
  const baseSpeechIntervals = speechIntervalBaselineSignature(baseDocument);
  const submittedSpeechIntervals = speechIntervalBaselineSignature(document);
  if (
    !baseSpeechIntervals ||
    !submittedSpeechIntervals ||
    baseSpeechIntervals !== submittedSpeechIntervals
  ) {
    throw new ProjectApiError(
      409,
      "speech_activity_baseline_mismatch",
      "Editor revisions must preserve the server-produced speech activity baseline.",
      { baseRevisionId, reason: "speech_intervals_must_match_base" },
    );
  }
  const coverageBlockReason = immutableCoverageBlockReason(document);
  if (coverageBlockReason) {
    throw new ProjectApiError(
      400,
      "invalid_project_coverage",
      "Caption coverage does not verify the current immutable cues.",
      { reason: coverageBlockReason },
    );
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

async function processingCapabilityToken(
  ownerCapability: string,
  jobId: string,
  fingerprint: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(ownerCapability),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `syncword-processing-callback:v1:${jobId}:${fingerprint}`,
    ),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function getProcessingJob(
  db: D1Database,
  projectId: string,
  jobId: string,
): Promise<ProcessingJobRow | null> {
  return db
    .prepare(`${PROCESSING_JOB_SELECT} WHERE project_id = ?1 AND id = ?2`)
    .bind(projectId, jobId)
    .first<ProcessingJobRow>();
}

async function processingCapabilityForJob(
  ownerCapability: string,
  job: ProcessingJobRow,
): Promise<string> {
  const token = await processingCapabilityToken(
    ownerCapability,
    job.id,
    job.requestFingerprint,
  );
  if (!constantTimeHexEqual(job.callbackCapabilityHash, await sha256Hex(token))) {
    throw new ProjectApiError(503, "processing_capability_corrupt", "Processing capability is corrupt.");
  }
  return token;
}

async function requireProcessingCapability(
  request: Request,
  db: D1Database,
  projectId: string,
  jobId: string,
): Promise<ProcessingJobRow> {
  const job = await getProcessingJob(db, projectId, jobId);
  if (!job) throw new ProjectApiError(404, "processing_job_not_found", "Processing job not found.");
  if (!(await capabilityMatches(request, job.callbackCapabilityHash))) {
    throw new ProjectApiError(401, "processing_callback_capability_invalid", "Processing callback capability is invalid.");
  }
  return job;
}

function processingUrls(request: Request, job: ProcessingJobRow) {
  const base = `/api/projects/${job.projectId}/processing-jobs/${job.id}`;
  const absolute = (path: string) => new URL(path, request.url).href;
  return {
    sourceUrl: absolute(`${base}/source`),
    baseUrl: absolute(base),
    stateUrl: absolute(`${base}/state`),
    resultUrl: absolute(`${base}/result`),
  };
}

async function dispatchProcessingJob(
  request: Request,
  env: ProjectEnv,
  db: D1Database,
  job: ProcessingJobRow,
  asset: AssetRow,
  token: string,
  forceRetry = false,
): Promise<ProcessingJobRow> {
  if (!isSupportedLanguageCode(job.language)) {
    throw new ProjectApiError(
      409,
      "unsupported_processing_language",
      "Choose Assamese or Bodo before restarting caption processing.",
    );
  }
  if (
    !new Set(["queued", "extracting", "transcribing", "aligning", "recovering"]).has(
      job.status,
    )
  ) {
    return job;
  }
  const endpoint = renderApiEndpoint(env, "/v3/processing-jobs");
  const claimedAt = new Date();
  const now = claimedAt.toISOString();
  const leaseExpiresAt = new Date(
    claimedAt.getTime() + DISPATCH_LEASE_MILLISECONDS,
  ).toISOString();
  const claim = await db.prepare(`UPDATE processing_jobs
    SET dispatch_attempts = dispatch_attempts + 1, dispatch_error = NULL,
        dispatch_lease_expires_at = ?4, message = ?6, updated_at = ?3
    WHERE project_id = ?1 AND id = ?2
      AND status IN ('queued','extracting','transcribing','aligning','recovering')
      AND (
        dispatch_lease_expires_at IS NULL OR dispatch_lease_expires_at <= ?3
        OR (?5 = 1 AND dispatch_error IS NOT NULL)
      )`)
    .bind(
      job.projectId,
      job.id,
      now,
      leaseExpiresAt,
      forceRetry ? 1 : 0,
      job.dispatchedAt ? "Re-dispatching caption processing" : "Dispatching caption processing",
    ).run();
  if (Number(claim.meta.changes ?? 0) !== 1) {
    return (await getProcessingJob(db, job.projectId, job.id)) ?? job;
  }
  const urls = processingUrls(request, job);
  const payload = {
    schemaVersion: 1,
    id: job.id,
    projectId: job.projectId,
    requestFingerprint: job.requestFingerprint,
    processorRevision: job.processorRevision,
    source: { assetId: asset.id, url: urls.sourceUrl, contentType: asset.contentType,
      byteSize: asset.byteSize, etag: asset.sourceEtag, sha256: asset.sha256 },
    processing: { language: job.language, mode: job.mode },
    callback: { baseUrl: urls.baseUrl, stateUrl: urls.stateUrl, resultUrl: urls.resultUrl },
    authorization: { processingCapabilityToken: token,
      ...(env.SITES_BYPASS_BEARER_TOKEN ? { sitesAuthorization: env.SITES_BYPASS_BEARER_TOKEN } : {}) },
  };
  let response: Response;
  try {
    response = await fetchRenderer(env, new Request(endpoint, { method: "POST", headers: {
      "content-type": "application/json; charset=utf-8", "idempotency-key": job.id,
      "x-syncword-request-fingerprint": job.requestFingerprint }, body: canonicalJson(payload) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = new Date();
    await db.prepare(`UPDATE processing_jobs SET dispatch_error = ?3,
      dispatch_lease_expires_at = ?5, message = 'Processing dispatch needs retry', updated_at = ?4
      WHERE project_id = ?1 AND id = ?2 AND dispatch_lease_expires_at = ?6`)
      .bind(job.projectId, job.id, message.slice(0, 500), failedAt.toISOString(),
        new Date(failedAt.getTime() + DISPATCH_RETRY_DELAY_MILLISECONDS).toISOString(),
        leaseExpiresAt).run();
    throw new ProjectApiError(502, "processing_dispatch_failed", "Caption processing dispatch failed. Retry the same idempotency key.",
      { processingJobId: job.id, retryable: true });
  }
  const upstreamStatus = response.status;
  await response.body?.cancel();
  if (!response.ok) {
    const failedAt = new Date();
    await db.prepare(`UPDATE processing_jobs SET dispatch_error = ?3,
      dispatch_lease_expires_at = ?5, message = 'Processing dispatch needs retry', updated_at = ?4
      WHERE project_id = ?1 AND id = ?2 AND dispatch_lease_expires_at = ?6`)
      .bind(job.projectId, job.id, `HTTP ${upstreamStatus}`, failedAt.toISOString(),
        new Date(failedAt.getTime() + DISPATCH_RETRY_DELAY_MILLISECONDS).toISOString(),
        leaseExpiresAt).run();
    throw new ProjectApiError(502, "processing_dispatch_rejected", "Caption processor rejected the job. Retry the same idempotency key.",
      { processingJobId: job.id, rendererStatus: upstreamStatus, retryable: true });
  }
  const dispatchedAt = new Date().toISOString();
  await db.prepare(`UPDATE processing_jobs SET dispatched_at = COALESCE(dispatched_at, ?3),
    dispatch_error = NULL, message = 'Queued in caption processor', updated_at = ?3
    WHERE project_id = ?1 AND id = ?2 AND dispatch_lease_expires_at = ?4`)
    .bind(job.projectId, job.id, dispatchedAt, leaseExpiresAt).run();
  const updated = await getProcessingJob(db, job.projectId, job.id);
  if (!updated) throw new Error("Dispatched processing job could not be read back.");
  return updated;
}

async function createProcessingJob(request: Request, env: ProjectEnv, db: D1Database,
  project: ProjectRow, processorRevision: string): Promise<Response> {
  const input = asObject(await readBoundedJson(request, 32 * 1024));
  const sourceAssetId = uuidValue(input.sourceAssetId, "sourceAssetId");
  const asset = await getAsset(db, project.id, sourceAssetId);
  if (!asset || asset.status !== "ready") throw new ProjectApiError(409, "source_asset_not_ready", "Source asset is not ready.");
  if (asset.kind !== "source_video" || !asset.contentType.startsWith("video/")) {
    throw new ProjectApiError(415, "unsupported_processing_source", "Caption processing currently requires a source video.");
  }
  const language = stringValue(input.language, "language", 32);
  if (!isSupportedLanguageCode(language)) {
    throw new ProjectApiError(400, "invalid_processing_language", "language must be as-IN or brx-IN.");
  }
  const mode = stringValue(input.mode ?? "codemix", "mode", 32) ?? "codemix";
  if (!new Set(["codemix", "verbatim", "transcribe"]).has(mode)) {
    throw new ProjectApiError(400, "invalid_processing_mode", "mode must be codemix, verbatim, or transcribe.");
  }
  const fingerprint = await sha256Hex(canonicalJson({ projectId: project.id, sourceAssetId,
    language, mode, processorRevision }));
  const headerKey = request.headers.get("idempotency-key") ?? undefined;
  if (headerKey && input.idempotencyKey && headerKey !== input.idempotencyKey) {
    throw new ProjectApiError(400, "idempotency_key_mismatch", "Header and body idempotency keys must match.");
  }
  let idempotencyKey: string;
  try { idempotencyKey = normalizeIdempotencyKey(headerKey ?? input.idempotencyKey, fingerprint); }
  catch (error) { throw new ProjectApiError(400, "invalid_idempotency_key", error instanceof Error ? error.message : "Invalid idempotency key."); }
  let existing = await db.prepare(`${PROCESSING_JOB_SELECT} WHERE project_id = ?1 AND idempotency_key = ?2`)
    .bind(project.id, idempotencyKey).first<ProcessingJobRow>();
  if (project.headRevisionId && !existing) throw new ProjectApiError(409, "project_already_initialized", "Project already has a first revision.");
  const decision = idempotencyDecision(existing?.requestFingerprint, fingerprint);
  if (decision === "conflict") throw new ProjectApiError(409, "idempotency_conflict", "Idempotency key names different processing input.");
  const owner = ownerCapabilityToken(request, project.id);
  const proposedId = existing?.id ?? crypto.randomUUID();
  let token = existing ? await processingCapabilityForJob(owner, existing) :
    await processingCapabilityToken(owner, proposedId, fingerprint);
  if (!existing) {
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO processing_jobs
      (id, project_id, source_asset_id, idempotency_key, request_fingerprint,
       callback_capability_hash, language, mode, processor_revision, status, progress, message, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'queued', 0, 'Queued for captioning', ?10, ?10)
      ON CONFLICT(project_id, idempotency_key) DO NOTHING`)
      .bind(proposedId, project.id, sourceAssetId, idempotencyKey, fingerprint,
        await sha256Hex(token), language, mode, processorRevision, now).run();
    existing = await db.prepare(`${PROCESSING_JOB_SELECT} WHERE project_id = ?1 AND idempotency_key = ?2`)
      .bind(project.id, idempotencyKey).first<ProcessingJobRow>();
  }
  if (!existing || existing.requestFingerprint !== fingerprint) throw new ProjectApiError(409, "idempotency_conflict", "Processing job conflict.");
  token = await processingCapabilityForJob(owner, existing);
  const updated = await dispatchProcessingJob(request, env, db, existing, asset, token, true);
  return json({ ...publicProcessingJob(updated), idempotentReplay: decision === "replay" || updated.id !== proposedId },
    decision === "replay" || updated.id !== proposedId ? 200 : 202);
}

function projectRenderUrls(request: Request, job: RenderJobRow) {
  const basePath = `/api/projects/${job.projectId}/render-jobs/${job.id}`;
  const absolute = (path: string) => new URL(path, request.url).href;
  return {
    sourceUrl: absolute(`${basePath}/source`),
    revisionUrl: absolute(`${basePath}/revision`),
    callbackBaseUrl: absolute(basePath),
    stateUrl: absolute(`${basePath}/state`),
    artifacts: {
      video: absolute(`${basePath}/artifacts/video`),
      captions_ass: absolute(`${basePath}/artifacts/captions_ass`),
      captions_srt: absolute(`${basePath}/artifacts/captions_srt`),
      captions_vtt: absolute(`${basePath}/artifacts/captions_vtt`),
    },
  };
}

function renderApiEndpoint(env: ProjectEnv, path: string): URL {
  let base: URL;
  try {
    base = new URL(env.RENDER_API_URL ?? DEFAULT_RENDER_API);
  } catch {
    throw new ProjectApiError(
      503,
      "render_api_invalid",
      "The project renderer URL is invalid.",
    );
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new ProjectApiError(
      503,
      "render_api_invalid",
      "The project renderer URL must use HTTP or HTTPS.",
    );
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
  base.search = "";
  base.hash = "";
  return base;
}

async function fetchRenderer(env: ProjectEnv, request: Request): Promise<Response> {
  if (env.RENDER_API) return env.RENDER_API.fetch(request);
  return fetch(request);
}

async function recordDispatchFailure(
  db: D1Database,
  job: RenderJobRow,
  message: string,
  claimedLeaseExpiresAt: string,
): Promise<void> {
  const failedAt = new Date();
  const now = failedAt.toISOString();
  const retryAt = new Date(
    failedAt.getTime() + DISPATCH_RETRY_DELAY_MILLISECONDS,
  ).toISOString();
  await db
    .prepare(
      `UPDATE render_jobs
       SET dispatch_error = ?3, dispatch_lease_expires_at = ?5,
           message = 'Render dispatch needs retry', updated_at = ?4
       WHERE project_id = ?1 AND id = ?2 AND dispatch_lease_expires_at = ?6`,
    )
    .bind(job.projectId, job.id, message.slice(0, 500), now, retryAt, claimedLeaseExpiresAt)
    .run();
}

async function dispatchRenderJob(
  request: Request,
  env: ProjectEnv,
  db: D1Database,
  job: RenderJobRow,
  revision: RevisionRow,
  sourceAsset: AssetRow,
  exportSpec: ReturnType<typeof parseExportSpec>,
  callbackCapabilityToken: string,
  forceRetry = false,
): Promise<RenderJobRow> {
  if (!new Set(["queued", "running"]).has(job.status)) return job;

  const endpoint = renderApiEndpoint(env, "/v3/render-jobs");

  const claimedAt = new Date();
  const now = claimedAt.toISOString();
  const leaseExpiresAt = new Date(
    claimedAt.getTime() + DISPATCH_LEASE_MILLISECONDS,
  ).toISOString();
  const claim = await db
    .prepare(
      `UPDATE render_jobs
       SET dispatch_attempts = dispatch_attempts + 1, dispatch_error = NULL,
           dispatch_lease_expires_at = ?4, message = ?6, updated_at = ?3
       WHERE project_id = ?1 AND id = ?2 AND status IN ('queued', 'running')
         AND (
           dispatch_lease_expires_at IS NULL OR dispatch_lease_expires_at <= ?3
           OR (?5 = 1 AND dispatch_error IS NOT NULL)
         )`,
    )
    .bind(
      job.projectId,
      job.id,
      now,
      leaseExpiresAt,
      forceRetry ? 1 : 0,
      job.dispatchedAt ? "Re-dispatching immutable render" : "Dispatching immutable render",
    )
    .run();
  if (Number(claim.meta.changes ?? 0) !== 1) {
    return (await getRenderJob(db, job.projectId, job.id)) ?? job;
  }

  const urls = projectRenderUrls(request, job);
  const payload = {
    schemaVersion: PROJECT_RENDER_PROTOCOL_VERSION,
    id: job.id,
    projectId: job.projectId,
    requestFingerprint: job.requestFingerprint,
    rendererRevision: job.rendererRevision,
    revision: {
      id: revision.id,
      schemaVersion: revision.schemaVersion,
      documentHash: revision.documentHash,
      sourceAssetId: revision.sourceAssetId,
      url: urls.revisionUrl,
    },
    source: {
      assetId: sourceAsset.id,
      url: urls.sourceUrl,
      contentType: sourceAsset.contentType,
      byteSize: sourceAsset.byteSize,
      etag: sourceAsset.sourceEtag,
      sha256: sourceAsset.sha256,
    },
    exportSpec,
    callback: {
      baseUrl: urls.callbackBaseUrl,
      stateUrl: urls.stateUrl,
      artifacts: urls.artifacts,
    },
    authorization: {
      renderCapabilityToken: callbackCapabilityToken,
      ...(env.SITES_BYPASS_BEARER_TOKEN
        ? { sitesAuthorization: env.SITES_BYPASS_BEARER_TOKEN }
        : {}),
    },
  };

  let response: Response;
  try {
    response = await fetchRenderer(
      env,
      new Request(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json; charset=utf-8",
          "idempotency-key": job.id,
          "x-syncword-request-fingerprint": job.requestFingerprint,
        },
        body: canonicalJson(payload),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordDispatchFailure(db, job, message, leaseExpiresAt);
    throw new ProjectApiError(
      502,
      "render_dispatch_failed",
      "The immutable render could not be dispatched. Retry with the same idempotency key.",
      { renderJobId: job.id, retryable: true },
    );
  }

  const rendererStatus = response.status;
  await response.body?.cancel();
  if (!response.ok) {
    await recordDispatchFailure(
      db,
      job,
      `Renderer rejected immutable job with HTTP ${rendererStatus}.`,
      leaseExpiresAt,
    );
    throw new ProjectApiError(
      502,
      "render_dispatch_rejected",
      "The renderer rejected the immutable render. Retry with the same idempotency key after the renderer is fixed.",
      { renderJobId: job.id, rendererStatus, retryable: true },
    );
  }

  const dispatchedAt = new Date().toISOString();
  await db
    .prepare(
      `UPDATE render_jobs
       SET dispatched_at = COALESCE(dispatched_at, ?3), dispatch_error = NULL,
           message = 'Queued in renderer', updated_at = ?3
       WHERE project_id = ?1 AND id = ?2 AND dispatch_lease_expires_at = ?4`,
    )
    .bind(job.projectId, job.id, dispatchedAt, leaseExpiresAt)
    .run();
  const dispatched = await getRenderJob(db, job.projectId, job.id);
  if (!dispatched) throw new Error("Dispatched render job could not be read back.");
  return dispatched;
}

async function createRenderJob(
  request: Request,
  env: ProjectEnv,
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
  const blockReason =
    renderBlockReason(document) ?? immutableCoverageBlockReason(document);
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
  if (existingDecision === "conflict") {
    throw new ProjectApiError(
      409,
      "idempotency_conflict",
      "This idempotency key already names a different render request.",
    );
  }

  const ownerCapability = ownerCapabilityToken(request, project.id);
  let renderJobId = existing?.id ?? crypto.randomUUID();
  let callbackCapabilityToken = existing
    ? await callbackCapabilityForJob(ownerCapability, existing)
    : await deriveRenderCallbackToken(ownerCapability, renderJobId, fingerprint);
  const callbackCapabilityHash = await sha256Hex(callbackCapabilityToken);
  const now = new Date().toISOString();
  const exportSpecJson = canonicalJson(exportSpec);
  if (!existing) {
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
  }
  let persisted = await findRenderJobByIdempotencyKey(db, project.id, idempotencyKey);
  if (!persisted) throw new Error("Created render job could not be read back.");
  if (persisted.requestFingerprint !== fingerprint) {
    throw new ProjectApiError(
      409,
      "idempotency_conflict",
      "This idempotency key already names a different render request.",
    );
  }
  const idempotentReplay = persisted.id !== renderJobId || existingDecision === "replay";
  renderJobId = persisted.id;
  callbackCapabilityToken = await callbackCapabilityForJob(ownerCapability, persisted);
  persisted = await dispatchRenderJob(
    request,
    env,
    db,
    persisted,
    revision,
    sourceAsset,
    exportSpec,
    callbackCapabilityToken,
    true,
  );
  return json(
    renderJobAcceptance(persisted, idempotentReplay),
    idempotentReplay ? 200 : 202,
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

function dispatchLeaseIsStale(
  job: Pick<RenderJobRow | ProcessingJobRow, "dispatchLeaseExpiresAt">,
  now = Date.now(),
): boolean {
  if (!job.dispatchLeaseExpiresAt) return true;
  const expiresAt = Date.parse(job.dispatchLeaseExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

async function showRenderJob(
  request: Request,
  env: ProjectEnv,
  db: D1Database,
  project: ProjectRow,
  renderJobId: string,
): Promise<Response> {
  let job = await getRenderJob(db, project.id, renderJobId);
  if (!job) {
    throw new ProjectApiError(404, "render_job_not_found", "Render job not found.");
  }
  if (new Set(["queued", "running"]).has(job.status) && dispatchLeaseIsStale(job)) {
    const revision = await getRevision(db, project.id, job.revisionId);
    if (!revision) throw new ProjectApiError(503, "revision_not_found", "Render revision is unavailable.");
    const sourceAsset = await getAsset(db, project.id, revision.sourceAssetId);
    if (!sourceAsset || sourceAsset.status !== "ready") {
      throw new ProjectApiError(503, "source_asset_not_ready", "Render source is unavailable.");
    }
    let exportSpec: ReturnType<typeof parseExportSpec>;
    try {
      exportSpec = parseExportSpec(JSON.parse(job.exportSpecJson));
    } catch {
      throw new ProjectApiError(503, "render_job_corrupt", "Stored render input is invalid.");
    }
    const token = await callbackCapabilityForJob(
      ownerCapabilityToken(request, project.id),
      job,
    );
    try {
      job = await dispatchRenderJob(
        request,
        env,
        db,
        job,
        revision,
        sourceAsset,
        exportSpec,
        token,
      );
    } catch (error) {
      if (!(error instanceof ProjectApiError) || error.status !== 502) throw error;
      job = (await getRenderJob(db, project.id, renderJobId)) ?? job;
    }
  }
  const artifacts = await listArtifactsForJob(db, project.id, renderJobId);
  return json({ ...publicRenderJob(job), artifacts: artifacts.map(publicArtifact) });
}

async function showProcessingJob(
  request: Request,
  env: ProjectEnv,
  db: D1Database,
  project: ProjectRow,
  jobId: string,
): Promise<Response> {
  let job = await getProcessingJob(db, project.id, jobId);
  if (!job) throw new ProjectApiError(404, "processing_job_not_found", "Processing job not found.");
  if (
    new Set(["queued", "extracting", "transcribing", "aligning", "recovering"]).has(
      job.status,
    ) && dispatchLeaseIsStale(job)
  ) {
    const asset = await getAsset(db, project.id, job.sourceAssetId);
    if (!asset || asset.status !== "ready") {
      throw new ProjectApiError(503, "source_asset_not_ready", "Processing source is unavailable.");
    }
    const token = await processingCapabilityForJob(
      ownerCapabilityToken(request, project.id),
      job,
    );
    try {
      job = await dispatchProcessingJob(request, env, db, job, asset, token);
    } catch (error) {
      if (!(error instanceof ProjectApiError) || error.status !== 502) throw error;
      job = (await getProcessingJob(db, project.id, jobId)) ?? job;
    }
  }
  return json(publicProcessingJob(job));
}

async function serveProcessingSource(request: Request, db: D1Database, bucket: R2Bucket,
  projectId: string, jobId: string): Promise<Response> {
  const job = await requireProcessingCapability(request, db, projectId, jobId);
  if (new Set(["ready", "review_required", "failed", "cancelled"]).has(job.status)) {
    throw new ProjectApiError(409, "processing_job_terminal", `Processing job is ${job.status}.`);
  }
  const asset = await getAsset(db, projectId, job.sourceAssetId);
  if (!asset || asset.status !== "ready") throw new ProjectApiError(503, "source_asset_not_ready", "Processing source is unavailable.");
  const object = await bucket.get(asset.sourceR2Key, { range: request.headers });
  if (!object) throw new ProjectApiError(503, "source_object_missing", "Processing source is missing.");
  return renderInputObjectResponse(object);
}

async function updateProcessingState(request: Request, db: D1Database, projectId: string,
  jobId: string): Promise<Response> {
  const job = await requireProcessingCapability(request, db, projectId, jobId);
  const input = asObject(await readBoundedJson(request, 32 * 1024));
  const status = stringValue(input.status, "status", 32);
  const callbackStatuses = new Set(["queued", "extracting", "transcribing", "aligning", "recovering", "failed", "cancelled"]);
  if (!status || !callbackStatuses.has(status)) throw new ProjectApiError(409, "invalid_processing_transition", "Final ready/review state requires a result callback.");
  if (new Set(["ready", "review_required", "failed", "cancelled"]).has(job.status) && status !== job.status) {
    throw new ProjectApiError(409, "invalid_processing_transition", `Processing job cannot transition from ${job.status}.`);
  }
  const rank: Record<string, number> = { queued: 0, extracting: 1, transcribing: 2, aligning: 3, recovering: 4 };
  if (status in rank && job.status in rank && rank[status] < rank[job.status]) {
    throw new ProjectApiError(409, "invalid_processing_transition", `Processing job cannot move backward from ${job.status} to ${status}.`);
  }
  const progress = input.progress === undefined ? job.progress : Number(input.progress);
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw new ProjectApiError(400, "invalid_progress", "progress must be 0 to 100.");
  const message = stringValue(input.message, "message", 500, { optional: true }) ?? job.message;
  const failureCode = input.failureCode === null ? null :
    (stringValue(input.failureCode, "failureCode", 100, { optional: true }) ?? job.failureCode);
  const callbackAt = new Date();
  const now = callbackAt.toISOString();
  const startedAt = status !== "queued" ? (job.startedAt ?? now) : job.startedAt;
  const terminal = new Set(["failed", "cancelled"]).has(status);
  const completedAt = terminal ? (job.completedAt ?? now) : null;
  const leaseExpiresAt = terminal
    ? null
    : new Date(callbackAt.getTime() + DISPATCH_LEASE_MILLISECONDS).toISOString();
  const result = await db.prepare(`UPDATE processing_jobs SET status = ?3, progress = ?4,
    message = ?5, failure_code = ?6, dispatch_error = NULL,
    started_at = ?7, completed_at = ?8,
    dispatch_lease_expires_at = ?9, dispatched_at = COALESCE(dispatched_at, ?10), updated_at = ?10
    WHERE project_id = ?1 AND id = ?2 AND status = ?11`)
    .bind(projectId, jobId, status, progress, message, failureCode, startedAt,
      completedAt, leaseExpiresAt, now, job.status).run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new ProjectApiError(409, "processing_state_conflict", "Processing job changed concurrently.");
  const updated = await getProcessingJob(db, projectId, jobId);
  if (!updated) throw new Error("Updated processing job missing.");
  return json(publicProcessingJob(updated));
}

async function finalizeProcessingResult(request: Request, db: D1Database, bucket: R2Bucket,
  project: ProjectRow, jobId: string): Promise<Response> {
  const job = await requireProcessingCapability(request, db, project.id, jobId);
  if (job.revisionId) return json({ ...publicProcessingJob(job), idempotentReplay: true });
  if (new Set(["failed", "cancelled"]).has(job.status)) throw new ProjectApiError(409, "processing_job_terminal", `Processing job is ${job.status}.`);
  const input = asObject(await readBoundedJson(request));
  let document: ReturnType<typeof parseProjectDocument>;
  try { document = parseProjectDocument(input.document); }
  catch (error) { throw new ProjectApiError(400, "invalid_project_document", error instanceof Error ? error.message : "Invalid document."); }
  if (document.sourceAssetId !== job.sourceAssetId) throw new ProjectApiError(400, "processing_source_mismatch", "Result references a different source asset.");
  if (document.captionTrack.languageCode !== job.language) {
    throw new ProjectApiError(
      400,
      "processing_language_mismatch",
      "Result language must match the selected processing language.",
    );
  }
  if (!new Set(["ready", "review_required"]).has(document.captionTrack.status)) {
    throw new ProjectApiError(400, "invalid_processing_result", "Result status must be ready or review_required.");
  }
  if (speechIntervalBaseline(document) === null) {
    throw new ProjectApiError(
      400,
      "invalid_project_coverage",
      "Processing results must include a valid server-produced speech activity baseline.",
      { reason: "speech_activity_baseline_missing" },
    );
  }
  const coverageReason = immutableCoverageBlockReason(document);
  if (coverageReason) throw new ProjectApiError(400, "invalid_project_coverage", "Processing result coverage does not verify its cues.", { reason: coverageReason });
  const revisionId = job.id;
  const text = canonicalJson(document);
  const documentHash = await sha256Hex(text);
  const key = revisionDocumentKey(project.id, revisionId);
  const now = new Date().toISOString();
  const storedDocument = await bucket.put(key, text, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { projectId: project.id, revisionId, documentHash, processingJobId: job.id },
  });
  if (!storedDocument) {
    const existingDocument = await bucket.head(key);
    if (existingDocument?.customMetadata?.documentHash !== documentHash) {
      throw new ProjectApiError(
        409,
        "processing_result_conflict",
        "A different immutable result was already received for this processing job.",
      );
    }
  }
  const changeSummary = stringValue(input.changeSummary, "changeSummary", 500, { optional: true }) ?? "Initial automatic captions";
  let results: D1Result[];
  try {
    const revisionInput = { projectId: project.id, id: revisionId,
      parentRevisionId: null, sourceAssetId: job.sourceAssetId, schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
      documentR2Key: key, documentHash, captionStatus: document.captionTrack.status,
      captionLanguage: document.captionTrack.languageCode, changeSummary, createdBy: "caption-processor", createdAt: now };
    const [, advanceProjectHead] = prepareRevisionAdvanceBatch(db, revisionInput);
    const insertRevisionWhileProcessing = db.prepare(`
      INSERT INTO project_revisions
        (id, project_id, parent_revision_id, source_asset_id, schema_version,
         document_r2_key, document_hash, caption_status, caption_language,
         change_summary, created_by, created_at)
      SELECT ?2, ?1, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
      FROM projects
      WHERE id = ?1 AND status = 'active' AND head_revision_id IS NULL
        AND EXISTS (
          SELECT 1 FROM processing_jobs
          WHERE project_id = ?1 AND id = ?2 AND source_asset_id = ?3
            AND revision_id IS NULL AND status NOT IN ('failed', 'cancelled')
        )
    `).bind(project.id, revisionId, job.sourceAssetId, PROJECT_DOCUMENT_SCHEMA_VERSION,
      key, documentHash, document.captionTrack.status, document.captionTrack.languageCode,
      changeSummary, "caption-processor", now);
    results = await db.batch([insertRevisionWhileProcessing, advanceProjectHead,
      db.prepare(`UPDATE processing_jobs SET revision_id = ?3, status = ?4, progress = 100,
        message = ?5, dispatch_error = NULL, completed_at = ?6, dispatch_lease_expires_at = NULL,
        dispatched_at = COALESCE(dispatched_at, ?6), updated_at = ?6
        WHERE project_id = ?1 AND id = ?2 AND revision_id IS NULL AND status NOT IN ('failed','cancelled')`)
        .bind(project.id, job.id, revisionId, document.captionTrack.status,
          document.captionTrack.status === "ready" ? "Captions ready" : "Caption review required", now)]);
  } catch (error) {
    // The conditional R2 write is intentionally left for an identical retry or
    // garbage collection when D1 availability is uncertain.
    throw error;
  }
  if (!revisionAdvanceCommitted(results) || Number(results[2]?.meta?.changes ?? 0) !== 1) {
    const committedJob = await getProcessingJob(db, project.id, job.id);
    if (committedJob?.revisionId === revisionId) {
      const committedRevision = await getRevision(db, project.id, revisionId);
      if (committedRevision) {
        return json({ ...publicProcessingJob(committedJob), revision: publicRevision(committedRevision), idempotentReplay: true });
      }
    }
    if (storedDocument) await bucket.delete(key);
    throw new ProjectApiError(409, "processing_revision_conflict", "Project head changed before initial captions were saved.");
  }
  const updated = await getProcessingJob(db, project.id, job.id);
  if (!updated) throw new Error("Finalized processing job missing.");
  const revision = await getRevision(db, project.id, revisionId);
  if (!revision) throw new Error("Finalized processing revision missing.");
  return json({ ...publicProcessingJob(updated), revision: publicRevision(revision), idempotentReplay: false }, 201);
}

async function cancelProcessingJob(request: Request, env: ProjectEnv, db: D1Database,
  project: ProjectRow, jobId: string): Promise<Response> {
  let job = await getProcessingJob(db, project.id, jobId);
  if (!job) throw new ProjectApiError(404, "processing_job_not_found", "Processing job not found.");
  if (new Set(["ready", "review_required", "failed"]).has(job.status)) throw new ProjectApiError(409, "processing_job_terminal", `Processing job is ${job.status}.`);
  let replay = job.status === "cancelled";
  if (!replay) {
    const now = new Date().toISOString();
    const cancelled = await db.prepare(`UPDATE processing_jobs SET status='cancelled', message='Processing cancelled',
      completed_at=?3, dispatch_lease_expires_at=NULL, updated_at=?3
      WHERE project_id=?1 AND id=?2 AND status NOT IN ('ready','review_required','failed','cancelled')`)
      .bind(project.id, job.id, now).run();
    job = (await getProcessingJob(db, project.id, job.id))!;
    if (Number(cancelled.meta.changes ?? 0) !== 1) {
      if (job.status === "cancelled") replay = true;
      else throw new ProjectApiError(409, "processing_job_terminal", `Processing job is ${job.status}.`);
    }
  }
  const token = await processingCapabilityForJob(ownerCapabilityToken(request, project.id), job);
  let response: Response;
  try {
    response = await fetchRenderer(env, new Request(renderApiEndpoint(env, `/v3/processing-jobs/${job.id}`), {
      method: "DELETE", headers: { authorization: `Bearer ${token}`, "idempotency-key": job.id } }));
  } catch {
    throw new ProjectApiError(502, "processing_cancel_propagation_failed",
      "Processing is cancelled locally, but compute cancellation must be retried.",
      { processingJobId: job.id, cancelled: true, retryable: true });
  }
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) throw new ProjectApiError(502, "processing_cancel_rejected", "Processing is cancelled locally but compute cancellation failed.");
  return json({ ...publicProcessingJob(job), idempotentReplay: replay }, replay ? 200 : 202);
}

async function requireRenderJobCapability(
  request: Request,
  db: D1Database,
  projectId: string,
  renderJobId: string,
): Promise<RenderJobRow> {
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
  return job;
}

function renderInputObjectResponse(object: R2ObjectBody): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
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

async function serveRenderJobSource(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
  projectId: string,
  renderJobId: string,
): Promise<Response> {
  const job = await requireRenderJobCapability(
    request,
    db,
    projectId,
    renderJobId,
  );
  if (new Set(["succeeded", "failed", "cancelled"]).has(job.status)) {
    throw new ProjectApiError(
      409,
      "render_job_terminal",
      `Render job is ${job.status}.`,
    );
  }
  const revision = await getRevision(db, projectId, job.revisionId);
  if (!revision) {
    throw new ProjectApiError(503, "revision_not_found", "Render revision is missing.");
  }
  const asset = await getAsset(db, projectId, revision.sourceAssetId);
  if (!asset || asset.status !== "ready") {
    throw new ProjectApiError(
      503,
      "source_asset_not_ready",
      "The immutable render source is unavailable.",
    );
  }
  const object = await bucket.get(asset.sourceR2Key, { range: request.headers });
  if (!object) {
    throw new ProjectApiError(
      503,
      "source_object_missing",
      "The immutable render source is missing from object storage.",
    );
  }
  return renderInputObjectResponse(object);
}

async function serveRenderJobRevision(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
  projectId: string,
  renderJobId: string,
): Promise<Response> {
  const job = await requireRenderJobCapability(
    request,
    db,
    projectId,
    renderJobId,
  );
  if (new Set(["succeeded", "failed", "cancelled"]).has(job.status)) {
    throw new ProjectApiError(
      409,
      "render_job_terminal",
      `Render job is ${job.status}.`,
    );
  }
  const revision = await getRevision(db, projectId, job.revisionId);
  if (!revision) {
    throw new ProjectApiError(503, "revision_not_found", "Render revision is missing.");
  }
  const document = await loadRevisionDocument(bucket, revision);
  const body = canonicalJson(document);
  return new Response(body, {
    headers: {
      "cache-control": "private, no-store",
      "content-length": String(new TextEncoder().encode(body).byteLength),
      "content-type": "application/json; charset=utf-8",
      etag: `"${revision.documentHash}"`,
      "x-syncword-document-sha256": revision.documentHash,
    },
  });
}

async function updateRenderJobState(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
  projectId: string,
  renderJobId: string,
): Promise<Response> {
  const job = await requireRenderJobCapability(
    request,
    db,
    projectId,
    renderJobId,
  );
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
  if (nextStatus === "succeeded") {
    const video = await findArtifactByKind(db, projectId, renderJobId, "video");
    if (!video) {
      throw new ProjectApiError(
        409,
        "render_video_artifact_required",
        "A durable video artifact is required before render success.",
      );
    }
    const storedVideo = await bucket.head(video.r2Key);
    if (
      !storedVideo ||
      storedVideo.size !== video.byteSize ||
      storedVideo.etag !== video.etag
    ) {
      throw new ProjectApiError(
        409,
        "render_video_artifact_missing",
        "The video artifact is not durable in object storage.",
      );
    }
  }
  const callbackAt = new Date();
  const now = callbackAt.toISOString();
  const startedAt = nextStatus === "running" ? (job.startedAt ?? now) : job.startedAt;
  const terminal = new Set(["succeeded", "failed", "cancelled"]).has(nextStatus);
  const completedAt = terminal ? (job.completedAt ?? now) : null;
  const leaseExpiresAt = terminal
    ? null
    : new Date(callbackAt.getTime() + DISPATCH_LEASE_MILLISECONDS).toISOString();
  const resolvedProgress = nextStatus === "succeeded" ? 100 : progress;
  const result = await db
    .prepare(
       `UPDATE render_jobs
       SET status = ?3, progress = ?4, message = ?5, failure_code = ?6,
           dispatch_error = NULL,
           started_at = ?7, completed_at = ?8, dispatch_lease_expires_at = ?9,
           dispatched_at = COALESCE(dispatched_at, ?10), updated_at = ?10
       WHERE project_id = ?1 AND id = ?2 AND status = ?11`,
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
      leaseExpiresAt,
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

async function cancelRenderJob(
  request: Request,
  env: ProjectEnv,
  db: D1Database,
  project: ProjectRow,
  renderJobId: string,
): Promise<Response> {
  let job = await getRenderJob(db, project.id, renderJobId);
  if (!job) {
    throw new ProjectApiError(404, "render_job_not_found", "Render job not found.");
  }
  if (job.status === "succeeded" || job.status === "failed") {
    throw new ProjectApiError(
      409,
      "render_job_terminal",
      `Render job is ${job.status} and cannot be cancelled.`,
    );
  }
  const idempotentReplay = job.status === "cancelled";
  if (!idempotentReplay) {
    const now = new Date().toISOString();
    const result = await db
      .prepare(
         `UPDATE render_jobs
         SET status = 'cancelled', message = 'Render cancelled', completed_at = ?3,
             dispatch_lease_expires_at = NULL, updated_at = ?3
         WHERE project_id = ?1 AND id = ?2 AND status IN ('queued', 'running')`,
      )
      .bind(project.id, renderJobId, now)
      .run();
    if (Number(result.meta.changes ?? 0) !== 1) {
      job = await getRenderJob(db, project.id, renderJobId);
      if (!job || job.status !== "cancelled") {
        throw new ProjectApiError(
          409,
          "render_state_conflict",
          "The render job changed before cancellation was applied.",
        );
      }
    }
  }

  const callbackCapabilityToken = await callbackCapabilityForJob(
    ownerCapabilityToken(request, project.id),
    job,
  );
  let response: Response;
  try {
    response = await fetchRenderer(
      env,
      new Request(renderApiEndpoint(env, `/v3/render-jobs/${job.id}`), {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${callbackCapabilityToken}`,
          "idempotency-key": job.id,
          "x-syncword-project-id": project.id,
        },
      }),
    );
  } catch {
    throw new ProjectApiError(
      502,
      "render_cancel_propagation_failed",
      "The render is cancelled locally, but compute cancellation must be retried.",
      { renderJobId: job.id, cancelled: true, retryable: true },
    );
  }
  const rendererStatus = response.status;
  await response.body?.cancel();
  if (!response.ok && rendererStatus !== 404) {
    throw new ProjectApiError(
      502,
      "render_cancel_rejected",
      "The render is cancelled locally, but compute cancellation was rejected.",
      { renderJobId: job.id, cancelled: true, rendererStatus, retryable: true },
    );
  }
  const cancelled = await getRenderJob(db, project.id, renderJobId);
  if (!cancelled) throw new Error("Cancelled render job could not be read back.");
  return json(
    { ...publicRenderJob(cancelled), idempotentReplay },
    idempotentReplay ? 200 : 202,
  );
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
  const callbackAt = new Date();
  await db.prepare(`UPDATE render_jobs
    SET dispatch_error = NULL, dispatch_lease_expires_at = ?3,
        dispatched_at = COALESCE(dispatched_at, ?4),
        updated_at = ?4
    WHERE project_id = ?1 AND id = ?2 AND status IN ('queued', 'running')`)
    .bind(
      projectId,
      renderJobId,
      new Date(callbackAt.getTime() + DISPATCH_LEASE_MILLISECONDS).toISOString(),
      callbackAt.toISOString(),
    ).run();
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
  if (new URL(request.url).searchParams.get("download") === "1") {
    const extensions: Record<string, string> = {
      video: "mp4",
      captions_ass: "ass",
      captions_srt: "srt",
      captions_vtt: "vtt",
    };
    const extension = extensions[artifact.kind] ?? "bin";
    headers.set(
      "content-disposition",
      `attachment; filename="subtitles-by-miithii.${extension}"`,
    );
  }
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

  if (
    segments[0] === "processing-jobs" &&
    segments.length === 3 &&
    ((request.method === "GET" && segments[2] === "source") ||
      (request.method === "PUT" && (segments[2] === "state" || segments[2] === "result")))
  ) {
    const jobId = uuidValue(segments[1], "processingJobId");
    if (segments[2] === "source") return serveProcessingSource(request, db, requireBucket(env.MEDIA), projectId, jobId);
    if (segments[2] === "state") return updateProcessingState(request, db, projectId, jobId);
    return finalizeProcessingResult(request, db, requireBucket(env.MEDIA), project, jobId);
  }

  if (
    request.method === "GET" &&
    segments[0] === "render-jobs" &&
    segments.length === 3 &&
    (segments[2] === "source" || segments[2] === "revision")
  ) {
    const renderJobId = uuidValue(segments[1], "renderJobId");
    if (segments[2] === "source") {
      return serveRenderJobSource(
        request,
        db,
        requireBucket(env.MEDIA),
        projectId,
        renderJobId,
      );
    }
    return serveRenderJobRevision(
      request,
      db,
      requireBucket(env.MEDIA),
      projectId,
      renderJobId,
    );
  }

  if (projectRouteAuthorization(request.method, segments) === "render_callback") {
    const renderJobId = uuidValue(segments[1], "renderJobId");
    if (segments[2] === "state") {
      return updateRenderJobState(
        request,
        db,
        requireBucket(env.MEDIA),
        projectId,
        renderJobId,
      );
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
  if (
    segments.length === 1 &&
    segments[0] === "session" &&
    request.method === "POST"
  ) {
    return establishProjectSession(request, project);
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
    if (segments.length === 3 && segments[2] === "content" && request.method === "GET") {
      return serveAssetContent(request, db, requireBucket(env.MEDIA), projectId, uuidValue(segments[1], "assetId"));
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
          env.RENDERER_REVISION ?? "syncword-render-v2",
          "RENDERER_REVISION",
          128,
        ) ?? "syncword-render-v2";
      return createRenderJob(
        request,
        env,
        db,
        requireBucket(env.MEDIA),
        project,
        rendererRevision,
      );
    }
    if (segments.length === 2 && request.method === "GET") {
      return showRenderJob(
        request,
        env,
        db,
        project,
        uuidValue(segments[1], "renderJobId"),
      );
    }
    if (segments.length === 2 && request.method === "DELETE") {
      return cancelRenderJob(
        request,
        env,
        db,
        project,
        uuidValue(segments[1], "renderJobId"),
      );
    }
  }
  if (segments[0] === "processing-jobs") {
    if (segments.length === 1 && request.method === "POST") {
      const processorRevision = stringValue(env.PROCESSOR_REVISION ?? "syncword-caption-v3", "PROCESSOR_REVISION", 128) ?? "syncword-caption-v3";
      return createProcessingJob(request, env, db, project, processorRevision);
    }
    if (segments.length === 2 && request.method === "GET") {
      return showProcessingJob(
        request,
        env,
        db,
        project,
        uuidValue(segments[1], "processingJobId"),
      );
    }
    if (segments.length === 2 && request.method === "DELETE") {
      return cancelProcessingJob(request, env, db, project, uuidValue(segments[1], "processingJobId"));
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
