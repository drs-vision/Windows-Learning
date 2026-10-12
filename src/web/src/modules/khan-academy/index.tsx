import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { Activity } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { bridge } from '../../core/bridge';
import { scoreKhanAcademy, DEFAULTS } from './score';

export const khanAcademy: LessonModule = {
  id: 'khan-academy',
  title: 'Khan Academy',
  tagline: 'Finish a lesson, claim your coins',
  description: 'Coins arrive automatically while the child works on Khan Academy inside CoinQuest: every correct answer and every finished video pays (set below). The daily limit still applies. The child can also claim a finished lesson, quiz or unit test by hand; those claims wait for your OK in Approvals.',
  icon: '🎓',
  verification: 'observed',
  options: [
    { key: 'perAnswer', label: 'Coins per correct answer', number: { min: 0, max: 50 }, default: '2' },
    { key: 'perVideo', label: 'Coins per finished video', number: { min: 0, max: 100 }, default: '5' },
  ],
  defaults: DEFAULTS,
  requiredSites: ['khanacademy.org', 'kastatic.org', 'kasandbox.org'],

  nextActivity(): Activity {
    return { moduleId: 'khan-academy', kind: 'claim', data: {}, issuedAt: 0 };
  },

  mount(el, activity, ctx) {
    render(<KhanView activity={activity} ctx={ctx} />, el);
    return () => render(null, el);
  },

  score: scoreKhanAcademy,
};

function KhanView({ ctx }: { activity: Activity; ctx: ActivityContext }) {
  const [topic, setTopic] = useState('');
  const [kind, setKind] = useState<'lesson' | 'quiz' | 'unitTest'>('lesson');
  const [done, setDone] = useState<{ coins: number } | null>(null);
  const [error, setError] = useState('');
  const base = ctx.settings.coinsPerActivity;

  async function claim() {
    try {
      const r = await ctx.submit({ startedAt: Date.now() - 1000, finishedAt: Date.now(), data: { topic, kind } });
      setDone(r);
    } catch (e) { setError((e as Error).message); }
  }

  if (done) return (
    <div class="activity-result">
      <div class="coins-earned pending">{done.coins} 🪙</div>
      <h2>Sent to your parent</h2>
      <p>Once they approve it, the coins land in your wallet.</p>
      <button class="primary" onClick={ctx.exit}>OK</button>
    </div>
  );

  return (
    <div class="activity-intro">
      <h2>Khan Academy</h2>
      <p>Every correct answer and finished video on Khan Academy earns coins automatically — {ctx.settings.options?.perAnswer ?? 2} 🪙 per correct answer. Finished a whole unit test? Claim the bonus below.</p>
      <button class="secondary" onClick={() => bridge.openSite('https://www.khanacademy.org/', 'Khan Academy', ['khanacademy.org', 'kastatic.org', 'kasandbox.org'])}>Open Khan Academy ↗</button>
      <div class="form">
        <label>What did you finish?<input value={topic} onInput={(e) => setTopic((e.target as HTMLInputElement).value)} placeholder="e.g. Multiplying fractions" maxLength={120} /></label>
        <div class="segmented">
          {([['lesson', `Lesson · ${base}`], ['quiz', `Quiz · ${Math.round(base * 1.5)}`], ['unitTest', `Unit test · ${base * 2}`]] as const).map(([k, label]) => (
            <button class={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{label} 🪙</button>
          ))}
        </div>
      </div>
      {error && <p class="error">{error}</p>}
      <button class="primary" disabled={topic.trim().length < 3} onClick={claim}>Claim coins</button>
      <button class="ghost" onClick={ctx.exit}>Back</button>
    </div>
  );
}
