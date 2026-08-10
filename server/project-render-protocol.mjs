import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import {
  parseExportSpec,
  sha256Hex,
} from "../shared/project-contract.mjs";
import {
  ProjectRenderContractError,
  canonicalProjectRenderState,
  projectRevisionToRenderInput,
  validateProjectRenderUrls,
} from "./project-render-contract.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_REVISION_BYTES = 2 * 1024 * 1024;

function requiredString(value, path, maximum = 512) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum) {
    throw new ProjectRenderContractError(
      "invalid_project_render_request",
      `${path} is required and must be at most ${maximum} characters.`,
    );
  }
  return text;
}

function uuid(value, path) {
  const text = requiredString(value, path, 36);
  if (!UUID_PATTERN.test(text)) {
    throw new ProjectRenderContractError(
      "invalid_project_render_request",
      `${path} must be a UUID.`,
    );
  }
  return text.toLowerCase();
}

function digest(value, path) {
  const text = requiredString(value, path, 64).toLowerCase();
  if (!SHA256_PATTERN.test(text)) {
    throw new ProjectRenderContractError(
      "invalid_project_render_request",
      `${path} must be a SHA-256 digest.`,
    );
  }
  return text;
}

function exactUrl(value, expected, path) {
  const url = new URL(requiredString(value, path, 2_048));
  if (url.toString() !== expected.toString()) {
    throw new ProjectRenderContractError(
      "invalid_project_render_url",
      `${path} does not match the immutable render job route.`,
    );
  }
  return url;
}

export function parseProjectRenderRequest(input, { allowedOrigins = [] } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProjectRenderContractError(
      "invalid_project_render_request",
      "Project render input must be an object.",
    );
  }
  if (input.schemaVersion !== 1) {
    throw new ProjectRenderContractError(
      "unsupported_project_render_schema",
      "Project render schemaVersion must equal 1.",
    );
  }
  const id = uuid(input.id, "id");
  const projectId = uuid(input.projectId, "projectId");
  const requestFingerprint = digest(
    input.requestFingerprint,
    "requestFingerprint",
  );
  const rendererRevision = requiredString(
    input.rendererRevision,
    "rendererRevision",
    128,
  );
  const revision = input.revision ?? {};
  const source = input.source ?? {};
  const callback = input.callback ?? {};
  const authorization = input.authorization ?? {};
  const revisionId = uuid(revision.id, "revision.id");
  const sourceAssetId = uuid(source.assetId, "source.assetId");
  if (uuid(revision.sourceAssetId, "revision.sourceAssetId") !== sourceAssetId) {
    throw new ProjectRenderContractError(
      "project_render_source_mismatch",
      "The revision and source asset identities do not match.",
    );
  }
  const documentHash = digest(revision.documentHash, "revision.documentHash");
  const sourceByteSize = Number(source.byteSize);
  if (!Number.isInteger(sourceByteSize) || sourceByteSize <= 0) {
    throw new ProjectRenderContractError(
      "invalid_project_render_request",
      "source.byteSize must be a positive integer.",
    );
  }
  const renderCapabilityToken = digest(
    authorization.renderCapabilityToken,
    "authorization.renderCapabilityToken",
  );
  const sitesAuthorization =
    typeof authorization.sitesAuthorization === "string" &&
    authorization.sitesAuthorization.length >= 32
      ? authorization.sitesAuthorization
      : "";
  const callbackBase = new URL(
    requiredString(callback.baseUrl, "callback.baseUrl", 2_048),
  );
  const sourceUrl = new URL(
    requiredString(source.url, "source.url", 2_048),
  );
  const revisionUrl = new URL(
    requiredString(revision.url, "revision.url", 2_048),
  );
  validateProjectRenderUrls(
    {
      sourceUrl: sourceUrl.toString(),
      revisionUrl: revisionUrl.toString(),
      callbackBase: callbackBase.toString(),
    },
    allowedOrigins,
  );

  const rootPath = `/api/projects/${projectId}/render-jobs/${id}`;
  const routeBase = new URL(rootPath, callbackBase.origin);
  if (callbackBase.toString().replace(/\/+$/, "") !== routeBase.toString().replace(/\/+$/, "")) {
    throw new ProjectRenderContractError(
      "invalid_project_render_url",
      "callback.baseUrl does not match the project render job identity.",
    );
  }
  exactUrl(sourceUrl, new URL(`${rootPath}/source`, callbackBase.origin), "source.url");
  exactUrl(revisionUrl, new URL(`${rootPath}/revision`, callbackBase.origin), "revision.url");
  const stateUrl = exactUrl(
    callback.stateUrl,
    new URL(`${rootPath}/state`, callbackBase.origin),
    "callback.stateUrl",
  );
  const artifactUrls = {};
  for (const kind of ["video", "captions_ass", "captions_srt", "captions_vtt"]) {
    const supplied = callback.artifacts?.[kind];
    if (!supplied && (kind === "captions_srt" || kind === "captions_vtt")) continue;
    artifactUrls[kind] = exactUrl(
      supplied,
      new URL(`${rootPath}/artifacts/${kind}`, callbackBase.origin),
      `callback.artifacts.${kind}`,
    );
  }
  if (!artifactUrls.video || !artifactUrls.captions_ass) {
    throw new ProjectRenderContractError(
      "invalid_project_render_request",
      "Video and ASS artifact callback URLs are required.",
    );
  }

  return {
    schemaVersion: 1,
    id,
    projectId,
    requestFingerprint,
    rendererRevision,
    revision: {
      id: revisionId,
      documentHash,
      schemaVersion: Number(revision.schemaVersion),
      sourceAssetId,
      url: revisionUrl,
    },
    source: {
      assetId: sourceAssetId,
      url: sourceUrl,
      contentType: requiredString(source.contentType, "source.contentType", 120),
      byteSize: sourceByteSize,
      etag: typeof source.etag === "string" ? source.etag : null,
      sha256:
        typeof source.sha256 === "string" && SHA256_PATTERN.test(source.sha256)
          ? source.sha256.toLowerCase()
          : null,
    },
    exportSpec: parseExportSpec(input.exportSpec),
    callback: { baseUrl: routeBase, stateUrl, artifacts: artifactUrls },
    authorization: { renderCapabilityToken, sitesAuthorization },
  };
}

