import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Activity } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { invalid } from '../../core/module';
import { bridge } from '../../core/bridge';

/**
 * Reading Quest: a bite-size paragraph (3-6 sentences) with one question right under it, one after another for as long
 * as the child likes (no set length; the daily coin limit caps the pay, not the reading).
 * The PC picks each paragraph near the child's rating and moves the rating with every answer (ReadingQuest.cs), pays
 * coins for right answers and a bonus for every few in a row. Paragraphs are written by people (public-domain and
 * CC BY sources, content/passages); the PC holds the answers.
 */
export const readingQuest: LessonModule = {
  id: 'reading-quest',
  title: 'Reading Quest',
  tagline: 'Short paragraphs, one question each',
  description: 'Your child reads a short paragraph (3-6 sentences, written by real authors — nature, space, animals, stories) and answers one question right under it, then the next one comes up, for as long as they like. The paragraphs get harder or easier with each answer, so they stay just right. Right answers pay coins, and every few in a row earns a streak bonus.',
  icon: '🧭',
  verification: 'in_app',
  defaults: { coinsPerActivity: 1, dailyCap: 40 },
  options: [
    { key: 'streakEvery', label: 'Streak bonus every', suffix: 'right in a row', number: { min: 2, max: 50 }, default: '2' },
  ],
  nextActivity(): Activity { return { moduleId: 'reading-quest', kind: 'quest', data: {}, issuedAt: 0 }; },
  mount(el, activity, ctx) { render(<Quest activity={activity} ctx={ctx} />, el); return () => render(null, el); },
  score: () => invalid('Reading Quest is marked by the PC'),
};

interface Me { level: number; progress: number; streak: number; bestStreak: number; streakEvery: number; answered: number; earnedToday: number; dailyCap: number; left: number }
interface Shown { id: string; title: string; text: string; q: string; choices: string[]; sourceName: string; sourceUrl: string; license: string; author: string | null; retry: boolean; readSeconds: number; waitLeft: number }
interface Result { retry: boolean; right: boolean; rightChoice: number; evidence: string; streak: number; streakUp: boolean; coins: number; bonus: number; pending: boolean; levelBefore: number; me: Me }
type Step = { at: 'loading' } | { at: 'read'; p: Shown; shownAt: number; openAt: number; pick?: number; r?: Result } | { at: 'empty' };

/** How many of this sitting's answers show as dots (a trail, not a count-down: the quest never ends). */
const TRAIL = 10;

const call = <T,>(op: string, p?: unknown) => bridge.call<T>(op, p);

/**
 * The streak: a ring in `every` parts. Each right answer in a row fills a part; a full ring adds 1 to the number in
 * the middle (and pays it as a bonus) and starts again. A miss empties it. One soft pulse when it fills; nothing loops.
 */
function StreakRing({ streak, every, best }: { streak: number; every: number; best: number }) {
  const level = Math.floor(streak / every);
  const filled = streak % every;
  const prev = useRef(level);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (level > prev.current) { setPulse(true); const t = setTimeout(() => setPulse(false), 700); prev.current = level; return () => clearTimeout(t); }
    prev.current = level;
  }, [level]);
  const r = 15, c = 2 * Math.PI * r, gap = every > 1 ? 3 : 0, seg = c / every - gap;
  return (
    <span class={'rq-ring-streak' + (pulse ? ' pulse' : '') + (streak ? ' on' : '')} title={`Streak: ${streak} in a row (best ${best})`} aria-label={`Streak ${streak} in a row`}>
      <svg viewBox="0 0 40 40" width="44" height="44" aria-hidden="true">
        {Array.from({ length: every }, (_, i) => (
          <circle cx="20" cy="20" r={r} fill="none" stroke-width="4" stroke-linecap="round"
            class={i < (pulse ? every : filled) ? 'seg full' : 'seg'} stroke-dasharray={`${seg} ${c - seg}`} stroke-dashoffset={-(i * c) / every - gap / 2}
            transform="rotate(-90 20 20)" />
        ))}
        <text x="20" y="21" text-anchor="middle" dominant-baseline="middle">{level}</text>
      </svg>
    </span>
  );
}

/** The paragraph; the evidence is highlighted only after a second-look miss (the paragraph is retired, so nothing is given away). */
function Paragraph({ text, mark }: { text: string; mark?: string }) {
  if (!mark) return <p class="rq-text">{text}</p>;
  const i = text.toLowerCase().replace(/\s+/g, ' ').indexOf(mark.toLowerCase().replace(/\s+/g, ' '));
  const flat = text.replace(/\s+/g, ' ');
  if (i < 0) return <p class="rq-text">{text}</p>;
  return <p class="rq-text">{flat.slice(0, i)}<mark>{flat.slice(i, i + mark.length)}</mark>{flat.slice(i + mark.length)}</p>;
}

