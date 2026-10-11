import type { Activity, Result, ModuleSettings, ScoreOutcome } from '../../core/types';
import { clamp, invalid, typingAccuracy, wordsPerMinute } from '../../core/module';
import { LANES, laneForPlacement } from './content';

export const DEFAULTS = { coinsPerActivity: 10, dailyCap: 80 };

/**
 * Pure scorer. Everything needed to validate is in activity.data (issued by nextActivity) and result.data.
 * We recompute accuracy and WPM ourselves — the client's numbers are never trusted.
 */
export function scoreTypingQuest(activity: Activity, result: Result, settings: ModuleSettings): ScoreOutcome {
  const text = String(activity.data.text ?? '');
  const typed = String(result.data.typed ?? '');
  const durationMs = result.finishedAt - result.startedAt;
  if (!text) return invalid('no text');
  if (durationMs < 500) return invalid('too fast to be real');
  if (typed.length === 0) return invalid('nothing typed');

  const accuracy = typingAccuracy(text, typed);
  const wpm = wordsPerMinute(typed.length, durationMs);
  if (wpm > 180) return invalid('implausible speed');

  const base = settings.coinsPerActivity;

  if (activity.kind === 'placement') {
    const lane = laneForPlacement(wpm, accuracy);
    return {
      valid: true, coins: Math.round(base / 2), needsApproval: false,
      detail: `Placement test · ${Math.round(wpm)} WPM · ${Math.round(accuracy * 100)}%`,
      progressDelta: { placed: true, lane, drill: 0, bestWpm: Math.round(wpm), placementWpm: Math.round(wpm) },
    };
  }

  const laneIdx = Number(activity.data.lane ?? 0);
  const drillIdx = Number(activity.data.drill ?? 0);
  const lane = LANES[laneIdx];
  if (!lane || !lane.drills[drillIdx]) return invalid('unknown drill');
  if (lane.drills[drillIdx].text !== text) return invalid('drill text mismatch');

  const passedAccuracy = accuracy >= lane.minAccuracy;
  const isTimed = lane.drills[drillIdx].kind === 'timed';
  const passedSpeed = !isTimed || wpm >= lane.targetWpm;

  // Comprehension questions (passages): must answer all to pass; each wrong answer costs a bit.
  let qScore = 1;
  const questions = lane.drills[drillIdx].questions;
  if (questions && questions.length) {
    const answers = Array.isArray(result.data.answers) ? (result.data.answers as number[]) : [];
    if (answers.length !== questions.length) return invalid('answer the questions first');
    const right = questions.filter((q, i) => q.answer === answers[i]).length;
    qScore = right / questions.length;
  }

  const passed = passedAccuracy && passedSpeed && qScore >= 0.5;
  let coins = passed ? base : Math.round(base * 0.3);
  if (passed && isTimed && wpm >= lane.targetWpm * 1.25) coins += Math.round(base * 0.5); // speed bonus
  if (questions?.length) coins = Math.round(coins * clamp(qScore, 0.5, 1));

  const prevBest = Number((activity.data.bestWpm as number) ?? 0);
  const bestWpm = Math.max(prevBest, Math.round(wpm));

  // Advance on pass; weak lanes get re-queued by the UI (nextActivity) using the history we return.
  let nextLane = laneIdx, nextDrill = drillIdx;
  if (passed) {
    nextDrill = drillIdx + 1;
    if (nextDrill >= lane.drills.length) { nextLane = Math.min(laneIdx + 1, LANES.length - 1); nextDrill = nextLane === laneIdx ? drillIdx : 0; }
  }

  const detail = `${lane.name} ${drillIdx + 1}/${lane.drills.length} · ${Math.round(wpm)} WPM · ${Math.round(accuracy * 100)}%${passed ? '' : ' · try again'}`;
  return {
    valid: true, coins, needsApproval: false, detail,
    progressDelta: { lane: nextLane, drill: nextDrill, bestWpm, lastAccuracy: Math.round(accuracy * 100), completed: passed ? ((activity.data.completed as number) ?? 0) + 1 : (activity.data.completed as number) ?? 0 },
  };
}
