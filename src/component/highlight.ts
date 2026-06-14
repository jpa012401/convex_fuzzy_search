// Words are runs of Unicode letters/numbers — the same alphabet the tokenizer
// splits on — but here we keep the ORIGINAL segments (case + separators).
const WORD = /[\p{L}\p{N}]+/gu;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Highlight one field value: wrap each word whose lowercased form is in
// `matchedTerms` with <mark>…</mark>. Non-mark text is HTML-escaped so the
// resulting snippet is safe to render. Returns null if nothing matched.
export function highlightField(
  value: string,
  matchedTerms: Set<string>,
): { snippet: string; matched_tokens: string[] } | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let out = "";
  let last = 0;
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const m of value.matchAll(WORD)) {
    const word = m[0];
    const start = m.index!;
    out += esc(value.slice(last, start));
    if (matchedTerms.has(word.toLowerCase())) {
      out += `<mark>${esc(word)}</mark>`;
      if (!seen.has(word)) {
        seen.add(word);
        matched.push(word);
      }
    } else {
      out += esc(word);
    }
    last = start + word.length;
  }
  out += esc(value.slice(last));
  if (matched.length === 0) return null;
  return { snippet: out, matched_tokens: matched };
}
