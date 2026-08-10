const DEFAULT_SUBSTANTIAL_REPAIR_OVERLAP_MILLISECONDS = 80;
const DEFAULT_MINIMUM_BOUNDARY_WORD_MILLISECONDS = 40;
const ABSOLUTE_MINIMUM_WORD_MILLISECONDS = 1;

export class GeneratedCaptionTimelineError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "GeneratedCaptionTimelineError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function timelineError(code, message, details) {
  throw new GeneratedCaptionTimelineError(code, message, details);
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function milliseconds(value, path, durationMilliseconds) {
  const secondsValue = Number(value);
  if (!Number.isFinite(secondsValue)) {
    timelineError(
      "caption_timeline_invalid",
      `${path} must be a finite number of seconds.`,
      { path },
    );
  }
  return Math.max(
    0,
    Math.min(durationMilliseconds, Math.round(secondsValue * 1_000)),
  );
}

function seconds(millisecondsValue) {
  return Number((millisecondsValue / 1_000).toFixed(3));
}

function normalizedCaption(caption, captionIndex, durationMilliseconds) {
  const captionPath = `captions[${captionIndex}]`;
  if (!caption || typeof caption !== "object" || Array.isArray(caption)) {
    timelineError(
      "caption_timeline_invalid",
      `${captionPath} must be an object.`,
      { captionIndex },
    );
  }
  if (!Array.isArray(caption.words) || caption.words.length === 0) {
    timelineError(
      "caption_timeline_invalid",
      `${captionPath} must contain complete word timings.`,
      { captionIndex, captionId: String(caption.id ?? "") },
    );
  }

  const words = caption.words.map((word, wordIndex) => {
    const wordPath = `${captionPath}.words[${wordIndex}]`;
    if (!word || typeof word !== "object" || Array.isArray(word)) {
      timelineError(
        "caption_timeline_invalid",
        `${wordPath} must be an object.`,
        { captionIndex, wordIndex },
      );
    }
    const startMilliseconds = milliseconds(
      word.start,
      `${wordPath}.start`,
      durationMilliseconds,
    );
    const endMilliseconds = milliseconds(
      word.end,
      `${wordPath}.end`,
      durationMilliseconds,
    );
    if (endMilliseconds <= startMilliseconds) {
      timelineError(
        "caption_timeline_invalid",
        `${wordPath} must have a positive duration after millisecond normalization.`,
        { captionIndex, wordIndex, startMilliseconds, endMilliseconds },
      );
    }
    return {
      value: { ...word },
      captionIndex,
      wordIndex,
      startMilliseconds,
      endMilliseconds,
    };
  });

  return {
    value: { ...caption },
    words,
    startMilliseconds: words[0].startMilliseconds,
    endMilliseconds: words.at(-1).endMilliseconds,
  };
}

function emptyDiagnostics() {
  return {
    repairedBoundaryCount: 0,
    repairedWordCount: 0,
    crossCaptionBoundaryCount: 0,
    substantialOverlapBoundaryCount: 0,
    maximumOverlapMilliseconds: 0,
    maximumAdjustmentMilliseconds: 0,
    minimumDurationFallbackUsed: false,
    reviewRequired: false,
  };
}

function collectCollisions(words) {
  const collisions = [];
  for (let wordIndex = 1; wordIndex < words.length; wordIndex += 1) {
    const previous = words[wordIndex - 1];
    const current = words[wordIndex];
    const overlapMilliseconds =
      previous.endMilliseconds - current.startMilliseconds;
    if (overlapMilliseconds <= 0) continue;
    collisions.push({
      previousWordIndex: wordIndex - 1,
      wordIndex,
      overlapMilliseconds,
      crossCaption: previous.captionIndex !== current.captionIndex,
    });
  }
  return collisions;
}

/**
 * Projects a sequence onto nondecreasing integer values with least-squares
 * pooling. This is the pool-adjacent-violators algorithm. Rounding a block
 * mean cannot invert two already ordered block means, so the result remains
 * monotonic at millisecond precision.
 */
