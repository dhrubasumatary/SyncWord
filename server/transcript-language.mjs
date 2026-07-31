const languageAliases = new Map([
  ["as", "as-IN"],
  ["asm", "as-IN"],
  ["as-in", "as-IN"],
  ["brx", "brx-IN"],
  ["brx-in", "brx-IN"],
]);

function canonicalLanguageCode(value) {
  return languageAliases.get(String(value ?? "").trim().toLowerCase()) ?? null;
}

export function resolveTranscriptLanguage(
  transcriptLanguage,
  requestedLanguage,
) {
  return (
    canonicalLanguageCode(transcriptLanguage) ??
    canonicalLanguageCode(requestedLanguage) ??
    "unknown"
  );
}

export function languageTag(languageCode) {
  if (languageCode === "as-IN") return "as";
  if (languageCode === "brx-IN") return "brx";
  return "mix";
}
