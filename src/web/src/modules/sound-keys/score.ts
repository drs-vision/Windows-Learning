import type { Activity, Result, ModuleSettings, ScoreOutcome } from '../../core/types';
import { invalid } from '../../core/module';
import { LESSONS, buildLesson, totalItems } from './content';

export const DEFAULTS = { coinsPerActivity: 12, dailyCap: 100 };
/** First-try share needed to move on. Below it, the lesson repeats (with a fresh shuffle) — never a "fail" screen. */
export const MASTERY = 0.8;

/**
 * Pure scorer. The Guardian rebuilds the lesson from (lessonId, seed) and checks that every item was actually typed.
 * result.data = { typed: string[] (one entry per item, in order), firstTry: boolean[] }
 */
export function scoreSoundKeys(activity: Activity, result: Result, settings: ModuleSettings): ScoreOutcome {
  const lessonId = Number(activity.data.lessonId);
  const seed = Number(activity.data.seed ?? 0);
  const lesson = LESSONS.find((l) => l.id === lessonId);
  if (!lesson) return invalid('unknown lesson');
  const current = Math.max(1, Number(activity.data.current ?? 1));
  if (lessonId > current) return invalid('that lesson is still locked');
  const steps = buildLesson(lessonId, seed);
  const expected = steps.flatMap((s) => s.items);
  const typed = Array.isArray(result.data.typed) ? (result.data.typed as unknown[]).map(String) : [];
  const firstTry = Array.isArray(result.data.firstTry) ? (result.data.firstTry as unknown[]).map(Boolean) : [];
  if (typed.length !== expected.length || firstTry.length !== expected.length) return invalid('lesson not finished');
  for (let i = 0; i < expected.length; i++) if (typed[i] !== expected[i]) return invalid('typed text does not match the lesson');
  const ms = result.finishedAt - result.startedAt;
  if (ms < totalItems(steps) * 300) return invalid('too fast to be real');

  const ratio = firstTry.filter(Boolean).length / expected.length;
  const mastered = ratio >= MASTERY;
  const coins = Math.round(settings.coinsPerActivity * (0.5 + 0.5 * ratio)) + (mastered && lesson.kind === 'review' ? Math.round(settings.coinsPerActivity / 2) : 0);
  const last = LESSONS[LESSONS.length - 1].id;
  const done = Array.isArray(activity.data.done) ? (activity.data.done as number[]) : [];
  return {
    valid: true, coins, needsApproval: false,
    detail: `${lesson.title} · ${Math.round(ratio * 100)}% first try${mastered ? '' : ' · will practise again'}`,
    progressDelta: {
      lesson: Math.min(last, Math.max(current, mastered ? lessonId + 1 : lessonId)),
      done: mastered && !done.includes(lessonId) ? [...done, lessonId] : done,
      seed: seed + 1,
      lastRatio: Math.round(ratio * 100),
    },
  };
}
