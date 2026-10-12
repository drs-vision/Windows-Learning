// Entry point for the scorers bundle (dist/scorers.js). Loaded by the Guardian into a sandboxed JS
// engine and by the mock Guardian in the browser. MUST stay pure: no DOM, no Date.now(), no imports
// that touch the environment.

import type { Activity, ModuleSettings, Result, ScoreOutcome } from './core/types';
import { settingsOrDefault } from './core/module';
import { scoreTypingQuest, DEFAULTS as TQ } from './modules/typing-quest/score';
import { scoreSoundKeys, DEFAULTS as SK } from './modules/sound-keys/score';
import { scoreBibleTyping, DEFAULTS as BT } from './modules/bible-typing/score';
import { scoreKhanAcademy, DEFAULTS as KA } from './modules/khan-academy/score';

const scorers: Record<string, { fn: (a: Activity, r: Result, s: ModuleSettings) => ScoreOutcome; defaults: { coinsPerActivity: number; dailyCap: number } }> = {
  'sound-keys': { fn: scoreSoundKeys, defaults: SK },
  'typing-quest': { fn: scoreTypingQuest, defaults: TQ },
  'bible-typing': { fn: scoreBibleTyping, defaults: BT },
  'khan-academy': { fn: scoreKhanAcademy, defaults: KA },
};

export function scoreModule(moduleId: string, activity: Activity, result: Result, settings: Partial<ModuleSettings> | undefined): ScoreOutcome {
  const s = scorers[moduleId];
  if (!s) return { valid: false, reason: `unknown module ${moduleId}`, coins: 0, needsApproval: false, detail: '' };
  try {
    const out = s.fn(activity, result, settingsOrDefault(settings, s.defaults));
    // Belt and braces: never mint more than 5× the base per activity, never negative.
    const cap = settingsOrDefault(settings, s.defaults).coinsPerActivity * 5;
    return { ...out, coins: Math.max(0, Math.min(cap, Math.round(out.coins || 0))) };
  } catch (e) {
    return { valid: false, reason: 'scorer error: ' + (e as Error).message, coins: 0, needsApproval: false, detail: '' };
  }
}

export const score = scoreModule;
// Global for Jint: globalThis.CoinQuestScorers.score(...)
(globalThis as any).CoinQuestScorers = { score: scoreModule, modules: Object.keys(scorers) };
