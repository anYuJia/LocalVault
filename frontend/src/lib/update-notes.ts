export function normalizeUpdateNotes(notes?: string) {
  const text = String(notes || "").trim();
  if (!text) return "";

  const cutPatterns = [/\n##\s*下载建议\b/i, /\n##\s*Download\b/i];
  const cutAt = cutPatterns
    .map((pattern) => {
      const match = text.match(pattern);
      return match?.index ?? -1;
    })
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  return (cutAt >= 0 ? text.slice(0, cutAt) : text).trim();
}