function Quest({ ctx }: { activity: Activity; ctx: ActivityContext }) {
  const [me, setMe] = useState<Me | null>(null);
  const [step, setStep] = useState<Step>({ at: 'loading' });
  const [trail, setTrail] = useState<boolean[]>([]); // this sitting's answers, newest last (only the last few are shown)
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { next(); }, []); // no start screen: the first paragraph comes straight up

  async function next() {
    setErr('');
    try {
      const r = await call<{ passage: Shown | null; me: Me }>('quest.next');
      setMe(r.me);
      if (!r.passage) { setStep({ at: 'empty' }); return; }
      setStep({ at: 'read', p: r.passage, shownAt: Date.now(), openAt: Date.now() + r.passage.waitLeft * 1000 });
      top.current?.scrollIntoView?.({ block: 'start' });
    } catch (e) { setErr((e as Error).message); }
  }

  async function answer(pick: number) {
    if (step.at !== 'read' || step.r) return;
    setStep({ ...step, pick });
    try {
      const r = await call<Result>('quest.answer', { id: step.p.id, pick, readMs: Date.now() - step.shownAt });
      setStep({ ...step, pick, r });
      setMe(r.me);
      setTrail((t) => [...t, r.right].slice(-TRAIL));
      if (r.me.level > r.levelBefore) { setToast(`⬆ Level ${r.me.level}!`); setTimeout(() => setToast(''), 3500); }
    } catch (e) { setErr((e as Error).message); setStep({ ...step, pick: undefined }); }
  }

  if (!me) return <div class="rq">{err ? <p class="error">{err}</p> : <p class="muted center">Loading…</p>}</div>;
  const capped = me.dailyCap > 0 && me.earnedToday >= me.dailyCap;

  const head = (
    <div class="rq-head" ref={top}>
      <button class="ghost" onClick={ctx.exit}>← Back</button>
      <div class="rq-level" title="Your Quest level grows as you get answers right">
        <b>Level {me.level}</b>
        <span class="rq-bar"><i style={{ width: `${Math.round(me.progress * 100)}%` }} /></span>
      </div>
      <StreakRing streak={me.streak} every={me.streakEvery} best={me.bestStreak} />
    </div>
  );

  if (step.at !== 'read') return (
    <div class="rq">
      {head}
      <div class="rq-card rq-start">
        {step.at === 'empty'
          ? <><h2>🧭 Reading Quest</h2><p>You've read every paragraph there is right now — amazing! New ones come with updates.</p></>
          : err ? null : <p class="muted">Loading…</p>}
        {err && <><p class="error">{err}</p><button class="primary" onClick={next}>Try again</button></>}
      </div>
    </div>
  );

  return <QuestCard p={step.p} pick={step.pick} r={step.r} openAt={step.openAt} head={head} trail={trail} capped={capped} err={err} toast={toast} onAnswer={answer} onNext={next} />;
}

/** One paragraph and its question. The answers unlock after the reading time (the PC checks it too). */
function QuestCard({ p, pick, r, openAt, head, trail, capped, err, toast, onAnswer, onNext }: {
  p: Shown; pick?: number; r?: Result; openAt: number; head: preact.JSX.Element; trail: boolean[]; capped: boolean;
  err: string; toast: string; onAnswer: (k: number) => void; onNext: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (Date.now() >= openAt) return; const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, [openAt]);
  const wait = Math.max(0, Math.ceil((openAt - now) / 1000));
  const locked = wait > 0 && !r;
  return (
    <div class="rq">
      {head}
      {trail.length > 0 && (
        <div class="rq-dots" aria-label={`Last answers: ${trail.filter(Boolean).length} of ${trail.length} right`}>
          {trail.map((ok) => <i class={ok ? 'ok' : 'miss'} />)}{!r && <i class="now" />}
        </div>
      )}
      <div class="rq-card">
        <h3 class="rq-title">{p.title}</h3>
        <Paragraph text={p.text} mark={r && !r.right && r.evidence ? r.evidence : undefined} />
        <p class="rq-credit">From {p.sourceName}{p.author ? `, by ${p.author}` : ''} · {p.license}</p>
        <div class="rq-q">{p.retry && <span class="rq-retry">Second look</span>}<b>{p.q}</b></div>
        {locked && <div class="rq-wait" role="timer"><span class="rq-ring" style={{ '--p': `${Math.round((1 - wait / p.readSeconds) * 100)}` } as any}>{wait}</span> Read the paragraph first — the answers open in {wait} second{wait === 1 ? '' : 's'}.</div>}
        <div class="rq-choices">
          {p.choices.map((c, k) => {
            const cls = !r ? (pick === k ? ' on' : '') : k === r.rightChoice ? ' right' : k === pick ? ' wrong' : ' dim'; // rightChoice is -1 when the paragraph comes back
            return <button class={'choice' + cls} disabled={locked || !!r || pick != null} onClick={() => onAnswer(k)}><span class="letter">{'ABCD'[k]}</span>{c}</button>;
          })}
        </div>
        {r && (
          <div class={'rq-feedback ' + (r.right ? 'ok' : 'miss')}>
            <b>{r.right ? (r.retry ? '✓ Got it this time!' : `✓ Right!${r.coins ? ` +${r.coins} 🪙` : ''}${r.pending ? ' (waiting for a parent)' : ''}`)
              : r.retry ? 'Not this time — here is the answer.' : 'Not quite. This one will come back later for another try.'}</b>
            {capped && r.right && !r.retry && <span class="muted small">That's all of today's Reading Quest coins — keep reading for practice and your level.</span>}
            <button class="primary" onClick={onNext}>Next paragraph →</button>
          </div>
        )}
        {err && <p class="error">{err}</p>}
      </div>
      {toast && <div class="rq-toast">{toast}</div>}
    </div>
  );
}
