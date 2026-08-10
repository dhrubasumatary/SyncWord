import path from "node:path";

import {
  downloadProjectSource,
  fetchProjectRevision,
  putProjectRenderState,
  uploadProjectRenderArtifact,
} from "./project-render-protocol.mjs";

function failureCode(error) {
  const code = String(error?.code ?? "project_render_failed")
    .replace(/[^a-z0-9_-]+/gi, "_")
    .slice(0, 100);
  return code || "project_render_failed";
}

/**
 * Executes one immutable project render. The injected renderer owns FFmpeg;
 * this orchestrator owns the durable protocol and never marks success before
 * both the ASS and video artifacts have been acknowledged by the Worker.
 */
export async function executeProjectRender({
  plan,
  directory,
  render,
  fetchImpl = fetch,
  isCancelled = () => false,
}) {
  const inputPath = path.join(directory, "source.mp4");
  try {
    await putProjectRenderState(
      plan,
      { status: "running", progress: 2, message: "Loading immutable revision" },
      fetchImpl,
    );
    const [{ document, renderInput }] = await Promise.all([
      fetchProjectRevision(plan, fetchImpl),
      downloadProjectSource(plan, inputPath, fetchImpl),
    ]);
    await putProjectRenderState(
      plan,
      { status: "running", progress: 18, message: "Preparing caption render" },
      fetchImpl,
    );
    const output = await render({
      plan,
      document,
      renderInput,
      inputPath,
      directory,
      onProgress: (progress, message) =>
        putProjectRenderState(
          plan,
          { status: "running", progress, message },
          fetchImpl,
        ),
    });
    if (!output?.captionsAssPath || !output?.videoPath) {
      const error = new Error("Renderer did not produce the required artifacts.");
      error.code = "render_artifacts_missing";
      throw error;
    }
    await putProjectRenderState(
      plan,
      { status: "running", progress: 94, message: "Saving caption artifacts" },
      fetchImpl,
    );
    await uploadProjectRenderArtifact(
      plan,
      "captions_ass",
      output.captionsAssPath,
      "text/x-ssa; charset=utf-8",
      { fetchImpl },
    );
    await uploadProjectRenderArtifact(
      plan,
      "video",
      output.videoPath,
      "video/mp4",
      { codecManifest: output.codecManifest, fetchImpl },
    );
    await putProjectRenderState(
      plan,
      { status: "succeeded", progress: 100, message: "Captioned video ready" },
      fetchImpl,
    );
    return output;
  } catch (error) {
    const cancelled = isCancelled();
    await putProjectRenderState(
      plan,
      {
        status: cancelled ? "cancelled" : "failed",
        progress: 0,
        message: cancelled
          ? "Rendering cancelled"
          : error instanceof Error
            ? error.message
            : "Project render failed",
        ...(!cancelled ? { failureCode: failureCode(error) } : {}),
      },
      fetchImpl,
    ).catch(() => undefined);
    throw error;
  }
}
