function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function retimeCaption(
  caption,
  requestedStart,
  requestedEnd,
  previousEnd = 0,
  followingStart = Number.POSITIVE_INFINITY,
) {
  if (!caption?.words?.length) {
    throw new Error("A timed caption needs at least one word.");
  }

  const resolvedFollowingStart = Number.isFinite(followingStart)
    ? followingStart
    : Math.max(requestedEnd, caption.end);
  const availableDuration = resolvedFollowingStart - previousEnd;
  if (availableDuration <= 0) {
    throw new Error("A timed caption needs a positive gap between its neighbors.");
  }
  const minimumDuration = Math.min(0.18, availableDuration);
  const safeStart = clamp(
    requestedStart,
    previousEnd,
    resolvedFollowingStart - minimumDuration,
  );
  const safeEnd = clamp(
    requestedEnd,
    safeStart + minimumDuration,
    resolvedFollowingStart,
  );
  const originalDuration = Math.max(0.18, caption.end - caption.start);
  const scale = (safeEnd - safeStart) / originalDuration;
  const words = caption.words.map((word) => ({
    ...word,
    start: Number(
      (safeStart + (word.start - caption.start) * scale).toFixed(3),
    ),
    end: Number(
      (safeStart + (word.end - caption.start) * scale).toFixed(3),
    ),
    confidence: 1,
    source: "manual",
  }));

  return {
    ...caption,
    start: Number(safeStart.toFixed(3)),
    end: Number(safeEnd.toFixed(3)),
    words,
  };
}
