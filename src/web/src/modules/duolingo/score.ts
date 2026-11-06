import type { Activity, Result, ModuleSettings, ScoreOutcome } from '../../core/types';
import { invalid } from '../../core/module';

/** coinsPerActivity = coins per finished Duolingo lesson. */
export const DEFAULTS = { coinsPerActivity: 5, dailyCap: 50 };

const n = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

/** Automatic: a lesson finished on Duolingo inside CoinQuest's browser. A story counts as a lesson. */
export function scoreDuolingo(activity: Activity, result: Result, settings: ModuleSettings): ScoreOutcome {
  if (activity.kind !== 'observed') return invalid('Duolingo pays automatically when a lesson is finished');
  const lessons = Math.min(3, n(result.data.lesson, 3) + n(result.data.story, 2));
  if (lessons === 0) return invalid('nothing to count');
  return { valid: true, coins: lessons * settings.coinsPerActivity, needsApproval: false, detail: `Duolingo: ${lessons} lesson${lessons > 1 ? 's' : ''} finished` };
}
