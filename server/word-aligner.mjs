const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_FRAME_MS = 20;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function tokenizeWords(text) {
  return String(text ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function graphemeCount(word) {
  const cleaned = String(word)
    .replace(/[\p{P}\p{S}]+/gu, "")
    .trim();
  if (!cleaned) return 1;

  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("und", {
      granularity: "grapheme",
    });
    return Math.max(1, Array.from(segmenter.segment(cleaned)).length);
  }
  return Math.max(1, Array.from(cleaned).length);
}

function wordWeight(word) {
  // A sublinear grapheme prior is less biased against Indic conjuncts while
  // still giving visibly longer words more room than short particles.
  return Math.max(1, graphemeCount(word) ** 0.72);
}

function percentile(values, position) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    clamp(Math.round((sorted.length - 1) * position), 0, sorted.length - 1)
  ];
}

function smooth(values) {
  return values.map((value, index) => {
    const previous = values[index - 1] ?? value;
    const next = values[index + 1] ?? value;
    return previous * 0.24 + value * 0.52 + next * 0.24;
  });
}

export function pcmEnergyEnvelope(
  pcmBuffer,
  {
    sampleRate = DEFAULT_SAMPLE_RATE,
    frameMs = DEFAULT_FRAME_MS,
  } = {},
) {
  const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frameCount = Math.ceil(pcmBuffer.length / 2 / samplesPerFrame);
  const raw = new Array(frameCount).fill(0);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const firstSample = frame * samplesPerFrame;
    const lastSample = Math.min(
      pcmBuffer.length / 2,
      firstSample + samplesPerFrame,
    );
    let squareSum = 0;
    let sampleCount = 0;

    for (let sample = firstSample; sample < lastSample; sample += 1) {
      const value = pcmBuffer.readInt16LE(sample * 2) / 32768;
      squareSum += value * value;
      sampleCount += 1;
    }
    raw[frame] = sampleCount ? Math.sqrt(squareSum / sampleCount) : 0;
  }

  const compressed = raw.map((value) => Math.log1p(value * 24));
  const smoothed = smooth(compressed);
  const floor = percentile(smoothed, 0.15);
  const ceiling = percentile(smoothed, 0.95);
  const range = Math.max(0.0001, ceiling - floor);

  return smoothed.map((value) => clamp((value - floor) / range, 0, 1));
}

function weightedFallback(words, start, end) {
  const weights = words.map(wordWeight);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cursor = start;
  return words.map((word, index) => {
    const duration =
      index === words.length - 1
        ? end - cursor
        : ((end - start) * weights[index]) / totalWeight;
    const wordEnd = index === words.length - 1 ? end : cursor + duration;
    const timing = {
      id: `word-${index + 1}`,
      text: word,
      start: Number(cursor.toFixed(3)),
      end: Number(wordEnd.toFixed(3)),
      confidence: 0.38,
      source: "grapheme-prior",
    };
    cursor = wordEnd;
    return timing;
  });
}

