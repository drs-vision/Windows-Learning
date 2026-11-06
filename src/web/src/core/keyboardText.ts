/**
 * Pasted text often has characters that aren't on a keyboard (curly quotes, long dashes, "…", odd spaces).
 * Common ones become their keyboard look-alikes; anything else that isn't a printable keyboard character
 * (ASCII 32–126) is removed and reported, so a parent sees exactly what changed before saving.
 */
const SWAPS: [RegExp, string][] = [
  [/[‘’‚‛′`´]/g, "'"],
  [/[“”„‟″«»]/g, '"'],
  [/[‐‑‒–—―−­]/g, '-'],
  [/…/g, '...'],
  [/[  -   　\t]/g, ' '],
  [/[​-‍﻿]/g, ''],
];

export interface CleanText { text: string; swapped: string[]; removed: string[] }

export function keyboardText(raw: string): CleanText {
  const swapped = new Set<string>();
  let s = raw.normalize('NFKD').replace(/[̀-ͯ]/g, ''); // é → e
  for (const [re, to] of SWAPS) s = s.replace(re, (m) => { if (m.trim() || to) swapped.add(m); return to; });
  const removed = new Set<string>();
  s = s.replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E]/g, (m) => { removed.add(m); return ''; });
  s = s.replace(/ {2,}/g, ' ').trim();
  for (const ch of raw) if (ch !== ch.normalize('NFKD').replace(/[̀-ͯ]/g, '')) swapped.add(ch);
  return { text: s, swapped: [...swapped], removed: [...removed] };
}

/** True when every character is one you can type on a keyboard. */
export const isKeyboardText = (s: string) => /^[\x20-\x7E]*$/.test(s);
