// @ts-check

export const EDITOR_DRAFT_SCHEMA_VERSION = 1;
export const EDITOR_DRAFT_STORAGE_KEY = "syncword:active-editor-draft";
export const EDITOR_HISTORY_LIMIT = 60;

/** @typedef {Record<string, unknown>} JsonRecord */
/** @typedef {{ revisionId: string, snapshot: JsonRecord }} EditorRevision */
/** @typedef {{ limit: number, past: EditorRevision[], present: EditorRevision, future: EditorRevision[], baseRevision: string }} RevisionHistory */

/**
 * Clone only JSON-safe data. Runtime-only browser objects (File, Blob, DOM
 * nodes, object URLs, class instances, and circular references) are omitted.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [ancestors]
 * @returns {unknown}
 */
export function cloneSerializable(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.startsWith("blob:") || /^bearer\s/iu.test(value)
      ? undefined
      : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object") return undefined;
  if (ancestors.has(value)) return undefined;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.flatMap((item) => {
        const cloned = cloneSerializable(item, ancestors);
        return cloned === undefined ? [] : [cloned];
      });
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }

    /** @type {JsonRecord} */
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token$/iu.test(key) || /authorization/iu.test(key)) continue;
      const cloned = cloneSerializable(item, ancestors);
      if (cloned !== undefined) result[key] = cloned;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** @param {unknown} value */
function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cloned = cloneSerializable(value);
  return cloned && typeof cloned === "object" && !Array.isArray(cloned)
    ? /** @type {JsonRecord} */ (cloned)
    : null;
}

/** @param {unknown} value */
function stableJson(value) {
  const seen = new WeakSet();
  /**
   * @param {unknown} item
   * @returns {unknown}
   */
  const canonicalize = (item) => {
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) return null;
    seen.add(item);
    try {
      if (Array.isArray(item)) return item.map(canonicalize);
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    } finally {
      seen.delete(item);
    }
  };
  return JSON.stringify(canonicalize(cloneSerializable(value)));
}

/**
 * A deterministic, content-addressed local revision ID. This is intentionally
 * not a server revision; a later sync layer can map it to one without changing
 * the editor history contract.
 *
 * @param {unknown} snapshot
 */
export function editorRevisionId(snapshot) {
  const serialized = stableJson(snapshot);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `local-${first.toString(36)}-${second.toString(36)}-${serialized.length.toString(36)}`;
}

/**
 * @param {unknown} snapshot
 * @param {string} [revisionId]
 * @returns {EditorRevision}
 */
function revision(snapshot, revisionId) {
  const safeSnapshot = plainRecord(snapshot) ?? {};
  return {
    revisionId: revisionId || editorRevisionId(safeSnapshot),
    snapshot: safeSnapshot,
  };
}

/**
 * @param {unknown} snapshot
 * @param {{ revisionId?: string, baseRevision?: string, limit?: number }} [options]
 * @returns {RevisionHistory}
 */
export function createRevisionHistory(snapshot, options = {}) {
  const present = revision(snapshot, options.revisionId);
  const limit = Math.max(
    1,
    Math.min(250, Math.floor(options.limit ?? EDITOR_HISTORY_LIMIT)),
  );
  return {
    limit,
    past: [],
    present,
    future: [],
    baseRevision: options.baseRevision || present.revisionId,
  };
}

/**
 * @param {RevisionHistory} history
 * @param {unknown} snapshot
 * @param {{ revisionId?: string }} [options]
 * @returns {RevisionHistory}
 */
export function commitRevision(history, snapshot, options = {}) {
  const next = revision(snapshot, options.revisionId);
  if (stableJson(next.snapshot) === stableJson(history.present.snapshot)) {
    return history;
  }
  return {
    ...history,
    past: [...history.past, history.present].slice(-history.limit),
    present: next,
    future: [],
  };
}

