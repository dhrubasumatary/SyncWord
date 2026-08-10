const DEFAULT_FPS = 30;
const DEFAULT_GOP_SECONDS = 2;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function parseFrameRate(value) {
  if (typeof value === "number") {
    return value > 0 ? value : DEFAULT_FPS;
  }
  const candidate = String(value ?? "").trim();
  if (!candidate) return DEFAULT_FPS;
  const [numeratorText, denominatorText] = candidate.split("/");
  const numerator = finiteNumber(numeratorText);
  const denominator = finiteNumber(denominatorText ?? 1);
  if (!numerator || !denominator || denominator <= 0) return DEFAULT_FPS;
  const frameRate = numerator / denominator;
  return frameRate > 0 ? frameRate : DEFAULT_FPS;
}

export function exportFrameRateMatchesSource(
  sourceFrameRate,
  requestedFrameRate,
  tolerance = 0.02,
) {
  if (requestedFrameRate === "source") return true;
  const requested = finiteNumber(requestedFrameRate);
  return (
    requested !== undefined &&
    requested > 0 &&
    Math.abs(parseFrameRate(sourceFrameRate) - requested) <= tolerance
  );
}

/**
 * Builds the loss/seekability policy for a caption-only MP4 export.
 *
 * AAC-LC is stream-copied when its timeline already matches the video because
 * captions do not alter it. Other codecs/profiles are converted once to
 * AAC-LC. FFmpeg receives explicit audio and cloned-frame padding when source
 * edit metadata outlasts decoded packets, preserving the advertised timeline
 * without a black frame or an early `-shortest` cut.
 */
export function buildExportMediaPolicy(video = {}, options = {}) {
  const frameRate = parseFrameRate(video.frameRate);
  const requestedGopSeconds = finiteNumber(options.gopSeconds);
  const gopSeconds = clamp(
    requestedGopSeconds ?? DEFAULT_GOP_SECONDS,
    1,
    5,
  );
  const keyframeIntervalFrames = Math.max(
    1,
    Math.round(frameRate * gopSeconds),
  );

  const audio = video.audio && typeof video.audio === "object"
    ? video.audio
    : undefined;
  const hasAudio = Boolean(audio);
  const sourceAudioCodec = String(audio?.codecName ?? "").toLowerCase();
  const sourceAudioProfile = String(audio?.profile ?? "").toLowerCase();
  const channels = finiteNumber(audio?.channels);

  const videoDuration = finiteNumber(
    video.streamDuration ?? video.duration,
  );
  const audioDuration = finiteNumber(audio?.duration);
  const frameDuration = 1 / frameRate;
  const targetDuration =
    videoDuration !== undefined || audioDuration !== undefined
      ? Math.max(videoDuration ?? 0, audioDuration ?? 0)
      : undefined;
  const audioTail =
    videoDuration !== undefined && audioDuration !== undefined
      ? audioDuration - videoDuration
      : 0;
  const tailPadSeconds =
    audioTail > frameDuration / 2
      ? Math.round(audioTail * 1_000_000) / 1_000_000
      : 0;
  const copyAudio =
    hasAudio &&
    sourceAudioCodec === "aac" &&
    !sourceAudioProfile.includes("he-aac") &&
    tailPadSeconds === 0;
  const audioArgs = !hasAudio
    ? []
    : copyAudio
      ? ["-c:a", "copy"]
      : [
          "-c:a",
          "aac",
          "-b:a",
          channels === 1 ? "80k" : "128k",
        ];
  const audioFilterArgs =
    hasAudio && !copyAudio && targetDuration
      ? ["-af", `apad=whole_dur=${targetDuration}`]
      : [];

  return {
    frameRate,
    keyframeIntervalFrames,
    gopSeconds,
    hasAudio,
    audioMode: !hasAudio ? "none" : copyAudio ? "copy" : "aac",
    audioArgs,
    audioFilterArgs,
    audioTargetDuration: targetDuration,
    tailPadSeconds,
    useShortest: false,
  };
}

export function exportVideoArgs(policy) {
  return [
    "-g",
    String(policy.keyframeIntervalFrames),
    "-keyint_min",
    String(policy.keyframeIntervalFrames),
    "-sc_threshold",
    "0",
  ];
}
