"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";

type WordTiming = {
  id: string;
  text: string;
  start: number;
  end: number;
  confidence: number;
  source: "waveform-dp" | "grapheme-prior" | "manual";
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
  outlineWidth: number;
  position: number;
  weight: "600" | "700" | "800";
  karaokeMode: "wipe" | "pop" | "box";
};

type AlignmentSummary = {
  method: string;
  totalWords: number;
  waveformAlignedWords: number;
  averageConfidence: number;
  needsReview: number;
};

type JobResponse = {
  id: string;
  status:
    | "queued"
    | "extracting"
    | "transcribing"
    | "ready"
    | "rendering"
    | "complete"
    | "failed";
  progress: number;
  message?: string;
  captions?: Caption[];
  alignment?: AlignmentSummary;
  downloadUrl?: string;
};

const demoDuration = 26.4;

function weightForWord(word: string) {
  const length = Array.from(
    word.replace(/[\p{P}\p{S}]+/gu, "") || word,
  ).length;
  return Math.max(1, length ** 0.72);
}

function distributeWords(
  text: string,
  start: number,
  end: number,
  confidence = 0.74,
  source: WordTiming["source"] = "waveform-dp",
) {
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  const weights = tokens.map(weightForWord);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cursor = start;
  return tokens.map((word, index) => {
    const wordEnd =
      index === tokens.length - 1
        ? end
        : cursor + ((end - start) * weights[index]) / totalWeight;
    const timing: WordTiming = {
      id: `word-${index}-${Math.round(start * 1000)}`,
      text: word,
      start: Number(cursor.toFixed(3)),
      end: Number(wordEnd.toFixed(3)),
      confidence,
      source,
    };
    cursor = wordEnd;
    return timing;
  });
}

function makeCaption(
  id: string,
  start: number,
  end: number,
  text: string,
  language: Caption["language"],
  confidences?: number[],
): Caption {
  const words = distributeWords(text, start, end);
  if (confidences) {
    words.forEach((word, index) => {
      word.confidence = confidences[index] ?? word.confidence;
    });
  }
  return { id, start, end, text, language, words };
}

const initialCaptions: Caption[] = [
  makeCaption(
    "c-1",
    0.4,
    4.7,
    "মোৰ ভাষা, মোৰ পৰিচয়।",
    "as",
    [0.91, 0.86, 0.82, 0.9],
  ),
  makeCaption(
    "c-2",
    4.9,
    9.2,
    "আজিৰ story টো একেবাৰে simple.",
    "mix",
    [0.78, 0.93, 0.68, 0.59, 0.88],
  ),
  makeCaption(
    "c-3",
    9.45,
    14.1,
    "आंनि राव, आंनि सिनायथि।",
    "brx",
    [0.84, 0.72, 0.76, 0.62],
  ),
  makeCaption(
    "c-4",
    14.35,
    19.2,
    "কথাবোৰে আমাক একেলগে ৰাখে।",
    "as",
    [0.81, 0.67, 0.71, 0.87],
  ),
  makeCaption(
    "c-5",
    19.45,
    25.8,
    "Every voice deserves a beautiful frame.",
    "mix",
    [0.95, 0.89, 0.85, 0.91, 0.93, 0.87],
  ),
];

const defaultStyle: CaptionStyle = {
  fontFamily: "Noto Sans Bengali",
  fontSize: 48,
  textColor: "#FFFFFF",
  highlightColor: "#FFDE59",
  backgroundColor: "#11131C",
  backgroundOpacity: 82,
  outlineWidth: 2,
  position: 81,
  weight: "800",
  karaokeMode: "wipe",
};

const waveform = [
  18, 26, 38, 56, 74, 45, 34, 64, 82, 52, 39, 71, 48, 29, 59, 78, 43, 67,
  36, 51, 84, 62, 31, 46, 72, 54, 26, 63, 79, 41, 58, 87, 49, 35, 68, 76,
  44, 61, 28, 53, 81, 47, 69, 37, 57, 73, 32, 65, 85, 43, 55, 77, 39, 64,
  30, 51, 80, 46, 71, 34, 60, 75, 42, 66, 29, 54, 83, 48, 62, 36, 69, 78,
];

