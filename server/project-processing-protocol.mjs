import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import {
  canonicalJson,
  isSupportedLanguageCode,
} from "../shared/project-contract.mjs";
import {
  ProjectProcessingContractError,
  assertProjectProcessingResult,
  canonicalProjectProcessingState,
} from "./project-processing-contract.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_SOURCE_BYTES = 500 * 1024 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

function requiredString(value, path, maximum = 512) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum) {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_request",
      `${path} is required and must be at most ${maximum} characters.`,
    );
  }
  return text;
}

function exactKeys(value, path, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_request",
      `${path} must be an object.`,
    );
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ProjectProcessingContractError(
        "invalid_project_processing_request",
        `${path}.${key} is not part of processing schemaVersion 1.`,
      );
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new ProjectProcessingContractError(
        "invalid_project_processing_request",
        `${path}.${key} is required.`,
      );
    }
  }
  return value;
}

function uuid(value, path) {
  const text = requiredString(value, path, 36);
  if (!UUID_PATTERN.test(text)) {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_request",
      `${path} must be a UUID.`,
    );
  }
  return text.toLowerCase();
}

function digest(value, path) {
  const text = requiredString(value, path, 64).toLowerCase();
  if (!SHA256_PATTERN.test(text)) {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_request",
      `${path} must be a SHA-256 digest.`,
    );
  }
  return text;
}

function exactUrl(value, expected, path) {
  let url;
  try {
    url = new URL(requiredString(value, path, 2_048));
  } catch {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_url",
      `${path} must be an absolute URL.`,
    );
  }
  if (url.toString() !== expected.toString()) {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_url",
      `${path} does not match the immutable processing job route.`,
    );
  }
  return url;
}

function validateOrigin(url, allowedOrigins) {
  const allowlist = new Set(allowedOrigins ?? []);
  if (url.protocol !== "https:" || !allowlist.has(url.origin)) {
    throw new ProjectProcessingContractError(
      "project_processing_origin_not_allowed",
      "Project processing URLs must use an allowed HTTPS origin.",
    );
  }
}

export function parseProjectProcessingRequest(input, { allowedOrigins = [] } = {}) {
  exactKeys(
    input,
    "request",
    [
      "schemaVersion",
      "id",
      "projectId",
      "requestFingerprint",
      "processorRevision",
      "source",
      "processing",
      "callback",
      "authorization",
    ],
  );
  if (input.schemaVersion !== 1) {
    throw new ProjectProcessingContractError(
      "unsupported_project_processing_schema",
      "Project processing schemaVersion must equal 1.",
    );
  }

  const id = uuid(input.id, "id");
  const projectId = uuid(input.projectId, "projectId");
  const source = exactKeys(
    input.source,
    "source",
    ["assetId", "url", "contentType", "byteSize", "etag", "sha256"],
  );
  const processing = exactKeys(
    input.processing,
    "processing",
    ["language", "mode"],
  );
  const callback = exactKeys(
    input.callback,
    "callback",
    ["baseUrl", "stateUrl", "resultUrl"],
  );
  const authorization = exactKeys(
    input.authorization,
    "authorization",
    ["processingCapabilityToken"],
    ["sitesAuthorization"],
  );

  const sourceAssetId = uuid(source.assetId, "source.assetId");
  const byteSize = Number(source.byteSize);
  if (!Number.isInteger(byteSize) || byteSize <= 0 || byteSize > MAX_SOURCE_BYTES) {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_request",
      "source.byteSize must be an integer between 1 byte and 500 MB.",
    );
  }
  const contentType = requiredString(source.contentType, "source.contentType", 120);
  if (!contentType.toLowerCase().startsWith("video/")) {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_request",
      "source.contentType must be a video media type.",
    );
  }
  const language = requiredString(processing.language, "processing.language", 32);
  if (!isSupportedLanguageCode(language)) {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_request",
      "processing.language must be as-IN or brx-IN.",
    );
  }
  const mode = requiredString(processing.mode, "processing.mode", 32);
  if (!new Set(["codemix", "verbatim", "transcribe"]).has(mode)) {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_request",
      "processing.mode must be codemix, verbatim, or transcribe.",
    );
  }

  let callbackBase;
  try {
    callbackBase = new URL(requiredString(callback.baseUrl, "callback.baseUrl", 2_048));
  } catch {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_url",
      "callback.baseUrl must be an absolute URL.",
    );
  }
  validateOrigin(callbackBase, allowedOrigins);
  const rootPath = `/api/projects/${projectId}/processing-jobs/${id}`;
  const routeBase = new URL(rootPath, callbackBase.origin);
  if (
    callbackBase.toString().replace(/\/+$/, "") !==
    routeBase.toString().replace(/\/+$/, "")
  ) {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_url",
      "callback.baseUrl does not match the project processing job identity.",
    );
  }
  const sourceUrl = exactUrl(
    source.url,
    new URL(`${rootPath}/source`, callbackBase.origin),
    "source.url",
  );
  const stateUrl = exactUrl(
    callback.stateUrl,
    new URL(`${rootPath}/state`, callbackBase.origin),
    "callback.stateUrl",
  );
  const resultUrl = exactUrl(
    callback.resultUrl,
    new URL(`${rootPath}/result`, callbackBase.origin),
    "callback.resultUrl",
  );
  for (const url of [sourceUrl, stateUrl, resultUrl]) {
    if (url.origin !== callbackBase.origin) {
      throw new ProjectProcessingContractError(
        "project_processing_origin_not_allowed",
        "Source and callback routes must have the same origin.",
      );
    }
  }

  const sitesAuthorization = authorization.sitesAuthorization;
  if (
    sitesAuthorization !== undefined &&
    (typeof sitesAuthorization !== "string" || sitesAuthorization.length < 32)
  ) {
    throw new ProjectProcessingContractError(
      "invalid_project_processing_request",
      "authorization.sitesAuthorization must be at least 32 characters when supplied.",
    );
  }

  return {
    schemaVersion: 1,
    id,
    projectId,
    requestFingerprint: digest(input.requestFingerprint, "requestFingerprint"),
    processorRevision: requiredString(
      input.processorRevision,
      "processorRevision",
      128,
    ),
    source: {
      assetId: sourceAssetId,
      url: sourceUrl,
      contentType,
      byteSize,
      etag:
        typeof source.etag === "string" && source.etag.trim()
          ? source.etag.trim().slice(0, 256)
          : null,
      sha256:
        typeof source.sha256 === "string" && source.sha256.trim()
          ? digest(source.sha256, "source.sha256")
          : null,
    },
    processing: { language, mode },
    callback: { baseUrl: routeBase, stateUrl, resultUrl },
    authorization: {
      processingCapabilityToken: digest(
        authorization.processingCapabilityToken,
        "authorization.processingCapabilityToken",
      ),
      sitesAuthorization:
        typeof sitesAuthorization === "string" ? sitesAuthorization : "",
    },
  };
}

