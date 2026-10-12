import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Activity, ModuleSettings, Progress } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { contentUrl } from '../../core/content-url';
import {
  FINGER_COLOR, FINGER_NAME, KEY_FINGER, LESSONS, SOUNDS, WORDS, buildLesson, rng, scramble,
  type Finger, type Lesson, type Step, type StepKind,
} from './content';
import { Glitch, Island, LetterBuddy, Tap, Tock } from './art';
import { scoreSoundKeys, DEFAULTS } from './score';

interface SKProgress extends Progress { lesson?: number; done?: number[]; seed?: number }

export const soundKeys: LessonModule = {
  id: 'sound-keys',
  title: 'Letter Rescue',
  tagline: 'Free the letters from Glitch — learn sounds and typing',
  description: 'A complete beginner reading-and-typing adventure in 39 lessons. Glitch has trapped the letters; each lesson rescues one by learning its sound, its key and the finger that types it, then using it in balloon pops, real words, listening games and short phrases. Guided by Tap (left hand) and Tock (right hand). Calm and predictable: same steps every lesson, never timed, no buzzers, gentle hints. Verified automatically.',
  icon: '🔤',
  verification: 'in_app',
  defaults: DEFAULTS,
  options: [
    { key: 'calm', label: 'Motion', help: 'Calm turns off pulsing and bouncing.', choices: [['on', 'Calm (no motion)'], ['off', 'Lively']], default: 'on' },
    { key: 'sound', label: 'Sounds and voice', choices: [['on', 'On'], ['off', 'Off']], default: 'on' },
    { key: 'voice', label: 'Voice speed', choices: [['slow', 'Slow'], ['normal', 'Normal']], default: 'slow' },
    { key: 'hint', label: 'When listening or spelling, show a hint after', help: 'A wrong key always shows the hint right away.', choices: [['2', '2 seconds'], ['5', '5 seconds'], ['10', '10 seconds'], ['never', 'Only when asked']], default: '5' },
  ],

  nextActivity(progress: SKProgress): Activity {
    const lesson = progress.lesson ?? 1;
    return { moduleId: 'sound-keys', kind: 'lesson', data: { lessonId: lesson, current: lesson, seed: progress.seed ?? 0, done: progress.done ?? [] }, issuedAt: 0 };
  },

  mount(el, activity, ctx) {
    render(<SoundKeys activity={activity} ctx={ctx} />, el);
    return () => { try { speechSynthesis.cancel(); } catch { } render(null, el); };
  },

  score: scoreSoundKeys,
};

// ---------------------------------------------------------------- audio

function opts(s: ModuleSettings) {
  const o = s.options ?? {};
  return {
    calm: (o.calm ?? 'on') === 'on',
    sound: (o.sound ?? 'on') === 'on',
    rate: (o.voice ?? 'slow') === 'slow' ? 0.8 : 1,
    hintMs: (o.hint ?? '5') === 'never' ? Infinity : Number(o.hint ?? '5') * 1000,
  };
}
type Opts = ReturnType<typeof opts>;

