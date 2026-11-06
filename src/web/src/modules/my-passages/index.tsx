import { render } from 'preact';
import type { Activity, Progress } from '../../core/types';
import type { LessonModule } from '../../core/module';
import { PassageView, WORDS_PER_OPTION, REPEATS_OPTION, groupFor } from '../bible-typing';
import { scoreMyPassages, familyPassages, DEFAULTS } from './score';

interface MPProgress extends Progress { done?: string[]; totalWords?: number; chosenRef?: string; today?: { day?: string; counts?: Record<string, number> } }

/** Typing passages a parent pastes in (a poem, spelling words, a talk, a chapter). Same screen and rules as Scripture Typing. */
export const myPassages: LessonModule = {
  id: 'my-passages',
  title: 'Family Passages',
  tagline: 'Type the passages your parents picked',
  description: 'Your own passages: a poem, spelling words, a talk, a chapter. Same typing and pay as Scripture Typing.',
  icon: '📝',
  verification: 'in_app',
  paysByWords: true,
  defaults: DEFAULTS,
  options: [
    WORDS_PER_OPTION,
    REPEATS_OPTION,
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
      ? <PassageView activity={activity} ctx={ctx} groups={[groupFor('my-passages', 'From your family', list, ctx.settings, ctx.progress as MPProgress)]} />
      : <div class="activity-intro"><h2>📝 No passages yet</h2><p>Ask a parent to add some in the Parent Console.</p><button class="ghost" onClick={ctx.exit}>Back</button></div>, el);
    return () => render(null, el);
  },

  score: scoreMyPassages,
};
