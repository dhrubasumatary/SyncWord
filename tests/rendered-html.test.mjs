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

test("server-renders the SyncWord editor", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>SyncWord — Sync first\. Render once\.<\/title>/i,
  );
  assert.match(html, /Your words\./);
  assert.match(html, /On beat\./);
  assert.match(html, /Upload your reel/);
  assert.match(html, /3 min \/ 90 MB/);
  assert.match(html, /GPU CTC alignment/);
  assert.match(html, /No mock transcript/);
  assert.match(html, /No render while you edit/);
  assert.match(html, /ASS/);
  assert.doesNotMatch(
    html,
    /মোৰ ভাষা|आंनि राव|brahmaputra-stories|MAJULI/i,
  );
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("removes the disposable starter and wires product metadata", async () => {
  const [page, layout, packageJson, renderServer] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(page, /SyncWord/);
  assert.match(page, /NEXT_PUBLIC_RENDER_API_URL/);
  assert.match(page, /Advanced SubStation Alpha/);
  assert.match(page, /Whole-word ASS hits/);
  assert.match(page, /Exact speech/);
  assert.match(page, /Loop this word/);
  assert.match(page, /Word start/);
  assert.match(page, /Phrase 100 ms/);
  assert.match(page, /Looks right/);
  assert.match(page, /Preview looks right — render anyway/);
  assert.doesNotMatch(
    page,
    /initialCaptions|demoDuration|importSrt|Download SRT|distributeWords/,
  );
  assert.doesNotMatch(
    page,
    /const processingStatuses[\s\S]{0,160}"ready"/,
  );
  assert.match(layout, /og-correction\.png/);
  assert.match(layout, /x-forwarded-host/);
  assert.match(renderServer, /model: "saaras:v3"/);
  assert.match(renderServer, /model: "saaras:v3",\s*mode,/);
  assert.match(renderServer, /"codemix", "verbatim", "transcribe"/);
  assert.match(renderServer, /with_timestamps: true/);
  assert.match(renderServer, /alignTranscriptWithModal/);
  assert.match(renderServer, /summary: result\.alignment/);
  assert.match(renderServer, /runSarvamTranscript\(\s*job,\s*"verbatim"/);
  assert.match(renderServer, /displayCaptions/);
  assert.match(renderServer, /transcript_gap_recovery_failed/);
  assert.match(renderServer, /words need timing review before export/);
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
  assert.match(modalAligner, /_trim_recovery_word_end/);
  assert.match(modalAligner, /alignmentComplete/);
  assert.doesNotMatch(
    modalAligner,
    /alignment_words\.extend\(\(normalized_word, "\*"\)\)/,
  );

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", templateRoot)),
  );
});
