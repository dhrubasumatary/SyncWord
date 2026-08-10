"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  canHighlightGroup,
} from "../shared/caption-quality.mjs";
import { createLatestSeekController } from "../shared/preview-transport.mjs";
import { retimeCaption } from "../shared/caption-timing.mjs";
import {
  EDITOR_DRAFT_STORAGE_KEY,
  commitRevision,
  createBrowserDraftStore,
  createEditorDraft,
  createRevisionHistory,
  markRevisionBase,
  parseEditorDraft,
  redoRevision,
  replaceRevisionBase,
  revisionHistoryDirty,
  serializeEditorDraft,
  undoRevision,
} from "../shared/editor-draft.mjs";
import { CaptionTimeline } from "./components/CaptionTimeline";

type WordTiming = {
  id: string;
  text: string;
  start: number;
  end: number;
  confidence: number;
  highlightSafe?: boolean;
  highlightReason?: string;
  source:
    | "mms-fa"
    | "mms-fa-star"
    | "speech-window-review"
    | "acoustic-dp"
    | "grapheme-prior"
    | "manual";
};

type Caption = {
  id: string;
  start: number;
  end: number;
  text: string;
  language: "as" | "brx" | "mix";
  words: WordTiming[];
};

type CaptionStyle = {
  fontFamily: string;
  fontSize: number;
  textColor: string;
  highlightColor: string;
  backgroundColor: string;
  backgroundOpacity: number;
  outlineColor: string;
  outlineWidth: number;
  position: number;
  weight: "600" | "700" | "800";
  animation: "pop" | "fade" | "slide";
  wordsPerCard: number;
};

type AlignmentSummary = {
  method: string;
  totalWords: number;
  waveformAlignedWords: number;
  averageConfidence: number;
  needsReview: number;
  stableWords?: number;
  estimatedWords?: number;
  alignmentComplete?: boolean;
  recoveredWords?: number;
  surfaceWordsReplaced?: number;
  highlightSafeWords?: number;
  phraseTimedWords?: number;
  qualityScore?: number;
  transcriptRecoveryAttempted?: boolean;
  transcriptRecoverySelected?: boolean;
};

type JobStatus =
  | "queued"
  | "extracting"
  | "transcribing"
  | "ready"
  | "review_required"
  | "rendering"
  | "complete"
  | "failed"
  | "cancelled";

type JobResponse = {
  id: string;
  captionQualityRevision?: string;
  status: JobStatus;
  progress: number;
  message?: string;
  captions?: Caption[];
  alignment?: AlignmentSummary;
  updatedAt?: string;
  previewUrl?: string;
  downloadUrl?: string;
  assUrl?: string;
  expiresAt?: string;
  capabilityToken?: string;
  uploadUrl?: string;
  processUrl?: string;
};

type StudioTab = "review" | "style" | "export";
type EngineState = "offline" | "waking" | "online";
type TranscriptMode = "codemix" | "verbatim" | "transcribe";
type ReviewItem = {
  captionId: string;
  captionIndex: number;
  wordIndex: number;
  globalIndex: number;
  word: WordTiming;
};
type LoopRange = { start: number; end: number } | null;
type EditorDocument = {
  language: string;
  transcriptMode: TranscriptMode;
  captionStyle: CaptionStyle;
  activePresetName: string;
  captions: Caption[];
};
type MediaIdentity = {
  name: string;
  type: string;
  size: number;
  lastModified: number;
  durable: boolean;
};

const hostedRenderApi = "https://syncword-render-dhrub404.onrender.com";
const appRevision = "syncword-web-2026-08-07-v24";
const expectedCaptionQualityRevision = "perceptual-gate-v1";

const defaultStyle: CaptionStyle = {
  fontFamily: "Noto Sans Bengali",
  fontSize: 78,
  textColor: "#FFFFFF",
  highlightColor: "#CFFF47",
  backgroundColor: "#070806",
  backgroundOpacity: 76,
  outlineColor: "#070806",
  outlineWidth: 2,
  position: 74,
  weight: "800",
  animation: "pop",
  wordsPerCard: 4,
};

const presets: Array<{
  name: string;
  note: string;
  sample: string;
  values: Partial<CaptionStyle>;
}> = [
  {
    name: "Signal",
    note: "clean creator hit",
    sample: "NOW",
    values: {
      textColor: "#FFFFFF",
      highlightColor: "#CFFF47",
      backgroundColor: "#070806",
      backgroundOpacity: 76,
      outlineColor: "#070806",
      outlineWidth: 2,
      animation: "pop",
      wordsPerCard: 4,
    },
  },
  {
    name: "Impact",
    note: "hard social outline",
    sample: "LOUD",
    values: {
      textColor: "#FFFFFF",
      highlightColor: "#FF6D5D",
      backgroundColor: "#070806",
      backgroundOpacity: 0,
      outlineColor: "#070806",
      outlineWidth: 6,
      animation: "pop",
      wordsPerCard: 3,
    },
  },
  {
    name: "Electric",
    note: "cool blue motion",
    sample: "PLAY",
    values: {
      textColor: "#FFFFFF",
      highlightColor: "#70A7FF",
      backgroundColor: "#11192B",
      backgroundOpacity: 58,
      outlineColor: "#070B12",
      outlineWidth: 4,
      animation: "slide",
      wordsPerCard: 4,
    },
  },
];

const processingStatuses: JobStatus[] = [
  "queued",
  "extracting",
  "transcribing",
  "rendering",
];
const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function compactTime(seconds: number) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const wholeSeconds = Math.floor(safe % 60);
  return `${minutes}:${wholeSeconds.toString().padStart(2, "0")}`;
}

function preciseTime(seconds: number) {
  return `${Math.max(0, seconds).toFixed(2)}s`;
}

function rgba(hex: string, opacity: number) {
  const normalized = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  const numeric = Number.parseInt(normalized, 16);
  return `rgba(${(numeric >> 16) & 255}, ${(numeric >> 8) & 255}, ${
    numeric & 255
  }, ${opacity / 100})`;
}

function statusStep(status?: JobStatus) {
  if (!status || status === "queued") return 0;
  if (status === "extracting") return 1;
  if (status === "transcribing") return 2;
  if (status === "ready") return 3;
  if (status === "rendering") return 4;
  if (status === "complete") return 5;
  return 0;
}

