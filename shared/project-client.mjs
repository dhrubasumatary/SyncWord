// @ts-check

/** @typedef {typeof fetch} FetchLike */
/** @typedef {{ method?: string, headers?: HeadersInit, body?: BodyInit | null, json?: unknown }} ProjectRequestOptions */

export class ProjectClientError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown> | null} [details]
   * @param {unknown} [payload]
   */
  constructor(status, code, message, details = null, payload = null) {
    super(message);
    this.name = "ProjectClientError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.payload = payload;
  }
}

/** @param {Response} response */
async function responsePayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Same-origin, cookie-authenticated JSON boundary for durable projects. Owner
 * and compute capabilities never enter this module's inputs or return values.
 * @param {FetchLike} fetchImpl
 * @param {string} path
 * @param {ProjectRequestOptions} [options]
 * @returns {Promise<any>}
 */
export async function projectRequest(fetchImpl, path, options = {}) {
  const headers = new Headers(options.headers);
  let body = options.body;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json; charset=utf-8");
    body = JSON.stringify(options.json);
  }
  const method = options.method ?? (body === undefined ? "GET" : "POST");
  const response = await fetchImpl(path, {
    method,
    headers,
    body,
    credentials: "same-origin",
    ...(method === "GET" ? { cache: "no-store" } : {}),
  });
  const payload = await responsePayload(response);
  if (!response.ok) {
    const record = payload && typeof payload === "object" ? payload : {};
    throw new ProjectClientError(
      response.status,
      typeof record.code === "string" ? record.code : "project_request_failed",
      typeof record.error === "string"
        ? record.error
        : `Project request failed with HTTP ${response.status}.`,
      record.details && typeof record.details === "object"
        ? record.details
        : null,
      payload,
    );
  }
  return payload;
}

/** @param {string} projectId @param {string} [suffix] */
export function projectPath(projectId, suffix = "") {
  return `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
}

/** @param {string} projectId @param {string} assetId */
export function projectAssetContentUrl(projectId, assetId) {
  return projectPath(
    projectId,
    `/assets/${encodeURIComponent(assetId)}/content`,
  );
}

/** @param {string} projectId @param {string} artifactId */
export function projectExportContentUrl(projectId, artifactId) {
  return projectPath(
    projectId,
    `/exports/${encodeURIComponent(artifactId)}/content`,
  );
}

/** @param {FetchLike} fetchImpl @param {string} title */
export function createProject(fetchImpl, title) {
  return projectRequest(fetchImpl, "/api/projects", {
    method: "POST",
    json: { title },
  });
}

/** @param {FetchLike} fetchImpl @param {string} projectId */
export function getProject(fetchImpl, projectId) {
  return projectRequest(fetchImpl, projectPath(projectId));
}

/** @param {FetchLike} fetchImpl @param {string} projectId @param {File} file */
export function reserveProjectAsset(fetchImpl, projectId, file) {
  return projectRequest(fetchImpl, projectPath(projectId, "/assets"), {
    method: "POST",
    json: {
      originalName: file.name,
      contentType: file.type || "video/mp4",
      byteSize: file.size,
      kind: "source_video",
    },
  });
}

/** @param {FetchLike} fetchImpl @param {string} uploadUrl @param {File} file */
export function uploadProjectAsset(fetchImpl, uploadUrl, file) {
  return projectRequest(fetchImpl, uploadUrl, {
    method: "PUT",
    headers: { "content-type": file.type || "video/mp4" },
    body: file,
  });
}

/**
 * @param {FetchLike} fetchImpl
 * @param {string} projectId
 * @param {{ sourceAssetId: string, language: string, mode: string, idempotencyKey?: string }} input
 */
export function createProjectProcessingJob(
  fetchImpl,
  projectId,
  { sourceAssetId, language, mode, idempotencyKey },
) {
  return projectRequest(fetchImpl, projectPath(projectId, "/processing-jobs"), {
    method: "POST",
    headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
    json: {
      sourceAssetId,
      language,
      mode,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  });
}

/** @param {FetchLike} fetchImpl @param {string} projectId @param {string} jobId */
export function getProjectProcessingJob(fetchImpl, projectId, jobId) {
  return projectRequest(
    fetchImpl,
    projectPath(projectId, `/processing-jobs/${encodeURIComponent(jobId)}`),
  );
}

/** @param {FetchLike} fetchImpl @param {string} projectId @param {string} jobId */
export function cancelProjectProcessingJob(fetchImpl, projectId, jobId) {
  return projectRequest(
    fetchImpl,
    projectPath(projectId, `/processing-jobs/${encodeURIComponent(jobId)}`),
    { method: "DELETE" },
  );
}

/** @param {FetchLike} fetchImpl @param {string} projectId @param {string} revisionId */
export function getProjectRevision(fetchImpl, projectId, revisionId) {
  return projectRequest(
    fetchImpl,
    projectPath(projectId, `/revisions/${encodeURIComponent(revisionId)}`),
  );
}

/**
 * @param {FetchLike} fetchImpl
 * @param {string} projectId
 * @param {{ baseRevisionId: string | null, document: unknown, changeSummary?: string, createdBy?: string }} input
 */
export function createProjectRevision(
  fetchImpl,
  projectId,
  { baseRevisionId, document, changeSummary = "Caption edits", createdBy = "editor" },
) {
  return projectRequest(fetchImpl, projectPath(projectId, "/revisions"), {
    method: "POST",
    json: { baseRevisionId, document, changeSummary, createdBy },
  });
}

/**
 * @param {FetchLike} fetchImpl
 * @param {string} projectId
 * @param {{ revisionId: string, exportSpec: Record<string, unknown>, idempotencyKey?: string }} input
 */
export function createProjectRenderJob(
  fetchImpl,
  projectId,
  { revisionId, exportSpec, idempotencyKey },
) {
  return projectRequest(fetchImpl, projectPath(projectId, "/render-jobs"), {
    method: "POST",
    headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
    json: {
      revisionId,
      exportSpec,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  });
}

/** @param {FetchLike} fetchImpl @param {string} projectId @param {string} jobId */
export function getProjectRenderJob(fetchImpl, projectId, jobId) {
  return projectRequest(
    fetchImpl,
    projectPath(projectId, `/render-jobs/${encodeURIComponent(jobId)}`),
  );
}

/** @param {FetchLike} fetchImpl @param {string} projectId @param {string} jobId */
export function cancelProjectRenderJob(fetchImpl, projectId, jobId) {
  return projectRequest(
    fetchImpl,
    projectPath(projectId, `/render-jobs/${encodeURIComponent(jobId)}`),
    { method: "DELETE" },
  );
}

/** @param {FetchLike} fetchImpl @param {string} projectId */
export function listProjectExports(fetchImpl, projectId) {
  return projectRequest(fetchImpl, projectPath(projectId, "/exports"));
}
