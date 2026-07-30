"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
} from "react";

type Caption = {
  id: string;
  start: number;
  end: number;
  text: string;
  language: "as" | "brx" | "mix";
};

type CaptionStyle = {
  fontFamily: string;
  fontSize: number;
  textColor: string;
  backgroundColor: string;
  backgroundOpacity: number;
  outlineColor: string;
  outlineWidth: number;
  position: number;
  animation: "pop" | "fade" | "slide";
  weight: "600" | "700" | "800";
  uppercaseEnglish: boolean;
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
  captions?: Array<{
    id?: string;
    start: number;
    end: number;
    text: string;
    language?: Caption["language"];
  }>;
  downloadUrl?: string;
};

const demoDuration = 28;

const initialCaptions: Caption[] = [
  {
    id: "c-1",
    start: 0.4,
    end: 4.7,
    text: "মোৰ ভাষা, মোৰ পৰিচয়।",
    language: "as",
  },
  {
    id: "c-2",
    start: 4.9,
    end: 9.1,
    text: "आजि story टा एकदम simple.",
    language: "mix",
  },
  {
    id: "c-3",
    start: 9.4,
    end: 13.8,
    text: "आंनि राव, आंनि सिनायथि।",
    language: "brx",
  },
  {
    id: "c-4",
    start: 14,
    end: 18.6,
    text: "কথাবোৰে আমাক একেলগে ৰাখে।",
    language: "as",
  },
  {
    id: "c-5",
    start: 19,
    end: 24.8,
    text: "Every voice deserves a beautiful frame.",
    language: "mix",
  },
];

const defaultStyle: CaptionStyle = {
  fontFamily: "Noto Sans Bengali",
  fontSize: 44,
  textColor: "#FFF9EE",
  backgroundColor: "#171A27",
  backgroundOpacity: 78,
  outlineColor: "#171A27",
  outlineWidth: 2,
  position: 83,
  animation: "pop",
  weight: "700",
  uppercaseEnglish: false,
};

const waveform = [
  18, 28, 22, 42, 58, 36, 68, 46, 30, 54, 74, 44, 60, 34, 80, 52, 66, 38,
  48, 72, 40, 62, 82, 56, 32, 64, 50, 76, 46, 68, 36, 58, 78, 42, 62, 28,
  52, 70, 38, 60, 84, 48, 66, 32, 56, 74, 44, 62, 30, 50, 72, 38, 58, 80,
  46, 64, 34, 54, 70, 40, 60, 28, 48, 66,
];

const languageNames = {
  as: "অসমীয়া",
  brx: "बड़ो",
  mix: "Code-mix",
};