function clientDelay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function getRenderHealth(apiBase: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${apiBase}/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as {
      ok?: boolean;
      captionQualityRevision?: string;
    };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

const cardBreakGapSeconds = 0.52;

function groupSpeechBurst(words: WordTiming[], maxWords: number) {
  if (words.length <= 2) return [words];
  const preferredMaximum = Math.max(2, Math.min(7, Math.round(maxWords)));
  const hardMaximum = Math.min(words.length, preferredMaximum + 1);
  const best = new Array(words.length + 1).fill(Number.POSITIVE_INFINITY);
  const parent = new Array(words.length + 1).fill(-1);
  best[0] = 0;
  const endsStrongPhrase = (text: string) =>
    /[.!?।॥…]["'”’)]*$/u.test(text.trim());

  const penalty = (start: number, end: number) => {
    const count = end - start;
    const slice = words.slice(start, end);
    const duration = slice.at(-1)!.end - slice[0].start;
    const glyphs = slice.reduce(
      (sum, word) => sum + Array.from(word.text).length,
      0,
    );
    let score = Math.abs(count - Math.min(preferredMaximum, 4)) * 2.2;
    if (count === 1 && words.length > 1) score += 1_000;
    if (count > preferredMaximum) {
      score += (count - preferredMaximum) ** 2 * 70;
    }
    if (duration > 2.8) score += (duration - 2.8) ** 2 * 18;
    if (glyphs > 30) score += (glyphs - 30) ** 2 * 0.35;
    if (words.length - end === 1) score += 800;
    if (endsStrongPhrase(slice.at(-1)!.text)) score -= 7;
    if (/[,:;—–-]$/u.test(slice.at(-1)!.text)) score -= 3;
    if (slice.slice(0, -1).some((word) => endsStrongPhrase(word.text))) {
      score += 24;
    }
    return score;
  };

  for (let end = 1; end <= words.length; end += 1) {
    for (
      let start = Math.max(0, end - hardMaximum);
      start < end;
      start += 1
    ) {
      if (!Number.isFinite(best[start])) continue;
      const candidate = best[start] + penalty(start, end);
      if (candidate < best[end]) {
        best[end] = candidate;
        parent[end] = start;
      }
    }
  }

  const groups: WordTiming[][] = [];
  for (let end = words.length; end > 0; ) {
    const start = parent[end];
    if (start < 0) return [words];
    groups.unshift(words.slice(start, end));
    end = start;
  }
  return groups;
}

function groupWordsForReels(words: WordTiming[], maxWords: number) {
  if (!words.length) return [];

  const bursts: WordTiming[][] = [];
  let burst: WordTiming[] = [];
  for (const word of words) {
    const previous = burst.at(-1);
    if (
      previous &&
      word.start - previous.end > cardBreakGapSeconds
    ) {
      bursts.push(burst);
      burst = [];
    }
    burst.push(word);
  }
  if (burst.length) bursts.push(burst);

  return bursts.flatMap((speechBurst) =>
    groupSpeechBurst(speechBurst, maxWords),
  );
}

function isAlignedCaption(value: unknown): value is Caption {
  if (!value || typeof value !== "object") return false;
  const caption = value as Partial<Caption>;
  return (
    typeof caption.id === "string" &&
    typeof caption.text === "string" &&
    Number.isFinite(caption.start) &&
    Number.isFinite(caption.end) &&
    Number(caption.end) > Number(caption.start) &&
    Array.isArray(caption.words) &&
    caption.words.length > 0 &&
    caption.words.every(
      (word) =>
        word &&
        typeof word.text === "string" &&
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.end > word.start,
    )
  );
}

function isReviewCandidate(word: WordTiming) {
  return word.highlightReason === "invalid_boundary";
}

function normalizeRestoredStyle(value: unknown): CaptionStyle {
  const style = value && typeof value === "object"
    ? (value as Partial<CaptionStyle>)
    : {};
  return {
    fontFamily:
      typeof style.fontFamily === "string"
        ? style.fontFamily
        : defaultStyle.fontFamily,
    fontSize: Number.isFinite(style.fontSize)
      ? clamp(Number(style.fontSize), 28, 160)
      : defaultStyle.fontSize,
    textColor:
      typeof style.textColor === "string"
        ? style.textColor
        : defaultStyle.textColor,
    highlightColor:
      typeof style.highlightColor === "string"
        ? style.highlightColor
        : defaultStyle.highlightColor,
    backgroundColor:
      typeof style.backgroundColor === "string"
        ? style.backgroundColor
        : defaultStyle.backgroundColor,
    backgroundOpacity: Number.isFinite(style.backgroundOpacity)
      ? clamp(Number(style.backgroundOpacity), 0, 100)
      : defaultStyle.backgroundOpacity,
    outlineColor:
      typeof style.outlineColor === "string"
        ? style.outlineColor
        : defaultStyle.outlineColor,
    outlineWidth: Number.isFinite(style.outlineWidth)
      ? clamp(Number(style.outlineWidth), 0, 12)
      : defaultStyle.outlineWidth,
    position: Number.isFinite(style.position)
      ? clamp(Number(style.position), 8, 94)
      : defaultStyle.position,
    weight: ["600", "700", "800"].includes(String(style.weight))
      ? (String(style.weight) as CaptionStyle["weight"])
      : defaultStyle.weight,
    animation: ["pop", "fade", "slide"].includes(String(style.animation))
      ? (String(style.animation) as CaptionStyle["animation"])
      : defaultStyle.animation,
    wordsPerCard: Number.isFinite(style.wordsPerCard)
      ? clamp(Math.round(Number(style.wordsPerCard)), 2, 7)
      : defaultStyle.wordsPerCard,
  };
}

function normalizeEditorDocument(value: unknown): EditorDocument | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<EditorDocument>;
  const captions = Array.isArray(record.captions) &&
    record.captions.every(isAlignedCaption)
    ? record.captions
    : [];
  const transcriptMode = ["codemix", "verbatim", "transcribe"].includes(
    String(record.transcriptMode),
  )
    ? (String(record.transcriptMode) as TranscriptMode)
    : "codemix";
  return {
    language:
      typeof record.language === "string" ? record.language : "unknown",
    transcriptMode,
    captionStyle: normalizeRestoredStyle(record.captionStyle),
    activePresetName:
      typeof record.activePresetName === "string"
        ? record.activePresetName
        : "Signal",
    captions,
  };
}

function normalizeRestoredJob(
  value: unknown,
  captions: Caption[],
): JobResponse | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<JobResponse>;
  const statuses: JobStatus[] = [
    "queued",
    "extracting",
    "transcribing",
    "ready",
    "review_required",
    "rendering",
    "complete",
    "failed",
    "cancelled",
  ];
  if (
    typeof record.id !== "string" ||
    !statuses.includes(record.status as JobStatus)
  ) {
    return null;
  }
  return {
    ...record,
    id: record.id,
    status: record.status as JobStatus,
    progress: Number.isFinite(record.progress) ? Number(record.progress) : 0,
    captions,
  };
}

