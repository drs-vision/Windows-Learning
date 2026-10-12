import type { Activity, Result, ModuleSettings, ScoreOutcome } from '../../core/types';
import { invalid } from '../../core/module';

export const DEFAULTS = { coinsPerActivity: 35, dailyCap: 140 };

/** v1: a claim. The child says what they finished; the parent approves it. v2 will accept extension-observed completions. */
export function scoreKhanAcademy(activity: Activity, result: Result, settings: ModuleSettings): ScoreOutcome {
  if (activity.kind === 'observed') {
    // Seen automatically inside CoinQuest's browser: correct answers and finished videos on Khan Academy.
    const correct = Math.max(0, Math.min(30, Math.floor(Number(result.data.correct) || 0)));
    const videos = Math.max(0, Math.min(5, Math.floor(Number(result.data.videos) || 0)));
    if (correct + videos === 0) return invalid('nothing to count');
    const perAnswer = Number(settings.options?.perAnswer ?? 2);
    const perVideo = Number(settings.options?.perVideo ?? 5);
    const parts = [correct ? `${correct} correct answer${correct > 1 ? 's' : ''}` : '', videos ? `${videos} video${videos > 1 ? 's' : ''}` : ''].filter(Boolean);
    return { valid: true, coins: correct * perAnswer + videos * perVideo, needsApproval: false, detail: `Khan Academy: ${parts.join(' + ')}` };
  }
  const topic = String(result.data.topic ?? '').trim();
  const kind = String(result.data.kind ?? 'lesson');
  if (topic.length < 3) return invalid('tell us what you finished');
  if (topic.length > 120) return invalid('keep it short');
  const multiplier = kind === 'unitTest' ? 2 : kind === 'quiz' ? 1.5 : 1;
  const coins = Math.round(settings.coinsPerActivity * multiplier);
  const label = kind === 'unitTest' ? 'Unit test' : kind === 'quiz' ? 'Quiz' : 'Lesson';
  return { valid: true, coins, needsApproval: true, detail: `${label}: ${topic}` };
}
