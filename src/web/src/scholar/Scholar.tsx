import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChildState, Prize, Unlock } from '../core/types';
import { bridge } from '../core/bridge';
import { MODULES, moduleById } from '../modules/registry';
import { Arcade, fmt } from '../modules/arcade/Arcade';
import { ParentConsole } from '../parent/ParentConsole';
import { YouTube } from './YouTube';
import { Websites } from './Websites';
import type { LessonModule } from '../core/module';

type View = { name: 'home' } | { name: 'quest'; moduleId: string } | { name: 'shop' } | { name: 'arcade' } | { name: 'youtube' } | { name: 'web' } | { name: 'parent' };

/** The child's whole world: home base, quests, shop, arcade. */
export function Scholar() {
  const [state, setState] = useState<ChildState | null>(null);
  const [view, setView] = useState<View>({ name: 'home' });
  const [toast, setToast] = useState<string>('');
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  const refresh = () => bridge.state().then(setState).catch((e) => setError(e.message));
  // Learning seen in CoinQuest's browser (Khan Academy, Duolingo): counted up, then sent to the Guardian, which pays.
  type Counts = Record<string, number>;
  const learn = useRef<{ khan: Counts; duolingo: Counts; timer: any }>({ khan: {}, duolingo: {}, timer: 0 });
  const flushLearn = () => {
    const l = learn.current; clearTimeout(l.timer);
    for (const [moduleId, key, label] of [['khan-academy', 'khan', '🎓 Khan Academy'], ['duolingo', 'duolingo', '🦉 Duolingo']] as const) {
      const data = l[key];
      if (!Object.values(data).some((n) => n > 0)) continue;
      l[key] = {};
      const result = { startedAt: Date.now() - 1000, finishedAt: Date.now(), data };
      bridge.submit(moduleId, { moduleId, kind: 'observed', data: {}, issuedAt: Date.now() }, result)
        .then((r) => { if (r.coins > 0) setToast(`${label}: +${r.coins} 🪙!`); refresh(); })
        .catch(() => undefined);
    }
  };

  useEffect(() => {
    refresh();
    const off = bridge.on((ev) => {
      if (ev.name === 'state') refresh();
      if (ev.name === 'unlockEnded') { setToast(`⏰ ${ev.payload?.prizeName ?? 'Your time'} is up`); if (view.name === 'arcade') setView({ name: 'home' }); }
      if (ev.name === 'blocked') setToast(`🚫 ${ev.payload?.exe ?? 'That app'} isn't on your list`);
      if (ev.name === 'openParent') setView({ name: 'parent' });
      if (ev.name === 'learn') {
        const [site, what] = String(ev.payload?.kind ?? '').split(':');
        const l = learn.current;
        const bucket = site === 'duolingo' ? l.duolingo : site === 'khan' ? l.khan : null;
        if (bucket && what) {
          bucket[what] = (bucket[what] ?? 0) + 1;
          clearTimeout(l.timer);
          if (what !== 'correct' || (bucket.correct ?? 0) >= 5) flushLearn(); else l.timer = setTimeout(flushLearn, 8000);
        }
      }
      if (ev.name === 'siteClosed') flushLearn();
      if (ev.name === 'disconnected') setError('Lost connection to the Guardian — reconnecting…');
    });
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { off(); clearInterval(t); };
  }, []);

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 6000); return () => clearTimeout(t); } }, [toast]);

  if (error && !state) return <div class="screen center"><h2>Hmm.</h2><p>{error}</p><button class="primary" onClick={refresh}>Try again</button></div>;
  if (!state) return <div class="screen center"><p class="muted">Loading…</p></div>;

  // Recompute secondsLeft locally between server pushes so countdowns are smooth.
  const unlocks = state.unlocks.map((u) => ({ ...u, secondsLeft: Math.max(0, Math.round((Date.parse(u.expiresAt) - Date.now()) / 1000)) }));
  const arcadeUnlock = unlocks.find((u) => u.kind === 'arcadeUnlock' && u.secondsLeft > 0);
  const ytUnlock = unlocks.find((u) => u.kind === 'youTube' && u.secondsLeft > 0);

  return (
    <div class="scholar">
      {view.name !== 'parent' && <TopBar state={state} unlocks={unlocks} onHome={() => setView({ name: 'home' })} onShop={() => setView({ name: 'shop' })} />}
      <main>
        {view.name === 'home' && <Home state={state} arcadeUnlock={arcadeUnlock} ytUnlock={ytUnlock} onQuest={(id) => setView({ name: 'quest', moduleId: id })} onArcade={() => setView({ name: 'arcade' })} onYouTube={() => setView({ name: 'youtube' })} onWeb={() => setView({ name: 'web' })} onShop={() => setView({ name: 'shop' })} />}
        {view.name === 'quest' && <QuestRunner module={moduleById(view.moduleId)!} state={state} onExit={() => { setView({ name: 'home' }); refresh(); }} />}
        {view.name === 'shop' && <Shop state={state} onBought={(msg) => { setToast(msg); refresh(); }} onExit={() => setView({ name: 'home' })} onYouTube={() => setView({ name: 'youtube' })} />}
        {view.name === 'arcade' && <Arcade unlocks={unlocks} balance={state.balance} onChanged={refresh} onExit={() => setView({ name: 'home' })} />}
        {view.name === 'web' && <Websites state={state} onExit={() => setView({ name: 'home' })} />}
        {view.name === 'youtube' && <YouTube unlock={ytUnlock} onExit={() => setView({ name: 'home' })} prize={state.prizes.find((p) => p.kind === 'youTube')} balance={state.balance} onBought={refresh} />}
        {view.name === 'parent' && <ParentConsole embedded onClose={() => { setView({ name: 'home' }); refresh(); }} />}
      </main>
      {toast && <div class="toast">{toast}</div>}
    </div>
  );
}

