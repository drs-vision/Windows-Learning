#!/usr/bin/env node
// Readability of every chapter, written into each book.json (see content/books/README.md, "readability").
//   node scripts/books/readability.mjs        update all books
// Three published formulas that use only sentence, word and letter/syllable counts (no word lists, so nothing
// proprietary), each giving a US school grade; "grade" is their average:
//   Flesch-Kincaid Grade Level   0.39 (words/sentences) + 11.8 (syllables/words) - 15.59      (Kincaid et al., 1975)
//   Coleman-Liau Index           0.0588 L - 0.296 S - 15.8; L = letters, S = sentences per 100 words (Coleman & Liau, 1975)
//   Automated Readability Index  4.71 (characters/words) + 0.5 (words/sentences) - 21.43  (Smith & Senter, 1967)
// They measure sentence and word length only: an old book with long sentences can measure harder than it feels.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'content', 'books');

/** Syllables in a word, by the usual vowel-group rule (good to within a syllable for most English words). */
export function syllables(word) {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Counts and the three grades for a text. */
export function measure(text) {
  const t = text.replace(/\r/g, '');
  const words = t.split(/\s+/).map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')).filter((w) => /[A-Za-z]/.test(w));
  // A sentence ends at . ! ? (not inside "Mr." / "Mrs." / "Dr." / "St."), or at a paragraph end.
  const cleaned = t.replace(/\b(Mr|Mrs|Dr|St|Capt|Ms)\./g, '$1');
  const sentences = Math.max(1, (cleaned.match(/[.!?]+["')\]]*(\s|$)/g) ?? []).length
    + (cleaned.split(/\n\s*\n/).filter((p) => p.trim() && !/[.!?]["')\]]*\s*$/.test(p.trim())).length));
  const W = Math.max(1, words.length);
  const letters = words.reduce((a, w) => a + w.replace(/[^A-Za-z0-9]/g, '').length, 0);
  const syl = words.reduce((a, w) => a + syllables(w), 0);
  const fk = 0.39 * (W / sentences) + 11.8 * (syl / W) - 15.59;
  const cli = 0.0588 * (letters / W * 100) - 0.296 * (sentences / W * 100) - 15.8;
  const ari = 4.71 * (letters / W) + 0.5 * (W / sentences) - 21.43;
  const r1 = (x) => Math.round(x * 10) / 10;
  const clamp = (x) => Math.max(0, Math.min(16, x));
  return { words: W, sentences, syllables: syl, letters, fk: r1(clamp(fk)), cli: r1(clamp(cli)), ari: r1(clamp(ari)), grade: r1(clamp((fk + cli + ari) / 3)) };
}

const pick = ({ grade, fk, cli, ari }) => ({ grade, fk, cli, ari });

export function bookReadability(dir, book) {
  let words = 0;
  const sums = { grade: 0, fk: 0, cli: 0, ari: 0 };
  const chapters = book.chapters.map((c) => {
    const m = measure(readFileSync(join(dir, c.text), 'utf8'));
    words += m.words;
    for (const k of Object.keys(sums)) sums[k] += m[k] * m.words;
    return pick(m);
  });
  const avg = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Math.round(v / Math.max(1, words) * 10) / 10]));
  return { book: avg, chapters };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const id of readdirSync(ROOT).filter((d) => d !== 'schema' && statSync(join(ROOT, d)).isDirectory())) {
    const dir = join(ROOT, id), path = join(dir, 'book.json');
    const book = JSON.parse(readFileSync(path, 'utf8'));
    const r = bookReadability(dir, book);
    // Keep the key order readable: readability after grade, and on each chapter after words.
    const out = {};
    for (const [k, v] of Object.entries(book)) { if (k === 'readability') continue; out[k] = v; if (k === 'grade') out.readability = r.book; }
    out.chapters = book.chapters.map((c, i) => { const { readability, ...rest } = c; return { ...rest, readability: r.chapters[i] }; });
    writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
    console.log(`L${book.level} ${id.padEnd(28)} grade ${r.book.grade.toFixed(1).padStart(4)}  (FK ${r.book.fk}, CLI ${r.book.cli}, ARI ${r.book.ari})`);
  }
}