function formatShortTime(seconds: number) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const tenths = Math.floor((safe % 1) * 10);
  return `${minutes}:${wholeSeconds.toString().padStart(2, "0")}.${tenths}`;
}

function formatTimecode(seconds: number) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const milliseconds = Math.round((safe % 1) * 1000);
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${wholeSeconds
    .toString()
    .padStart(2, "0")},${milliseconds.toString().padStart(3, "0")}`;
}

function parseTimecode(value: string) {
  const match = value
    .trim()
    .match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!match) return null;
  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4].padEnd(3, "0")) / 1000
  );
}

function parseSrt(source: string): Caption[] {
  const normalized = source.replace(/\r/g, "").trim();
  if (!normalized) return [];
  return normalized
    .split(/\n{2,}/)
    .map((block, index) => {
      const lines = block.split("\n");
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) return null;
      const [startValue, endValue] = lines[timingIndex]
        .split("-->")
        .map((value) => value.trim());
      const start = parseTimecode(startValue);
      const end = parseTimecode(endValue);
      const text = lines
        .slice(timingIndex + 1)
        .join(" ")
        .replace(/<[^>]+>/g, "")
        .trim();
      if (start === null || end === null || end <= start || !text) return null;
      return makeCaption(
        `srt-${index}-${Date.now()}`,
        start,
        end,
        text,
        "mix",
      );
    })
    .filter((caption): caption is Caption => Boolean(caption));
}

function rgba(hex: string, opacity: number) {
  const normalized = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  const numeric = Number.parseInt(normalized, 16);
  return `rgba(${(numeric >> 16) & 255}, ${(numeric >> 8) & 255}, ${
    numeric & 255
  }, ${opacity / 100})`;
}

export default function Home() {
  const [panel, setPanel] = useState<"subtitles" | "words" | "styles">(
    "words",
  );
  const [captions, setCaptions] = useState(initialCaptions);
  const [selectedCaptionId, setSelectedCaptionId] = useState("c-1");
  const [captionStyle, setCaptionStyle] = useState(defaultStyle);
  const [videoUrl, setVideoUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("brahmaputra-stories.mp4");
  const [duration, setDuration] = useState(demoDuration);
  const [currentTime, setCurrentTime] = useState(2.15);
  const [playing, setPlaying] = useState(false);
  const [language, setLanguage] = useState("unknown");
  const [toast, setToast] = useState("");
  const [job, setJob] = useState<JobResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [previewRatio, setPreviewRatio] = useState<"16:9" | "9:16">("16:9");

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);

  const apiBase = useMemo(() => {
    const configured = process.env.NEXT_PUBLIC_RENDER_API_URL;
    if (configured) return configured.replace(/\/$/, "");
    if (
      typeof window !== "undefined" &&
      ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ) {
      return "http://localhost:8787";
    }
    return "";
  }, []);

  const activeCaption =
    captions.find(
      (caption) =>
        currentTime >= caption.start && currentTime < caption.end,
    ) ??
    captions.find((caption) => caption.id === selectedCaptionId) ??
    captions[0];
  const selectedCaption =
    captions.find((caption) => caption.id === selectedCaptionId) ??
    activeCaption;
  const activeWord = activeCaption?.words.find(
    (word) => currentTime >= word.start && currentTime < word.end,
  );
  const progress = duration ? (currentTime / duration) * 100 : 0;

  const alignmentSummary = useMemo<AlignmentSummary>(() => {
    if (job?.alignment) return job.alignment;
    const words = captions.flatMap((caption) => caption.words);
    return {
      method: "phrase-anchored-waveform-dp",
      totalWords: words.length,
      waveformAlignedWords: words.filter(
        (word) => word.source === "waveform-dp",
      ).length,
      averageConfidence: words.length
        ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length
        : 0,
      needsReview: words.filter((word) => word.confidence < 0.62).length,
    };
  }, [captions, job?.alignment]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!playing || videoUrl) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (timestamp: number) => {
      const delta = (timestamp - previous) / 1000;
      previous = timestamp;
      setCurrentTime((value) => {
        if (value + delta >= duration) {
          setPlaying(false);
          return 0;
        }
        return value + delta;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, playing, videoUrl]);

  useEffect(() => {
    if (!job || ["complete", "failed"].includes(job.status) || !apiBase)
      return;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`${apiBase}/v1/jobs/${job.id}`);
        if (!response.ok) return;
        const nextJob = (await response.json()) as JobResponse;
        setJob(nextJob);
        if (nextJob.status === "ready" && nextJob.captions?.length) {
          setCaptions(nextJob.captions);
          setSelectedCaptionId(nextJob.captions[0].id);
          setPanel("words");
          setToast(
            `${nextJob.alignment?.totalWords ?? 0} word boundaries are ready to review.`,
          );
        }
        if (nextJob.status === "complete") {
          setToast("Word-synced captioned video is ready.");
        }
        if (nextJob.status === "failed") {
          setToast(nextJob.message ?? "The job failed.");
        }
      } catch {
        setToast("The render service is not reachable.");
      }
    }, 2500);
    return () => window.clearInterval(interval);
  }, [apiBase, job]);

  const seek = (value: number) => {
    const next = Math.max(0, Math.min(duration, value));
    setCurrentTime(next);
    if (videoRef.current) videoRef.current.currentTime = next;
  };

  const togglePlayback = () => {
    if (videoRef.current) {
      if (videoRef.current.paused) void videoRef.current.play();
      else videoRef.current.pause();
      return;
    }
    setPlaying((value) => !value);
  };

  const acceptVideo = (nextFile: File) => {
    if (!nextFile.type.startsWith("video/")) {
      setToast("Choose an MP4, MOV, WebM, or another video file.");
      return;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(URL.createObjectURL(nextFile));
    setFile(nextFile);
    setFileName(nextFile.name);
    setCurrentTime(0);
    setJob(null);
    setToast("Video loaded locally. Generate captions when you’re ready.");
  };

  const importSrt = async (event: ChangeEvent<HTMLInputElement>) => {
    const srtFile = event.target.files?.[0];
    if (!srtFile) return;
    const imported = parseSrt(await srtFile.text());
    if (!imported.length) {
      setToast("That file does not contain readable SRT caption blocks.");
      return;
    }
    setCaptions(imported);
    setSelectedCaptionId(imported[0].id);
    setDuration((value) => Math.max(value, imported.at(-1)?.end ?? value));
    setPanel("words");
    setToast(
      `Imported ${imported.length} phrase anchors. Word timings need waveform alignment.`,
    );
    event.target.value = "";
  };

  const downloadSrt = () => {
    const srt = captions
      .map(
        (caption, index) =>
          `${index + 1}\n${formatTimecode(caption.start)} --> ${formatTimecode(
            caption.end,
          )}\n${caption.text}\n`,
      )
      .join("\n");
    const url = URL.createObjectURL(
      new Blob([srt], { type: "application/x-subrip;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${fileName.replace(/\.[^.]+$/, "") || "captions"}.srt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const updateCaptionText = (id: string, text: string) => {
    setCaptions((items) =>
      items.map((caption) =>
        caption.id === id
          ? {
              ...caption,
              text,
              words: distributeWords(
                text,
                caption.start,
                caption.end,
                0.38,
                "grapheme-prior",
              ),
            }
          : caption,
      ),
    );
  };

  const updateCaptionTime = (
    id: string,
    key: "start" | "end",
    value: string,
  ) => {
    const parsed = parseTimecode(value);
    if (parsed === null) return;
    setCaptions((items) =>
      items.map((caption) => {
        if (caption.id !== id) return caption;
        const next = { ...caption, [key]: parsed };
        if (next.end <= next.start) return caption;
        return {
          ...next,
          words: distributeWords(
            next.text,
            next.start,
            next.end,
            0.38,
            "grapheme-prior",
          ),
        };
      }),
    );
  };

  const addCaption = () => {
    const previous = captions.at(-1);
    const start = Math.min(duration - 0.5, (previous?.end ?? 0) + 0.15);
    const end = Math.min(duration, start + 2.8);
    const caption = makeCaption(
      `manual-${Date.now()}`,
      start,
      end,
      "নতুন caption",
      "mix",
    );
    caption.words.forEach((word) => {
      word.confidence = 0.38;
      word.source = "grapheme-prior";
    });
    setCaptions((items) => [...items, caption]);
    setSelectedCaptionId(caption.id);
    setPanel("subtitles");
  };

  const deleteCaption = (id: string) => {
    if (captions.length === 1) return;
    const remaining = captions.filter((caption) => caption.id !== id);
    setCaptions(remaining);
    if (selectedCaptionId === id) setSelectedCaptionId(remaining[0].id);
  };

  const nudgeBoundary = (
    captionId: string,
    wordIndex: number,
    delta: number,
  ) => {
    setCaptions((items) =>
      items.map((caption) => {
        if (caption.id !== captionId || wordIndex >= caption.words.length - 1)
          return caption;
        const words = caption.words.map((word) => ({ ...word }));
        const left = words[wordIndex];
        const right = words[wordIndex + 1];
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
  };

  const redistributeSelected = () => {
    if (!selectedCaption) return;
    setCaptions((items) =>
      items.map((caption) =>
        caption.id === selectedCaption.id
          ? {
              ...caption,
              words: distributeWords(
                caption.text,
                caption.start,
                caption.end,
                0.38,
                "grapheme-prior",
              ),
            }
          : caption,
      ),
    );
    setToast("Reset to grapheme-weighted timing. Run alignment for audio cues.");
  };

  const startTranscription = async () => {
    if (!file) {
      videoInputRef.current?.click();
      setToast("Upload a video first.");
      return;
    }
    if (!apiBase) {
      setToast(
        "The editor works here; connect the render API to run waveform alignment.",
      );
      return;
    }
    setIsSubmitting(true);
    try {
      const payload = new FormData();
      payload.append("video", file);
      payload.append("language", language);
      payload.append("mode", "codemix");
      const response = await fetch(`${apiBase}/v1/jobs`, {
        method: "POST",
        body: payload,
      });
      const data = (await response.json()) as JobResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Upload failed.");
      setJob(data);
      setToast("Phrase transcription and waveform alignment started.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const startRender = async () => {
    if (!job || job.status !== "ready") {
      void startTranscription();
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await fetch(`${apiBase}/v1/jobs/${job.id}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ captions, style: captionStyle }),
      });
      const data = (await response.json()) as JobResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Render failed.");
      setJob(data);
      setToast("ASS karaoke render started with approved word boundaries.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Render failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const primaryAction = () => {
    if (job?.status === "complete" && job.downloadUrl) {
      window.location.href = `${apiBase}${job.downloadUrl}`;
    } else if (job?.status === "ready") {
      void startRender();
    } else {
      void startTranscription();
    }
  };

  const primaryLabel = (() => {
    if (isSubmitting) return "Starting…";
    if (!file) return "Upload video";
    if (!job) return "Generate + align words";
    if (["queued", "extracting", "transcribing"].includes(job.status))
      return `${job.message ?? "Aligning"} · ${job.progress}%`;
    if (job.status === "ready") return "Render word karaoke";
    if (job.status === "rendering") return `Rendering · ${job.progress}%`;
    if (job.status === "complete") return "Download video";
    return "Try again";
  })();

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
    "--caption-font":
      captionStyle.fontFamily === "Noto Sans Devanagari"
        ? '"Noto Sans Devanagari", "Nirmala UI", sans-serif'
        : '"Noto Sans Bengali", "Nirmala UI", sans-serif',
  } as CSSProperties;

  return (
    <main className="editor-shell">
      <header className="editor-topbar">
        <div className="editor-brand">
          <span className="editor-logo">S</span>
          <strong>SyncWord</strong>
        </div>
        <div className="history-buttons">
          <button aria-label="Undo" onClick={() => setToast("Nothing to undo.")}>
            ↶
          </button>
          <button aria-label="Redo" onClick={() => setToast("Nothing to redo.")}>
            ↷
          </button>
        </div>
        <button className="project-title">
          {fileName}
          <span>Saved</span>
        </button>
        <div className="top-actions">
          <button className="share-button" onClick={downloadSrt}>
            Download SRT
          </button>
          <button className="export-button" onClick={primaryAction}>
            Export
            <span>↗</span>
          </button>
        </div>
      </header>

      <div className="editor-body">
        <nav className="asset-rail" aria-label="Editor tools">
          <button onClick={() => videoInputRef.current?.click()}>
            <span>▣</span>
            Media
          </button>
          <button
            className={panel === "subtitles" ? "active" : ""}
            onClick={() => setPanel("subtitles")}
          >
            <span>CC</span>
            Subtitles
          </button>
          <button
            className={panel === "words" ? "active innovation" : "innovation"}
            onClick={() => setPanel("words")}
          >
            <span>W</span>
            WordSync
          </button>
          <button
            className={panel === "styles" ? "active" : ""}
            onClick={() => setPanel("styles")}
          >
            <span>Aa</span>
            Styles
          </button>
          <button onClick={() => setToast("Audio remains unchanged.")}>
            <span>◒</span>
            Audio
          </button>
        </nav>

        <aside className="subtitle-sidebar">
          <div className="sidebar-head">
            <div>
              <h1>Subtitles</h1>
              <span>Phrase anchors + word timing</span>
            </div>
            <button aria-label="Close sidebar">×</button>
          </div>

          <div className="sidebar-tabs">
            <button
              className={panel === "subtitles" ? "active" : ""}
              onClick={() => setPanel("subtitles")}
            >
              Edit
            </button>
            <button
              className={panel === "words" ? "active" : ""}
              onClick={() => setPanel("words")}
            >
              Word sync
              <i>Beta</i>
            </button>
            <button
              className={panel === "styles" ? "active" : ""}
              onClick={() => setPanel("styles")}
            >
              Styles
            </button>
          </div>

          <div className="sidebar-scroll">
            {panel === "subtitles" && (
              <div className="edit-panel">
                <div className="subtitle-source-actions">
                  <button
                    className="auto-subtitle"
                    onClick={() => void startTranscription()}
                  >
                    ✦ Auto subtitle
                  </button>
                  <button
                    className="import-srt"
                    onClick={() => srtInputRef.current?.click()}
                  >
                    ↑ Import SRT
                  </button>
                </div>
                <label className="language-select">
                  Spoken language
                  <select
                    value={language}
                    onChange={(event) => setLanguage(event.target.value)}
                  >
                    <option value="unknown">Auto-detect</option>
                    <option value="as-IN">Assamese · as-IN</option>
                    <option value="brx-IN">Bodo · brx-IN</option>
                  </select>
                </label>
                <div className="source-meta">
                  <span>Saaras v3</span>
                  <span>codemix</span>
                  <small>chunk anchors</small>
                </div>

                <div className="caption-toolbar">
                  <strong>{captions.length} subtitle blocks</strong>
                  <button onClick={addCaption}>+ Add subtitle</button>
                </div>

                <div className="srt-list">
                  {captions.map((caption, index) => (
                    <article
                      key={caption.id}
                      className={
                        selectedCaptionId === caption.id ? "selected" : ""
                      }
                      onClick={() => {
                        setSelectedCaptionId(caption.id);
                        seek(caption.start + 0.02);
                      }}
                    >
                      <div className="caption-number">
                        {String(index + 1).padStart(2, "0")}
                      </div>
                      <div className="caption-fields">
                        <textarea
                          value={caption.text}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            updateCaptionText(caption.id, event.target.value)
                          }
                          aria-label={`Subtitle ${index + 1}`}
                          rows={2}
                        />
                        <div className="timecode-row">
                          <input
                            key={`start-${caption.start}`}
                            defaultValue={formatTimecode(caption.start)}
                            onBlur={(event) =>
                              updateCaptionTime(
                                caption.id,
                                "start",
                                event.target.value,
                              )
                            }
                            aria-label={`Subtitle ${index + 1} start time`}
                          />
                          <span>→</span>
                          <input
                            key={`end-${caption.end}`}
                            defaultValue={formatTimecode(caption.end)}
                            onBlur={(event) =>
                              updateCaptionTime(
                                caption.id,
                                "end",
                                event.target.value,
                              )
                            }
                            aria-label={`Subtitle ${index + 1} end time`}
                          />
                        </div>
                      </div>
                      <button
                        className="caption-menu"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteCaption(caption.id);
                        }}
                        aria-label={`Delete subtitle ${index + 1}`}
                      >
                        ⋮
                      </button>
                    </article>
                  ))}
                </div>
              </div>
            )}

            {panel === "words" && selectedCaption && (
              <div className="words-panel">
                <div className="innovation-card">
                  <div className="innovation-label">
                    <span>WordSync</span>
                    <i>Beta</i>
                  </div>
                  <h2>Word timing without word timestamps.</h2>
                  <p>
                    Phrase anchors keep us honest. Waveform valleys place the
                    words. You only review uncertain cuts.
                  </p>
                  <div className="alignment-flow">
                    <span>Sarvam phrase</span>
                    <b>→</b>
                    <span>Audio valleys</span>
                    <b>→</b>
                    <span>ASS karaoke</span>
                  </div>
                </div>

                <div className="alignment-stats">
                  <div>
                    <strong>{alignmentSummary.totalWords}</strong>
                    <span>words</span>
                  </div>
                  <div>
                    <strong>
                      {Math.round(alignmentSummary.averageConfidence * 100)}%
                    </strong>
                    <span>confidence</span>
                  </div>
                  <div className={alignmentSummary.needsReview ? "warning" : ""}>
                    <strong>{alignmentSummary.needsReview}</strong>
                    <span>review</span>
                  </div>
                </div>

                <div className="selected-phrase">
                  <span>
                    Phrase{" "}
                    {captions.findIndex(
                      (caption) => caption.id === selectedCaption.id,
                    ) + 1}
                  </span>
                  <p>{selectedCaption.text}</p>
                  <small>
                    {formatTimecode(selectedCaption.start)} →{" "}
                    {formatTimecode(selectedCaption.end)}
                  </small>
                </div>

                <div className="word-list-head">
                  <span>Word boundaries</span>
                  <button onClick={redistributeSelected}>Reset spacing</button>
                </div>

                <div className="word-boundary-list">
                  {selectedCaption.words.map((word, index) => (
                    <article
                      key={word.id}
                      className={`${word.confidence < 0.62 ? "low" : ""} ${
                        activeWord?.id === word.id ? "active" : ""
                      }`}
                      onClick={() => seek(word.start + 0.01)}
                    >
                      <div className="word-copy">
                        <strong>{word.text}</strong>
                        <span>
                          {formatShortTime(word.start)} —{" "}
                          {formatShortTime(word.end)}
                        </span>
                      </div>
                      <div className="confidence-meter">
                        <i style={{ width: `${word.confidence * 100}%` }} />
                      </div>
                      <small>
                        {word.source === "manual"
                          ? "fixed"
                          : `${Math.round(word.confidence * 100)}%`}
                      </small>
                      {index < selectedCaption.words.length - 1 ? (
                        <div className="nudge-buttons">
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              nudgeBoundary(selectedCaption.id, index, -0.03);
                            }}
                            aria-label={`Move boundary after ${word.text} earlier`}
                          >
                            −30
                          </button>
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              nudgeBoundary(selectedCaption.id, index, 0.03);
                            }}
                            aria-label={`Move boundary after ${word.text} later`}
                          >
                            +30
                          </button>
                        </div>
                      ) : (
                        <span className="phrase-end">END</span>
                      )}
                    </article>
                  ))}
                </div>

                <div className="review-note">
                  <span>◉</span>
                  <p>
                    Amber rows are low-confidence. Play the phrase and nudge
                    only those boundaries by 30ms.
                  </p>
                </div>
              </div>
            )}

            {panel === "styles" && (
              <div className="styles-panel">
                <section>
                  <div className="settings-title">
                    <strong>Karaoke style</strong>
                    <button onClick={() => setCaptionStyle(defaultStyle)}>
                      Reset
                    </button>
                  </div>
                  <div className="style-presets">
                    {(["wipe", "pop", "box"] as const).map((mode) => (
                      <button
                        key={mode}
                        className={
                          captionStyle.karaokeMode === mode ? "active" : ""
                        }
                        onClick={() =>
                          setCaptionStyle((value) => ({
                            ...value,
                            karaokeMode: mode,
                          }))
                        }
                      >
                        <span className={`preset-preview ${mode}`}>
                          <i>WORD</i>
                        </span>
                        {mode}
                      </button>
                    ))}
                  </div>
                </section>

                <section>
                  <strong className="section-label">Typography</strong>
                  <label className="setting-row">
                    Font
                    <select
                      value={captionStyle.fontFamily}
                      onChange={(event) =>
                        setCaptionStyle((value) => ({
                          ...value,
                          fontFamily: event.target.value,
                        }))
                      }
                    >
                      <option>Noto Sans Bengali</option>
                      <option>Noto Sans Devanagari</option>
                    </select>
                  </label>
                  <div className="two-settings">
                    <label>
                      Size
                      <input
                        type="number"
                        min="24"
                        max="84"
                        value={captionStyle.fontSize}
                        onChange={(event) =>
                          setCaptionStyle((value) => ({
                            ...value,
                            fontSize: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                    <label>
                      Weight
                      <select
                        value={captionStyle.weight}
                        onChange={(event) =>
                          setCaptionStyle((value) => ({
                            ...value,
                            weight: event.target.value as CaptionStyle["weight"],
                          }))
                        }
                      >
                        <option value="600">600</option>
                        <option value="700">700</option>
                        <option value="800">800</option>
                      </select>
                    </label>
                  </div>
                </section>

                <section>
                  <strong className="section-label">Colors</strong>
                  <div className="color-settings">
                    {[
                      ["Text", "textColor"],
                      ["Active word", "highlightColor"],
                      ["Background", "backgroundColor"],
                    ].map(([label, key]) => (
                      <label key={key}>
                        {label}
                        <span>
                          <input
                            type="color"
                            value={captionStyle[key as keyof CaptionStyle] as string}
                            onChange={(event) =>
                              setCaptionStyle((value) => ({
                                ...value,
                                [key]: event.target.value,
                              }))
                            }
                          />
                          {captionStyle[key as keyof CaptionStyle]}
                        </span>
                      </label>
                    ))}
                  </div>
                </section>

                <section>
                  <label className="range-setting">
                    <span>
                      Position <b>{captionStyle.position}%</b>
                    </span>
                    <input
                      type="range"
                      min="58"
                      max="88"
                      value={captionStyle.position}
                      onChange={(event) =>
                        setCaptionStyle((value) => ({
                          ...value,
                          position: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label className="range-setting">
                    <span>
                      Background <b>{captionStyle.backgroundOpacity}%</b>
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={captionStyle.backgroundOpacity}
                      onChange={(event) =>
                        setCaptionStyle((value) => ({
                          ...value,
                          backgroundOpacity: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                </section>
              </div>
            )}
          </div>

          <div className="sidebar-footer">
            {job && (
              <div className="job-state">
                <span>{job.message}</span>
                <i>
                  <b style={{ width: `${job.progress}%` }} />
                </i>
              </div>
            )}
            <button
              className="primary-job-button"
              onClick={primaryAction}
              disabled={
                isSubmitting ||
                Boolean(
                  job &&
                    ["queued", "extracting", "transcribing", "rendering"].includes(
                      job.status,
                    ),
                )
              }
            >
              <span>{primaryLabel}</span>
              <b>→</b>
            </button>
          </div>
        </aside>

        <section className="workbench">
          <div className="canvas-toolbar">
            <div className="canvas-controls">
              <button
                className={previewRatio === "16:9" ? "active" : ""}
                onClick={() => setPreviewRatio("16:9")}
              >
                16:9
              </button>
              <button
                className={previewRatio === "9:16" ? "active" : ""}
                onClick={() => setPreviewRatio("9:16")}
              >
                9:16
              </button>
            </div>
            <div className="alignment-badge">
              <span>●</span>
              Phrase anchored · word aligned
            </div>
            <button
              className="add-media-button"
              onClick={() => videoInputRef.current?.click()}
            >
              + Add media
            </button>
          </div>

          <div className="canvas-space">
            <div
              className={`video-artboard ${
                previewRatio === "9:16" ? "portrait" : ""
              }`}
              style={previewStyle}
            >
              {videoUrl ? (
                <video
                  ref={videoRef}
                  src={videoUrl}
                  onLoadedMetadata={(event) => {
                    if (Number.isFinite(event.currentTarget.duration)) {
                      setDuration(event.currentTarget.duration);
                    }
                  }}
                  onTimeUpdate={(event) =>
                    setCurrentTime(event.currentTarget.currentTime)
                  }
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  playsInline
                />
              ) : (
                <div className="river-scene">
                  <div className="scene-sun" />
                  <div className="scene-mountain back" />
                  <div className="scene-mountain front" />
                  <div className="scene-river" />
                  <span>MAJULI · ASSAM</span>
                </div>
              )}

              {activeCaption && (
                <div
                  className={`karaoke-caption ${captionStyle.karaokeMode}`}
                  key={`${activeCaption.id}-${captionStyle.karaokeMode}`}
                >
                  {activeCaption.words.map((word) => (
                    <span
                      key={word.id}
                      className={
                        activeWord?.id === word.id ? "active-word" : ""
                      }
                    >
                      {word.text}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="transport">
            <button onClick={() => seek(Math.max(0, currentTime - 1 / 30))}>
              |◀
            </button>
            <button className="transport-play" onClick={togglePlayback}>
              {playing ? "Ⅱ" : "▶"}
            </button>
            <button
              onClick={() => seek(Math.min(duration, currentTime + 1 / 30))}
            >
              ▶|
            </button>
            <span>
              {formatShortTime(currentTime)} / {formatShortTime(duration)}
            </span>
            <div className="transport-spacer" />
            <button onClick={() => setToast("Preview volume uses video audio.")}>
              ◖
            </button>
            <button onClick={() => setToast("Preview expanded to fit canvas.")}>
              ⛶
            </button>
          </div>

          <div className="timeline">
            <div className="timeline-toolbar">
              <div>
                <button onClick={addCaption}>+ Add subtitle</button>
                <button
                  onClick={() =>
                    setToast("Select a subtitle block before splitting.")
                  }
                >
                  ✂ Split
                </button>
              </div>
              <div className="zoom-control">
                <span>−</span>
                <input
                  type="range"
                  min="70"
                  max="160"
                  value={zoom}
                  onChange={(event) => setZoom(Number(event.target.value))}
                />
                <span>+</span>
                <b>{zoom}%</b>
              </div>
            </div>

            <div
              className="timeline-scroll"
              style={{ "--timeline-zoom": zoom / 100 } as CSSProperties}
            >
              <div
                className="timeline-content"
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  seek(((event.clientX - bounds.left) / bounds.width) * duration);
                }}
              >
                <div className="timeline-ruler">
                  {[0, 5, 10, 15, 20, 25].map((time) => (
                    <span
                      key={time}
                      style={{ left: `${(time / duration) * 100}%` }}
                    >
                      {formatShortTime(time)}
                    </span>
                  ))}
                </div>

                <div className="subtitle-track">
                  <label>CC</label>
                  {captions.map((caption) => (
                    <button
                      key={caption.id}
                      className={
                        selectedCaptionId === caption.id ? "selected" : ""
                      }
                      style={{
                        left: `${(caption.start / duration) * 100}%`,
                        width: `${Math.max(
                          2.5,
                          ((caption.end - caption.start) / duration) * 100,
                        )}%`,
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedCaptionId(caption.id);
                        seek(caption.start + 0.01);
                      }}
                    >
                      {caption.words.map((word) => (
                        <i
                          key={word.id}
                          className={
                            activeWord?.id === word.id ? "active-word" : ""
                          }
                          style={{
                            left: `${
                              ((word.start - caption.start) /
                                (caption.end - caption.start)) *
                              100
                            }%`,
                            width: `${
                              ((word.end - word.start) /
                                (caption.end - caption.start)) *
                              100
                            }%`,
                          }}
                        />
                      ))}
                      <span>{caption.text}</span>
                    </button>
                  ))}
                </div>

                <div className="video-track">
                  <label>▣</label>
                  <div className="video-strip">
                    {Array.from({ length: 12 }).map((_, index) => (
                      <i key={index} style={{ "--frame": index } as CSSProperties} />
                    ))}
                    <span>{fileName}</span>
                  </div>
                </div>

                <div className="audio-track">
                  <label>◒</label>
                  <div className="waveform">
                    {waveform.map((height, index) => (
                      <i
                        key={`${height}-${index}`}
                        style={{ height: `${height}%` }}
                      />
                    ))}
                  </div>
                </div>

                <div
                  className="timeline-playhead"
                  style={{ left: `${progress}%` }}
                >
                  <i />
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(event) => {
          const nextFile = event.target.files?.[0];
          if (nextFile) acceptVideo(nextFile);
        }}
      />
      <input
        ref={srtInputRef}
        type="file"
        accept=".srt,.vtt,text/plain"
        hidden
        onChange={importSrt}
      />

      {toast && (
        <div className="toast" role="status">
          <span>●</span>
          {toast}
          <button onClick={() => setToast("")}>×</button>
        </div>
      )}
    </main>
  );
}
