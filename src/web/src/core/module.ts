import type { Activity, ModuleSettings, Progress, Result, ScoreOutcome, Scorer, Verification } from './types';

export interface ActivityContext {
  /**
   * Hand the finished result to the Guardian. Resolves with what it decided.
   * Pass `activity` when the child chose a different activity than the one issued (e.g. picked a passage);
   * the scorer must still be able to validate it against bundled content.
   */
  submit(result: Result, activity?: Activity): Promise<{ coins: number; pending: boolean; capped: boolean; detail: string; balance: number }>;
  /** Save module progress (not coin-bearing; opaque to the Guardian). */
  saveProgress(progress: Progress): Promise<void>;
  /** Leave the activity without submitting. */
  exit(): void;
  progress: Progress;
  settings: ModuleSettings;
}

export interface LessonModule {
  id: string;
  title: string;
  tagline: string;          // one line for the child
  description: string;      // one paragraph for the parent (Quests screen)
  icon: string;             // emoji is fine
  verification: Verification;
  defaults: { coinsPerActivity: number; dailyCap: number };
  requiredSites?: string[];
  /** Parent-facing settings shown on the Quests screen. Stored as strings in ModuleSettings.options. */
  options?: { key: string; label: string; help?: string; choices: [string, string][]; default: string }[];

  nextActivity(progress: Progress, rng: () => number): Activity;
  /** Mount the activity UI. Return a cleanup function. */
  mount(el: HTMLElement, activity: Activity, ctx: ActivityContext): () => void;
  score: Scorer;
}

/** Deterministic PRNG so "next activity" is reproducible from progress alone (mulberry32). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function invalid(reason: string): ScoreOutcome {
  return { valid: false, reason, coins: 0, needsApproval: false, detail: '' };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Levenshtein-free typing accuracy: proportion of characters typed correctly in position, penalising length mismatch. */
export function typingAccuracy(expected: string, typed: string): number {
  if (expected.length === 0) return 0;
  let correct = 0;
  const n = Math.min(expected.length, typed.length);
  for (let i = 0; i < n; i++) if (expected[i] === typed[i]) correct++;
  return clamp(correct / Math.max(expected.length, typed.length), 0, 1);
}

export function wordsPerMinute(chars: number, ms: number): number {
  if (ms <= 0) return 0;
  return (chars / 5) / (ms / 60000);
}

export function settingsOrDefault(s: Partial<ModuleSettings> | undefined, d: { coinsPerActivity: number; dailyCap: number }): ModuleSettings {
  return {
    enabled: s?.enabled ?? true,
    coinsPerActivity: s?.coinsPerActivity ?? d.coinsPerActivity,
    dailyCap: s?.dailyCap ?? d.dailyCap,
    requireApproval: s?.requireApproval ?? false,
    options: s?.options ?? {},
  };
}
