// Letter Rescue — one lesson: story → mission plan → mini-games (each a skin over the same calm typing core).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FINGER_COLOR, FINGER_NAME, KEY_FINGER, LESSONS, SOUNDS, WORDS, rng, scramble, type Lesson, type Step, type StepKind } from './content';
import { Glitch, LetterBuddy, Tap, Tock } from './art';
import { centerOf, confetti, hush, playSound, sfx, speak, type Opts } from './fx';
import { FingerKeyboard, Hands } from './extras';

export const STEP_INFO: Record<StepKind, { icon: string; name: string; tell: string }> = {
  meet: { icon: '⚡', name: 'Charge the key', tell: 'Press the glowing key to charge it up!' },
  home: { icon: '🏠', name: 'Home base', tell: 'Feel the bumps on F and J. Left pointer on F, right pointer on J.' },
  keys: { icon: '⌨️', name: 'Keys', tell: 'Press the key you see.' },
  listen: { icon: '👂', name: 'Echo cave', tell: 'Listen. Which key makes that sound?' },
  blaster: { icon: '🎈', name: 'Balloon pop', tell: 'Pop the lowest balloon. Press its letter!' },
  words: { icon: '🌉', name: 'Word bridge', tell: 'Type the word to build the bridge.' },
  spell: { icon: '🎁', name: 'Mystery box', tell: 'Listen to the word, then type it to open the box.' },
  read: { icon: '📜', name: 'Secret message', tell: 'Read the message and type it. Space is your thumb.' },
  boss: { icon: '🌀', name: 'Glitch battle', tell: 'Glitch scrambled the letters! Type the real word to zap him.' },
  sentence: { icon: '✈️', name: 'Sky writer', tell: 'Type it exactly. Hold Shift for a big letter.' },
};

const pictureFor = (word: string) => WORDS.find(([w]) => w === word.toLowerCase())?.[1] ?? '';
export const buddyColor = (id: string | undefined) => (id && SOUNDS[id] ? FINGER_COLOR[KEY_FINGER[SOUNDS[id].keys[0]]] : '#fde047');

/** Split into sound units so typing "ship" plays /sh/ /i/ /p/. Returns the unit that ENDS at each index. */
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

// ---------------------------------------------------------------- story

type Who = 'tap' | 'tock' | 'glitch' | 'buddy';
interface Line { who: Who; text: string; sound?: string }

function storyFor(lesson: Lesson): Line[] {
  const u = lesson.sound ? SOUNDS[lesson.sound] : null;
  const guide: Who = u && KEY_FINGER[u.keys[0]]?.startsWith('R') ? 'tock' : 'tap';
  if (lesson.id === 1) return [
    { who: 'tap', text: "Hi! I'm Tap. I help your left hand." },
    { who: 'tock', text: "And I'm Tock! I help your right hand." },
    { who: 'glitch', text: 'Bzzzt! I am Glitch! I zapped every letter into a bubble. Hee hee!' },
    { who: 'tap', text: "Oh no! Let's rescue them, one letter at a time. First: F!" },
    { who: 'buddy', text: 'F says...', sound: 'f' },
    { who: 'tap', text: `F, like fish. Your left pointer finger types it.` },
  ];
  if (u) {
    const team = u.keys.length > 1;
    return [
      { who: 'glitch', text: team ? `Bzzzt! I stuck ${u.keys[0].toUpperCase()} and ${u.keys[1].toUpperCase()} together in one bubble!` : `Bzzzt! I trapped the letter ${u.keys.toUpperCase()}!` },
      { who: 'buddy', text: team ? `Together they say...` : `${u.keys.toUpperCase()} says...`, sound: u.id },
      { who: guide, text: `${u.say}. Your ${FINGER_NAME[KEY_FINGER[u.keys[0]]]} types it. Let's get ${team ? 'them' : 'it'} out!` },
    ];
  }
  if (lesson.kind === 'review') return [
    { who: 'glitch', text: 'You think you know your letters? Try my SCRAMBLE WAVE! Bzzzt!' },
    { who: 'tap', text: 'Pop his balloons and fix his words.' },
    { who: 'tock', text: "We've got your back. Let's go!" },
  ];
  if (lesson.id === LESSONS[LESSONS.length - 1].id) return [
    { who: 'tock', text: 'The last mission! Write real sentences in the sky.' },
    { who: 'tap', text: 'Start with a big letter. End with a dot.' },
  ];
  return [
    { who: 'tock', text: 'Big letters! Hold Shift with one pinky...' },
    { who: 'tap', text: '...and press the letter with the other hand. Names start with big letters!' },
  ];
}

