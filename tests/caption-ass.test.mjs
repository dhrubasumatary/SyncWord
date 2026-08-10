import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("ASS keeps small and large word sizes in phrase and word sync paths", async (context) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "miithii-ass-"));
  process.env.PORT = "0";
  process.env.RUNTIME_DIR = runtimeRoot;
  const { createAss, renderServer } = await import(
    `../server/index.mjs?ass-test=${Date.now()}`
  );
  if (!renderServer.listening) await once(renderServer, "listening");
  context.after(async () => {
    await new Promise((resolve, reject) => {
      renderServer.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  const style = {
    fontFamily: "Noto Sans Bengali",
    fontSize: 50,
    textColor: "#ffffff",
    highlightColor: "#c6ff3d",
    backgroundOpacity: 0,
    animation: "fade",
    wordsPerCard: 4,
  };
  const words = [
    {
      id: "word-small",
      text: "সৰু",
      start: 0,
      end: 0.5,
      displaySize: "small",
      highlightSafe: true,
    },
    {
      id: "word-large",
      text: "ডাঙৰ",
      start: 0.5,
      end: 1,
      displaySize: "large",
      highlightSafe: true,
    },
  ];
  const wordSync = createAss(
    [{ id: "cue-sync", text: "সৰু ডাঙৰ", start: 0, end: 1, words }],
    style,
    "as-IN",
    { width: 720, height: 1280 },
  );

  assert.match(wordSync, /Title: subtitles by miithii/);
  assert.match(wordSync, /\\fs50/);
  assert.match(wordSync, /\\fs73/);
  assert.match(wordSync, /\\1c&H003DFFC6&\\fs73\\fscx116\\fscy116/);

  const phraseSync = createAss(
    [
      {
        id: "cue-phrase",
        text: "সৰু ডাঙৰ",
        start: 0,
        end: 1,
        words: words.map((word) => ({
          ...word,
          highlightSafe: false,
          highlightReason: "invalid_boundary",
        })),
      },
    ],
    style,
    "as-IN",
    { width: 720, height: 1280 },
  );

  assert.match(phraseSync, /\{\\fs50\}সৰু \{\\fs73\}ডাঙৰ/);
  assert.doesNotMatch(phraseSync, /\\fscx116/);
});