function TopBar({ state, unlocks, onHome, onShop }: { state: ChildState; unlocks: Unlock[]; onHome: () => void; onShop: () => void }) {
  return (
    <header class="topbar">
      <button class="brand" onClick={onHome}>🏠 <span>Hi, {state.child.displayName}</span></button>
      <div class="unlock-pills">
        {(() => {
          // Busy days can have many timers; show the three ending soonest and a count for the rest.
          const live = unlocks.filter((u) => u.secondsLeft > 0).sort((a, b) => a.secondsLeft - b.secondsLeft);
          return <>
            {live.slice(0, 3).map((u) => <span class="pill">{u.prizeName.replace(/^\d+ minutes of /, '')} · {fmt(u.secondsLeft)}</span>)}
            {live.length > 3 && <span class="pill">+{live.length - 3} more</span>}
          </>;
        })()}
      </div>
      <button class="wallet" onClick={onShop}>🪙 <b>{state.balance}</b></button>
    </header>
  );
}

function Home({ state, arcadeUnlock, ytUnlock, onQuest, onArcade, onYouTube, onWeb, onShop }: { state: ChildState; arcadeUnlock?: Unlock; ytUnlock?: Unlock; onQuest: (id: string) => void; onArcade: () => void; onYouTube: () => void; onWeb: () => void; onShop: () => void }) {
  const quests = MODULES.filter((m) => state.modules[m.id]?.enabled);
  const pending = state.pendingClaims.length;
  return (
    <div class="home">
      <section class="quests">
        <h2>Today's quests</h2>
        <div class="quest-grid">
          {quests.map((m) => {
            const s = state.modules[m.id];
            const left = s.dailyCap > 0 ? Math.max(0, s.dailyCap - s.earnedToday) : null;
            return (
              <button class={'quest-card' + (left === 0 ? ' maxed' : '')} onClick={() => onQuest(m.id)}>
                <div class="quest-icon">{m.icon}</div>
                <b>{m.title}</b>
                <small>{m.tagline}</small>
                <div class="quest-meta">{s.coinsPerActivity} 🪙 each{left !== null && <> · {left === 0 ? 'done for today' : `${left} left today`}</>}</div>
                <ProgressLine moduleId={m.id} state={state} />
              </button>
            );
          })}
        </div>
      </section>
      <aside class="side">
        <button class="big-btn" onClick={onShop}>🛒 Shop</button>
        <button class={'big-btn' + (arcadeUnlock ? ' live' : '')} onClick={onArcade}>🕹️ Arcade {arcadeUnlock && <small>{fmt(arcadeUnlock.secondsLeft)}</small>}</button>
        <button class="big-btn" onClick={onWeb}>🌐 Websites</button>
        {(state.youtubeChannels ?? 0) > 0 && <button class={'big-btn' + (ytUnlock ? ' live' : '')} onClick={onYouTube}>▶️ YouTube {ytUnlock && <small>{fmt(ytUnlock.secondsLeft)}</small>}</button>}
        {pending > 0 && <div class="note">⏳ {pending} claim{pending > 1 ? 's' : ''} waiting for a parent</div>}
        <Recent state={state} />
      </aside>
    </div>
  );
}

