// Entry point for the scorers bundle (dist/scorers.js). Loaded by the Guardian into a sandboxed JS
// engine and by the mock Guardian in the browser. MUST stay pure: no DOM, no Date.now(), no imports
// that touch the environment.

import type { Activity, ModuleSettings, Result, ScoreOutcome } from './core/types';
import { settingsOrDefault } from './core/module';
import { scoreTypingQuest, DEFAULTS as TQ } from './modules/typing-quest/score';
import { scoreSoundKeys, DEFAULTS as SK } from './modules/sound-keys/score';
import { LESSONS as SK_LESSONS, buildLesson as skBuildLesson } from './modules/sound-keys/content';
import { scoreBibleTyping, DEFAULTS as BT } from './modules/bible-typing/score';
import { scoreKhanAcademy, DEFAULTS as KA } from './modules/khan-academy/score';
import { scoreDuolingo, DEFAULTS as DU } from './modules/duolingo/score';

const scorers: Record<string, { fn: (a: Activity, r: Result, s: ModuleSettings) => ScoreOutcome; defaults: { coinsPerActivity: number; dailyCap: number } }> = {
  'sound-keys': { fn: scoreSoundKeys, defaults: SK },
  'typing-quest': { fn: scoreTypingQuest, defaults: TQ },
  'bible-typing': { fn: scoreBibleTyping, defaults: BT },
  'khan-academy': { fn: scoreKhanAcademy, defaults: KA },
  'duolingo': { fn: scoreDuolingo, defaults: DU },
};

export function scoreModule(moduleId: string, activity: Activity, result: Result, settings: Partial<ModuleSettings> | undefined): ScoreOutcome {
  const s = scorers[moduleId];
  if (!s) return { valid: false, reason: `unknown module ${moduleId}`, coins: 0, needsApproval: false, detail: '' };
  try {
    const st = settingsOrDefault(settings, s.defaults);
    const out = s.fn(activity, result, st);
    // Belt and braces: never more than 5× the set amount per activity, either way (a parent's negative rate charges).
    // Scripture paid per N words may go higher: up to what the passage's length allows.
    let times = 5;
    const per = Number(st.options?.wordsPer ?? 0);
    if (moduleId === 'bible-typing' && per > 0) times = Math.max(5, Math.ceil(String(activity?.data?.text ?? '').split(/\s+/).filter(Boolean).length / per) + 1);
    const cap = Math.max(Math.abs(st.coinsPerActivity) * times, moduleId === 'khan-academy' ? 60 : 0);
    return { ...out, coins: Math.max(-cap, Math.min(cap, Math.round(out.coins || 0))) };
  } catch (e) {
    return { valid: false, reason: 'scorer error: ' + (e as Error).message, coins: 0, needsApproval: false, detail: '' };
  }
}

export const score = scoreModule;
// Global for Jint: globalThis.CoinQuestScorers.score(...)
(globalThis as any).CoinQuestScorers = {
  score: scoreModule, modules: Object.keys(scorers),
  // For the Guardian's tests: what a lesson asks the child to type, so every lesson can be scored end to end.
  soundKeysLessonCount: () => SK_LESSONS.length,
  soundKeysItems: (lessonId: number, seed: number) => skBuildLesson(lessonId, seed).flatMap((s) => s.items),
};
