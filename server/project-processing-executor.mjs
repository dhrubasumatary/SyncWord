import path from "node:path";

import {
  downloadProjectProcessingSource,
  putProjectProcessingResult,
  putProjectProcessingState,
} from "./project-processing-protocol.mjs";

function failureCode(error) {
  const code = String(error?.code ?? "project_processing_failed")
    .replace(/[^a-z0-9_-]+/gi, "_")
    .slice(0, 100);
  return code || "project_processing_failed";
}

function cancelledError() {
  const error = new Error("Processing cancelled.");
  error.code = "SYNCWORD_CANCELLED";
  return error;
}

/**
 * Owns the durable project-processing boundary. The injected `process` reuses
 * The existing STT/alignment/recovery implementation; this executor
 * owns authenticated source transfer, canonical progress, and the idempotent
 * immutable result PUT.
 */
export async function executeProjectProcessing({
  plan,
  directory,
  process,
  fetchImpl = fetch,
  isCancelled = () => false,
  signal,
}) {
  const inputPath = path.join(directory, "source.mp4");
  let stateQueue = Promise.resolve();
  const queueState = (state) => {
    stateQueue = stateQueue
      .catch(() => undefined)
      .then(() => putProjectProcessingState(plan, state, fetchImpl))
      .catch(() => undefined);
    return stateQueue;
  };

  try {
    await queueState({
      status: "extracting",
      progress: 2,
      message: "Loading immutable source",
    });
    await downloadProjectProcessingSource(plan, inputPath, fetchImpl, { signal });
    if (isCancelled()) throw cancelledError();
    const result = await process({
      plan,
      inputPath,
      directory,
      onState: queueState,
    });
    await stateQueue;
    if (isCancelled()) throw cancelledError();
    if (!result?.document) {
      const error = new Error("Caption processor did not produce a project document.");
      error.code = "processing_document_missing";
      throw error;
    }
    await putProjectProcessingResult(plan, result.document, {
      changeSummary: result.changeSummary ?? "Automatic captions",
      fetchImpl,
      signal,
    });
    return result;
  } catch (error) {
    await stateQueue.catch(() => undefined);
    const cancelled = isCancelled() || error?.code === "SYNCWORD_CANCELLED";
    await putProjectProcessingState(
      plan,
      {
        status: cancelled ? "cancelled" : "failed",
        progress: 0,
        message: cancelled
          ? "Processing cancelled"
          : error instanceof Error
            ? error.message
            : "Project processing failed",
        ...(!cancelled ? { failureCode: failureCode(error) } : {}),
      },
      fetchImpl,
    ).catch(() => undefined);
    throw error;
  }
}
