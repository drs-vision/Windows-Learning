// Copies the Ruffle runtime into dist/vendor/ruffle so the arcade works fully offline.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'node_modules', '@ruffle-rs', 'ruffle');
const dst = join(here, '..', 'dist', 'vendor', 'ruffle');
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) if (/\.(js|wasm|map)$/.test(f) || f.startsWith('LICENSE')) cpSync(join(src, f), join(dst, f));
console.log('ruffle copied to', dst);
