import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { typingAccuracy, wordsPerMinute } from '../module';

export interface TypingDone { typed: string; startedAt: number; finishedAt: number; accuracy: number; wpm: number }

/**
 * The typing surface used by every typing drill: shows the target text, captures keys, colours each
 * character right/wrong, shows live WPM and accuracy, and calls onDone when the last character is typed
 * (or Enter is pressed after the text is complete). Backspace is allowed — accuracy counts the final text.
 */
export function TypingBox({ text, onDone, highlightKeys, big }: { text: string; onDone: (d: TypingDone) => void; highlightKeys?: string; big?: boolean }) {
  const [typed, setTyped] = useState('');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);

  const elapsed = startedAt ? now - startedAt : 0;
  const accuracy = useMemo(() => typingAccuracy(text.slice(0, typed.length), typed), [text, typed]);
  const wpm = wordsPerMinute(typed.length, elapsed);

  function finish(final: string) {
    if (done.current) return;
    done.current = true;
    const finishedAt = Date.now();
    onDone({ typed: final, startedAt: startedAt ?? finishedAt, finishedAt, accuracy: typingAccuracy(text, final), wpm: wordsPerMinute(final.length, finishedAt - (startedAt ?? finishedAt)) });
  }

  function onInput(e: Event) {
    const v = (e.target as HTMLTextAreaElement).value;
    if (!startedAt && v.length > 0) setStartedAt(Date.now());
    const next = v.slice(0, text.length);
    setTyped(next);
    if (next.length >= text.length) finish(next);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); if (typed.length >= text.length * 0.9) finish(typed); }
    if (e.key === 'Tab') e.preventDefault();
  }

  const nextChar = text[typed.length] ?? '';

  return (
    <div class={'typing-box' + (big ? ' big' : '')} onClick={() => inputRef.current?.focus()}>
      <div class="typing-text" aria-label="text to type">
        {text.split('').map((ch, i) => {
          const cls = i < typed.length ? (typed[i] === ch ? 'ok' : 'bad') : i === typed.length ? 'cur' : '';
          return <span key={i} class={cls}>{ch === ' ' && cls === 'bad' ? '␣' : ch}</span>;
        })}
      </div>
      <textarea ref={inputRef} class="typing-input" value={typed} onInput={onInput} onKeyDown={onKey} spellcheck={false} autocomplete="off" autocapitalize="off" aria-label="type here" />
      <div class="typing-stats">
        <span>{Math.round(wpm)} <small>WPM</small></span>
        <span>{Math.round(accuracy * 100)}% <small>accuracy</small></span>
        <span>{Math.round(elapsed / 1000)}<small>s</small></span>
      </div>
      {highlightKeys !== undefined && <Keyboard next={nextChar} lane={highlightKeys} />}
    </div>
  );
}

const ROWS = ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./'];
const FINGER: Record<string, string> = {};
for (const [keys, f] of [['`1qaz', 'L5'], ['2wsx', 'L4'], ['3edc', 'L3'], ['4rfv5tgb', 'L2'], ['6yhn7ujm', 'R2'], ['8ik,', 'R3'], ['9ol.', 'R4'], ["0p;/-['=]\\", 'R5']] as const)
  for (const k of keys) FINGER[k] = f;

/** On-screen keyboard with the next key lit and the finger named. */
export function Keyboard({ next, lane }: { next: string; lane: string }) {
  const n = next.toLowerCase();
  const shift = next !== '' && (next !== n || '~!@#$%^&*()_+{}|:"<>?'.includes(next));
  const finger = FINGER[n];
  return (
    <div class="kbd">
      {ROWS.map((row, ri) => (
        <div class="kbd-row" style={{ paddingLeft: ri * 14 + 'px' }}>
          {row.split('').map((k) => <span class={'key' + (k === n ? ' next' : '') + (lane.includes(k) ? ' lane' : '')}>{k}</span>)}
        </div>
      ))}
      <div class="kbd-row"><span class={'key wide' + (shift ? ' next' : '')}>shift</span><span class={'key space' + (next === ' ' ? ' next' : '')}>space</span></div>
      <div class="kbd-finger">{next === ' ' ? 'thumb' : finger ? fingerName(finger) : ''}</div>
    </div>
  );
}

function fingerName(f: string) {
  const hand = f[0] === 'L' ? 'left' : 'right';
  const names: Record<string, string> = { '2': 'index', '3': 'middle', '4': 'ring', '5': 'pinky' };
  return `${hand} ${names[f[1]]}`;
}
