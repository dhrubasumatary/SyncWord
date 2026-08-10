"use client";

import Image from "next/image";
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
import { CAPTION_QUALITY_REVISION } from "../shared/caption-coverage.mjs";
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
  rebaseRevisionHistory,
  redoRevision,
  replaceRevisionBase,
  revisionHistoryDirty,
  serializeEditorDraft,
  undoRevision,
} from "../shared/editor-draft.mjs";
import {
  createManualCaptionForGap,
  normalizeRenderPreflight,
  normalizeUncoveredIntervals,
} from "../shared/editor-coverage.mjs";
import {
  ProjectClientError,
  cancelProjectProcessingJob,
  cancelProjectRenderJob,
  createProject,
  createProjectProcessingJob,
  createProjectRenderJob,
  createProjectRevision,
  getProject,
  getProjectProcessingJob,
  getProjectRenderJob,
  getProjectRevision,
  listProjectExports,
  projectAssetContentUrl,
  projectExportContentUrl,
  reserveProjectAsset,
  uploadProjectAsset,
} from "../shared/project-client.mjs";
import {
  editorCaptionsFromProject,
  jobAfterProjectRevisionSave,
  projectProcessingStatusForHydration,
  projectDocumentFromEditor,
  projectRenderRequestScope,
  projectSessionAfterTerminalRender,
  reconcileProjectSessionHead,
  safeProjectSession,
  selectCompletedRenderArtifact,
  selectProjectRenderDispatchIdentity,
} from "../shared/project-editor-adapter.mjs";
import { CaptionTimeline } from "./components/CaptionTimeline";
import {
  miithiiColors,
  miithiiSemanticColors,
} from "../shared/miithii-tokens.mjs";

type WordTiming = {
  id: string;
  text: string;
  start: number;
  end: number;
  confidence: number;
  displaySize?: "small" | "large";
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
  language: "as" | "brx";
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
  coverage?: CaptionCoverageSummary;
};

type CoverageInterval = {
  start: number;
  end: number;
  duration: number;
};

type CaptionCoverageSummary = {
  revision?: string;
  complete?: boolean;
  coverageRatio?: number;
  largestUncoveredGapSeconds?: number;
  uncoveredIntervals?: CoverageInterval[];
  reasons?: string[];
  [key: string]: unknown;
};

type RenderPreflight = {
  code: string;
  message: string;
  coverage: CaptionCoverageSummary | null;
  uncoveredIntervals: CoverageInterval[];
};

type DraftSaveState = {
  status: "idle" | "saving" | "saved" | "error";
  savedAt?: number;
  message?: string;
};

type JobStatus =
  | "queued"
  | "extracting"
  | "transcribing"
  | "aligning"
  | "recovering"
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
type SupportedLanguage = "as-IN" | "brx-IN";
type ReviewItem = {
  captionId: string;
  captionIndex: number;
  wordIndex: number;
  globalIndex: number;
  word: WordTiming;
};
type LoopRange = { start: number; end: number } | null;
type EditorDocument = {
  language: SupportedLanguage;
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

type ProjectSession = {
  projectId: string;
  sourceAssetId: string;
  activeProcessingJobId: string | null;
  headRevisionId: string | null;
  headEditorRevisionId: string | null;
  activeRenderJobId: string | null;
  activeRenderIdempotencyKey: string | null;
  activeRenderRequestScope: string | null;
  activeRenderAttemptDiscriminator: string | null;
  lastCompletedRenderJobId: string | null;
  lastExportArtifactId: string | null;
};

type ProjectProcessingJob = {
  id: string;
  projectId: string;
  sourceAssetId: string;
  revisionId: string | null;
  language: SupportedLanguage;
  mode: string;
  status:
    | "queued"
    | "extracting"
    | "transcribing"
    | "aligning"
    | "recovering"
    | "ready"
    | "review_required"
    | "failed"
    | "cancelled";
  progress: number;
  message?: string;
  failureCode?: string | null;
  updatedAt?: string;
};

type ProjectArtifact = {
  id: string;
  renderJobId: string;
  revisionId: string;
  kind: "video" | "captions_ass" | "captions_srt" | "captions_vtt";
  contentUrl: string;
};

type ProjectRenderJob = {
  id: string;
  projectId: string;
  revisionId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  message?: string;
  failureCode?: string | null;
  updatedAt?: string;
  exportSpec?: Record<string, unknown>;
  artifacts?: ProjectArtifact[];
};

const hostedRenderApi = "https://syncword-render-dhrub404.onrender.com";
const appRevision = "subtitles-web-2026-08-10-v27";
const expectedCaptionQualityRevision = CAPTION_QUALITY_REVISION;
const expectedProcessorRevision = "syncword-caption-v3";
const expectedRendererRevision = "syncword-render-v2";

const defaultStyle: CaptionStyle = {
  fontFamily: "Noto Sans Bengali",
  fontSize: 72,
  textColor: miithiiSemanticColors.dark.text,
  highlightColor: miithiiSemanticColors.dark.accent,
  backgroundColor: miithiiSemanticColors.dark.background,
  backgroundOpacity: 68,
  outlineColor: miithiiSemanticColors.dark.background,
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
    name: "Pulse",
    note: "the miithii signature",
    sample: "PLAY",
    values: {
      textColor: miithiiColors.cream50,
      highlightColor: miithiiColors.lime400,
      backgroundColor: miithiiColors.teal950,
      backgroundOpacity: 68,
      outlineColor: miithiiColors.teal950,
      outlineWidth: 2,
      animation: "pop",
      wordsPerCard: 4,
    },
  },
  {
    name: "Clean",
    note: "quiet and open",
    sample: "CLEAR",
    values: {
      textColor: miithiiColors.cream50,
      highlightColor: miithiiColors.jade400,
      backgroundColor: miithiiColors.teal950,
      backgroundOpacity: 0,
      outlineColor: miithiiColors.teal950,
      outlineWidth: 3,
      animation: "fade",
      wordsPerCard: 4,
    },
  },
  {
    name: "Poster",
    note: "bold and compact",
    sample: "LOUD",
    values: {
      textColor: miithiiColors.cream50,
      highlightColor: miithiiColors.lime400,
      backgroundColor: miithiiColors.teal900,
      backgroundOpacity: 82,
      outlineColor: miithiiColors.teal950,
      outlineWidth: 4,
      animation: "pop",
      wordsPerCard: 3,
    },
  },
];

const processingStatuses: JobStatus[] = [
  "queued",
  "extracting",
  "transcribing",
  "aligning",
  "recovering",
  "rendering",
];
const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function supportedLanguage(value: unknown): SupportedLanguage {
  return value === "brx-IN" ? "brx-IN" : "as-IN";
}

function normalizeCaptionDisplaySizes(items: Caption[]): Caption[] {
  return items.map((caption) => ({
    ...caption,
    language: caption.language === "brx" ? "brx" : "as",
    words: caption.words.map((word) => ({
      ...word,
      displaySize: word.displaySize === "large" ? "large" : "small",
    })),
  }));
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
      processorRevision?: string;
      rendererRevision?: string;
      sarvamConfigured?: boolean;
      modalAlignerConfigured?: boolean;
    };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function renderHealthIsCompatible(
  health: Awaited<ReturnType<typeof getRenderHealth>>,
) {
  return Boolean(
    health?.ok &&
      health.captionQualityRevision === expectedCaptionQualityRevision &&
      health.processorRevision === expectedProcessorRevision &&
      health.rendererRevision === expectedRendererRevision,
  );
}

