"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";

type WordTiming = {
  id: string;
  text: string;
  start: number;
  end: number;
  confidence: number;
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
};

type JobStatus =
  | "queued"
  | "extracting"
  | "transcribing"
  | "ready"
  | "rendering"
  | "complete"
  | "failed"
  | "cancelled";

type JobResponse = {
  id: string;
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

const hostedRenderApi = "https://syncword-render-dhrub404.onrender.com";

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

async function pingRenderEngine(apiBase: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${apiBase}/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
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
  return (
    word.confidence < 0.35 ||
    !["mms-fa", "manual"].includes(word.source)
  );
}

function confidenceLabel(word: WordTiming) {
  if (word.source === "manual") return "Adjusted";
  if (word.source === "mms-fa-star") return "Recovered";
  if (word.source === "speech-window-review") return "Boundary";
  if (word.source === "grapheme-prior") return "Estimated";
  if (word.confidence < 0.35) return "Check";
  return "Aligned";
}

export default function Home() {
  const [tab, setTab] = useState<StudioTab>("review");
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [duration, setDuration] = useState(0);
  const [videoRatio, setVideoRatio] = useState(9 / 16);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [language, setLanguage] = useState("unknown");
  const [transcriptMode, setTranscriptMode] =
    useState<TranscriptMode>("codemix");
  const [captionStyle, setCaptionStyle] = useState(defaultStyle);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [selectedCaptionId, setSelectedCaptionId] = useState("");
  const [selectedWordIndex, setSelectedWordIndex] = useState(0);
  const [approvedWordIds, setApprovedWordIds] = useState<string[]>([]);
  const [loopRange, setLoopRange] = useState<LoopRange>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [engineState, setEngineState] =
    useState<EngineState>("offline");
  const [hasChanges, setHasChanges] = useState(false);
  const [toast, setToast] = useState("");
  const [captionDrafts, setCaptionDrafts] = useState<
    Record<string, string>
  >({});
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientSnapshot,
    serverSnapshot,
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

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
  const approvedWordIdSet = new Set(approvedWordIds);
  const selectedItem = flatWords.find(
    (item) =>
      item.captionId === selectedCaption?.id &&
      item.wordIndex === selectedWordIndex,
  );
  const flaggedItems = flatWords.filter((item) =>
    isReviewCandidate(item.word),
  );
  const unresolvedItems = flaggedItems.filter(
    (item) => !approvedWordIdSet.has(item.word.id),
  );
  const verifiedWords = Math.max(0, flatWords.length - unresolvedItems.length);
  const reviewPercent = flatWords.length
    ? Math.round((verifiedWords / flatWords.length) * 100)
    : 0;
  const alignment = job?.alignment;
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
  const activeWord = activeWordGroup.find((word, index) => {
    const displayEnd =
      activeWordGroup[index + 1]?.start ?? word.end;
    return currentTime >= word.start && currentTime < displayEnd;
  });
  const selectedGlobalIndex = selectedItem?.globalIndex ?? -1;
  const previousGlobalWord =
    selectedGlobalIndex > 0 ? flatWords[selectedGlobalIndex - 1]?.word : null;
  const nextGlobalWord =
    selectedGlobalIndex >= 0
      ? flatWords[selectedGlobalIndex + 1]?.word ?? null
      : null;
  const timingNeighborhood = selectedItem
    ? flatWords.slice(
        Math.max(0, selectedItem.globalIndex - 2),
        Math.min(flatWords.length, selectedItem.globalIndex + 3),
      )
    : [];
  const isLooping = Boolean(loopRange);

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
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

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
        if (await pingRenderEngine(apiBase)) {
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
      ["ready", "complete", "failed", "cancelled"].includes(job.status)
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
          setToast("Sync preview ready. Review the flagged words.");
        } else if (next.status === "complete") {
          setTab("export");
          setToast("Final ASS-burned MP4 is ready.");
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
        if (await pingRenderEngine(apiBase)) {
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
      setJob(data);
      setToast("Upload complete. Building the sync preview—no render yet.");
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
    setFile(null);
    setVideoUrl("");
    setDuration(0);
    setCurrentTime(0);
    setCaptions([]);
    setSelectedCaptionId("");
    setSelectedWordIndex(0);
    setApprovedWordIds([]);
    setCaptionDrafts({});
    setLoopRange(null);
    setJob(null);
    setHasChanges(false);
    setTab("review");
  };

  const cancelProcessing = () => {
    const jobToCancel = job;
    clearProject();
    void cancelRemoteJob(jobToCancel);
    setToast("Processing cancelled. The queue slot is free.");
  };

  const acceptVideo = async (nextFile: File) => {
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
    setFile(nextFile);
    setVideoUrl(localUrl);
    setDuration(0);
    setCurrentTime(0);
    setCaptions([]);
    setSelectedCaptionId("");
    setSelectedWordIndex(0);
    setApprovedWordIds([]);
    setCaptionDrafts({});
    setLoopRange(null);
    setJob(null);
    setHasChanges(false);
    setTab("review");
    void uploadVideo(nextFile);
  };

  const markWordsHandled = (ids: string[]) => {
    setApprovedWordIds((current) => [
      ...new Set([...current, ...ids.filter(Boolean)]),
    ]);
  };

  const selectReviewItem = (item: ReviewItem, shouldLoop = false) => {
    setSelectedCaptionId(item.captionId);
    setSelectedWordIndex(item.wordIndex);
    setLoopRange(null);
    const start = Math.max(0, item.word.start - 0.12);
    setCurrentTime(start);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = start;
    }
    if (shouldLoop) {
      window.setTimeout(() => {
        const range = {
          start: Math.max(0, item.word.start - 0.48),
          end: Math.min(duration, item.word.end + 0.48),
        };
        setLoopRange(range);
        if (videoRef.current) {
          videoRef.current.currentTime = range.start;
          void videoRef.current.play();
        }
      }, 40);
    }
  };

  const goToNextIssue = () => {
    const next =
      unresolvedItems.find(
        (item) => item.globalIndex > (selectedItem?.globalIndex ?? -1),
      ) ?? unresolvedItems[0];
    if (next) {
      setTab("review");
      selectReviewItem(next, true);
    } else {
      setLoopRange(null);
      setToast("Sync check complete. Choose a caption style.");
      setTab("style");
    }
  };

  const approveSelectedAndContinue = () => {
    if (!selectedWord) return;
    markWordsHandled([selectedWord.id]);
    const remaining = unresolvedItems.filter(
      (item) => item.word.id !== selectedWord.id,
    );
    const next =
      remaining.find(
        (item) => item.globalIndex > (selectedItem?.globalIndex ?? -1),
      ) ?? remaining[0];
    setLoopRange(null);
    if (next) {
      selectReviewItem(next, true);
      setToast("Approved. Playing the next flagged word.");
    } else {
      videoRef.current?.pause();
      setToast("Every flagged word is handled. Style when you are ready.");
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
    markWordsHandled([selectedWord.id]);
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
    if (sameWordCount) {
      markWordsHandled(selectedCaption.words.map((word) => word.id));
      setToast("Caption text updated. Word timing stayed intact.");
    } else {
      setApprovedWordIds((current) =>
        current.filter(
          (id) => !selectedCaption.words.some((word) => word.id === id),
        ),
      );
      setToast("Caption updated. Check the new word boundaries before export.");
    }
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
    markWordsHandled([selectedWord.id]);
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
    markWordsHandled([selectedWord.id]);
    setCurrentTime(nextStart);
    if (videoRef.current) videoRef.current.currentTime = nextStart;
  };

  const shiftSelectedPhrase = (delta: number) => {
    if (!selectedCaption?.words.length) return;
    const captionIndex = captions.findIndex(
      (caption) => caption.id === selectedCaption.id,
    );
    const first = selectedCaption.words[0];
    const last = selectedCaption.words.at(-1)!;
    const previousEnd =
      captions[captionIndex - 1]?.words.at(-1)?.end ?? 0;
    const nextStart =
      captions[captionIndex + 1]?.words[0]?.start ??
      Math.max(duration, last.end);
    const resolvedDelta = clamp(
      delta,
      previousEnd - first.start,
      nextStart - last.end,
    );
    updateCaptionWords(selectedCaption.id, (words) =>
      words.map((word) => ({
        ...word,
        start: Number((word.start + resolvedDelta).toFixed(3)),
        end: Number((word.end + resolvedDelta).toFixed(3)),
        confidence: 1,
        source: "manual",
      })),
    );
    markWordsHandled(selectedCaption.words.map((word) => word.id));
    const nextTime = Math.max(0, currentTime + resolvedDelta);
    setCurrentTime(nextTime);
    if (videoRef.current) videoRef.current.currentTime = nextTime;
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
    setLoopRange(range);
    videoRef.current.currentTime = range.start;
    void videoRef.current.play();
  };

  const startRender = async (allowUnresolved = false) => {
    if (
      !job ||
      !["ready", "complete"].includes(job.status) ||
      (!usingDurableMedia && !apiBase) ||
      !captions.length
    ) {
      return;
    }
    if (unresolvedItems.length && !allowUnresolved) {
      setTab("export");
      setToast(
        `${unresolvedItems.length} flagged word${
          unresolvedItems.length === 1 ? "" : "s"
        } still need a decision.`,
      );
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
      setToast("Final render started. Your reviewed timing is locked.");
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

  const setStyle = (values: Partial<CaptionStyle>) => {
    setCaptionStyle((current) => ({ ...current, ...values }));
    setHasChanges(true);
  };

  const seek = (seconds: number) => {
    const next = Math.max(0, Math.min(duration, seconds));
    setLoopRange(null);
    setCurrentTime(next);
    if (videoRef.current) videoRef.current.currentTime = next;
  };

  const togglePlayback = () => {
    if (!videoRef.current) return;
    setLoopRange(null);
    if (videoRef.current.paused) void videoRef.current.play();
    else videoRef.current.pause();
  };

  const primaryAction = () => {
    if (!file) {
      videoInputRef.current?.click();
      return;
    }
    if (!job || ["failed", "cancelled"].includes(job.status)) {
      void uploadVideo(file);
      return;
    }
    if (tab === "review") {
      if (unresolvedItems.length) goToNextIssue();
      else setTab("style");
      return;
    }
    if (tab === "style") {
      setTab("export");
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
    if (!file) return "Choose video";
    if (!job || ["failed", "cancelled"].includes(job.status)) {
      return "Try again";
    }
    if (isProcessing) {
      return `${job.message ?? "Processing"} · ${job.progress}%`;
    }
    if (tab === "review") {
      return unresolvedItems.length
        ? `Review ${unresolvedItems.length} flagged word${
            unresolvedItems.length === 1 ? "" : "s"
          }`
        : "Continue to style";
    }
    if (tab === "style") return "Continue to export";
    if (job.status === "ready" && unresolvedItems.length) {
      return `Review ${unresolvedItems.length} words before render`;
    }
    if (job.status === "ready") return "Render final video";
    if (job.status === "complete" && hasChanges) return "Update final video";
    return "Download final MP4";
  })();

  return (
    <main className={`creator-app ${file ? "has-project" : ""}`}>
      <header className="app-header">
        <button
          className="brand"
          onClick={() => {
            if (file) {
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
          {file && (
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

      {!file ? (
        <section className="launch">
          <div className="launch-copy">
            <span className="eyebrow">AUTO CAPTIONS FOR ASSAMESE + BODO</span>
            <h1>
              Add captions.
              <br />
              <em>Fix. Export.</em>
            </h1>
            <p>
              Pick a reel. Edit the captions while it plays. Export only when
              it looks right.
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

            <div className="transcript-row">
              <span>Transcript</span>
              <div>
                {[
                  ["codemix", "Natural mix"],
                  ["verbatim", "Exact speech"],
                  ["transcribe", "Clean"],
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
                  ? "Keeps fillers and repetitions for an exact spoken transcript."
                  : transcriptMode === "transcribe"
                    ? "Cleans up speech while keeping the spoken language."
                    : "English stays English; regional speech stays in its native script."}
              </small>
            </div>

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
              <strong>Upload your reel</strong>
              <small>MVP · up to 3 min / 90 MB</small>
            </button>
          </div>

          <ol className="promise-row">
            <li>
              <b>01</b>
              <div>
                <strong>Hear</strong>
                <span>Saaras v3 builds the real code-mixed transcript</span>
              </div>
            </li>
            <li>
              <b>02</b>
              <div>
                <strong>Verify</strong>
                <span>GPU CTC alignment flags only uncertain word timing</span>
              </div>
            </li>
            <li>
              <b>03</b>
              <div>
                <strong>Export</strong>
                <span>ASS styling burns once after you approve the preview</span>
              </div>
            </li>
          </ol>

          <p className="truth-line">
            No mock transcript. No render while you edit. No surprise timing.
          </p>
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
              <span title={file.name}>{file.name}</span>
              {showingFinal ? (
                <b className="final-label">FINAL</b>
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
                  const nextTime = event.currentTarget.currentTime;
                  setCurrentTime(nextTime);
                  if (loopRange && nextTime >= loopRange.end) {
                    event.currentTarget.currentTime = loopRange.start;
                    void event.currentTarget.play();
                  }
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                playsInline
              />

              {!showingFinal && activeWordGroup.length > 0 && (
                <div
                  className={`live-caption ${captionStyle.animation}`}
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
                      ? "Your timing is locked. We are burning the final ASS captions now."
                      : "We are building an editable sync preview. FFmpeg has not started."}
                  </small>
                  <button
                    className="cancel-processing"
                    onClick={cancelProcessing}
                  >
                    Cancel processing
                  </button>
                  <ol>
                    {(job?.status === "rendering"
                      ? ["Upload", "Transcript", "Sync", "Review", "Render"]
                      : ["Upload", "Audio", "Transcript", "Word sync"]
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
              <div className="mobile-review-meter">
                <span style={{ width: `${reviewPercent}%` }} />
                <div>
                  <strong>{verifiedWords} checked</strong>
                  <small>
                    {unresolvedItems.length
                      ? `${unresolvedItems.length} need attention`
                      : "sync ready"}
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
                  ["review", "CC", "Captions"],
                  ["style", "Aa", "Style"],
                  ["export", "↑", "Export"],
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
                  {value === "review" && unresolvedItems.length > 0 && (
                    <b>{unresolvedItems.length}</b>
                  )}
                </button>
              ))}
            </nav>

            <div className="tool-body">
              {tab === "review" && !captions.length && (
                <div className="waiting-panel">
                  <span className="panel-icon">⌁</span>
                  <h2>
                    {job?.status === "failed"
                      ? "That sync needs another go."
                      : "Building your editable preview."}
                  </h2>
                  <p>
                    Saaras creates the phrases. Multilingual GPU acoustic frames
                    place every word. Rendering waits for you.
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
                <div className="review-panel">
                  <div className="review-heading">
                    <div>
                      <small>AUTO CAPTIONS</small>
                      <h2>
                        Edit what people will read.
                      </h2>
                      <p>
                        Tap a caption, fix the text, then play it back.
                      </p>
                    </div>
                    <div
                      className="review-score"
                      style={
                        { "--review": reviewPercent } as CSSProperties
                      }
                    >
                      <strong>{reviewPercent}%</strong>
                      <span>checked</span>
                    </div>
                  </div>

                  {unresolvedItems.length > 0 ? (
                    <div className="issue-queue" aria-label="Words to review">
                      <div className="section-label">
                      <span>Check suggested</span>
                        <small>{unresolvedItems.length} words</small>
                      </div>
                      <div>
                        {unresolvedItems.map((item) => (
                          <button
                            key={item.word.id}
                            className={
                              item.word.id === selectedWord.id ? "active" : ""
                            }
                            onClick={() => selectReviewItem(item, true)}
                            aria-current={
                              item.word.id === selectedWord.id
                                ? "true"
                                : undefined
                            }
                          >
                            <span>{item.word.text}</span>
                            <small>
                              {Math.round(item.word.confidence * 100)}% ·{" "}
                              {preciseTime(item.word.start)}
                            </small>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="all-clear-card">
                      <i>✓</i>
                      <div>
                        <strong>Sync check complete</strong>
                        <span>
                          Your original video is still untouched. Styling is
                          instant.
                        </span>
                      </div>
                      <button onClick={() => setTab("style")}>Style captions</button>
                    </div>
                  )}

                  <div className="selected-word-card">
                    <div className="word-card-topline">
                      <span
                        className={
                          isReviewCandidate(selectedWord) ? "attention" : ""
                        }
                      >
                        {confidenceLabel(selectedWord)}
                      </span>
                      <small>
                        Phrase{" "}
                        {String(
                          captions.findIndex(
                            (caption) => caption.id === selectedCaption.id,
                          ) + 1,
                        ).padStart(2, "0")}
                      </small>
                    </div>

                    <div className="caption-edit-field">
                      <label htmlFor="caption-text">
                        Caption text
                      </label>
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
                        aria-describedby="caption-edit-help"
                      />
                      <div>
                        <small id="caption-edit-help">
                          Change the sentence here. Tap a word below for exact
                          timing.
                        </small>
                        <button onClick={commitCaptionDraft}>Save</button>
                      </div>
                    </div>

                    <label className="word-text-field">
                      <span>Selected word</span>
                      <input
                        value={selectedWord.text}
                        onChange={(event) =>
                          updateSelectedWordText(event.target.value)
                        }
                        aria-label="Selected word text"
                      />
                    </label>

                    <button
                      className={`listen-button ${isLooping ? "active" : ""}`}
                      onClick={toggleWordLoop}
                    >
                      <i>{isLooping ? "■" : "▶"}</i>
                      <span>
                        <strong>
                          {isLooping ? "Stop listening" : "Loop this word"}
                        </strong>
                        <small>
                          {preciseTime(selectedWord.start)}–{preciseTime(selectedWord.end)}
                        </small>
                      </span>
                      <b>{Math.round(selectedWord.confidence * 100)}%</b>
                    </button>

                    <details
                      className="timing-tools"
                      key={selectedWord.id}
                      open={
                        isReviewCandidate(selectedWord) &&
                        !approvedWordIdSet.has(selectedWord.id)
                      }
                    >
                      <summary>
                        <span>Fine-tune timing</span>
                        <small>
                          {preciseTime(selectedWord.start)}–
                          {preciseTime(selectedWord.end)}
                        </small>
                      </summary>

                      <div className="timing-strip">
                        <div className="timing-ruler">
                          {timingNeighborhood.map((item) => {
                            const wordDuration = Math.max(
                              0.08,
                              item.word.end - item.word.start,
                            );
                            return (
                              <button
                                key={item.word.id}
                                className={
                                  item.word.id === selectedWord.id
                                    ? "selected"
                                    : ""
                                }
                                style={{ flexGrow: wordDuration }}
                                onClick={() => selectReviewItem(item)}
                              >
                                <span>{item.word.text}</span>
                                <small>{preciseTime(item.word.start)}</small>
                              </button>
                            );
                          })}
                        </div>
                        <div className="playhead" aria-hidden="true">
                          <span />
                        </div>
                      </div>

                      <div className="precision-controls">
                        <div className="control-row">
                          <div>
                            <span>Word start</span>
                            <strong>{selectedWord.start.toFixed(3)}s</strong>
                          </div>
                          <button
                            onClick={() => adjustSelectedEdge("start", -0.03)}
                            aria-label="Move word start 30 milliseconds earlier"
                          >
                            −30
                          </button>
                          <button
                            onClick={() => adjustSelectedEdge("start", 0.03)}
                            aria-label="Move word start 30 milliseconds later"
                          >
                            +30
                          </button>
                        </div>
                        <div className="control-row">
                          <div>
                            <span>Word end</span>
                            <strong>{selectedWord.end.toFixed(3)}s</strong>
                          </div>
                          <button
                            onClick={() => adjustSelectedEdge("end", -0.03)}
                            aria-label="Move word end 30 milliseconds earlier"
                          >
                            −30
                          </button>
                          <button
                            onClick={() => adjustSelectedEdge("end", 0.03)}
                            aria-label="Move word end 30 milliseconds later"
                          >
                            +30
                          </button>
                        </div>
                      </div>

                      <div className="shift-actions">
                        <button onClick={() => shiftSelectedWord(-0.03)}>
                          <span>←</span>
                          Word 30 ms
                        </button>
                        <button onClick={() => shiftSelectedWord(0.03)}>
                          Word 30 ms
                          <span>→</span>
                        </button>
                        <button onClick={() => shiftSelectedPhrase(-0.1)}>
                          <span>←</span>
                          Phrase 100 ms
                        </button>
                        <button onClick={() => shiftSelectedPhrase(0.1)}>
                          Phrase 100 ms
                          <span>→</span>
                        </button>
                      </div>
                    </details>

                    <button
                      className="approve-button"
                      onClick={approveSelectedAndContinue}
                    >
                      <span>
                        <strong>Done with this word</strong>
                        <small>
                          {unresolvedItems.length > 1
                            ? "save & play next suggestion"
                            : "finish caption check"}
                        </small>
                      </span>
                      <b>✓</b>
                    </button>
                  </div>

                  <div className="transcript-section">
                    <div className="section-label">
                      <span>Caption track</span>
                      <small>tap any caption</small>
                    </div>
                    <div className="phrase-tabs">
                      {captions.map((caption, index) => (
                        <button
                          key={caption.id}
                          className={
                            caption.id === selectedCaption.id ? "active" : ""
                          }
                          onClick={() => {
                            setSelectedCaptionId(caption.id);
                            setSelectedWordIndex(0);
                            seek(caption.words[0]?.start ?? caption.start);
                          }}
                        >
                          <small>
                            {compactTime(caption.start)} ·{" "}
                            {String(index + 1).padStart(2, "0")}
                          </small>
                          <span>{caption.text}</span>
                          {caption.words.some(
                            (word) =>
                              isReviewCandidate(word) &&
                              !approvedWordIdSet.has(word.id),
                          ) && <i>!</i>}
                        </button>
                      ))}
                    </div>
                    <div className="word-grid">
                      {selectedWords.map((word, index) => {
                        const needsReview =
                          isReviewCandidate(word) &&
                          !approvedWordIdSet.has(word.id);
                        return (
                          <button
                            key={word.id}
                            className={[
                              index === selectedWordIndex ? "active" : "",
                              needsReview ? "review" : "",
                              approvedWordIdSet.has(word.id)
                                ? "approved"
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            onClick={() =>
                              selectReviewItem({
                                captionId: selectedCaption.id,
                                captionIndex: captions.findIndex(
                                  (caption) =>
                                    caption.id === selectedCaption.id,
                                ),
                                wordIndex: index,
                                globalIndex:
                                  flatWords.find(
                                    (item) => item.word.id === word.id,
                                  )?.globalIndex ?? 0,
                                word,
                              })
                            }
                          >
                            <span>{word.text}</span>
                            {needsReview && <i>!</i>}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="alignment-truth">
                    <span>Alignment report</span>
                    <div>
                      <strong>
                        {alignment?.waveformAlignedWords ?? flatWords.length}/
                        {alignment?.totalWords ?? flatWords.length} acoustic
                      </strong>
                      <small>
                        {alignment?.estimatedWords
                          ? `${alignment.estimatedWords} estimated timing`
                          : "no silent timing fallback"}
                      </small>
                    </div>
                  </div>
                </div>
              )}

              {tab === "style" && (
                <div className="style-panel">
                  <div className="panel-heading">
                    <small>INSTANT CLIENT PREVIEW</small>
                    <h2>Choose the energy.</h2>
                    <p>
                      These controls change the overlay immediately. No video
                      render is running.
                    </p>
                  </div>

                  <div className="preset-row">
                    {presets.map((preset) => (
                      <button
                        key={preset.name}
                        onClick={() => setStyle(preset.values)}
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

                  <div className="style-note">
                    <i>⌁</i>
                    <div>
                      <strong>Original video stays untouched</strong>
                      <span>
                        The player uses a synchronized HTML overlay. Advanced
                        SubStation Alpha is generated only when you export.
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
                        : unresolvedItems.length
                          ? "attention"
                          : ""
                    }`}
                  >
                    <span>
                      {showingFinal
                        ? "✓"
                        : job?.status === "rendering"
                          ? "↻"
                          : unresolvedItems.length
                            ? "!"
                            : "→"}
                    </span>
                    <div>
                      <small>
                        {showingFinal
                          ? "FINAL VIDEO"
                          : job?.status === "rendering"
                            ? "RENDERING"
                            : "PRE-FLIGHT CHECK"}
                      </small>
                      <h2>
                        {showingFinal
                          ? "Ready to post."
                          : job?.status === "rendering"
                            ? "Burning the approved cut."
                            : unresolvedItems.length
                              ? `${unresolvedItems.length} timing decision${
                                  unresolvedItems.length === 1 ? "" : "s"
                                } left.`
                              : "Ready for one clean render."}
                      </h2>
                      <p>
                        {showingFinal
                          ? "The player is now showing the real burned-in MP4."
                          : job?.status === "rendering"
                            ? job.message
                            : unresolvedItems.length
                              ? "Review the flagged words for the safest result, or export anyway if the preview already feels right."
                              : "Your transcript, timing, and style are locked. FFmpeg starts only after you confirm."}
                      </p>
                    </div>
                  </div>

                  <div className="preflight-list">
                    <div className="pass">
                      <i>✓</i>
                      <span>
                        <strong>Transcript ready</strong>
                        <small>{flatWords.length} words in native script</small>
                      </span>
                    </div>
                    <div className={unresolvedItems.length ? "warn" : "pass"}>
                      <i>{unresolvedItems.length ? "!" : "✓"}</i>
                      <span>
                        <strong>Timing review</strong>
                        <small>
                          {unresolvedItems.length
                            ? `${unresolvedItems.length} unchecked`
                            : "all issues handled"}
                        </small>
                      </span>
                    </div>
                    <div className="pass">
                      <i>✓</i>
                      <span>
                        <strong>ASS style ready</strong>
                        <small>{captionStyle.animation} · {captionStyle.wordsPerCard} words/card</small>
                      </span>
                    </div>
                  </div>

                  <div className="export-spec">
                    <div>
                      <span>Video</span>
                      <strong>H.264 · AAC · fast start</strong>
                    </div>
                    <div>
                      <span>Captions</span>
                      <strong>Advanced SubStation Alpha</strong>
                    </div>
                    <div>
                      <span>Word effect</span>
                      <strong>Whole-word ASS hits</strong>
                    </div>
                    <div>
                      <span>Compatibility</span>
                      <strong>Instagram · TikTok · YouTube</strong>
                    </div>
                  </div>

                  {job?.status === "ready" && (
                    <div className="export-actions">
                      {unresolvedItems.length > 0 && (
                        <button
                          className="secondary"
                          onClick={goToNextIssue}
                        >
                          Review {unresolvedItems.length} flagged words
                        </button>
                      )}
                      <button
                        className="primary"
                        onClick={() =>
                          void startRender(unresolvedItems.length > 0)
                        }
                      >
                        {unresolvedItems.length
                          ? "Preview looks right — render anyway"
                          : "Start final render"}
                        <span>→</span>
                      </button>
                    </div>
                  )}

                  {job?.status === "complete" && hasChanges && (
                    <div className="export-actions">
                      <button
                        className="primary"
                        onClick={() =>
                          void startRender(unresolvedItems.length > 0)
                        }
                      >
                        Update final video
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
                        Download source .ASS
                      </button>
                    </div>
                  )}

                  <p className="hobby-note">
                    MVP files are temporary. Download the final MP4 before the
                    project expires.
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

      {file && (
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