function Speaker({ who, line, talking, o }: { who: Who; line: Line; talking: boolean; o: Opts }) {
  const u = line.sound ? SOUNDS[line.sound] : null;
  return (
    <div class={'lr-speaker ' + who}>
      {who === 'tap' && <Tap size={130} talking={talking} wave={talking && !o.calm} />}
      {who === 'tock' && <Tock size={130} talking={talking} wave={talking && !o.calm} />}
      {who === 'glitch' && <Glitch size={140} />}
      {who === 'buddy' && u && <LetterBuddy letter={u.keys} color={buddyColor(u.id)} size={130} trapped happy={false} />}
    </div>
  );
}

function Story({ lesson, steps, o, onStart, onQuit }: { lesson: Lesson; steps: Step[]; o: Opts; onStart: () => void; onQuit: () => void }) {
  const lines = useMemo(() => storyFor(lesson), [lesson.id]);
  const [i, setI] = useState(0);
  const [talking, setTalking] = useState(true);
  const plan = i >= lines.length;
  const line = lines[Math.min(i, lines.length - 1)];

  useEffect(() => {
    if (plan) { speak('Here is the plan. Press Enter to start.', o); return; }
    setTalking(true);
    let alive = true;
    const run = async () => {
      if (line.sound) { await speak(line.text, o); await playSound(line.sound, o); await new Promise((r) => setTimeout(r, 250)); await playSound(line.sound, o); }
      else await speak(line.text, o, line.who === 'glitch' ? { pitch: 1.5, rate: o.rate * 1.05 } : {});
      if (alive) setTalking(false);
    };
    run();
    return () => { alive = false; };
  }, [i]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sfx('soft', o); if (plan) { hush(); onStart(); } else setI((x) => x + 1); }
      if (e.key === 'Escape') { hush(); onQuit(); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [plan]);

  return (
    <div class="lr-story-screen">
      <div class="sk-head"><button class="ghost" onClick={() => { hush(); onQuit(); }}>← Map</button><h2>{lesson.title}</h2><button class="ghost small" onClick={() => { hush(); onStart(); }}>Skip ⏭</button></div>
      {!plan ? (
        <div class="lr-scene" onClick={() => setI(i + 1)}>
          <Speaker who={line.who} line={line} talking={talking} o={o} />
          <div class={'lr-bubble ' + line.who}>
            <p>{line.text}</p>
            {line.sound && <button class="secondary small" onClick={(e) => { e.stopPropagation(); playSound(line.sound!, o); }}>🔊 Hear it again</button>}
            <span class="lr-next-hint">Enter ▶</span>
          </div>
        </div>
      ) : (
        <div class="lr-plan">
          {lesson.sound && <LetterBuddy letter={SOUNDS[lesson.sound].keys} color={buddyColor(lesson.sound)} size={110} trapped happy={false} />}
          <div class="lr-plan-card">
            <h3>Mission plan</h3>
            <ol>{steps.map((s) => <li><span class="sk-plan-icon">{STEP_INFO[s.kind].icon}</span> {STEP_INFO[s.kind].name}</li>)}</ol>
            <p class="muted">Take your time. There is no clock, and mistakes are OK.</p>
            <button class="primary big" onClick={() => { hush(); onStart(); }}>Start <span class="muted small">(Enter)</span></button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the lesson

export interface LessonDone { typed: string[]; firstTry: boolean[]; startedAt: number }

export function LessonPlayer({ lesson, steps, o, onQuit, onComplete }: {
  lesson: Lesson; steps: Step[]; o: Opts; onQuit: () => void; onComplete: (r: LessonDone) => void;
}) {
  const [phase, setPhase] = useState<'story' | 'play'>('story');
  const [stepIdx, setStepIdx] = useState(0);
  const [itemIdx, setItemIdx] = useState(0);
  const [banner, setBanner] = useState(true);
  const [streak, setStreak] = useState(0);
  const results = useRef<{ typed: string[]; firstTry: boolean[] }>({ typed: [], firstTry: [] });
  const startedAt = useRef(Date.now());

  if (phase === 'story') return <Story lesson={lesson} steps={steps} o={o} onQuit={onQuit} onStart={() => { startedAt.current = Date.now(); setPhase('play'); }} />;

  const step = steps[stepIdx];
  const item = step.items[itemIdx];

  function next(firstTry: boolean) {
    results.current.typed.push(item);
    results.current.firstTry.push(firstTry);
    setStreak((s) => (firstTry ? s + 1 : 0));
    if (itemIdx + 1 < step.items.length) setItemIdx(itemIdx + 1);
    else if (stepIdx + 1 < steps.length) { setStepIdx(stepIdx + 1); setItemIdx(0); setBanner(true); }
    else onComplete({ typed: results.current.typed, firstTry: results.current.firstTry, startedAt: startedAt.current });
  }

  const total = steps.reduce((n, s) => n + s.items.length, 0);
  const doneCount = steps.slice(0, stepIdx).reduce((n, s) => n + s.items.length, 0) + itemIdx;
  return (
    <div class="lr-play">
      <div class="sk-schedule">
        <button class="ghost small" onClick={() => { hush(); onQuit(); }}>Stop</button>
        <ol class="sk-steps">
          {steps.map((s, i) => <li class={i < stepIdx ? 'done' : i === stepIdx ? 'now' : ''}><span>{STEP_INFO[s.kind].icon}</span> {STEP_INFO[s.kind].name}</li>)}
        </ol>
        <div class="sk-bar"><div style={{ width: `${(doneCount / total) * 100}%` }} /></div>
        {streak >= 3 && !o.calm && <span class="lr-streak" title="Right the first time, in a row">🔥 {streak} in a row</span>}
      </div>
      {banner
        ? <StepBanner key={stepIdx} kind={step.kind} ch={item[0]} o={o} onGo={() => setBanner(false)} />
        : <ItemPlayer key={`${stepIdx}-${itemIdx}`} kind={step.kind} target={item} items={step.items} itemIdx={itemIdx} lesson={lesson} o={o} onDone={next} />}
    </div>
  );
}

/** Between mini-games: the guide names the next game and how to play it. Any key (or a moment) continues. */
function StepBanner({ kind, ch, o, onGo }: { kind: StepKind; ch: string; o: Opts; onGo: () => void }) {
  const info = STEP_INFO[kind];
  const right = KEY_FINGER[(ch ?? '').toLowerCase()]?.startsWith('R');
  useEffect(() => {
    sfx('whoosh', o);
    let gone = false;
    const go = () => { if (!gone) { gone = true; onGo(); } };
    speak(`${info.name}! ${info.tell}`, o).then(() => setTimeout(go, 300));
    const t = setTimeout(go, 9000);
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hush(); go(); } };
    window.addEventListener('keydown', h);
    return () => { gone = true; clearTimeout(t); window.removeEventListener('keydown', h); };
  }, []);
  return (
    <div class="lr-banner" onClick={() => { hush(); onGo(); }}>
      <div class="lr-banner-icon">{info.icon}</div>
      <h2>{info.name}</h2>
      <div class={'sk-guide' + (right ? ' right' : '')}>
        {kind === 'boss' ? <Glitch size={90} /> : right ? <Tock size={90} talking /> : <Tap size={90} talking />}
        <div class="sk-say">{info.tell}</div>
      </div>
      <p class="muted small">Press Enter to start</p>
    </div>
  );
}

// ---------------------------------------------------------------- one item: the typing core + the game skin

function ItemPlayer({ kind, target, items, itemIdx, lesson, o, onDone }: {
  kind: StepKind; target: string; items: string[]; itemIdx: number; lesson: Lesson; o: Opts; onDone: (firstTry: boolean) => void;
}) {
  const [pos, setPos] = useState(0);
  const [missed, setMissed] = useState(false);
  const [hint, setHint] = useState(!(kind === 'listen' || kind === 'spell' || kind === 'boss'));
  const [wrongKey, setWrongKey] = useState<string | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const ends = useMemo(() => unitEnds(target), [target]);
  const hidden = kind === 'listen' || kind === 'spell' || kind === 'boss';
  const unitId = SOUNDS[target] ? target : null;

  const announce = () => {
    if ((kind === 'listen' || kind === 'meet') && unitId) return playSound(unitId, o);
    if (kind === 'spell' || kind === 'boss') return speak(target, o);
    return Promise.resolve();
  };
  useEffect(() => { announce(); }, []);

  // Hidden items: a hint appears after a pause. It only ever helps — there is no timer to beat.
  useEffect(() => {
    if (hint || !hidden || !isFinite(o.hintMs)) return;
    const t = setTimeout(() => setHint(true), o.hintMs);
    return () => clearTimeout(t);
  }, [hint, pos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (finished || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Shift' || e.key === 'CapsLock' || e.key === 'Tab') return;
      if (e.key === 'Enter' && hidden) { e.preventDefault(); announce(); return; }
      if (e.key.length !== 1) return;
      e.preventDefault();
      setPressed(e.key); setTimeout(() => setPressed(null), 140);
      const want = target[pos];
      if (e.key === want) {
        setWrongKey(null);
        const u = ends[pos];
        if (kind === 'meet') sfx('charge', o, itemIdx);
        else if (kind === 'words') sfx('plank', o, pos);
        else if (kind === 'blaster') { /* pop on finish */ }
        else if (kind === 'listen') sfx('gem', o, itemIdx);
        else sfx('type', o);
        if (u && kind !== 'sentence' && kind !== 'listen' && kind !== 'meet' && kind !== 'home') playSound(u, o);
        if (kind === 'home') speak(want === 'f' ? 'F' : 'J', o, { rate: 1.1 });
        if (pos + 1 >= target.length) {
          setFinished(true);
          const finish = () => onDone(!missed);
          const last = itemIdx === items.length - 1;
          if (kind === 'blaster') { sfx('pop', o); confetti(o, centerOf(stage.current?.querySelector('.lr-balloon.cur')), 14); setTimeout(finish, 320); }
          else if (kind === 'meet') { if (last) { sfx('free', o); confetti(o, centerOf(stage.current), 40); setTimeout(finish, 1200); } else setTimeout(finish, 380); }
          else if (kind === 'boss') { sfx('hit', o); speak(target, o).then(() => setTimeout(finish, last ? 900 : 300)); if (last) setTimeout(() => confetti(o, centerOf(stage.current), 50), 300); }
          else if (kind === 'words' || kind === 'spell' || kind === 'read') { sfx('chime', o); speak(target, o).then(() => setTimeout(finish, 350)); }
          else if (kind === 'sentence') { sfx('chime', o); setTimeout(finish, 450); }
          else setTimeout(finish, 260);
        }
        setPos(pos + 1);
      } else {
        // Errorless: nothing bad happens. The right key lights up and the finger is named.
        sfx('soft', o);
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

  const letters = (
    <div class={'sk-target' + (target.length > 3 ? ' long' : '') + (target.length > 12 ? ' phrase' : '')}>
      {[...target].map((ch, i) => {
        const show = !hidden || i < pos || (hint && i === pos);
        const f = KEY_FINGER[ch.toLowerCase()];
        return (
          <span class={'sk-ch' + (i < pos ? ' typed' : i === pos ? ' cur' : '') + (show ? '' : ' blank') + (ch === ' ' ? ' space' : '')}
            style={i === pos && show && f ? { color: FINGER_COLOR[f], borderColor: FINGER_COLOR[f] } : i < pos && f ? { color: FINGER_COLOR[f] } : {}}>
            {show ? (ch === ' ' ? '␣' : ch) : '?'}
          </span>
        );
      })}
    </div>
  );

  const scene = { kind, target, pos, items, itemIdx, finished, hint, o, letters, lesson };
  return (
    <div class="sk-item">
      <div class={'sk-stage lr-stage-' + kind} ref={stage}>
        <Scene {...scene} />
        {hidden && !finished && <button class="sk-hear" onClick={announce} title="Hear it again (Enter)">🔊 <small>Enter</small></button>}
        <div class="lr-help">
          {wrongKey && <p class="sk-gentle">That was <b>{wrongKey === ' ' ? 'space' : wrongKey}</b>. Look for the glowing key.</p>}
          {hint && want && finger && <p class="sk-finger" style={{ color: FINGER_COLOR[finger] }}>Use your {FINGER_NAME[finger]}{want !== want.toLowerCase() ? ' — and hold Shift with your other pinky' : ''}.</p>}
          {!hint && hidden && <button class="ghost small" onClick={() => { setHint(true); setMissed(true); }}>Show me</button>}
        </div>
      </div>
      <FingerKeyboard target={hint ? want : ''} known={lesson.known} pressed={pressed} />
      <Hands finger={hint ? finger ?? null : null} />
    </div>
  );
}

// ---------------------------------------------------------------- the game skins

interface SceneProps { kind: StepKind; target: string; pos: number; items: string[]; itemIdx: number; finished: boolean; hint: boolean; o: Opts; letters: any; lesson: Lesson }

function Scene(p: SceneProps) {
  switch (p.kind) {
    case 'meet': return <ChargeScene {...p} />;
    case 'home': return <HomeScene {...p} />;
    case 'listen': return <EchoScene {...p} />;
    case 'blaster': return <BalloonScene {...p} />;
    case 'words': return <BridgeScene {...p} />;
    case 'spell': return <BoxScene {...p} />;
    case 'read': return <MessageScene {...p} />;
    case 'boss': return <BossScene {...p} />;
    default: return <SkyScene {...p} />;
  }
}

function ChargeScene({ target, items, itemIdx, finished }: SceneProps) {
  const free = finished && itemIdx === items.length - 1;
  const charged = itemIdx + (finished ? 1 : 0);
  const color = FINGER_COLOR[KEY_FINGER[target[0]]] ?? '#fde047';
  return (
    <div class="lr-charge">
      <div class={'lr-cage' + (free ? ' broken' : '')} style={{ '--fc': color } as any}>
        <LetterBuddy letter={target} color={color} size={120} trapped={!free} happy={free} />
        {!free && <div class="lr-bolt" key={charged}>⚡</div>}
      </div>
      <div class="lr-meter">{items.map((_, i) => <span class={i < charged ? 'on' : ''} style={{ '--fc': color } as any} />)}</div>
      <p class="lr-caption">{free ? 'Free! 🎉' : `Press ${target.toUpperCase()} · ${items.length - charged} more`}</p>
    </div>
  );
}

function HomeScene({ target, pos, itemIdx, finished }: SceneProps) {
  const want = finished ? '' : target[pos];
  return (
    <div class="lr-home">
      <div class={'lr-home-side' + (want === 'f' ? ' on' : '')}><Tap size={96} wave={want === 'f'} /><div class="lr-bigkey" style={{ '--fc': FINGER_COLOR.L2 } as any}>F<i /></div></div>
      <div class="lr-home-mid">🏠<small>{itemIdx + (finished ? 1 : 0)} / 8</small></div>
      <div class={'lr-home-side' + (want === 'j' ? ' on' : '')}><div class="lr-bigkey" style={{ '--fc': FINGER_COLOR.R2 } as any}>J<i /></div><Tock size={96} wave={want === 'j'} /></div>
    </div>
  );
}

function EchoScene({ items, itemIdx, finished, hint, target, letters }: SceneProps) {
  const unit = SOUNDS[target];
  return (
    <div class="lr-echo">
      <div class="lr-cave">
        <div class="lr-ripples"><i /><i /><i /></div>
        <div class="lr-echo-q">{finished || hint ? <span>{unit?.emoji}</span> : '?'}</div>
      </div>
      {letters}
      <div class="lr-gems">{items.map((_, i) => <span class={i < itemIdx || (i === itemIdx && finished) ? 'on' : ''}>💎</span>)}</div>
    </div>
  );
}

function BalloonScene({ items, itemIdx, finished }: SceneProps) {
  return (
    <div class="lr-balloons">
      {items.slice(itemIdx, itemIdx + 6).map((k, i) => (
        <div class={'lr-balloon' + (i === 0 ? ' cur' : '') + (i === 0 && finished ? ' popped' : '')}
          style={{ '--fc': FINGER_COLOR[KEY_FINGER[k[0]]], left: `calc(50% - 38px + ${i === 0 ? 0 : (i % 2 ? 1 : -1) * (60 + i * 18)}px)`, bottom: `${i * 22}px`, zIndex: 10 - i } as any}>
          <span>{k}</span>
        </div>
      ))}
      <div class="lr-left muted small">🎈 {items.length - itemIdx - (finished ? 1 : 0)} left</div>
    </div>
  );
}

function BridgeScene({ target, pos, finished, letters }: SceneProps) {
  const pic = pictureFor(target);
  return (
    <div class="lr-bridge-wrap">
      <div class="lr-bridge">
        <div class="lr-cliff left"><span class={'lr-walker' + (finished ? ' across' : '')}>🧒</span></div>
        <div class="lr-planks">
          {[...target].map((ch, i) => <span class={'lr-plank' + (i < pos ? ' laid' : '')} style={{ '--fc': FINGER_COLOR[KEY_FINGER[ch]] } as any}>{i < pos ? ch : ''}</span>)}
        </div>
        <div class="lr-cliff right">{pic ? <span class="lr-goal">{pic}</span> : <span class="lr-goal">🏁</span>}</div>
      </div>
      {letters}
    </div>
  );
}

function BoxScene({ target, finished, letters }: SceneProps) {
  const pic = pictureFor(target) || '⭐';
  return (
    <div class="lr-box-wrap">
      <div class={'lr-box' + (finished ? ' open' : '')}>
        <div class="lr-box-lid">🎀</div>
        <div class="lr-box-body">{finished ? <span class="lr-box-prize">{pic}</span> : '?'}</div>
      </div>
      {letters}
    </div>
  );
}

function MessageScene({ target, letters }: SceneProps) {
  const pics = target.split(' ').map(pictureFor).filter(Boolean).join(' ');
  return (
    <div class="lr-scroll">
      <div class="lr-scroll-paper">
        {pics && <div class="lr-scroll-pics">{pics}</div>}
        {letters}
      </div>
    </div>
  );
}

function BossScene({ target, items, itemIdx, finished, letters }: SceneProps) {
  const mixed = useMemo(() => scramble(target, rng(target.length * 131 + itemIdx * 7 + 1)), [target]);
  const hp = items.length - itemIdx - (finished ? 1 : 0);
  const pic = pictureFor(target);
  const defeated = hp === 0;
  return (
    <div class="lr-battle">
      <div class="lr-hp"><span>Glitch</span><div><i style={{ width: `${(hp / items.length) * 100}%` }} /></div></div>
      <div class={'lr-boss-row' + (finished ? ' hit' : '')}>
        <div class={'lr-glitch' + (defeated ? ' poof' : '')}><Glitch size={110} mood={finished ? 'oops' : 'sly'} /></div>
        <div class="lr-tiles">{[...mixed].map((c) => <span class="lr-tile">{c}</span>)}</div>
        {pic && <div class="sk-picture small">{pic}</div>}
      </div>
      {letters}
      {defeated && <p class="lr-caption">Glitch is beaten! 🎉</p>}
    </div>
  );
}

function SkyScene({ letters, finished }: SceneProps) {
  return (
    <div class="lr-sky">
      <div class={'lr-plane' + (finished ? ' fly' : '')}>✈️</div>
      {letters}
    </div>
  );
}
