import type { Activity, Result, ModuleSettings, ScoreOutcome } from '../../core/types';
import { invalid } from '../../core/module';

export const DEFAULTS = { coinsPerActivity: 35, dailyCap: 140 };

/** v1: a claim. The child says what they finished; the parent approves it. v2 will accept extension-observed completions. */
export function scoreKhanAcademy(activity: Activity, result: Result, settings: ModuleSettings): ScoreOutcome {
  const topic = String(result.data.topic ?? '').trim();
  const kind = String(result.data.kind ?? 'lesson');
  if (topic.length < 3) return invalid('tell us what you finished');
  if (topic.length > 120) return invalid('keep it short');
  const multiplier = kind === 'unitTest' ? 2 : kind === 'quiz' ? 1.5 : 1;
  const coins = Math.round(settings.coinsPerActivity * multiplier);
  const label = kind === 'unitTest' ? 'Unit test' : kind === 'quiz' ? 'Quiz' : 'Lesson';
  return { valid: true, coins, needsApproval: true, detail: `${label}: ${topic}` };
}
