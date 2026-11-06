import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Activity } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { invalid } from '../../core/module';
import { bridge } from '../../core/bridge';

/**
 * Reading Quest: a bite-size paragraph (3-6 sentences) with one question right under it; about 5 minutes a quest.
 * The PC picks each paragraph near the child's rating and moves the rating with every answer (ReadingQuest.cs), pays
 * coins for right answers and a bonus for every few in a row. Paragraphs are written by people (public-domain and
 * CC BY sources, content/passages); the PC holds the answers.
 */
export const readingQuest: LessonModule = {
  id: 'reading-quest',
  title: 'Reading Quest',
  tagline: 'Short paragraphs, one question each',
  description: 'About five minutes: your child reads a short paragraph (3-6 sentences, written by real authors — nature, space, animals, stories) and answers one question right under it. The paragraphs get harder or easier with each answer, so they stay just right. Right answers pay coins, and every few in a row earns a streak bonus.',
  icon: '🧭',
  verification: 'in_app',
  defaults: { coinsPerActivity: 1, dailyCap: 40 },
  options: [
    { key: 'perQuest', label: 'Paragraphs per quest', number: { min: 3, max: 20 }, default: '6' },
    { key: 'streakEvery', label: 'Streak bonus every', suffix: 'right in a row', number: { min: 2, max: 50 }, default: '5' },
  ],
  nextActivity(): Activity { return { moduleId: 'reading-quest', kind: 'quest', data: {}, issuedAt: 0 }; },
  mount(el, activity, ctx) { render(<Quest activity={activity} ctx={ctx} />, el); return () => render(null, el); },
  score: () => invalid('Reading Quest is marked by the PC'),
};

interface Me { level: number; progress: number; streak: number; bestStreak: number; streakEvery: number; answered: number; perQuest: number; earnedToday: number; dailyCap: number; left: number }
interface Shown { id: string; title: string; text: string; q: string; choices: string[]; sourceName: string; sourceUrl: string; license: string; author: string | null; retry: boolean; readSeconds: number; waitLeft: number }
interface Result { retry: boolean; right: boolean; rightChoice: number; evidence: string; explain: string; streak: number; streakUp: boolean; coins: number; bonus: number; pending: boolean; levelBefore: number; me: Me }
type Step = { at: 'start' } | { at: 'read'; p: Shown; shownAt: number; openAt: number; pick?: number; r?: Result } | { at: 'done' } | { at: 'empty' };

const call = <T,>(op: string, p?: unknown) => bridge.call<T>(op, p);

/** The paragraph, with the evidence highlighted after a wrong answer. */
function Paragraph({ text, mark }: { text: string; mark?: string }) {
  if (!mark) return <p class="rq-text">{text}</p>;
  const i = text.toLowerCase().replace(/\s+/g, ' ').indexOf(mark.toLowerCase().replace(/\s+/g, ' '));
  const flat = text.replace(/\s+/g, ' ');
  if (i < 0) return <p class="rq-text">{text}</p>;
  return <p class="rq-text">{flat.slice(0, i)}<mark>{flat.slice(i, i + mark.length)}</mark>{flat.slice(i + mark.length)}</p>;
}

