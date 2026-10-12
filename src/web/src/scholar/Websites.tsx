import type { ChildState } from '../core/types';
import { bridge } from '../core/bridge';

/** Support domains that are allowed so other sites work, but aren't destinations by themselves. */
const SUPPORT = new Set(['kastatic.org', 'kasandbox.org', 'wikimedia.org', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'gstatic.com']);
const NAMES: Record<string, [string, string]> = {
  'khanacademy.org': ['Khan Academy', '🎓'], 'wikipedia.org': ['Wikipedia', '📚'], 'merriam-webster.com': ['Dictionary', '📖'],
  'scratch.mit.edu': ['Scratch', '🐱'], 'code.org': ['Code.org', '💻'], 'nasa.gov': ['NASA', '🚀'], 'britannica.com': ['Britannica', '🏛️'],
  'kids.nationalgeographic.com': ['Nat Geo Kids', '🦁'], 'duolingo.com': ['Duolingo', '🦉'], 'biblegateway.com': ['Bible Gateway', '📖'],
  'churchofjesuschrist.org': ['Gospel Library', '⛪'],
};

/** The only way onto the web for a managed child: CoinQuest's locked browser, limited to these sites. */
export function Websites({ state, onExit }: { state: ChildState; onExit: () => void }) {
  const unlocked = state.unlocks.filter((u) => u.kind === 'siteUnlock' && u.secondsLeft > 0).flatMap((u) => u.targets);
  const allow = [...new Set([...state.sites, ...unlocked])];
  const sites = allow.filter((s) => !SUPPORT.has(s));
  return (
    <div class="arcade">
      <header><h2>🌐 Websites</h2><span class="muted">Only these work. Ask a parent to add more.</span><button class="ghost" onClick={onExit}>Back</button></header>
      <div class="site-grid">
        {sites.map((s) => {
          const [name, icon] = NAMES[s] ?? [s, '🌐'];
          return <button class="site-card" onClick={() => bridge.openSite(`https://${s.startsWith('www.') || s.split('.').length > 2 ? s : 'www.' + s}/`, name, allow)}><span class="site-icon">{icon}</span><b>{name}</b><small class="muted">{s}</small></button>;
        })}
      </div>
    </div>
  );
}
