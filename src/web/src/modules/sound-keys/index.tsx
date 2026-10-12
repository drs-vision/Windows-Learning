import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Activity, ModuleSettings, Progress } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { contentUrl } from '../../core/content-url';
import {
  FINGER_COLOR, FINGER_NAME, KEY_FINGER, LESSONS, SOUNDS, WORDS, buildLesson,
  type Finger, type Lesson, type Step, type StepKind,
} from './content';
import { scoreSoundKeys, DEFAULTS } from './score';

interface SKProgress extends Progress { lesson?: number; done?: number[]; seed?: number }

export const soundKeys: LessonModule = {
  id: 'sound-keys',
  title: 'Sound Keys',
  tagline: 'Learn a sound, a letter and a finger',
  description: 'A complete beginner course in reading sounds and touch typing together, 39 lessons. Each lesson teaches one sound, its letter, and the finger that types it, then uses it in real words and in typing from hearing. Calm and predictable: same steps every lesson, never timed, no buzzers, gentle hints. Verified automatically.',
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

function LessonMap({ current, done, o, onPick, onBack }: { current: number; done: number[]; o: Opts; onPick: (id: number) => void; onBack: () => void }) {
  const units = [...new Set(LESSONS.map((l) => l.unit))];
  const next = LESSONS.find((l) => l.id === current)!;
  return (
    <div class={'sk' + (o.calm ? ' calm' : '')}>
      <div class="sk-head">
        <button class="ghost" onClick={onBack}>← Back</button>
        <h2>Sound Keys</h2>
        <span class="muted">{done.length} of {LESSONS.length} lessons</span>
      </div>
      <button class="sk-next" onClick={() => onPick(current)}>
        <span class="sk-next-label">Next lesson</span>
        <span class="sk-next-title">{next.sound ? <><b style={{ color: FINGER_COLOR[KEY_FINGER[SOUNDS[next.sound].keys[0]]] }}>{next.sound}</b> {SOUNDS[next.sound].emoji}</> : next.title}</span>
        <span class="sk-next-go">Start ▶</span>
      </button>
      {units.map((u) => (
        <div class="sk-unit">
          <h3>{u}</h3>
          <div class="sk-path">
            {LESSONS.filter((l) => l.unit === u).map((l) => {
              const state = done.includes(l.id) ? 'done' : l.id === current ? 'now' : l.id < current ? 'done' : 'locked';
              const color = l.sound ? FINGER_COLOR[KEY_FINGER[SOUNDS[l.sound].keys[0]]] : undefined;
              return (
                <button class={'sk-stone ' + state} disabled={state === 'locked'} onClick={() => onPick(l.id)} title={l.title}>
                  <span class="sk-stone-letter" style={color ? { color } : {}}>{l.sound ?? (l.kind === 'review' ? '★' : 'Aa')}</span>
                  {state === 'done' && <span class="sk-check">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the lesson

const STEP_INFO: Record<StepKind, { icon: string; name: string; tell: string }> = {
  meet: { icon: '👋', name: 'Meet', tell: 'Listen to the sound. Press the key 3 times.' },
  keys: { icon: '⌨️', name: 'Keys', tell: 'Press the key you see.' },
  listen: { icon: '👂', name: 'Listen', tell: 'Listen. Press the key that makes that sound.' },
  words: { icon: '📖', name: 'Words', tell: 'Type the word. Each letter makes its sound.' },
  spell: { icon: '✏️', name: 'Spell', tell: 'Listen to the word. Type it.' },
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
      <p class="sk-tell">{STEP_INFO[step.kind].tell}</p>
      <ItemPlayer key={`${stepIdx}-${itemIdx}`} kind={step.kind} target={item} lesson={lesson} o={o} onDone={next} />
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
  return (
    <div class={'sk' + (o.calm ? ' calm' : '')}>
      <div class="sk-head"><button class="ghost" onClick={onQuit}>← Map</button><h2>{lesson.title}</h2><span /></div>
      <div class="sk-intro">
        {unit && (
          <div class="sk-meet-card" style={{ borderColor: FINGER_COLOR[finger!] }}>
            <div class="sk-big-letter" style={{ color: FINGER_COLOR[finger!] }}>{unit.keys}</div>
            <div class="sk-keyword">{unit.emoji} {unit.keyword}</div>
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

function ItemPlayer({ kind, target, lesson, o, onDone }: { kind: StepKind; target: string; lesson: Lesson; o: Opts; onDone: (firstTry: boolean) => void }) {
  const [pos, setPos] = useState(0);
  const [missed, setMissed] = useState(false);
  const [hint, setHint] = useState(kind === 'meet' || kind === 'keys' || kind === 'words' || kind === 'sentence');
  const [wrongKey, setWrongKey] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const ends = useMemo(() => unitEnds(target), [target]);
  const hidden = kind === 'listen' || kind === 'spell';
  const unitId = kind === 'listen' || kind === 'meet' || kind === 'keys' ? (SOUNDS[target] ? target : null) : null;

  // Say what to type when the item appears.
  const announce = () => {
    if (kind === 'listen' && unitId) return playSound(unitId, o);
    if (kind === 'spell') return speak(target, o);
    if (kind === 'meet' && unitId) return playSound(unitId, o);
    return Promise.resolve();
  };
  useEffect(() => { announce(); }, []);

  // Timed hint for listen/spell (never a timer the child has to beat — it only ever helps).
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
        if (u && (kind === 'words' || kind === 'spell' || kind === 'keys' || kind === 'meet')) playSound(u, o);
        if (pos + 1 >= target.length) {
          setFinished(true);
          const finish = () => onDone(!missed);
          if (kind === 'words' || kind === 'spell') speak(target, o).then(() => setTimeout(finish, 250));
          else if (kind === 'sentence') setTimeout(finish, 350);
          else setTimeout(finish, kind === 'meet' ? 500 : 250);
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
  const picture = kind === 'words' || kind === 'spell' ? pictureFor(target) : kind === 'listen' && hint && unitId ? SOUNDS[unitId].emoji : '';

  return (
    <div class="sk-item">
      <div class="sk-stage">
        {picture && <div class="sk-picture">{picture}</div>}
        {kind === 'listen' || kind === 'spell'
          ? <button class="sk-hear" onClick={announce} title="Hear it again (Enter)">🔊</button>
          : null}
        <div class={'sk-target' + (target.length > 3 ? ' long' : '')}>
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
  useEffect(() => { speak(repeat ? 'Good work. We will practise this one again.' : 'You did it!', o); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter') onDone(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <div class={'sk' + (o.calm ? ' calm' : '')}>
      <div class="activity-result">
        <div class="coins-earned">{outcome.coins} 🪙</div>
        <h2>{repeat ? 'Good work. Next time we practise this again.' : `You finished "${lesson.title}"`}</h2>
        <p class="muted">{outcome.detail}</p>
        <button class="primary big" onClick={onDone}>Done <span class="muted small">(Enter)</span></button>
      </div>
    </div>
  );
}