function Quest({ ctx }: { activity: Activity; ctx: ActivityContext }) {
  const [me, setMe] = useState<Me | null>(null);
  const [step, setStep] = useState<Step>({ at: 'start' });
  const [round, setRound] = useState<{ n: number; results: boolean[]; coins: number; startLevel: number }>({ n: 0, results: [], coins: 0, startLevel: 1 });
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { call<Me>('quest.state').then(setMe).catch((e) => setErr((e as Error).message)); }, []);

  async function next(fresh = false) {
    setErr('');
    try {
      const r = await call<{ passage: Shown | null; me: Me }>('quest.next');
      setMe(r.me);
      if (fresh) setRound({ n: 0, results: [], coins: 0, startLevel: r.me.level });
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
      setRound((x) => ({ ...x, n: x.n + 1, results: [...x.results, r.right], coins: x.coins + r.coins + r.bonus }));
      const msgs = [r.streakUp ? `🔥 ${r.streak} in a row! +${r.bonus} bonus 🪙` : '', r.me.level > r.levelBefore ? `⬆ Level ${r.me.level}!` : ''].filter(Boolean);
      if (msgs.length) { setToast(msgs.join('  ')); setTimeout(() => setToast(''), 3500); }
    } catch (e) { setErr((e as Error).message); setStep({ ...step, pick: undefined }); }
  }

  if (!me) return <div class="rq">{err ? <p class="error">{err}</p> : <p class="muted center">Loading…</p>}</div>;
  const per = me.perQuest;
  const capped = me.dailyCap > 0 && me.earnedToday >= me.dailyCap;

  const head = (
    <div class="rq-head" ref={top}>
      <button class="ghost" onClick={ctx.exit}>← Back</button>
      <div class="rq-level" title="Your Quest level grows as you get answers right">
        <b>Level {me.level}</b>
        <span class="rq-bar"><i style={{ width: `${Math.round(me.progress * 100)}%` }} /></span>
      </div>
      <span class={'rq-streak' + (me.streak ? ' hot' : '')} title={`Best: ${me.bestStreak} in a row`}>🔥 {me.streak}</span>
    </div>
  );

  if (step.at === 'start' || step.at === 'empty') return (
    <div class="rq">
      {head}
      <div class="rq-card rq-start">
        <h2>🧭 Reading Quest</h2>
        {step.at === 'empty'
          ? <p>You've read every paragraph there is right now — amazing! New ones come with updates.</p>
          : <>
            <p>{per} short paragraphs, one question each. About 5 minutes.</p>
            <p class="muted">Every {me.streakEvery} right in a row adds to your 🔥 streak and earns bonus coins.</p>
            {capped && <p class="muted">You've earned today's Reading Quest coins — you can still read for practice.</p>}
            <button class="primary big" onClick={() => next(true)}>Start the quest</button>
          </>}
        {err && <p class="error">{err}</p>}
      </div>
    </div>
  );

  if (step.at === 'done') {
    const right = round.results.filter(Boolean).length;
    return (
      <div class="rq">
        {head}
        <div class="rq-card rq-start">
          <h2>Quest complete! 🎉</h2>
          <p class="rq-big">{right} of {round.results.length} right{round.coins ? <> · +{round.coins} 🪙</> : null}</p>
          {me.level > round.startLevel && <p>⬆ You reached <b>Level {me.level}</b>!</p>}
          <p class="muted">🔥 Streak: {me.streak} · best {me.bestStreak}</p>
          <div class="row center">
            <button class="primary" onClick={() => next(true)}>Another quest</button>
            <button class="ghost" onClick={ctx.exit}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  const { p, pick, r } = step;
  const last = round.n >= per;
  return <QuestCard p={p} pick={pick} r={r} openAt={step.openAt} last={last} head={head} round={round} per={per} err={err} toast={toast} onAnswer={answer} onNext={() => (last ? setStep({ at: 'done' }) : next())} />;
}

/** One paragraph and its question. The answers unlock after the reading time (the PC checks it too). */
function QuestCard({ p, pick, r, openAt, last, head, round, per, err, toast, onAnswer, onNext }: {
  p: Shown; pick?: number; r?: Result; openAt: number; last: boolean; head: preact.JSX.Element; round: { n: number; results: boolean[] }; per: number;
  err: string; toast: string; onAnswer: (k: number) => void; onNext: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (Date.now() >= openAt) return; const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, [openAt]);
  const wait = Math.max(0, Math.ceil((openAt - now) / 1000));
  const locked = wait > 0 && !r;
  return (
    <div class="rq">
      {head}
      <div class="rq-dots" aria-label={`Paragraph ${Math.min(round.n + (r ? 0 : 1), per)} of ${per}`}>
        {Array.from({ length: per }, (_, i) => <i class={i < round.results.length ? (round.results[i] ? 'ok' : 'miss') : i === round.results.length ? 'now' : ''} />)}
      </div>
      <div class="rq-card">
        <h3 class="rq-title">{p.title}</h3>
        <Paragraph text={p.text} mark={r && !r.right ? r.evidence : undefined} />
        <p class="rq-credit">From {p.sourceName}{p.author ? `, by ${p.author}` : ''} · {p.license}</p>
        <div class="rq-q">{p.retry && <span class="rq-retry">Second look</span>}<b>{p.q}</b></div>
        {locked && <div class="rq-wait" role="timer"><span class="rq-ring" style={{ '--p': `${Math.round((1 - wait / p.readSeconds) * 100)}` } as any}>{wait}</span> Read the paragraph first — the answers open in {wait} second{wait === 1 ? '' : 's'}.</div>}
        <div class="rq-choices">
          {p.choices.map((c, k) => {
            const cls = !r ? (pick === k ? ' on' : '') : k === r.rightChoice ? ' right' : k === pick ? ' wrong' : ' dim';
            return <button class={'choice' + cls} disabled={locked || !!r || pick != null} onClick={() => onAnswer(k)}><span class="letter">{'ABCD'[k]}</span>{c}</button>;
          })}
        </div>
        {r && (
          <div class={'rq-feedback ' + (r.right ? 'ok' : 'miss')}>
            <b>{r.retry ? (r.right ? '✓ Got it this time!' : 'Not this time either — look at the highlighted words.')
              : r.right ? `✓ Right!${r.coins ? ` +${r.coins} 🪙` : ''}${r.pending ? ' (waiting for a parent)' : ''}` : 'Not quite — look at the highlighted words. This one will come back later.'}</b>
            <span>{r.explain}</span>
            <button class="primary" onClick={onNext}>{last ? 'Finish' : 'Next →'}</button>
          </div>
        )}
        {err && <p class="error">{err}</p>}
      </div>
      {toast && <div class="rq-toast">{toast}</div>}
    </div>
  );
}