function loadBrowserVideoMetadata(sourceUrl: string) {
  return new Promise<{
    duration: number;
    width: number;
    height: number;
  }>((resolve, reject) => {
    const probe = document.createElement("video");
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish(new Error("Video preview timed out."));
    }, 15_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      probe.onloadedmetadata = null;
      probe.onerror = null;
      probe.removeAttribute("src");
      probe.load();
    };
    const finish = (
      error?: Error,
      metadata?: { duration: number; width: number; height: number },
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (metadata) resolve(metadata);
    };
    probe.preload = "metadata";
    probe.muted = true;
    probe.onloadedmetadata = () => {
      const metadata = {
        duration: probe.duration,
        width: probe.videoWidth,
        height: probe.videoHeight,
      };
      if (
        !Number.isFinite(metadata.duration) ||
        metadata.duration <= 0 ||
        metadata.width <= 0 ||
        metadata.height <= 0
      ) {
        finish(new Error("Video metadata is unavailable."));
        return;
      }
      finish(undefined, metadata);
    };
    probe.onerror = () => {
      finish(
        new Error(
          "This browser cannot preview that video. Use a browser-playable H.264 MP4 or WebM file.",
        ),
      );
    };
    probe.src = sourceUrl;
    probe.load();
  });
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
    ? normalizeCaptionDisplaySizes(record.captions)
    : [];
  const transcriptMode = ["codemix", "verbatim", "transcribe"].includes(
    String(record.transcriptMode),
  )
    ? (String(record.transcriptMode) as TranscriptMode)
    : "codemix";
  return {
    language: supportedLanguage(record.language),
    transcriptMode,
    captionStyle: normalizeRestoredStyle(record.captionStyle),
    activePresetName:
      typeof record.activePresetName === "string"
        ? record.activePresetName
        : "Pulse",
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
    "aligning",
    "recovering",
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

function jobFromProjectProcessing(
  processing: ProjectProcessingJob,
  captions: Caption[] = [],
  coverage?: CaptionCoverageSummary,
): JobResponse {
  return {
    id: processing.id,
    captionQualityRevision: CAPTION_QUALITY_REVISION,
    status: processing.status,
    progress: processing.progress,
    message: processing.message,
    captions,
    updatedAt: processing.updatedAt,
    ...(coverage
      ? {
          alignment: {
            method: "project-caption-v3",
            totalWords: captions.reduce(
              (total, caption) => total + caption.words.length,
              0,
            ),
            waveformAlignedWords: captions.reduce(
              (total, caption) =>
                total +
                caption.words.filter((word) => word.source !== "manual").length,
              0,
            ),
            averageConfidence: 0,
            needsReview: processing.status === "review_required" ? 1 : 0,
            coverage,
          },
        }
      : {}),
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
  const [videoDimensions, setVideoDimensions] = useState({
    width: 0,
    height: 0,
  });
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [language, setLanguage] = useState<SupportedLanguage>("as-IN");
  const [transcriptMode, setTranscriptMode] =
    useState<TranscriptMode>("codemix");
  const [captionStyle, setCaptionStyle] = useState(defaultStyle);
  const [activePresetName, setActivePresetName] = useState("Pulse");
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [selectedCaptionId, setSelectedCaptionId] = useState("");
  const [selectedWordIndex, setSelectedWordIndex] = useState(0);
  const [loopRange, setLoopRange] = useState<LoopRange>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [projectSession, setProjectSession] =
    useState<ProjectSession | null>(null);
  const [projectRenderJob, setProjectRenderJob] =
    useState<ProjectRenderJob | null>(null);
  const [projectAccessDenied, setProjectAccessDenied] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [engineState, setEngineState] =
    useState<EngineState>("offline");
  const [hasChanges, setHasChanges] = useState(false);
  const [updateRequired, setUpdateRequired] = useState(false);
  const [toast, setToast] = useState("");
  const [renderPreflight, setRenderPreflight] =
    useState<RenderPreflight | null>(null);
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>({
    status: "idle",
  });
  const [pendingRenderRevision, setPendingRenderRevision] = useState("");
  const [lastRenderedRevision, setLastRenderedRevision] = useState("");
  const [captionDrafts, setCaptionDrafts] = useState<
    Record<string, string>
  >({});
  const [revisionHistoryVersion, setRevisionHistoryVersion] = useState(0);
  const [historyControls, setHistoryControls] = useState({
    canUndo: false,
    canRedo: false,
    currentRevisionId: "",
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
      language: "as-IN",
      transcriptMode: "codemix",
      captionStyle: defaultStyle,
      activePresetName: "Pulse",
      captions: [],
    }),
  );
  const draftStoreRef = useRef<ReturnType<
    typeof createBrowserDraftStore
  > | null>(null);
  const draftReadyRef = useRef(false);
  const suppressHistoryTrackingRef = useRef(false);
  const pendingRenderRevisionRef = useRef("");
  const videoSelectionGenerationRef = useRef(0);
  const draftSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const draftSaveGenerationRef = useRef(0);
  const draftViewTimerRef = useRef<number | null>(null);
  const draftLastViewSaveRef = useRef(0);
  const draftPersistenceMountedRef = useRef(true);
  const draftPersistenceSnapshotRef = useRef<{
    mediaIdentity: MediaIdentity | null;
    duration: number;
    videoRatio: number;
    videoDimensions: { width: number; height: number };
    projectSession: ProjectSession | null;
    job: JobResponse | null;
    tab: StudioTab;
    selectedCaptionId: string;
    selectedWordIndex: number;
    currentTime: number;
    captionDrafts: Record<string, string>;
    pendingRenderRevision: string;
    lastRenderedRevision: string;
  } | null>(null);

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
    mediaIdentity?.durable &&
      job &&
      (projectSession ? projectAccessDenied : !job.capabilityToken),
  );
  const isProcessing = Boolean(
    uploading || (job && processingStatuses.includes(job.status)),
  );
  const projectVideoArtifact = projectRenderJob?.artifacts?.find(
    (artifact) => artifact.kind === "video",
  );
  const projectFinalVideoUrl = projectSession?.lastExportArtifactId
    ? projectExportContentUrl(
        projectSession.projectId,
        projectSession.lastExportArtifactId,
      )
    : projectVideoArtifact?.contentUrl ?? "";
  const isFinal =
    job?.status === "complete" &&
    Boolean(projectSession ? projectFinalVideoUrl : job.previewUrl);
  const showingFinal = isFinal && !hasChanges;
  const finalVideoUrl = showingFinal
    ? projectSession
      ? projectFinalVideoUrl
      : job?.previewUrl
        ? `${jobsBase}${job.previewUrl}?v=${encodeURIComponent(
            job.updatedAt ?? "",
          )}`
        : ""
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
  const uncoveredIntervals = useMemo(
    () =>
      normalizeUncoveredIntervals(
        renderPreflight?.uncoveredIntervals ??
          job?.alignment?.coverage?.uncoveredIntervals,
        duration,
      ) as CoverageInterval[],
    [duration, job?.alignment?.coverage?.uncoveredIntervals, renderPreflight],
  );
  const coverageMessage =
    renderPreflight?.message ??
    job?.message ??
    "Some spoken audio is still missing trusted captions. Review every highlighted gap before exporting.";
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
        currentRevisionId: history.present.revisionId,
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
        ? "var(--font-bodo)"
        : "var(--font-assamese)",
  } as CSSProperties;

  const persistDraft = useCallback(
    (options: {
      synchronousFallback?: boolean;
      surfaceStatus?: boolean;
    } = {}) => {
      const snapshot = draftPersistenceSnapshotRef.current;
      const store = draftStoreRef.current;
      if (
        !draftReadyRef.current ||
        !snapshot ||
        !store ||
        (!snapshot.mediaIdentity && !snapshot.job)
      ) {
        return Promise.resolve(false);
      }

      let serialized: string;
      try {
        const draft = createEditorDraft({
          projectId:
            snapshot.projectSession?.projectId ?? snapshot.job?.id ?? "active",
          savedAt: new Date().toISOString(),
          media: snapshot.mediaIdentity
            ? {
                ...snapshot.mediaIdentity,
                duration: snapshot.duration,
                videoRatio: snapshot.videoRatio,
                videoWidth: snapshot.videoDimensions.width,
                videoHeight: snapshot.videoDimensions.height,
              }
            : null,
          projectSession: snapshot.projectSession,
          job: snapshot.job,
          history: revisionHistoryRef.current,
          view: {
            tab: snapshot.tab,
            selectedCaptionId: snapshot.selectedCaptionId,
            selectedWordIndex: snapshot.selectedWordIndex,
            currentTime: snapshot.currentTime,
            captionDrafts: snapshot.captionDrafts,
            pendingRenderRevision: snapshot.pendingRenderRevision,
            lastRenderedRevision: snapshot.lastRenderedRevision,
          },
        });
        serialized = serializeEditorDraft(draft);
      } catch (error) {
        if (draftPersistenceMountedRef.current) {
          setDraftSaveState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "The local draft could not be prepared.",
          });
        }
        return Promise.resolve(false);
      }

      let synchronousFallbackSaved = false;
      if (options.synchronousFallback) {
        try {
          window.localStorage.setItem(EDITOR_DRAFT_STORAGE_KEY, serialized);
          synchronousFallbackSaved = true;
        } catch {
          // The queued resilient store still gets a chance to use IndexedDB.
        }
      }

      const generation = ++draftSaveGenerationRef.current;
      if (
        options.surfaceStatus !== false &&
        draftPersistenceMountedRef.current
      ) {
        setDraftSaveState({ status: "saving" });
      }
      const save = draftSaveQueueRef.current.then(() =>
        store.save(EDITOR_DRAFT_STORAGE_KEY, serialized),
      );
      draftSaveQueueRef.current = save.catch(() => undefined);
      return save
        .then(() => {
          if (
            generation === draftSaveGenerationRef.current &&
            draftPersistenceMountedRef.current
          ) {
            setDraftSaveState({ status: "saved", savedAt: Date.now() });
          }
          return true;
        })
        .catch((error) => {
          if (
            generation === draftSaveGenerationRef.current &&
            draftPersistenceMountedRef.current
          ) {
            setDraftSaveState({
              status: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "Local draft storage is unavailable.",
              });
          }
          return synchronousFallbackSaved;
        });
    },
    [],
  );

  const persistProjectSession = useCallback(
    async (nextSession: ProjectSession) => {
      setProjectSession((current) =>
        current?.projectId === nextSession.projectId ? nextSession : current,
      );
      const snapshot = draftPersistenceSnapshotRef.current;
      if (
        snapshot?.projectSession?.projectId === nextSession.projectId
      ) {
        draftPersistenceSnapshotRef.current = {
          ...snapshot,
          projectSession: nextSession,
        };
      }
      return persistDraft({
        synchronousFallback: true,
        surfaceStatus: false,
      });
    },
    [persistDraft],
  );

  useEffect(() => {
    draftPersistenceSnapshotRef.current = {
      mediaIdentity,
      duration,
      videoRatio,
      videoDimensions,
      projectSession,
      job,
      tab,
      selectedCaptionId,
      selectedWordIndex,
      currentTime,
      captionDrafts,
      pendingRenderRevision,
      lastRenderedRevision,
    };
  }, [
    captionDrafts,
    currentTime,
    duration,
    job,
    lastRenderedRevision,
    mediaIdentity,
    pendingRenderRevision,
    selectedCaptionId,
    selectedWordIndex,
    tab,
    videoRatio,
    videoDimensions,
    projectSession,
  ]);

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
        const draftDocument = normalizeEditorDocument(
          draft?.history.present.snapshot,
        );
        if (!draft || !draftDocument) return;
        let restoredDocument: EditorDocument = draftDocument;

        let restoredHistory = draft.history;
        let restoredJob = normalizeRestoredJob(
          draft.job,
          restoredDocument.captions,
        );
        let restoredProjectSession = safeProjectSession(
          draft.projectSession,
        ) as ProjectSession | null;
        let restoredDuration = draft.media?.duration ?? 0;
        let restoredDimensions = {
          width: draft.media?.videoWidth ?? 0,
          height: draft.media?.videoHeight ?? 0,
        };
        let restoredRatio = draft.media?.videoRatio ?? 9 / 16;
        let projectAccessLost = false;
        let remoteHeadChanged = false;
        let remoteHeadCheckFailed = false;

        if (restoredProjectSession) {
          try {
            const project = await getProject(
              fetch,
              restoredProjectSession.projectId,
            );
            if (!active) return;
            const remoteHeadRevisionId =
              typeof project.headRevisionId === "string" &&
              project.headRevisionId
                ? project.headRevisionId
                : null;
            remoteHeadChanged =
              remoteHeadRevisionId !== restoredProjectSession.headRevisionId;

            if (remoteHeadChanged && remoteHeadRevisionId) {
              const revision = await getProjectRevision(
                fetch,
                restoredProjectSession.projectId,
                remoteHeadRevisionId,
              );
              if (!active) return;
              const projectDocument = revision.document as {
                durationMs: number;
                canvas: { width: number; height: number };
                captionTrack: {
                  languageCode: string;
                  status: "ready" | "review_required" | "complete";
                  style?: unknown;
                };
              };
              const remoteCaptions = normalizeCaptionDisplaySizes(
                editorCaptionsFromProject(revision.document) as Caption[],
              );
              if (
                !remoteCaptions.length ||
                !remoteCaptions.every(isAlignedCaption)
              ) {
                throw new Error("The remote project revision is invalid.");
              }
              const remoteEditorDocument: EditorDocument = {
                language: supportedLanguage(
                  projectDocument.captionTrack.languageCode,
                ),
                transcriptMode: restoredDocument.transcriptMode,
                captionStyle: normalizeRestoredStyle(
                  projectDocument.captionTrack.style ??
                    restoredDocument.captionStyle,
                ),
                activePresetName: restoredDocument.activePresetName,
                captions: remoteCaptions,
              };
              restoredHistory = rebaseRevisionHistory(
                restoredHistory,
                remoteEditorDocument,
              );
              const reconciledDocument = normalizeEditorDocument(
                restoredHistory.present.snapshot,
              );
              if (!reconciledDocument) {
                throw new Error("The reconciled project draft is invalid.");
              }
              restoredDocument = reconciledDocument;
              restoredDuration = projectDocument.durationMs / 1_000;
              restoredDimensions = projectDocument.canvas;
              restoredRatio =
                projectDocument.canvas.width / projectDocument.canvas.height;
              if (restoredJob) {
                restoredJob = jobAfterProjectRevisionSave(
                  restoredJob,
                  revision.document,
                  restoredDocument.captions,
                ) as JobResponse;
              }
            }

            restoredProjectSession = reconcileProjectSessionHead(
              restoredProjectSession,
              remoteHeadRevisionId,
              remoteHeadChanged ? restoredHistory.baseRevision : null,
            ) as ProjectSession;
          } catch (error) {
            remoteHeadChanged = false;
            if (error instanceof ProjectClientError && error.status === 401) {
              projectAccessLost = true;
            } else {
              remoteHeadCheckFailed = true;
            }
          }
        }

        if (!active) return;
        applyEditorDocument(restoredDocument);
        publishRevisionHistory(restoredHistory);
        setHasChanges(revisionHistoryDirty(restoredHistory));
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
        setDuration(restoredDuration);
        setVideoRatio(restoredRatio);
        setVideoDimensions(restoredDimensions);
        setProjectSession(restoredProjectSession);
        setProjectAccessDenied(projectAccessLost);
        setProjectRenderJob(null);
        if (restoredProjectSession) {
          setVideoUrl(
            projectAssetContentUrl(
              restoredProjectSession.projectId,
              restoredProjectSession.sourceAssetId,
            ),
          );
        }
        setTab(draft.view.tab as StudioTab);
        setSelectedCaptionId(
          (restoredDocument.captions.some(
            (caption) => caption.id === draft.view.selectedCaptionId,
          )
            ? draft.view.selectedCaptionId
            : "") ||
            restoredDocument.captions[0]?.id ||
            "",
        );
        setSelectedWordIndex(draft.view.selectedWordIndex);
        setCurrentTime(draft.view.currentTime);
        setCaptionDrafts(
          remoteHeadChanged && !revisionHistoryDirty(draft.history)
            ? {}
            : (draft.view.captionDrafts as Record<string, string>),
        );
        const restoredPendingRevision = String(
          draft.view.pendingRenderRevision ?? "",
        );
        pendingRenderRevisionRef.current = restoredPendingRevision;
        setPendingRenderRevision(restoredPendingRevision);
        setLastRenderedRevision(
          String(draft.view.lastRenderedRevision ?? ""),
        );
        setJob(restoredJob);
        setDraftSaveState({
          status: "saved",
          savedAt: Date.parse(draft.savedAt) || Date.now(),
        });
        draftReadyRef.current = true;

        if (projectAccessLost) {
          setToast(
            "This browser no longer has access to the recovered project.",
          );
        } else if (remoteHeadCheckFailed) {
          setToast(
            "Draft restored. The latest project head could not be checked yet.",
          );
        } else if (remoteHeadChanged && revisionHistoryDirty(restoredHistory)) {
          setToast(
            "Latest project head restored. Your unsaved local edits are preserved on top.",
          );
        } else if (remoteHeadChanged) {
          setToast("Latest saved project revision restored.");
        } else if (restoredJob?.status === "review_required") {
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
    if (!draftReadyRef.current) return;
    const timeout = window.setTimeout(() => {
      void persistDraft();
    }, 320);
    return () => window.clearTimeout(timeout);
  }, [
    captionDrafts,
    duration,
    job,
    lastRenderedRevision,
    mediaIdentity,
    pendingRenderRevision,
    persistDraft,
    projectSession,
    revisionHistoryVersion,
    videoDimensions,
    videoRatio,
  ]);

  useEffect(() => {
    if (!draftReadyRef.current || draftViewTimerRef.current !== null) return;
    const elapsed = Date.now() - draftLastViewSaveRef.current;
    const wait = Math.max(0, 1_250 - elapsed);
    draftViewTimerRef.current = window.setTimeout(() => {
      draftViewTimerRef.current = null;
      draftLastViewSaveRef.current = Date.now();
      void persistDraft();
    }, wait);
  }, [
    currentTime,
    persistDraft,
    selectedCaptionId,
    selectedWordIndex,
    tab,
  ]);

  useEffect(() => {
    draftPersistenceMountedRef.current = true;
    const flushDraft = () => {
      if (draftViewTimerRef.current !== null) {
        window.clearTimeout(draftViewTimerRef.current);
        draftViewTimerRef.current = null;
      }
      void persistDraft({
        synchronousFallback: true,
        surfaceStatus: false,
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      flushDraft();
      draftPersistenceMountedRef.current = false;
      window.removeEventListener("pagehide", flushDraft);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [persistDraft]);

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
          if (!renderHealthIsCompatible(health)) {
            if (active) {
              setUpdateRequired(true);
              setEngineState("offline");
              setToast(
                "The editor and caption engine are on different versions. Reload after the update finishes.",
              );
            }
            return;
          }
          if (isLocalBrowser && health.sarvamConfigured === false) {
            if (active) {
              setEngineState("offline");
              setToast(
                "Local engine is running, but SARVAM_API_KEY is missing. Copy .env.example to .env and add the key.",
              );
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
  }, [apiBase, isLocalBrowser]);

  useEffect(() => {
    if (
      !usingDurableMedia ||
      !projectSession?.activeProcessingJobId ||
      projectAccessDenied
    ) {
      return;
    }
    let active = true;
    let timer: number | null = null;
    const projectId = projectSession.projectId;
    const processingJobId = projectSession.activeProcessingJobId;

    const pollProcessing = async () => {
      try {
        const processing = (await getProjectProcessingJob(
          fetch,
          projectId,
          processingJobId,
        )) as ProjectProcessingJob;
        if (!active) return;
        setEngineState("online");
        const waitsForRevisionHydration =
          ["ready", "review_required"].includes(processing.status) &&
          Boolean(processing.revisionId);
        const visibleProcessing = waitsForRevisionHydration
          ? {
              ...processing,
              status: projectProcessingStatusForHydration(
                processing.status,
              ) as ProjectProcessingJob["status"],
              progress: Math.min(processing.progress, 99),
              message: "Loading the saved caption revision",
            }
          : processing;
        setJob((current) =>
          jobFromProjectProcessing(
            visibleProcessing,
            current?.captions ?? [],
            current?.alignment?.coverage,
          ),
        );

        if (waitsForRevisionHydration && processing.revisionId) {
          const revision = await getProjectRevision(
            fetch,
            projectId,
            processing.revisionId,
          );
          if (!active) return;
          const projectDocument = revision.document as {
            durationMs: number;
            canvas: { width: number; height: number };
            captionTrack: {
              languageCode: string;
              status: "ready" | "review_required";
              style?: unknown;
              coverage?: CaptionCoverageSummary;
            };
          };
          const nextCaptions = normalizeCaptionDisplaySizes(
            editorCaptionsFromProject(revision.document) as Caption[],
          );
          if (!nextCaptions.length || !nextCaptions.every(isAlignedCaption)) {
            throw new Error("The immutable caption revision is empty or invalid.");
          }
          const nextEditorDocument: EditorDocument = {
            language: supportedLanguage(
              projectDocument.captionTrack.languageCode,
            ),
            transcriptMode: processing.mode as TranscriptMode,
            captionStyle: normalizeRestoredStyle(
              projectDocument.captionTrack.style ?? captionStyle,
            ),
            activePresetName,
            captions: nextCaptions,
          };
          suppressHistoryTrackingRef.current = true;
          applyEditorDocument(nextEditorDocument);
          const cleanHistory = replaceRevisionBase(
            revisionHistoryRef.current,
            nextEditorDocument,
          );
          publishRevisionHistory(cleanHistory);
          setHasChanges(false);
          setDuration(projectDocument.durationMs / 1_000);
          setVideoDimensions(projectDocument.canvas);
          setVideoRatio(
            projectDocument.canvas.width / projectDocument.canvas.height,
          );
          const coverage = projectDocument.captionTrack.coverage;
          setJob(
            jobFromProjectProcessing(
              processing,
              nextCaptions,
              coverage,
            ),
          );
          setSelectedCaptionId(nextCaptions[0]?.id ?? "");
          setSelectedWordIndex(0);
          setProjectSession((current) =>
            current && current.projectId === projectId
              ? {
                  ...current,
                  activeProcessingJobId: null,
                  headRevisionId: processing.revisionId,
                  headEditorRevisionId: cleanHistory.present.revisionId,
                  activeRenderIdempotencyKey: null,
                  activeRenderRequestScope: null,
                  activeRenderAttemptDiscriminator: null,
                }
              : current,
          );
          if (processing.status === "review_required") {
            const intervals = normalizeUncoveredIntervals(
              coverage?.uncoveredIntervals,
              projectDocument.durationMs / 1_000,
            ) as CoverageInterval[];
            setRenderPreflight({
              code: "caption_coverage_incomplete",
              message:
                processing.message ??
                "Some speech still needs a caption before export.",
              coverage: coverage ?? null,
              uncoveredIntervals: intervals,
            });
            setTab("review");
            setToast(
              processing.message ??
                "Captions need review in the highlighted speech gaps.",
            );
          } else {
            setRenderPreflight(null);
            setTab("review");
            setToast("Captions ready. Play through and edit anything.");
          }
          return;
        }

        if (["failed", "cancelled"].includes(processing.status)) {
          setProjectSession((current) =>
            current && current.projectId === projectId
              ? { ...current, activeProcessingJobId: null }
              : current,
          );
          setToast(processing.message ?? "Caption processing failed.");
          return;
        }
      } catch (error) {
        if (!active) return;
        if (error instanceof ProjectClientError && error.status === 401) {
          setProjectAccessDenied(true);
          setToast("Project access expired in this browser.");
          return;
        }
        setEngineState("waking");
      }
      if (active) timer = window.setTimeout(pollProcessing, 2_000);
    };

    void pollProcessing();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    activePresetName,
    applyEditorDocument,
    captionStyle,
    language,
    projectAccessDenied,
    projectSession?.activeProcessingJobId,
    projectSession?.projectId,
    publishRevisionHistory,
    usingDurableMedia,
  ]);

  useEffect(() => {
    if (
      !job ||
      (usingDurableMedia && Boolean(projectSession)) ||
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
          setToast("The editor was updated. Reload before continuing.");
          return;
        }
        setJob((current) => ({
          ...next,
          capabilityToken: current?.capabilityToken,
        }));
        const pendingRevision = pendingRenderRevisionRef.current;
        const documentChangedSinceRender = Boolean(
          pendingRevision &&
            revisionHistoryRef.current.present.revisionId !== pendingRevision,
        );
        const nextCaptions =
          Array.isArray(next.captions) &&
          next.captions.every(isAlignedCaption)
            ? normalizeCaptionDisplaySizes(next.captions)
            : [];
        if (nextCaptions.length) {
          setCaptions((current) =>
            current.length &&
            (next.status === "rendering" || documentChangedSinceRender)
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
          setRenderPreflight(null);
          setTab("review");
          setToast("Captions ready. Play through and edit anything.");
        } else if (next.status === "review_required") {
          setTab("review");
          setToast(
            next.message ??
              "Some speech is still missing captions and needs review.",
          );
        } else if (next.status === "complete") {
          setRenderPreflight(null);
          if (pendingRevision) {
            pendingRenderRevisionRef.current = "";
            setPendingRenderRevision("");
            setLastRenderedRevision(pendingRevision);
            if (!documentChangedSinceRender) {
              const cleanHistory = markRevisionBase(
                revisionHistoryRef.current,
              );
              publishRevisionHistory(cleanHistory);
              setHasChanges(false);
            }
          }
          setTab("export");
          setToast(
            documentChangedSinceRender
              ? "That render is ready. Your newer draft edits are still unsent."
              : "Your final video is ready to download.",
          );
        } else if (["failed", "cancelled"].includes(next.status)) {
          if (pendingRevision) {
            pendingRenderRevisionRef.current = "";
            setPendingRenderRevision("");
          }
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
    publishRevisionHistory,
    projectSession,
    selectedCaptionId,
    usingDurableMedia,
  ]);

  useEffect(() => {
    if (
      !usingDurableMedia ||
      !projectSession?.activeRenderJobId ||
      projectAccessDenied
    ) {
      return;
    }
    let active = true;
    let timer: number | null = null;
    const projectId = projectSession.projectId;
    const renderJobId = projectSession.activeRenderJobId;

    const pollRender = async () => {
      try {
        const renderJob = (await getProjectRenderJob(
          fetch,
          projectId,
          renderJobId,
        )) as ProjectRenderJob;
        if (!active) return;
        setProjectRenderJob(renderJob);
        if (["queued", "running"].includes(renderJob.status)) {
          setJob((current) =>
            current
              ? {
                  ...current,
                  status: "rendering",
                  progress: renderJob.progress,
                  message: renderJob.message,
                  updatedAt: renderJob.updatedAt,
                }
              : current,
          );
        } else if (renderJob.status === "succeeded") {
          const videoArtifact = selectCompletedRenderArtifact(
            renderJob.artifacts,
            renderJob.id,
            "video",
          ) as ProjectArtifact | null;
          if (!videoArtifact) {
            throw new Error("The render succeeded without a video artifact.");
          }
          const pendingRevision = pendingRenderRevisionRef.current;
          const changedSinceRender = Boolean(
            pendingRevision &&
              revisionHistoryRef.current.present.revisionId !== pendingRevision,
          );
          pendingRenderRevisionRef.current = "";
          setPendingRenderRevision("");
          if (pendingRevision) setLastRenderedRevision(pendingRevision);
          setProjectSession((current) =>
            current && current.projectId === projectId
              ? {
                  ...current,
                  activeRenderJobId: null,
                  activeRenderIdempotencyKey: null,
                  activeRenderRequestScope: null,
                  activeRenderAttemptDiscriminator: null,
                  lastCompletedRenderJobId: renderJob.id,
                  lastExportArtifactId: videoArtifact.id,
                }
              : current,
          );
          setJob((current) =>
            current
              ? {
                  ...current,
                  status: "complete",
                  progress: 100,
                  message: "Your final video is ready.",
                  previewUrl: videoArtifact.contentUrl,
                  downloadUrl: videoArtifact.contentUrl,
                  updatedAt: renderJob.updatedAt,
                }
              : current,
          );
          setTab("export");
          setToast(
            changedSinceRender
              ? "That render is ready. Your newer draft edits are still unsent."
              : "Your final video is ready to download.",
          );
          return;
        } else {
          pendingRenderRevisionRef.current = "";
          setPendingRenderRevision("");
          const terminalRequestScope =
            projectSession.activeRenderRequestScope ??
            (renderJob.exportSpec
              ? projectRenderRequestScope(
                  renderJob.revisionId,
                  renderJob.exportSpec,
                )
              : null);
          if (!terminalRequestScope) {
            throw new Error(
              "The terminal render is missing its immutable request scope.",
            );
          }
          await persistProjectSession(
            projectSessionAfterTerminalRender(
              projectSession,
              terminalRequestScope,
              renderJob.id,
            ) as ProjectSession,
          );
          setJob((current) =>
            current
              ? {
                  ...current,
                  status: current.alignment?.coverage?.complete
                    ? "ready"
                    : "review_required",
                  message:
                    renderJob.message ??
                    (renderJob.status === "cancelled"
                      ? "Render cancelled. Retry when you are ready."
                      : "Render failed. Your saved revision can be retried."),
                }
              : current,
          );
          setToast(
            renderJob.message ??
              (renderJob.status === "cancelled"
                ? "Render cancelled. Retry when you are ready."
                : "Render failed. Your saved revision can be retried."),
          );
          return;
        }
      } catch (error) {
        if (!active) return;
        if (error instanceof ProjectClientError && error.status === 401) {
          setProjectAccessDenied(true);
          setToast("Project access expired in this browser.");
          return;
        }
        setEngineState("waking");
      }
      if (active) timer = window.setTimeout(pollRender, 2_000);
    };

    void pollRender();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    projectAccessDenied,
    persistProjectSession,
    projectSession,
    usingDurableMedia,
  ]);

  const uploadVideo = async (nextFile: File) => {
    if (updateRequired) {
      setToast("Reload the editor before uploading another video.");
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
        if (renderHealthIsCompatible(health)) {
          if (isLocalBrowser && health?.sarvamConfigured === false) {
            throw new Error(
              "Local engine is running, but SARVAM_API_KEY is missing. Copy .env.example to .env and add the key.",
            );
          }
          engineReady = true;
          setEngineState("online");
          break;
        }
        if (health?.ok) {
          setUpdateRequired(true);
          throw new Error(
            "The editor and caption engine are on different versions. Reload after the update finishes.",
          );
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
        const project = await createProject(
          fetch,
          nextFile.name.replace(/\.[^.]+$/u, "") || "Untitled caption project",
        );
        const asset = await reserveProjectAsset(fetch, project.id, nextFile);
        const initialProjectSession = safeProjectSession({
          projectId: project.id,
          sourceAssetId: asset.id,
        }) as ProjectSession;
        setProjectSession(initialProjectSession);
        setProjectAccessDenied(false);
        setProjectRenderJob(null);
        setToast("Saving your original video securely.");
        const uploadedAsset = await uploadProjectAsset(
          fetch,
          asset.uploadUrl,
          nextFile,
        );
        if (uploadedAsset.status !== "ready") {
          throw new Error("The durable source upload did not finalize.");
        }
        const processingKey = `process:${project.id}:${asset.id}:${language}:${transcriptMode}`;
        let processing: ProjectProcessingJob | null = null;
        let processingError: unknown = null;
        for (let attempt = 0; attempt < 3 && !processing; attempt += 1) {
          try {
            processing = (await createProjectProcessingJob(fetch, project.id, {
              sourceAssetId: asset.id,
              language,
              mode: transcriptMode,
              idempotencyKey: processingKey,
            })) as ProjectProcessingJob;
          } catch (error) {
            processingError = error;
            if (
              !(error instanceof ProjectClientError) ||
              error.status !== 502 ||
              attempt === 2
            ) {
              throw error;
            }
            await clientDelay(1_500 * (attempt + 1));
          }
        }
        if (!processing) throw processingError ?? new Error("Processing could not start.");
        setProjectSession({
          ...initialProjectSession,
          activeProcessingJobId: processing.id,
        });
        data = jobFromProjectProcessing(processing);
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
        throw new Error("The editor was updated. Reload and upload again.");
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
      if (usingDurableMedia && projectSession) {
        if (projectSession.activeProcessingJobId) {
          await cancelProjectProcessingJob(
            fetch,
            projectSession.projectId,
            projectSession.activeProcessingJobId,
          );
        } else if (projectSession.activeRenderJobId) {
          await cancelProjectRenderJob(
            fetch,
            projectSession.projectId,
            projectSession.activeRenderJobId,
          );
        }
        return;
      }
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

  const removePersistedDraft = () => {
    const store = draftStoreRef.current;
    if (!store) return;
    draftSaveGenerationRef.current += 1;
    const remove = draftSaveQueueRef.current.then(() =>
      store.remove(EDITOR_DRAFT_STORAGE_KEY),
    );
    draftSaveQueueRef.current = remove.catch(() => undefined);
    void remove.catch((error) => {
      if (draftPersistenceMountedRef.current) {
        setDraftSaveState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "The previous local draft could not be removed.",
        });
      }
    });
  };

  const clearProject = () => {
    videoSelectionGenerationRef.current += 1;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    suppressHistoryTrackingRef.current = true;
    publishRevisionHistory(
      createRevisionHistory({
        ...editorDocument,
        activePresetName: "Pulse",
        captions: [],
      }),
    );
    removePersistedDraft();
    setFile(null);
    setMediaIdentity(null);
    setVideoUrl("");
    setDuration(0);
    setVideoRatio(9 / 16);
    setVideoDimensions({ width: 0, height: 0 });
    setCurrentTime(0);
    setCaptions([]);
    setSelectedCaptionId("");
    setSelectedWordIndex(0);
    setCaptionDrafts({});
    setLoopRange(null);
    setJob(null);
    setProjectSession(null);
    setProjectRenderJob(null);
    setProjectAccessDenied(false);
    setHasChanges(false);
    setRenderPreflight(null);
    pendingRenderRevisionRef.current = "";
    setPendingRenderRevision("");
    setLastRenderedRevision("");
    setDraftSaveState({ status: "idle" });
    setActivePresetName("Pulse");
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
      setToast("Reload the editor before uploading another video.");
      return;
    }
    const hasPreviewableExtension = /\.(mp4|webm|m4v)$/i.test(nextFile.name);
    if (!hasPreviewableExtension) {
      setToast("Choose a browser-playable MP4, WebM, or M4V video.");
      return;
    }
    if (nextFile.size > 90 * 1024 * 1024) {
      setToast("Keep the reel under 90 MB for this MVP.");
      return;
    }
    const selectionGeneration = ++videoSelectionGenerationRef.current;
    const localUrl = URL.createObjectURL(nextFile);
    setToast("Checking that this browser can preview the video.");
    let previewMetadata: Awaited<ReturnType<typeof loadBrowserVideoMetadata>>;
    try {
      previewMetadata = await loadBrowserVideoMetadata(localUrl);
    } catch (error) {
      URL.revokeObjectURL(localUrl);
      if (selectionGeneration === videoSelectionGenerationRef.current) {
        setToast(
          error instanceof Error
            ? error.message
            : "Use a browser-playable H.264 MP4 or WebM file.",
        );
      }
      return;
    }
    if (selectionGeneration !== videoSelectionGenerationRef.current) {
      URL.revokeObjectURL(localUrl);
      return;
    }

    const previousJob = job;
    await cancelRemoteJob(previousJob);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    suppressHistoryTrackingRef.current = true;
    publishRevisionHistory(
      createRevisionHistory({
        ...editorDocument,
        activePresetName: "Pulse",
        captions: [],
      }),
    );
    removePersistedDraft();
    setFile(nextFile);
    setMediaIdentity({
      name: nextFile.name,
      type: nextFile.type,
      size: nextFile.size,
      lastModified: nextFile.lastModified,
      durable: usingDurableMedia,
    });
    setVideoUrl(localUrl);
    setDuration(previewMetadata.duration);
    setVideoRatio(previewMetadata.width / previewMetadata.height);
    setVideoDimensions({
      width: previewMetadata.width,
      height: previewMetadata.height,
    });
    setCurrentTime(0);
    setCaptions([]);
    setSelectedCaptionId("");
    setSelectedWordIndex(0);
    setCaptionDrafts({});
    setLoopRange(null);
    setJob(null);
    setProjectSession(null);
    setProjectRenderJob(null);
    setProjectAccessDenied(false);
    setHasChanges(false);
    setRenderPreflight(null);
    pendingRenderRevisionRef.current = "";
    setPendingRenderRevision("");
    setLastRenderedRevision("");
    setDraftSaveState({ status: "idle" });
    setActivePresetName("Pulse");
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

  const addCaptionForGap = (gap: CoverageInterval) => {
    const manualIdBase = `manual-gap-${Math.round(
      gap.start * 1000,
    ).toString(36)}-${Math.round(gap.end * 1000).toString(36)}`;
    const matchingManualCaptions = captions.filter((caption) =>
      caption.id.startsWith(manualIdBase),
    ).length;
    const manualId = matchingManualCaptions
      ? `${manualIdBase}-${matchingManualCaptions + 1}`
      : manualIdBase;
    const captionLanguage: Caption["language"] =
      language === "brx-IN" ? "brx" : "as";
    const manualCaption = normalizeCaptionDisplaySizes([
      createManualCaptionForGap(gap, {
        id: manualId,
        language: captionLanguage,
      }) as Caption,
    ])[0];
    setCaptions((items) =>
      [...items, manualCaption].sort(
        (left, right) => left.start - right.start || left.end - right.end,
      ),
    );
    setCaptionDrafts((current) => {
      const next = { ...current };
      delete next[manualId];
      return next;
    });
    setSelectedCaptionId(manualId);
    setSelectedWordIndex(0);
    setLoopRange(null);
    setTab("review");
    setHasChanges(true);
    videoRef.current?.pause();
    jumpTo(gap.start);
    setToast(
      "Manual caption added. Replace “Type-here” with the words you hear, then check coverage again.",
    );
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
      setToast("Caption review complete. Pick a look.");
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

  const setSelectedWordDisplaySize = (displaySize: "small" | "large") => {
    if (!selectedCaption || !selectedWord) return;
    updateCaptionWords(selectedCaption.id, (words) => {
      words[selectedWordIndex] = {
        ...words[selectedWordIndex],
        displaySize,
      };
      return words;
    });
    setToast(
      displaySize === "large"
        ? "That word now lands large."
        : "That word now sits small.",
    );
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
          displaySize: "small",
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
      !["ready", "review_required", "complete"].includes(job.status) ||
      (!usingDurableMedia && !apiBase) ||
      !captions.length
    ) {
      return;
    }
    if (
      usingDurableMedia &&
      ((projectSession && projectAccessDenied) ||
        (!projectSession && !job.capabilityToken))
    ) {
      const message =
        "This recovered draft needs project authorization before it can render again.";
      setRenderPreflight({
        code: "render_authorization_required",
        message,
        coverage: job.alignment?.coverage ?? null,
        uncoveredIntervals,
      });
      setToast(message);
      return;
    }
    if (job.status === "review_required" && !hasChanges) {
      const message =
        "Add or repair a caption in each speech gap, then check coverage again.";
      setRenderPreflight((current) => ({
        code: current?.code ?? "caption_coverage_incomplete",
        message,
        coverage: current?.coverage ?? job.alignment?.coverage ?? null,
        uncoveredIntervals,
      }));
      setTab("review");
      setToast(message);
      return;
    }
    setUploading(true);
    setLoopRange(null);
    videoRef.current?.pause();
    let attemptedProjectDispatch = false;
    try {
      if (usingDurableMedia && projectSession) {
        const width =
          videoDimensions.width || videoRef.current?.videoWidth || 0;
        const height =
          videoDimensions.height || videoRef.current?.videoHeight || 0;
        if (width < 16 || height < 16 || duration <= 0) {
          throw new Error(
            "Video metadata is still loading. Wait a moment and try again.",
          );
        }

        const latestHistory = commitRevision(
          revisionHistoryRef.current,
          editorDocument,
        );
        if (latestHistory !== revisionHistoryRef.current) {
          publishRevisionHistory(latestHistory);
        }
        const submittedEditorRevision = latestHistory.present.revisionId;
        let revisionId = projectSession.headRevisionId;
        const needsRevisionSave =
          !revisionId ||
          projectSession.headEditorRevisionId !== submittedEditorRevision;
        let submittedProjectDocument: ReturnType<
          typeof projectDocumentFromEditor
        > | null = null;

        if (needsRevisionSave) {
          const speechIntervals = job.alignment?.coverage?.speechIntervals;
          submittedProjectDocument = projectDocumentFromEditor({
            sourceAssetId: projectSession.sourceAssetId,
            durationSeconds: duration,
            canvas: { width, height },
            languageCode: language,
            captions,
            style: captionStyle,
            speechIntervals: Array.isArray(speechIntervals)
              ? speechIntervals
              : undefined,
            requestedStatus: "ready",
          });
          const revision = await createProjectRevision(
            fetch,
            projectSession.projectId,
            {
              baseRevisionId: projectSession.headRevisionId,
              document: submittedProjectDocument,
              changeSummary:
                job.status === "review_required"
                  ? "Repair missing speech captions"
                  : "Save caption and style edits",
            },
          );
          revisionId = revision.id;
          setProjectSession((current) =>
            current && current.projectId === projectSession.projectId
              ? {
                  ...current,
                  headRevisionId: revision.id,
                  headEditorRevisionId: submittedEditorRevision,
                  activeRenderIdempotencyKey: null,
                  activeRenderRequestScope: null,
                  activeRenderAttemptDiscriminator: null,
                }
              : current,
          );
          if (
            revisionHistoryRef.current.present.revisionId ===
            submittedEditorRevision
          ) {
            const cleanHistory = markRevisionBase(
              revisionHistoryRef.current,
            );
            publishRevisionHistory(cleanHistory);
            setHasChanges(false);
          }

          const freshCoverage = (
            submittedProjectDocument.captionTrack as typeof submittedProjectDocument.captionTrack & {
              coverage: CaptionCoverageSummary;
            }
          ).coverage;
          setJob((current) =>
            current
              ? (jobAfterProjectRevisionSave(
                  current,
                  submittedProjectDocument,
                  captions,
                ) as JobResponse)
              : current,
          );
          if (submittedProjectDocument.captionTrack.status === "review_required") {
            const diagnostics: RenderPreflight = {
              code: "caption_coverage_incomplete",
              message:
                "Some spoken audio is still missing a caption. Repair every highlighted gap before export.",
              coverage: freshCoverage,
              uncoveredIntervals: normalizeUncoveredIntervals(
                freshCoverage.uncoveredIntervals,
                duration,
              ) as CoverageInterval[],
            };
            setRenderPreflight(diagnostics);
            setTab("review");
            setToast(diagnostics.message);
            return;
          }
        }

        if (!revisionId) {
          throw new Error("The project revision could not be saved.");
        }
        const exportSpec = {
          width,
          height,
          fps: "source" as const,
          quality: "balanced",
          container: "mp4",
          videoCodec: "h264",
          audioCodec: "aac",
          captionMode: "burned",
        };
        const renderRequestScope = projectRenderRequestScope(
          revisionId,
          exportSpec,
        );
        const renderDispatchIdentity = await selectProjectRenderDispatchIdentity(
          projectSession,
          revisionId,
          renderRequestScope,
        );
        const renderIdempotencyKey =
          renderDispatchIdentity.idempotencyKey;
        const dispatchSession = {
          ...projectSession,
          headRevisionId: revisionId,
          headEditorRevisionId: submittedEditorRevision,
          activeRenderJobId: null,
          activeRenderIdempotencyKey: renderIdempotencyKey,
          activeRenderRequestScope: renderRequestScope,
          activeRenderAttemptDiscriminator:
            renderDispatchIdentity.attemptDiscriminator,
        } satisfies ProjectSession;
        const dispatchSessionPersisted = await persistProjectSession(
          dispatchSession,
        );
        if (
          renderDispatchIdentity.attemptDiscriminator &&
          !dispatchSessionPersisted
        ) {
          throw new Error(
            "The render retry could not be saved locally. Free browser storage and try again.",
          );
        }
        attemptedProjectDispatch = true;
        const renderJob = (await createProjectRenderJob(
          fetch,
          projectSession.projectId,
          {
            revisionId,
            exportSpec,
            idempotencyKey: renderIdempotencyKey,
          },
        )) as ProjectRenderJob;
        pendingRenderRevisionRef.current = submittedEditorRevision;
        setPendingRenderRevision(submittedEditorRevision);
        setRenderPreflight(null);
        setProjectRenderJob(renderJob);
        if (["failed", "cancelled"].includes(renderJob.status)) {
          pendingRenderRevisionRef.current = "";
          setPendingRenderRevision("");
          await persistProjectSession(
            projectSessionAfterTerminalRender(
              dispatchSession,
              renderRequestScope,
              renderJob.id,
            ) as ProjectSession,
          );
          setJob((current) =>
            current
              ? {
                  ...current,
                  status: current.alignment?.coverage?.complete
                    ? "ready"
                    : "review_required",
                  message:
                    renderJob.status === "cancelled"
                      ? "The previous render was cancelled. Retry when you are ready."
                      : "The previous render failed. Retry this saved revision when you are ready.",
                }
              : current,
          );
          setToast(
            "The previous attempt is terminal and was not reopened. Choose Make my video to start a new attempt.",
          );
          return;
        }
        setProjectSession((current) =>
          current && current.projectId === projectSession.projectId
            ? {
                ...current,
                activeRenderJobId: renderJob.id,
                activeRenderIdempotencyKey: renderIdempotencyKey,
                activeRenderRequestScope: renderRequestScope,
                activeRenderAttemptDiscriminator:
                  renderDispatchIdentity.attemptDiscriminator,
              }
            : current,
        );
        setJob((current) =>
          current
            ? {
                ...current,
                status: "rendering",
                progress: renderJob.progress,
                message: renderJob.message,
                updatedAt: renderJob.updatedAt,
              }
            : current,
        );
        setTab("export");
        setToast(
          job.status === "review_required"
            ? "Coverage passed. Your immutable revision is rendering now."
            : "Saved revision is rendering. You can keep editing while it runs.",
        );
        return;
      }

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
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const diagnostics = normalizeRenderPreflight(payload, {
          durationSeconds: duration,
          fallbackMessage: "The render preflight failed. Review this draft and try again.",
        }) as RenderPreflight;
        setRenderPreflight(diagnostics);
        if (
          diagnostics.code === "caption_coverage_incomplete" ||
          diagnostics.code === "caption_coverage_unverified"
        ) {
          pendingRenderRevisionRef.current = "";
          setPendingRenderRevision("");
          setJob((current) =>
            current
              ? {
                  ...current,
                  status: "review_required",
                  message: diagnostics.message,
                  alignment:
                    current.alignment && diagnostics.coverage
                      ? {
                          ...current.alignment,
                          coverage: diagnostics.coverage,
                        }
                      : current.alignment,
                }
              : current,
          );
          setTab("review");
        }
        setToast(diagnostics.message);
        return;
      }
      const data = payload as JobResponse;
      const submittedRevision = revisionHistoryRef.current.present.revisionId;
      pendingRenderRevisionRef.current = submittedRevision;
      setPendingRenderRevision(submittedRevision);
      setRenderPreflight(null);
      setJob({
        ...data,
        capabilityToken: job.capabilityToken,
      });
      setTab("export");
      setToast(
        job.status === "review_required"
          ? "Coverage passed. Your final render is now running."
          : "Final render started. You can keep editing this draft while it runs.",
      );
    } catch (error) {
      if (
        error instanceof ProjectClientError &&
        error.code === "revision_conflict"
      ) {
        const message =
          "This project changed in another tab. Reload that revision before saving over it.";
        setRenderPreflight({
          code: "revision_conflict",
          message,
          coverage: job.alignment?.coverage ?? null,
          uncoveredIntervals,
        });
        setToast(message);
      } else if (
        error instanceof ProjectClientError &&
        error.code === "invalid_project_coverage"
      ) {
        const message =
          "Speech coverage changed while saving. Review the highlighted gaps and try again.";
        setRenderPreflight({
          code: error.code,
          message,
          coverage: job.alignment?.coverage ?? null,
          uncoveredIntervals,
        });
        setTab("review");
        setToast(message);
      } else if (
        error instanceof ProjectClientError &&
        error.status === 401
      ) {
        setProjectAccessDenied(true);
        setToast("Project access expired in this browser.");
      } else if (
        attemptedProjectDispatch &&
        error instanceof ProjectClientError &&
        error.code === "idempotency_conflict"
      ) {
        setToast(
          "The saved render identity conflicts with different input. Reload before trying again.",
        );
      } else if (
        attemptedProjectDispatch &&
        (!(error instanceof ProjectClientError) ||
          error.status === 429 ||
          error.status >= 500)
      ) {
        setToast(
          "Your revision is saved. Render dispatch is temporarily unavailable; try Make my video again.",
        );
      } else {
        setToast(error instanceof Error ? error.message : "Render failed.");
      }
    } finally {
      setUploading(false);
    }
  };

  const downloadResult = async (kind: "video" | "ass") => {
    let resultPath = kind === "video" ? job?.downloadUrl : job?.assUrl;
    if (projectSession) {
      resultPath = "";
      const artifactKind = kind === "video" ? "video" : "captions_ass";
      const completedRenderJobId = projectSession.lastCompletedRenderJobId;
      const exactArtifactId =
        kind === "video" ? projectSession.lastExportArtifactId : null;
      let artifact =
        completedRenderJobId &&
        projectRenderJob?.id === completedRenderJobId &&
        projectRenderJob.status === "succeeded"
          ? (selectCompletedRenderArtifact(
              projectRenderJob.artifacts,
              completedRenderJobId,
              artifactKind,
              exactArtifactId,
            ) as ProjectArtifact | null)
          : null;

      if (exactArtifactId) {
        resultPath =
          artifact?.contentUrl ??
          projectExportContentUrl(projectSession.projectId, exactArtifactId);
      } else if (artifact) {
        resultPath = artifact.contentUrl;
      }

      if (!resultPath && completedRenderJobId) {
        try {
          const payload = await listProjectExports(
            fetch,
            projectSession.projectId,
          );
          artifact = selectCompletedRenderArtifact(
            Array.isArray(payload.exports) ? payload.exports : [],
            completedRenderJobId,
            artifactKind,
            exactArtifactId,
          ) as ProjectArtifact | null;
        } catch (error) {
          setToast(
            error instanceof Error
              ? error.message
              : "The export list could not be loaded.",
          );
          return;
        }
        resultPath = artifact?.contentUrl;
      }
    }
    if (!resultPath) {
      setToast(`${kind === "video" ? "Video" : "ASS file"} is not ready.`);
      return;
    }
    const link = document.createElement("a");
    if (projectSession) {
      const downloadUrl = new URL(resultPath, window.location.href);
      downloadUrl.searchParams.set("download", "1");
      link.href = downloadUrl.toString();
      link.download = kind === "video" ? "subtitles-by-miithii.mp4" : "subtitles-by-miithii.ass";
    } else {
      link.href = `${jobsBase}${resultPath}`;
    }
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
      setSelectedWordIndex(0);
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
      if (hasChanges) {
        void startRender();
      } else {
        setToast(
          coverageMessage ??
            "Caption every speech gap before exporting this draft.",
        );
      }
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
    if (job.status === "review_required") {
      return hasChanges ? "Check coverage again" : "Review missing speech";
    }
    if (tab === "review") {
      return "Choose a caption look";
    }
    if (tab === "style") return "Continue to export";
    if (draftNeedsAuthorization && hasChanges) return "Render access required";
    if (job.status === "ready") return "Make my video";
    if (job.status === "complete" && hasChanges) return "Update final video";
    return "Download final MP4";
  })();
  const renderedCurrentRevision = Boolean(
    lastRenderedRevision &&
      historyControls.currentRevisionId === lastRenderedRevision,
  );
  const draftSaveLabel = (() => {
    if (draftSaveState.status === "error") return "Draft save failed";
    if (draftSaveState.status === "saving") return "Saving…";
    if (draftSaveState.status === "idle") return "Not saved yet";
    if (pendingRenderRevision) return "Saved · render pending";
    if (hasChanges) return "Saved · not rendered";
    if (renderedCurrentRevision) return "Saved · rendered";
    return "Draft saved";
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
          aria-label="subtitles by miithii home"
        >
          <Image
            src="/miithii-mark.svg"
            alt=""
            width={38}
            height={32}
            priority
          />
          <span>
            <strong>subtitles</strong>
            <small>by miithii</small>
          </span>
        </button>
        <div className="header-actions">
          {hasProject && (
            <span
              className={`draft-save-state ${draftSaveState.status}`}
              role="status"
              title={draftSaveState.message ?? draftSaveLabel}
            >
              <i aria-hidden="true" />
              {draftSaveLabel}
            </span>
          )}
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
            <small>
              {engineState === "online"
                ? "Engine ready"
                : engineState === "waking"
                  ? "Engine starting"
                  : "Engine offline"}
            </small>
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
              Reload subtitles
            </button>
          </div>
        </section>
      )}

      {!hasProject ? (
        <section className="launch">
          <div className="launch-copy">
            <span className="eyebrow">SUBTITLES · BY MIITHII</span>
            <h1>
              Make every word <em>land.</em>
            </h1>
            <p>
              Add an Assamese or Bodo video, refine every line, then play with
              large and small words before you export.
            </p>
          </div>

          <div className="launch-card">
            <div className="language-row">
              <span>Spoken language</span>
              <div>
                {[
                  ["as-IN", "অসমীয়া · Assamese"],
                  ["brx-IN", "बड़ो · Bodo"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={language === value ? "active" : ""}
                    onClick={() => {
                      setLanguage(value as SupportedLanguage);
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
                      : "Keep mixed words"}
                </strong>
              </summary>
              <div>
                {[
                  ["codemix", "Keep mixed words"],
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
              <small>up to 3 min · 90 MB</small>
            </button>
          </div>

          <ol className="promise-row" aria-label="How subtitles by miithii works">
            <li>
              <b>1</b>
              <div>
                <strong>First-pass captions</strong>
                <span>Assamese or Bodo, ready to review</span>
              </div>
            </li>
            <li>
              <b>2</b>
              <div>
                <strong>Play with words</strong>
                <span>Make each one small or large</span>
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
                    setVideoDimensions({
                      width: event.currentTarget.videoWidth,
                      height: event.currentTarget.videoHeight,
                    });
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
                onError={() => {
                  setPlaying(false);
                  setToast(
                    showingFinal
                      ? "The final video could not be played in this browser. Download it to inspect the file."
                      : "This browser cannot preview that source. Use a browser-playable H.264 MP4 or WebM file.",
                  );
                }}
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
                      className={`${
                        word.displaySize === "large"
                          ? "word-size-large"
                          : "word-size-small"
                      } ${activeWord?.id === word.id ? "active" : ""}`}
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
                  ["review", "1", "Words"],
                  ["style", "2", "Style"],
                  ["export", "3", "Export"],
                ] as const
              ).map(([value, number, label]) => (
                <button
                  key={value}
                  className={tab === value ? "active" : ""}
                  onClick={() => setTab(value)}
                  disabled={!captions.length && value !== "review"}
                  role="tab"
                  id={`workflow-tab-${value}`}
                  aria-controls={`workflow-panel-${value}`}
                  aria-selected={tab === value}
                  tabIndex={tab === value ? 0 : -1}
                  onKeyDown={(event) => {
                    if (![
                      "ArrowLeft",
                      "ArrowRight",
                      "Home",
                      "End",
                    ].includes(event.key)) return;
                    event.preventDefault();
                    const available: Array<"review" | "style" | "export"> =
                      captions.length
                        ? ["review", "style", "export"]
                        : ["review"];
                    const currentIndex = available.indexOf(tab);
                    const nextIndex = event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? available.length - 1
                        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
                    const nextTab = available[nextIndex];
                    setTab(nextTab);
                    requestAnimationFrame(() => {
                      document.getElementById(`workflow-tab-${nextTab}`)?.focus();
                    });
                  }}
                >
                  <i>{number}</i>
                  <span>{label}</span>
                </button>
              ))}
            </nav>

            <div
              className="tool-body"
              role="tabpanel"
              id={`workflow-panel-${tab}`}
              aria-labelledby={`workflow-tab-${tab}`}
            >
              {(job?.status === "review_required" || renderPreflight) && (
                <div className="coverage-warning" role="alert">
                  <strong>
                    {renderPreflight &&
                    !renderPreflight.code.startsWith("caption_coverage")
                      ? "Render check needs attention"
                      : "Speech coverage needs review"}
                  </strong>
                  <span>{coverageMessage}</span>
                  {uncoveredIntervals.length > 0 && (
                    <ol className="coverage-gap-list">
                      {uncoveredIntervals.map((gap, index) => {
                        const hasManualCaption = captions.some(
                          (caption) =>
                            caption.id.startsWith("manual-gap-") &&
                            caption.start < gap.end &&
                            caption.end > gap.start,
                        );
                        return (
                          <li key={`${gap.start}-${gap.end}`}>
                            <button
                              className="coverage-gap-seek"
                              onClick={() => {
                                setTab("review");
                                videoRef.current?.pause();
                                seek(gap.start);
                              }}
                            >
                              <b>Gap {index + 1}</b>
                              <small>
                                {compactTime(gap.start)}–{compactTime(gap.end)} ·{" "}
                                {gap.duration.toFixed(1)}s
                              </small>
                            </button>
                            <button
                              className="coverage-gap-add"
                              onClick={() => addCaptionForGap(gap)}
                              disabled={hasManualCaption}
                            >
                              {hasManualCaption
                                ? "Caption added"
                                : "Add caption here"}
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  {job?.status === "review_required" &&
                    uncoveredIntervals.length === 0 && (
                      <small className="coverage-no-gaps">
                        The engine could not provide trustworthy gap locations.
                        Edit any known missing line, then run the check again.
                      </small>
                    )}
                  {job?.status === "review_required" && (
                    <button
                      className="coverage-recheck"
                      onClick={() => void startRender()}
                      disabled={uploading || !hasChanges}
                    >
                      {uploading
                        ? "Checking coverage…"
                        : hasChanges
                          ? "Check coverage again"
                          : "Edit a gap to recheck"}
                    </button>
                  )}
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
                      <h2>Make every word land.</h2>
                      <p>Fix the line, select a word, then make it small or large.</p>
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
                      <span>Select a word to edit its timing and size.</span>
                      <button onClick={commitCaptionDraft}>Save text</button>
                    </div>

                    <div className="word-strip" aria-label="Words in this caption">
                      {selectedWords.map((word, index) => (
                        <button
                          key={word.id}
                          className={`${
                            index === selectedWordIndex ? "active" : ""
                          } ${
                            word.displaySize === "large"
                              ? "word-is-large"
                              : "word-is-small"
                          }`}
                          aria-label={`${word.text}, ${
                            word.displaySize === "large" ? "large" : "small"
                          }`}
                          aria-pressed={index === selectedWordIndex}
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
                      <fieldset className="word-size-control">
                        <legend>Word size</legend>
                        <button
                          type="button"
                          aria-pressed={selectedWord.displaySize !== "large"}
                          className={
                            selectedWord.displaySize !== "large" ? "active" : ""
                          }
                          onClick={() => setSelectedWordDisplaySize("small")}
                        >
                          Small
                        </button>
                        <button
                          type="button"
                          aria-pressed={selectedWord.displaySize === "large"}
                          className={
                            selectedWord.displaySize === "large" ? "active" : ""
                          }
                          onClick={() => setSelectedWordDisplaySize("large")}
                        >
                          Large
                        </button>
                      </fieldset>
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
                            ? "shape the overall look next"
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
                    <small>STEP 2 · STYLE</small>
                    <h2>Shape the rhythm.</h2>
                    <p>
                      Your small and large word choices stay intact in every look.
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
                              preset.values.backgroundColor ??
                                miithiiColors.teal950,
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
                        <small>color, base size, motion and position</small>
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
                      showingFinal
                        ? "ready"
                        : job?.status === "review_required"
                          ? "blocked"
                          : ""
                    }`}
                  >
                    <span>
                      {showingFinal
                        ? "✓"
                        : job?.status === "review_required"
                          ? "!"
                        : job?.status === "rendering"
                          ? "↻"
                          : "→"}
                    </span>
                    <div>
                      <small>
                        {showingFinal
                          ? "READY"
                          : job?.status === "review_required"
                            ? "COVERAGE REVIEW REQUIRED"
                          : job?.status === "rendering"
                            ? "MAKING YOUR VIDEO"
                            : "STEP 3 · EXPORT"}
                      </small>
                      <h2>
                        {showingFinal
                          ? "Ready to post."
                          : job?.status === "review_required"
                            ? "Caption the missing speech first."
                          : job?.status === "rendering"
                            ? "Adding captions to every frame…"
                            : "Happy with the preview?"}
                      </h2>
                      <p>
                        {showingFinal
                          ? "Download it and post wherever your audience is."
                          : job?.status === "review_required"
                            ? coverageMessage
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
                        <small>miithii creates a separate downloadable copy</small>
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
                      <strong>Small + large, exactly as chosen</strong>
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

                  {job?.status === "review_required" && (
                    <div className="export-actions">
                      <button
                        className="secondary"
                        onClick={() => setTab("review")}
                      >
                        Review speech gaps
                      </button>
                      <button
                        className="primary"
                        onClick={() => void startRender()}
                        disabled={uploading || !hasChanges}
                      >
                        {uploading ? "Checking…" : "Check coverage again"}
                        <span>↻</span>
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
                      <button onClick={() => void downloadResult("video")}>
                        Download final MP4
                        <span>↓</span>
                      </button>
                      <button onClick={() => void downloadResult("ass")}>
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
        accept=".mp4,.webm,.m4v,video/mp4,video/webm,video/x-m4v"
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
