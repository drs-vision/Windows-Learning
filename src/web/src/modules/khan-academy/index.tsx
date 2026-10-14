import { render } from 'preact';
import type { Activity } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { bridge } from '../../core/bridge';
import { scoreKhanAcademy, DEFAULTS } from './score';

const SITES = ['khanacademy.org', 'kastatic.org', 'kasandbox.org'];

export const khanAcademy: LessonModule = {
  id: 'khan-academy',
  title: 'Khan Academy',
  tagline: 'Practice, quizzes and videos pay by themselves',
  description: 'Fully automatic, nothing to approve: while the child works on Khan Academy inside CoinQuest, every correct answer, finished video and finished exercise / quiz / unit test pays (amounts below; "coins per activity" is the finished-exercise bonus). The daily limit still applies.',
  icon: '🎓',
  verification: 'observed',
  options: [
    { key: 'perAnswer', label: 'Coins per correct answer', number: { min: -20, max: 20 }, default: '1' },
    { key: 'perVideo', label: 'Coins per finished video', number: { min: -50, max: 50 }, default: '3' },
  ],
  defaults: DEFAULTS,
  requiredSites: SITES,
  nextActivity(): Activity { return { moduleId: 'khan-academy', kind: 'observed', data: {}, issuedAt: 0 }; },
  mount(el, activity, ctx) { render(<KhanView activity={activity} ctx={ctx} />, el); return () => render(null, el); },
  score: scoreKhanAcademy,
};

function KhanView({ ctx }: { activity: Activity; ctx: ActivityContext }) {
  const o = ctx.settings.options ?? {};
  return (
    <div class="activity-intro">
      <h2>🎓 Khan Academy</h2>
      <p>Coins arrive by themselves while you work: <b>{o.perAnswer ?? 1} 🪙</b> per correct answer, <b>{ctx.settings.coinsPerActivity} 🪙</b> bonus for finishing an exercise, quiz or unit test, and <b>{o.perVideo ?? 3} 🪙</b> per finished video.</p>
      <button class="primary" onClick={() => bridge.openSite('https://www.khanacademy.org/', 'Khan Academy', SITES)}>Open Khan Academy ↗</button>
      <button class="ghost" onClick={ctx.exit}>Back</button>
    </div>
  );
}