const clipCache = new Map<string, HTMLAudioElement>();
function playSound(id: string, o: Opts): Promise<void> {
  if (!o.sound) return Promise.resolve();
  const unit = SOUNDS[id];
  const file = unit?.audio ?? id;
  let a = clipCache.get(file);
  if (!a) { a = new Audio(contentUrl(`sounds/phonemes/${file}.mp3`)); clipCache.set(file, a); }
  a.currentTime = 0;
  return new Promise((res) => { a!.onended = () => res(); a!.play().catch(() => res()); setTimeout(res, 1500); });
}
function speak(text: string, o: Opts): Promise<void> {
  if (!o.sound || typeof speechSynthesis === 'undefined') return Promise.resolve();
  return new Promise((res) => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = o.rate; u.lang = 'en-US';
      const v = speechSynthesis.getVoices().find((v) => v.lang.startsWith('en-US'));
      if (v) u.voice = v;
      u.onend = () => res(); u.onerror = () => res();
      speechSynthesis.speak(u);
      setTimeout(res, 4000);
    } catch { res(); }
  });
}
/** Small, soft synthesized effects (no files). Quiet on purpose. */
let actx: AudioContext | null = null;
function sfx(kind: 'pop' | 'chime' | 'charge' | 'free', o: Opts, n = 0) {
  if (!o.sound) return;
  try {
    actx ??= new AudioContext();
    const t = actx.currentTime;
    const note = (freq: number, at: number, dur: number, type: OscillatorType = 'sine', to?: number) => {
      const osc = actx!.createOscillator(); const g = actx!.createGain();
      osc.type = type; osc.frequency.setValueAtTime(freq, t + at);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, t + at + dur);
      g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.07, t + at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      osc.connect(g).connect(actx!.destination); osc.start(t + at); osc.stop(t + at + dur + 0.02);
    };
    if (kind === 'pop') note(700, 0, 0.12, 'triangle', 220);
    if (kind === 'charge') note(330 + n * 70, 0, 0.18, 'triangle');
    if (kind === 'chime') { note(660, 0, 0.25); note(990, 0.1, 0.3); }
    if (kind === 'free') { note(523, 0, 0.2); note(659, 0.12, 0.2); note(784, 0.24, 0.35); }
  } catch { /* audio not available */ }
}

/** Tap guides the left hand, Tock the right. */
function Guide({ ch, text, talking = true }: { ch: string; text: string; talking?: boolean }) {
  const f = KEY_FINGER[(ch ?? '').toLowerCase()];
  const right = f?.startsWith('R');
  return (
    <div class={'sk-guide' + (right ? ' right' : '')}>
      {right ? <Tock size={78} talking={talking} /> : <Tap size={78} talking={talking} />}
      <div class="sk-say">{text}</div>
    </div>
  );
}

const buddyColor = (id: string | undefined) => (id && SOUNDS[id] ? FINGER_COLOR[KEY_FINGER[SOUNDS[id].keys[0]]] : '#fde047');

/** Split a word into sound units so typing "ship" plays /sh/ /i/ /p/, not /s/ /h/ /i/ /p/. Returns the unit that ENDS at each index (or null). */
function unitEnds(word: string): (string | null)[] {
  const out: (string | null)[] = Array(word.length).fill(null);
  const w = word.toLowerCase();
  for (let i = 0; i < w.length;) {
    const two = w.slice(i, i + 2);
    if (['sh', 'ch', 'th', 'ng', 'ck'].includes(two)) { out[i + 1] = two; i += 2; }
    else { out[i] = SOUNDS[w[i]] ? w[i] : null; i += 1; }
  }
  return out;
}
const pictureFor = (word: string) => WORDS.find(([w]) => w === word.toLowerCase())?.[1] ?? '';

// ---------------------------------------------------------------- top level: map → lesson → done

function SoundKeys({ activity, ctx }: { activity: Activity; ctx: ActivityContext }) {
  const o = useMemo(() => opts(ctx.settings), [ctx.settings]);
  const current = Number(activity.data.lessonId);
  const done = (activity.data.done as number[]) ?? [];
  const seed = Number(activity.data.seed ?? 0);
  const [lessonId, setLessonId] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<{ coins: number; detail: string } | null>(null);
  const [error, setError] = useState('');

  if (outcome) return <Finished o={o} outcome={outcome} lesson={LESSONS.find((l) => l.id === lessonId)!} onDone={ctx.exit} />;
  if (lessonId === null) return <LessonMap current={current} done={done} o={o} onPick={setLessonId} onBack={ctx.exit} />;

  const act: Activity = { ...activity, data: { ...activity.data, lessonId, current, seed } };
  return (
    <LessonPlayer
      key={lessonId}
      lesson={LESSONS.find((l) => l.id === lessonId)!}
      steps={buildLesson(lessonId, seed)}
      o={o}
      error={error}
      onQuit={() => setLessonId(null)}
      onComplete={async (typed, firstTry, startedAt) => {
        try { setOutcome(await ctx.submit({ startedAt, finishedAt: Date.now(), data: { typed, firstTry } }, act)); }
        catch (e) { setError((e as Error).message); }
      }}
    />
  );
}

