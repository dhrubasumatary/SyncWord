// @ts-check

import { CAPTION_PLACEHOLDER_FIELD } from "./caption-coverage.mjs";

const defaultPreflightMessage =
  "Some spoken audio is still missing captions. Review every highlighted gap before exporting.";

/** @param {unknown} value */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

/** @param {number} value */
function roundTime(value) {
  return Number(value.toFixed(3));
}

/**
 * Normalize renderer coverage intervals at the browser boundary. Invalid or
 * empty intervals are discarded and timestamps are clamped to the media.
 *
 * @param {unknown} value
 * @param {number} [durationSeconds]
 */
export function normalizeUncoveredIntervals(
  value,
  durationSeconds = Number.POSITIVE_INFINITY,
) {
  const maximum = Number.isFinite(durationSeconds)
    ? Math.max(0, durationSeconds)
    : Number.POSITIVE_INFINITY;
  return (Array.isArray(value) ? value : [])
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const startValue = finiteNumber(item.start);
      const endValue = finiteNumber(item.end);
      if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return [];
      const start = Math.max(0, Math.min(maximum, startValue));
      const end = Math.max(0, Math.min(maximum, endValue));
      if (end <= start) return [];
      return [
        {
          start: roundTime(start),
          end: roundTime(end),
          duration: roundTime(end - start),
        },
      ];
    })
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .slice(0, 100);
}

/**
 * Convert a speech gap into one editable manual cue. The placeholder is a
 * single token so it remains compatible with the existing word timing editor.
 * Its original value is marked explicitly: coverage ignores it until the
 * creator replaces the generated text with words they actually heard.
 *
 * @param {unknown} interval
 * @param {{ id: string, language: "as" | "brx", placeholder?: string }} options
 */
export function createManualCaptionForGap(interval, options) {
  const [gap] = normalizeUncoveredIntervals([interval]);
  if (!gap) throw new TypeError("A valid speech gap is required.");
  const id = String(options?.id ?? "").trim();
  if (!id) throw new TypeError("A manual caption ID is required.");
  const language = String(options?.language);
  if (!new Set(["as", "brx"]).has(language)) {
    throw new TypeError("A supported caption language is required.");
  }
  const placeholder = String(options?.placeholder ?? "Type-here")
    .trim()
    .replace(/\s+/gu, "-") || "Type-here";

  return {
    id,
    start: gap.start,
    end: gap.end,
    text: placeholder,
    [CAPTION_PLACEHOLDER_FIELD]: placeholder,
    language,
    words: [
      {
        id: `${id}-word-0`,
        text: placeholder,
        start: gap.start,
        end: gap.end,
        confidence: 1,
        highlightSafe: true,
        source: "manual",
      },
    ],
  };
}

/**
 * Preserve a renderer's fresh coverage diagnostics while normalizing the
 * interval list used by the editor UI.
 *
 * @param {unknown} value
 * @param {{ durationSeconds?: number, fallbackMessage?: string }} [options]
 */
export function normalizeRenderPreflight(value, options = {}) {
  /** @type {Record<string, unknown>} */
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : {};
  const coverageValue = record.coverage;
  /** @type {Record<string, unknown> | null} */
  const rawCoverage =
    coverageValue &&
    typeof coverageValue === "object" &&
    !Array.isArray(coverageValue)
      ? /** @type {Record<string, unknown>} */ (coverageValue)
      : null;
  const uncoveredIntervals = normalizeUncoveredIntervals(
    record.uncoveredIntervals ?? rawCoverage?.uncoveredIntervals,
    options.durationSeconds,
  );
  const coverage = rawCoverage
    ? { ...rawCoverage, uncoveredIntervals }
    : null;
  const message =
    (typeof record.error === "string" && record.error.trim()) ||
    (typeof record.message === "string" && record.message.trim()) ||
    options.fallbackMessage ||
    defaultPreflightMessage;

  return {
    code:
      typeof record.code === "string" && record.code.trim()
        ? record.code
        : "render_preflight_failed",
    message,
    coverage,
    uncoveredIntervals,
  };
}
