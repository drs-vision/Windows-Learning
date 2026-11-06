import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

/**
 * A pale, dismissible hint ("Read whatever you like…", "Tip: select words to highlight them"). It looks quieter than
 * the page's real content and has a faint ✕; once closed it stays closed on this PC (per `id`). Use it for any
 * how-to or explanation a child only needs to see until they've got it — never for errors or things they must act on.
 */
export function Notice({ id, children, class: cls = '' }: { id: string; children: ComponentChildren; class?: string }) {
  const key = `cq.notice.${id}`;
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  if (hidden) return null;
  const close = () => { setHidden(true); try { localStorage.setItem(key, '1'); } catch { /* fine */ } };
  return (
    <div class={'notice ' + cls} role="note">
      <span class="notice-text">{children}</span>
      <button class="notice-close" aria-label="Got it, hide this" title="Got it" onClick={close}>✕</button>
    </div>
  );
}
