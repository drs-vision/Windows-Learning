import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Activity, Progress } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { TypingBox, type TypingDone } from '../../core/ui/TypingBox';
import { scoreBibleTyping, DEFAULTS, passagePay, dayKey, wordCount } from './score';
import starter from '../../../../../content/bible/kjv-starter.json';

interface Passage { ref: string; level: number; text: string }
interface BTProgress extends Progress { done?: string[]; lastRef?: string; totalWords?: number; chosenRef?: string; today?: { day?: string; counts?: Record<string, number> } }

const PASSAGES: Passage[] = (starter as { passages: Passage[] }).passages;

/** Pay setting shared by every passage-typing quest: the coins are per this many words, rounded to the nearest. */
export const WORDS_PER_OPTION = { key: 'wordsPer', label: 'Words per payment', help: 'The coins are paid for every this many words, rounded to the nearest: with 20, a 9-word passage pays nothing, 10–29 words pay once, 30–49 twice. 0 = the same coins for every passage, whatever its length.', number: { min: 0, max: 500 }, default: '20' };

export const bibleTyping: LessonModule = {
  id: 'bible-typing',
  title: 'Scripture Typing',
  tagline: 'Type a passage, keep it forever',
  description: 'Type passages from the King James Bible (public domain). Pays per so many words (1 coin per 20 words to start), and each passage can earn a set number of times a day (so the same short one can\'t be repeated for coins). No speed or accuracy targets. Typing is errorless: a wrong key simply doesn\'t go in and the right key stays lit, so every finished passage is typed correctly and added to the child\'s collection. Verified automatically.',
  icon: '📖',
  verification: 'in_app',
  defaults: DEFAULTS,
  options: [
    WORDS_PER_OPTION,
    { key: 'repeatsPerDay', label: 'Each passage can earn', help: 'Typing a passage again after that still counts as practice, just without coins until tomorrow.', choices: [['1', 'Once a day'], ['2', 'Twice a day'], ['3', '3 times a day'], ['0', 'Any number of times']], default: '1' },
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
  const per = Number(ctx.settings.options?.wordsPer ?? '20') || 0;
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
      <p class="muted">{per > 0 ? `${ctx.settings.coinsPerActivity} 🪙 for every ${per} words.` : 'Every passage pays the same.'}{perDay > 0 ? ` Each one earns ${perDay === 1 ? 'once' : perDay === 2 ? 'twice' : perDay + ' times'} a day.` : ''} Take your time — there's no clock, and only the right key goes in.</p>
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
