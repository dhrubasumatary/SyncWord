const coverageRevision = "speech-active-v1";

export const defaultCaptionCoveragePolicy = Object.freeze({
  minimumCoverageRatio: 0.92,
  maximumUncoveredGapSeconds: 1.5,
  captionBoundaryPaddingSeconds: 0.12,
  captionMergeGapSeconds: 0.24,
  minimumSpeechIntervalSeconds: 0.12,
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundTime(value) {
  return Number(finiteNumber(value).toFixed(3));
}

function durationOf(interval) {
  return Math.max(0, finiteNumber(interval?.end) - finiteNumber(interval?.start));
}

function intervalOverlap(left, right) {
  return Math.max(
    0,
    Math.min(finiteNumber(left?.end), finiteNumber(right?.end)) -
      Math.max(finiteNumber(left?.start), finiteNumber(right?.start)),
  );
}

export function normalizeTimeIntervals(
  intervals,
  {
    minimum = 0,
    maximum = Number.POSITIVE_INFINITY,
    minimumDurationSeconds = 0,
    mergeGapSeconds = 0,
  } = {},
) {
  const lowerBound = finiteNumber(minimum);
  const upperBound = Number.isFinite(Number(maximum))
    ? Math.max(lowerBound, Number(maximum))
    : Number.POSITIVE_INFINITY;
  const minimumDuration = Math.max(0, finiteNumber(minimumDurationSeconds));
  const mergeGap = Math.max(0, finiteNumber(mergeGapSeconds));
  const normalized = (intervals ?? [])
    .map((interval) => ({
      start: Math.max(lowerBound, finiteNumber(interval?.start, Number.NaN)),
      end: Math.min(upperBound, finiteNumber(interval?.end, Number.NaN)),
    }))
    .filter(
      (interval) =>
        Number.isFinite(interval.start) &&
        Number.isFinite(interval.end) &&
        interval.end - interval.start >= minimumDuration &&
        interval.end > interval.start,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged = [];
  for (const interval of normalized) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end + mergeGap) {
      previous.end = Math.max(previous.end, interval.end);
      continue;
    }
    merged.push({ ...interval });
  }

  return merged.map((interval) => ({
    start: roundTime(interval.start),
    end: roundTime(interval.end),
  }));
}

export function speechIntervalsFromSilences(
  durationSeconds,
  silenceIntervals,
  { minimumSpeechIntervalSeconds = defaultCaptionCoveragePolicy.minimumSpeechIntervalSeconds } = {},
) {
  const duration = Math.max(0, finiteNumber(durationSeconds));
  if (!duration) return [];

  const silences = normalizeTimeIntervals(silenceIntervals, {
    maximum: duration,
  });
  const speech = [];
  let cursor = 0;
  for (const silence of silences) {
    if (silence.start > cursor) {
      speech.push({ start: cursor, end: silence.start });
    }
    cursor = Math.max(cursor, silence.end);
  }
  if (cursor < duration) speech.push({ start: cursor, end: duration });

  return normalizeTimeIntervals(speech, {
    maximum: duration,
    minimumDurationSeconds: Math.max(
      0,
      finiteNumber(minimumSpeechIntervalSeconds),
    ),
  });
}

function validWordIntervals(words) {
  return (words ?? [])
    .map((word) => ({
      start: finiteNumber(word?.start, Number.NaN),
      end: finiteNumber(word?.end, Number.NaN),
    }))
    .filter(
      (word) =>
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.end > word.start,
    );
}

export function captionIntervalsFromCaptions(
  captions,
  {
    durationSeconds = Number.POSITIVE_INFINITY,
    boundaryPaddingSeconds =
      defaultCaptionCoveragePolicy.captionBoundaryPaddingSeconds,
    mergeGapSeconds = defaultCaptionCoveragePolicy.captionMergeGapSeconds,
  } = {},
) {
  const maximum = Number.isFinite(Number(durationSeconds))
    ? Math.max(0, Number(durationSeconds))
    : Number.POSITIVE_INFINITY;
  const padding = Math.max(0, finiteNumber(boundaryPaddingSeconds));
  const intervals = (captions ?? []).flatMap((caption) => {
    if (!String(caption?.text ?? "").trim()) return [];
    const words = validWordIntervals(caption?.words);
    const start = words.length
      ? Math.min(...words.map((word) => word.start))
      : finiteNumber(caption?.start, Number.NaN);
    const end = words.length
      ? Math.max(...words.map((word) => word.end))
      : finiteNumber(caption?.end, Number.NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return [];
    }
    return [{ start: start - padding, end: end + padding }];
  });

  return normalizeTimeIntervals(intervals, {
    maximum,
    mergeGapSeconds,
  });
}

function intersectIntervals(leftIntervals, rightIntervals) {
  const intersections = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (
    leftIndex < leftIntervals.length &&
    rightIndex < rightIntervals.length
  ) {
    const left = leftIntervals[leftIndex];
    const right = rightIntervals[rightIndex];
    const start = Math.max(left.start, right.start);
    const end = Math.min(left.end, right.end);
    if (end > start) intersections.push({ start, end });
    if (left.end <= right.end) leftIndex += 1;
    else rightIndex += 1;
  }
  return normalizeTimeIntervals(intersections);
}

function subtractIntervals(sourceIntervals, removalIntervals) {
  const remainder = [];
  let removalIndex = 0;
  for (const source of sourceIntervals) {
    let cursor = source.start;
    while (
      removalIndex < removalIntervals.length &&
      removalIntervals[removalIndex].end <= source.start
    ) {
      removalIndex += 1;
    }
    let index = removalIndex;
    while (
      index < removalIntervals.length &&
      removalIntervals[index].start < source.end
    ) {
      const removal = removalIntervals[index];
      if (removal.start > cursor) {
        remainder.push({
          start: cursor,
          end: Math.min(source.end, removal.start),
        });
      }
      cursor = Math.max(cursor, removal.end);
      if (cursor >= source.end) break;
      index += 1;
    }
    if (cursor < source.end) remainder.push({ start: cursor, end: source.end });
  }
  return normalizeTimeIntervals(remainder);
}

function sumDuration(intervals) {
  return (intervals ?? []).reduce(
    (sum, interval) => sum + durationOf(interval),
    0,
  );
}

function resolvedPolicy(policy = {}) {
  return {
    minimumCoverageRatio: Math.max(
      0,
      Math.min(
        1,
        finiteNumber(
          policy.minimumCoverageRatio,
          defaultCaptionCoveragePolicy.minimumCoverageRatio,
        ),
      ),
    ),
    maximumUncoveredGapSeconds: Math.max(
      0,
      finiteNumber(
        policy.maximumUncoveredGapSeconds,
        defaultCaptionCoveragePolicy.maximumUncoveredGapSeconds,
      ),
    ),
    captionBoundaryPaddingSeconds: Math.max(
      0,
      finiteNumber(
        policy.captionBoundaryPaddingSeconds,
        defaultCaptionCoveragePolicy.captionBoundaryPaddingSeconds,
      ),
    ),
    captionMergeGapSeconds: Math.max(
      0,
      finiteNumber(
        policy.captionMergeGapSeconds,
        defaultCaptionCoveragePolicy.captionMergeGapSeconds,
      ),
    ),
  };
}

export function evaluateCaptionCoverage(
  speechIntervals,
  captions,
  { durationSeconds = Number.POSITIVE_INFINITY, policy = {} } = {},
) {
  const resolved = resolvedPolicy(policy);
  const maximum = Number.isFinite(Number(durationSeconds))
    ? Math.max(0, Number(durationSeconds))
    : Number.POSITIVE_INFINITY;
  const speech = normalizeTimeIntervals(speechIntervals, { maximum });
  const captionIntervals = captionIntervalsFromCaptions(captions, {
    durationSeconds: maximum,
    boundaryPaddingSeconds: resolved.captionBoundaryPaddingSeconds,
    mergeGapSeconds: resolved.captionMergeGapSeconds,
  });
  const coveredIntervals = intersectIntervals(speech, captionIntervals);
  const uncoveredIntervals = subtractIntervals(speech, coveredIntervals).map(
    (interval) => ({
      ...interval,
      duration: roundTime(durationOf(interval)),
    }),
  );
  const speechDuration = sumDuration(speech);
  const coveredDuration = sumDuration(coveredIntervals);
  const uncoveredDuration = Math.max(0, speechDuration - coveredDuration);
  const coverageRatio = speechDuration ? coveredDuration / speechDuration : 1;
  const largestUncoveredGap = uncoveredIntervals.reduce(
    (largest, interval) => Math.max(largest, interval.duration),
    0,
  );
  const reasons = [];
  if (coverageRatio < resolved.minimumCoverageRatio) {
    reasons.push("coverage_below_threshold");
  }
  if (largestUncoveredGap > resolved.maximumUncoveredGapSeconds) {
    reasons.push("uncovered_gap_too_long");
  }

  return {
    revision: coverageRevision,
    complete: reasons.length === 0,
    speechDurationSeconds: roundTime(speechDuration),
    coveredSpeechDurationSeconds: roundTime(coveredDuration),
    uncoveredDurationSeconds: roundTime(uncoveredDuration),
    coverageRatio: Number(coverageRatio.toFixed(3)),
    largestUncoveredGapSeconds: roundTime(largestUncoveredGap),
    speechIntervals: speech,
    captionIntervals,
    coveredIntervals,
    uncoveredIntervals,
    reasons,
    policy: {
      minimumCoverageRatio: resolved.minimumCoverageRatio,
      maximumUncoveredGapSeconds: resolved.maximumUncoveredGapSeconds,
    },
  };
}

function splitRecoveryInterval(
  interval,
  maximumWindowSeconds,
  overlapSeconds,
) {
  const windows = [];
  let start = interval.start;
  while (interval.end - start > maximumWindowSeconds) {
    const end = start + maximumWindowSeconds;
    windows.push({ start, end });
    start = Math.max(start + 0.1, end - overlapSeconds);
  }
  if (interval.end > start) windows.push({ start, end: interval.end });
  return windows;
}

export function planCoverageRecoveryWindows(
  uncoveredIntervals,
  durationSeconds,
  {
    paddingSeconds = 0.45,
    mergeGapSeconds = 0.35,
    minimumGapSeconds = 0.18,
    maximumWindowSeconds = 28,
    overlapSeconds = 0.45,
    maximumWindows = 8,
  } = {},
) {
  const duration = Math.max(0, finiteNumber(durationSeconds));
  if (!duration) return [];
  const padding = Math.max(0, Math.min(2, finiteNumber(paddingSeconds)));
  const minimumGap = Math.max(0, finiteNumber(minimumGapSeconds, 0.18));
  const recoveryMergeGap = Math.max(
    0,
    Math.min(2, finiteNumber(mergeGapSeconds, 0.35)),
  );
  const maximumWindow = Math.max(
    1,
    Math.min(29, finiteNumber(maximumWindowSeconds, 28)),
  );
  const overlap = Math.max(
    0,
    Math.min(maximumWindow - 0.1, finiteNumber(overlapSeconds, 0.45)),
  );
  const limit = Math.max(
    1,
    Math.min(12, Math.floor(finiteNumber(maximumWindows, 8))),
  );
  const padded = normalizeTimeIntervals(
    (uncoveredIntervals ?? [])
      .filter((interval) => durationOf(interval) >= minimumGap)
      .map((interval) => ({
        start: finiteNumber(interval.start) - padding,
        end: finiteNumber(interval.end) + padding,
      })),
    {
      maximum: duration,
      mergeGapSeconds: recoveryMergeGap,
    },
  );

  return padded
    .flatMap((interval) =>
      splitRecoveryInterval(interval, maximumWindow, overlap),
    )
    .slice(0, limit)
    .map((interval, index) => ({
      id: `coverage-recovery-${index + 1}`,
      start: roundTime(interval.start),
      end: roundTime(interval.end),
      duration: roundTime(interval.end - interval.start),
    }));
}

function normalizedCaptionText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function captionInterval(caption) {
  const words = validWordIntervals(caption?.words);
  const start = words.length
    ? Math.min(...words.map((word) => word.start))
    : finiteNumber(caption?.start, Number.NaN);
  const end = words.length
    ? Math.max(...words.map((word) => word.end))
    : finiteNumber(caption?.end, Number.NaN);
  return { start, end };
}

export function mergeRecoveredCaptions(
  primaryCaptions,
  recoveredCaptions,
  uncoveredIntervals,
) {
  const primary = (primaryCaptions ?? []).filter((caption) =>
    String(caption?.text ?? "").trim(),
  );
  const gaps = normalizeTimeIntervals(uncoveredIntervals);
  const additions = [];

  for (const caption of recoveredCaptions ?? []) {
    const text = normalizedCaptionText(caption?.text);
    const interval = captionInterval(caption);
    if (
      !text ||
      !Number.isFinite(interval.start) ||
      !Number.isFinite(interval.end) ||
      interval.end <= interval.start
    ) {
      continue;
    }
    const missingOverlap = gaps.reduce(
      (sum, gap) => sum + intervalOverlap(interval, gap),
      0,
    );
    if (missingOverlap < Math.min(0.12, durationOf(interval) * 0.25)) {
      continue;
    }
    const primaryOverlap = primary.reduce(
      (sum, existing) =>
        sum + intervalOverlap(interval, captionInterval(existing)),
      0,
    );
    if (
      primaryOverlap >= missingOverlap &&
      primaryOverlap / durationOf(interval) >= 0.5
    ) {
      continue;
    }

    const duplicate = [...primary, ...additions].some((existing) => {
      if (normalizedCaptionText(existing?.text) !== text) return false;
      const existingInterval = captionInterval(existing);
      return (
        intervalOverlap(interval, existingInterval) > 0 ||
        Math.abs(interval.start - existingInterval.start) <= 1.2
      );
    });
    if (duplicate) continue;

    additions.push({
      ...caption,
      _coverage_recovery: true,
    });
  }

  const captions = [...primary, ...additions]
    .sort(
      (left, right) =>
        finiteNumber(left?.start) - finiteNumber(right?.start) ||
        finiteNumber(left?.end) - finiteNumber(right?.end),
    )
    .map((caption, index) => ({
      ...caption,
      id: `stt-${index + 1}`,
    }));

  return { captions, additions, addedCaptionCount: additions.length };
}

export function coverageMateriallyImproves(primary, candidate) {
  if (!candidate) return false;
  if (!primary) return true;
  if (candidate.complete && !primary.complete) return true;
  const ratioGain =
    finiteNumber(candidate.coverageRatio) - finiteNumber(primary.coverageRatio);
  const gapReduction =
    finiteNumber(primary.largestUncoveredGapSeconds) -
    finiteNumber(candidate.largestUncoveredGapSeconds);
  return ratioGain >= 0.01 && gapReduction >= -0.05;
}

export function canRenderCaptionTrack(status, coverage) {
  return (
    ["ready", "complete"].includes(String(status ?? "")) &&
    coverage?.complete !== false
  );
}
