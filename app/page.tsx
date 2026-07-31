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

type StudioTab = "captions" | "style" | "export";
type EngineState = "offline" | "waking" | "online";
type TranscriptMode = "codemix" | "verbatim" | "transcribe";

const hostedRenderApi = "https://syncword-render-dhrub404.onrender.com";

const defaultStyle: CaptionStyle = {
  fontFamily: "Noto Sans Bengali",
  fontSize: 78,
  textColor: "#FFFFFF",
  highlightColor: "#D7FF38",
  backgroundColor: "#09090B",
  backgroundOpacity: 76,
  outlineColor: "#09090B",
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
    name: "Viral",
    note: "lime word hit",
    sample: "HIT",
    values: {
      textColor: "#FFFFFF",
      highlightColor: "#D7FF38",
      backgroundColor: "#09090B",
      backgroundOpacity: 76,
      outlineColor: "#09090B",
      outlineWidth: 2,
      animation: "pop",
      wordsPerCard: 4,
    },
  },
  {
    name: "Punch",
    note: "hard outline",
    sample: "LOUD",
    values: {
      textColor: "#FFFFFF",
      highlightColor: "#FF4D67",
      backgroundColor: "#09090B",
      backgroundOpacity: 0,
      outlineColor: "#09090B",
      outlineWidth: 6,
      animation: "pop",
      wordsPerCard: 3,
    },
  },
  {
    name: "Glow",
    note: "electric blue",
    sample: "NOW",
    values: {
      textColor: "#FFFFFF",
      highlightColor: "#58A6FF",
      backgroundColor: "#121A2A",
      backgroundOpacity: 54,
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
  "ready",
  "rendering",
];
const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

function compactTime(seconds: number) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const wholeSeconds = Math.floor(safe % 60);
  return `${minutes}:${wholeSeconds.toString().padStart(2, "0")}`;
}

function rgba(hex: string, opacity: number) {
  const normalized = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  const numeric = Number.parseInt(normalized, 16);
  return `rgba(${(numeric >> 16) & 255}, ${(numeric >> 8) & 255}, ${
    numeric & 255
  }, ${opacity / 100})`;
}

function wordWeight(word: string) {
  const length = Array.from(
    word.replace(/[\p{P}\p{S}]+/gu, "") || word,
  ).length;
  return Math.max(1, length ** 0.72);
}

