const timestampPattern =
  /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/gi;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundTime(value) {
  return Number(finiteNumber(value).toFixed(3));
}

export function parseSilenceIntervals(output, durationSeconds) {
  const duration = Math.max(0, finiteNumber(durationSeconds));
  const intervals = [];
  let openStart = null;

  for (const match of String(output ?? "").matchAll(timestampPattern)) {
    const type = match[1].toLowerCase();
    const time = Math.max(0, finiteNumber(match[2]));
    if (type === "start") {
      openStart = Math.min(duration || time, time);
      continue;
    }
    if (openStart === null) continue;
    const end = Math.min(duration || time, time);
    if (end > openStart) {
      intervals.push({
        start: roundTime(openStart),
        end: roundTime(end),
      });
    }
    openStart = null;
  }

  if (openStart !== null && duration > openStart) {
    intervals.push({
      start: roundTime(openStart),
      end: roundTime(duration),
    });
  }
  return intervals;
}

export function planSpeechSegments(
  durationSeconds,
  silenceIntervals,
  {
    targetSeconds = 9.5,
    maximumSeconds = 15.5,
    minimumSeconds = 3.2,
    minimumSilenceSeconds = 0.2,
  } = {},
) {
  const duration = Math.max(0, finiteNumber(durationSeconds));
  if (!duration) return [];

  const target = Math.max(4, finiteNumber(targetSeconds, 9.5));
  const maximum = Math.max(
    target + 0.5,
    Math.min(29, finiteNumber(maximumSeconds, 15.5)),
  );
  const minimum = Math.max(
    1,
    Math.min(target - 0.5, finiteNumber(minimumSeconds, 3.2)),
  );
  const silenceMinimum = Math.max(
    0.08,
    finiteNumber(minimumSilenceSeconds, 0.2),
  );
  const silenceCenters = (silenceIntervals ?? [])
    .filter(
      (interval) =>
        finiteNumber(interval?.end) - finiteNumber(interval?.start) >=
        silenceMinimum,
    )
    .map(
      (interval) =>
        (finiteNumber(interval.start) + finiteNumber(interval.end)) / 2,
    )
    .filter((time) => time > 0 && time < duration)
    .sort((left, right) => left - right);

  const segments = [];
  let start = 0;
  while (duration - start > maximum) {
    const earliest = start + minimum;
    const latest = Math.min(duration, start + maximum);
    const desired = Math.min(duration, start + target);
    const candidates = silenceCenters.filter(
      (time) => time >= earliest && time <= latest,
    );
    const end = candidates.length
      ? candidates.reduce((best, candidate) =>
          Math.abs(candidate - desired) < Math.abs(best - desired)
            ? candidate
            : best,
        )
      : latest;
    segments.push({
      id: `speech-${segments.length + 1}`,
      start: roundTime(start),
      end: roundTime(end),
    });
    start = end;
  }

  if (duration > start) {
    segments.push({
      id: `speech-${segments.length + 1}`,
      start: roundTime(start),
      end: roundTime(duration),
    });
  }

  const last = segments.at(-1);
  const previous = segments.at(-2);
  if (
    previous &&
    last &&
    last.end - last.start < minimum &&
    last.end - previous.start < 29
  ) {
    previous.end = last.end;
    segments.pop();
  }

  return segments.map((segment, index) => ({
    ...segment,
    id: `speech-${index + 1}`,
    duration: roundTime(segment.end - segment.start),
  }));
}

export function combineSegmentTranscripts(
  results,
  requestedLanguage = "unknown",
) {
  const captions = (results ?? [])
    .flatMap((result) =>
      (result.captions ?? []).map((caption) => ({
        ...caption,
        start: roundTime(finiteNumber(caption.start) + result.segment.start),
        end: roundTime(finiteNumber(caption.end) + result.segment.start),
        _alignment_padding_before: 0.45,
        _alignment_padding_after: 0.45,
        _source_segment_id: result.segment.id,
      })),
    )
    .filter(
      (caption) =>
        caption.text &&
        Number.isFinite(caption.start) &&
        Number.isFinite(caption.end) &&
        caption.end > caption.start,
    )
    .sort((left, right) => left.start - right.start)
    .map((caption, index) => ({
      ...caption,
      id: `stt-${index + 1}`,
    }));

  const detectedLanguage = (results ?? [])
    .map((result) => result.languageCode)
    .find((language) => language && language !== "unknown");

  return {
    request_id: `syncword-segmented-${Date.now()}`,
    transcript: captions.map((caption) => caption.text).join(" "),
    language_code: detectedLanguage ?? requestedLanguage,
    timestamps: {
      words: captions.map((caption) => caption.text),
      start_time_seconds: captions.map((caption) => caption.start),
      end_time_seconds: captions.map((caption) => caption.end),
      source_segment_ids: captions.map(
        (caption) => caption._source_segment_id,
      ),
    },
    syncword_segmentation: {
      transport: "rest",
      segment_count: results?.length ?? 0,
      speech_windows: (results ?? []).map(({ segment }) => segment),
    },
  };
}
