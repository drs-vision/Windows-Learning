import type { Activity, Result, ModuleSettings, ScoreOutcome } from '../../core/types';
import { invalid, typingAccuracy, wordsPerMinute } from '../../core/module';
import starter from '../../../../../content/bible/kjv-starter.json';

const KNOWN: Record<string, string> = Object.fromEntries((starter as { passages: { ref: string; text: string }[] }).passages.map((p) => [p.ref, p.text]));

export const DEFAULTS = { coinsPerActivity: 15, dailyCap: 60 };

/** Local calendar day of a timestamp, e.g. "2026-10-17". */
export const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * What a finished passage pays. Parent's choice (option "wordsPer"): the set coins for every passage (0), or the set
 * coins for every N words, so longer passages pay more. A negative rate charges instead; a positive one pays at least 1.
 */
export function passagePay(settings: ModuleSettings, words: number): number {
  const base = settings.coinsPerActivity;
  const per = Math.max(0, Number(settings.options?.wordsPer ?? 0) || 0);
  if (!per || !base) return base;
  const raw = Math.round(base * words / per);
  return base < 0 ? Math.min(-1, raw) : Math.max(1, raw);
}

/**
 * Pays per passage or per N words (parent's choice, see passagePay). No speed or accuracy targets: the typing screen
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
  const coins = passagePay(settings, words);

  const done = Array.isArray(activity.data.done) ? (activity.data.done as string[]) : [];
  const nowDone = !done.includes(ref) ? [...done, ref] : done;
  // Times typed today, per passage (for the picker; the Guardian enforces the daily limit from the ledger).
  const day = dayKey(result.finishedAt);
  const prev = activity.data.today as { day?: string; counts?: Record<string, number> } | undefined;
  const counts = { ...(prev?.day === day ? prev.counts ?? {} : {}) };
  counts[ref] = (counts[ref] ?? 0) + 1;

  return {
    valid: true, coins, needsApproval: false,
    detail: `${ref} · ${words} words`,
    repeatKey: ref,
    progressDelta: { done: nowDone, lastRef: ref, totalWords: ((activity.data.totalWords as number) ?? 0) + words, today: { day, counts } },
  };
}
