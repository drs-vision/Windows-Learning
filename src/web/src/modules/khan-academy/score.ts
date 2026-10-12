import type { Activity, Result, ModuleSettings, ScoreOutcome } from '../../core/types';
import { invalid } from '../../core/module';

/** coinsPerActivity = coins for a finished exercise, quiz or unit test. */
export const DEFAULTS = { coinsPerActivity: 5, dailyCap: 80 };

const n = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

/**
 * Fully automatic — nothing to approve. Seen inside CoinQuest's browser on Khan Academy: correct answers,
 * finished videos and finished exercises/quizzes/unit tests.
 */
export function scoreKhanAcademy(activity: Activity, result: Result, settings: ModuleSettings): ScoreOutcome {
  if (activity.kind !== 'observed') return invalid('Khan Academy pays automatically now — just do it in CoinQuest');
  const correct = n(result.data.correct, 30);
  const videos = n(result.data.video ?? result.data.videos, 5);
  const done = n(result.data.done, 3);
  if (correct + videos + done === 0) return invalid('nothing to count');
  const perAnswer = Number(settings.options?.perAnswer ?? 1);
  const perVideo = Number(settings.options?.perVideo ?? 3);
  const perTask = settings.coinsPerActivity;
  const parts = [
    done ? `${done} finished exercise/quiz${done > 1 ? 'zes' : ''}` : '',
    correct ? `${correct} correct answer${correct > 1 ? 's' : ''}` : '',
    videos ? `${videos} video${videos > 1 ? 's' : ''}` : '',
  ].filter(Boolean);
  return { valid: true, coins: correct * perAnswer + videos * perVideo + done * perTask, needsApproval: false, detail: `Khan Academy: ${parts.join(' + ')}` };
}