function formatTime(value: number) {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const minutes = Math.floor(safeValue / 60);
  const seconds = Math.floor(safeValue % 60);
  const tenths = Math.floor((safeValue % 1) * 10);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${tenths}`;
}

function toRgba(hex: string, opacity: number) {
  const value = hex.replace("#", "");
  const normalized =
    value.length === 3
      ? value
          .split("")
          .map((character) => character + character)
          .join("")
      : value;
  const numeric = Number.parseInt(normalized, 16);
  const red = (numeric >> 16) & 255;
  const green = (numeric >> 8) & 255;
  const blue = numeric & 255;
  return `rgba(${red}, ${green}, ${blue}, ${opacity / 100})`;
}

export default function Home() {
  const [activePanel, setActivePanel] = useState<"captions" | "style">("style");
  const [captions, setCaptions] = useState(initialCaptions);
  const [captionStyle, setCaptionStyle] = useState(defaultStyle);
  const [language, setLanguage] = useState("unknown");
  const [videoUrl, setVideoUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("brahmaputra-stories.mp4");
  const [duration, setDuration] = useState(demoDuration);
  const [currentTime, setCurrentTime] = useState(2.2);
  const [playing, setPlaying] = useState(false);
  const [previewMode, setPreviewMode] = useState<"landscape" | "portrait">(
    "landscape",
  );
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState("");
  const [job, setJob] = useState<JobResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [projectName, setProjectName] = useState("Brahmaputra stories");
  const [renaming, setRenaming] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    ) ?? captions[0];

  const progress = duration ? (currentTime / duration) * 100 : 0;

  const playerStyle = {
    "--caption-top": `${captionStyle.position}%`,
    "--caption-size": `${captionStyle.fontSize}px`,
    "--caption-text": captionStyle.textColor,
    "--caption-bg": toRgba(
      captionStyle.backgroundColor,
      captionStyle.backgroundOpacity,
    ),
    "--caption-outline": captionStyle.outlineColor,
    "--caption-outline-width": `${captionStyle.outlineWidth}px`,
    "--caption-font":
      captionStyle.fontFamily === "Noto Sans Devanagari"
        ? '"Noto Sans Devanagari", "Nirmala UI", sans-serif'
        : captionStyle.fontFamily === "Geist"
          ? "var(--font-geist-sans), sans-serif"
          : '"Noto Sans Bengali", "Nirmala UI", sans-serif',
    "--caption-weight": captionStyle.weight,
  } as CSSProperties;

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!job || ["complete", "failed"].includes(job.status)) return;
    if (!apiBase) return;

    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`${apiBase}/v1/jobs/${job.id}`);
        if (!response.ok) return;
        const nextJob = (await response.json()) as JobResponse;
        setJob(nextJob);

        if (nextJob.status === "ready" && nextJob.captions?.length) {
          setCaptions(
            nextJob.captions.map((caption, index) => ({
              id: caption.id ?? `stt-${index}`,
              start: caption.start,
              end: caption.end,
              text: caption.text,
              language: caption.language ?? "mix",
            })),
          );
          setActivePanel("captions");
          setToast("Transcript ready — review the phrases before rendering.");
        }

        if (nextJob.status === "complete") {
          setToast("Captioned video is ready to download.");
        }

        if (nextJob.status === "failed") {
          setToast(nextJob.message ?? "The render job could not be completed.");
        }
      } catch {
        setToast("The render service is not reachable right now.");
      }
    }, 2600);

    return () => window.clearInterval(interval);
  }, [apiBase, job]);

  useEffect(() => {
    if (!playing || videoUrl) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (timestamp: number) => {
      const delta = (timestamp - previous) / 1000;
      previous = timestamp;
      setCurrentTime((value) => {
        const next = value + delta;
        if (next >= duration) {
          setPlaying(false);
          return 0;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, playing, videoUrl]);

  const togglePlayback = () => {
    if (videoRef.current) {
      if (videoRef.current.paused) {
        void videoRef.current.play();
      } else {
        videoRef.current.pause();
      }
      return;
    }

    if (playing) {
      setPlaying(false);
    } else {
      setPlaying(true);
      if (currentTime >= duration) setCurrentTime(0);
    }
  };

  const seek = (value: number) => {
    const next = Math.max(0, Math.min(duration, value));
    setCurrentTime(next);
    if (videoRef.current) videoRef.current.currentTime = next;
  };

  const acceptFile = (nextFile: File) => {
    if (!nextFile.type.startsWith("video/")) {
      setToast("Choose an MP4, MOV, WebM, or another video file.");
      return;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const nextUrl = URL.createObjectURL(nextFile);
    setVideoUrl(nextUrl);
    setFile(nextFile);
    setFileName(nextFile.name);
    setCurrentTime(0);
    setPlaying(false);
    setJob(null);
    setToast("Video added. Preview the look or generate a fresh transcript.");
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0];
    if (nextFile) acceptFile(nextFile);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const nextFile = event.dataTransfer.files?.[0];
    if (nextFile) acceptFile(nextFile);
  };

  const updateCaption = (id: string, text: string) => {
    setCaptions((items) =>
      items.map((caption) =>
        caption.id === id ? { ...caption, text } : caption,
      ),
    );
  };

  const addCaption = () => {
    const last = captions[captions.length - 1];
    const start = last ? Math.min(duration - 1, last.end + 0.2) : 0;
    const end = Math.min(duration, start + 3);
    setCaptions((items) => [
      ...items,
      {
        id: `manual-${Date.now()}`,
        start,
        end,
        text: "নতুন caption",
        language: "mix",
      },
    ]);
    setActivePanel("captions");
  };

  const removeCaption = (id: string) => {
    if (captions.length === 1) {
      setToast("Keep at least one caption block in the timeline.");
      return;
    }
    setCaptions((items) => items.filter((caption) => caption.id !== id));
  };

  const startTranscription = async () => {
    if (!file) {
      fileInputRef.current?.click();
      setToast("Choose a video to generate its captions.");
      return;
    }
    if (!apiBase) {
      setToast(
        "Preview works here. Connect the render API to run Saaras and ffmpeg.",
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
      if (!response.ok) throw new Error(data.error ?? "Upload failed");
      setJob(data);
      setToast("Audio extraction started. You can keep styling while it runs.");
    } catch (error) {
      setToast(
        error instanceof Error
          ? error.message
          : "The render service is not reachable.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const startRender = async () => {
    if (!job || job.status !== "ready") {
      if (!file) {
        fileInputRef.current?.click();
        setToast("Choose a video first, then generate its transcript.");
      } else {
        void startTranscription();
      }
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
      if (!response.ok) throw new Error(data.error ?? "Render failed");
      setJob(data);
      setToast("Final burn-in started with your approved style.");
    } catch (error) {
      setToast(
        error instanceof Error ? error.message : "The render could not start.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const actionLabel = (() => {
    if (isSubmitting) return "Starting…";
    if (!file) return "Upload & generate";
    if (!job) return "Generate captions";
    if (["queued", "extracting", "transcribing"].includes(job.status))
      return `${job.message ?? "Transcribing"} · ${job.progress}%`;
    if (job.status === "ready") return "Burn captions";
    if (job.status === "rendering") return `Rendering · ${job.progress}%`;
    if (job.status === "complete") return "Download video";
    return "Try again";
  })();

  const onPrimaryAction = () => {
    if (job?.status === "complete" && job.downloadUrl) {
      window.location.href = `${apiBase}${job.downloadUrl}`;
      return;
    }
    if (job?.status === "ready") {
      void startRender();
      return;
    }
    void startTranscription();
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="SyncWord home">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>SyncWord</span>
        </div>

        <div className="project-heading">
          {renaming ? (
            <input
              className="project-name-input"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              onBlur={() => setRenaming(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter") setRenaming(false);
              }}
              autoFocus
              aria-label="Project name"
            />
          ) : (
            <button
              className="project-name"
              onClick={() => setRenaming(true)}
              aria-label="Rename project"
            >
              {projectName}
              <span aria-hidden="true">↗</span>
            </button>
          )}
          <span className="saved-state">
            <i aria-hidden="true" />
            Saved just now
          </span>
        </div>

        <div className="header-actions">
          <div className="preview-toggle" aria-label="Preview aspect ratio">
            <button
              className={previewMode === "landscape" ? "active" : ""}
              onClick={() => setPreviewMode("landscape")}
              aria-label="Landscape preview"
              aria-pressed={previewMode === "landscape"}
            >
              ▭
            </button>
            <button
              className={previewMode === "portrait" ? "active" : ""}
              onClick={() => setPreviewMode("portrait")}
              aria-label="Portrait preview"
              aria-pressed={previewMode === "portrait"}
            >
              ▯
            </button>
          </div>
          <button
            className="quiet-button help-button"
            onClick={() =>
              setToast(
                "Phrase-level timing is supported. Word karaoke needs alignment.",
              )
            }
          >
            Need help?
          </button>
          <button className="avatar" aria-label="Open account menu">
            TR
          </button>
        </div>
      </header>

      <section className="studio">
        <nav className="tool-rail" aria-label="Editor tools">
          <button
            className={activePanel === "captions" ? "active" : ""}
            onClick={() => setActivePanel("captions")}
          >
            <span aria-hidden="true">CC</span>
            Captions
          </button>
          <button
            className={activePanel === "style" ? "active" : ""}
            onClick={() => setActivePanel("style")}
          >
            <span aria-hidden="true">Aa</span>
            Style
          </button>
          <button
            onClick={() =>
              setToast("Phrase timing can be adjusted in the caption list.")
            }
          >
            <span aria-hidden="true">⌁</span>
            Timing
          </button>
          <button
            onClick={() =>
              setToast("ASS export is created by the render service.")
            }
          >
            <span aria-hidden="true">↓</span>
            Export
          </button>
        </nav>

        <section className="canvas-column">
          <div className="canvas-toolbar">
            <div>
              <span className="eyebrow">Live style preview</span>
              <h1>Caption Indian voices, beautifully.</h1>
            </div>
            <div className="model-note">
              <span className="status-dot" aria-hidden="true" />
              Saaras v3 · codemix
            </div>
          </div>

          <div
            className={`player-frame ${previewMode}`}
            style={playerStyle}
          >
            <div className="video-stage">
              {videoUrl ? (
                <video
                  ref={videoRef}
                  src={videoUrl}
                  className="uploaded-video"
                  onLoadedMetadata={(event) => {
                    const nextDuration = event.currentTarget.duration;
                    if (Number.isFinite(nextDuration)) setDuration(nextDuration);
                  }}
                  onTimeUpdate={(event) =>
                    setCurrentTime(event.currentTarget.currentTime)
                  }
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  playsInline
                />
              ) : (
                <div className="demo-scene" aria-label="Demo video scene">
                  <div className="demo-sun" />
                  <div className="demo-hill demo-hill-back" />
                  <div className="demo-hill demo-hill-front" />
                  <div className="demo-river" />
                  <span className="demo-location">
                    MAJULI · 07:24
                  </span>
                </div>
              )}

              <div className="frame-guide" aria-hidden="true" />

              {activeCaption && (
                <div
                  key={`${activeCaption.id}-${captionStyle.animation}`}
                  className={`caption-preview ${captionStyle.animation} ${
                    captionStyle.uppercaseEnglish ? "uppercase-english" : ""
                  }`}
                >
                  {activeCaption.text}
                </div>
              )}

              <div className="player-controls">
                <button
                  className="play-button"
                  onClick={togglePlayback}
                  aria-label={playing ? "Pause" : "Play"}
                >
                  {playing ? "Ⅱ" : "▶"}
                </button>
                <span>{formatTime(currentTime)}</span>
                <input
                  aria-label="Video position"
                  type="range"
                  min="0"
                  max={duration || 1}
                  step="0.05"
                  value={Math.min(currentTime, duration)}
                  onChange={(event) => seek(Number(event.target.value))}
                  style={{ "--range-progress": `${progress}%` } as CSSProperties}
                />
                <span>{formatTime(duration)}</span>
                <button
                  className="control-icon"
                  onClick={() => setToast("Preview volume uses your video audio.")}
                  aria-label="Volume"
                >
                  ◖
                </button>
              </div>
            </div>
          </div>

          <div className="timeline-panel">
            <div className="timeline-head">
              <div>
                <span className="timeline-title">{fileName}</span>
                <span className="timeline-meta">
                  {videoUrl ? "Local preview" : "Demo clip"} ·{" "}
                  {formatTime(duration)}
                </span>
              </div>
              <div className="timeline-actions">
                <button onClick={() => seek(Math.max(0, currentTime - 1))}>
                  − 1s
                </button>
                <button onClick={() => seek(Math.min(duration, currentTime + 1))}>
                  + 1s
                </button>
                <button onClick={addCaption}>+ Caption</button>
              </div>
            </div>

            <div
              className="timeline-track"
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                seek(((event.clientX - bounds.left) / bounds.width) * duration);
              }}
              role="presentation"
            >
              <div className="time-ruler">
                {[0, 5, 10, 15, 20, 25].map((time) => (
                  <span key={time} style={{ left: `${(time / 28) * 100}%` }}>
                    {time}s
                  </span>
                ))}
              </div>
              <div className="waveform" aria-hidden="true">
                {waveform.map((height, index) => (
                  <i
                    key={`${height}-${index}`}
                    style={{ height: `${height}%` }}
                  />
                ))}
              </div>
              <div className="caption-clips">
                {captions.map((caption, index) => (
                  <button
                    key={caption.id}
                    className={
                      activeCaption?.id === caption.id ? "active" : ""
                    }
                    style={{
                      left: `${(caption.start / duration) * 100}%`,
                      width: `${Math.max(
                        5,
                        ((caption.end - caption.start) / duration) * 100,
                      )}%`,
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      seek(caption.start + 0.05);
                    }}
                    title={caption.text}
                  >
                    {index + 1}
                  </button>
                ))}
              </div>
              <div
                className="playhead"
                style={{ left: `${progress}%` }}
                aria-hidden="true"
              >
                <i />
              </div>
            </div>
          </div>
        </section>

        <aside className="inspector">
          <div className="inspector-tabs">
            <button
              className={activePanel === "captions" ? "active" : ""}
              onClick={() => setActivePanel("captions")}
            >
              Captions
            </button>
            <button
              className={activePanel === "style" ? "active" : ""}
              onClick={() => setActivePanel("style")}
            >
              Style
            </button>
          </div>

          {activePanel === "captions" ? (
            <div className="panel-content captions-panel">
              <div
                className={`upload-box ${dragging ? "dragging" : ""}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ")
                    fileInputRef.current?.click();
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  onChange={handleFileChange}
                  hidden
                />
                <span className="upload-symbol" aria-hidden="true">
                  ↑
                </span>
                <div>
                  <strong>{file ? "Replace video" : "Drop a video here"}</strong>
                  <small>
                    {file ? file.name : "MP4, MOV or WebM · up to 2 hours"}
                  </small>
                </div>
              </div>

              <label className="control-label">
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

              <div className="sync-note">
                <span aria-hidden="true">◎</span>
                <div>
                  <strong>Phrase-level sync</strong>
                  <p>
                    Saaras Batch returns sentence chunks. Word karaoke needs a
                    separate alignment pass.
                  </p>
                </div>
              </div>

              <div className="caption-list-head">
                <span>{captions.length} caption blocks</span>
                <button onClick={addCaption}>+ Add</button>
              </div>

              <div className="caption-list">
                {captions.map((caption, index) => (
                  <article
                    key={caption.id}
                    className={
                      activeCaption?.id === caption.id ? "active" : ""
                    }
                    onClick={() => seek(caption.start + 0.05)}
                  >
                    <div className="caption-index">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <small>{languageNames[caption.language]}</small>
                    </div>
                    <div className="caption-copy">
                      <input
                        value={caption.text}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          updateCaption(caption.id, event.target.value)
                        }
                        aria-label={`Caption ${index + 1} text`}
                      />
                      <small>
                        {formatTime(caption.start)} — {formatTime(caption.end)}
                      </small>
                    </div>
                    <button
                      className="remove-caption"
                      onClick={(event) => {
                        event.stopPropagation();
                        removeCaption(caption.id);
                      }}
                      aria-label={`Remove caption ${index + 1}`}
                    >
                      ×
                    </button>
                  </article>
                ))}
              </div>
            </div>
          ) : (
            <div className="panel-content style-panel">
              <section className="style-section">
                <div className="section-title">
                  <span>Typography</span>
                  <button
                    onClick={() =>
                      setCaptionStyle((value) => ({
                        ...defaultStyle,
                        position: value.position,
                      }))
                    }
                  >
                    Reset
                  </button>
                </div>

                <label className="control-label">
                  Script-safe font
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
                    <option>Geist</option>
                  </select>
                </label>

                <div className="split-controls">
                  <label className="control-label">
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
                      <option value="600">Semibold</option>
                      <option value="700">Bold</option>
                      <option value="800">Extra bold</option>
                    </select>
                  </label>
                  <label className="control-label">
                    Size
                    <span className="numeric-input">
                      <input
                        type="number"
                        min="24"
                        max="78"
                        value={captionStyle.fontSize}
                        onChange={(event) =>
                          setCaptionStyle((value) => ({
                            ...value,
                            fontSize: Number(event.target.value),
                          }))
                        }
                      />
                      px
                    </span>
                  </label>
                </div>
              </section>

              <section className="style-section">
                <div className="section-title">
                  <span>Color & contrast</span>
                  <small>ASS-safe</small>
                </div>

                <div className="color-row">
                  <label>
                    <span>Text</span>
                    <span className="color-input">
                      <input
                        type="color"
                        value={captionStyle.textColor}
                        onChange={(event) =>
                          setCaptionStyle((value) => ({
                            ...value,
                            textColor: event.target.value,
                          }))
                        }
                        aria-label="Caption text color"
                      />
                      {captionStyle.textColor}
                    </span>
                  </label>
                  <label>
                    <span>Panel</span>
                    <span className="color-input">
                      <input
                        type="color"
                        value={captionStyle.backgroundColor}
                        onChange={(event) =>
                          setCaptionStyle((value) => ({
                            ...value,
                            backgroundColor: event.target.value,
                          }))
                        }
                        aria-label="Caption background color"
                      />
                      {captionStyle.backgroundColor}
                    </span>
                  </label>
                </div>

                <label className="range-control">
                  <span>
                    Panel opacity <strong>{captionStyle.backgroundOpacity}%</strong>
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

                <label className="range-control">
                  <span>
                    Outline <strong>{captionStyle.outlineWidth}px</strong>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="6"
                    step="0.5"
                    value={captionStyle.outlineWidth}
                    onChange={(event) =>
                      setCaptionStyle((value) => ({
                        ...value,
                        outlineWidth: Number(event.target.value),
                      }))
                    }
                  />
                </label>
              </section>

              <section className="style-section">
                <div className="section-title">
                  <span>Motion & placement</span>
                </div>

                <div className="motion-options">
                  {(["pop", "fade", "slide"] as const).map((animation) => (
                    <button
                      key={animation}
                      className={
                        captionStyle.animation === animation ? "active" : ""
                      }
                      onClick={() =>
                        setCaptionStyle((value) => ({
                          ...value,
                          animation,
                        }))
                      }
                    >
                      <span aria-hidden="true">
                        {animation === "pop"
                          ? "↗"
                          : animation === "fade"
                            ? "◐"
                            : "→"}
                      </span>
                      {animation}
                    </button>
                  ))}
                </div>

                <label className="range-control">
                  <span>
                    Vertical position <strong>{captionStyle.position}%</strong>
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

                <label className="switch-row">
                  <span>
                    Uppercase English
                    <small>Indic scripts stay unchanged</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={captionStyle.uppercaseEnglish}
                    onChange={(event) =>
                      setCaptionStyle((value) => ({
                        ...value,
                        uppercaseEnglish: event.target.checked,
                      }))
                    }
                  />
                </label>
              </section>
            </div>
          )}

          <div className="render-dock">
            {job && (
              <div className="job-progress">
                <span>
                  {job.message ??
                    (job.status === "ready"
                      ? "Ready for your final burn-in"
                      : job.status)}
                </span>
                <div>
                  <i style={{ width: `${job.progress}%` }} />
                </div>
              </div>
            )}
            <button
              className="primary-action"
              onClick={onPrimaryAction}
              disabled={
                isSubmitting ||
                !!job &&
                  ["queued", "extracting", "transcribing", "rendering"].includes(
                    job.status,
                  )
              }
            >
              <span>{actionLabel}</span>
              <span aria-hidden="true">→</span>
            </button>
            <p>
              Preview is instant. ffmpeg runs only after you approve the look.
            </p>
          </div>
        </aside>
      </section>

      {toast && (
        <div className="toast" role="status">
          <span aria-hidden="true">●</span>
          {toast}
          <button onClick={() => setToast("")} aria-label="Dismiss message">
            ×
          </button>
        </div>
      )}
    </main>
  );
}
