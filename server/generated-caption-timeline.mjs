const DEFAULT_MAXIMUM_REPAIR_OVERLAP_MILLISECONDS = 80;
const DEFAULT_MINIMUM_BOUNDARY_WORD_MILLISECONDS = 40;

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
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    timelineError(
      "caption_timeline_invalid",
      `${path} must be a finite number of seconds.`,
      { path },
    );
  }
  return Math.max(
    0,
    Math.min(durationMilliseconds, Math.round(seconds * 1_000)),
  );
}

function seconds(millisecondsValue) {
  return Number((millisecondsValue / 1_000).toFixed(3));
}

function repairWordBoundary(
  previousWord,
  currentWord,
  {
    maximumRepairOverlapMilliseconds,
    minimumBoundaryWordMilliseconds,
    details,
    boundaryLabel,
  },
) {
  const overlapMilliseconds =
    previousWord.endMilliseconds - currentWord.startMilliseconds;
  if (overlapMilliseconds <= 0) return;
  const collision = { ...details, overlapMilliseconds };
  if (overlapMilliseconds > maximumRepairOverlapMilliseconds) {
    timelineError(
      "caption_timeline_overlap",
      `Automatic timing produced an overlap larger than ${maximumRepairOverlapMilliseconds} ms at ${boundaryLabel}.`,
      collision,
    );
  }

  const earliestBoundary = Math.max(
    currentWord.startMilliseconds,
    previousWord.startMilliseconds + minimumBoundaryWordMilliseconds,
  );
  const latestBoundary = Math.min(
    previousWord.endMilliseconds,
    currentWord.endMilliseconds - minimumBoundaryWordMilliseconds,
  );
  if (earliestBoundary > latestBoundary) {
    timelineError(
      "caption_timeline_overlap",
      `Automatic timing could not safely separate ${boundaryLabel}.`,
      {
        ...collision,
        minimumBoundaryWordMilliseconds,
      },
    );
  }

  const midpoint = Math.round(
    (previousWord.endMilliseconds + currentWord.startMilliseconds) / 2,
  );
  const boundaryMilliseconds = Math.max(
    earliestBoundary,
    Math.min(latestBoundary, midpoint),
  );
  previousWord.endMilliseconds = boundaryMilliseconds;
  currentWord.startMilliseconds = boundaryMilliseconds;
  previousWord.value = {
    ...previousWord.value,
    confidence: 0,
    source: "speech-window-review",
    timingSource: "speech-window-review",
  };
  currentWord.value = {
    ...currentWord.value,
    confidence: 0,
    source: "speech-window-review",
    timingSource: "speech-window-review",
  };
}

function normalizedCaption(
  caption,
  captionIndex,
  durationMilliseconds,
  maximumRepairOverlapMilliseconds,
  minimumBoundaryWordMilliseconds,
) {
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
      startMilliseconds,
      endMilliseconds,
    };
  });

  for (let wordIndex = 1; wordIndex < words.length; wordIndex += 1) {
    repairWordBoundary(words[wordIndex - 1], words[wordIndex], {
      maximumRepairOverlapMilliseconds,
      minimumBoundaryWordMilliseconds,
      boundaryLabel: `${captionPath}.words[${wordIndex - 1}/${wordIndex}]`,
      details: {
        captionIndex,
        captionId: String(caption.id ?? ""),
        previousWordIndex: wordIndex - 1,
        previousWordId: String(words[wordIndex - 1].value.id ?? ""),
        wordIndex,
        wordId: String(words[wordIndex].value.id ?? ""),
      },
    });
  }

  return {
    value: { ...caption },
    words,
    startMilliseconds: words[0].startMilliseconds,
    endMilliseconds: words.at(-1).endMilliseconds,
  };
}

function collisionDetails(previous, current, captionIndex, overlapMilliseconds) {
  return {
    previousCaptionIndex: captionIndex - 1,
    previousCaptionId: String(previous.value.id ?? ""),
    captionIndex,
    captionId: String(current.value.id ?? ""),
    previousEndMilliseconds: previous.endMilliseconds,
    startMilliseconds: current.startMilliseconds,
    overlapMilliseconds,
  };
}

function repairBoundary(
  previous,
  current,
  captionIndex,
  maximumRepairOverlapMilliseconds,
  minimumBoundaryWordMilliseconds,
) {
  const overlapMilliseconds =
    previous.endMilliseconds - current.startMilliseconds;
  if (overlapMilliseconds <= 0) return;

  const details = collisionDetails(
    previous,
    current,
    captionIndex,
    overlapMilliseconds,
  );
  if (overlapMilliseconds > maximumRepairOverlapMilliseconds) {
    timelineError(
      "caption_timeline_overlap",
      `Automatic timing produced an overlap larger than ${maximumRepairOverlapMilliseconds} ms between captions ${captionIndex - 1} and ${captionIndex}.`,
      details,
    );
  }

  const previousWord = previous.words.at(-1);
  const currentWord = current.words[0];
  repairWordBoundary(previousWord, currentWord, {
    maximumRepairOverlapMilliseconds,
    minimumBoundaryWordMilliseconds,
    boundaryLabel: `captions ${captionIndex - 1} and ${captionIndex}`,
    details,
  });
  previous.endMilliseconds = previousWord.endMilliseconds;
  current.startMilliseconds = currentWord.startMilliseconds;
}

/**
 * Canonicalizes the compute-owned caption timeline before coverage is measured
 * and an immutable project document is created. Tiny acoustic frame collisions
 * are split at a shared boundary; larger or ambiguous collisions fail closed.
 * Manual/editor documents deliberately do not pass through this repair.
 */
export function finalizeGeneratedCaptionTimeline(
  captions,
  {
    durationSeconds,
    maximumRepairOverlapMilliseconds =
      DEFAULT_MAXIMUM_REPAIR_OVERLAP_MILLISECONDS,
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
  const repairLimit = boundedInteger(
    maximumRepairOverlapMilliseconds,
    0,
    1_000,
    DEFAULT_MAXIMUM_REPAIR_OVERLAP_MILLISECONDS,
  );
  const minimumBoundaryDuration = boundedInteger(
    minimumBoundaryWordMilliseconds,
    1,
    1_000,
    DEFAULT_MINIMUM_BOUNDARY_WORD_MILLISECONDS,
  );
  const normalized = captions.map((caption, captionIndex) =>
    normalizedCaption(
      caption,
      captionIndex,
      durationMilliseconds,
      repairLimit,
      minimumBoundaryDuration,
    ),
  );

  for (let captionIndex = 1; captionIndex < normalized.length; captionIndex += 1) {
    repairBoundary(
      normalized[captionIndex - 1],
      normalized[captionIndex],
      captionIndex,
      repairLimit,
      minimumBoundaryDuration,
    );
  }

  return normalized.map((caption) => ({
    ...caption.value,
    start: seconds(caption.startMilliseconds),
    end: seconds(caption.endMilliseconds),
    words: caption.words.map((word) => ({
      ...word.value,
      start: seconds(word.startMilliseconds),
      end: seconds(word.endMilliseconds),
    })),
  }));
}
