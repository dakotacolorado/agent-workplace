export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

const lines = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

/** A line diff of `before` against `after`: the lines of both, in order, each marked same, added or deleted. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  // Longest common subsequence of the middle; the files are small (a skill holds a few thousand characters).
  const n = am.length;
  const m = bm.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = am[i] === bm[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) out.push({ kind: "same", text: am[i++]! }), j++;
    else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ kind: "del", text: am[i++]! });
    else out.push({ kind: "add", text: bm[j++]! });
  }
  return out.concat(a.slice(a.length - tail).map((text) => ({ kind: "same" as const, text })));
}

/** Whether anything differs. */
export const changed = (d: DiffLine[]) => d.some((l) => l.kind !== "same");
