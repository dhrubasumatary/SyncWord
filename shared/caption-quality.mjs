const trustedWordSources = new Set(["mms-fa", "manual"]);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function acousticCharacterCount(text) {
  const characters = Array.from(String(text ?? "")).filter((character) =>
    /[\p{L}\p{N}]/u.test(character),
  );
  return Math.max(1, characters.length);
}

function expectedMaximumDuration(text) {
  const characters = acousticCharacterCount(text);
  return Math.min(2.6, Math.max(1.15, characters * 0.18 + 0.45));
}

export function wordHighlightDecision(word) {
  if (!word || !String(word.text ?? "").trim()) {
    return { safe: false, reason: "missing_word" };
  }
  if (word.source === "manual") {
    return { safe: true, reason: "manual" };
  }
  if (!trustedWordSources.has(String(word.source ?? ""))) {
    return { safe: false, reason: "estimated_timing" };
  }

  const start = Number(word.start);
  const end = Number(word.end);
  const duration = end - start;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    duration < 0.035
  ) {
    return { safe: false, reason: "invalid_boundary" };
  }
  if (duration > expectedMaximumDuration(word.text)) {
    return { safe: false, reason: "stretched_word" };
  }
  if (Number(word.confidence) < 0.28) {
    return { safe: false, reason: "weak_acoustic_match" };
  }
  return { safe: true, reason: "acoustic_match" };
}

export function canHighlightWord(word) {
  if (typeof word?.highlightSafe === "boolean") {
    return word.highlightSafe;
  }
  return wordHighlightDecision(word).safe;
}

export function canHighlightGroup(words) {
  return (
    Array.isArray(words) &&
    words.length > 0 &&
    words.every((word) => canHighlightWord(word))
  );
}

export function annotateTimingSafety(captions) {
  return (captions ?? []).map((caption) => {
    const words = (caption.words ?? []).map((word) => {
      const decision = wordHighlightDecision(word);
      return {
        ...word,
        highlightSafe: decision.safe,
        highlightReason: decision.reason,
      };
    });
    const safeWords = words.filter((word) => word.highlightSafe).length;
    return {
      ...caption,
      words,
      wordHighlightCoverage: words.length
        ? Number((safeWords / words.length).toFixed(3))
        : 0,
    };
  });
}

export function alignmentQualityReport(alignment) {
  const captions = annotateTimingSafety(alignment?.captions ?? []);
  const words = captions.flatMap((caption) => caption.words ?? []);
  const totalWords = words.length;
  const safeWords = words.filter((word) => word.highlightSafe).length;
  const severeWords = words.filter(
    (word) =>
      word.highlightReason === "invalid_boundary" ||
      Number(word.confidence) < 0.15,
  ).length;
  const safeRatio = totalWords ? safeWords / totalWords : 0;
  const severeRatio = totalWords ? severeWords / totalWords : 1;
  const reportedConfidence = Number(alignment?.summary?.averageConfidence);
  const averageConfidence = Number.isFinite(reportedConfidence)
    ? reportedConfidence
    : totalWords
      ? words.reduce(
          (sum, word) => sum + clamp(Number(word.confidence) || 0, 0, 1),
          0,
        ) / totalWords
      : 0;
  const score = clamp(
    averageConfidence * 0.58 +
      safeRatio * 0.42 -
      severeRatio * 0.38,
    0,
    1,
  );

  return {
    captions,
    totalWords,
    safeWords,
    phraseTimedWords: Math.max(0, totalWords - safeWords),
    severeWords,
    safeRatio: Number(safeRatio.toFixed(3)),
    severeRatio: Number(severeRatio.toFixed(3)),
    averageConfidence: Number(averageConfidence.toFixed(3)),
    score: Number(score.toFixed(3)),
    recoveryRecommended:
      totalWords > 0 &&
      (safeRatio < 0.88 || averageConfidence < 0.53 || severeWords > 0),
  };
}

export function chooseBetterAlignment(primary, candidate) {
  const primaryReport = alignmentQualityReport(primary);
  const candidateReport = alignmentQualityReport(candidate);
  const candidateWins =
    candidateReport.totalWords > 0 &&
    (candidateReport.score > primaryReport.score + 0.035 ||
      (candidateReport.severeWords < primaryReport.severeWords &&
        candidateReport.score >= primaryReport.score - 0.01));

  return candidateWins
    ? {
        alignment: {
          ...candidate,
          captions: candidateReport.captions,
        },
        report: candidateReport,
        selected: "recovery",
      }
    : {
        alignment: {
          ...primary,
          captions: primaryReport.captions,
        },
        report: primaryReport,
        selected: "primary",
      };
}
