// Letter Rescue — a complete beginner reading-and-typing adventure (original characters, art and words).
// One sound ↔ one letter ↔ one finger, learned together and used straight away in real words.
import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Activity, Progress } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { LESSONS, SOUNDS, buildLesson, type Lesson } from './content';
import { scoreSoundKeys, DEFAULTS } from './score';
import { Glitch, Island, LetterBuddy, Tap, Tock } from './art';
import { confetti, hush, opts, sfx, speak, type Opts } from './fx';
import { BuddyBook, FocusGuard, Typewriter } from './extras';
import { LessonPlayer, buddyColor, type LessonDone } from './lesson';

interface SKProgress extends Progress { lesson?: number; done?: number[]; seed?: number; stars?: Record<string, number> }
interface Prog { current: number; done: number[]; seed: number; stars: Record<string, number> }

export const soundKeys: LessonModule = {
  id: 'sound-keys',
  title: 'Letter Rescue',
  tagline: 'Free the letters from Glitch — learn sounds and typing',
  description: 'A complete beginner reading-and-typing adventure in 39 lessons. Glitch has trapped the letters; each lesson rescues one by learning its sound, its key and the finger that types it, then using it in mini-games: charge the key, echo cave, balloon pop, word bridge, mystery box, secret messages and Glitch battles. Guided by Tap (left hand) and Tock (right hand). Also has a Buddy Book of rescued letters and a Talking Typewriter that reads back anything he types. Never timed, no buzzers, gentle hints; 1–3 stars per lesson, and a lesson comes round again until it is solid. Verified automatically.',
  icon: '🔤',
  verification: 'in_app',
  defaults: DEFAULTS,
  options: [
    { key: 'calm', label: 'Motion', help: 'Calm turns off bouncing, confetti and moving balloons.', choices: [['off', 'Lively (gentle animations)'], ['on', 'Calm (no motion)']], default: 'off' },
    { key: 'sound', label: 'Sounds and voice', choices: [['on', 'On'], ['off', 'Off']], default: 'on' },
    { key: 'voice', label: 'Voice speed', choices: [['slow', 'Slow'], ['normal', 'Normal']], default: 'slow' },
    { key: 'hint', label: 'When listening or spelling, show a hint after', help: 'A wrong key always shows the hint right away.', choices: [['2', '2 seconds'], ['5', '5 seconds'], ['10', '10 seconds'], ['never', 'Only when asked']], default: '5' },
  ],

  nextActivity(progress: SKProgress): Activity {
    const lesson = progress.lesson ?? 1;
    return { moduleId: 'sound-keys', kind: 'lesson', data: { lessonId: lesson, current: lesson, seed: progress.seed ?? 0, done: progress.done ?? [], stars: progress.stars ?? {} }, issuedAt: 0 };
  },

  mount(el, activity, ctx) {
    render(<LetterRescue activity={activity} ctx={ctx} />, el);
    return () => { hush(); render(null, el); };
  },

  score: scoreSoundKeys,
};

type Screen = { name: 'title' } | { name: 'map' } | { name: 'lesson'; id: number; run: number } | { name: 'finish'; id: number; out: Finish } | { name: 'book' } | { name: 'typer' };
interface Finish { coins: number; detail: string; stars: number; mastered: boolean; pending: boolean; capped: boolean }

