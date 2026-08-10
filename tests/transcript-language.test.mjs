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

test("keeps requested Bodo when Saaras reports another language", () => {
  assert.equal(resolveTranscriptLanguage("asm", "brx-IN"), "brx-IN");
  assert.equal(languageTag("brx-IN"), "brx");
});

test("rejects unsupported requested and caption languages", () => {
  assert.throws(
    () => resolveTranscriptLanguage("as-IN", "unknown"),
    /as-IN or brx-IN/,
  );
  assert.throws(() => languageTag("mix"), /as-IN or brx-IN/);
});
