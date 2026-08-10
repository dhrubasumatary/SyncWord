import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://syncword.example/", {
      headers: {
        accept: "text/html",
        host: "syncword.example",
        "x-forwarded-host": "syncword.example",
        "x-forwarded-proto": "https",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders subtitles by miithii", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>subtitles — by miithii<\/title>/i,
  );
  assert.match(html, /Make every word/);
  assert.match(html, /Assamese or Bodo video/);
  assert.match(html, /Choose a video/);
  assert.match(html, /up to 3 min · 90 MB/);
  assert.match(html, /First-pass captions/);
  assert.match(html, /Make each one small or large/);
  assert.match(html, /Rendering starts only when you approve/);
  assert.doesNotMatch(
    html,
    /মোৰ ভাষা|आंनि राव|brahmaputra-stories|MAJULI/i,
  );
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("removes the disposable starter and wires product metadata", async () => {
  const [
    page,
    layout,
    fontsCss,
    packageJson,
    renderServer,
    renderDockerfile,
    mediaWorker,
    projectClient,
    projectWorker,
    webRevision,
  ] =
    await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/fonts.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../worker/media.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/project-client.mjs", import.meta.url), "utf8"),
    readFile(new URL("../worker/projects.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/revision.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /subtitles/);
  assert.match(page, /by miithii/);
  assert.doesNotMatch(page, /SyncWord/);
  assert.match(page, /NEXT_PUBLIC_RENDER_API_URL/);
  assert.match(page, /Everything said/);
  assert.match(page, /CaptionTimeline/);
  assert.match(page, /Caption text/);
  assert.match(page, /Fine timing/);
  assert.match(page, /word-needs-timing-review/);
  assert.match(page, /Play the outlined words and nudge each once to approve/);
  assert.match(page, /Start −30 ms/);
  assert.match(page, /Done with this line/);
  assert.match(page, /onChange=\{updateCaptionTiming\}/);
  assert.match(page, /Make my video/);
  assert.match(page, /createProjectProcessingJob/);
  assert.match(page, /createProjectRevision/);
  assert.match(page, /createProjectRenderJob/);
  assert.match(page, /fps: "source"/);
  assert.match(page, /activeRenderRequestScope/);
  assert.match(page, /activeRenderAttemptDiscriminator/);
  assert.match(page, /lastCompletedRenderJobId/);
  assert.match(page, /selectCompletedRenderArtifact/);
  assert.match(
    page,
    /const dispatchSessionPersisted = await persistProjectSession\([\s\S]{0,700}attemptedProjectDispatch = true;[\s\S]{0,300}createProjectRenderJob/,
  );
  assert.match(page, /expectedProcessorRevision = "syncword-caption-v3"/);
  assert.match(page, /expectedRendererRevision = "syncword-render-v2"/);
  assert.match(page, /renderHealthIsCompatible/);
  assert.match(page, /loadBrowserVideoMetadata/);
  assert.match(
    page,
    /accept="\.mp4,\.webm,\.m4v,video\/mp4,video\/webm,video\/x-m4v"/,
  );
  assert.doesNotMatch(page, /accept="video\/\*,\.mkv"/);
  assert.match(page, /projectAssetContentUrl/);
  assert.match(
    page,
    /if \(usingDurableMedia\) \{[\s\S]{0,1400}reserveProjectAsset[\s\S]{0,1800}createProjectProcessingJob/,
  );
  assert.doesNotMatch(
    page,
    /createProjectRenderJob\([\s\S]{0,500}\{\s*captions\s*,\s*style/,
  );
  assert.match(page, /uncertain words stay steady instead of drifting/);
  assert.match(page, /revision\.json\?check=/);
  assert.match(page, new RegExp(JSON.parse(webRevision).revision));
  assert.match(page, /Reload before making captions/);
  assert.match(page, /expectedCaptionQualityRevision/);
  assert.match(page, /Reload the editor before uploading another video/);
  assert.doesNotMatch(
    page,
    /initialCaptions|demoDuration|importSrt|Download SRT|distributeWords/,
  );
  assert.doesNotMatch(
    page,
    /const processingStatuses[\s\S]{0,160}"ready"/,
  );
  assert.match(layout, /title: "subtitles — by miithii"/);
  assert.match(layout, /fonts\.css/);
  assert.match(layout, /miithii-tokens\.css/);
  assert.match(fontsCss, /Noto Sans Bengali/);
  assert.match(fontsCss, /Noto Sans Devanagari/);
  assert.match(fontsCss, /\/fonts\/noto-sans-bengali-script\.woff2/);
  assert.match(fontsCss, /\/fonts\/noto-sans-devanagari-script\.woff2/);
  assert.doesNotMatch(fontsCss, /[A-Z]:[\\/]/);
  assert.match(renderServer, /SARVAM_MODEL \?\? "saaras:v3"/);
  assert.match(renderServer, /model: sarvamModel,\s*mode,/);
  assert.match(
    renderServer,
    /for \(let attempt = 0; attempt < 3; attempt \+= 1\)[\s\S]{0,300}new FormData\(\)/,
  );
  assert.match(renderServer, /"codemix", "verbatim", "transcribe"/);
  assert.match(renderServer, /with_timestamps: true/);
  assert.match(renderServer, /alignTranscriptWithModal/);
  assert.match(renderServer, /summary: result\.alignment/);
  assert.match(
    renderServer,
    /runPreferredSarvamTranscript\(\s*job,\s*"verbatim"/,
  );
  assert.match(renderServer, /silencedetect=noise=-35dB:d=0\.22/);
  assert.match(renderServer, /\/speech-to-text/);
  assert.match(renderServer, /Automatic timing could not lock onto this voice/);
  assert.match(renderServer, /displayCaptions/);
  assert.match(renderServer, /transcript_gap_recovery_failed/);
  assert.match(renderServer, /chooseBetterAlignment/);
  assert.match(renderServer, /phraseTimedWords/);
  assert.match(renderServer, /canHighlightGroup/);
  assert.match(
    renderServer,
    /const captionQualityRevision = CAPTION_QUALITY_REVISION/,
  );
  assert.match(renderServer, /const rendererRevision =/);
  assert.match(renderServer, /project_renderer_revision_unsupported/);
  assert.match(
    page,
    /const expectedCaptionQualityRevision = CAPTION_QUALITY_REVISION/,
  );
  assert.doesNotMatch(page, /perceptual-gate-v1/);
  assert.match(renderServer, /speech_coverage_recovery_started/);
  assert.match(renderServer, /caption_job_review_required/);
  assert.match(renderServer, /caption_timing_review_required/);
  assert.match(renderServer, /timingReview: timelineFinalization\.diagnostics/);
  assert.match(renderServer, /validateRenderCaptionSubmission/);
  assert.match(renderServer, /acceptRenderCaptionSubmission/);
  assert.match(renderServer, /uncoveredIntervals/);
  assert.match(mediaWorker, /caption_coverage_unverified/);
  assert.match(mediaWorker, /"review_required"/);
  assert.match(mediaWorker, /job.alignment = payload.alignment/);
  assert.match(mediaWorker, /job.captions = payload.captions/);
  assert.match(projectWorker, /\/v3\/processing-jobs/);
  assert.match(projectWorker, /finalizeProcessingResult/);
  assert.match(projectWorker, /serveAssetContent/);
  assert.match(projectWorker, /\/v3\/render-jobs/);
  assert.match(
    projectWorker,
    /DEFAULT_RENDER_API = "https:\/\/syncword-render-dhrub404\.onrender\.com"/,
  );
  assert.match(projectWorker, /video_artifact_required/);
  assert.match(projectClient, /credentials: "same-origin"/);
  assert.doesNotMatch(projectClient, /authorization\s*:/i);
  assert.match(renderServer, /caption_job_queued/);
  assert.match(renderServer, /caption_job_ready/);
  assert.match(renderServer, /phraseTimedWords: timingQuality\.phraseTimedWords/);
  assert.match(renderDockerfile, /COPY shared \.\/shared/);
  assert.doesNotMatch(
    renderServer,
    /if \(job\.status === "ready"\) \{\s*await renderVideo/,
  );
  assert.match(
    renderServer,
    /transcriptToCaptions\(transcript, job\.language\)/,
  );
  assert.match(renderServer, /\/v2\/jobs/);
  assert.doesNotMatch(renderServer, /\\kf\$\{duration\}/);
  assert.match(renderServer, /processJob/);
  assert.match(renderServer, /\/v1\/jobs\/:id\/result/);
  assert.match(renderServer, /app\.delete\("\/v1\/jobs\/:id"/);
  assert.match(renderServer, /Processing cancelled/);
  assert.match(renderServer, /JOB_RETENTION_HOURS/);
  assert.doesNotMatch(renderServer, /input_audio_codec/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  const modalAligner = await readFile(
    new URL("../modal_app/syncword_aligner.py", import.meta.url),
    "utf8",
  );
  assert.match(modalAligner, /"as": "asm"/);
  assert.match(modalAligner, /tokenizer\(alignment_words\)/);
  assert.match(modalAligner, /_suspicious_word_boundaries/);
  assert.match(modalAligner, /_apply_display_surfaces/);
  assert.match(modalAligner, /surfaceWordsReplaced/);
  assert.match(modalAligner, /_split_long_caption/);
  assert.match(modalAligner, /_continuous_caption_groups/);
  assert.match(modalAligner, /mms-fa-speech-windows-v13/);
  assert.match(modalAligner, /same_source_segment/);
  assert.match(modalAligner, /_trim_recovery_word_end/);
  assert.match(modalAligner, /alignmentComplete/);
  assert.doesNotMatch(
    modalAligner,
    /alignment_words\.extend\(\(normalized_word, "\*"\)\)/,
  );

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", templateRoot)),
  );
  await Promise.all(
    [
      "manrope-latin.woff2",
      "space-grotesk-latin.woff2",
      "space-mono-latin-400.woff2",
      "space-mono-latin-700.woff2",
      "noto-sans-bengali-script.woff2",
      "noto-sans-bengali-latin.woff2",
      "noto-sans-devanagari-script.woff2",
      "noto-sans-devanagari-latin.woff2",
    ].map((name) =>
      access(new URL(`public/fonts/${name}`, templateRoot)),
    ),
  );
});
