import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Activity, Progress } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { TypingBox, type TypingDone } from '../../core/ui/TypingBox';
import { scoreBibleTyping, DEFAULTS, passagePay, dayKey, wordCount, wordsPerCoin } from './score';
import starter from '../../../../../content/bible/kjv-starter.json';

interface Passage { ref: string; level: number; text: string }
interface BTProgress extends Progress { done?: string[]; lastRef?: string; totalWords?: number; chosenRef?: string; today?: { day?: string; counts?: Record<string, number> } }

const PASSAGES: Passage[] = (starter as { passages: Passage[] }).passages;

/** Pay setting shared by every passage-typing quest: the coins are per this many words, rounded to the nearest. */
export const WORDS_PER_OPTION = { key: 'wordsPer', label: '1 🪙 per', suffix: 'words', help: 'Rounded to the nearest: with 20, a 9-word passage pays nothing, 10–29 words pay 1 coin, 30–49 pay 2.', number: { min: 1, max: 500 }, default: '20' };

/** The repeat limit shared by every passage quest. */
export const REPEATS_OPTION = { key: 'repeatsPerDay', label: 'Each passage pays', help: 'After that, typing it again is practice without coins until tomorrow.', choices: [['1', 'Once a day'], ['2', 'Twice a day'], ['3', '3 times a day'], ['0', 'Every time']] as [string, string][], default: '1' };

export const bibleTyping: LessonModule = {
  id: 'bible-typing',
  title: 'Scripture Typing',
  tagline: 'Type a passage, keep it forever',
  description: 'King James Bible passages. Typing is errorless (only the right key goes in) with no clock. Pays by length.',
  icon: '📖',
  verification: 'in_app',
  paysByWords: true,
  defaults: DEFAULTS,
  options: [
    WORDS_PER_OPTION,
    REPEATS_OPTION,
  ],

  nextActivity(progress: BTProgress): Activity {
    const done = progress.done ?? [];
    const chosen = progress.chosenRef ? PASSAGES.find((p) => p.ref === progress.chosenRef) : undefined;
    const next = chosen ?? PASSAGES.find((p) => !done.includes(p.ref)) ?? PASSAGES[0];
    return { moduleId: 'bible-typing', kind: 'passage', data: { ref: next.ref, text: next.text, done, totalWords: progress.totalWords ?? 0, today: progress.today ?? {} }, issuedAt: 0 };
  },

  mount(el, activity, ctx) {
    render(<PassageView activity={activity} ctx={ctx} passages={PASSAGES} />, el);
    return () => render(null, el);
  },

  score: scoreBibleTyping,
};

/** Pick a passage, type it (errorless), see the coins. Used by Scripture Typing and by the family's own passages. */
export function PassageView({ activity, ctx, passages }: { activity: Activity; ctx: ActivityContext; passages: { ref: string; text: string }[] }) {
  const [phase, setPhase] = useState<'pick' | 'type' | 'result'>('pick');
  const [passage, setPassage] = useState<{ ref: string; text: string }>({ ref: String(activity.data.ref), text: String(activity.data.text) });
  const [outcome, setOutcome] = useState<{ coins: number; detail: string } | null>(null);
  const [stats, setStats] = useState<TypingDone | null>(null);
  const [error, setError] = useState('');
  const done = (activity.data.done as string[]) ?? [];
  const today = activity.data.today as { day?: string; counts?: Record<string, number> } | undefined;
  const counts = today?.day === dayKey(Date.now()) ? today.counts ?? {} : {};
  const perDay = Number(ctx.settings.options?.repeatsPerDay ?? '1') || 0;
  const per = wordsPerCoin(ctx.settings);
  const words = (p: { text: string }) => wordCount(p.text);
  const usedUp = (p: { ref: string }) => perDay > 0 && (counts[p.ref] ?? 0) >= perDay;

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
        {passages.map((p) => (
          <button class={'passage' + (p.ref === passage.ref ? ' picked' : '') + (done.includes(p.ref) ? ' done' : '') + (usedUp(p) ? ' used' : '')} onClick={() => setPassage(p)}>
            <b>{p.ref}</b>
            <small>{words(p)} words · {usedUp(p) ? 'earned today ✓' : `+${passagePay(ctx.settings, words(p))} 🪙`}{done.includes(p.ref) && !usedUp(p) ? ' · ✓ typed' : ''}</small>
          </button>
        ))}
      </div>
      <p class="muted">{`1 🪙 for every ${per} words.`}{perDay > 0 ? ` Each one earns ${perDay === 1 ? 'once' : perDay === 2 ? 'twice' : perDay + ' times'} a day.` : ''} Take your time — there's no clock, and only the right key goes in.</p>
      {usedUp(passage) && <p class="muted"><b>{passage.ref}</b> has already earned today — you can still type it for practice, or pick another for coins.</p>}
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
      <h2>{outcome && outcome.coins > 0 ? 'Added to your collection' : outcome?.detail.includes('already earned') ? 'Great practice!' : 'Keep practicing'}</h2>
      <p>{outcome?.detail}</p>
      {outcome?.detail.includes('already earned') && <p class="muted">That passage has earned its coins for today. Pick a different one to earn more.</p>}
      <button class="primary" onClick={ctx.exit}>Continue</button>
    </div>
  );
}
