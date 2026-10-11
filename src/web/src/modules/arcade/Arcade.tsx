import { useEffect, useRef, useState } from 'preact/hooks';
import type { Game, Unlock } from '../../core/types';
import { bridge } from '../../core/bridge';

declare global { interface Window { RufflePlayer?: any } }

let ruffleLoading: Promise<void> | null = null;
function loadRuffle(): Promise<void> {
  if (window.RufflePlayer) return Promise.resolve();
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

/** The arcade: a game library gated by an active arcade unlock. Flash games run in Ruffle, HTML5 games in an iframe. */
export function Arcade({ unlock, onExit }: { unlock: Unlock | undefined; onExit: () => void }) {
  const [games, setGames] = useState<Game[]>([]);
  const [playing, setPlaying] = useState<Game | null>(null);
  const [filter, setFilter] = useState<'all' | 'swf' | 'html5'>('all');

  useEffect(() => { bridge.arcade().then((r) => setGames(r.games)).catch(() => setGames([])); }, []);
  useEffect(() => { if (!unlock) setPlaying(null); }, [unlock]);

  if (!unlock) return (
    <div class="arcade-locked">
      <h2>🕹️ Arcade</h2>
      <p>Buy arcade minutes in the shop to play.</p>
      <button class="primary" onClick={onExit}>Back</button>
    </div>
  );

  if (playing) return <Player game={playing} onBack={() => setPlaying(null)} secondsLeft={unlock.secondsLeft} />;

  const shown = games.filter((g) => g.available && (filter === 'all' || g.kind === filter));
  return (
    <div class="arcade">
      <header>
        <h2>🕹️ Arcade</h2>
        <span class="countdown">{fmt(unlock.secondsLeft)} left</span>
        <div class="segmented small">
          {(['all', 'swf', 'html5'] as const).map((f) => <button class={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'swf' ? 'Flash classics' : 'Browser games'}</button>)}
        </div>
        <button class="ghost" onClick={onExit}>Back</button>
      </header>
      {shown.length === 0 && <p class="muted">No games installed yet. The build fetches them; parents can also drop .swf files into the arcade folder.</p>}
      <div class="game-grid">
        {shown.map((g) => (
          <button class="game-card" onClick={() => setPlaying(g)}>
            <div class="game-art">{g.kind === 'swf' ? '⚡' : '🌐'}</div>
            <b>{g.title}</b>
            <small>{g.genre}{g.author ? ' · ' + g.author : ''}</small>
          </button>
        ))}
      </div>
    </div>
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
      host.current!.appendChild(player);
      player.ruffle().load({ url: game.url, base: game.url.slice(0, game.url.lastIndexOf('/') + 1), allowScriptAccess: false }).catch((e: Error) => setErr(e.message));
    }).catch((e) => setErr(e.message));
    return () => { try { player?.remove(); } catch { } };
  }, [game]);

  return (
    <div class="player">
      <header>
        <button class="ghost" onClick={onBack}>← Games</button>
        <b>{game.title}</b>
        <span class="countdown">{fmt(secondsLeft)}</span>
      </header>
      {err && <p class="error">{err}</p>}
      {game.kind === 'swf'
        ? <div class="player-host" ref={host} />
        : <iframe class="player-host" src={game.url} sandbox="allow-scripts allow-same-origin allow-pointer-lock" title={game.title} />}
      <footer class="muted small">{game.title} by {game.author || 'unknown'} · {game.license}</footer>
    </div>
  );
}

export function fmt(s: number) { const m = Math.floor(s / 60); const r = s % 60; return `${m}:${r.toString().padStart(2, '0')}`; }
