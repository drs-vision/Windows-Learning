import { render } from 'preact';
import type { Activity } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { bridge } from '../../core/bridge';
import { scoreDuolingo, DEFAULTS } from './score';

const SITES = ['duolingo.com'];

export const duolingo: LessonModule = {
  id: 'duolingo',
  title: 'Duolingo',
  tagline: 'Finish a lesson, coins arrive by themselves',
  description: 'Coins arrive automatically for every Duolingo lesson or story finished inside CoinQuest (CoinQuest sees Duolingo save the finished lesson). Nothing to approve. The daily limit still applies. Lessons done on a phone or another browser are not counted.',
  icon: '🦉',
  verification: 'observed',
  options: [{ key: 'perStory', label: 'Coins per finished story', number: { min: 0, max: 50 }, default: '5' }],
  defaults: DEFAULTS,
  requiredSites: SITES,
  nextActivity(): Activity { return { moduleId: 'duolingo', kind: 'observed', data: {}, issuedAt: 0 }; },
  mount(el, activity, ctx) { render(<DuoView activity={activity} ctx={ctx} />, el); return () => render(null, el); },
  score: scoreDuolingo,
};

function DuoView({ ctx }: { activity: Activity; ctx: ActivityContext }) {
  return (
    <div class="activity-intro">
      <h2>🦉 Duolingo</h2>
      <p>Every lesson you finish on Duolingo here earns <b>{ctx.settings.coinsPerActivity} 🪙</b> — automatically, the moment Duolingo says “lesson complete”.</p>
      <button class="primary" onClick={() => bridge.openSite('https://www.duolingo.com/learn', 'Duolingo', SITES)}>Open Duolingo ↗</button>
      <button class="ghost" onClick={ctx.exit}>Back</button>
    </div>
  );
}