const ISLAND_COLORS = ['#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#eab308'];

function LessonMap({ current, done, o, onPick, onBack }: { current: number; done: number[]; o: Opts; onPick: (id: number) => void; onBack: () => void }) {
  const units = [...new Set(LESSONS.map((l) => l.unit))];
  const next = LESSONS.find((l) => l.id === current)!;
  const rescued = LESSONS.filter((l) => l.sound && (done.includes(l.id) || l.id < current)).length;
  const totalLetters = LESSONS.filter((l) => l.sound).length;
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter') onPick(current); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <div class={'sk lr' + (o.calm ? ' calm' : '')}>
      <div class="sk-head">
        <button class="ghost" onClick={onBack}>← Back</button>
        <h2>Letter Rescue</h2>
        <span class="lr-count">🫧 {rescued} / {totalLetters} letters rescued</span>
      </div>
      <button class="sk-next lr-next" onClick={() => onPick(current)}>
        {next.sound ? <LetterBuddy letter={SOUNDS[next.sound].keys} color={buddyColor(next.sound)} size={84} trapped happy={false} /> : <Glitch size={84} />}
        <span class="lr-next-text">
          <span class="sk-next-label">{next.sound ? 'Next rescue' : next.kind === 'review' ? 'Boss level' : 'Next mission'}</span>
          <span class="sk-next-title">{next.sound ? <>Free <b style={{ color: buddyColor(next.sound) }}>{SOUNDS[next.sound].keys}</b> {SOUNDS[next.sound].emoji}</> : next.title}</span>
        </span>
        <span class="sk-next-go">Go ▶ <small class="muted">(Enter)</small></span>
      </button>
      <div class="lr-islands">
        {units.map((u, ui) => (
          <Island color={ISLAND_COLORS[ui % ISLAND_COLORS.length]} width={460}>
            <h3>{u}</h3>
            <div class="sk-path">
              {LESSONS.filter((l) => l.unit === u).map((l) => {
                const state = done.includes(l.id) ? 'done' : l.id === current ? 'now' : l.id < current ? 'done' : 'locked';
                return (
                  <button class={'lr-stone ' + state} disabled={state === 'locked'} onClick={() => onPick(l.id)} title={l.title}>
                    {l.sound
                      ? <LetterBuddy letter={SOUNDS[l.sound].keys} color={state === 'locked' ? '#64748b' : buddyColor(l.sound)} size={54} trapped={state !== 'done'} happy={state === 'done'} />
                      : <span class="lr-boss">{l.kind === 'review' ? (state === 'done' ? '🏆' : '🌀') : 'Aa'}</span>}
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

// ---------------------------------------------------------------- the lesson

const STEP_INFO: Record<StepKind, { icon: string; name: string; tell: string }> = {
  meet: { icon: '⚡', name: 'Charge the key', tell: 'Press the glowing key to charge it up!' },
  keys: { icon: '⌨️', name: 'Keys', tell: 'Press the key you see.' },
  listen: { icon: '👂', name: 'Sound echo', tell: 'Listen. Which key makes that sound?' },
  blaster: { icon: '🎈', name: 'Balloon pop', tell: 'Pop the lowest balloon by pressing its letter.' },
  words: { icon: '🧱', name: 'Build words', tell: 'Type the word. Each letter says its sound.' },
  spell: { icon: '✏️', name: 'Word echo', tell: 'Listen to the word. Type it.' },
  read: { icon: '📖', name: 'Read & type', tell: 'Read it, then type it. Space is your thumb.' },
  boss: { icon: '🌀', name: "Glitch's scramble", tell: 'Glitch mixed up the letters! Type the real word.' },
  sentence: { icon: '📝', name: 'Sentences', tell: 'Type it exactly. Hold Shift for a capital letter.' },
};

function LessonPlayer({ lesson, steps, o, error, onQuit, onComplete }: {
  lesson: Lesson; steps: Step[]; o: Opts; error: string;
  onQuit: () => void; onComplete: (typed: string[], firstTry: boolean[], startedAt: number) => void;
}) {
  const [stepIdx, setStepIdx] = useState(-1); // -1 = the lesson's "what will happen" screen
  const [itemIdx, setItemIdx] = useState(0);
  const results = useRef<{ typed: string[]; firstTry: boolean[] }>({ typed: [], firstTry: [] });
  const startedAt = useRef(Date.now());

  if (stepIdx === -1) return <LessonIntro lesson={lesson} steps={steps} o={o} onStart={() => { startedAt.current = Date.now(); setStepIdx(0); }} onQuit={onQuit} />;

  const step = steps[stepIdx];
  const item = step.items[itemIdx];

  function next(firstTry: boolean) {
    results.current.typed.push(item);
    results.current.firstTry.push(firstTry);
    if (itemIdx + 1 < step.items.length) setItemIdx(itemIdx + 1);
    else if (stepIdx + 1 < steps.length) { setStepIdx(stepIdx + 1); setItemIdx(0); }
    else onComplete(results.current.typed, results.current.firstTry, startedAt.current);
  }

  return (
    <div class={'sk' + (o.calm ? ' calm' : '')}>
      <Schedule steps={steps} stepIdx={stepIdx} itemIdx={itemIdx} onQuit={onQuit} />
      <Guide ch={item[0]} text={STEP_INFO[step.kind].tell} talking={itemIdx === 0} />
      <ItemPlayer key={`${stepIdx}-${itemIdx}`} kind={step.kind} target={item} items={step.items} itemIdx={itemIdx} lesson={lesson} o={o} onDone={next} />
      {error && <p class="error">{error}</p>}
    </div>
  );
}

function LessonIntro({ lesson, steps, o, onStart, onQuit }: { lesson: Lesson; steps: Step[]; o: Opts; onStart: () => void; onQuit: () => void }) {
  const unit = lesson.sound ? SOUNDS[lesson.sound] : null;
  const finger = unit ? KEY_FINGER[unit.keys[0]] : null;
  useEffect(() => { if (unit) { playSound(unit.id, o).then(() => speak(unit.say, o)); } }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter') onStart(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  const story = unit
    ? `Glitch trapped the letter ${unit.keys.toUpperCase()}! Learn its sound and its key to set it free.`
    : lesson.kind === 'review' ? 'Glitch is back with a whole wave of scrambled letters. Show what you know!'
    : 'Big letters and full sentences — the final missions.';
  return (
    <div class={'sk lr' + (o.calm ? ' calm' : '')}>
      <div class="sk-head"><button class="ghost" onClick={onQuit}>← Map</button><h2>{lesson.title}</h2><span /></div>
      <div class="lr-story">
        <Glitch size={90} />
        <p>{story}</p>
        {unit && <LetterBuddy letter={unit.keys} color={FINGER_COLOR[finger!]} size={90} trapped happy={false} />}
      </div>
      <div class="sk-intro">
        {unit && (
          <div class="sk-meet-card" style={{ borderColor: FINGER_COLOR[finger!] }}>
            <div class="sk-big-letter" style={{ color: FINGER_COLOR[finger!] }}>{unit.keys}</div>
            <div class="sk-keyword">{unit.emoji} {unit.keyword}</div>
            <p class="sk-finger" style={{ color: FINGER_COLOR[finger!] }}>Your {FINGER_NAME[finger!]} types it.</p>
            <button class="secondary" onClick={() => playSound(unit.id, o).then(() => speak(unit.say, o))}>🔊 Hear it</button>
          </div>
        )}
        <div class="sk-plan">
          <h3>What we will do</h3>
          <ol>{steps.map((s) => <li><span class="sk-plan-icon">{STEP_INFO[s.kind].icon}</span> {STEP_INFO[s.kind].name} <span class="muted">· {s.items.length}</span></li>)}</ol>
          <p class="muted">Take your time. There is no clock.</p>
        </div>
      </div>
      <div class="sk-actions"><button class="primary big" onClick={onStart}>Start <span class="muted small">(Enter)</span></button></div>
    </div>
  );
}

function Schedule({ steps, stepIdx, itemIdx, onQuit }: { steps: Step[]; stepIdx: number; itemIdx: number; onQuit: () => void }) {
  const total = steps.reduce((n, s) => n + s.items.length, 0);
  const doneCount = steps.slice(0, stepIdx).reduce((n, s) => n + s.items.length, 0) + itemIdx;
  return (
    <div class="sk-schedule">
      <button class="ghost small" onClick={onQuit}>Stop</button>
      <ol class="sk-steps">
        {steps.map((s, i) => <li class={i < stepIdx ? 'done' : i === stepIdx ? 'now' : ''}><span>{STEP_INFO[s.kind].icon}</span> {STEP_INFO[s.kind].name}</li>)}
      </ol>
      <div class="sk-bar"><div style={{ width: `${(doneCount / total) * 100}%` }} /></div>
      <span class="muted small">{steps[stepIdx].items.length - itemIdx} left in {STEP_INFO[steps[stepIdx].kind].name}</span>
    </div>
  );
}

// ---------------------------------------------------------------- one item: the heart of it

function ItemPlayer({ kind, target, items, itemIdx, lesson, o, onDone }: {
  kind: StepKind; target: string; items: string[]; itemIdx: number; lesson: Lesson; o: Opts; onDone: (firstTry: boolean) => void;
}) {
  const [pos, setPos] = useState(0);
  const [missed, setMissed] = useState(false);
  const [hint, setHint] = useState(kind === 'meet' || kind === 'keys' || kind === 'words' || kind === 'sentence' || kind === 'read' || kind === 'blaster');
  const [wrongKey, setWrongKey] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const ends = useMemo(() => unitEnds(target), [target]);
  const hidden = kind === 'listen' || kind === 'spell' || kind === 'boss';
  const unitId = kind === 'listen' || kind === 'meet' || kind === 'keys' || kind === 'blaster' ? (SOUNDS[target] ? target : null) : null;
  const mixed = useMemo(() => (kind === 'boss' ? scramble(target, rng(target.length * 131 + itemIdx)) : ''), [target]);

  // Say what to type when the item appears.
  const announce = () => {
    if ((kind === 'listen' || kind === 'meet') && unitId) return playSound(unitId, o);
    if (kind === 'spell' || kind === 'boss') return speak(target, o);
    return Promise.resolve();
  };
  useEffect(() => { announce(); }, []);

  // Timed hint for hidden items (never a timer the child has to beat — it only ever helps).
  useEffect(() => {
    if (hint || !hidden || !isFinite(o.hintMs)) return;
    const t = setTimeout(() => setHint(true), o.hintMs);
    return () => clearTimeout(t);
  }, [hint, pos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (finished || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Shift' || e.key === 'CapsLock' || e.key === 'Tab') return;
      if (e.key === 'Enter' && hidden) { announce(); return; }
      if (e.key.length !== 1) return;
      e.preventDefault();
      const want = target[pos];
      if (e.key === want) {
        setWrongKey(null);
        const u = ends[pos];
        if (kind === 'meet') sfx('charge', o, itemIdx);
        else if (u && kind !== 'sentence' && kind !== 'listen') playSound(u, o);
        if (pos + 1 >= target.length) {
          setFinished(true);
          const finish = () => onDone(!missed);
          if (kind === 'blaster') { sfx('pop', o); setTimeout(finish, 280); }
          else if (kind === 'meet' && itemIdx === items.length - 1) { sfx('free', o); setTimeout(finish, 900); }
          else if (kind === 'words' || kind === 'spell' || kind === 'boss' || kind === 'read') { sfx('chime', o); speak(target, o).then(() => setTimeout(finish, 250)); }
          else if (kind === 'sentence') setTimeout(finish, 350);
          else setTimeout(finish, kind === 'meet' ? 450 : 250);
        }
        setPos(pos + 1);
      } else {
        // Errorless: nothing bad happens. The right key lights up and the finger is named.
        setMissed(true);
        setHint(true);
        setWrongKey(e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pos, missed, finished, target]);

  const want = target[pos] ?? '';
  const finger = KEY_FINGER[want.toLowerCase()];
  const picture = kind === 'words' || kind === 'spell' || kind === 'boss' ? pictureFor(target)
    : kind === 'read' ? target.split(' ').map(pictureFor).filter(Boolean).join(' ')
    : kind === 'listen' && hint && unitId ? SOUNDS[unitId].emoji : '';

  const letters = (
    <div class={'sk-target' + (target.length > 3 ? ' long' : '') + (target.length > 12 ? ' phrase' : '')}>
      {[...target].map((ch, i) => {
        const show = !hidden || i < pos || (hint && i === pos);
        const f = KEY_FINGER[ch.toLowerCase()];
        return (
          <span class={'sk-ch' + (i < pos ? ' typed' : i === pos ? ' cur' : '') + (show ? '' : ' blank') + (ch === ' ' ? ' space' : '')}
            style={i === pos && show && f ? { color: FINGER_COLOR[f], borderColor: FINGER_COLOR[f] } : {}}>
            {show ? (ch === ' ' ? '␣' : ch) : '_'}
          </span>
        );
      })}
    </div>
  );

  return (
    <div class="sk-item">
      <div class="sk-stage">
        {kind === 'meet' && (
          <div class="lr-charge">
            <LetterBuddy letter={target} color={FINGER_COLOR[finger] ?? '#fde047'} size={110} trapped={!(finished && itemIdx === items.length - 1)} happy={finished && itemIdx === items.length - 1} />
            <div class="lr-meter">{items.map((_, i) => <span class={i < itemIdx || (i === itemIdx && finished) ? 'on' : ''} style={{ '--fc': FINGER_COLOR[finger] } as any} />)}</div>
            {finished && itemIdx === items.length - 1 && <p class="lr-freed">Free! 🎉</p>}
          </div>
        )}
        {kind === 'blaster' && (
          <div class="lr-balloons">
            {items.slice(itemIdx, itemIdx + 6).map((k, i) => (
              <div class={'lr-balloon' + (i === 0 ? ' cur' : '') + (i === 0 && finished ? ' popped' : '')} style={{ '--fc': FINGER_COLOR[KEY_FINGER[k[0]]], '--i': i, left: `calc(50% - 38px + ${i === 0 ? 0 : (i % 2 ? 1 : -1) * (60 + i * 18)}px)`, bottom: `${i * 22}px`, zIndex: 10 - i } as any}>
                <span>{k}</span>
              </div>
            ))}
            <div class="lr-left muted small">{items.length - itemIdx - (finished ? 1 : 0)} balloons left</div>
          </div>
        )}
        {kind === 'boss' && (
          <div class="lr-boss-row">
            <Glitch size={70} mood={finished ? 'oops' : 'sly'} />
            <div class="lr-tiles">{[...mixed].map((c) => <span class="lr-tile">{c}</span>)}</div>
          </div>
        )}
        {picture && <div class={'sk-picture' + (kind === 'read' ? ' small' : '')}>{picture}</div>}
        {hidden && <button class="sk-hear" onClick={announce} title="Hear it again (Enter)">🔊</button>}
        {kind !== 'blaster' && kind !== 'meet' && letters}
        {kind === 'listen' && !hint && <p class="muted">Not sure? Wait a moment, or press 🔊 to hear it again.</p>}
        {wrongKey && <p class="sk-gentle">That was <b>{wrongKey === ' ' ? 'space' : wrongKey}</b>. Look for the glowing key.</p>}
        {hint && want && finger && <p class="sk-finger" style={{ color: FINGER_COLOR[finger] }}>Use your {FINGER_NAME[finger]}{want !== want.toLowerCase() ? ' — and hold Shift with your other pinky' : ''}.</p>}
        {!hint && hidden && <button class="ghost small" onClick={() => { setHint(true); setMissed(true); }}>Show me</button>}
      </div>
      <FingerKeyboard target={hint ? want : ''} known={lesson.known} />
      <Hands finger={hint ? finger ?? null : null} />
    </div>
  );
}

// ---------------------------------------------------------------- keyboard + hands

const ROWS: string[] = ['qwertyuiop', 'asdfghjkl;', 'zxcvbnm,./'];

export function FingerKeyboard({ target, known }: { target: string; known: string[] }) {
  const knownKeys = new Set(known.flatMap((s) => [...SOUNDS[s].keys]));
  const t = target.toLowerCase();
  const needShift = target !== '' && target !== t;
  return (
    <div class="fk">
      {ROWS.map((row, ri) => (
        <div class="fk-row" style={{ marginLeft: `${[0, 18, 46][ri]}px` }}>
          {[...row].map((k) => {
            const f = KEY_FINGER[k] as Finger;
            const isKnown = knownKeys.has(k);
            return (
              <span class={'fk-key' + (k === t ? ' target' : '') + (isKnown ? ' known' : '') + (k === 'f' || k === 'j' ? ' bump' : '')}
                style={{ '--fc': FINGER_COLOR[f] } as any}>{k}</span>
            );
          })}
        </div>
      ))}
      <div class="fk-row">
        <span class={'fk-key shift' + (needShift && KEY_FINGER[t]?.startsWith('R') ? ' target' : '')} style={{ '--fc': FINGER_COLOR.L5 } as any}>shift</span>
        <span class={'fk-key space' + (t === ' ' ? ' target' : '')} style={{ '--fc': FINGER_COLOR.T } as any}>space</span>
        <span class={'fk-key shift' + (needShift && KEY_FINGER[t]?.startsWith('L') ? ' target' : '')} style={{ '--fc': FINGER_COLOR.R5 } as any}>shift</span>
      </div>
    </div>
  );
}

/** Two simple hands. The finger to use is lifted and bright; the rest are dim. */
export function Hands({ finger }: { finger: Finger | null }) {
  const left: Finger[] = ['L5', 'L4', 'L3', 'L2'];
  const right: Finger[] = ['R2', 'R3', 'R4', 'R5'];
  const heights = [44, 56, 62, 54];
  const hand = (fs: Finger[], mirror: boolean) => (
    <svg viewBox="0 0 140 120" class="hand" style={mirror ? { transform: 'scaleX(-1)' } : {}}>
      {fs.map((f, i) => {
        const h = heights[mirror ? 3 - i : i];
        const active = finger === f;
        return <rect x={8 + i * 26} y={(active ? 2 : 14) + (62 - h)} width={22} height={h} rx={11}
          fill={FINGER_COLOR[f]} opacity={finger && !active ? 0.25 : 0.9} />;
      })}
      <rect x={4} y={72} width={110} height={44} rx={18} fill="#cbd5e1" opacity={0.35} />
      <rect x={104} y={60} width={20} height={44} rx={10} transform="rotate(35 114 82)" fill={FINGER_COLOR.T} opacity={finger === 'T' ? 0.9 : 0.25} />
    </svg>
  );
  return <div class="hands">{hand(left, false)}{hand(right, true)}</div>;
}

// ---------------------------------------------------------------- finish

function Finished({ outcome, lesson, o, onDone }: { outcome: { coins: number; detail: string }; lesson: Lesson; o: Opts; onDone: () => void }) {
  const repeat = outcome.detail.includes('practise again');
  useEffect(() => { if (!repeat) sfx('free', o); speak(repeat ? 'Good work. We will practise this one again.' : lesson.sound ? `You rescued ${SOUNDS[lesson.sound].keys}!` : 'You did it!', o); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter') onDone(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <div class={'sk' + (o.calm ? ' calm' : '')}>
      <div class="activity-result">
        {lesson.sound && !repeat && <LetterBuddy letter={SOUNDS[lesson.sound].keys} color={buddyColor(lesson.sound)} size={130} happy />}
        {!lesson.sound && !repeat && <div class="lr-duo"><Tap size={90} wave /><Tock size={90} wave /></div>}
        <div class="coins-earned">{outcome.coins} 🪙</div>
        <h2>{repeat ? 'Good work. Next time we practise this again.' : lesson.sound ? `You rescued ${SOUNDS[lesson.sound].keys.toUpperCase()}!` : `You beat "${lesson.title}"!`}</h2>
        <p class="muted">{outcome.detail}</p>
        <button class="primary big" onClick={onDone}>Done <span class="muted small">(Enter)</span></button>
      </div>
    </div>
  );
}
