import express from "express";
import { timingSafeEqual } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  parseProjectProcessingRequest,
  putProjectProcessingState,
} from "./project-processing-protocol.mjs";

const ACTIVE_STATUSES = new Set([
  "queued",
  "extracting",
  "transcribing",
  "aligning",
  "recovering",
]);
const SUCCESS_STATUSES = new Set(["ready", "review_required"]);
const TERMINAL_STATUSES = new Set([
  ...SUCCESS_STATUSES,
  "failed",
  "cancelled",
]);

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization ?? ""));
  return match?.[1] ?? "";
}

export function projectJobCapabilityMatches(request, expectedToken) {
  const actual = Buffer.from(bearerToken(request));
  const expected = Buffer.from(String(expectedToken ?? ""));
  return (
    actual.length > 0 &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}

export const processingCapabilityMatches = projectJobCapabilityMatches;

export function publicProjectProcessingJob(job, captionQualityRevision) {
  return {
    id: job.id,
    projectId: job.projectId,
    sourceAssetId: job.sourceAssetId,
    requestFingerprint: job.requestFingerprint,
    processorRevision: job.processorRevision,
    status: job.status,
    progress: job.progress,
    message: job.message,
    ...(job.failureCode ? { failureCode: job.failureCode } : {}),
    ...(captionQualityRevision ? { captionQualityRevision } : {}),
  };
}

function routeError(response, status, code, error) {
  response.status(status).json({ error, code });
}

/**
 * Creates an independently testable Express router. Queueing, runtime
 * cancellation, and the actual caption pipeline are injected so the legacy
 * endpoints remain untouched.
 */
export function createProjectProcessingRouter({
  root,
  jobs,
  maxQueuedJobs,
  jobLifetimeMs,
  allowedOrigins,
  captionQualityRevision,
  supportedProcessorRevision,
  enqueue,
  ensureRuntime,
  cancelRuntime,
  runJob,
  putState = putProjectProcessingState,
}) {
  const router = express.Router();

  router.post("/", async (request, response) => {
    let plan;
    try {
      plan = parseProjectProcessingRequest(request.body, {
        allowedOrigins:
          typeof allowedOrigins === "function"
            ? allowedOrigins()
            : allowedOrigins,
      });
    } catch (error) {
      routeError(
        response,
        400,
        error?.code ?? "invalid_project_processing_request",
        error instanceof Error ? error.message : "Invalid project processing request.",
      );
      return;
    }

    if (
      supportedProcessorRevision &&
      plan.processorRevision !== supportedProcessorRevision
    ) {
      routeError(
        response,
        409,
        "project_processing_revision_unsupported",
        `This compute service supports processor revision ${supportedProcessorRevision}.`,
      );
      return;
    }

    const idempotencyKey = String(request.headers["idempotency-key"] ?? "");
    if (idempotencyKey !== plan.id) {
      routeError(
        response,
        409,
        "project_processing_idempotency_mismatch",
        "Idempotency-Key must equal the immutable processing job id.",
      );
      return;
    }
    const fingerprintHeader = request.headers["x-syncword-request-fingerprint"];
    if (
      fingerprintHeader !== undefined &&
      String(fingerprintHeader) !== plan.requestFingerprint
    ) {
      routeError(
        response,
        409,
        "project_processing_fingerprint_header_mismatch",
        "The request fingerprint header does not match the processing payload.",
      );
      return;
    }

    const existing = jobs.get(plan.id);
    if (existing) {
      if (existing.requestFingerprint !== plan.requestFingerprint) {
        routeError(
          response,
          409,
          "project_processing_fingerprint_conflict",
          "This processing job id already names different immutable input.",
        );
        return;
      }
      if (!new Set(["failed", "cancelled"]).has(existing.status)) {
        response
          .status(SUCCESS_STATUSES.has(existing.status) ? 200 : 202)
          .json(publicProjectProcessingJob(existing, captionQualityRevision));
        return;
      }
    }

    const active = [...jobs.values()].filter((job) =>
      ACTIVE_STATUSES.has(job.status),
    ).length;
    if (active >= maxQueuedJobs) {
      routeError(
        response,
        429,
        "project_processing_queue_full",
        "The caption processing queue is full. Try again in a few minutes.",
      );
      return;
    }

    const directory = path.join(root, plan.id);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const now = new Date().toISOString();
    const job = {
      id: plan.id,
      projectId: plan.projectId,
      sourceAssetId: plan.source.assetId,
      requestFingerprint: plan.requestFingerprint,
      processorRevision: plan.processorRevision,
      directory,
      inputPath: path.join(directory, "source.mp4"),
      language: plan.processing.language,
      mode: plan.processing.mode,
      style: {},
      status: "queued",
      progress: 0,
      message: "Queued for captioning",
      captions: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + jobLifetimeMs).toISOString(),
    };
    Object.defineProperties(job, {
      plan: { value: plan, enumerable: false },
      capabilityToken: {
        value: plan.authorization.processingCapabilityToken,
        enumerable: false,
      },
    });
    ensureRuntime(job);
    jobs.set(plan.id, job);
    response
      .status(202)
      .json(publicProjectProcessingJob(job, captionQualityRevision));

    enqueue(job, async () => {
      try {
        const result = await runJob({ job, plan, directory });
        const status = result?.document?.captionTrack?.status;
        if (!SUCCESS_STATUSES.has(status)) {
          const error = new Error(
            "Caption processing did not produce a ready or review_required revision.",
          );
          error.code = "processing_result_status_invalid";
          throw error;
        }
        Object.assign(job, {
          status,
          progress: 100,
          message:
            status === "ready"
              ? "Captions ready to edit"
              : "Some spoken audio still needs captions",
        });
      } catch (error) {
        if (job.cancelRequested || job.status === "cancelled") {
          job.status = "cancelled";
          job.message = "Processing cancelled";
        } else {
          job.status = "failed";
          job.failureCode = String(
            error?.code ?? "project_processing_failed",
          ).slice(0, 100);
          job.message =
            error instanceof Error ? error.message : "Project processing failed";
        }
        await putState(job.plan, {
          status: job.status,
          progress: job.progress,
          message: job.message,
          ...(job.status === "failed"
            ? { failureCode: job.failureCode }
            : {}),
        }).catch(() => undefined);
      } finally {
        job.updatedAt = new Date().toISOString();
        await rm(directory, { recursive: true, force: true }).catch(
          () => undefined,
        );
        const retentionTimer = setTimeout(() => jobs.delete(job.id), jobLifetimeMs);
        retentionTimer.unref?.();
      }
    });
  });

  router.delete("/:id", async (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) {
      routeError(
        response,
        404,
        "project_processing_job_not_found",
        "Project processing job not found.",
      );
      return;
    }
    if (!projectJobCapabilityMatches(request, job.capabilityToken)) {
      routeError(
        response,
        401,
        "processing_cancellation_capability_invalid",
        "Processing cancellation capability is invalid.",
      );
      return;
    }
    const idempotencyKey = request.headers["idempotency-key"];
    if (idempotencyKey !== undefined && String(idempotencyKey) !== job.id) {
      routeError(
        response,
        409,
        "project_processing_idempotency_mismatch",
        "Idempotency-Key must equal the immutable processing job id.",
      );
      return;
    }
    if (job.status === "cancelled") {
      response
        .status(200)
        .json(publicProjectProcessingJob(job, captionQualityRevision));
      return;
    }
    if (TERMINAL_STATUSES.has(job.status)) {
      routeError(
        response,
        409,
        "project_processing_job_terminal",
        `Project processing job is ${job.status} and cannot be cancelled.`,
      );
      return;
    }

    cancelRuntime(job);
    await putState(
      job.plan,
      {
        status: "cancelled",
        progress: job.progress,
        message: "Processing cancelled",
      },
    ).catch(() => undefined);
    response
      .status(202)
      .json(publicProjectProcessingJob(job, captionQualityRevision));
  });

  return router;
}
