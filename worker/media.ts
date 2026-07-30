const DEFAULT_RENDER_API = "https://syncword-render-dhrub404.onrender.com";
const MAX_VIDEO_BYTES = 90 * 1024 * 1024;
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

type MediaEnv = {
  MEDIA?: R2Bucket;
  RENDER_API_URL?: string;
  SITES_BYPASS_BEARER_TOKEN?: string;
};

type StoredJob = {
  id: string;
  status: string;
  progress: number;
  message: string;
  originalName: string;
  contentType: string;
  size: number;
  language: string;
  mode: string;
  style: Record<string, unknown>;
  captions: unknown[];
  alignment?: Record<string, unknown>;
  languageCode?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  capabilityToken: string;
  sourceKey: string;
  resultKey?: string;
  assKey?: string;
};

function json(payload: unknown, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "private, no-store",
    },
  });
}

function jobKey(id: string) {
  return `jobs/${id}/job.json`;
}

function publicJob(job: StoredJob) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    captions: Array.isArray(job.captions) ? job.captions : [],
    alignment: job.alignment,
    languageCode: job.languageCode,
    style: job.style,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    previewUrl:
      job.status === "complete" && job.resultKey
        ? `/api/media/jobs/${job.id}/result`
        : undefined,
    downloadUrl:
      job.status === "complete" && job.resultKey
        ? `/api/media/jobs/${job.id}/download`
        : undefined,
    assUrl:
      job.assKey ? `/api/media/jobs/${job.id}/captions.ass` : undefined,
  };
}

async function readJob(bucket: R2Bucket, id: string) {
  const object = await bucket.get(jobKey(id));
  if (!object) return null;
  try {
    return (await object.json()) as StoredJob;
  } catch {
    return null;
  }
}

