#!/usr/bin/env node
// Downloads the arcade games listed in content/games/MANIFEST.json (run by CI; safe to run locally).
// Each game lands at content/games/<path> with its LICENSE next to it. Nothing here is committed.
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gamesDir = join(root, 'content', 'games');
const manifest = JSON.parse(readFileSync(join(gamesDir, 'MANIFEST.json'), 'utf8'));
const tmp = join(root, '.tmp-games'); mkdirSync(tmp, { recursive: true });
const only = process.argv.slice(2);

async function download(url, dest) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'coinquest-fetch-games' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(r.body, createWriteStream(dest));
}

let ok = 0, failed = 0;
for (const g of manifest.games) {
  if (only.length && !only.includes(g.id)) continue;
  const target = join(gamesDir, g.path);
  try {
    if (g.kind === 'swf') {
      await download(g.download, target);
      for (const [name, url] of Object.entries(g.sidecars ?? {})) await download(url, join(dirname(target), name));
    } else {
      const zip = join(tmp, g.id + '.zip');
      await download(g.download, zip);
      const extractTo = join(tmp, g.id);
      rmSync(extractTo, { recursive: true, force: true }); mkdirSync(extractTo, { recursive: true });
      // unzip is on every CI image; on Windows use tar (bsdtar understands zip).
      execSync(process.platform === 'win32' ? `tar -xf "${zip}" -C "${extractTo}"` : `unzip -q "${zip}" -d "${extractTo}"`);
      const src = join(extractTo, g.unzipRoot ?? readdirSync(extractTo)[0]);
      if (g.id === 'micropolis') {
        try { execSync('npm ci && npm run build', { cwd: src, stdio: 'ignore' }); }
        catch { console.warn(`  ${g.id}: upstream build failed, skipping`); failed++; continue; }
      }
      // The game's folder is everything above its index.html within content/games/<path>.
      const pathParts = g.path.split('/');               // html5/<id>/.../index.html
      const gameRoot = join(gamesDir, pathParts[0], pathParts[1]);
      rmSync(gameRoot, { recursive: true, force: true });
      cpSync(src, gameRoot, { recursive: true });
      // Strip .git and node_modules if any slipped in.
      for (const junk of ['.git', 'node_modules']) rmSync(join(gameRoot, junk), { recursive: true, force: true });
    }
    // License next to the game.
    try {
      const rawLicense = g.licenseUrl.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
      await download(rawLicense, join(dirname(target), g.kind === 'swf' ? `${g.id}.LICENSE.txt` : 'LICENSE.coinquest.txt'));
    } catch { writeFileSync(join(dirname(target), `${g.id}.LICENSE.txt`), `${g.title} — ${g.license}\n${g.licenseUrl}\nSource: ${g.source}\n`); }
    console.log(`  ✓ ${g.title}`); ok++;
  } catch (e) {
    console.warn(`  ✗ ${g.title}: ${e.message}`); failed++;
  }
}
rmSync(tmp, { recursive: true, force: true });
console.log(`${ok} fetched, ${failed} failed`);
if (ok === 0 && manifest.games.length) process.exit(1);
