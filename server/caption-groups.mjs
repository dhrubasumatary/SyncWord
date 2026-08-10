function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function captionsHaveWordTimings(captions) {
  return (
    Array.isArray(captions) &&
    captions.length > 0 &&
    captions.every(
      (caption) =>
        caption &&
        Number.isFinite(Number(caption.start)) &&
        Number.isFinite(Number(caption.end)) &&
        Number(caption.end) > Number(caption.start) &&
        Array.isArray(caption.words) &&
        caption.words.length > 0 &&
        caption.words.every(
          (word) =>
            word &&
            String(word.text ?? "").trim() &&
            Number.isFinite(Number(word.start)) &&
            Number.isFinite(Number(word.end)) &&
            Number(word.end) > Number(word.start),
        ),
    )
  );
}

function wordCount(caption) {
  if (Array.isArray(caption?.words) && caption.words.length) {
    return caption.words.length;
  }
  return String(caption?.text ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length;
}

function endsStrongPhrase(text) {
  return /[.!?।॥…]["'”’)]*$/u.test(String(text ?? "").trim());
}

function mergeCaptions(left, right) {
  const words = [...(left.words ?? []), ...(right.words ?? [])].map(
    (word, index) => ({
      ...word,
      id: `${left.id}+${right.id}-word-${index + 1}`,
    }),
  );
  return {
    ...left,
    id: `${left.id}+${right.id}`,
    start: Math.min(Number(left.start), Number(right.start)),
    end: Math.max(Number(left.end), Number(right.end)),
    text: `${String(left.text ?? "").trim()} ${String(
      right.text ?? "",
    ).trim()}`.trim(),
    language: left.language,
    words,
  };
}

/**
 * Sarvam occasionally returns a tiny chunk at a phrase edge. Keep its accurate
 * timestamp, but attach the orphan to a nearby phrase when the pause is short.
 * This prevents a grammatical particle from becoming a one-word caption card.
 */
export function stitchShortCaptionPhrases(
  captions,
  {
    maxGapSeconds = 0.42,
    minimumPhraseWords = 2,
    maximumMergedWords = 12,
  } = {},
) {
  const stitched = [];

  for (const source of captions ?? []) {
    const caption = {
      ...source,
      words: Array.isArray(source.words)
        ? source.words.map((word) => ({ ...word }))
        : [],
    };
    const previous = stitched.at(-1);
    if (!previous) {
      stitched.push(caption);
      continue;
    }

    const gap = Number(caption.start) - Number(previous.end);
    const previousWords = wordCount(previous);
    const currentWords = wordCount(caption);
    const hasOrphan =
      previousWords < minimumPhraseWords ||
      currentWords < minimumPhraseWords;
    const canCrossBoundary =
      !endsStrongPhrase(previous.text) ||
      previousWords < minimumPhraseWords;
    const canMerge =
      gap >= -0.08 &&
      gap <= maxGapSeconds &&
      hasOrphan &&
      canCrossBoundary &&
      previousWords + currentWords <= maximumMergedWords;

    if (canMerge) {
      stitched[stitched.length - 1] = mergeCaptions(previous, caption);
    } else {
      stitched.push(caption);
    }
  }

  return stitched;
}

function groupPenalty(words, start, end, preferredMaximum) {
  const count = end - start;
  const total = words.length;
  const slice = words.slice(start, end);
  const first = slice[0];
  const last = slice.at(-1);
  const duration = Number(last.end) - Number(first.start);
  const glyphs = slice.reduce(
    (sum, word) => sum + Array.from(String(word.text ?? "")).length,
    0,
  );
  const target = Math.min(preferredMaximum, 4);
  let penalty = Math.abs(count - target) * 2.2;

  if (count === 1 && total > 1) penalty += 1_000;
  if (count > preferredMaximum) {
    penalty += (count - preferredMaximum) ** 2 * 70;
  }
  if (duration > 2.8) penalty += (duration - 2.8) ** 2 * 18;
  if (glyphs > 30) penalty += (glyphs - 30) ** 2 * 0.35;

  const remainder = total - end;
  if (remainder === 1) penalty += 800;
  if (endsStrongPhrase(last.text)) penalty -= 7;
  if (/[,:;—–-]$/u.test(String(last.text ?? ""))) penalty -= 3;

  for (let index = 0; index < slice.length - 1; index += 1) {
    if (endsStrongPhrase(slice[index].text)) penalty += 24;
  }

  return penalty;
}

// A visual card should represent one continuous burst of speech. MMS alignment
// pads word ends slightly, so 520 ms here corresponds to a clearly audible
// pause without splitting normal articulation gaps.
const CARD_BREAK_GAP_SECONDS = 0.52;

function splitSpeechBursts(words) {
  const bursts = [];
  let burst = [];

  for (const word of words) {
    const previous = burst.at(-1);
    const gap =
      Number(word?.start) - Number(previous?.end);
    if (
      previous &&
      Number.isFinite(gap) &&
      gap > CARD_BREAK_GAP_SECONDS
    ) {
      bursts.push(burst);
      burst = [];
    }
    burst.push(word);
  }

  if (burst.length) bursts.push(burst);
  return bursts;
}

/**
 * Dynamic programming keeps cards balanced around linguistic punctuation.
 * Unlike a greedy max-word split, a five-word phrase becomes 2+3 or 3+2,
 * never 4+1.
 */
function groupSpeechBurst(source, rawMaximum) {
  if (source.length <= 2) return [source];

  const preferredMaximum = Math.round(clamp(Number(rawMaximum) || 4, 2, 7));
  const hardMaximum = Math.min(source.length, preferredMaximum + 1);
  const best = new Array(source.length + 1).fill(Number.POSITIVE_INFINITY);
  const parent = new Array(source.length + 1).fill(-1);
  best[0] = 0;

  for (let end = 1; end <= source.length; end += 1) {
    const earliest = Math.max(0, end - hardMaximum);
    for (let start = earliest; start < end; start += 1) {
      if (!Number.isFinite(best[start])) continue;
      const candidate =
        best[start] +
        groupPenalty(source, start, end, preferredMaximum);
      if (candidate < best[end]) {
        best[end] = candidate;
        parent[end] = start;
      }
    }
  }

  if (parent[source.length] < 0) return [source];
  const groups = [];
  for (let end = source.length; end > 0; ) {
    const start = parent[end];
    groups.unshift(source.slice(start, end));
    end = start;
  }
  return groups;
}

export function groupWordsForReels(words, rawMaximum = 4) {
  const source = Array.isArray(words) ? words.filter(Boolean) : [];
  if (!source.length) return [];

  return splitSpeechBursts(source).flatMap((burst) =>
    groupSpeechBurst(burst, rawMaximum),
  );
}
