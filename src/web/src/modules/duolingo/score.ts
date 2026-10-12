import type { Activity, Result, ModuleSettings, ScoreOutcome } from '../../core/types';
import { invalid } from '../../core/module';

/** coinsPerActivity = coins per finished Duolingo lesson. */
export const DEFAULTS = { coinsPerActivity: 5, dailyCap: 50 };

const n = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

/** Automatic: a lesson or story finished on Duolingo inside CoinQuest's browser. */
export function scoreDuolingo(activity: Activity, result: Result, settings: ModuleSettings): ScoreOutcome {
  if (activity.kind !== 'observed') return invalid('Duolingo pays automatically when a lesson is finished');
  const lessons = n(result.data.lesson, 3);
  const stories = n(result.data.story, 2);
  if (lessons + stories === 0) return invalid('nothing to count');
  const perStory = Number(settings.options?.perStory ?? settings.coinsPerActivity);
  const parts = [lessons ? `${lessons} lesson${lessons > 1 ? 's' : ''}` : '', stories ? `${stories} stor${stories > 1 ? 'ies' : 'y'}` : ''].filter(Boolean);
  return { valid: true, coins: lessons * settings.coinsPerActivity + stories * perStory, needsApproval: false, detail: `Duolingo: ${parts.join(' + ')} finished` };
}