async function writeJob(bucket: R2Bucket, job: StoredJob) {
  job.updatedAt = new Date().toISOString();
  await bucket.put(jobKey(job.id), JSON.stringify(job), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function deleteJobObjects(bucket: R2Bucket, job: StoredJob) {
  const keys = [
    jobKey(job.id),
    job.sourceKey,
    job.resultKey,
    job.assKey,
  ].filter((key): key is string => Boolean(key));
  await Promise.all(keys.map((key) => bucket.delete(key)));
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

function hasCapability(request: Request, job: StoredJob) {
  const supplied = bearerToken(request);
  if (!supplied || supplied.length !== job.capabilityToken.length) return false;
  let mismatch = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    mismatch |= supplied.charCodeAt(index) ^ job.capabilityToken.charCodeAt(index);
  }
  return mismatch === 0;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function cleanFileName(value: unknown) {
  const name = String(value ?? "video.mp4")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .slice(0, 120);
  return name || "video.mp4";
}

function acceptedVideoType(contentType: string, fileName: string) {
  return (
    contentType.startsWith("video/") ||
    /\.(mp4|mov|webm|mkv|m4v)$/i.test(fileName)
  );
}

async function serveObject(
  request: Request,
  bucket: R2Bucket,
  key: string,
  {
    attachmentName,
  }: {
    attachmentName?: string;
  } = {},
) {
  const object = await bucket.get(key, {
    range: request.headers,
  });
  if (!object) return json({ error: "File not found." }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set(
    "cache-control",
    attachmentName ? "private, no-store" : "private, max-age=60",
  );
  if (attachmentName) {
    headers.set(
      "content-disposition",
      `attachment; filename="${attachmentName.replaceAll('"', "")}"`,
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

async function createJob(request: Request, bucket: R2Bucket) {
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Send valid job metadata." }, 400);
  }

  const originalName = cleanFileName(input.originalName);
  const contentType = String(input.contentType ?? "video/mp4").slice(0, 120);
  const size = Number(input.size);
  if (
    !Number.isFinite(size) ||
    size <= 0 ||
    size > MAX_VIDEO_BYTES
  ) {
    return json(
      { error: "Keep the reel under 90 MB for this MVP." },
      413,
    );
  }
  if (!acceptedVideoType(contentType, originalName)) {
    return json(
      { error: "Choose an MP4, MOV, WebM, MKV, or M4V video." },
      415,
    );
  }

  const id = crypto.randomUUID();
  const extension =
    originalName.match(/\.(mp4|mov|webm|mkv|m4v)$/i)?.[0].toLowerCase() ??
    ".mp4";
  const now = new Date();
  const job: StoredJob = {
    id,
    status: "queued",
    progress: 1,
    message: "Waiting for video upload",
    originalName,
    contentType,
    size,
    language: ["as-IN", "brx-IN", "unknown"].includes(String(input.language))
      ? String(input.language)
      : "unknown",
    mode: ["codemix", "verbatim", "transcribe"].includes(String(input.mode))
      ? String(input.mode)
      : "codemix",
    style:
      input.style && typeof input.style === "object"
        ? (input.style as Record<string, unknown>)
        : {},
    captions: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + JOB_RETENTION_MS).toISOString(),
    capabilityToken: randomToken(),
    sourceKey: `jobs/${id}/source${extension}`,
  };
  await writeJob(bucket, job);
  return json(
    {
      ...publicJob(job),
      capabilityToken: job.capabilityToken,
      uploadUrl: `/api/media/jobs/${id}/source`,
      processUrl: `/api/media/jobs/${id}/process`,
    },
    201,
  );
}

async function uploadSource(
  request: Request,
  bucket: R2Bucket,
  job: StoredJob,
) {
  if (!hasCapability(request, job)) {
    return json({ error: "Upload capability is invalid." }, 401);
  }
  if (!request.body) return json({ error: "Video body is required." }, 400);
  if (!["queued", "failed"].includes(job.status) || job.progress > 2) {
    return json({ error: "This upload has already been finalized." }, 409);
  }

  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader
    ? Number(contentLengthHeader)
    : null;
  if (
    contentLength !== null &&
    (!Number.isFinite(contentLength) ||
      contentLength !== job.size ||
      contentLength > MAX_VIDEO_BYTES)
  ) {
    return json({ error: "Uploaded video size does not match." }, 400);
  }

  await bucket.put(job.sourceKey, request.body, {
    httpMetadata: {
      contentType: job.contentType,
      contentDisposition: `inline; filename="${job.originalName.replaceAll('"', "")}"`,
    },
  });
  const stored = await bucket.head(job.sourceKey);
  if (!stored || stored.size !== job.size || stored.size > MAX_VIDEO_BYTES) {
    await bucket.delete(job.sourceKey);
    return json({ error: "Uploaded video size does not match." }, 400);
  }
  job.status = "queued";
  job.progress = 3;
  job.message = "Upload complete · ready to process";
  await writeJob(bucket, job);
  return json(publicJob(job), 201);
}

async function startProcessing(
  request: Request,
  env: MediaEnv,
  bucket: R2Bucket,
  job: StoredJob,
) {
  if (!hasCapability(request, job)) {
    return json({ error: "Processing capability is invalid." }, 401);
  }
  const source = await bucket.head(job.sourceKey);
  if (!source) return json({ error: "Upload the source video first." }, 409);
  if (
    ["extracting", "transcribing", "rendering", "complete"].includes(
      job.status,
    )
  ) {
    return json(publicJob(job), 202);
  }

  job.status = "queued";
  job.progress = 3;
  job.message = "Queued for captioning";
  await writeJob(bucket, job);

  const origin = new URL(request.url).origin;
  const renderApi = String(env.RENDER_API_URL ?? DEFAULT_RENDER_API).replace(
    /\/+$/,
    "",
  );
  const response = await fetch(`${renderApi}/v2/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: job.id,
      sourceUrl: `${origin}/api/media/jobs/${job.id}/source`,
      callbackBase: `${origin}/api/media/jobs/${job.id}`,
      capabilityToken: job.capabilityToken,
      sitesAuthorization: env.SITES_BYPASS_BEARER_TOKEN,
      originalName: job.originalName,
      contentType: job.contentType,
      language: job.language,
      mode: job.mode,
      style: job.style,
    }),
  });
  const result = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) {
    job.status = "failed";
    job.message =
      result.error ??
      `Render engine rejected the job (${response.status}).`;
    await writeJob(bucket, job);
    return json({ error: job.message }, response.status);
  }
  return json(publicJob(job), 202);
}

async function updateState(
  request: Request,
  bucket: R2Bucket,
  job: StoredJob,
) {
  if (!hasCapability(request, job)) {
    return json({ error: "Callback capability is invalid." }, 401);
  }
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Send valid job state." }, 400);
  }

  const allowedStatuses = new Set([
    "queued",
    "extracting",
    "transcribing",
    "ready",
    "rendering",
    "complete",
    "failed",
    "cancelled",
  ]);
  if (allowedStatuses.has(String(input.status))) {
    job.status = String(input.status);
  }
  const progress = Number(input.progress);
  if (Number.isFinite(progress)) {
    job.progress = Math.max(0, Math.min(100, progress));
  }
  if (typeof input.message === "string") {
    job.message = input.message.slice(0, 500);
  }
  if (Array.isArray(input.captions)) job.captions = input.captions;
  if (input.alignment && typeof input.alignment === "object") {
    job.alignment = input.alignment as Record<string, unknown>;
  }
  if (typeof input.languageCode === "string") {
    job.languageCode = input.languageCode;
  }
  if (input.style && typeof input.style === "object") {
    job.style = input.style as Record<string, unknown>;
  }
  await writeJob(bucket, job);
  return json(publicJob(job));
}

async function uploadArtifact(
  request: Request,
  bucket: R2Bucket,
  job: StoredJob,
  artifact: string,
) {
  if (!hasCapability(request, job)) {
    return json({ error: "Artifact capability is invalid." }, 401);
  }
  if (!request.body) return json({ error: "Artifact body is required." }, 400);

  let key: string;
  let contentType: string;
  if (artifact === "result") {
    key = `jobs/${job.id}/captioned.mp4`;
    contentType = "video/mp4";
    job.resultKey = key;
  } else if (artifact === "captions.ass") {
    key = `jobs/${job.id}/captions.ass`;
    contentType = "text/x-ssa; charset=utf-8";
    job.assKey = key;
  } else {
    return json({ error: "Unknown artifact." }, 404);
  }

  await bucket.put(key, request.body, {
    httpMetadata: { contentType },
  });
  await writeJob(bucket, job);
  return json({ ok: true, key }, 201);
}

async function cancelJob(
  request: Request,
  env: MediaEnv,
  bucket: R2Bucket,
  job: StoredJob,
) {
  if (!hasCapability(request, job)) {
    return json({ error: "Cancellation capability is invalid." }, 401);
  }
  if (["complete", "failed", "cancelled"].includes(job.status)) {
    return json(publicJob(job), 202);
  }
  job.status = "cancelled";
  job.message = "Processing cancelled";
  await writeJob(bucket, job);

  const renderApi = String(env.RENDER_API_URL ?? DEFAULT_RENDER_API).replace(
    /\/+$/,
    "",
  );
  await fetch(`${renderApi}/v2/jobs/${job.id}`, {
    method: "DELETE",
  }).catch(() => undefined);
  return json(publicJob(job), 202);
}

async function rerenderJob(
  request: Request,
  env: MediaEnv,
  bucket: R2Bucket,
  job: StoredJob,
) {
  if (!hasCapability(request, job)) {
    return json({ error: "Render capability is invalid." }, 401);
  }
  if (!["ready", "complete"].includes(job.status)) {
    return json(
      { error: `Job is not ready for rendering (${job.status}).` },
      409,
    );
  }
  const body = await request.text();
  const renderApi = String(env.RENDER_API_URL ?? DEFAULT_RENDER_API).replace(
    /\/+$/,
    "",
  );
  const response = await fetch(`${renderApi}/v2/jobs/${job.id}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const payload = await response.text();
  if (!response.ok) {
    return new Response(payload, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }
  job.status = "rendering";
  job.progress = 82;
  job.message = "Re-render queued";
  await writeJob(bucket, job);
  return json(publicJob(job), 202);
}

export async function handleMediaRequest(
  request: Request,
  env: MediaEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/media/")) return null;
  const bucket = env.MEDIA;
  if (!bucket) {
    return json({ error: "Media storage is not provisioned." }, 503);
  }

  if (request.method === "POST" && url.pathname === "/api/media/jobs") {
    return createJob(request, bucket);
  }

  const match = url.pathname.match(
    /^\/api\/media\/jobs\/([0-9a-f-]{36})(?:\/([^/]+))?$/i,
  );
  if (!match) return json({ error: "Media route not found." }, 404);
  const [, id, action] = match;
  const job = await readJob(bucket, id);
  if (!job) return json({ error: "Job not found." }, 404);
  if (Date.parse(job.expiresAt) <= Date.now()) {
    await deleteJobObjects(bucket, job);
    return json({ error: "Job expired." }, 410);
  }

  if (!action && request.method === "GET") return json(publicJob(job));
  if (!action && request.method === "DELETE") {
    return cancelJob(request, env, bucket, job);
  }
  if (action === "source" && request.method === "PUT") {
    return uploadSource(request, bucket, job);
  }
  if (action === "source" && request.method === "GET") {
    if (!hasCapability(request, job)) {
      return json({ error: "Source capability is invalid." }, 401);
    }
    return serveObject(request, bucket, job.sourceKey);
  }
  if (action === "process" && request.method === "POST") {
    return startProcessing(request, env, bucket, job);
  }
  if (action === "render" && request.method === "POST") {
    return rerenderJob(request, env, bucket, job);
  }
  if (action === "state" && request.method === "PUT") {
    return updateState(request, bucket, job);
  }
  if (
    (action === "result" || action === "captions.ass") &&
    request.method === "PUT"
  ) {
    return uploadArtifact(request, bucket, job, action);
  }
  if (action === "result" && request.method === "GET" && job.resultKey) {
    return serveObject(request, bucket, job.resultKey);
  }
  if (action === "download" && request.method === "GET" && job.resultKey) {
    const baseName = job.originalName
      .replace(/\.[^.]+$/, "")
      .replace(/[^\p{L}\p{N}_-]+/gu, "-");
    return serveObject(request, bucket, job.resultKey, {
      attachmentName: `${baseName || "syncword"}-captioned.mp4`,
    });
  }
  if (action === "captions.ass" && request.method === "GET" && job.assKey) {
    return serveObject(request, bucket, job.assKey, {
      attachmentName: "captions.ass",
    });
  }
  return json({ error: "Media action is not ready." }, 404);
}
