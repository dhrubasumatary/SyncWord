import { isSupportedLanguageCode } from "../shared/project-contract.mjs";

export function resolveTranscriptLanguage(
  _transcriptLanguage,
  requestedLanguage,
) {
  if (!isSupportedLanguageCode(requestedLanguage)) {
    throw new TypeError("requestedLanguage must be as-IN or brx-IN.");
  }
  return requestedLanguage;
}

export function languageTag(languageCode) {
  if (languageCode === "as-IN") return "as";
  if (languageCode === "brx-IN") return "brx";
  throw new TypeError("languageCode must be as-IN or brx-IN.");
}