function LetterRescue({ activity, ctx }: { activity: Activity; ctx: ActivityContext }) {
  const o = useMemo(() => opts(ctx.settings), [ctx.settings]);
  const d = activity.data as Record<string, unknown>;
  const [p, setP] = useState<Prog>({
    current: Number(d.current ?? d.lessonId ?? 1), done: (d.done as number[]) ?? [], seed: Number(d.seed ?? 0), stars: (d.stars as Record<string, number>) ?? {},
  });
  const [screen, setScreen] = useState<Screen>({ name: 'title' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function complete(id: number, r: LessonDone) {
    const act: Activity = { ...activity, data: { lessonId: id, current: p.current, seed: p.seed, done: p.done, stars: p.stars } };
    const result = { startedAt: r.startedAt, finishedAt: Date.now(), data: { typed: r.typed, firstTry: r.firstTry } };
    setBusy(true); setError('');
    try {
      const out = await ctx.submit(result, act);
      // The Guardian ran the same pure scorer; run it here too to know the new progress without a round trip.
      const local = scoreSoundKeys(act, result, ctx.settings);
      const delta = (local.progressDelta ?? {}) as Record<string, any>;
      setP({ current: delta.lesson ?? p.current, done: delta.done ?? p.done, seed: delta.seed ?? p.seed + 1, stars: delta.stars ?? p.stars });
      setScreen({ name: 'finish', id, out: { coins: out.coins, detail: out.detail, stars: delta.lastStars ?? 1, mastered: !String(local.detail).includes('practise again'), pending: out.pending, capped: out.capped } });
    } catch (e) {
      setError((e as Error).message);
      setScreen({ name: 'map' });
    } finally { setBusy(false); }
  }

  const lesson = (id: number) => LESSONS.find((l) => l.id === id)!;
  return (
    <div class={'sk lr' + (o.calm ? ' calm' : '')}>
      <FocusGuard />
      {error && <p class="error">Couldn't save that lesson: {error}</p>}
      {busy && <p class="muted center">Saving…</p>}
      {screen.name === 'title' && <Title o={o} p={p} onPlay={() => setScreen({ name: 'map' })} onBook={() => setScreen({ name: 'book' })} onTyper={() => setScreen({ name: 'typer' })} onExit={ctx.exit} />}
      {screen.name === 'map' && <WorldMap p={p} o={o} onPick={(id) => setScreen({ name: 'lesson', id, run: Date.now() })} onBack={() => setScreen({ name: 'title' })} />}
      {screen.name === 'lesson' && (
        <LessonPlayer key={screen.run} lesson={lesson(screen.id)} steps={buildLesson(screen.id, p.seed)} o={o}
          onQuit={() => setScreen({ name: 'map' })} onComplete={(r) => complete(screen.id, r)} />
      )}
      {screen.name === 'finish' && (
        <Finished o={o} lesson={lesson(screen.id)} out={screen.out}
          onNext={() => setScreen({ name: 'lesson', id: screen.out.mastered ? p.current : screen.id, run: Date.now() })}
          onMap={() => setScreen({ name: 'map' })} />
      )}
      {screen.name === 'book' && <BuddyBook current={p.current} done={p.done} o={o} onBack={() => setScreen({ name: 'title' })} />}
      {screen.name === 'typer' && <Typewriter o={o} onBack={() => setScreen({ name: 'title' })} />}
    </div>
  );
}

// ---------------------------------------------------------------- title

function Title({ o, p, onPlay, onBook, onTyper, onExit }: { o: Opts; p: Prog; onPlay: () => void; onBook: () => void; onTyper: () => void; onExit: () => void }) {
  const totalStars = Object.values(p.stars).reduce((a, b) => a + b, 0);
  const rescued = LESSONS.filter((l) => l.sound && (p.done.includes(l.id) || l.id < p.current)).length;
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sfx('whoosh', o); onPlay(); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <div class="lr-title">
      <div class="lr-title-top"><button class="ghost" onClick={onExit}>← Home</button><span class="lr-count">⭐ {totalStars} · 🫧 {rescued} friends rescued</span></div>
      <h1 class="lr-logo">{'LETTER'.split('').map((c, i) => <span style={{ animationDelay: `${i * 0.08}s` }}>{c}</span>)}<br />{'RESCUE'.split('').map((c, i) => <span class="b" style={{ animationDelay: `${0.5 + i * 0.08}s` }}>{c}</span>)}</h1>
      <div class="lr-title-cast">
        <Tap size={120} wave={!o.calm} />
        <div class="lr-title-glitch"><Glitch size={130} /></div>
        <Tock size={120} wave={!o.calm} />
      </div>
      <div class="lr-title-btns">
        <button class="lr-play-btn" onClick={() => { sfx('whoosh', o); onPlay(); }}>▶ PLAY <small>(Enter)</small></button>
        <div class="row center">
          <button class="secondary" onClick={onBook}>📖 Buddy Book</button>
          <button class="secondary" onClick={onTyper}>⌨️ Talking Typewriter</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- map

const ISLAND_COLORS = ['#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#eab308'];

function WorldMap({ p, o, onPick, onBack }: { p: Prog; o: Opts; onPick: (id: number) => void; onBack: () => void }) {
  const units = [...new Set(LESSONS.map((l) => l.unit))];
  const next = LESSONS.find((l) => l.id === p.current)!;
  const rescued = LESSONS.filter((l) => l.sound && (p.done.includes(l.id) || l.id < p.current)).length;
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(p.current); } if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => { document.querySelector('.lr-stone.now')?.scrollIntoView({ block: 'center', behavior: o.calm ? 'auto' : 'smooth' }); }, []);
  return (
    <div class="lr-map">
      <div class="sk-head">
        <button class="ghost" onClick={onBack}>← Back</button>
        <h2>World map</h2>
        <span class="lr-count">⭐ {Object.values(p.stars).reduce((a, b) => a + b, 0)} · 🫧 {rescued} / {LESSONS.filter((l) => l.sound).length}</span>
      </div>
      <button class="sk-next lr-next" onClick={() => onPick(p.current)}>
        {next.sound ? <LetterBuddy letter={SOUNDS[next.sound].keys} color={buddyColor(next.sound)} size={84} trapped happy={false} /> : <Glitch size={84} />}
        <span class="lr-next-text">
          <span class="sk-next-label">{next.sound ? 'Next rescue' : next.kind === 'review' ? 'Boss level' : 'Next mission'}</span>
          <span class="sk-next-title">{next.sound ? <>Free <b style={{ color: buddyColor(next.sound) }}>{SOUNDS[next.sound].keys}</b> {SOUNDS[next.sound].emoji}</> : next.title}</span>
        </span>
        <span class="sk-next-go">GO ▶ <small class="muted">(Enter)</small></span>
      </button>
      <div class="lr-islands">
        {units.map((u, ui) => (
          <Island color={ISLAND_COLORS[ui % ISLAND_COLORS.length]} width={470}>
            <h3>{u}</h3>
            <div class="sk-path">
              {LESSONS.filter((l) => l.unit === u).map((l) => {
                const state = p.done.includes(l.id) || l.id < p.current ? 'done' : l.id === p.current ? 'now' : 'locked';
                const st = p.stars[String(l.id)] ?? 0;
                return (
                  <button class={'lr-stone ' + state} disabled={state === 'locked'} onClick={() => onPick(l.id)} title={l.title}>
                    {l.sound
                      ? <LetterBuddy letter={SOUNDS[l.sound].keys} color={state === 'locked' ? '#64748b' : buddyColor(l.sound)} size={54} trapped={state !== 'done'} happy={state === 'done'} />
                      : <span class="lr-boss-node">{l.kind === 'review' ? (state === 'done' ? '🏆' : '🌀') : 'Aa'}</span>}
                    <span class="lr-stars">{state === 'done' ? '★'.repeat(st) + '☆'.repeat(3 - st) : state === 'now' ? '▲' : ''}</span>
                  </button>
                );
              })}
            </div>
          </Island>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- finish

function Finished({ o, lesson, out, onNext, onMap }: { o: Opts; lesson: Lesson; out: Finish; onNext: () => void; onMap: () => void }) {
  const [shown, setShown] = useState(0);
  const u = lesson.sound ? SOUNDS[lesson.sound] : null;
  useEffect(() => {
    const timers: number[] = [];
    for (let i = 1; i <= out.stars; i++) timers.push(window.setTimeout(() => { setShown(i); sfx('star', o, i); }, 400 + i * 450));
    timers.push(window.setTimeout(() => {
      if (out.mastered) { sfx('win', o); confetti(o, undefined, 60); }
      speak(out.mastered ? (u ? `You rescued ${u.keys}! ${u.keys} is free!` : 'You did it!') : "Good work! We'll play this one again to make it stronger.", o);
    }, 500 + out.stars * 450));
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hush(); onNext(); } if (e.key === 'Escape') { hush(); onMap(); } };
    window.addEventListener('keydown', h);
    return () => { timers.forEach(clearTimeout); window.removeEventListener('keydown', h); };
  }, []);
  return (
    <div class="lr-finish">
      <div class="lr-finish-stars">{[1, 2, 3].map((i) => <span class={i <= shown ? 'on' : ''}>★</span>)}</div>
      {u && out.mastered && <div class="lr-finish-buddy"><LetterBuddy letter={u.keys} color={buddyColor(u.id)} size={150} happy /></div>}
      {!u && out.mastered && <div class="lr-duo"><Tap size={100} wave /><Tock size={100} wave /></div>}
      {!out.mastered && <div class="lr-duo"><Tap size={100} /><Glitch size={90} /></div>}
      <h2>{out.mastered ? (u ? `${u.keys.toUpperCase()} is free!` : `"${lesson.title}" complete!`) : 'Good work! Let’s play this one again.'}</h2>
      <div class="coins-earned">+{out.coins} 🪙</div>
      {out.pending && <p class="muted">Waiting for a parent to OK the coins.</p>}
      {out.capped && <p class="muted">That's all the coins for today — the practice still counts!</p>}
      <div class="row center">
        <button class="primary big" onClick={() => { hush(); onNext(); }}>{out.mastered ? 'Next mission ▶' : 'Try again ▶'} <small class="muted">(Enter)</small></button>
        <button class="ghost" onClick={() => { hush(); onMap(); }}>🗺️ Map</button>
      </div>
    </div>
  );
}