/** @param {RevisionHistory} history @returns {RevisionHistory} */
export function undoRevision(history) {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    ...history,
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, history.limit),
  };
}

/** @param {RevisionHistory} history @returns {RevisionHistory} */
export function redoRevision(history) {
  const next = history.future[0];
  if (!next) return history;
  return {
    ...history,
    past: [...history.past, history.present].slice(-history.limit),
    present: next,
    future: history.future.slice(1),
  };
}

/**
 * Replace server-generated/editor-bootstrap content with a clean local base.
 * Bootstrap changes are not user commands and therefore do not belong in undo.
 *
 * @param {RevisionHistory} history
 * @param {unknown} snapshot
 * @returns {RevisionHistory}
 */
export function replaceRevisionBase(history, snapshot) {
  return createRevisionHistory(snapshot, { limit: history.limit });
}

/** @param {RevisionHistory} history @returns {RevisionHistory} */
export function markRevisionBase(history) {
  if (history.baseRevision === history.present.revisionId) return history;
  return { ...history, baseRevision: history.present.revisionId };
}

/** @param {RevisionHistory} history */
export function revisionHistoryDirty(history) {
  return history.present.revisionId !== history.baseRevision;
}

/** @param {unknown} value */
function normalizedRevision(value) {
  const record = plainRecord(value);
  if (!record || typeof record.revisionId !== "string") return null;
  const snapshot = plainRecord(record.snapshot);
  if (!snapshot) return null;
  return { revisionId: record.revisionId, snapshot };
}

/** @param {unknown} value */
function normalizedHistory(value) {
  const record = plainRecord(value);
  if (!record) return null;
  const present = normalizedRevision(record.present);
  if (!present) return null;
  const limit = Math.max(
    1,
    Math.min(
      250,
      Number.isFinite(record.limit)
        ? Math.floor(Number(record.limit))
        : EDITOR_HISTORY_LIMIT,
    ),
  );
  /** @param {unknown} items @returns {EditorRevision[]} */
  const normalizeList = (items) =>
    (Array.isArray(items) ? items : [])
      .map(normalizedRevision)
      .filter((item) => item !== null)
      .slice(-limit);
  return {
    limit,
    past: normalizeList(record.past),
    present,
    future: normalizeList(record.future),
    baseRevision:
      typeof record.baseRevision === "string"
        ? record.baseRevision
        : present.revisionId,
  };
}

const persistedJobKeys = new Set([
  "id",
  "captionQualityRevision",
  "status",
  "progress",
  "message",
  "alignment",
  "languageCode",
  "updatedAt",
  "expiresAt",
  "previewUrl",
  "downloadUrl",
  "assUrl",
]);

/** @param {unknown} value */
function normalizedJob(value) {
  const record = plainRecord(value);
  if (!record || typeof record.id !== "string") return null;
  /** @type {JsonRecord} */
  const result = {};
  for (const [key, item] of Object.entries(record)) {
    if (persistedJobKeys.has(key)) result[key] = item;
  }
  return result;
}

/** @param {unknown} value */
function normalizedMedia(value) {
  const record = plainRecord(value);
  if (!record || typeof record.name !== "string") return null;
  return {
    name: record.name.slice(0, 240),
    type: typeof record.type === "string" ? record.type.slice(0, 120) : "",
    size:
      Number.isFinite(record.size) && Number(record.size) >= 0
        ? Number(record.size)
        : 0,
    lastModified:
      Number.isFinite(record.lastModified) && Number(record.lastModified) >= 0
        ? Number(record.lastModified)
        : 0,
    durable: record.durable === true,
    duration:
      Number.isFinite(record.duration) && Number(record.duration) >= 0
        ? Number(record.duration)
        : 0,
    videoRatio:
      Number.isFinite(record.videoRatio) && Number(record.videoRatio) > 0
        ? Number(record.videoRatio)
        : 9 / 16,
  };
}