function ProgressLine({ moduleId, state }: { moduleId: string; state: ChildState }) {
  const p = (state.progress[moduleId] ?? {}) as Record<string, any>;
  if (moduleId === 'sound-keys') return <small class="muted">{p.done?.length ? `${p.done.length} of 39 lessons` : 'Start here — lesson 1'}</small>;
  if (moduleId === 'typing-quest') return <small class="muted">{p.placed ? `Row ${(p.lane ?? 0) + 1} · best ${p.bestWpm ?? 0} WPM` : 'Start with a placement test'}</small>;
  if (moduleId === 'bible-typing') return <small class="muted">{(p.done?.length ?? 0)} passages · {p.totalWords ?? 0} words</small>;
  return null;
}

function Recent({ state }: { state: ChildState }) {
  if (!state.recent.length) return <div class="recent"><h3>Today</h3><p class="muted">Nothing yet. Pick a quest!</p></div>;
  return (
    <div class="recent">
      <h3>Today</h3>
      <ul>
        {state.recent.slice(0, 8).map((e) => <li class={e.kind}><span class="delta">{e.delta > 0 ? '+' : ''}{e.delta || '⏳'}</span><span>{e.detail}</span></li>)}
      </ul>
    </div>
  );
}

/** Mounts a module's activity UI and wires its context to the bridge. */
function QuestRunner({ module, state, onExit }: { module: LessonModule; state: ChildState; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const progress = (state.progress[module.id] ?? {}) as Record<string, unknown>;
    const activity = { ...module.nextActivity(progress, Math.random), issuedAt: Date.now() };
    const settings = state.modules[module.id];
    const unmount = module.mount(host.current, activity, {
      progress, settings,
      submit: (result, act) => bridge.submit(module.id, act ?? activity, result),
      saveProgress: (p) => bridge.saveProgress(module.id, p).then(() => { }),
      exit: onExit,
    });
    return unmount;
  }, [module.id]);
  return <div class="quest-host" ref={host} />;
}

function Shop({ state, onBought, onExit, onYouTube }: { state: ChildState; onBought: (msg: string) => void; onExit: () => void; onYouTube: () => void }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function buy(p: Prize) {
    setBusy(p.id); setError('');
    try { await bridge.buy(p.id); onBought(p.kind === 'realWorld' ? `🎉 ${p.name} — tell your parent!` : p.kind === 'youTube' ? `✅ ${p.name} started — open YouTube from home` : `✅ ${p.name} started`); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }
  return (
    <div class="shop">
      <header><h2>🛒 Shop</h2><span class="wallet-big">🪙 {state.balance}</span><button class="ghost" onClick={onExit}>Back</button></header>
      {error && <p class="error">{error}</p>}
      <div class="prize-grid">
        {state.prizes.map((p) => {
          const soldOut = p.dailyCap > 0 && p.boughtToday >= p.dailyCap;
          if (p.kind === 'youTube' && p.blockPrice) return (
            <div class={'prize-card' + (soldOut ? ' soldout' : '')}>
              <div class="prize-icon">{ICON[p.kind]}</div>
              <b>YouTube time</b>
              <div class="price">🪙 {p.blockPrice} <small>/ 5 min</small></div>
              <small class="muted">Press + for more minutes</small>
              <button class="primary" disabled={soldOut} onClick={onYouTube}>{soldOut ? 'Tomorrow' : 'Choose time'}</button>
            </div>
          );
          const canAfford = state.balance >= p.cost;
          return (
            <div class={'prize-card' + (soldOut ? ' soldout' : '') + (!canAfford ? ' poor' : '')}>
              <div class="prize-icon">{ICON[p.kind]}</div>
              <b>{p.name}</b>
              <div class="price">🪙 {p.cost}</div>
              {p.dailyCap > 0 && <small class="muted">{p.boughtToday}/{p.dailyCap} today</small>}
              <button class="primary" disabled={soldOut || !canAfford || busy === p.id} onClick={() => buy(p)}>{soldOut ? 'Tomorrow' : canAfford ? 'Buy' : `${p.cost - state.balance} more`}</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ICON: Record<string, string> = { youTube: '▶️', siteUnlock: '🌐', arcadeUnlock: '🕹️', appUnlock: '💻', screenTimeExtension: '⏰', realWorld: '🎁' };
