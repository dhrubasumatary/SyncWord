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
  const safeStart = clamp(
    requestedStart,
    previousEnd,
    Math.max(previousEnd, resolvedFollowingStart - 0.18),
  );
  const safeEnd = clamp(
    requestedEnd,
    safeStart + 0.18,
    Math.max(safeStart + 0.18, resolvedFollowingStart),
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
