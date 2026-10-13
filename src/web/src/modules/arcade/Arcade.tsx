import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Game, Unlock } from '../../core/types';
import { BLOCK_MINUTES } from '../../core/types';
import { TimeStepper } from '../../core/TimeStepper';
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

/** Time he can play this game right now: its own time, or a sampler pass ("*"), whichever lasts longer. */
const unlockFor = (unlocks: Unlock[], gameId: string) =>
  unlocks.filter((u) => u.kind === 'arcadeUnlock' && u.secondsLeft > 0 && (u.targets.length === 0 || u.targets.includes(gameId) || u.targets.includes('*')))
    .sort((a, b) => b.secondsLeft - a.secondsLeft)[0];
const samplerFor = (unlocks: Unlock[]) => unlocks.find((u) => u.kind === 'arcadeUnlock' && u.secondsLeft > 0 && u.targets.includes('*'));

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

const GENRE_ICON: Record<string, string> = { Racing: '🏎️', Strategy: '♟️', 'Tower defense': '🏰', Platformer: '🏃', Puzzle: '🧩', Launch: '🚀', Artillery: '💥', Sports: '⚽', Arcade: '👾', Fighting: '🥋', 'Choose your path': '🕵️', Cooking: '🍕', Creative: '✏️', Runner: '🏃', 'Board games': '♞', Adventure: '🗺️', Action: '💣', Training: '🦆' };
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
  if (l.includes('creat') || l.includes('sandbox')) return 'Creative';
  if (l.includes('board')) return 'Board games';
  if (l.includes('adventure')) return 'Adventure';
  if (l.includes('action')) return 'Action';
  if (l.includes('training') || l.includes('mining')) return 'Training';
  return 'Arcade';
}

/**
 * A 2000s-style game portal. Time is bought like quarters: press + to add 5 minutes of a game, then Play.
 * Or save up for a sampler pass: any game, for 10 minutes. Time keeps counting once started; leaving a game
 * and coming back is free while time is left.
 */
