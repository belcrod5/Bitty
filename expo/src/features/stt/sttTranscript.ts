const STT_KNOWN_FALSE_POSITIVE_PATTERN = "ご視聴\\s*ありがとう\\s*ございました";
const STT_KNOWN_FALSE_POSITIVE_DETECT_REGEX = new RegExp(STT_KNOWN_FALSE_POSITIVE_PATTERN);
const STT_KNOWN_FALSE_POSITIVE_REMOVE_REGEX = new RegExp(STT_KNOWN_FALSE_POSITIVE_PATTERN, "g");

export function normalizeSttTextForNoiseCheck(raw: unknown) {
  return String(raw || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[。．.!！?？,，、~〜…・]/g, "");
}

export function sanitizeSttTranscript(raw: unknown) {
  return String(raw || "")
    .normalize("NFKC")
    .replace(STT_KNOWN_FALSE_POSITIVE_REMOVE_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldIgnoreSttTranscript(raw: unknown) {
  const normalizedRaw = String(raw || "").normalize("NFKC");
  if (normalizedRaw.search(STT_KNOWN_FALSE_POSITIVE_DETECT_REGEX) < 0) return false;
  const sanitized = sanitizeSttTranscript(normalizedRaw);
  return normalizeSttTextForNoiseCheck(sanitized).length === 0;
}
