import { render } from 'preact';
import { Scholar } from './scholar/Scholar';
import { ParentConsole } from './parent/ParentConsole';

const app = new URLSearchParams(location.search).get('app') ?? 'scholar';
document.documentElement.dataset.app = app;

// Arrow keys, space and page keys belong to games and lessons — never scroll the page with them.
if (app !== 'parent') {
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) e.preventDefault();
  }, { capture: true });
}

render(app === 'parent' ? <ParentConsole /> : <Scholar />, document.getElementById('app')!);