function projectNondecreasing(values, minimum, maximum) {
  const blocks = [];
  for (let index = 0; index < values.length; index += 1) {
    blocks.push({ start: index, end: index, sum: values[index], count: 1 });
    while (blocks.length > 1) {
      const current = blocks.at(-1);
      const previous = blocks.at(-2);
      if (previous.sum / previous.count <= current.sum / current.count) break;
      blocks.splice(-2, 2, {
        start: previous.start,
        end: current.end,
        sum: previous.sum + current.sum,
        count: previous.count + current.count,
      });
    }
  }

  const projected = new Array(values.length);
  for (const block of blocks) {
    const mean = Math.max(
      minimum,
      Math.min(maximum, Math.round(block.sum / block.count)),
    );
    for (let index = block.start; index <= block.end; index += 1) {
      projected[index] = mean;
    }
  }
  return projected;
}

function projectWordTimeline(words, durationMilliseconds, minimumDurations) {
  const requiredDuration = minimumDurations.reduce(
    (total, duration) => total + duration,
    0,
  );
  if (requiredDuration > durationMilliseconds) {
    timelineError(
      "caption_timeline_capacity",
      "Automatic timing contains more words than can receive positive millisecond durations.",
      {
        wordCount: words.length,
        durationMilliseconds,
        requiredDurationMilliseconds: requiredDuration,
      },
    );
  }

  const transformed = [];
  let requiredBefore = 0;
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    transformed.push(words[wordIndex].startMilliseconds - requiredBefore);
    requiredBefore += minimumDurations[wordIndex];
    transformed.push(words[wordIndex].endMilliseconds - requiredBefore);
  }

  const availableSlack = durationMilliseconds - requiredDuration;
  const projected = projectNondecreasing(transformed, 0, availableSlack);
  requiredBefore = 0;
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    words[wordIndex].startMilliseconds = projected[wordIndex * 2] + requiredBefore;
    requiredBefore += minimumDurations[wordIndex];
    words[wordIndex].endMilliseconds = projected[wordIndex * 2 + 1] + requiredBefore;
  }
}

function markWordForReview(word) {
  word.value = {
    ...word.value,
    confidence: 0,
    source: "speech-window-review",
    timingSource: "speech-window-review",
  };
}

function finalizeNormalizedCaptions(normalized) {
  return normalized.map((caption) => {
    caption.startMilliseconds = caption.words[0].startMilliseconds;
    caption.endMilliseconds = caption.words.at(-1).endMilliseconds;
    return {
      ...caption.value,
      start: seconds(caption.startMilliseconds),
      end: seconds(caption.endMilliseconds),
      words: caption.words.map((word) => ({
        ...word.value,
        start: seconds(word.startMilliseconds),
        end: seconds(word.endMilliseconds),
      })),
    };
  });
}

