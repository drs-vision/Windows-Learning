import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Activity, Progress } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { TypingBox, type TypingDone } from '../../core/ui/TypingBox';
import { scoreBibleTyping, DEFAULTS } from './score';
import starter from '../../../../../content/bible/kjv-starter.json';

interface Passage { ref: string; level: number; text: string }
interface BTProgress extends Progress { done?: string[]; lastRef?: string; totalWords?: number; chosenRef?: string }

const PASSAGES: Passage[] = (starter as { passages: Passage[] }).passages;

export const bibleTyping: LessonModule = {
  id: 'bible-typing',
  title: 'Scripture Typing',
  tagline: 'Type a passage, keep it forever',
  description: 'Type passages from the King James Bible (public domain). Every finished passage earns the same coins, short or long — no speed or accuracy targets. Typing is errorless: a wrong key simply doesn\'t go in and the right key stays lit, so every finished passage is typed correctly and added to the child\'s collection. Verified automatically.',
  icon: '📖',
  verification: 'in_app',
  defaults: DEFAULTS,

  nextActivity(progress: BTProgress): Activity {
    const done = progress.done ?? [];
    const chosen = progress.chosenRef ? PASSAGES.find((p) => p.ref === progress.chosenRef) : undefined;
    const next = chosen ?? PASSAGES.find((p) => !done.includes(p.ref)) ?? PASSAGES[0];
    return { moduleId: 'bible-typing', kind: 'passage', data: { ref: next.ref, text: next.text, done, totalWords: progress.totalWords ?? 0 }, issuedAt: 0 };
  },

  mount(el, activity, ctx) {
    render(<BibleView activity={activity} ctx={ctx} />, el);
    return () => render(null, el);
  },

  score: scoreBibleTyping,
};

function BibleView({ activity, ctx }: { activity: Activity; ctx: ActivityContext }) {
  const [phase, setPhase] = useState<'pick' | 'type' | 'result'>('pick');
  const [passage, setPassage] = useState<Passage>({ ref: String(activity.data.ref), level: 1, text: String(activity.data.text) });
  const [outcome, setOutcome] = useState<{ coins: number; detail: string } | null>(null);
  const [stats, setStats] = useState<TypingDone | null>(null);
  const [error, setError] = useState('');
  const done = (activity.data.done as string[]) ?? [];

  // When the child picks a different passage we re-issue the activity so the Guardian scores the right text.
  useEffect(() => { ctx.saveProgress({ ...ctx.progress, chosenRef: passage.ref }); }, [passage.ref]);

  async function onTyped(t: TypingDone) {
    setStats(t);
    try {
      // Submit against the passage the child picked. The scorer checks ref ⇄ text against the bundled content.
      const act = { ...activity, data: { ...activity.data, ref: passage.ref, text: passage.text } };
      const r = await ctx.submit({ startedAt: t.startedAt, finishedAt: t.finishedAt, data: { typed: t.typed } }, act);
      setOutcome(r); setPhase('result');
    } catch (e) { setError((e as Error).message); }
  }

  if (phase === 'pick') return (
    <div class="activity-intro">
      <h2>Pick a passage</h2>
      <div class="passage-list">
        {PASSAGES.map((p) => (
          <button class={'passage' + (p.ref === passage.ref ? ' picked' : '') + (done.includes(p.ref) ? ' done' : '')} onClick={() => setPassage(p)}>
            <b>{p.ref}</b><small>{p.text.split(' ').length} words{done.includes(p.ref) ? ' · ✓ typed' : ''}</small>
          </button>
        ))}
      </div>
      <p class="muted">Longer passages pay more. Take your time — there's no clock, and only the right key goes in.</p>
      <button class="primary" onClick={() => setPhase('type')}>Type {passage.ref}</button>
      <button class="ghost" onClick={ctx.exit}>Back</button>
    </div>
  );

  if (phase === 'type') return (
    <div class="activity">
      <h3 class="passage-ref">{passage.ref}</h3>
      <TypingBox text={passage.text} onDone={onTyped} errorless highlightKeys="" />
      {error && <p class="error">{error} <button class="ghost small" onClick={() => { setError(''); setPhase('pick'); }}>Try again</button></p>}
      {!error && <button class="ghost small" onClick={() => setPhase('pick')}>Quit</button>}
    </div>
  );

  return (
    <div class="activity-result">
      <div class="coins-earned">{outcome?.coins ?? 0} 🪙</div>
      <h2>{outcome && outcome.coins > 0 ? 'Added to your collection' : 'Keep practicing'}</h2>
      <p>{outcome?.detail}</p>
      <button class="primary" onClick={ctx.exit}>Continue</button>
    </div>
  );
}