export function projectProcessingAuthorizationHeaders(plan, extra = {}) {
  return {
    authorization: `Bearer ${plan.authorization.processingCapabilityToken}`,
    ...(plan.authorization.sitesAuthorization
      ? {
          "oai-sites-authorization": `Bearer ${plan.authorization.sitesAuthorization}`,
        }
      : {}),
    ...extra,
  };
}

async function responseError(response, action) {
  const detail = await response.text().catch(() => "");
  return new ProjectProcessingContractError(
    "project_processing_remote_failed",
    `${action} returned ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`,
  );
}

function normalizeEtag(value) {
  return String(value ?? "").trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

export async function fileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function downloadProjectProcessingSource(
  plan,
  destination,
  fetchImpl = fetch,
  { signal } = {},
) {
  const response = await fetchImpl(plan.source.url, {
    headers: projectProcessingAuthorizationHeaders(plan),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) {
    throw await responseError(response, "Source download");
  }
  const announcedLengthHeader = response.headers.get("content-length");
  const announcedLength = Number(announcedLengthHeader);
  if (
    announcedLengthHeader !== null &&
    Number.isFinite(announcedLength) &&
    announcedLength !== plan.source.byteSize
  ) {
    await response.body.cancel().catch(() => undefined);
    throw new ProjectProcessingContractError(
      "project_source_size_mismatch",
      "The source Content-Length does not match its immutable asset record.",
    );
  }
  const returnedEtag = response.headers.get("etag");
  if (
    plan.source.etag &&
    returnedEtag &&
    normalizeEtag(returnedEtag) !== normalizeEtag(plan.source.etag)
  ) {
    await response.body.cancel().catch(() => undefined);
    throw new ProjectProcessingContractError(
      "project_source_etag_mismatch",
      "The downloaded source ETag does not match its immutable asset record.",
    );
  }
  await pipeline(
    /** @type {any} */ (response.body),
    createWriteStream(destination, { flags: "wx" }),
  );
  const stored = await stat(destination);
  if (stored.size !== plan.source.byteSize) {
    throw new ProjectProcessingContractError(
      "project_source_size_mismatch",
      "The downloaded source size does not match its immutable asset record.",
    );
  }
  if (plan.source.sha256 && (await fileSha256(destination)) !== plan.source.sha256) {
    throw new ProjectProcessingContractError(
      "project_source_hash_mismatch",
      "The downloaded source failed its SHA-256 check.",
    );
  }
  return stored;
}

export async function putProjectProcessingState(plan, state, fetchImpl = fetch) {
  const payload = canonicalProjectProcessingState(
    state.status,
    state.progress,
    state.message,
    state.failureCode,
  );
  const response = await fetchImpl(plan.callback.stateUrl, {
    method: "PUT",
    headers: projectProcessingAuthorizationHeaders(plan, {
      "content-type": "application/json",
    }),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw await responseError(response, "State callback");
  return payload;
}

export async function putProjectProcessingResult(
  plan,
  documentInput,
  {
    changeSummary = "Automatic captions",
    fetchImpl = fetch,
    attempts = 3,
    retryDelay = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    signal,
  } = {},
) {
  const document = assertProjectProcessingResult(plan, documentInput);
  const body = canonicalJson({ document, changeSummary: String(changeSummary).slice(0, 500) });
  if (new TextEncoder().encode(body).byteLength > MAX_RESULT_BYTES) {
    throw new ProjectProcessingContractError(
      "project_processing_result_too_large",
      "The immutable processing result exceeds 2 MB.",
    );
  }

  let lastError;
  const maximumAttempts = Math.max(1, Math.min(3, Math.floor(Number(attempts) || 1)));
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error("Processing cancelled.");
    let response;
    try {
      response = await fetchImpl(plan.callback.resultUrl, {
        method: "PUT",
        headers: projectProcessingAuthorizationHeaders(plan, {
          "content-type": "application/json; charset=utf-8",
        }),
        body,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
    }
    if (response?.ok) return document;
    if (response) {
      lastError = await responseError(response, "Processing result callback");
      if (response.status < 500 && response.status !== 429) throw lastError;
    }
    if (attempt < maximumAttempts) await retryDelay(100 * 2 ** (attempt - 1));
  }
  throw lastError ?? new ProjectProcessingContractError(
    "project_processing_remote_failed",
    "Processing result callback failed.",
  );
}
