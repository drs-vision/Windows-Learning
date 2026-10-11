import type { Activity, Result, ModuleSettings, ScoreOutcome } from '../../core/types';
import { clamp, invalid, typingAccuracy, wordsPerMinute } from '../../core/module';
import starter from '../../../../../content/bible/kjv-starter.json';

const KNOWN: Record<string, string> = Object.fromEntries((starter as { passages: { ref: string; text: string }[] }).passages.map((p) => [p.ref, p.text]));

export const DEFAULTS = { coinsPerActivity: 15, dailyCap: 60 };

/** Coins scale with passage length (base = a 40-word passage) × accuracy. 90% accuracy or better for full credit. */
export function scoreBibleTyping(activity: Activity, result: Result, settings: ModuleSettings): ScoreOutcome {
  const text = String(activity.data.text ?? '');
  const ref = String(activity.data.ref ?? '');
  const typed = String(result.data.typed ?? '');
  const durationMs = result.finishedAt - result.startedAt;
  if (!text || !ref) return invalid('no passage');
  if (KNOWN[ref] !== text) return invalid('unknown passage');
  if (typed.length === 0) return invalid('nothing typed');
  if (durationMs < 1000) return invalid('too fast to be real');

  const accuracy = typingAccuracy(text, typed);
  const wpm = wordsPerMinute(typed.length, durationMs);
  if (wpm > 180) return invalid('implausible speed');
  if (accuracy < 0.5) return { valid: true, coins: 0, needsApproval: false, detail: `${ref} · ${Math.round(accuracy * 100)}% · not quite — try again` };

  const words = text.split(/\s+/).filter(Boolean).length;
  const lengthFactor = clamp(words / 40, 0.25, 3);
  const accuracyFactor = accuracy >= 0.9 ? 1 : accuracy >= 0.75 ? 0.6 : 0.3;
  const coins = Math.max(1, Math.round(settings.coinsPerActivity * lengthFactor * accuracyFactor));

  const done = Array.isArray(activity.data.done) ? (activity.data.done as string[]) : [];
  const nowDone = accuracy >= 0.9 && !done.includes(ref) ? [...done, ref] : done;

  return {
    valid: true, coins, needsApproval: false,
    detail: `${ref} · ${Math.round(accuracy * 100)}% · ${words} words · ${Math.round(wpm)} WPM`,
    progressDelta: { done: nowDone, lastRef: ref, totalWords: ((activity.data.totalWords as number) ?? 0) + (accuracy >= 0.9 ? words : 0) },
  };
}