function distributeWords(text: string, start: number, end: number) {
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  const weights = tokens.map(wordWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = start;
  return tokens.map((token, index): WordTiming => {
    const wordEnd =
      index === tokens.length - 1
        ? end
        : cursor + ((end - start) * weights[index]) / total;
    const word = {
      id: `edited-${index}-${Math.round(start * 1000)}`,
      text: token,
      start: Number(cursor.toFixed(3)),
      end: Number(wordEnd.toFixed(3)),
      confidence: 0.38,
      source: "grapheme-prior" as const,
    };
    cursor = wordEnd;
    return word;
  });
}

function statusStep(status?: JobStatus) {
  if (!status || status === "queued") return 0;
  if (status === "extracting") return 1;
  if (status === "transcribing" || status === "ready") return 2;
  if (status === "rendering") return 3;
  if (status === "complete") return 4;
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

export default function Home() {
  const [tab, setTab] = useState<StudioTab>("captions");
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
  const [job, setJob] = useState<JobResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [engineState, setEngineState] =
    useState<EngineState>("offline");
  const [hasChanges, setHasChanges] = useState(false);
  const [toast, setToast] = useState("");
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
  const selectedWords = selectedCaption?.words ?? [];
  const selectedWord = selectedWords[selectedWordIndex];
  const activeCaption =
    captions.find(
      (caption) =>
        currentTime >= caption.start && currentTime < caption.end,
    ) ?? selectedCaption;
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
  const alignment = job?.alignment;

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
      ["complete", "failed", "cancelled"].includes(job.status)
    ) {
      return;
    }
    const jobId = job.id;
    const pollingRoute = usingDurableMedia
      ? `/api/media/jobs/${jobId}`
      : `/v1/jobs/${jobId}`;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`${jobsBase}${pollingRoute}`);
        if (response.status === 404) {
          const failedJob: JobResponse = {
            ...job,
            status: "failed",
            progress: job.progress,
            message: usingDurableMedia
              ? "This temporary project expired. Upload it again to rebuild."
              : "The free render engine restarted. Tap Try again to rebuild this reel.",
          };
          setJob(failedJob);
          setToast(failedJob.message ?? "Render restarted.");
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
          setCaptions(nextCaptions);
          setSelectedCaptionId(
            (current) => current || nextCaptions[0].id,
          );
        }
        if (next.status === "complete") {
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
  }, [apiBase, job, jobsBase, usingDurableMedia]);

  const uploadVideo = async (nextFile: File) => {
    if (!apiBase) {
      setToast("The render engine is not connected to this deployment yet.");
      return;
    }
    setUploading(true);
    try {
      setEngineState("waking");
      setToast("Waking the hobby render engine. First use can take a minute.");
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
          "The free render engine is still waking. Tap Try again in a moment.",
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
        setToast("Saving the video securely before processing.");
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
      setToast("Upload complete. Building the synchronized preview first.");
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
        throw new Error(data.error ?? "Could not cancel the render.");
      }
    } catch (error) {
      setToast(
        error instanceof Error ? error.message : "Could not cancel the render.",
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
    setJob(null);
    setHasChanges(false);
    setTab("captions");
  };

  const cancelProcessing = () => {
    const jobToCancel = job;
    clearProject();
    void cancelRemoteJob(jobToCancel);
    setToast("Processing cancelled. Your hobby queue slot is free.");
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
      setToast("Keep the reel under 90 MB for the MVP.");
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
    setJob(null);
    setHasChanges(false);
    setTab("captions");
    void uploadVideo(nextFile);
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
      setToast("Burning your changes into a new MP4.");
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
    window.location.href = `${jobsBase}${resultPath}`;
  };

  const setStyle = (values: Partial<CaptionStyle>) => {
    setCaptionStyle((current) => ({ ...current, ...values }));
    setHasChanges(true);
  };

  const updateCaptionText = (text: string) => {
    if (!selectedCaption) return;
    setCaptions((items) =>
      items.map((caption) =>
        caption.id === selectedCaption.id
          ? {
              ...caption,
              text,
              words: distributeWords(text, caption.start, caption.end),
            }
          : caption,
      ),
    );
    setSelectedWordIndex(0);
    setHasChanges(true);
  };

  const nudgeBoundary = (delta: number) => {
    if (
      !selectedCaption ||
      !selectedWord ||
      selectedWordIndex >= selectedWords.length - 1
    ) {
      return;
    }
    setCaptions((items) =>
      items.map((caption) => {
        if (caption.id !== selectedCaption.id) return caption;
        const words = (caption.words ?? []).map((word) => ({ ...word }));
        const left = words[selectedWordIndex];
        const right = words[selectedWordIndex + 1];
        const boundary = Math.max(
          left.start + 0.08,
          Math.min(right.end - 0.08, left.end + delta),
        );
        left.end = Number(boundary.toFixed(3));
        right.start = Number(boundary.toFixed(3));
        left.confidence = 1;
        right.confidence = 1;
        left.source = "manual";
        right.source = "manual";
        return { ...caption, words };
      }),
    );
    setHasChanges(true);
  };

  const seek = (seconds: number) => {
    const next = Math.max(0, Math.min(duration, seconds));
    setCurrentTime(next);
    if (videoRef.current) videoRef.current.currentTime = next;
  };

  const togglePlayback = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) void videoRef.current.play();
    else videoRef.current.pause();
  };

  const primaryAction = () => {
    if (!file) {
      videoInputRef.current?.click();
    } else if (["failed", "cancelled"].includes(job?.status ?? "") || !job) {
      void uploadVideo(file);
    } else if (job.status === "complete" && hasChanges) {
      void startRender();
    } else if (job.status === "complete") {
      downloadResult("video");
    }
  };

  const primaryLabel = (() => {
    if (uploading) return "Uploading video…";
    if (!file) return "Choose video";
    if (!job || ["failed", "cancelled"].includes(job.status)) {
      return "Try again";
    }
    if (isProcessing) return `${job.message ?? "Processing"} · ${job.progress}%`;
    if (hasChanges) return "Update final video";
    return "Download MP4";
  })();

  return (
    <main className={`creator-app ${file ? "has-project" : ""}`}>
      <header className="app-header">
        <a className="brand" href="#" aria-label="SyncWord home">
          <i aria-hidden="true">
            <span />
            <span />
            <span />
          </i>
          <strong>syncword</strong>
        </a>
        <div className={`engine-state ${engineState}`}>
          <span />
          {engineState === "online"
            ? "render online"
            : engineState === "waking"
              ? "waking render"
              : "engine offline"}
        </div>
      </header>

      {!file ? (
        <section className="launch">
          <div className="launch-copy">
            <span className="eyebrow">WORD-ACCURATE REEL CAPTIONS</span>
            <h1>
              Your words.
              <br />
              <em>On beat.</em>
            </h1>
            <p>
              Upload a reel. Get a finished MP4 with modern, animated,
              word-by-word captions burned into every frame.
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
                  ? "Keeps fillers and repetitions. Timing is aligned separately."
                  : transcriptMode === "transcribe"
                    ? "Normalizes speech into a cleaner native-script transcript."
                    : "English stays English; Indic speech stays in its native script."}
              </small>
            </div>

            <button
              className="upload-reel"
              onClick={() => videoInputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const dropped = event.dataTransfer.files[0];
                if (dropped) acceptVideo(dropped);
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
              <span>Saaras v3 hears the real phrases</span>
            </li>
            <li>
              <b>02</b>
              <span>GPU CTC alignment locks every word to speech</span>
            </li>
            <li>
              <b>03</b>
              <span>ASS + ffmpeg returns a social-ready MP4</span>
            </li>
          </ol>

          <p className="truth-line">
            No account. No mock transcript. No fake final preview.
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
                {isProcessing ? "Cancel & new video" : "← New video"}
              </button>
              <span title={file.name}>{file.name}</span>
              {showingFinal && <b>FINAL</b>}
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
                onTimeUpdate={(event) =>
                  setCurrentTime(event.currentTarget.currentTime)
                }
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                playsInline
              />

              {!showingFinal && activeWordGroup.length > 0 && (
                <div className="live-caption">
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
                    <span>
                      {job?.progress ?? 4}%
                    </span>
                  </div>
                  <strong>{job?.message ?? "Uploading your reel"}</strong>
                  <small>Keep this tab open while we make the final MP4.</small>
                  <button
                    className="cancel-processing"
                    onClick={cancelProcessing}
                  >
                    Cancel processing
                  </button>
                  <ol>
                    {["Upload", "Audio", "Words", "ASS burn"].map(
                      (label, index) => (
                        <li
                          key={label}
                          className={
                            index <= statusStep(job?.status) ? "active" : ""
                          }
                        >
                          <i />
                          <span>{label}</span>
                        </li>
                      ),
                    )}
                  </ol>
                </div>
              )}

              {["failed", "cancelled"].includes(job?.status ?? "") && (
                <div className="failed-cover">
                  <b>Render stopped</b>
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
          </section>

          <section className="tool-column">
            <nav className="tool-tabs" aria-label="Caption controls">
              {(
                [
                  ["captions", "Captions"],
                  ["style", "Style"],
                  ["export", "Export"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={tab === value ? "active" : ""}
                  onClick={() => setTab(value)}
                >
                  {label}
                </button>
              ))}
            </nav>

            <div className="tool-body">
              {tab === "captions" && !captions.length && (
                <div className="waiting-panel">
                  <span className="panel-icon">⌁</span>
                  <h2>
                    {job?.status === "failed"
                      ? "That render needs another go."
                      : "Your captions are being built."}
                  </h2>
                  <p>
                    Phrase timestamps come from Saaras v3. Word cuts come from
                    Meta&apos;s multilingual CTC acoustic frames—not guessed
                    word duration.
                  </p>
                </div>
              )}

              {tab === "captions" && selectedCaption && (
                <div className="caption-editor">
                  <div className="score-row">
                    <div>
                      <small>WORD SYNC</small>
                      <strong>
                        {alignment?.totalWords ?? 0} words ·{" "}
                        {alignment?.stableWords ??
                          Math.max(
                            0,
                            (alignment?.totalWords ?? 0) -
                              (alignment?.needsReview ?? 0),
                          )}
                        {" "}
                        stable
                      </strong>
                    </div>
                    <span>
                      {alignment?.needsReview
                        ? `${alignment.needsReview} review`
                        : "clean"}
                    </span>
                  </div>

                  <div className="phrase-picker">
                    {captions.map((caption, index) => (
                      <button
                        key={caption.id}
                        className={
                          caption.id === selectedCaption.id ? "active" : ""
                        }
                        onClick={() => {
                          setSelectedCaptionId(caption.id);
                          setSelectedWordIndex(0);
                          seek(caption.start + 0.01);
                        }}
                      >
                        <small>{String(index + 1).padStart(2, "0")}</small>
                        <span>{caption.text}</span>
                      </button>
                    ))}
                  </div>

                  <label className="transcript-field">
                    Phrase text
                    <textarea
                      rows={3}
                      value={selectedCaption.text}
                      onChange={(event) =>
                        updateCaptionText(event.target.value)
                      }
                    />
                  </label>

                  <span className="field-label">Tap a word to inspect its cut</span>
                  <div className="word-grid">
                    {selectedWords.map((word, index) => (
                      <button
                        key={word.id}
                        className={`${index === selectedWordIndex ? "active" : ""} ${
                          word.confidence < 0.35 ? "review" : ""
                        }`}
                        onClick={() => {
                          setSelectedWordIndex(index);
                          seek(word.start + 0.01);
                        }}
                      >
                        <span>{word.text}</span>
                        <i style={{ width: `${word.confidence * 100}%` }} />
                      </button>
                    ))}
                  </div>

                  {selectedWord && (
                    <div className="timing-card">
                      <div>
                        <small>Start</small>
                        <strong>{selectedWord.start.toFixed(3)}s</strong>
                      </div>
                      <div>
                        <small>End</small>
                        <strong>{selectedWord.end.toFixed(3)}s</strong>
                      </div>
                      <div>
                        <small>Source</small>
                        <strong>
                          {selectedWord.source === "manual"
                            ? "manual"
                            : selectedWord.source === "mms-fa"
                              ? "GPU align"
                              : selectedWord.source === "mms-fa-star"
                                ? "GPU recovery"
                              : "fallback"}
                        </strong>
                      </div>
                      {selectedWordIndex <
                        selectedWords.length - 1 && (
                        <div className="nudge-buttons">
                          <button onClick={() => nudgeBoundary(-0.03)}>
                            −30 ms
                          </button>
                          <span>next cut</span>
                          <button onClick={() => nudgeBoundary(0.03)}>
                            +30 ms
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {tab === "style" && (
                <div className="style-panel">
                  <div className="panel-heading">
                    <small>LIVE ASS PREVIEW</small>
                    <h2>Make the words hit.</h2>
                    <p>
                      Preview instantly here. Re-render only when the look is
                      right.
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
                              preset.values.backgroundColor ?? "#09090B",
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
                            setStyle({ [key]: Number(event.target.value) })
                          }
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {tab === "export" && (
                <div className="export-panel">
                  <div
                    className={`export-status ${showingFinal ? "ready" : ""}`}
                  >
                    <span>{showingFinal ? "✓" : "↻"}</span>
                    <div>
                      <small>
                        {showingFinal ? "FINAL VIDEO" : "RENDER STATUS"}
                      </small>
                      <h2>
                        {showingFinal
                          ? "Ready to post."
                          : isFinal && hasChanges
                            ? "Preview has new changes."
                            : "Still making the MP4."}
                      </h2>
                      <p>
                        {showingFinal
                          ? "What you see in the player is the real burned-in file."
                          : isFinal && hasChanges
                            ? "Tap Update final video to burn this look into the MP4."
                          : job?.message ?? "Waiting for caption processing."}
                      </p>
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

                  {showingFinal && (
                    <div className="download-actions">
                      <button onClick={() => downloadResult("video")}>
                        Download final MP4
                      </button>
                      <button onClick={() => downloadResult("ass")}>
                        Download source .ASS
                      </button>
                    </div>
                  )}
                  <p className="hobby-note">
                    MVP files are stored temporarily for 24 hours. Download
                    your final MP4 before they expire.
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
