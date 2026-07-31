import assert from "node:assert/strict";
import test from "node:test";
import {
  languageTag,
  resolveTranscriptLanguage,
} from "../server/transcript-language.mjs";

test("keeps requested Assamese when Saaras omits language detection", () => {
  assert.equal(resolveTranscriptLanguage(undefined, "as-IN"), "as-IN");
  assert.equal(languageTag("as-IN"), "as");
});

test("normalizes ISO aliases returned by speech providers", () => {
  assert.equal(resolveTranscriptLanguage("asm", "unknown"), "as-IN");
  assert.equal(resolveTranscriptLanguage("brx", "unknown"), "brx-IN");
});

test("prefers detected language over the requested fallback", () => {
  assert.equal(resolveTranscriptLanguage("brx-IN", "as-IN"), "brx-IN");
  assert.equal(languageTag("brx-IN"), "brx");
});
