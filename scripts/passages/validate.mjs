#!/usr/bin/env node
// Checks content/passages (format: content/passages/README.md). No dependencies.
//   node scripts/passages/validate.mjs [--write]     --write also recomputes each paragraph's readability
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure } from '../books/readability.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'content', 'passages');
const write = process.argv.includes('--write');
const TYPES = new Set(['detail', 'main-idea', 'vocabulary', 'inference', 'sequence', 'cause-effect']);
const KINDS = new Set(['story', 'facts', 'fable', 'poem']);
const KEYBOARD = /^[\x20-\x7E\n]*$/;
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** Sentences as a child sees them: ends at . ! ? (not "Mr." etc.), quotes included. */
export const sentences = (t) => t.replace(/\b(Mr|Mrs|Dr|St|Ms|Jr|U\.S)\./g, '$1').split(/(?<=[.!?]["')]?)\s+/).filter((x) => /[A-Za-z]/.test(x)).length;

let errors = 0, count = 0;
const err = (where, msg) => { errors++; console.log(`ERROR ${where}: ${msg}`); };
const ids = new Set();
const grades = [];
const files = existsSync(ROOT) ? readdirSync(ROOT).filter((f) => f.endsWith('.json')) : [];
for (const f of files.sort()) {
  let doc;
  try { doc = JSON.parse(readFileSync(join(ROOT, f), 'utf8')); } catch (e) { err(f, e.message); continue; }
  for (const k of ['source', 'license', 'licenseUrl']) if (!doc[k]) err(f, `"${k}" missing at the top`);
  const list = Array.isArray(doc.passages) ? doc.passages : [];
  let longest = 0, shortest = 0;
  for (const p of list) {
    count++;
    const where = `${f} ${p?.id ?? '?'}`;
    const extra = Object.keys(p ?? {}).filter((k) => !['id', 'title', 'kind', 'topic', 'text', 'source', 'readability', 'question'].includes(k));
    if (extra.length) err(where, `unknown fields: ${extra.join(', ')}`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p?.id ?? '')) err(where, 'id should be lowercase-with-dashes');
    if (ids.has(p.id)) err(where, 'duplicate id'); ids.add(p.id);
    if (!p.title) err(where, 'title missing');
    if (!KINDS.has(p.kind)) err(where, `kind should be one of ${[...KINDS].join(', ')}`);
    if (!p.topic) err(where, 'topic missing');
    const text = String(p.text ?? '');
    if (!KEYBOARD.test(text) || !KEYBOARD.test(String(p.title))) err(where, 'non-keyboard characters in the title or text');
    if (/\n\s*\n/.test(text.trim())) err(where, 'one paragraph only');
    const m = measure(text), n = sentences(text);
    if (m.words < 30 || m.words > 120) err(where, `${m.words} words; bite-size is 30-120`);
    if (n < 3 || n > 6) err(where, `${n} sentences; bite-size is 3-6`);
    const src = p.source ?? {};
    if (!/^https:\/\//.test(src.url ?? '')) err(where, 'source.url (https) missing');
    if (!src.name || !src.license) err(where, 'source.name and source.license are required');
    if (/^CC BY/.test(src.license ?? '') && !src.author) err(where, 'CC BY needs source.author (credit)');
    if (write) p.readability = { grade: m.grade, fk: m.fk, cli: m.cli, ari: m.ari };
    else if (!p.readability || Math.abs(p.readability.grade - m.grade) > 0.05) err(where, 'readability missing or out of date: run with --write');
    grades.push(m.grade);
    const q = p.question;
    if (!q || typeof q !== 'object') { err(where, 'question missing'); continue; }
    const qx = Object.keys(q).filter((k) => !['type', 'q', 'choices', 'answer', 'evidence', 'explain'].includes(k));
    if (qx.length) err(where, `unknown question fields: ${qx.join(', ')}`);
    if (!TYPES.has(q.type)) err(where, `question type should be one of ${[...TYPES].join(', ')}`);
    if (typeof q.q !== 'string' || q.q.length < 8) err(where, 'question text missing');
    if (!Array.isArray(q.choices) || q.choices.length !== 4) { err(where, 'needs exactly 4 choices'); continue; }
    if (new Set(q.choices.map((c) => norm(String(c)))).size !== 4) err(where, 'choices repeat');
    if (q.choices.some((c) => /^(all|none|both) of the above$/i.test(String(c).trim()))) err(where, '"of the above" choices don\'t work when shuffled');
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) { err(where, 'answer must be 0-3'); continue; }
    for (const x of [q.q, q.evidence, q.explain, ...q.choices]) if (typeof x === 'string' && !KEYBOARD.test(x)) err(where, `non-keyboard character in "${x}"`);
    if (typeof q.evidence !== 'string' || q.evidence.trim().length < 3) err(where, 'evidence missing');
    else if (!norm(text).includes(norm(q.evidence))) err(where, `evidence not found in the text: "${q.evidence}"`);
    if (typeof q.explain !== 'string' || q.explain.length < 10) err(where, 'explain missing');
    const L = q.choices.map((c) => String(c).length), a = L[q.answer];
    if (L.every((x, i) => i === q.answer || x < a)) longest++;
    if (L.every((x, i) => i === q.answer || x > a)) shortest++;
  }
  if (list.length >= 6) {
    if (longest / list.length > 0.4) err(f, `the right answer is the longest choice in ${longest} of ${list.length}; at most 40%`);
    if (shortest / list.length > 0.4) err(f, `the right answer is the shortest choice in ${shortest} of ${list.length}; at most 40%`);
  }
  if (write) writeFileSync(join(ROOT, f), JSON.stringify(doc, null, 2) + '\n');
}
const band = (lo, hi) => grades.filter((g) => g >= lo && g < hi).length;
console.log(`${count} paragraph(s) in ${files.length} file(s) · difficulty: <2 ${band(-1, 2)}, 2-4 ${band(2, 4)}, 4-6 ${band(4, 6)}, 6-8 ${band(6, 8)}, 8+ ${band(8, 99)} · ${errors} error(s)`);
process.exit(errors ? 1 : 0);
