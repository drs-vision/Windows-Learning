import { render } from 'preact';
import { Scholar } from './scholar/Scholar';
import { ParentConsole } from './parent/ParentConsole';
import './coin.css';

const app = new URLSearchParams(location.search).get('app') ?? 'scholar';
document.documentElement.dataset.app = app;

// Does this computer have a colour 🪙? (Windows 10 doesn't: it draws an empty square.) If not, use our own coin.
try {
  const c = document.createElement('canvas'); c.width = c.height = 40;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.font = '32px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif'; g.textBaseline = 'top';
  g.fillText('\u{1FA99}', 2, 2);
  const d = g.getImageData(0, 0, 40, 40).data;
  let colour = false;
  for (let i = 0; i < d.length && !colour; i += 4) if (d[i + 3] > 0 && (Math.abs(d[i] - d[i + 1]) > 30 || Math.abs(d[i + 1] - d[i + 2]) > 30)) colour = true;
  if (!colour) document.documentElement.dataset.coinfont = '1';
} catch { /* keep the system's */ }

// Arrow keys, space and page keys belong to games and lessons — never scroll the page with them.
if (app !== 'parent') {
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) e.preventDefault();
  }, { capture: true });
}

render(app === 'parent' ? <ParentConsole /> : <Scholar />, document.getElementById('app')!);
