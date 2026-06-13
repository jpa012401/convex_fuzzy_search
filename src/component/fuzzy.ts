// Typo budget by token length (Typesense-style): tiny tokens tolerate no typos.
export function typoBudget(len: number): number {
  if (len <= 3) return 0;
  if (len <= 7) return 1;
  return 2;
}

// Bounded Levenshtein edit distance. Returns the true distance when it is <= max,
// otherwise returns a value strictly greater than max (caller treats that as "no match").
// Early-exits a row once its best possible value exceeds max.
export function levenshtein(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}
