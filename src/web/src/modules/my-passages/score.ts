import type { Activity, Result, ModuleSettings, ScoreOutcome } from '../../core/types';
import { invalid, typingAccuracy, wordsPerMinute } from '../../core/module';
import { passagePay, dayKey, wordCount } from '../bible-typing/score';
import { isKeyboardText } from '../../core/keyboardText';

export const DEFAULTS = { coinsPerActivity: 1, dailyCap: 60 };

export interface FamilyPassage { id: string; title: string; text: string }

/** The parent's passages, kept as JSON in the module's "passages" option (so the Guardian's scorer sees them too). */
export function familyPassages(settings: Pick<ModuleSettings, 'options'> | undefined): FamilyPassage[] {
  try {
    const list = JSON.parse(settings?.options?.passages ?? '[]');
    return Array.isArray(list) ? list.filter((p) => p && typeof p.title === 'string' && typeof p.text === 'string' && p.text) : [];
  } catch { return []; }
}

/** Same rules as Scripture Typing: errorless typing, pay per so many words, a daily limit per passage. */
export function scoreMyPassages(activity: Activity, result: Result, settings: ModuleSettings): ScoreOutcome {
  const text = String(activity.data.text ?? '');
  const ref = String(activity.data.ref ?? '');
  const typed = String(result.data.typed ?? '');
  const durationMs = result.finishedAt - result.startedAt;
  if (!text || !ref) return invalid('no passage');
  const known = familyPassages(settings).find((p) => p.title === ref);
  if (!known || known.text !== text || !isKeyboardText(text)) return invalid('that passage has been changed or removed');
  if (typed.length === 0) return invalid('nothing typed');
  if (durationMs < 1000) return invalid('too fast to be real');
  if (wordsPerMinute(typed.length, durationMs) > 180) return invalid('implausible speed');
  const finished = typed === text || (typed.length >= text.length * 0.9 && typingAccuracy(text, typed) >= 0.5);
  if (!finished) return { valid: true, coins: 0, needsApproval: false, detail: `${ref} · not finished yet` };

  const words = wordCount(text);
  const day = dayKey(result.finishedAt);
  const prev = activity.data.today as { day?: string; counts?: Record<string, number> } | undefined;
  const counts = { ...(prev?.day === day ? prev.counts ?? {} : {}) };
  counts[ref] = (counts[ref] ?? 0) + 1;
  const done = Array.isArray(activity.data.done) ? (activity.data.done as string[]) : [];
  return {
    valid: true, coins: passagePay(settings, words), needsApproval: false,
    detail: `${ref} · ${words} words`,
    repeatKey: ref,
    progressDelta: { done: done.includes(ref) ? done : [...done, ref], lastRef: ref, totalWords: ((activity.data.totalWords as number) ?? 0) + words, today: { day, counts } },
  };
}