export default function Home() {
  const [tab, setTab] = useState<StudioTab>("review");
  const [file, setFile] = useState<File | null>(null);
  const [mediaIdentity, setMediaIdentity] =
    useState<MediaIdentity | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [duration, setDuration] = useState(0);
  const [videoRatio, setVideoRatio] = useState(9 / 16);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [language, setLanguage] = useState("unknown");
  const [transcriptMode, setTranscriptMode] =
    useState<TranscriptMode>("codemix");
  const [captionStyle, setCaptionStyle] = useState(defaultStyle);
  const [activePresetName, setActivePresetName] = useState("Signal");
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [selectedCaptionId, setSelectedCaptionId] = useState("");
  const [selectedWordIndex, setSelectedWordIndex] = useState(0);
  const [loopRange, setLoopRange] = useState<LoopRange>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [engineState, setEngineState] =
    useState<EngineState>("offline");
  const [hasChanges, setHasChanges] = useState(false);
  const [updateRequired, setUpdateRequired] = useState(false);
  const [toast, setToast] = useState("");
  const [captionDrafts, setCaptionDrafts] = useState<
    Record<string, string>
  >({});
  const [revisionHistoryVersion, setRevisionHistoryVersion] = useState(0);
  const [historyControls, setHistoryControls] = useState({
    canUndo: false,
    canRedo: false,
  });
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientSnapshot,
    serverSnapshot,
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const seekControllerRef = useRef<ReturnType<
    typeof createLatestSeekController
  > | null>(null);
  const loopRangeRef = useRef<LoopRange>(null);
  const revisionHistoryRef = useRef(
    createRevisionHistory({
      language: "unknown",
      transcriptMode: "codemix",
      captionStyle: defaultStyle,
      activePresetName: "Signal",
      captions: [],
    }),
  );
  const draftStoreRef = useRef<ReturnType<
    typeof createBrowserDraftStore
  > | null>(null);
  const draftReadyRef = useRef(false);
  const suppressHistoryTrackingRef = useRef(false);

  const configuredApi =
    process.env.NEXT_PUBLIC_RENDER_API_URL?.replace(/\/$/, "") ?? "";
  const isLocalBrowser =
    hydrated &&
    ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const apiBase =
    configuredApi ||
    (hydrated
      ? isLocalBrowser
        ? "http://localhost:8787"
        : hostedRenderApi
      : "");
  const usingDurableMedia = hydrated && !configuredApi && !isLocalBrowser;
  const jobsBase = usingDurableMedia ? "" : apiBase;
  const jobRoute = (jobId: string) =>
    usingDurableMedia
      ? `/api/media/jobs/${jobId}`
      : `/v1/jobs/${jobId}`;
  const hasProject = Boolean(file || mediaIdentity || job);
  const mediaName = file?.name ?? mediaIdentity?.name ?? "Recovered project";
  const draftNeedsAuthorization = Boolean(
    mediaIdentity?.durable && job && !job.capabilityToken,
  );
  const isProcessing = Boolean(
    uploading || (job && processingStatuses.includes(job.status)),
  );
  const isFinal = job?.status === "complete" && Boolean(job.previewUrl);
  const showingFinal = isFinal && !hasChanges;
  const finalVideoUrl =
    showingFinal && job?.previewUrl
      ? `${jobsBase}${job.previewUrl}?v=${encodeURIComponent(
          job.updatedAt ?? "",
        )}`
      : "";
  const playbackUrl = finalVideoUrl || videoUrl;
  const selectedCaption =
    captions.find((caption) => caption.id === selectedCaptionId) ?? captions[0];
  const captionDraft = selectedCaption
    ? (captionDrafts[selectedCaption.id] ?? selectedCaption.text)
    : "";
  const selectedWords = selectedCaption?.words ?? [];
  const selectedWord = selectedWords[selectedWordIndex];
  let globalWordIndex = 0;
  const flatWords: ReviewItem[] = captions.flatMap((caption, captionIndex) =>
    caption.words.map((word, wordIndex) => ({
      captionId: caption.id,
      captionIndex,
      wordIndex,
      globalIndex: globalWordIndex++,
      word,
    })),
  );
  const selectedItem = flatWords.find(
    (item) =>
      item.captionId === selectedCaption?.id &&
      item.wordIndex === selectedWordIndex,
  );
  const activeCaption = captions.find(
    (caption) =>
      currentTime >= caption.start && currentTime < caption.end,
  );
  const activeWords = activeCaption?.words ?? [];
  const activeGroups = groupWordsForReels(
    activeWords,
    captionStyle.wordsPerCard,
  );
  const activeWordGroup = activeCaption
    ? activeGroups.find(
        (group) =>
          currentTime >= group[0].start &&
          currentTime < group[group.length - 1].end,
      ) ?? []
    : [];
  const activeGroupUsesWordSync = canHighlightGroup(activeWordGroup);
  const activeWord = activeGroupUsesWordSync
    ? activeWordGroup.find((word, index) => {
        const displayEnd =
          activeWordGroup[index + 1]?.start ?? word.end;
        return currentTime >= word.start && currentTime < displayEnd;
      })
    : undefined;
  const selectedGlobalIndex = selectedItem?.globalIndex ?? -1;
  const previousGlobalWord =
    selectedGlobalIndex > 0 ? flatWords[selectedGlobalIndex - 1]?.word : null;
  const nextGlobalWord =
    selectedGlobalIndex >= 0
      ? flatWords[selectedGlobalIndex + 1]?.word ?? null
      : null;
  const isLooping = Boolean(loopRange);
  const editorDocument = useMemo<EditorDocument>(
    () => ({
      language,
      transcriptMode,
      captionStyle,
      activePresetName,
      captions,
    }),
    [
      activePresetName,
      captionStyle,
      captions,
      language,
      transcriptMode,
    ],
  );
  const applyEditorDocument = useCallback((document: EditorDocument) => {
    suppressHistoryTrackingRef.current = true;
    setLanguage(document.language);
    setTranscriptMode(document.transcriptMode);
    setCaptionStyle(document.captionStyle);
    setActivePresetName(document.activePresetName);
    setCaptions(document.captions);
  }, []);
  const publishRevisionHistory = useCallback(
    (history: ReturnType<typeof createRevisionHistory>) => {
      revisionHistoryRef.current = history;
      setHistoryControls({
        canUndo: history.past.length > 0,
        canRedo: history.future.length > 0,
      });
      setRevisionHistoryVersion((version) => version + 1);
    },
    [],
  );
  const canUndo = historyControls.canUndo;
  const canRedo = historyControls.canRedo;

  const previewStyle = {
    "--caption-font-size": `${captionStyle.fontSize}px`,
    "--caption-color": captionStyle.textColor,
    "--highlight-color": captionStyle.highlightColor,
    "--caption-background": rgba(
      captionStyle.backgroundColor,
      captionStyle.backgroundOpacity,
    ),
    "--caption-position": `${captionStyle.position}%`,
    "--caption-weight": captionStyle.weight,
    "--caption-outline": `${captionStyle.outlineWidth}px`,
    "--caption-outline-color": captionStyle.outlineColor,
    "--caption-font":
      captionStyle.fontFamily === "Noto Sans Devanagari"
        ? '"Noto Sans Devanagari", "Nirmala UI", sans-serif'
        : '"Noto Sans Bengali", "Nirmala UI", sans-serif',
  } as CSSProperties;

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    draftReadyRef.current = false;
    void (async () => {
      try {
        const store = createBrowserDraftStore(window);
        draftStoreRef.current = store;
        const serialized = await store.load(EDITOR_DRAFT_STORAGE_KEY);
        if (!active || !serialized) return;
        const draft = parseEditorDraft(serialized);
        const restoredDocument = normalizeEditorDocument(
          draft?.history.present.snapshot,
        );
        if (!draft || !restoredDocument) return;

        const restoredJob = normalizeRestoredJob(
          draft.job,
          restoredDocument.captions,
        );
        applyEditorDocument(restoredDocument);
        publishRevisionHistory(draft.history);
        setHasChanges(revisionHistoryDirty(draft.history));
        setMediaIdentity(
          draft.media
            ? {
                name: draft.media.name,
                type: draft.media.type,
                size: draft.media.size,
                lastModified: draft.media.lastModified,
                durable: draft.media.durable,
              }
            : null,
        );
        setDuration(draft.media?.duration ?? 0);
        setVideoRatio(draft.media?.videoRatio ?? 9 / 16);
        setTab(draft.view.tab as StudioTab);
        setSelectedCaptionId(
          draft.view.selectedCaptionId ||
            restoredDocument.captions[0]?.id ||
            "",
        );
        setSelectedWordIndex(draft.view.selectedWordIndex);
        setCurrentTime(draft.view.currentTime);
        setCaptionDrafts(
          draft.view.captionDrafts as Record<string, string>,
        );
        setJob(restoredJob);
        draftReadyRef.current = true;

        if (restoredJob?.status === "review_required") {
          setTab("review");
          setToast(
            restoredJob.message ??
              "Draft restored. Some speech still needs caption review.",
          );
        } else {
          setToast("Your last caption draft was restored.");
        }

      } catch {
        // IndexedDB can be unavailable in hardened browsing modes. The store
        // already tries localStorage; failure here must not block the editor.
      } finally {
        if (active) draftReadyRef.current = true;
      }
    })();
    return () => {
      active = false;
    };
  }, [applyEditorDocument, hydrated, publishRevisionHistory]);

  useEffect(() => {
    if (!draftReadyRef.current) return;
    if (suppressHistoryTrackingRef.current) {
      suppressHistoryTrackingRef.current = false;
      return;
    }
    const current = revisionHistoryRef.current;
    let next;
    if (hasChanges) {
      next = commitRevision(current, editorDocument);
    } else {
      const candidate = commitRevision(current, editorDocument);
      next = candidate === current
        ? markRevisionBase(current)
        : replaceRevisionBase(current, editorDocument);
    }
    if (next !== current) publishRevisionHistory(next);
  }, [editorDocument, hasChanges, publishRevisionHistory]);

  useEffect(() => {
    if (
      !draftReadyRef.current ||
      !draftStoreRef.current ||
      (!mediaIdentity && !job)
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      try {
        const draft = createEditorDraft({
          projectId: job?.id ?? "active",
          savedAt: new Date().toISOString(),
          media: mediaIdentity
            ? { ...mediaIdentity, duration, videoRatio }
            : null,
          job,
          history: revisionHistoryRef.current,
          view: {
            tab,
            selectedCaptionId,
            selectedWordIndex,
            currentTime,
            captionDrafts,
          },
        });
        void draftStoreRef.current?.save(
          EDITOR_DRAFT_STORAGE_KEY,
          serializeEditorDraft(draft),
        );
      } catch {
        // Persistence is best-effort and never interrupts active editing.
      }
    }, 320);
    return () => window.clearTimeout(timeout);
  }, [
    captionDrafts,
    currentTime,
    duration,
    job,
    mediaIdentity,
    revisionHistoryVersion,
    selectedCaptionId,
    selectedWordIndex,
    tab,
    videoRatio,
  ]);

  useEffect(
    () => () => {
      if (videoUrl.startsWith("blob:")) URL.revokeObjectURL(videoUrl);
    },
    [videoUrl],
  );

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    loopRangeRef.current = loopRange;
  }, [loopRange]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playbackUrl) return;

    const seekController = createLatestSeekController(video);
    seekControllerRef.current = seekController;
    let stopped = false;
    let videoFrameId: number | null = null;
    let animationFrameId: number | null = null;

    const cancelClock = () => {
      if (videoFrameId !== null) {
        video.cancelVideoFrameCallback(videoFrameId);
        videoFrameId = null;
      }
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    };

    const syncClock = (time: number, enforceLoop = true) => {
      if (!Number.isFinite(time)) return;
      const activeLoop = loopRangeRef.current;
      if (enforceLoop && activeLoop && time >= activeLoop.end) {
        seekController.jump(activeLoop.start);
        setCurrentTime(activeLoop.start);
        if (video.paused) void video.play();
        return;
      }
      setCurrentTime((current) =>
        Math.abs(current - time) >= 0.004 ? time : current,
      );
    };

    const onVideoFrame: VideoFrameRequestCallback = (_now, metadata) => {
      syncClock(metadata.mediaTime);
      if (!stopped && !video.paused) {
        videoFrameId = video.requestVideoFrameCallback(onVideoFrame);
      }
    };

    const onAnimationFrame = () => {
      syncClock(video.currentTime);
      if (!stopped && !video.paused) {
        animationFrameId = window.requestAnimationFrame(onAnimationFrame);
      }
    };

    const startClock = () => {
      cancelClock();
      if (typeof video.requestVideoFrameCallback === "function") {
        videoFrameId = video.requestVideoFrameCallback(onVideoFrame);
      } else {
        animationFrameId = window.requestAnimationFrame(onAnimationFrame);
      }
    };

    const settleClock = () => {
      cancelClock();
      syncClock(video.currentTime, false);
    };

    const resumeClockAfterSeek = () => {
      syncClock(video.currentTime, !video.paused);
      if (!video.paused) startClock();
    };

    video.addEventListener("play", startClock);
    video.addEventListener("pause", settleClock);
    video.addEventListener("seeked", resumeClockAfterSeek);
    if (!video.paused) startClock();

    return () => {
      stopped = true;
      cancelClock();
      seekController.dispose();
      if (seekControllerRef.current === seekController) {
        seekControllerRef.current = null;
      }
      video.removeEventListener("play", startClock);
      video.removeEventListener("pause", settleClock);
      video.removeEventListener("seeked", resumeClockAfterSeek);
    };
  }, [playbackUrl]);

  useEffect(() => {
    let active = true;
    const checkRevision = async () => {
      try {
        const response = await fetch(
          `/revision.json?check=${Date.now()}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const payload = (await response.json()) as { revision?: string };
        if (
          active &&
          payload.revision &&
          payload.revision !== appRevision
        ) {
          setUpdateRequired(true);
        }
      } catch {
        // A temporary version-check failure should never block editing.
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void checkRevision();
    };
    void checkRevision();
    const interval = window.setInterval(checkRevision, 45_000);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!apiBase) {
      return () => {
        active = false;
      };
    }
    void (async () => {
      if (active) setEngineState("waking");
      for (let attempt = 0; attempt < 18 && active; attempt += 1) {
        const health = await getRenderHealth(apiBase);
        if (health?.ok) {
          if (
            health.captionQualityRevision &&
            health.captionQualityRevision !==
              expectedCaptionQualityRevision
          ) {
            if (active) {
              setUpdateRequired(true);
              setEngineState("offline");
            }
            return;
          }
          if (active) setEngineState("online");
          return;
        }
        await clientDelay(4_000);
      }
      if (active) setEngineState("offline");
    })();
    return () => {
      active = false;
    };
  }, [apiBase]);

  useEffect(() => {
    if (
      !job ||
      (!usingDurableMedia && !apiBase) ||
      ["ready", "review_required", "complete", "failed", "cancelled"].includes(
        job.status,
      )
    ) {
      return;
    }
    const jobId = job.id;
    const pollingRoute = usingDurableMedia
      ? `/api/media/jobs/${jobId}`
      : `/v1/jobs/${jobId}`;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`${jobsBase}${pollingRoute}`, {
          cache: "no-store",
        });
        if (response.status === 404) {
          const failedJob: JobResponse = {
            ...job,
            status: "failed",
            progress: job.progress,
            message: usingDurableMedia
              ? "This temporary project expired. Upload it again to rebuild."
              : "The free processing engine restarted. Tap Try again.",
          };
          setJob(failedJob);
          setToast(failedJob.message ?? "Processing restarted.");
          return;
        }
        if (!response.ok) return;
        setEngineState("online");
        const next = (await response.json()) as JobResponse;
        if (
          next.captionQualityRevision &&
          next.captionQualityRevision !==
            expectedCaptionQualityRevision
        ) {
          setUpdateRequired(true);
          setToast("SyncWord was updated. Reload before continuing.");
          return;
        }
        setJob((current) => ({
          ...next,
          capabilityToken: current?.capabilityToken,
        }));
        const nextCaptions =
          Array.isArray(next.captions) &&
          next.captions.every(isAlignedCaption)
            ? next.captions
            : [];
        if (nextCaptions.length) {
          setCaptions((current) =>
            current.length && next.status === "rendering"
              ? current
              : nextCaptions,
          );
          if (!selectedCaptionId) {
            const firstFlag = nextCaptions
              .flatMap((caption, captionIndex) =>
                caption.words.map((word, wordIndex) => ({
                  caption,
                  captionIndex,
                  word,
                  wordIndex,
                })),
              )
              .find((item) => isReviewCandidate(item.word));
            setSelectedCaptionId(
              firstFlag?.caption.id ?? nextCaptions[0].id,
            );
            setSelectedWordIndex(firstFlag?.wordIndex ?? 0);
          }
        }
        if (next.status === "ready") {
          setTab("review");
          setToast("Captions ready. Play through and edit anything.");
        } else if (next.status === "review_required") {
          setTab("review");
          setToast(
            next.message ??
              "Some speech is still missing captions and needs review.",
          );
        } else if (next.status === "complete") {
          setTab("export");
          setToast("Your final video is ready to download.");
        } else if (["failed", "cancelled"].includes(next.status)) {
          setToast(next.message ?? "Processing failed.");
        }
      } catch {
        setEngineState("waking");
      }
    }, 2000);
    return () => window.clearInterval(interval);
  }, [
    apiBase,
    job,
    jobsBase,
    selectedCaptionId,
    usingDurableMedia,
  ]);

  const uploadVideo = async (nextFile: File) => {
    if (updateRequired) {
      setToast("Reload SyncWord before uploading another video.");
      return;
    }
    if (!apiBase) {
      setToast("The processing engine is not connected yet.");
      return;
    }
    setUploading(true);
    try {
      setEngineState("waking");
      setToast("Waking the hobby engine. First use can take a minute.");
      let engineReady = false;
      for (let attempt = 0; attempt < 18; attempt += 1) {
        const health = await getRenderHealth(apiBase);
        if (
          health?.ok &&
          health.captionQualityRevision ===
            expectedCaptionQualityRevision
        ) {
          engineReady = true;
          setEngineState("online");
          break;
        }
        await clientDelay(4_000);
      }
      if (!engineReady) {
        throw new Error(
          "The free engine is still waking. Try again in a moment.",
        );
      }

      let data: JobResponse & { error?: string };
      if (usingDurableMedia) {
        const createResponse = await fetch("/api/media/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            originalName: nextFile.name,
            contentType: nextFile.type || "video/mp4",
            size: nextFile.size,
            language,
            mode: transcriptMode,
            style: captionStyle,
          }),
        });
        data = (await createResponse.json()) as JobResponse & {
          error?: string;
        };
        if (!createResponse.ok) {
          throw new Error(data.error ?? "Could not create the upload.");
        }
        if (!data.capabilityToken || !data.uploadUrl || !data.processUrl) {
          throw new Error("Durable upload capability is incomplete.");
        }
        setJob(data);
        setToast("Saving your original video securely.");
        const uploadResponse = await fetch(data.uploadUrl, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${data.capabilityToken}`,
            "content-type": nextFile.type || "video/mp4",
          },
          body: nextFile,
        });
        const uploaded = (await uploadResponse.json()) as JobResponse & {
          error?: string;
        };
        if (!uploadResponse.ok) {
          throw new Error(uploaded.error ?? "Video upload failed.");
        }
        setJob({ ...uploaded, capabilityToken: data.capabilityToken });
        const processResponse = await fetch(data.processUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${data.capabilityToken}`,
          },
        });
        const processing = (await processResponse.json()) as JobResponse & {
          error?: string;
        };
        if (!processResponse.ok) {
          throw new Error(processing.error ?? "Processing could not start.");
        }
        data = { ...processing, capabilityToken: data.capabilityToken };
      } else {
        const payload = new FormData();
        payload.append("video", nextFile);
        payload.append("language", language);
        payload.append("mode", transcriptMode);
        payload.append("style", JSON.stringify(captionStyle));
        const response = await fetch(`${apiBase}/v1/jobs`, {
          method: "POST",
          body: payload,
        });
        data = (await response.json()) as JobResponse & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Upload failed.");
      }
      if (
        data.captionQualityRevision &&
        data.captionQualityRevision !== expectedCaptionQualityRevision
      ) {
        setUpdateRequired(true);
        throw new Error("SyncWord was updated. Reload and upload again.");
      }
      setJob(data);
      setToast("Upload complete. Creating editable captions.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const cancelRemoteJob = async (jobToCancel = job) => {
    if (
      !jobToCancel ||
      (!usingDurableMedia && !apiBase) ||
      !processingStatuses.includes(jobToCancel.status)
    ) {
      return;
    }
    try {
      const response = await fetch(`${jobsBase}${jobRoute(jobToCancel.id)}`, {
        method: "DELETE",
        headers:
          usingDurableMedia && jobToCancel.capabilityToken
            ? {
                authorization: `Bearer ${jobToCancel.capabilityToken}`,
              }
            : undefined,
      });
      if (!response.ok && response.status !== 404) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Could not cancel processing.");
      }
    } catch (error) {
      setToast(
        error instanceof Error
          ? error.message
          : "Could not cancel processing.",
      );
    }
  };

  const clearProject = () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    suppressHistoryTrackingRef.current = true;
    publishRevisionHistory(
      createRevisionHistory({
        ...editorDocument,
        activePresetName: "Signal",
        captions: [],
      }),
    );
    void draftStoreRef.current?.remove(EDITOR_DRAFT_STORAGE_KEY);
    setFile(null);
    setMediaIdentity(null);
    setVideoUrl("");
    setDuration(0);
    setVideoRatio(9 / 16);
    setCurrentTime(0);
    setCaptions([]);
    setSelectedCaptionId("");
    setSelectedWordIndex(0);
    setCaptionDrafts({});
    setLoopRange(null);
    setJob(null);
    setHasChanges(false);
    setActivePresetName("Signal");
    setTab("review");
  };

  const cancelProcessing = () => {
    const jobToCancel = job;
    clearProject();
    void cancelRemoteJob(jobToCancel);
    setToast("Processing cancelled. The queue slot is free.");
  };

  const acceptVideo = async (nextFile: File) => {
    if (updateRequired) {
      setToast("Reload SyncWord before uploading another video.");
      return;
    }
    const looksLikeVideo =
      nextFile.type.startsWith("video/") ||
      /\.(mp4|mov|webm|mkv|m4v)$/i.test(nextFile.name);
    if (!looksLikeVideo) {
      setToast("Choose an MP4, MOV, WebM, MKV, or M4V video.");
      return;
    }
    if (nextFile.size > 90 * 1024 * 1024) {
      setToast("Keep the reel under 90 MB for this MVP.");
      return;
    }
    const previousJob = job;
    await cancelRemoteJob(previousJob);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const localUrl = URL.createObjectURL(nextFile);
    suppressHistoryTrackingRef.current = true;
    publishRevisionHistory(
      createRevisionHistory({
        ...editorDocument,
        activePresetName: "Signal",
        captions: [],
      }),
    );
    void draftStoreRef.current?.remove(EDITOR_DRAFT_STORAGE_KEY);
    setFile(nextFile);
    setMediaIdentity({
      name: nextFile.name,
      type: nextFile.type,
      size: nextFile.size,
      lastModified: nextFile.lastModified,
      durable: usingDurableMedia,
    });
    setVideoUrl(localUrl);
    setDuration(0);
    setVideoRatio(9 / 16);
    setCurrentTime(0);
    setCaptions([]);
    setSelectedCaptionId("");
    setSelectedWordIndex(0);
    setCaptionDrafts({});
    setLoopRange(null);
    setJob(null);
    setHasChanges(false);
    setActivePresetName("Signal");
    setTab("review");
    void uploadVideo(nextFile);
  };

  const mediaTime = (seconds: number) =>
    Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds);

  const jumpTo = (seconds: number) => {
    const next = mediaTime(seconds);
    setCurrentTime(next);
    const video = videoRef.current;
    if (!video) return;
    if (seekControllerRef.current) {
      seekControllerRef.current.jump(next);
    } else {
      video.currentTime = next;
    }
  };

  const previewAt = (seconds: number) => {
    const next = mediaTime(seconds);
    setCurrentTime(next);
    const video = videoRef.current;
    if (!video) return;
    if (seekControllerRef.current) {
      seekControllerRef.current.preview(next);
    } else {
      video.currentTime = next;
    }
  };

  const selectReviewItem = (item: ReviewItem, shouldLoop = false) => {
    setSelectedCaptionId(item.captionId);
    setSelectedWordIndex(item.wordIndex);
    setLoopRange(null);
    const start = Math.max(0, item.word.start - 0.12);
    if (videoRef.current) {
      videoRef.current.pause();
    }
    jumpTo(start);
    if (shouldLoop) {
      window.setTimeout(() => {
        const range = {
          start: Math.max(0, item.word.start - 0.48),
          end: Math.min(duration, item.word.end + 0.48),
        };
        loopRangeRef.current = range;
        setLoopRange(range);
        if (videoRef.current) {
          jumpTo(range.start);
          void videoRef.current.play();
        }
      }, 40);
    }
  };

  const updateCaptionWords = (
    captionId: string,
    transform: (words: WordTiming[]) => WordTiming[],
  ) => {
    setCaptions((items) =>
      items.map((caption) => {
        if (caption.id !== captionId) return caption;
        const words = transform(caption.words.map((word) => ({ ...word })));
        return {
          ...caption,
          text: words.map((word) => word.text).join(" "),
          start: words[0]?.start ?? caption.start,
          end: words.at(-1)?.end ?? caption.end,
          words,
        };
      }),
    );
    setHasChanges(true);
  };

  const updateCaptionTiming = (
    captionId: string,
    requestedStart: number,
    requestedEnd: number,
  ) => {
    const captionIndex = captions.findIndex(
      (caption) => caption.id === captionId,
    );
    const target = captions[captionIndex];
    if (!target?.words.length) return;

    const previousEnd = captions[captionIndex - 1]?.end ?? 0;
    const followingStart =
      captions[captionIndex + 1]?.start ?? Math.max(duration, requestedEnd);
    const updatedCaption = retimeCaption(
      target,
      requestedStart,
      requestedEnd,
      previousEnd,
      followingStart,
    ) as Caption;

    setCaptions((items) =>
      items.map((caption) =>
        caption.id === captionId ? updatedCaption : caption,
      ),
    );
    setHasChanges(true);
    setToast("Caption timing updated.");
    seek(updatedCaption.start);
  };

  const finishSelectedCaption = () => {
    if (!selectedCaption) return;
    const captionIndex = captions.findIndex(
      (caption) => caption.id === selectedCaption.id,
    );
    const nextCaption = captions[captionIndex + 1];
    setLoopRange(null);
    if (!nextCaption) {
      videoRef.current?.pause();
      setTab("style");
      setToast("Captions saved. Pick a look.");
      return;
    }
    setSelectedCaptionId(nextCaption.id);
    setSelectedWordIndex(0);
    seek(nextCaption.start);
  };

  const updateSelectedWordText = (text: string) => {
    if (!selectedCaption || !selectedWord) return;
    if (!text.trim()) {
      setToast("A timed word cannot be empty.");
      return;
    }
    if (/\s/u.test(text)) {
      setToast("Edit one word at a time so its timing stays intact.");
      return;
    }
    updateCaptionWords(selectedCaption.id, (words) => {
      words[selectedWordIndex] = {
        ...words[selectedWordIndex],
        text,
        confidence: 1,
        source: "manual",
      };
      return words;
    });
  };

  const commitCaptionDraft = () => {
    if (!selectedCaption) return;
    const normalized = captionDraft.trim().replace(/\s+/gu, " ");
    if (!normalized) {
      setCaptionDrafts((current) => ({
        ...current,
        [selectedCaption.id]: selectedCaption.text,
      }));
      setToast("A caption cannot be empty.");
      return;
    }
    if (normalized === selectedCaption.text) {
      setCaptionDrafts((current) => {
        const next = { ...current };
        delete next[selectedCaption.id];
        return next;
      });
      return;
    }

    const tokens = normalized.split(" ");
    const sameWordCount = tokens.length === selectedCaption.words.length;
    const captionDuration = Math.max(
      0.12,
      selectedCaption.end - selectedCaption.start,
    );
    const weights = tokens.map((token) =>
      Math.max(1, Array.from(token.replace(/[^\p{L}\p{N}]/gu, "")).length),
    );
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = selectedCaption.start;
    const editStamp = Date.now().toString(36);

    updateCaptionWords(selectedCaption.id, (words) =>
      tokens.map((token, index) => {
        if (sameWordCount) {
          return {
            ...words[index],
            text: token,
            confidence: 1,
            source: "manual",
          };
        }
        const start = cursor;
        const share = (weights[index] / totalWeight) * captionDuration;
        cursor =
          index === tokens.length - 1
            ? selectedCaption.end
            : Math.min(selectedCaption.end, cursor + share);
        return {
          id: `${selectedCaption.id}-edit-${editStamp}-${index}`,
          text: token,
          start: Number(start.toFixed(4)),
          end: Number(cursor.toFixed(4)),
          confidence: 0.2,
          source: "grapheme-prior",
        };
      }),
    );
    setCaptionDrafts((current) => {
      const next = { ...current };
      delete next[selectedCaption.id];
      return next;
    });
    setSelectedWordIndex((current) =>
      Math.min(current, Math.max(0, tokens.length - 1)),
    );
    setToast(
      sameWordCount
        ? "Caption text updated. Word timing stayed intact."
        : "Caption updated. Play the line once to check its new word timing.",
    );
  };

  const adjustSelectedEdge = (
    edge: "start" | "end",
    delta: number,
  ) => {
    if (!selectedCaption || !selectedWord) return;
    const minimumStart = previousGlobalWord?.end ?? 0;
    const maximumEnd = nextGlobalWord?.start ?? Math.max(duration, selectedWord.end);
    updateCaptionWords(selectedCaption.id, (words) => {
      const word = words[selectedWordIndex];
      if (edge === "start") {
        word.start = Number(
          clamp(
            word.start + delta,
            minimumStart,
            word.end - 0.08,
          ).toFixed(3),
        );
      } else {
        word.end = Number(
          clamp(
            word.end + delta,
            word.start + 0.08,
            maximumEnd,
          ).toFixed(3),
        );
      }
      word.confidence = 1;
      word.source = "manual";
      return words;
    });
  };

  const shiftSelectedWord = (delta: number) => {
    if (!selectedCaption || !selectedWord) return;
    const wordDuration = selectedWord.end - selectedWord.start;
    const minimumStart = previousGlobalWord?.end ?? 0;
    const maximumEnd = nextGlobalWord?.start ?? Math.max(duration, selectedWord.end);
    const nextStart = clamp(
      selectedWord.start + delta,
      minimumStart,
      maximumEnd - wordDuration,
    );
    const appliedDelta = nextStart - selectedWord.start;
    updateCaptionWords(selectedCaption.id, (words) => {
      const word = words[selectedWordIndex];
      word.start = Number((word.start + appliedDelta).toFixed(3));
      word.end = Number((word.end + appliedDelta).toFixed(3));
      word.confidence = 1;
      word.source = "manual";
      return words;
    });
    jumpTo(nextStart);
  };

  const toggleWordLoop = () => {
    if (!selectedWord || !videoRef.current) return;
    if (loopRange) {
      setLoopRange(null);
      videoRef.current.pause();
      return;
    }
    const range = {
      start: Math.max(0, selectedWord.start - 0.48),
      end: Math.min(duration, selectedWord.end + 0.48),
    };
    loopRangeRef.current = range;
    setLoopRange(range);
    jumpTo(range.start);
    void videoRef.current.play();
  };

  const startRender = async () => {
    if (
      !job ||
      !["ready", "complete"].includes(job.status) ||
      (!usingDurableMedia && !apiBase) ||
      !captions.length
    ) {
      return;
    }
    setUploading(true);
    setLoopRange(null);
    videoRef.current?.pause();
    try {
      const response = await fetch(
        `${jobsBase}${jobRoute(job.id)}/render`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(usingDurableMedia && job.capabilityToken
              ? {
                  authorization: `Bearer ${job.capabilityToken}`,
                }
              : {}),
          },
          body: JSON.stringify({ captions, style: captionStyle }),
        },
      );
      const data = (await response.json()) as JobResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Render failed.");
      setJob({
        ...data,
        capabilityToken: job.capabilityToken,
      });
      setHasChanges(false);
      setTab("export");
      setToast("Final render started. You can download it when it finishes.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Render failed.");
    } finally {
      setUploading(false);
    }
  };

  const downloadResult = (kind: "video" | "ass") => {
    const resultPath = kind === "video" ? job?.downloadUrl : job?.assUrl;
    if (!resultPath) {
      setToast(`${kind === "video" ? "Video" : "ASS file"} is not ready.`);
      return;
    }
    const link = document.createElement("a");
    link.href = `${jobsBase}${resultPath}`;
    link.click();
  };

  const setStyle = (
    values: Partial<CaptionStyle>,
    presetName = "",
  ) => {
    setCaptionStyle((current) => ({ ...current, ...values }));
    setActivePresetName(presetName);
    setHasChanges(true);
  };

  const moveThroughHistory = useCallback(
    (direction: "undo" | "redo") => {
      const current = revisionHistoryRef.current;
      const next = direction === "undo"
        ? undoRevision(current)
        : redoRevision(current);
      if (next === current) return;
      const document = normalizeEditorDocument(next.present.snapshot);
      if (!document) return;
      applyEditorDocument(document);
      publishRevisionHistory(next);
      setHasChanges(revisionHistoryDirty(next));
      setCaptionDrafts({});
      setLoopRange(null);
      setSelectedCaptionId((captionId) =>
        document.captions.some((caption) => caption.id === captionId)
          ? captionId
          : document.captions[0]?.id ?? "",
      );
      setSelectedWordIndex((wordIndex) => Math.max(0, wordIndex));
      setToast(direction === "undo" ? "Edit undone." : "Edit restored.");
    },
    [applyEditorDocument, publishRevisionHistory],
  );

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        moveThroughHistory("undo");
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        moveThroughHistory("redo");
      }
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [moveThroughHistory]);

  const seek = (seconds: number) => {
    loopRangeRef.current = null;
    setLoopRange(null);
    previewAt(seconds);
  };

  const togglePlayback = () => {
    if (!videoRef.current) return;
    setLoopRange(null);
    if (videoRef.current.paused) void videoRef.current.play();
    else videoRef.current.pause();
  };

  const primaryAction = () => {
    if (!hasProject) {
      videoInputRef.current?.click();
      return;
    }
    if (!job || ["failed", "cancelled"].includes(job.status)) {
      if (file) void uploadVideo(file);
      else videoInputRef.current?.click();
      return;
    }
    if (job.status === "review_required") {
      setTab("review");
      setToast(
        job.message ?? "Caption every speech gap before exporting this draft.",
      );
      return;
    }
    if (tab === "review") {
      setTab("style");
      return;
    }
    if (tab === "style") {
      setTab("export");
      return;
    }
    if (
      draftNeedsAuthorization &&
      (job.status === "ready" ||
        (job.status === "complete" && hasChanges))
    ) {
      setToast(
        "This recovered draft needs project authorization before it can render again.",
      );
      return;
    }
    if (job.status === "ready") {
      void startRender();
    } else if (job.status === "complete" && hasChanges) {
      void startRender();
    } else if (job.status === "complete") {
      downloadResult("video");
    }
  };

  const primaryLabel = (() => {
    if (uploading) return "Working…";
    if (!hasProject) return "Choose video";
    if (!job || ["failed", "cancelled"].includes(job.status)) {
      return file ? "Try again" : "Choose video";
    }
    if (isProcessing) {
      return `${job.message ?? "Processing"} · ${job.progress}%`;
    }
    if (job.status === "review_required") return "Review missing speech";
    if (tab === "review") {
      return "Choose a caption look";
    }
    if (tab === "style") return "Continue to export";
    if (draftNeedsAuthorization && hasChanges) return "Render access required";
    if (job.status === "ready") return "Make my video";
    if (job.status === "complete" && hasChanges) return "Update final video";
    return "Download final MP4";
  })();

  return (
    <main className={`creator-app ${hasProject ? "has-project" : ""}`}>
      <header className="app-header">
        <button
          className="brand"
          onClick={() => {
            if (hasProject) {
              const activeJob = job;
              clearProject();
              void cancelRemoteJob(activeJob);
            }
          }}
          aria-label="SyncWord home"
        >
          <i aria-hidden="true">
            <span />
            <span />
            <span />
          </i>
          <strong>SyncWord</strong>
        </button>
        <div className="header-actions">
          {hasProject && captions.length > 0 && (
            <div className="history-actions" aria-label="Edit history">
              <button
                onClick={() => moveThroughHistory("undo")}
                disabled={!canUndo}
                aria-label="Undo last edit"
                title="Undo (Ctrl+Z)"
              >
                ↶
              </button>
              <button
                onClick={() => moveThroughHistory("redo")}
                disabled={!canRedo}
                aria-label="Redo last edit"
                title="Redo (Ctrl+Shift+Z)"
              >
                ↷
              </button>
            </div>
          )}
          {hasProject && (
            <button
              className="header-export"
              onClick={() => setTab("export")}
              disabled={!captions.length}
            >
              Export
            </button>
          )}
          <div
            className={`engine-state ${engineState}`}
            title={
              engineState === "online"
                ? "Caption engine ready"
                : engineState === "waking"
                  ? "Caption engine waking"
                  : "Caption engine offline"
            }
            aria-label={
              engineState === "online"
                ? "Caption engine ready"
                : engineState === "waking"
                  ? "Caption engine waking"
                  : "Caption engine offline"
            }
          >
            <span />
          </div>
        </div>
      </header>

      {updateRequired && (
        <section className="app-update" role="alertdialog" aria-modal="true">
          <div>
            <span>UPDATE READY</span>
            <h2>Reload before making captions.</h2>
            <p>
              An older editor can show the wrong word timing with the current
              caption engine. Reload to keep them in sync.
            </p>
            {hasProject && (
              <small>
                This temporary preview will reset. Your original video is
                untouched.
              </small>
            )}
            <button onClick={() => window.location.reload()}>
              Reload SyncWord
            </button>
          </div>
        </section>
      )}

      {!hasProject ? (
        <section className="launch">
          <div className="launch-copy">
            <span className="eyebrow">NEW CAPTION VIDEO</span>
            <h1>What are we captioning?</h1>
            <p>
              Add an Assamese, Bodo, or mixed-language reel. You can fix every
              line before making the final video.
            </p>
          </div>

          <div className="launch-card">
            <div className="language-row">
              <span>Spoken language</span>
              <div>
                {[
                  ["unknown", "Auto"],
                  ["as-IN", "অসমীয়া"],
                  ["brx-IN", "बड़ो"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={language === value ? "active" : ""}
                    onClick={() => {
                      setLanguage(value);
                      setStyle({
                        fontFamily:
                          value === "brx-IN"
                            ? "Noto Sans Devanagari"
                            : "Noto Sans Bengali",
                      });
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <details className="transcript-row">
              <summary>
                <span>How should captions be written?</span>
                <strong>
                  {transcriptMode === "verbatim"
                    ? "Everything said"
                    : transcriptMode === "transcribe"
                      ? "Cleaned up"
                      : "Natural mix"}
                </strong>
              </summary>
              <div>
                {[
                  ["codemix", "Natural mix"],
                  ["verbatim", "Everything said"],
                  ["transcribe", "Cleaned up"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={transcriptMode === value ? "active" : ""}
                    onClick={() =>
                      setTranscriptMode(value as TranscriptMode)
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <small>
                {transcriptMode === "verbatim"
                  ? "Keeps fillers, repetitions, and the way the person actually spoke."
                  : transcriptMode === "transcribe"
                    ? "Removes some speech clutter while keeping the original language."
                    : "Recommended: English stays English and regional speech stays in its own script."}
              </small>
            </details>

            <button
              className="upload-reel"
              onClick={() => videoInputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const dropped = event.dataTransfer.files[0];
                if (dropped) void acceptVideo(dropped);
              }}
            >
              <i>＋</i>
              <strong>Choose a video</strong>
              <small>MVP · up to 3 min / 90 MB</small>
            </button>
          </div>

          <ol className="promise-row" aria-label="How SyncWord works">
            <li>
              <b>1</b>
              <div>
                <strong>Automatic captions</strong>
                <span>See them on the video first</span>
              </div>
            </li>
            <li>
              <b>2</b>
              <div>
                <strong>Tap to correct</strong>
                <span>Change text and timing directly</span>
              </div>
            </li>
            <li>
              <b>3</b>
              <div>
                <strong>Export once</strong>
                <span>Rendering starts only when you approve</span>
              </div>
            </li>
          </ol>
        </section>
      ) : (
        <div className="creator-workspace">
          <section className="reel-column">
            <div className="project-bar">
              <button
                onClick={() => {
                  if (isProcessing) cancelProcessing();
                  videoInputRef.current?.click();
                }}
              >
                {isProcessing ? "Cancel & replace" : "Replace video"}
              </button>
              <span title={mediaName}>{mediaName}</span>
              {showingFinal ? (
                <b className="final-label">FINAL</b>
              ) : job?.status === "review_required" ? (
                <b className="review-label">REVIEW</b>
              ) : job?.status === "ready" ? (
                <b className="preview-label">PREVIEW</b>
              ) : null}
            </div>

            <div
              className={`reel-frame ${videoRatio >= 1 ? "landscape" : ""}`}
              style={previewStyle}
            >
              <video
                key={playbackUrl}
                ref={videoRef}
                src={playbackUrl}
                onLoadedMetadata={(event) => {
                  setDuration(
                    Number.isFinite(event.currentTarget.duration)
                      ? event.currentTarget.duration
                      : 0,
                  );
                  if (
                    event.currentTarget.videoWidth &&
                    event.currentTarget.videoHeight
                  ) {
                    setVideoRatio(
                      event.currentTarget.videoWidth /
                        event.currentTarget.videoHeight,
                    );
                  }
                }}
                onTimeUpdate={(event) => {
                  // Paused/buffered updates are a fallback. During playback,
                  // the decoded-frame clock above drives caption highlighting.
                  if (event.currentTarget.paused) {
                    setCurrentTime(event.currentTarget.currentTime);
                  }
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                playsInline
              />

              {!showingFinal && activeWordGroup.length > 0 && (
                <div
                  className={`live-caption ${captionStyle.animation} ${
                    activeGroupUsesWordSync ? "word-sync" : "phrase-sync"
                  }`}
                  aria-live="off"
                >
                  {activeWordGroup.map((word) => (
                    <span
                      key={word.id}
                      className={activeWord?.id === word.id ? "active" : ""}
                    >
                      {word.text}
                    </span>
                  ))}
                </div>
              )}

              {isProcessing && (
                <div className="processing-cover">
                  <div
                    className="processing-orbit"
                    style={
                      { "--progress": job?.progress ?? 4 } as CSSProperties
                    }
                  >
                    <span>{job?.progress ?? 4}%</span>
                  </div>
                  <strong>{job?.message ?? "Uploading your reel"}</strong>
                  <small>
                    {job?.status === "rendering"
                      ? "Creating the downloadable video now."
                      : "The editor will open automatically when the captions are ready."}
                  </small>
                  <button
                    className="cancel-processing"
                    onClick={cancelProcessing}
                  >
                    Cancel processing
                  </button>
                  <ol>
                    {(job?.status === "rendering"
                      ? ["Upload", "Captions", "Review", "Style", "Video"]
                      : ["Upload", "Listen", "Write", "Ready"]
                    ).map((label, index) => (
                      <li
                        key={label}
                        className={
                          index <= statusStep(job?.status) ? "active" : ""
                        }
                      >
                        <i />
                        <span>{label}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {["failed", "cancelled"].includes(job?.status ?? "") && (
                <div className="failed-cover">
                  <b>Processing stopped</b>
                  <span>{job?.message}</span>
                </div>
              )}

              {showingFinal && (
                <div className="final-chip">BURNED-IN MP4</div>
              )}
            </div>

            <div className="transport">
              <button onClick={togglePlayback} aria-label="Play or pause">
                {playing ? "Ⅱ" : "▶"}
              </button>
              <span>{compactTime(currentTime)}</span>
              <input
                aria-label="Video position"
                type="range"
                min="0"
                max={Math.max(duration, 0.01)}
                step="0.01"
                value={Math.min(currentTime, duration)}
                onChange={(event) => seek(Number(event.target.value))}
              />
              <span>{compactTime(duration)}</span>
            </div>

            {captions.length > 0 && (
              <div className="creator-hint">
                <span>1</span>
                <div>
                  <strong>Play it once.</strong>
                  <small>
                    Tap any caption below when the words or timing feel wrong.
                  </small>
                </div>
              </div>
            )}
          </section>

          <section className="tool-column">
            <nav
              className="tool-tabs"
              aria-label="Caption workflow"
              role="tablist"
            >
              {(
                [
                  ["review", "1", "Captions"],
                  ["style", "2", "Look"],
                  ["export", "3", "Export"],
                ] as const
              ).map(([value, number, label]) => (
                <button
                  key={value}
                  className={tab === value ? "active" : ""}
                  onClick={() => setTab(value)}
                  disabled={!captions.length && value !== "review"}
                  role="tab"
                  aria-selected={tab === value}
                >
                  <i>{number}</i>
                  <span>{label}</span>
                </button>
              ))}
            </nav>

            <div className="tool-body">
              {job?.status === "review_required" && (
                <div className="coverage-warning" role="alert">
                  <strong>Speech coverage needs review</strong>
                  <span>
                    {job.message ??
                      "Some spoken audio is still missing trusted captions. Export stays locked until coverage is complete."}
                  </span>
                </div>
              )}
              {tab === "review" && !captions.length && (
                <div className="waiting-panel">
                  <span className="panel-icon">⌁</span>
                  <h2>
                    {job?.status === "failed"
                      ? "That video needs another try."
                      : "Listening to your video…"}
                  </h2>
                  <p>
                    Your editable captions will appear here automatically.
                  </p>
                  {job && (
                    <div className="waiting-progress">
                      <i>
                        <b style={{ width: `${job.progress}%` }} />
                      </i>
                      <span>{job.message}</span>
                    </div>
                  )}
                </div>
              )}

              {tab === "review" && selectedCaption && selectedWord && (
                <div className="caption-editor">
                  <header className="caption-editor-heading">
                    <div>
                      <small>CAPTIONS</small>
                      <h2>Make it sound right.</h2>
                      <p>Play the video. Tap the exact line or word you hear.</p>
                    </div>
                    <button onClick={() => setTab("style")}>Style</button>
                  </header>

                  <CaptionTimeline
                    cues={captions}
                    duration={duration}
                    currentTime={currentTime}
                    selectedCueId={selectedCaption.id}
                    onSelect={(captionId, time) => {
                      setSelectedCaptionId(captionId);
                      setSelectedWordIndex(0);
                      setLoopRange(null);
                      seek(time);
                    }}
                    onChange={updateCaptionTiming}
                  />

                  <section className="caption-composer">
                    <div className="composer-topline">
                      <span>
                        Line {captions.findIndex((caption) => caption.id === selectedCaption.id) + 1}
                        <b>{compactTime(selectedCaption.start)}–{compactTime(selectedCaption.end)}</b>
                      </span>
                      <button
                        onClick={() => {
                          const range = {
                            start: Math.max(0, selectedCaption.start - 0.18),
                            end: Math.min(duration, selectedCaption.end + 0.18),
                          };
                          loopRangeRef.current = range;
                          setLoopRange(range);
                          jumpTo(range.start);
                          void videoRef.current?.play();
                        }}
                      >
                        ▶ Play line
                      </button>
                    </div>

                    <label className="line-editor" htmlFor="caption-text">
                      <span>Caption text</span>
                      <textarea
                        id="caption-text"
                        rows={2}
                        value={captionDraft}
                        onChange={(event) =>
                          setCaptionDrafts((current) => ({
                            ...current,
                            [selectedCaption.id]: event.target.value,
                          }))
                        }
                        onBlur={commitCaptionDraft}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            (event.metaKey || event.ctrlKey)
                          ) {
                            event.preventDefault();
                            commitCaptionDraft();
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </label>

                    <div className="composer-save-row">
                      <span>Tap a word to fix its highlight.</span>
                      <button onClick={commitCaptionDraft}>Save text</button>
                    </div>

                    <div className="word-strip" aria-label="Words in this caption">
                      {selectedWords.map((word, index) => (
                        <button
                          key={word.id}
                          className={index === selectedWordIndex ? "active" : ""}
                          onClick={() =>
                            selectReviewItem({
                              captionId: selectedCaption.id,
                              captionIndex: captions.findIndex(
                                (caption) => caption.id === selectedCaption.id,
                              ),
                              wordIndex: index,
                              globalIndex:
                                flatWords.find((item) => item.word.id === word.id)
                                  ?.globalIndex ?? 0,
                              word,
                            })
                          }
                        >
                          {word.text}
                        </button>
                      ))}
                    </div>

                    <div className="word-sync-card">
                      <button
                        className={`word-loop ${isLooping ? "active" : ""}`}
                        onClick={toggleWordLoop}
                        aria-label={isLooping ? "Stop word loop" : "Loop selected word"}
                      >
                        {isLooping ? "■" : "▶"}
                      </button>
                      <label>
                        <span>Selected word</span>
                        <input
                          value={selectedWord.text}
                          onChange={(event) => updateSelectedWordText(event.target.value)}
                        />
                      </label>
                      <div>
                        <button onClick={() => shiftSelectedWord(-0.06)}>← Earlier</button>
                        <button onClick={() => shiftSelectedWord(0.06)}>Later →</button>
                      </div>
                    </div>

                    <details className="fine-timing" key={selectedWord.id}>
                      <summary>
                        <span>Fine timing</span>
                        <small>{preciseTime(selectedWord.start)}–{preciseTime(selectedWord.end)}</small>
                      </summary>
                      <div>
                        <button onClick={() => adjustSelectedEdge("start", -0.03)}>Start −30 ms</button>
                        <button onClick={() => adjustSelectedEdge("start", 0.03)}>Start +30 ms</button>
                        <button onClick={() => adjustSelectedEdge("end", -0.03)}>End −30 ms</button>
                        <button onClick={() => adjustSelectedEdge("end", 0.03)}>End +30 ms</button>
                      </div>
                    </details>

                    <button className="next-caption" onClick={finishSelectedCaption}>
                      <span>
                        <strong>Done with this line</strong>
                        <small>
                          {captions.at(-1)?.id === selectedCaption.id
                            ? "pick a style next"
                            : "move to the next line"}
                        </small>
                      </span>
                      <b>→</b>
                    </button>
                  </section>

                  <nav className="caption-list" aria-label="All captions">
                    {captions.map((caption, index) => (
                      <button
                        key={caption.id}
                        className={caption.id === selectedCaption.id ? "active" : ""}
                        onClick={() => {
                          setSelectedCaptionId(caption.id);
                          setSelectedWordIndex(0);
                          setLoopRange(null);
                          seek(caption.start);
                        }}
                      >
                        <b>{String(index + 1).padStart(2, "0")}</b>
                        <span>{caption.text}</span>
                        <small>{compactTime(caption.start)}</small>
                      </button>
                    ))}
                  </nav>
                </div>
              )}

              {tab === "style" && (
                <div className="style-panel">
                  <div className="panel-heading">
                    <small>STEP 2 · LOOK</small>
                    <h2>Pick a look. Watch it live.</h2>
                    <p>
                      Tap a style, then play the video. Nothing is rendering yet.
                    </p>
                  </div>

                  <div className="preset-row">
                    {presets.map((preset) => (
                      <button
                        key={preset.name}
                        className={
                          activePresetName === preset.name ? "active" : ""
                        }
                        onClick={() => setStyle(preset.values, preset.name)}
                        aria-pressed={activePresetName === preset.name}
                      >
                        <i
                          style={{
                            color: preset.values.textColor,
                            background: rgba(
                              preset.values.backgroundColor ?? "#070806",
                              preset.values.backgroundOpacity ?? 0,
                            ),
                            WebkitTextStroke: `${
                              (preset.values.outlineWidth ?? 0) / 2
                            }px ${preset.values.outlineColor}`,
                          }}
                        >
                          {preset.sample}
                        </i>
                        <strong>{preset.name}</strong>
                        <small>{preset.note}</small>
                      </button>
                    ))}
                  </div>

                  <details className="style-customizer">
                    <summary>
                      <span>
                        <strong>Make it yours</strong>
                        <small>colors, size, motion and position</small>
                      </span>
                      <b>＋</b>
                    </summary>

                    <div className="style-customizer-body">
                      <div className="select-grid">
                        <label>
                          Script font
                          <select
                            value={captionStyle.fontFamily}
                            onChange={(event) =>
                              setStyle({ fontFamily: event.target.value })
                            }
                          >
                            <option>Noto Sans Bengali</option>
                            <option>Noto Sans Devanagari</option>
                          </select>
                        </label>
                        <label>
                          Motion
                          <select
                            value={captionStyle.animation}
                            onChange={(event) =>
                              setStyle({
                                animation: event.target
                                  .value as CaptionStyle["animation"],
                              })
                            }
                          >
                            <option value="pop">Pop</option>
                            <option value="slide">Slide up</option>
                            <option value="fade">Fade</option>
                          </select>
                        </label>
                      </div>

                      <div className="color-grid">
                        {(
                          [
                            ["Words", "textColor"],
                            ["Active", "highlightColor"],
                            ["Box", "backgroundColor"],
                          ] as const
                        ).map(([label, key]) => (
                          <label key={key}>
                            <input
                              type="color"
                              value={captionStyle[key]}
                              onChange={(event) =>
                                setStyle({ [key]: event.target.value })
                              }
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>

                      <div className="range-stack">
                        {[
                          ["Size", "fontSize", 28, 84, "px"],
                          ["Words on screen", "wordsPerCard", 2, 7, ""],
                          ["Position", "position", 56, 90, "%"],
                          ["Box", "backgroundOpacity", 0, 100, "%"],
                          ["Outline", "outlineWidth", 0, 8, "px"],
                        ].map(([label, key, min, max, suffix]) => (
                          <label key={String(key)}>
                            <span>
                              {label}
                              <b>
                                {captionStyle[key as keyof CaptionStyle]}
                                {suffix}
                              </b>
                            </span>
                            <input
                              type="range"
                              min={Number(min)}
                              max={Number(max)}
                              value={Number(
                                captionStyle[key as keyof CaptionStyle],
                              )}
                              onChange={(event) =>
                                setStyle({
                                  [key]: Number(event.target.value),
                                } as Partial<CaptionStyle>)
                              }
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  </details>

                  <div className="style-note">
                    <i>⌁</i>
                    <div>
                      <strong>This is only a preview</strong>
                      <span>
                        Play, change and compare freely. Your downloadable video
                        starts only after you confirm.
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {tab === "export" && (
                <div className="export-panel">
                  <div
                    className={`export-status ${
                      showingFinal ? "ready" : ""
                    }`}
                  >
                    <span>
                      {showingFinal
                        ? "✓"
                        : job?.status === "rendering"
                          ? "↻"
                          : "→"}
                    </span>
                    <div>
                      <small>
                        {showingFinal
                          ? "READY"
                          : job?.status === "rendering"
                            ? "MAKING YOUR VIDEO"
                            : "STEP 3 · EXPORT"}
                      </small>
                      <h2>
                        {showingFinal
                          ? "Ready to post."
                          : job?.status === "rendering"
                            ? "Adding captions to every frame…"
                            : "Happy with the preview?"}
                      </h2>
                      <p>
                        {showingFinal
                          ? "Download it and post wherever your audience is."
                          : job?.status === "rendering"
                            ? job.message
                            : "Play it once more if you want. When you confirm, we will make one downloadable MP4."}
                      </p>
                    </div>
                  </div>

                  <div className="preflight-list">
                    <div className="pass">
                      <i>✓</i>
                      <span>
                        <strong>Captions stay editable</strong>
                        <small>Go back and tap any line whenever you want</small>
                      </span>
                    </div>
                    <div className="pass">
                      <i>✓</i>
                      <span>
                        <strong>Safer word effects</strong>
                        <small>
                          uncertain words stay steady instead of drifting
                        </small>
                      </span>
                    </div>
                    <div className="pass">
                      <i>✓</i>
                      <span>
                        <strong>Your original stays safe</strong>
                        <small>SyncWord creates a separate downloadable copy</small>
                      </span>
                    </div>
                  </div>

                  <div className="export-spec">
                    <div>
                      <span>Video</span>
                      <strong>Ready for social apps</strong>
                    </div>
                    <div>
                      <span>Captions</span>
                      <strong>Burned into the video</strong>
                    </div>
                    <div>
                      <span>Word effect</span>
                      <strong>Automatic where reliable</strong>
                    </div>
                    <div>
                      <span>Compatibility</span>
                      <strong>Instagram · TikTok · YouTube</strong>
                    </div>
                  </div>

                  {job?.status === "ready" && (
                    <div className="export-actions">
                      <button
                        className="secondary"
                        onClick={() => setTab("review")}
                      >
                        Back to captions
                      </button>
                      <button
                        className="primary"
                        onClick={() => void startRender()}
                      >
                        Make my video
                        <span>→</span>
                      </button>
                    </div>
                  )}

                  {job?.status === "complete" && hasChanges && (
                    <div className="export-actions">
                      <button
                        className="primary"
                        onClick={() => void startRender()}
                      >
                        Update my video
                        <span>↻</span>
                      </button>
                    </div>
                  )}

                  {showingFinal && (
                    <div className="download-actions">
                      <button onClick={() => downloadResult("video")}>
                        Download final MP4
                        <span>↓</span>
                      </button>
                      <button onClick={() => downloadResult("ass")}>
                        Download caption file
                      </button>
                    </div>
                  )}

                  <p className="hobby-note">
                    This MVP keeps files temporarily. Download your finished
                    video when it is ready.
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      <input
        ref={videoInputRef}
        type="file"
        accept="video/*,.mkv"
        hidden
        onChange={(event) => {
          const nextFile = event.target.files?.[0];
          if (nextFile) void acceptVideo(nextFile);
          event.target.value = "";
        }}
      />

      {hasProject && (
        <div className="action-dock">
          {job && (
            <div className="mini-progress">
              <i>
                <b style={{ width: `${job.progress}%` }} />
              </i>
            </div>
          )}
          <button
            onClick={primaryAction}
            disabled={isProcessing}
            className={isFinal && !hasChanges ? "download" : ""}
          >
            <span>{primaryLabel}</span>
            <b>{isFinal && !hasChanges ? "↓" : "→"}</b>
          </button>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button onClick={() => setToast("")} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </main>
  );
}
