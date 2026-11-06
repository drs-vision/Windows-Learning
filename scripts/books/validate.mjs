#!/usr/bin/env node
// Checks every book under content/books (see content/books/README.md). No dependencies.
//   node scripts/books/validate.mjs            all books
//   node scripts/books/validate.mjs black-beauty [3]   one book (and optionally one chapter)
// Exit code 1 if anything is wrong. Missing question files are reported; pass --allow-missing to only warn.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure } from './readability.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'content', 'books');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const allowMissing = process.argv.includes('--allow-missing');
const onlyBook = args[0], onlyChapter = args[1] ? Number(args[1]) : null;

const TYPES = new Set(['detail', 'vocabulary', 'sequence', 'character', 'inference', 'main-idea']);
const KEYBOARD = /^[\x20-\x7E\n]*$/;
export const quizSize = (words) => Math.max(4, Math.min(10, Math.round(words / 250)));
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

let errors = 0, warnings = 0, questions = 0, chapters = 0, missing = 0;
const err = (where, msg) => { errors++; console.log(`ERROR ${where}: ${msg}`); };
const warn = (where, msg) => { warnings++; console.log(`warn  ${where}: ${msg}`); };

const books = readdirSync(ROOT).filter((d) => d !== 'schema' && statSync(join(ROOT, d)).isDirectory() && (!onlyBook || d === onlyBook));
for (const id of books) {
  const dir = join(ROOT, id);
  let book;
  try { book = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')); } catch (e) { err(id, 'book.json: ' + e.message); continue; }
  for (const k of ['id', 'title', 'author', 'published', 'level', 'grade', 'summary', 'source', 'publicDomain', 'chapters']) if (book[k] === undefined) err(id, `book.json is missing "${k}"`);
  if (book.id !== id) err(id, `book.json id "${book.id}" doesn't match its folder`);
  if (book.published > 1930) err(id, `published ${book.published}: only books published before 1931 are public domain in the US`);
  if (!(Number.isInteger(book.level) && book.level >= 1 && book.level <= 12)) err(id, 'level must be a whole number from 1 (easiest) up');
  if (!(book.grade?.min >= 0 && book.grade?.max >= book.grade?.min)) err(id, 'grade.min / grade.max are wrong');
  if (book.measures) {
    const { lexile, atos } = book.measures;
    if (lexile && !(Number.isInteger(lexile.value) && /^https:\/\//.test(lexile.url ?? ''))) err(id, 'measures.lexile needs a whole-number value and the https url it came from');
    if (atos && !(typeof atos.level === 'number' && /^https:\/\//.test(atos.url ?? ''))) err(id, 'measures.atos needs a level and the https url it came from');
    // One level scale with Reading Quest (src/Shared/Books/ReadingLevels.cs): the level is the ATOS book level's whole number.
    else if (atos && book.level !== Math.max(1, Math.floor(atos.level))) err(id, `level ${book.level} should be ${Math.max(1, Math.floor(atos.level))} (ATOS ${atos.level}; one scale with Reading Quest)`);
  }
  if (!book.readability) err(id, 'no readability: run node scripts/books/readability.mjs');
  const ids = new Set();
  for (const ch of book.chapters ?? []) {
    if (onlyChapter && ch.n !== onlyChapter) continue;
    const where = `${id} ch ${ch.n}`;
    chapters++;
    const tp = join(dir, ch.text);
    if (!existsSync(tp)) { err(where, `missing text ${ch.text}`); continue; }
    const text = readFileSync(tp, 'utf8').replace(/\r\n?/g, '\n');
    if (!KEYBOARD.test(text)) {
      const bad = [...new Set([...text].filter((c) => c !== '\n' && (c < ' ' || c > '~')))].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
      err(where, `text has characters that aren't on a keyboard: ${bad.join(' ')}`);
    }
    const words = text.split(/\s+/).filter(Boolean).length;
    const rd = measure(text);
    if (!ch.readability) err(where, 'no readability: run node scripts/books/readability.mjs');
    else if (['grade', 'fk', 'cli', 'ari'].some((k) => Math.abs((ch.readability[k] ?? -99) - rd[k]) > 0.05)) err(where, 'readability is out of date with the text: run node scripts/books/readability.mjs');
    if (words !== ch.words) warn(where, `book.json says ${ch.words} words, the text has ${words}`);
    const qp = join(dir, ch.questions);
    if (!existsSync(qp)) { missing++; (allowMissing ? warn : err)(where, `no questions yet (${ch.questions})`); continue; }
    let qf;
    try { qf = JSON.parse(readFileSync(qp, 'utf8')); } catch (e) { err(where, `${ch.questions}: ${e.message}`); continue; }
    if (qf.book !== id || qf.chapter !== ch.n) err(where, `questions file says book "${qf.book}" chapter ${qf.chapter}`);
    const list = Array.isArray(qf.questions) ? qf.questions : [];
    const need = Math.ceil(quizSize(words) * 1.5);
    if (list.length < need) err(where, `${list.length} questions; needs at least ${need} (quiz of ${quizSize(words)} x 1.5)`);
    const body = norm(text);
    // Guessing guard: if the right answer is usually the longest (or shortest) choice, a child can pass without reading.
    const ok4 = (q) => Array.isArray(q?.choices) && q.choices.length === 4 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4;
    const most = (cmp) => list.filter((q) => ok4(q) && q.choices.every((c, k) => k === q.answer || cmp(String(q.choices[q.answer]).length, String(c).length))).length;
    const longest = most((a, b) => a > b), shortest = most((a, b) => a < b);
    if (list.length >= 6 && longest / list.length > 0.4) err(where, `the right answer is the longest choice in ${longest} of ${list.length} questions; make the wrong choices as long and specific as the right one (at most 40%)`);
    if (list.length >= 6 && shortest / list.length > 0.4) err(where, `the right answer is the shortest choice in ${shortest} of ${list.length} questions; vary the lengths (at most 40%)`);
    for (const [i, q] of list.entries()) {
      const qw = `${where} q${i + 1}${q?.id ? ' (' + q.id + ')' : ''}`;
      questions++;
      if (!q || typeof q !== 'object') { err(qw, 'not an object'); continue; }
      const extra = Object.keys(q).filter((k) => !['id', 'type', 'q', 'choices', 'answer', 'evidence'].includes(k));
      if (extra.length) err(qw, `unknown fields: ${extra.join(', ')}`);
      if (!/^[a-z0-9-]+-\d{2}-\d{2}$/.test(q.id ?? '')) err(qw, `id should look like ${id}-${String(ch.n).padStart(2, '0')}-01`);
      else if (!q.id.startsWith(`${id}-${String(ch.n).padStart(2, '0')}-`)) err(qw, `id doesn't match book/chapter`);
      if (ids.has(q.id)) err(qw, 'duplicate id'); ids.add(q.id);
      if (!TYPES.has(q.type)) err(qw, `type "${q.type}" isn't one of ${[...TYPES].join(', ')}`);
      if (typeof q.q !== 'string' || q.q.length < 8) err(qw, 'question text missing');
      if (!Array.isArray(q.choices) || q.choices.length !== 4) err(qw, 'needs exactly 4 choices');
      else {
        if (new Set(q.choices.map(norm)).size !== 4) err(qw, 'choices repeat');
        if (q.choices.some((c) => typeof c !== 'string' || !c.trim())) err(qw, 'an empty choice');
        if (q.choices.some((c) => /^(all|none|both) of the above$/i.test(c.trim()))) err(qw, '"all/none of the above" doesn\'t work when choices are shuffled');
      }
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) err(qw, 'answer must be 0-3');
      for (const s of [q.q, q.evidence, ...(q.choices ?? [])]) if (typeof s === 'string' && !KEYBOARD.test(s)) err(qw, `non-keyboard character in "${s}"`);
      if (typeof q.evidence !== 'string' || q.evidence.trim().length < 3) err(qw, 'evidence missing');
      else if (!body.includes(norm(q.evidence))) err(qw, `evidence not found in the chapter: "${q.evidence}"`);
    }
  }
}
console.log(`\n${books.length} book(s), ${chapters} chapter(s), ${questions} question(s); ${missing} chapter(s) without questions; ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
