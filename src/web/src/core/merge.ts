const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const keyOf = (v: unknown) => (isObj(v) && typeof v.id === 'string' ? 'id:' + v.id : JSON.stringify(v));

/** Three-way merge: apply the change base→mine onto latest. Lists merge by item (id, or value): adds, removals and edits. */
export function merge3(base: unknown, mine: unknown, latest: unknown): unknown {
  if (same(base, mine)) return latest;
  if (isObj(base) && isObj(mine) && isObj(latest)) {
    const out: Record<string, unknown> = { ...latest };
    for (const k of new Set([...Object.keys(base), ...Object.keys(mine)])) {
      if (!(k in mine)) { delete out[k]; continue; }
      out[k] = k in base ? merge3(base[k], mine[k], latest[k]) : mine[k];
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(mine) && Array.isArray(latest)) {
    const b = new Map(base.map((x) => [keyOf(x), x]));
    const m = new Map(mine.map((x) => [keyOf(x), x]));
    const out = latest.filter((x) => !(b.has(keyOf(x)) && !m.has(keyOf(x)))).map((x) => {
      const k = keyOf(x);
      return m.has(k) && b.has(k) && !same(b.get(k), m.get(k)) ? merge3(b.get(k), m.get(k), x) : x;
    });
    const have = new Set(out.map(keyOf));
    for (const [k, x] of m) if (!have.has(k) && !b.has(k)) out.push(x);
    return out;
  }
  return mine;
}
