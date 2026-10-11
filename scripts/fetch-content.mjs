#!/usr/bin/env node
// Fetches the full public-domain King James Bible text (for the Scripture Typing "whole Bible" plan, a later phase).
// Source: https://github.com/scrollmapper/bible_databases (public domain data). Run by CI; output is not committed.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = 'https://raw.githubusercontent.com/scrollmapper/bible_databases/master/formats/json/KJV.json';
const r = await fetch(url);
if (!r.ok) { console.warn('KJV fetch failed:', r.status); process.exit(0); }
mkdirSync(join(root, 'content', 'bible'), { recursive: true });
writeFileSync(join(root, 'content', 'bible', 'kjv-full.json'), await r.text());
console.log('kjv-full.json written');