/** @param {unknown} value */
function normalizedView(value) {
  const record = plainRecord(value) ?? {};
  const captionDrafts = plainRecord(record.captionDrafts) ?? {};
  return {
    tab: ["review", "style", "export"].includes(String(record.tab))
      ? String(record.tab)
      : "review",
    selectedCaptionId:
      typeof record.selectedCaptionId === "string"
        ? record.selectedCaptionId
        : "",
    selectedWordIndex:
      Number.isInteger(record.selectedWordIndex) &&
      Number(record.selectedWordIndex) >= 0
        ? Number(record.selectedWordIndex)
        : 0,
    currentTime:
      Number.isFinite(record.currentTime) && Number(record.currentTime) >= 0
        ? Number(record.currentTime)
        : 0,
    captionDrafts: Object.fromEntries(
      Object.entries(captionDrafts).filter(
        ([key, item]) => key.length > 0 && typeof item === "string",
      ),
    ),
  };
}

/**
 * Construct a schema-versioned draft from runtime editor state. The input is
 * intentionally broader than the persisted result; normalization is the
 * boundary that keeps browser-only values out of storage.
 *
 * @param {{
 *   projectId?: string,
 *   savedAt: string,
 *   media?: unknown,
 *   job?: unknown,
 *   history: unknown,
 *   view?: unknown,
 * }} input
 */
export function createEditorDraft(input) {
  const history = normalizedHistory(input.history);
  if (!history) throw new TypeError("Editor draft history is invalid.");
  return {
    schemaVersion: EDITOR_DRAFT_SCHEMA_VERSION,
    projectId:
      typeof input.projectId === "string" && input.projectId
        ? input.projectId
        : "active",
    savedAt: input.savedAt,
    media: normalizedMedia(input.media),
    job: normalizedJob(input.job),
    history,
    view: normalizedView(input.view),
  };
}

/** @param {unknown} value */
function normalizedDraft(value) {
  const record = plainRecord(value);
  if (!record || record.schemaVersion !== EDITOR_DRAFT_SCHEMA_VERSION) {
    return null;
  }
  const history = normalizedHistory(record.history);
  if (!history || typeof record.savedAt !== "string") return null;
  return {
    schemaVersion: EDITOR_DRAFT_SCHEMA_VERSION,
    projectId:
      typeof record.projectId === "string" && record.projectId
        ? record.projectId
        : "active",
    savedAt: record.savedAt,
    media: normalizedMedia(record.media),
    job: normalizedJob(record.job),
    history,
    view: normalizedView(record.view),
  };
}

/** @param {unknown} draft */
export function serializeEditorDraft(draft) {
  const normalized = normalizedDraft(draft);
  if (!normalized) throw new TypeError("Editor draft is invalid.");
  return JSON.stringify(normalized);
}

