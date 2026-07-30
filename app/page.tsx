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
  outlineColor: string;
  outlineWidth: number;
  position: number;
  weight: "600" | "700" | "800";
  animation: "pop" | "fade" | "slide";
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
  assUrl?: string;
};

type StudioTab = "words" | "look" | "export";

const defaultStyle: CaptionStyle = {
  fontFamily: "Noto Sans Bengali",
  fontSize: 50,
  textColor: "#FFFFFF",
  highlightColor: "#DFFF57",
  backgroundColor: "#101010",
  backgroundOpacity: 72,
  outlineColor: "#101010",
  outlineWidth: 2,
  position: 82,
  weight: "800",
  animation: "pop",
};

const stylePresets: Array<{
  name: string;
  note: string;
  values: Partial<CaptionStyle>;
}> = [
  {
    name: "Signal",
    note: "acid word wipe",
    values: {
      textColor: "#FFFFFF",
      highlightColor: "#DFFF57",
      backgroundColor: "#101010",
      backgroundOpacity: 74,
      outlineColor: "#101010",
      outlineWidth: 2,
    },
  },
  {
    name: "Paper",
    note: "clean editorial",
    values: {
      textColor: "#111111",
      highlightColor: "#FF593D",
      backgroundColor: "#F4F0E7",
      backgroundOpacity: 94,
      outlineColor: "#F4F0E7",
      outlineWidth: 1,
    },
  },
  {
    name: "Night",
    note: "high contrast",
    values: {
      textColor: "#FFFFFF",
      highlightColor: "#65A7FF",
      backgroundColor: "#080808",
      backgroundOpacity: 42,
      outlineColor: "#080808",
      outlineWidth: 4,
    },
  },
];

const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

function wordWeight(word: string) {
  const length = Array.from(
    word.replace(/[\p{P}\p{S}]+/gu, "") || word,
  ).length;
  return Math.max(1, length ** 0.72);
}

