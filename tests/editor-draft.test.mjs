import assert from "node:assert/strict";
import test from "node:test";

import {
  EDITOR_DRAFT_SCHEMA_VERSION,
  commitRevision,
  createEditorDraft,
  createMemoryDraftAdapter,
  createResilientDraftStore,
  createRevisionHistory,
  editorRevisionId,
  markRevisionBase,
  parseEditorDraft,
  redoRevision,
  revisionHistoryDirty,
  serializeEditorDraft,
  undoRevision,
} from "../shared/editor-draft.mjs";

function snapshot(text = "hello", color = "#fff") {
  return {
    language: "as-IN",
    transcriptMode: "codemix",
    activePresetName: "Signal",
    captionStyle: { textColor: color },
    captions: [
      {
        id: "caption-1",
        start: 0,
        end: 1,
        text,
        words: [
          {
            id: "word-1",
            text,
            start: 0,
            end: 1,
            confidence: 1,
            source: "manual",
          },
        ],
      },
    ],
  };
}

function draftAt(savedAt, text = "hello") {
  const history = createRevisionHistory(snapshot(text));
  return serializeEditorDraft(
    createEditorDraft({ savedAt, history, media: null, job: null }),
  );
}

test("revision history tracks a clean base and deterministic undo/redo", () => {
  const initial = createRevisionHistory(snapshot());
  assert.equal(revisionHistoryDirty(initial), false);

  const editedText = commitRevision(initial, snapshot("নমস্কাৰ"));
  const editedStyle = commitRevision(
    editedText,
    snapshot("নমস্কাৰ", "#cfff47"),
  );
  assert.equal(revisionHistoryDirty(editedStyle), true);
  assert.equal(editedStyle.past.length, 2);

  const undone = undoRevision(editedStyle);
  assert.equal(undone.present.snapshot.captions[0].text, "নমস্কাৰ");
  assert.equal(undone.present.snapshot.captionStyle.textColor, "#fff");
  assert.equal(undone.future.length, 1);

  const redone = redoRevision(undone);
  assert.deepEqual(redone.present.snapshot, editedStyle.present.snapshot);
  assert.equal(redone.future.length, 0);

  const saved = markRevisionBase(redone);
  assert.equal(revisionHistoryDirty(saved), false);
  assert.equal(saved.baseRevision, saved.present.revisionId);
});

test("committing after undo clears redo and history stays bounded", () => {
  let history = createRevisionHistory(snapshot("0"), { limit: 2 });
  history = commitRevision(history, snapshot("1"));
  history = commitRevision(history, snapshot("2"));
  history = commitRevision(history, snapshot("3"));
  assert.equal(history.past.length, 2);

  history = undoRevision(history);
  assert.equal(history.future.length, 1);
  history = commitRevision(history, snapshot("replacement"));
  assert.equal(history.future.length, 0);
  assert.equal(history.present.snapshot.captions[0].text, "replacement");
});

test("content revision IDs do not depend on object key insertion order", () => {
  assert.equal(
    editorRevisionId({ captions: [], style: { color: "white", size: 72 } }),
    editorRevisionId({ style: { size: 72, color: "white" }, captions: [] }),
  );
});

test("draft serialization excludes File-like instances and object URLs", () => {
  class FakeFile {
    constructor() {
      this.bytes = "raw-video-data";
    }
  }

  const unsafeSnapshot = {
    ...snapshot(),
    runtimeFile: new FakeFile(),
    previewObjectUrl: "blob:https://syncword.test/temporary-video",
    nestedCredentials: {
      callbackToken: "callback-secret",
      authorization: "Bearer persisted-secret",
    },
  };
  const history = createRevisionHistory(unsafeSnapshot);
  const serialized = serializeEditorDraft(
    createEditorDraft({
      projectId: "job-1",
      savedAt: "2026-08-10T08:00:00.000Z",
      media: {
        name: "source.mp4",
        type: "video/mp4",
        size: 1024,
        lastModified: 123,
        durable: true,
        duration: 12.5,
        videoRatio: 9 / 16,
        file: new FakeFile(),
        objectUrl: "blob:https://syncword.test/source",
      },
      job: {
        id: "job-1",
        status: "ready",
        capabilityToken: "secret-capability",
        previewUrl: "blob:https://syncword.test/result",
        uploadUrl: "/ephemeral-upload",
      },
      history,
      view: {
        tab: "review",
        selectedCaptionId: "caption-1",
        selectedWordIndex: 0,
        captionDrafts: { "caption-1": "draft text" },
      },
    }),
  );

  assert.equal(serialized.includes("raw-video-data"), false);
  assert.equal(serialized.includes("blob:"), false);
  assert.equal(serialized.includes("ephemeral-upload"), false);

  const restored = parseEditorDraft(serialized);
  assert.equal(restored.schemaVersion, EDITOR_DRAFT_SCHEMA_VERSION);
  assert.deepEqual(restored.media, {
    name: "source.mp4",
    type: "video/mp4",
    size: 1024,
    lastModified: 123,
    durable: true,
    duration: 12.5,
    videoRatio: 9 / 16,
  });
  assert.equal("capabilityToken" in restored.job, false);
  assert.equal(serialized.includes("secret-capability"), false);
  assert.equal(serialized.includes("callback-secret"), false);
  assert.equal(serialized.includes("persisted-secret"), false);
  assert.equal("previewUrl" in restored.job, false);
  assert.equal("runtimeFile" in restored.history.present.snapshot, false);
});

test("parsing rejects corrupt and future-version drafts", () => {
  assert.equal(parseEditorDraft("not json"), null);
  assert.equal(
    parseEditorDraft(
      JSON.stringify({ schemaVersion: EDITOR_DRAFT_SCHEMA_VERSION + 1 }),
    ),
    null,
  );
  assert.equal(
    parseEditorDraft(
      JSON.stringify({
        schemaVersion: EDITOR_DRAFT_SCHEMA_VERSION,
        savedAt: "2026-08-10T08:00:00.000Z",
        history: {},
      }),
    ),
    null,
  );
});

test("resilient storage falls back and restores the newest valid copy", async () => {
  const oldDraft = draftAt("2026-08-10T08:00:00.000Z", "old");
  const newDraft = draftAt("2026-08-10T09:00:00.000Z", "new");
  const primary = createMemoryDraftAdapter({ active: oldDraft });
  const fallback = createMemoryDraftAdapter({ active: newDraft });
  const store = createResilientDraftStore({ primary, fallback });

  assert.equal(await store.load("active"), newDraft);

  const unavailablePrimary = {
    async getItem() {
      throw new Error("IndexedDB denied");
    },
    async setItem() {
      throw new Error("IndexedDB denied");
    },
    async removeItem() {
      throw new Error("IndexedDB denied");
    },
  };
  const fallbackOnly = createMemoryDraftAdapter();
  const fallbackStore = createResilientDraftStore({
    primary: unavailablePrimary,
    fallback: fallbackOnly,
  });
  assert.equal(await fallbackStore.save("active", newDraft), "fallback");
  assert.equal(await fallbackStore.load("active"), newDraft);
  await fallbackStore.remove("active");
  assert.equal(await fallbackOnly.getItem("active"), null);
});
