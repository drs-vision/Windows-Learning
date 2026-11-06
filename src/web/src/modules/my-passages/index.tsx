import { render } from 'preact';
import type { Activity, Progress } from '../../core/types';
import type { LessonModule } from '../../core/module';
import { PassageView, WORDS_PER_OPTION } from '../bible-typing';
import { scoreMyPassages, familyPassages, DEFAULTS } from './score';

interface MPProgress extends Progress { done?: string[]; totalWords?: number; chosenRef?: string; today?: { day?: string; counts?: Record<string, number> } }

/** Typing passages a parent pastes in (a poem, spelling words, a talk, a chapter). Same screen and rules as Scripture Typing. */
export const myPassages: LessonModule = {
  id: 'my-passages',
  title: 'Family Passages',
  tagline: 'Type the passages your parents picked',
  description: 'Paste in anything you want your child to type — a poem, a speech, scripture, spelling words, a chapter — below. Pasted text is cleaned up to keyboard characters (curly quotes and long dashes become plain ones). Same rules as Scripture Typing: errorless typing, pays per so many words, and each passage earns once a day to start. Verified automatically.',
  icon: '📝',
  verification: 'in_app',
  defaults: DEFAULTS,
  options: [
    WORDS_PER_OPTION,
    { key: 'repeatsPerDay', label: 'Each passage can earn', help: 'Typing a passage again after that still counts as practice, just without coins until tomorrow.', choices: [['1', 'Once a day'], ['2', 'Twice a day'], ['3', '3 times a day'], ['0', 'Any number of times']], default: '1' },
  ],

  nextActivity(progress: MPProgress, _rng, settings): Activity {
    const list = familyPassages(settings);
    const done = progress.done ?? [];
    const next = list.find((p) => p.title === progress.chosenRef) ?? list.find((p) => !done.includes(p.title)) ?? list[0];
    return { moduleId: 'my-passages', kind: 'passage', data: { ref: next?.title ?? '', text: next?.text ?? '', done, totalWords: progress.totalWords ?? 0, today: progress.today ?? {} }, issuedAt: 0 };
  },

  mount(el, activity, ctx) {
    const list = familyPassages(ctx.settings).map((p) => ({ ref: p.title, text: p.text }));
    render(list.length
      ? <PassageView activity={activity} ctx={ctx} passages={list} />
      : <div class="activity-intro"><h2>📝 No passages yet</h2><p>Ask a parent to add some in the Parent Console.</p><button class="ghost" onClick={ctx.exit}>Back</button></div>, el);
    return () => render(null, el);
  },

  score: scoreMyPassages,
};