/** @param {unknown} serialized */
export function parseEditorDraft(serialized) {
  try {
    const value =
      typeof serialized === "string" ? JSON.parse(serialized) : serialized;
    return normalizedDraft(value);
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, string>} [seed]
 */
export function createMemoryDraftAdapter(seed = {}) {
  const entries = new Map(Object.entries(seed));
  return {
    async getItem(/** @type {string} */ key) {
      return entries.get(key) ?? null;
    },
    async setItem(/** @type {string} */ key, /** @type {string} */ value) {
      entries.set(key, value);
    },
    async removeItem(/** @type {string} */ key) {
      entries.delete(key);
    },
    snapshot() {
      return Object.fromEntries(entries);
    },
  };
}

/** @param {Storage} storage */
export function createLocalStorageDraftAdapter(storage) {
  return {
    async getItem(/** @type {string} */ key) {
      return storage.getItem(key);
    },
    async setItem(/** @type {string} */ key, /** @type {string} */ value) {
      storage.setItem(key, value);
    },
    async removeItem(/** @type {string} */ key) {
      storage.removeItem(key);
    },
  };
}

/**
 * @param {IDBFactory} indexedDB
 * @param {{ databaseName?: string, storeName?: string }} [options]
 */
export function createIndexedDbDraftAdapter(indexedDB, options = {}) {
  const databaseName = options.databaseName ?? "syncword-editor";
  const storeName = options.storeName ?? "drafts";
  /** @type {Promise<IDBDatabase> | null} */
  let databasePromise = null;

  const openDatabase = () => {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
      request.onblocked = () => reject(new Error("IndexedDB open was blocked."));
    });
    return databasePromise;
  };

  return {
    async getItem(/** @type {string} */ key) {
      const database = await openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).get(key);
        request.onsuccess = () =>
          resolve(typeof request.result === "string" ? request.result : null);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed."));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("IndexedDB read aborted."));
      });
    },
    async setItem(/** @type {string} */ key, /** @type {string} */ value) {
      const database = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put(value, key);
        transaction.oncomplete = () => resolve(undefined);
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("IndexedDB write failed."));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("IndexedDB write aborted."));
      });
    },
    async removeItem(/** @type {string} */ key) {
      const database = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).delete(key);
        transaction.oncomplete = () => resolve(undefined);
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("IndexedDB delete failed."));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("IndexedDB delete aborted."));
      });
    },
  };
}

/** @param {string | null} value */
function savedAt(value) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const draft = parseEditorDraft(value);
  const timestamp = draft ? Date.parse(draft.savedAt) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

/**
 * @param {{
 *   primary?: { getItem(key: string): Promise<string | null>, setItem(key: string, value: string): Promise<void>, removeItem(key: string): Promise<void> } | null,
 *   fallback?: { getItem(key: string): Promise<string | null>, setItem(key: string, value: string): Promise<void>, removeItem(key: string): Promise<void> } | null,
 * }} adapters
 */
export function createResilientDraftStore({ primary = null, fallback = null }) {
  if (!primary && !fallback) {
    throw new TypeError("At least one editor draft adapter is required.");
  }
  return {
    async load(/** @type {string} */ key) {
      const results = await Promise.allSettled([
        primary?.getItem(key) ?? Promise.resolve(null),
        fallback?.getItem(key) ?? Promise.resolve(null),
      ]);
      const primaryValue = results[0].status === "fulfilled" ? results[0].value : null;
      const fallbackValue = results[1].status === "fulfilled" ? results[1].value : null;
      return savedAt(fallbackValue) > savedAt(primaryValue)
        ? fallbackValue
        : primaryValue ?? fallbackValue;
    },
    async save(/** @type {string} */ key, /** @type {string} */ value) {
      if (primary) {
        try {
          await primary.setItem(key, value);
          try {
            await fallback?.removeItem(key);
          } catch {
            // A stale fallback is harmless because load selects the newest copy.
          }
          return "primary";
        } catch {
          // Fall through to the synchronous-origin fallback.
        }
      }
      if (!fallback) throw new Error("Editor draft storage is unavailable.");
      await fallback.setItem(key, value);
      return "fallback";
    },
    async remove(/** @type {string} */ key) {
      const results = await Promise.allSettled(
        [primary, fallback]
          .filter((adapter) => adapter !== null)
          .map((adapter) => adapter.removeItem(key)),
      );
      if (results.length && results.every((result) => result.status === "rejected")) {
        throw new Error("Editor draft could not be removed.");
      }
    },
  };
}

/** @param {Window & typeof globalThis} browser */
export function createBrowserDraftStore(browser) {
  let primary = null;
  let fallback = null;
  try {
    if (browser.indexedDB) primary = createIndexedDbDraftAdapter(browser.indexedDB);
  } catch {
    primary = null;
  }
  try {
    if (browser.localStorage) fallback = createLocalStorageDraftAdapter(browser.localStorage);
  } catch {
    fallback = null;
  }
  return createResilientDraftStore({ primary, fallback });
}
