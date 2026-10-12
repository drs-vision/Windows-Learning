// Letter Rescue — keyboard, hands, Buddy Book, Talking Typewriter, and the "click here to type" focus guard.
import { useEffect, useRef, useState } from 'preact/hooks';
import { FINGER_COLOR, FINGER_NAME, KEY_FINGER, LESSONS, SOUNDS, WORDS, type Finger } from './content';
import { LetterBuddy, Tap, Tock } from './art';
import { playSound, speak, sfx, type Opts } from './fx';

// ---------------------------------------------------------------- keyboard + hands

const ROWS: string[] = ['qwertyuiop', 'asdfghjkl;', 'zxcvbnm,./'];

export function FingerKeyboard({ target, known, pressed }: { target: string; known: string[]; pressed?: string | null }) {
  const knownKeys = new Set(known.flatMap((s) => [...SOUNDS[s].keys]));
  const t = target.toLowerCase();
  const needShift = target !== '' && target !== t;
  const p = pressed?.toLowerCase();
  return (
    <div class="fk">
      {ROWS.map((row, ri) => (
        <div class="fk-row" style={{ marginLeft: `${[0, 18, 46][ri]}px` }}>
          {[...row].map((k) => {
            const f = KEY_FINGER[k] as Finger;
            return (
              <span class={'fk-key' + (k === t ? ' target' : '') + (knownKeys.has(k) ? ' known' : '') + (k === 'f' || k === 'j' ? ' bump' : '') + (k === p ? ' down' : '')}
                style={{ '--fc': FINGER_COLOR[f] } as any}>{k}</span>
            );
          })}
        </div>
      ))}
      <div class="fk-row">
        <span class={'fk-key shift' + (needShift && KEY_FINGER[t]?.startsWith('R') ? ' target' : '')} style={{ '--fc': FINGER_COLOR.L5 } as any}>shift</span>
        <span class={'fk-key space' + (t === ' ' ? ' target' : '') + (p === ' ' ? ' down' : '')} style={{ '--fc': FINGER_COLOR.T } as any}>space</span>
        <span class={'fk-key shift' + (needShift && KEY_FINGER[t]?.startsWith('L') ? ' target' : '')} style={{ '--fc': FINGER_COLOR.R5 } as any}>shift</span>
      </div>
    </div>
  );
}

/** Two hands. The finger to use is lifted and bright; the rest are dim. */
export function Hands({ finger }: { finger: Finger | null }) {
  const left: Finger[] = ['L5', 'L4', 'L3', 'L2'];
  const right: Finger[] = ['R2', 'R3', 'R4', 'R5'];
  const heights = [44, 56, 62, 54];
  const hand = (fs: Finger[], mirror: boolean) => (
    <svg viewBox="0 0 140 120" class="hand" style={mirror ? { transform: 'scaleX(-1)' } : {}}>
      {fs.map((f, i) => {
        const h = heights[mirror ? 3 - i : i];
        const active = finger === f;
        return <rect x={8 + i * 26} y={(active ? 0 : 14) + (62 - h)} width={22} height={h} rx={11}
          fill={FINGER_COLOR[f]} opacity={finger && !active ? 0.22 : 0.92} class={active ? 'finger-on' : ''} />;
      })}
      <rect x={4} y={72} width={110} height={44} rx={18} fill="#cbd5e1" opacity={0.35} />
      <rect x={104} y={60} width={20} height={44} rx={10} transform="rotate(35 114 82)" fill={FINGER_COLOR.T} opacity={finger === 'T' ? 0.92 : 0.22} />
    </svg>
  );
  return <div class="hands">{hand(left, false)}{hand(right, true)}</div>;
}

// ---------------------------------------------------------------- focus guard

/**
 * Inside the Windows app the page only receives keys once it has focus. If it doesn't (for example after another
 * window popped up), say so plainly instead of letting key presses vanish.
 */
export function FocusGuard() {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    const check = () => setFocused(document.hasFocus());
    const t = setInterval(check, 400);
    window.addEventListener('focus', check); window.addEventListener('blur', check);
    return () => { clearInterval(t); window.removeEventListener('focus', check); window.removeEventListener('blur', check); };
  }, []);
  if (focused) return null;
  return (
    <button class="lr-focus" onClick={() => { window.focus(); setFocused(true); }}>
      <span>👆</span> Click here, then type!
    </button>
  );
}

// ---------------------------------------------------------------- Buddy Book

