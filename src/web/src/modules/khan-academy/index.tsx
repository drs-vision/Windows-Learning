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
  description: 'The child works on Khan Academy in the browser, then tells CoinQuest what they finished. The claim shows up in Approvals for a parent to confirm. Lessons pay the base amount; quizzes pay 1.5×, unit tests 2×. A browser extension that verifies completions automatically is planned.',
  icon: '🎓',
  verification: 'parent_approved',
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
      <p>Do your work on Khan Academy, then come back here and tell us what you finished.</p>
      <button class="secondary" onClick={() => bridge.openBrowser('https://www.khanacademy.org/')}>Open Khan Academy ↗</button>
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