export function Arcade({ unlocks, balance, onExit, onChanged }: { unlocks: Unlock[]; balance: number; onExit: () => void; onChanged: () => void }) {
  const [games, setGames] = useState<Game[]>([]);
  const [fpRoot, setFpRoot] = useState<string | null>(null);
  const [sampler, setSampler] = useState<{ minutes: number; price: number } | null>(null);
  const [maxBlocks, setMaxBlocks] = useState(12);
  const [blocks, setBlocks] = useState(1);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const [sel, setSel] = useState<Game | null>(null);
  const [playing, setPlaying] = useState<(Game & { base?: string; rewritePrefix?: string }) | null>(null);
  const [preparing, setPreparing] = useState('');
  // When the current play's time runs out, from the purchase itself. The shared state (unlocks) arrives a moment
  // later; until it does, this is what keeps the game open (and the countdown right).
  const [until, setUntil] = useState(0);
  const startedAt = useRef(0);
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const secondsLeft = (g: Game) => unlockFor(unlocks, g.id)?.secondsLeft ?? (playing?.id === g.id ? Math.max(0, Math.round((until - Date.now()) / 1000)) : 0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadGames = () => bridge.arcade().then((r) => { setGames(r.games); setSampler(r.sampler ?? null); setMaxBlocks(r.maxBlocks ?? 12); setFpRoot(r.flashpointRoot ?? null); }).catch((e) => setError(e.message));
  useEffect(() => { loadGames(); }, []);
  // Time ran out (or a parent ended it): close whatever is open.
  useEffect(() => {
    if (!playing) return;
    const u = unlockFor(unlocks, playing.id);
    if (u) { const end = Date.parse(u.expiresAt); if (Math.abs(end - until) > 1500) setUntil(end); return; }
    // No time in the shared state: either it hasn't caught up with the purchase yet (give it a few seconds),
    // or the time really ended / a parent ended it.
    if (Date.now() >= until || Date.now() - startedAt.current > 8000) { bridge.closeGame(); setPlaying(null); }
  });
  // The child closed the game window: the play is over.
  useEffect(() => bridge.on((ev) => {
    if (ev.name === 'gameClosed') setPlaying((p) => { if (p) { bridge.arcadeQuit(p.id).then(onChanged); } return null; });
  }), []);

  const cats = useMemo(() => ['All', ...[...new Set(games.map((g) => genreKey(g.genre)))].sort()], [games]);
  const shown = games.filter((g) => (cat === 'All' || genreKey(g.genre) === cat) && (!q || g.title.toLowerCase().includes(q.toLowerCase())));
  const hot = [...games].filter((g) => (g.plays ?? 0) > 0).sort((a, b) => (b.plays ?? 0) - (a.plays ?? 0)).slice(0, 6);

  const pass = samplerFor(unlocks);
  const open = (g: Game) => { setSel(g); setBlocks(unlockFor(unlocks, g.id) ? 0 : 1); };

  async function buySampler() {
    setError(''); setBusy(true);
    try { await bridge.arcadeSampler(); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function insertCoin(g: Game, n: number) {
    setError(''); setBusy(true);
    try {
      if (playing && playing.id !== g.id) { bridge.closeGame(); setPlaying(null); }
      // Classics: get the game's files ready first (a few seconds the first time), so no coins are spent on a
      // game that can't start.
      let classic: { url: string; base: string; prefix: string; platform?: string } | null = null;
      if (g.kind === 'classic') { setPreparing(g.title); classic = await bridge.arcadePrepare(g.id).finally(() => setPreparing('')); }
      const r = await bridge.arcadePlay(g.id, n);
      startedAt.current = Date.now();
      setUntil(r.unlock?.expiresAt ? Date.parse(r.unlock.expiresAt) : Date.now() + 5 * 60_000);
      onChanged();
      if (g.kind === 'flashpoint') {
        const root = r.flashpointRoot ?? fpRoot;
        if (!root) throw new Error('Flashpoint is not installed on this computer yet.');
        await bridge.flashpoint(root, g.url);
      } else if (g.kind === 'web') {
        await bridge.openGame(g.url, g.title);
      }
      setSel(null);
      setPlaying(classic ? (classic.platform?.toLowerCase() === 'html5' ? { ...g, kind: 'html5', url: classic.url } : { ...g, kind: 'swf', url: classic.url, base: classic.base, rewritePrefix: classic.prefix }) : g);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  function quit() {
    if (playing) bridge.arcadeQuit(playing.id).then(onChanged);
    bridge.closeGame();
    setPlaying(null);
  }

  if (playing && (playing.kind === 'swf' || playing.kind === 'html5')) {
    return <Player game={playing} onBack={quit} onBroken={() => { quit(); loadGames(); onChanged(); }} secondsLeft={secondsLeft(playing)} sampler={!!pass && !unlocks.some((x) => x.targets.includes(playing.id) && x.secondsLeft > 0)} />;
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
      {preparing && <div class="now-playing"><span>⏳ Getting <b>{preparing}</b> ready… (the first time takes a few seconds)</span></div>}
      {sampler && (
        pass
          ? <div class="sampler on">🎟️ <b>Sampler pass</b> — play ANY game! <span class="countdown">{fmt(pass.secondsLeft)}</span> left</div>
          : <div class="sampler">
              <span>🎟️ <b>Sampler pass</b> — any game, as many as you want, for <b>{sampler.minutes} minutes</b></span>
              <button class="coin-btn small" disabled={busy || balance < sampler.price} onClick={buySampler}>
                {balance >= sampler.price ? <>GET PASS <b>🪙 {sampler.price}</b></> : `Save up: ${sampler.price - balance} more 🪙`}
              </button>
            </div>
      )}
      {playing && (
        <div class="now-playing">
          <span>🎮 Now playing <b>{playing.title}</b> · <span class="countdown">{fmt(secondsLeft(playing))}</span> left — {playing.kind === 'flashpoint' ? 'it opens in its own window (the first time it may take a moment to download).' : 'it is open in its own window.'}</span>
          <button class="primary" onClick={quit}>I'm done playing</button>
        </div>
      )}
      <nav class="portal-cats">{cats.map((c) => <button class={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c === 'All' ? '⭐ All' : `${GENRE_ICON[c] ?? '🎮'} ${c}`}</button>)}</nav>

      {!q && cat === 'All' && hot.length > 0 && (
        <section><h3 class="portal-h">🔥 Your most played</h3>
          <div class="tile-row">{hot.map((g) => <Tile g={g} onClick={() => open(g)} balance={balance} left={unlockFor(unlocks, g.id)?.secondsLeft} />)}</div>
        </section>
      )}

      <section>
        <h3 class="portal-h">{q ? `Results for "${q}"` : cat === 'All' ? '🕹️ All games' : `${GENRE_ICON[cat] ?? ''} ${cat}`} <small class="muted">· {shown.length}</small></h3>
        {games.length === 0 && <p class="muted">No games yet. A parent can add games in the Parent Console → Shop → Arcade.</p>}
        <div class="tile-grid">{shown.map((g) => <Tile g={g} onClick={() => open(g)} balance={balance} left={unlockFor(unlocks, g.id)?.secondsLeft} />)}</div>
      </section>

      {sel && (
        <div class="modal" onClick={(e) => { if (e.target === e.currentTarget) setSel(null); }}>
          <div class="game-detail">
            <Cover game={sel} big />
            <div class="game-detail-info">
              <h2>{sel.title}</h2>
              <p class="muted">{[sel.genre, sel.author].filter(Boolean).join(' · ')}</p>
              <p><span class="brains">{'🧠'.repeat(Math.max(1, sel.strategy))}</span> <small class="muted">thinking games cost less</small></p>
              <TimeBuyer game={sel} balance={balance} blocks={blocks} maxBlocks={maxBlocks} setBlocks={setBlocks} busy={busy}
                left={unlockFor(unlocks, sel.id)?.secondsLeft ?? 0} onPlay={(n) => insertCoin(sel, n)} />
              <button class="ghost" onClick={() => setSel(null)}>Back</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** + / − in 5-minute steps, then Play. Time already running (own or sampler) can be used for free, and topped up. */
function TimeBuyer({ game, balance, blocks, maxBlocks, setBlocks, left, busy, onPlay }: {
  game: Game; balance: number; blocks: number; maxBlocks: number; setBlocks: (n: number) => void; left: number; busy: boolean; onPlay: (blocks: number) => void;
}) {
  const cost = game.price * blocks;
  const minBlocks = left > 0 ? 0 : 1;
  const canAfford = balance >= cost;
  return (
    <div class="time-buyer">
      <p class="muted small">🪙 {game.price} for every {BLOCK_MINUTES} minutes{left > 0 ? <> · <b>{fmt(left)}</b> already on the clock</> : ''}</p>
      <TimeStepper price={game.price} blocks={blocks} setBlocks={setBlocks} min={minBlocks} max={maxBlocks} balance={balance} more={left > 0} />
      <button class="coin-btn" disabled={busy || !canAfford || (blocks === 0 && left <= 0)} onClick={() => onPlay(blocks)}>
        {!canAfford ? `Need ${cost - balance} more coins` : blocks === 0 ? <>▶ PLAY</> : left > 0 ? <>ADD TIME & PLAY <b>🪙 {cost}</b></> : <>▶ PLAY <b>🪙 {cost}</b></>}
      </button>
    </div>
  );
}

function Tile({ g, onClick, balance, left }: { g: Game; onClick: () => void; balance: number; left?: number }) {
  return (
    <button class={'tile' + (balance < g.price && !left ? ' poor' : '')} onClick={onClick}>
      <Cover game={g} />
      {left ? <span class="tile-price time">⏱ {fmt(left)}</span> : <span class="tile-price">🪙 {g.price}<small>/5m</small></span>}
      <b class="tile-title">{g.title}</b>
      <small class="tile-sub">{g.genre || g.author}</small>
    </button>
  );
}

function Player({ game, onBack, onBroken, secondsLeft, sampler }: { game: Game & { base?: string; rewritePrefix?: string }; onBack: () => void; onBroken: () => void; secondsLeft: number; sampler?: boolean }) {
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
      // Classics ask for their files at their original web addresses; send those to the local copy instead.
      // (Not the local copy itself — rewriting that again would double the address.)
      const rewrite = game.rewritePrefix ? { urlRewriteRules: [[/^https?:\/\/(?!coinquest-[a-z]+\.local\/)/, game.rewritePrefix]] } : {};
      // Fill the play area WITHOUT changing the game's own stage: the player keeps the game's native size and is
      // scaled up as a picture. (Forcing Ruffle to rescale the stage broke games that read their own pixels, e.g. Sugar, Sugar.)
      const fit = () => {
        const m = player?.ruffle?.().metadata; const box = host.current;
        if (!m?.width || !m?.height || !box) return;
        const k = Math.min(box.clientWidth / m.width, box.clientHeight / m.height);
        Object.assign(player.style, { position: 'absolute', width: m.width + 'px', height: m.height + 'px', transformOrigin: '0 0',
          transform: `scale(${k})`, left: (box.clientWidth - m.width * k) / 2 + 'px', top: (box.clientHeight - m.height * k) / 2 + 'px' });
      };
      player.addEventListener('loadedmetadata', fit);
      ro = new ResizeObserver(fit); ro.observe(host.current!);
      player.ruffle().load({ url: game.url, base: game.base ?? game.url.slice(0, game.url.lastIndexOf('/') + 1), allowScriptAccess: false, ...rewrite })
        .then(() => { fit(); player.focus(); }).catch((e: Error) => setErr(e.message));
    }).catch((e) => setErr(e.message));
    let ro: ResizeObserver | null = null;
    return () => { try { ro?.disconnect(); player?.remove(); } catch { } };
  }, [game]);

  return (
    <div class="player">
      <header>
        <button class="ghost" onClick={onBack}>{sampler ? '← Pick another game' : '← Back to arcade'}</button>
        <b>{game.title}</b>
        <span class="row">
          <button class="ghost small" title="Hides this game from the arcade and gives back the coins paid for its time. A parent can bring it back." onClick={() => { if (confirm(`Doesn't ${game.title} work? It will be taken out of the arcade and you get your coins back.`)) bridge.arcadeReportBroken(game.id).then((r) => { if (r.refund) alert(`🪙 ${r.refund} coins are back in your wallet.`); onBroken(); }).catch((e) => setErr((e as Error).message)); }}>⚠️ Broken?</button>
          <span class="countdown" title={sampler ? 'Sampler pass time left' : 'Time left on this game'}>{sampler ? '🎟️ ' : '⏱ '}{fmt(secondsLeft)}</span>
        </span>
      </header>
      {err && <p class="error">{err}</p>}
      {game.kind === 'swf'
        ? <div class="player-host swf-host" ref={host} />
        : <iframe class="player-host" src={game.url} sandbox="allow-scripts allow-same-origin allow-pointer-lock" title={game.title} ref={(el) => el?.focus()} />}
      <footer class="muted small">{game.title}{game.author ? ` by ${game.author}` : ''} · {game.license}</footer>
    </div>
  );
}

export function fmt(s: number) { const m = Math.floor(s / 60); const r = s % 60; return `${m}:${r.toString().padStart(2, '0')}`; }