/** Every letter friend. Rescued ones are in colour; click one to hear its sound again. */
export function BuddyBook({ current, done, o, onBack }: { current: number; done: number[]; o: Opts; onBack: () => void }) {
  const lessons = LESSONS.filter((l) => l.sound);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') onBack(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  const rescued = (id: number) => done.includes(id) || id < current;
  function hear(id: string) {
    setSel(id);
    const u = SOUNDS[id];
    playSound(id, o).then(() => speak(u.say, o));
  }
  const u = sel ? SOUNDS[sel] : null;
  return (
    <div class="lr-book">
      <div class="sk-head"><button class="ghost" onClick={onBack}>← Back</button><h2>📖 Buddy Book</h2><span class="lr-count">{lessons.filter((l) => rescued(l.id)).length} / {lessons.length} friends</span></div>
      {u && (
        <div class="lr-book-sel" style={{ borderColor: FINGER_COLOR[KEY_FINGER[u.keys[0]]] }}>
          <LetterBuddy letter={u.keys} color={FINGER_COLOR[KEY_FINGER[u.keys[0]]]} size={110} happy />
          <div>
            <div class="lr-book-word">{u.emoji} {u.keyword}</div>
            <div style={{ color: FINGER_COLOR[KEY_FINGER[u.keys[0]]] }}>Typed with your {FINGER_NAME[KEY_FINGER[u.keys[0]]]}</div>
            <button class="secondary" onClick={() => hear(u.id)}>🔊 Hear it again</button>
          </div>
        </div>
      )}
      <div class="lr-book-grid">
        {lessons.map((l) => {
          const s = SOUNDS[l.sound!];
          const ok = rescued(l.id);
          return (
            <button class={'lr-book-cell' + (ok ? '' : ' locked') + (sel === s.id ? ' on' : '')} disabled={!ok} onClick={() => hear(s.id)}>
              <LetterBuddy letter={s.keys} color={ok ? FINGER_COLOR[KEY_FINGER[s.keys[0]]] : '#475569'} size={64} trapped={!ok} happy={ok} />
              <small>{ok ? `${s.emoji} ${s.keyword}` : '???'}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Talking Typewriter

const PICTURES = new Map(WORDS.filter(([, e]) => e).map(([w, e]) => [w, e]));

/**
 * Free play: type anything and the computer reads it back — every word after Space, the whole line after Enter.
 * Letters show in their finger colour; known words get a picture. No coins, no right or wrong.
 */
export function Typewriter({ o, onBack }: { o: Opts; onBack: () => void }) {
  const [text, setText] = useState('');
  const [lastWord, setLastWord] = useState('');
  const paper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Escape') { onBack(); return; }
      if (e.key === 'Backspace') { e.preventDefault(); setText((t) => t.slice(0, -1)); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        setText((t) => { const line = t.split('\n').at(-1)!.trim(); if (line) speak(line, o); return t.length < 600 ? t + '\n' : t; });
        return;
      }
      if (e.key.length !== 1) return;
      e.preventDefault();
      sfx('type', o);
      setText((t) => {
        if (t.length >= 600) return t;
        if (e.key === ' ' || e.key === '.' || e.key === '!' || e.key === '?') {
          const word = (t.split(/[\s.!?]/).at(-1) ?? '').trim();
          if (word) { speak(word, o); setLastWord(word.toLowerCase()); }
        } else if (/^[a-z]$/i.test(e.key) && SOUNDS[e.key.toLowerCase()]) {
          // A quiet letter sound while typing helps connect key and sound.
          playSound(e.key.toLowerCase(), { ...o, sound: o.sound });
        }
        return t + e.key;
      });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => { paper.current?.scrollTo({ top: 1e6 }); }, [text]);
  const pic = PICTURES.get(lastWord);
  return (
    <div class="lr-typer">
      <div class="sk-head">
        <button class="ghost" onClick={onBack}>← Back</button>
        <h2>⌨️ Talking Typewriter</h2>
        <span class="muted small">Space = say the word · Enter = say the line</span>
      </div>
      <div class="lr-typer-row">
        <div class="lr-typer-guides"><Tap size={70} talking={!!lastWord} /></div>
        <div class="lr-paper" ref={paper}>
          {text.length === 0 && <span class="muted">Type anything you like… I'll read it to you!</span>}
          {[...text].map((ch) => ch === '\n' ? <br /> : <span style={{ color: FINGER_COLOR[KEY_FINGER[ch.toLowerCase()]] ?? '#e2e8f0' }}>{ch}</span>)}
          <span class="lr-caret">▍</span>
        </div>
        <div class="lr-typer-guides">{pic ? <div class="lr-typer-pic">{pic}</div> : <Tock size={70} />}</div>
      </div>
      <div class="row center"><button class="ghost small" onClick={() => speak(text.replace(/\n/g, '. '), o)}>🔊 Read it all</button><button class="ghost small" onClick={() => { setText(''); setLastWord(''); }}>🧽 Clear</button></div>
      <FingerKeyboard target="" known={Object.keys(SOUNDS)} />
    </div>
  );
}
