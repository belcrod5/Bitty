export function formatOutputTokens(outputTokens?: number): string {
  if (typeof outputTokens !== "number" || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    return "-- tok";
  }
  const count = outputTokens;
  const units = ["", "k", "m", "b"];
  let scaled = count;
  let unit = 0;
  while (scaled >= 999.95 && unit < units.length - 1) {
    scaled /= 1_000;
    unit += 1;
  }
  const compact = unit === 0 ? String(count)
    : `${scaled.toFixed(1).replace(/\.0$/, "")}${units[unit]}`;
  return `total ${compact} tok`;
}
