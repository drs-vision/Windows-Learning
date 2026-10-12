import type { Activity, Result, ModuleSettings, ScoreOutcome } from '../../core/types';
import { clamp, invalid, typingAccuracy, wordsPerMinute } from '../../core/module';
import starter from '../../../../../content/bible/kjv-starter.json';

const KNOWN: Record<string, string> = Object.fromEntries((starter as { passages: { ref: string; text: string }[] }).passages.map((p) => [p.ref, p.text]));

export const DEFAULTS = { coinsPerActivity: 15, dailyCap: 60 };

/**
 * Coins scale with passage length only (base = a 40-word passage). No speed or accuracy targets: the typing screen
 * is errorless, so a finished passage is the whole passage, typed. The only checks are that it really was typed.
 */
export function scoreBibleTyping(activity: Activity, result: Result, settings: ModuleSettings): ScoreOutcome {
  const text = String(activity.data.text ?? '');
  const ref = String(activity.data.ref ?? '');
  const typed = String(result.data.typed ?? '');
  const durationMs = result.finishedAt - result.startedAt;
  if (!text || !ref) return invalid('no passage');
  if (KNOWN[ref] !== text) return invalid('unknown passage');
  if (typed.length === 0) return invalid('nothing typed');
  if (durationMs < 1000) return invalid('too fast to be real');

  const wpm = wordsPerMinute(typed.length, durationMs);
  if (wpm > 180) return invalid('implausible speed'); // not a penalty: no one types that fast, so it wasn't typed
  // Finished = the whole passage. (Older screens allowed mistakes; those still count if most of it matches.)
  const finished = typed === text || (typed.length >= text.length * 0.9 && typingAccuracy(text, typed) >= 0.5);
  if (!finished) return { valid: true, coins: 0, needsApproval: false, detail: `${ref} · not finished yet` };

  const words = text.split(/\s+/).filter(Boolean).length;
  const lengthFactor = clamp(words / 40, 0.25, 3);
  const coins = Math.max(1, Math.round(settings.coinsPerActivity * lengthFactor));

  const done = Array.isArray(activity.data.done) ? (activity.data.done as string[]) : [];
  const nowDone = !done.includes(ref) ? [...done, ref] : done;

  return {
    valid: true, coins, needsApproval: false,
    detail: `${ref} · ${words} words`,
    progressDelta: { done: nowDone, lastRef: ref, totalWords: ((activity.data.totalWords as number) ?? 0) + words },
  };
}
