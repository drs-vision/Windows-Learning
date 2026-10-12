import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Game, Unlock } from '../../core/types';
import { bridge } from '../../core/bridge';

declare global { interface Window { RufflePlayer?: any } }

let ruffleLoading: Promise<void> | null = null;
function loadRuffle(): Promise<void> {
  if (window.RufflePlayer?.newest) return Promise.resolve();
  if (!ruffleLoading) {
    ruffleLoading = new Promise((resolve, reject) => {
      window.RufflePlayer = window.RufflePlayer || {};
      window.RufflePlayer.config = { autoplay: 'on', unmuteOverlay: 'hidden', letterbox: 'on', splashScreen: false, allowScriptAccess: false, publicPath: './vendor/ruffle/' };
      const s = document.createElement('script');
      s.src = './vendor/ruffle/ruffle.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Ruffle failed to load'));
      document.head.appendChild(s);
    });
  }
  return ruffleLoading;
}

const unlockFor = (unlocks: Unlock[], gameId: string) =>
  unlocks.find((u) => u.kind === 'arcadeUnlock' && u.secondsLeft > 0 && (u.targets.length === 0 || u.targets.includes(gameId)));

/** Deterministic, colourful cover art for games without a thumbnail. */
function Cover({ game, big }: { game: Game; big?: boolean }) {
  if (game.thumbnail) return <img class={'cover' + (big ? ' big' : '')} src={game.thumbnail} alt="" loading="lazy" />;
  let h = 0; for (const c of game.title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 360, b = (a + 50 + (h >> 8) % 90) % 360;
  const icon = GENRE_ICON[genreKey(game.genre)] ?? '🎮';
  return (
    <div class={'cover gen' + (big ? ' big' : '')} style={{ background: `linear-gradient(135deg, hsl(${a} 80% 45%), hsl(${b} 85% 30%))` }}>
      <span class="cover-icon">{icon}</span>
      <span class="cover-title">{game.title}</span>
    </div>
  );
}

const GENRE_ICON: Record<string, string> = { Racing: '🏎️', Strategy: '♟️', 'Tower defense': '🏰', Platformer: '🏃', Puzzle: '🧩', Launch: '🚀', Artillery: '💥', Sports: '⚽', Arcade: '👾', Fighting: '🥋', 'Choose your path': '🕵️', Cooking: '🍕', Creative: '✏️', Runner: '🏃' };
function genreKey(g: string): string {
  const l = g.toLowerCase();
  if (l.includes('racing') || l.includes('driv')) return 'Racing';
  if (l.includes('tower')) return 'Tower defense';
  if (l.includes('strategy')) return 'Strategy';
  if (l.includes('platform')) return 'Platformer';
  if (l.includes('runner')) return 'Runner';
  if (l.includes('puzzle')) return 'Puzzle';
  if (l.includes('launch') || l.includes('upgrade')) return 'Launch';
  if (l.includes('artillery') || l.includes('physics')) return 'Artillery';
  if (l.includes('sport')) return 'Sports';
  if (l.includes('fight')) return 'Fighting';
  if (l.includes('path')) return 'Choose your path';
  if (l.includes('cook')) return 'Cooking';
  if (l.includes('creat')) return 'Creative';
  return 'Arcade';
}

/** A 2000s-style game portal. Every game is pay-per-play: insert coins, play until you leave the game. */
export function Arcade({ unlocks, balance, onExit, onChanged }: { unlocks: Unlock[]; balance: number; onExit: () => void; onChanged: () => void }) {
  const [games, setGames] = useState<Game[]>([]);
  const [fpRoot, setFpRoot] = useState<string | null>(null);
  const [cap, setCap] = useState(15);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const [sel, setSel] = useState<Game | null>(null);
  const [playing, setPlaying] = useState<Game | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    bridge.arcade().then((r) => { setGames(r.games); setCap(r.minutesPerPlay ?? 15); setFpRoot(r.flashpointRoot ?? null); }).catch((e) => setError(e.message));
  }, []);
  // The play's safety cap ran out (or a parent ended it): close whatever is open.
  useEffect(() => { if (playing && !unlockFor(unlocks, playing.id)) { bridge.closeGame(); setPlaying(null); } }, [unlocks, playing]);
  // The child closed the game window: the play is over.
  useEffect(() => bridge.on((ev) => {
    if (ev.name === 'gameClosed') setPlaying((p) => { if (p) { bridge.arcadeQuit(p.id).then(onChanged); } return null; });
  }), []);

  const cats = useMemo(() => ['All', ...[...new Set(games.map((g) => genreKey(g.genre)))].sort()], [games]);
  const shown = games.filter((g) => (cat === 'All' || genreKey(g.genre) === cat) && (!q || g.title.toLowerCase().includes(q.toLowerCase())));
  const hot = [...games].filter((g) => (g.plays ?? 0) > 0).sort((a, b) => (b.plays ?? 0) - (a.plays ?? 0)).slice(0, 6);

  async function insertCoin(g: Game) {
    setError(''); setBusy(true);
    try {
      const r = await bridge.arcadePlay(g.id);
      onChanged();
      if (g.kind === 'flashpoint') {
        const root = r.flashpointRoot ?? fpRoot;
        if (!root) throw new Error('Flashpoint is not installed on this computer yet.');
        await bridge.flashpoint(root, g.url);
      } else if (g.kind === 'web') {
        await bridge.openGame(g.url, g.title);
      }
      setSel(null);
      setPlaying(g);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  function quit() {
    if (playing) bridge.arcadeQuit(playing.id).then(onChanged);
    bridge.closeGame();
    setPlaying(null);
  }

  if (playing && (playing.kind === 'swf' || playing.kind === 'html5')) {
    const u = unlockFor(unlocks, playing.id);
    return <Player game={playing} onBack={quit} secondsLeft={u?.secondsLeft ?? 0} />;
  }

  return (
    <div class="portal">
      <header class="portal-head">
        <div class="portal-logo">COIN<span>QUEST</span> <em>ARCADE</em></div>
        <input class="portal-search" placeholder="🔍 Search games…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <span class="portal-coins">🪙 {balance}</span>
        <button class="ghost" onClick={onExit}>✕</button>
      </header>
      {error && <p class="error">{error}</p>}
      {playing && (
        <div class="now-playing">
          <span>🎮 Now playing <b>{playing.title}</b> — {playing.kind === 'flashpoint' ? 'it opens in its own window (the first time it may take a moment to download).' : 'it is open in its own window.'}</span>
          <button class="primary" onClick={quit}>I'm done playing</button>
        </div>
      )}
      <nav class="portal-cats">{cats.map((c) => <button class={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c === 'All' ? '⭐ All' : `${GENRE_ICON[c] ?? '🎮'} ${c}`}</button>)}</nav>

      {!q && cat === 'All' && hot.length > 0 && (
        <section><h3 class="portal-h">🔥 Your most played</h3>
          <div class="tile-row">{hot.map((g) => <Tile g={g} onClick={() => setSel(g)} balance={balance} />)}</div>
        </section>
      )}

      <section>
        <h3 class="portal-h">{q ? `Results for "${q}"` : cat === 'All' ? '🕹️ All games' : `${GENRE_ICON[cat] ?? ''} ${cat}`} <small class="muted">· {shown.length}</small></h3>
        {games.length === 0 && <p class="muted">No games yet. A parent can add games in the Parent Console → Shop → Arcade.</p>}
        <div class="tile-grid">{shown.map((g) => <Tile g={g} onClick={() => setSel(g)} balance={balance} />)}</div>
      </section>

      {sel && (
        <div class="modal" onClick={(e) => { if (e.target === e.currentTarget) setSel(null); }}>
          <div class="game-detail">
            <Cover game={sel} big />
            <div class="game-detail-info">
              <h2>{sel.title}</h2>
              <p class="muted">{[sel.genre, sel.author].filter(Boolean).join(' · ')}</p>
              <p><span class="brains">{'🧠'.repeat(Math.max(1, sel.strategy))}</span> <small class="muted">thinking games cost less</small></p>
              <p class="muted small">1 play lasts until you leave the game (max {cap} min).</p>
              <button class="coin-btn" disabled={busy || balance < sel.price || !!playing} onClick={() => insertCoin(sel)}>
                {balance >= sel.price ? <>INSERT COIN <b>🪙 {sel.price}</b></> : `Need ${sel.price - balance} more coins`}
              </button>
              <button class="ghost" onClick={() => setSel(null)}>Back</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ g, onClick, balance }: { g: Game; onClick: () => void; balance: number }) {
  return (
    <button class={'tile' + (balance < g.price ? ' poor' : '')} onClick={onClick}>
      <Cover game={g} />
      <span class="tile-price">🪙 {g.price}</span>
      <b class="tile-title">{g.title}</b>
      <small class="tile-sub">{g.genre || g.author}</small>
    </button>
  );
}

function Player({ game, onBack, secondsLeft }: { game: Game; onBack: () => void; secondsLeft: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (game.kind !== 'swf' || !host.current) return;
    let player: any;
    loadRuffle().then(() => {
      player = window.RufflePlayer.newest().createPlayer();
      player.style.width = '100%'; player.style.height = '100%';
      player.tabIndex = 0;
      host.current!.appendChild(player);
      player.ruffle().load({ url: game.url, base: game.url.slice(0, game.url.lastIndexOf('/') + 1), allowScriptAccess: false })
        .then(() => player.focus()).catch((e: Error) => setErr(e.message));
    }).catch((e) => setErr(e.message));
    return () => { try { player?.remove(); } catch { } };
  }, [game]);

  return (
    <div class="player">
      <header>
        <button class="ghost" onClick={onBack}>← I'm done</button>
        <b>{game.title}</b>
        <span class="countdown" title="Longest a single play can last">{fmt(secondsLeft)}</span>
      </header>
      {err && <p class="error">{err}</p>}
      {game.kind === 'swf'
        ? <div class="player-host" ref={host} />
        : <iframe class="player-host" src={game.url} sandbox="allow-scripts allow-same-origin allow-pointer-lock" title={game.title} ref={(el) => el?.focus()} />}
      <footer class="muted small">{game.title}{game.author ? ` by ${game.author}` : ''} · {game.license}</footer>
    </div>
  );
}

export function fmt(s: number) { const m = Math.floor(s / 60); const r = s % 60; return `${m}:${r.toString().padStart(2, '0')}`; }