export function alignCaptionWords(
  caption,
  energy,
  {
    frameMs = DEFAULT_FRAME_MS,
    minimumWordMs = 80,
  } = {},
) {
  const words = tokenizeWords(caption.text);
  const start = Number(caption.start);
  const end = Number(caption.end);
  if (!words.length || !Number.isFinite(start) || !Number.isFinite(end)) {
    return [];
  }
  if (words.length === 1 || !energy?.length) {
    return weightedFallback(words, start, end);
  }

  const startFrame = clamp(
    Math.floor((start * 1000) / frameMs),
    0,
    energy.length - 1,
  );
  const endFrame = clamp(
    Math.ceil((end * 1000) / frameMs),
    startFrame + 1,
    energy.length,
  );
  const availableFrames = endFrame - startFrame;
  const minimumFrames = Math.max(1, Math.ceil(minimumWordMs / frameMs));

  if (availableFrames < words.length * minimumFrames) {
    return weightedFallback(words, start, end);
  }

  const weights = words.map(wordWeight);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const candidateLayers = [];
  let cumulativeWeight = 0;

  for (let boundary = 1; boundary < words.length; boundary += 1) {
    cumulativeWeight += weights[boundary - 1];
    const target =
      startFrame + Math.round(availableFrames * (cumulativeWeight / totalWeight));
    const averageWordFrames = availableFrames / words.length;
    const searchRadius = Math.max(4, Math.round(averageWordFrames * 0.78));
    const earliest = startFrame + boundary * minimumFrames;
    const wordsRemaining = words.length - boundary;
    const latest = endFrame - wordsRemaining * minimumFrames;
    const searchStart = clamp(target - searchRadius, earliest, latest);
    const searchEnd = clamp(target + searchRadius, searchStart, latest);

    const candidates = [];
    for (let frame = searchStart; frame <= searchEnd; frame += 1) {
      const frameEnergy = energy[frame] ?? 1;
      const previous = energy[frame - 1] ?? frameEnergy;
      const next = energy[frame + 1] ?? frameEnergy;
      const isValley = frameEnergy <= previous && frameEnergy <= next;
      const distance = Math.abs(frame - target) / Math.max(1, searchRadius);
      const localCost =
        frameEnergy * 0.68 + distance * 0.28 - (isValley ? 0.08 : 0);
      const proximity = 1 - Math.min(1, distance);
      candidates.push({
        frame,
        localCost,
        confidence: clamp(
          0.5 + (1 - frameEnergy) * 0.34 + proximity * 0.16,
          0.42,
          0.97,
        ),
        target,
      });
    }
    candidateLayers.push(candidates);
  }

  // Optimize every boundary together. The transition term prevents an early
  // low-energy valley from stealing time that a later word needs, while hard
  // monotonic constraints keep every word at least minimumWordMs long.
  const costs = candidateLayers.map((layer) =>
    new Array(layer.length).fill(Number.POSITIVE_INFINITY),
  );
  const parents = candidateLayers.map((layer) =>
    new Array(layer.length).fill(-1),
  );

  for (let layerIndex = 0; layerIndex < candidateLayers.length; layerIndex += 1) {
    const layer = candidateLayers[layerIndex];
    for (let candidateIndex = 0; candidateIndex < layer.length; candidateIndex += 1) {
      const candidate = layer[candidateIndex];
      if (layerIndex === 0) {
        costs[layerIndex][candidateIndex] = candidate.localCost;
        continue;
      }

      const previousLayer = candidateLayers[layerIndex - 1];
      for (
        let previousIndex = 0;
        previousIndex < previousLayer.length;
        previousIndex += 1
      ) {
        const previousCandidate = previousLayer[previousIndex];
        if (candidate.frame - previousCandidate.frame < minimumFrames) continue;
        const expectedGap = candidate.target - previousCandidate.target;
        const actualGap = candidate.frame - previousCandidate.frame;
        const transitionCost =
          (Math.abs(actualGap - expectedGap) / Math.max(1, expectedGap)) * 0.12;
        const totalCost =
          costs[layerIndex - 1][previousIndex] +
          candidate.localCost +
          transitionCost;
        if (totalCost < costs[layerIndex][candidateIndex]) {
          costs[layerIndex][candidateIndex] = totalCost;
          parents[layerIndex][candidateIndex] = previousIndex;
        }
      }
    }
  }

  const lastLayerIndex = candidateLayers.length - 1;
  let selectedIndex = costs[lastLayerIndex].reduce(
    (best, value, index, values) => (value < values[best] ? index : best),
    0,
  );
  if (!Number.isFinite(costs[lastLayerIndex][selectedIndex])) {
    return weightedFallback(words, start, end);
  }

  const selectedBoundaries = new Array(candidateLayers.length);
  for (let layerIndex = lastLayerIndex; layerIndex >= 0; layerIndex -= 1) {
    selectedBoundaries[layerIndex] = candidateLayers[layerIndex][selectedIndex];
    selectedIndex = parents[layerIndex][selectedIndex];
  }

  const boundaryFrames = [
    startFrame,
    ...selectedBoundaries.map((candidate) => candidate.frame),
  ];
  const boundaryConfidence = selectedBoundaries.map(
    (candidate) => candidate.confidence,
  );
  boundaryFrames.push(endFrame);

  return words.map((word, index) => {
    const leftConfidence = boundaryConfidence[index - 1];
    const rightConfidence = boundaryConfidence[index];
    const confidence =
      leftConfidence && rightConfidence
        ? (leftConfidence + rightConfidence) / 2
        : leftConfidence ?? rightConfidence ?? 0.72;
    return {
      id: `word-${index + 1}`,
      text: word,
      start: Number(((boundaryFrames[index] * frameMs) / 1000).toFixed(3)),
      end: Number(((boundaryFrames[index + 1] * frameMs) / 1000).toFixed(3)),
      confidence: Number(confidence.toFixed(2)),
      source: "waveform-dp",
    };
  });
}

export function alignTranscriptWords(
  captions,
  pcmBuffer,
  {
    sampleRate = DEFAULT_SAMPLE_RATE,
    frameMs = DEFAULT_FRAME_MS,
  } = {},
) {
  const energy = pcmEnergyEnvelope(pcmBuffer, { sampleRate, frameMs });
  let waveformAlignedWords = 0;
  let totalWords = 0;
  let confidenceSum = 0;

  const alignedCaptions = captions.map((caption) => {
    const words = alignCaptionWords(caption, energy, { frameMs });
    for (const word of words) {
      totalWords += 1;
      confidenceSum += word.confidence;
      if (word.source === "waveform-dp") waveformAlignedWords += 1;
    }
    return { ...caption, words };
  });

  return {
    captions: alignedCaptions,
    summary: {
      method: "phrase-anchored-waveform-dp",
      totalWords,
      waveformAlignedWords,
      averageConfidence: totalWords
        ? Number((confidenceSum / totalWords).toFixed(2))
        : 0,
      needsReview: alignedCaptions
        .flatMap((caption) => caption.words)
        .filter((word) => word.confidence < 0.62).length,
    },
  };
}
