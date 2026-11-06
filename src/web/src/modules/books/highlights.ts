/**
 * Highlights in a chapter: per paragraph, a sorted list of [start, end) character ranges that never overlap.
 * Selecting plain text highlights it; selecting text that's already all highlighted clears that part.
 */
export type Marks = Record<number, [number, number][]>;

/** Join ranges that overlap or touch. */
function normalize(list: [number, number][]): [number, number][] {
  const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Is [a, b) entirely highlighted already? */
export function covered(list: [number, number][], a: number, b: number) {
  return list.some(([x, y]) => x <= a && y >= b);
}

/** Highlight [a, b), or clear it when it's all highlighted already. */
export function toggle(list: [number, number][], a: number, b: number): [number, number][] {
  if (b <= a) return list;
  if (!covered(list, a, b)) return normalize([...list, [a, b]]);
  const out: [number, number][] = [];
  for (const [x, y] of list) {
    if (y <= a || x >= b) { out.push([x, y]); continue; }
    if (x < a) out.push([x, a]);
    if (y > b) out.push([b, y]);
  }
  return normalize(out);
}

/**
 * Apply a selection that may cross paragraphs: parts = [paragraph, start, end]. If every part is already
 * highlighted, the whole selection is cleared; otherwise it is all highlighted.
 */
export function applySelection(marks: Marks, parts: [number, number, number][]): Marks {
  const all = parts.every(([p, a, b]) => covered(marks[p] ?? [], a, b));
  const next: Marks = { ...marks };
  for (const [p, a, b] of parts) {
    const cur = next[p] ?? [];
    next[p] = all ? toggle(cur, a, b) : normalize([...cur, [a, b]]);
    if (!next[p].length) delete next[p];
  }
  return next;
}

/** A paragraph cut into plain and highlighted pieces, for drawing. */
export function pieces(text: string, list: [number, number][] = []): { text: string; mark: boolean; start: number }[] {
  const out: { text: string; mark: boolean; start: number }[] = [];
  let at = 0;
  for (const [a, b] of list) {
    if (a > at) out.push({ text: text.slice(at, a), mark: false, start: at });
    out.push({ text: text.slice(a, b), mark: true, start: a });
    at = b;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false, start: at });
  return out;
}