function normalizeGeneratedCaptionTimeline(
  captions,
  {
    durationSeconds,
    maximumRepairOverlapMilliseconds =
      DEFAULT_SUBSTANTIAL_REPAIR_OVERLAP_MILLISECONDS,
    minimumBoundaryWordMilliseconds =
      DEFAULT_MINIMUM_BOUNDARY_WORD_MILLISECONDS,
  } = {},
) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    timelineError(
      "caption_timeline_invalid",
      "durationSeconds must be positive.",
    );
  }
  if (!Array.isArray(captions)) {
    timelineError(
      "caption_timeline_invalid",
      "captions must be an array.",
    );
  }

  const durationMilliseconds = Math.max(1, Math.round(duration * 1_000));
  const substantialRepairThreshold = boundedInteger(
    maximumRepairOverlapMilliseconds,
    0,
    1_000,
    DEFAULT_SUBSTANTIAL_REPAIR_OVERLAP_MILLISECONDS,
  );
  const preferredMinimumDuration = boundedInteger(
    minimumBoundaryWordMilliseconds,
    1,
    1_000,
    DEFAULT_MINIMUM_BOUNDARY_WORD_MILLISECONDS,
  );
  const normalized = captions.map((caption, captionIndex) =>
    normalizedCaption(caption, captionIndex, durationMilliseconds),
  );
  const words = normalized.flatMap((caption) => caption.words);
  const collisions = collectCollisions(words);
  if (collisions.length === 0) {
    return {
      captions: finalizeNormalizedCaptions(normalized),
      diagnostics: emptyDiagnostics(),
    };
  }

  const originalTimings = words.map((word) => ({
    startMilliseconds: word.startMilliseconds,
    endMilliseconds: word.endMilliseconds,
  }));
  const reviewWordIndexes = new Set();
  for (const collision of collisions) {
    reviewWordIndexes.add(collision.previousWordIndex);
    reviewWordIndexes.add(collision.wordIndex);
  }

  let minimumDurations = words.map((_, wordIndex) =>
    reviewWordIndexes.has(wordIndex)
      ? preferredMinimumDuration
      : ABSOLUTE_MINIMUM_WORD_MILLISECONDS,
  );
  let minimumDurationFallbackUsed =
    minimumDurations.reduce((total, value) => total + value, 0) >
    durationMilliseconds;
  if (minimumDurationFallbackUsed) {
    minimumDurations = words.map(() => ABSOLUTE_MINIMUM_WORD_MILLISECONDS);
  }
  projectWordTimeline(words, durationMilliseconds, minimumDurations);

  let maximumAdjustmentMilliseconds = 0;
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    const word = words[wordIndex];
    const original = originalTimings[wordIndex];
    const adjustment = Math.max(
      Math.abs(word.startMilliseconds - original.startMilliseconds),
      Math.abs(word.endMilliseconds - original.endMilliseconds),
    );
    maximumAdjustmentMilliseconds = Math.max(
      maximumAdjustmentMilliseconds,
      adjustment,
    );
    if (adjustment > 0) reviewWordIndexes.add(wordIndex);
  }
  const maximumOverlapMilliseconds = Math.max(
    ...collisions.map((collision) => collision.overlapMilliseconds),
  );
  const substantialOverlapBoundaryCount = collisions.filter(
    (collision) =>
      collision.overlapMilliseconds > substantialRepairThreshold,
  ).length;
  const reviewRequired =
    substantialOverlapBoundaryCount > 0 ||
    minimumDurationFallbackUsed ||
    maximumAdjustmentMilliseconds > substantialRepairThreshold;
  const diagnostics = {
    repairedBoundaryCount: collisions.length,
    repairedWordCount: reviewWordIndexes.size,
    crossCaptionBoundaryCount: collisions.filter(
      (collision) => collision.crossCaption,
    ).length,
    substantialOverlapBoundaryCount,
    maximumOverlapMilliseconds,
    maximumAdjustmentMilliseconds,
    minimumDurationFallbackUsed,
    reviewRequired,
  };
  if (reviewRequired) {
    for (const wordIndex of reviewWordIndexes) {
      markWordForReview(words[wordIndex]);
    }
  }

  return {
    captions: finalizeNormalizedCaptions(normalized),
    diagnostics,
  };
}

/**
 * Canonicalizes the compute-owned caption timeline before coverage is measured
 * and an immutable project document is created. All generated word intervals
 * are projected onto one order-preserving millisecond timeline. Overlap size is
 * recorded for review, not used as a reason to discard an otherwise editable
 * project. Manual/editor documents deliberately do not pass through this path.
 */
export function finalizeGeneratedCaptionTimeline(captions, options = {}) {
  return normalizeGeneratedCaptionTimeline(captions, options).captions;
}

/**
 * The diagnostic variant lets the processing boundary force review for a
 * substantial or minimum-duration fallback repair without changing the legacy
 * array return value used by existing callers.
 */
export function finalizeGeneratedCaptionTimelineWithDiagnostics(
  captions,
  options = {},
) {
  return normalizeGeneratedCaptionTimeline(captions, options);
}