export function projectRenderAuthorizationHeaders(plan, extra = {}) {
  return {
    authorization: `Bearer ${plan.authorization.renderCapabilityToken}`,
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
  return new ProjectRenderContractError(
    "project_render_remote_failed",
    `${action} returned ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`,
  );
}

export async function fetchProjectRevision(plan, fetchImpl = fetch) {
  const response = await fetchImpl(plan.revision.url, {
    headers: projectRenderAuthorizationHeaders(plan),
  });
  if (!response.ok) throw await responseError(response, "Revision download");
  const announcedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(announcedLength) && announcedLength > MAX_REVISION_BYTES) {
    throw new ProjectRenderContractError(
      "project_revision_too_large",
      "The immutable revision exceeds the 2 MB compute contract.",
    );
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REVISION_BYTES) {
    throw new ProjectRenderContractError(
      "project_revision_too_large",
      "The immutable revision exceeds the 2 MB compute contract.",
    );
  }
  if ((await sha256Hex(text)) !== plan.revision.documentHash) {
    throw new ProjectRenderContractError(
      "project_revision_hash_mismatch",
      "The immutable revision failed its SHA-256 check.",
    );
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ProjectRenderContractError(
      "project_revision_invalid",
      "The immutable revision is not valid JSON.",
    );
  }
  const renderInput = projectRevisionToRenderInput(document);
  if (document.sourceAssetId !== plan.source.assetId) {
    throw new ProjectRenderContractError(
      "project_render_source_mismatch",
      "The downloaded revision references a different source asset.",
    );
  }
  return { document, renderInput };
}

export async function downloadProjectSource(plan, destination, fetchImpl = fetch) {
  const response = await fetchImpl(plan.source.url, {
    headers: projectRenderAuthorizationHeaders(plan),
  });
  if (!response.ok || !response.body) {
    throw await responseError(response, "Source download");
  }
  await pipeline(
    /** @type {any} */ (response.body),
    createWriteStream(destination, { flags: "wx" }),
  );
  const stored = await stat(destination);
  if (stored.size !== plan.source.byteSize) {
    throw new ProjectRenderContractError(
      "project_source_size_mismatch",
      "The downloaded source size does not match its immutable asset record.",
    );
  }
  return stored;
}

export async function putProjectRenderState(
  plan,
  state,
  fetchImpl = fetch,
) {
  const payload = canonicalProjectRenderState(
    state.status,
    state.progress,
    state.message,
    state.failureCode,
  );
  const response = await fetchImpl(plan.callback.stateUrl, {
    method: "PUT",
    headers: projectRenderAuthorizationHeaders(plan, {
      "content-type": "application/json",
    }),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw await responseError(response, "State callback");
  return payload;
}

export async function fileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function uploadProjectRenderArtifact(
  plan,
  kind,
  filePath,
  contentType,
  { codecManifest, fetchImpl = fetch } = {},
) {
  const target = plan.callback.artifacts[kind];
  if (!target) return null;
  const file = await stat(filePath);
  const sha256 = await fileSha256(filePath);
  const response = await fetchImpl(target, {
    method: "PUT",
    headers: projectRenderAuthorizationHeaders(plan, {
      "content-type": contentType,
      "content-length": String(file.size),
      "x-content-sha256": sha256,
      ...(codecManifest
        ? { "x-syncword-codec-manifest": JSON.stringify(codecManifest) }
        : {}),
    }),
    body: createReadStream(filePath),
    duplex: "half",
  });
  if (!response.ok) throw await responseError(response, `${kind} upload`);
  return { kind, byteSize: file.size, sha256 };
}

export async function readSmallJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