function distributeWords(
  text: string,
  start: number,
  end: number,
): WordTiming[] {
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  const weights = tokens.map(wordWeight);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cursor = start;

  return tokens.map((token, index) => {
    const wordEnd =
      index === tokens.length - 1
        ? end
        : cursor + ((end - start) * weights[index]) / totalWeight;
    const word = {
      id: `word-${index}-${Math.round(start * 1000)}`,
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

function compactTime(seconds: number) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const milliseconds = Math.floor((safe % 1) * 1000);
  return `${minutes}:${wholeSeconds.toString().padStart(2, "0")}.${milliseconds
    .toString()
    .padStart(3, "0")}`;
}

function rgba(hex: string, opacity: number) {
  const normalized = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  const numeric = Number.parseInt(normalized, 16);
  return `rgba(${(numeric >> 16) & 255}, ${(numeric >> 8) & 255}, ${
    numeric & 255
  }, ${opacity / 100})`;
}

export default function Home() {
  const [tab, setTab] = useState<StudioTab>("words");
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [selectedCaptionId, setSelectedCaptionId] = useState("");
  const [selectedWordIndex, setSelectedWordIndex] = useState(0);
  const [captionStyle, setCaptionStyle] = useState(defaultStyle);
  const [videoUrl, setVideoUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [videoRatio, setVideoRatio] = useState(16 / 9);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [language, setLanguage] = useState("unknown");
  const [job, setJob] = useState<JobResponse | null>(null);
  const [busy, setBusy] = useState(false);
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
  const apiBase =
    configuredApi ||
    (hydrated &&
    ["localhost", "127.0.0.1"].includes(window.location.hostname)
      ? "http://localhost:8787"
      : "");

  const selectedCaption =
    captions.find((caption) => caption.id === selectedCaptionId) ?? captions[0];
  const activeCaption =
    captions.find(
      (caption) =>
        currentTime >= caption.start && currentTime < caption.end,
    ) ?? selectedCaption;
  const activeWord = activeCaption?.words.find(
    (word) => currentTime >= word.start && currentTime < word.end,
  );
  const selectedWord = selectedCaption?.words[selectedWordIndex];

  const alignment: AlignmentSummary = (() => {
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
  })();

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (
      !job ||
      !apiBase ||
      ["ready", "complete", "failed"].includes(job.status)
    ) {
      return;
    }

    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`${apiBase}/v1/jobs/${job.id}`);
        if (!response.ok) return;
        const nextJob = (await response.json()) as JobResponse;
        setJob(nextJob);

        if (nextJob.status === "ready" && nextJob.captions?.length) {
          setCaptions(nextJob.captions);
          setSelectedCaptionId(nextJob.captions[0].id);
          setSelectedWordIndex(0);
          setTab("words");
          setToast(
            `${nextJob.alignment?.totalWords ?? 0} words aligned. Review the amber cuts.`,
          );
        } else if (nextJob.status === "complete") {
          setTab("export");
          setToast("Your ASS-burned video is ready.");
        } else if (nextJob.status === "failed") {
          setToast(nextJob.message ?? "Processing failed.");
        }
      } catch {
        setToast("The render engine is not reachable.");
      }
    }, 2500);

    return () => window.clearInterval(interval);
  }, [apiBase, job]);

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

  const acceptVideo = (nextFile: File) => {
    const looksLikeVideo =
      nextFile.type.startsWith("video/") ||
      /\.(mp4|mov|webm|mkv|m4v)$/i.test(nextFile.name);
    if (!looksLikeVideo) {
      setToast("Choose an MP4, MOV, WebM, or MKV video.");
      return;
    }

    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(URL.createObjectURL(nextFile));
    setFile(nextFile);
    setDuration(0);
    setVideoRatio(16 / 9);
    setCurrentTime(0);
    setCaptions([]);
    setSelectedCaptionId("");
    setSelectedWordIndex(0);
    setJob(null);
    setTab("words");
    setToast("Video loaded on this device. Nothing uploaded yet.");
  };

  const startTranscription = async () => {
    if (!file) {
      videoInputRef.current?.click();
      return;
    }
    if (!apiBase) {
      setToast(
        "Preview is ready. Connect the private render engine to upload and transcribe.",
      );
      return;
    }

    setBusy(true);
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
      setToast("Extracting audio, then Saaras finds the phrase anchors.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const startRender = async () => {
    if (!job || job.status !== "ready" || !apiBase) return;
    setBusy(true);
    try {
      const response = await fetch(`${apiBase}/v1/jobs/${job.id}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ captions, style: captionStyle }),
      });
      const data = (await response.json()) as JobResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Render failed.");
      setJob(data);
      setTab("export");
      setToast("Rendering ASS word wipes into the video.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Render failed.");
    } finally {
      setBusy(false);
    }
  };

  const downloadResult = (kind: "video" | "ass") => {
    const path = kind === "video" ? job?.downloadUrl : job?.assUrl;
    if (!apiBase || !path) {
      setToast(`${kind === "video" ? "Video" : "ASS file"} is not ready yet.`);
      return;
    }
    window.location.href = `${apiBase}${path}`;
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
  };

  const nudgeBoundary = (delta: number) => {
    if (
      !selectedCaption ||
      !selectedWord ||
      selectedWordIndex >= selectedCaption.words.length - 1
    ) {
      return;
    }

    setCaptions((items) =>
      items.map((caption) => {
        if (caption.id !== selectedCaption.id) return caption;
        const words = caption.words.map((word) => ({ ...word }));
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
  };

  const primaryAction = () => {
    if (!file) {
      videoInputRef.current?.click();
    } else if (!job || job.status === "failed") {
      void startTranscription();
    } else if (job.status === "ready") {
      void startRender();
    } else if (job.status === "complete") {
      downloadResult("video");
    }
  };

  const primaryLabel = (() => {
    if (busy) return "Starting…";
    if (!file) return "Choose a video";
    if (!job) return "Find words";
    if (["queued", "extracting", "transcribing"].includes(job.status)) {
      return `${job.message ?? "Listening"} · ${job.progress}%`;
    }
    if (job.status === "ready") return "Render with ASS";
    if (job.status === "rendering") return `Rendering · ${job.progress}%`;
    if (job.status === "complete") return "Download video";
    return "Try again";
  })();

  const processing = Boolean(
    busy ||
      (job &&
        ["queued", "extracting", "transcribing", "rendering"].includes(
          job.status,
        )),
  );

  return (
    <main className="mobile-studio">
      <header className="studio-header">
        <a className="wordmark" href="#" aria-label="SyncWord home">
          <span>SYNC</span>
          <b>WORD</b>
        </a>
        <div className={`engine-pill ${apiBase ? "online" : ""}`}>
          <i />
          {apiBase ? "engine ready" : "preview mode"}
        </div>
      </header>

      {!file ? (
        <section className="start-screen">
          <div className="start-copy">
            <p>ASS CAPTION WORKSHOP</p>
            <h1>
              Make every word
              <em>hit on time.</em>
            </h1>
            <span>
              Assamese and Bodo captions with phrase-anchored word timing.
              Nothing fake appears before your video does.
            </span>
          </div>

          <button
            className="drop-zone"
            onClick={() => videoInputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const dropped = event.dataTransfer.files[0];
              if (dropped) acceptVideo(dropped);
            }}
          >
            <span className="drop-icon">
              <i />
            </span>
            <strong>Choose a video</strong>
            <small>MP4, MOV, WebM or MKV</small>
          </button>

          <ol className="pipeline-strip" aria-label="Captioning pipeline">
            <li>
              <b>01</b>
              <span>Video</span>
            </li>
            <li>
              <b>02</b>
              <span>Audio</span>
            </li>
            <li>
              <b>03</b>
              <span>Saaras</span>
            </li>
            <li>
              <b>04</b>
              <span>Words</span>
            </li>
            <li>
              <b>05</b>
              <span>ASS</span>
            </li>
          </ol>

          <div className="start-footnote">
            <span>No account theatre.</span>
            <span>No mock transcript.</span>
            <span>Your video stays local until you tap Find words.</span>
          </div>
        </section>
      ) : (
        <>
          <section className="project-intro">
            <p>NOW WORKING ON</p>
            <h1>{file.name}</h1>
            <button onClick={() => videoInputRef.current?.click()}>
              Replace video
            </button>
          </section>

          <section className="video-stage" style={previewStyle}>
            <div
              className={`video-frame ${videoRatio < 1 ? "portrait" : ""}`}
            >
              <video
                ref={videoRef}
                src={videoUrl}
                onLoadedMetadata={(event) => {
                  if (Number.isFinite(event.currentTarget.duration)) {
                    setDuration(event.currentTarget.duration);
                  }
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

              {activeCaption && (
                <div className="ass-preview">
                  {activeCaption.words.map((word) => (
                    <span
                      key={word.id}
                      className={activeWord?.id === word.id ? "active" : ""}
                    >
                      {word.text}
                    </span>
                  ))}
                </div>
              )}

              {!captions.length && (
                <div className="uncaptioned-label">NO CAPTIONS YET</div>
              )}
            </div>

            <div className="player-row">
              <button
                className="play-button"
                onClick={togglePlayback}
                aria-label={playing ? "Pause video" : "Play video"}
              >
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

          <nav className="studio-tabs" aria-label="Caption workflow">
            {(
              [
                ["words", "01", "Words"],
                ["look", "02", "Look"],
                ["export", "03", "Export"],
              ] as const
            ).map(([value, number, label]) => (
              <button
                key={value}
                className={tab === value ? "active" : ""}
                onClick={() => setTab(value)}
              >
                <small>{number}</small>
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <section className="control-sheet">
            {tab === "words" && !captions.length && (
              <div className="generate-panel">
                <div className="section-kicker">LISTEN</div>
                <h2>Turn phrase timing into word timing.</h2>
                <p>
                  Saaras v3 finds the real phrase edges. WordSync then places
                  each word against the waveform and flags uncertain cuts.
                </p>

                <div className="language-block">
                  <span>Spoken language</span>
                  <div className="language-pills">
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
                          if (value === "brx-IN") {
                            setCaptionStyle((current) => ({
                              ...current,
                              fontFamily: "Noto Sans Devanagari",
                            }));
                          } else if (value === "as-IN") {
                            setCaptionStyle((current) => ({
                              ...current,
                              fontFamily: "Noto Sans Bengali",
                            }));
                          }
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="truth-card">
                  <span>WHAT ACTUALLY HAPPENS</span>
                  <ol>
                    <li>
                      <b>Phrase anchors</b>
                      <small>Saaras v3 Batch · codemix</small>
                    </li>
                    <li>
                      <b>Word boundaries</b>
                      <small>20ms waveform analysis</small>
                    </li>
                    <li>
                      <b>Review</b>
                      <small>Only low-confidence cuts</small>
                    </li>
                  </ol>
                </div>
              </div>
            )}

            {tab === "words" && selectedCaption && (
              <div className="word-editor">
                <div className="alignment-head">
                  <div>
                    <span className="section-kicker">WORD SYNC</span>
                    <h2>
                      {alignment.needsReview
                        ? `${alignment.needsReview} cuts need ears.`
                        : "Every cut reviewed."}
                    </h2>
                  </div>
                  <div className="confidence-orbit">
                    <strong>
                      {Math.round(alignment.averageConfidence * 100)}
                    </strong>
                    <span>%</span>
                  </div>
                </div>

                <div className="phrase-tabs">
                  {captions.map((caption, index) => (
                    <button
                      key={caption.id}
                      className={
                        selectedCaption.id === caption.id ? "active" : ""
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

                <label className="phrase-copy">
                  <span>Phrase transcript</span>
                  <textarea
                    rows={2}
                    value={selectedCaption.text}
                    onChange={(event) => updateCaptionText(event.target.value)}
                  />
                  <small>
                    {compactTime(selectedCaption.start)} —{" "}
                    {compactTime(selectedCaption.end)}
                  </small>
                </label>

                <div className="word-ribbon" aria-label="Aligned words">
                  {selectedCaption.words.map((word, index) => (
                    <button
                      key={word.id}
                      className={`${selectedWordIndex === index ? "active" : ""} ${
                        word.confidence < 0.62 ? "review" : ""
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
                  <div className="cut-inspector">
                    <div>
                      <span>Selected word</span>
                      <strong>{selectedWord.text}</strong>
                    </div>
                    <div>
                      <span>Starts</span>
                      <strong>{compactTime(selectedWord.start)}</strong>
                    </div>
                    <div>
                      <span>Ends</span>
                      <strong>{compactTime(selectedWord.end)}</strong>
                    </div>
                    <div>
                      <span>Source</span>
                      <strong>
                        {selectedWord.source === "manual"
                          ? "manual"
                          : `${Math.round(selectedWord.confidence * 100)}%`}
                      </strong>
                    </div>
                    {selectedWordIndex < selectedCaption.words.length - 1 && (
                      <div className="nudge-row">
                        <button onClick={() => nudgeBoundary(-0.03)}>
                          − 30ms
                        </button>
                        <span>move next cut</span>
                        <button onClick={() => nudgeBoundary(0.03)}>
                          + 30ms
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {tab === "look" && (
              <div className="look-panel">
                <span className="section-kicker">ASS STYLE</span>
                <h2>Style the burn, not a screenshot.</h2>
                <p>
                  This preview becomes an ASS style and ffmpeg renders the same
                  font, outline, position, word wipe, and line motion.
                </p>

                <div className="preset-stack">
                  {stylePresets.map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() =>
                        setCaptionStyle((value) => ({
                          ...value,
                          ...preset.values,
                        }))
                      }
                    >
                      <i
                        style={{
                          color: preset.values.textColor,
                          background: rgba(
                            preset.values.backgroundColor ?? "#101010",
                            preset.values.backgroundOpacity ?? 70,
                          ),
                          boxShadow: `inset 0 -3px ${
                            preset.values.highlightColor
                          }`,
                        }}
                      >
                        WORD
                      </i>
                      <span>
                        <strong>{preset.name}</strong>
                        <small>{preset.note}</small>
                      </span>
                      <b>→</b>
                    </button>
                  ))}
                </div>

                <div className="style-grid">
                  <label>
                    Script font
                    <select
                      aria-label="Script font"
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
                  <label>
                    Line motion
                    <select
                      aria-label="Line motion"
                      value={captionStyle.animation}
                      onChange={(event) =>
                        setCaptionStyle((value) => ({
                          ...value,
                          animation: event.target
                            .value as CaptionStyle["animation"],
                        }))
                      }
                    >
                      <option value="pop">Pop in</option>
                      <option value="fade">Fade</option>
                      <option value="slide">Slide up</option>
                    </select>
                  </label>
                </div>

                <div className="color-row">
                  {(
                    [
                      ["Text", "textColor"],
                      ["Active", "highlightColor"],
                      ["Box", "backgroundColor"],
                    ] as const
                  ).map(([label, key]) => (
                    <label key={key}>
                      <input
                        type="color"
                        value={captionStyle[key]}
                        onChange={(event) =>
                          setCaptionStyle((value) => ({
                            ...value,
                            [key]: event.target.value,
                          }))
                        }
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>

                <div className="slider-stack">
                  {[
                    ["Size", "fontSize", 28, 84, "px"],
                    ["Position", "position", 56, 90, "%"],
                    [
                      "Background",
                      "backgroundOpacity",
                      0,
                      100,
                      "%",
                    ],
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
                          setCaptionStyle((value) => ({
                            ...value,
                            [key]: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}

            {tab === "export" && (
              <div className="export-panel">
                <span className="section-kicker">FINAL BURN</span>
                <h2>ASS in. Captioned MP4 out.</h2>
                <p>
                  No plain SRT compromise. The render keeps the chosen script
                  font, active-word color, outline, position, and line motion.
                </p>

                <div className="export-receipt">
                  <div>
                    <span>Format</span>
                    <strong>Advanced SubStation Alpha</strong>
                  </div>
                  <div>
                    <span>Word timing</span>
                    <strong>
                      {alignment.totalWords
                        ? `${alignment.totalWords} aligned words`
                        : "Waiting for transcript"}
                    </strong>
                  </div>
                  <div>
                    <span>Karaoke</span>
                    <strong>ASS \kf sweep</strong>
                  </div>
                  <div>
                    <span>Line motion</span>
                    <strong>{captionStyle.animation}</strong>
                  </div>
                  <div>
                    <span>Render</span>
                    <strong>ffmpeg · H.264</strong>
                  </div>
                </div>

                {job?.status === "complete" && (
                  <div className="download-pair">
                    <button onClick={() => downloadResult("video")}>
                      Download video
                    </button>
                    <button onClick={() => downloadResult("ass")}>
                      Download .ASS
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          <div className="action-dock">
            {job && (
              <div className="progress-copy">
                <span>{job.message}</span>
                <i>
                  <b style={{ width: `${job.progress}%` }} />
                </i>
              </div>
            )}
            <button
              className="primary-action"
              onClick={primaryAction}
              disabled={processing}
            >
              <span>{primaryLabel}</span>
              <b>↗</b>
            </button>
          </div>
        </>
      )}

      <input
        ref={videoInputRef}
        type="file"
        accept="video/*,.mkv"
        hidden
        onChange={(event) => {
          const nextFile = event.target.files?.[0];
          if (nextFile) acceptVideo(nextFile);
          event.target.value = "";
        }}
      />

      {toast && (
        <div className="studio-toast" role="status">
          <span>{toast}</span>
          <button onClick={() => setToast("")} aria-label="Dismiss message">
            ×
          </button>
        </div>
      )}
    </main>
  );
}
