// Shared types between the UI, the modules, and the scorers.
// Keep this file free of DOM/Preact imports: scorers.ts pulls from it and runs inside the Guardian.

export type Verification = 'in_app' | 'observed' | 'parent_approved';

export interface ModuleSettings {
  enabled: boolean;
  coinsPerActivity: number;
  dailyCap: number;
  requireApproval: boolean;
  /** Module-specific parent settings (see LessonModule.options). */
  options?: Record<string, string>;
}

/** A thing the child is asked to do. Produced by nextActivity(); echoed back with the result. */
export interface Activity {
  moduleId: string;
  kind: string;
  /** Opaque, module-specific. Must contain everything score() needs to validate the result. */
  data: Record<string, unknown>;
  issuedAt: number; // ms epoch
}

/** What the child did. Produced by the module UI. */
export interface Result {
  startedAt: number;
  finishedAt: number;
  data: Record<string, unknown>;
}

export interface ScoreOutcome {
  valid: boolean;
  reason?: string;
  coins: number;
  needsApproval: boolean;
  detail: string;
  /** Shallow-merged into the child's stored progress for this module. */
  progressDelta?: Record<string, unknown>;
}

/** Pure scorer: same inputs → same outputs, no I/O, no Date.now(). Runs in the UI and in the Guardian. */
export type Scorer = (activity: Activity, result: Result, settings: ModuleSettings) => ScoreOutcome;

export type Progress = Record<string, unknown>;

export interface Unlock {
  id: string;
  kind: 'siteUnlock' | 'arcadeUnlock' | 'appUnlock' | 'screenTimeExtension' | 'realWorld' | 'youTube';
  targets: string[];
  prizeName: string;
  expiresAt: string;
  secondsLeft: number;
}

export interface Prize {
  id: string;
  name: string;
  cost: number;
  kind: Unlock['kind'];
  minutes: number;
  dailyCap: number;
  boughtToday: number;
  targets?: string[];
  enabled?: boolean;
}

export interface LedgerEntry {
  seq: number;
  at: string;
  kind: 'earn' | 'spend' | 'adjust' | 'claim' | 'claimApproved' | 'claimDenied';
  delta: number;
  source: string;
  detail: string;
}

export interface PendingClaim {
  ledgerSeq: number;
  childId: string;
  moduleId: string;
  coins: number;
  detail: string;
  at: string;
}

export interface ChildState {
  child: { id: string; displayName: string };
  balance: number;
  unlocks: Unlock[];
  prizes: (Prize & { boughtToday: number; blockPrice?: number | null; blockMinutes?: number })[];
  modules: Record<string, ModuleSettings & { earnedToday: number }>;
  recent: LedgerEntry[];
  pendingClaims: PendingClaim[];
  progress: Record<string, Progress | null>;
  sites: string[];
  youtubeChannels?: number;
  rwtInstalled?: boolean;
  discGames?: { id: string; title: string }[];
  arcadeMinutesPerPlay?: number;
}

export interface YouTubeChannel { id: string; title: string; url: string }
export interface WebGame { id: string; title: string; url: string; strategy: number }
export interface ArcadeSettings { minutesPerPlay: number; samplerMinutes?: number; samplerPrice?: number; priceOverrides: Record<string, number>; hidden: string[]; webGames: WebGame[]; flashpoint?: FlashpointGame[]; flashpointRoot?: string | null; autoClassics?: boolean; stockedPicks?: string[] }
export interface Video { id: string; title: string; channelId: string; channelTitle: string; published: string; thumbnail: string }

export interface Child {
  id: string;
  displayName: string;
  windowsAccount: string;
  windowsSid: string;
  allowlist: { apps: string[]; sites: string[] };
  prizes: Prize[];
  modules: Record<string, ModuleSettings>;
  dailyScreenTimeCapMinutes?: number | null;
  youTubeChannels?: YouTubeChannel[];
  arcade?: ArcadeSettings;
}

export interface ParentState {
  household: { id: string; name: string; children: Child[] };
  pendingClaims: PendingClaim[];
  perChild: Record<string, { balance: number; today: LedgerEntry[]; unlocks: Unlock[]; earnedToday: Record<string, number> }>;
  activeChildId?: string | null;
  version: string;
  updateStatus: { current: string; latest?: string | null; state: string; message?: string | null; lastChecked?: string | null };
  ledgerIntact: boolean;
  enforcement?: {
    consoleAccount?: string | null;
    childAtKeyboard: boolean;
    childAccount?: string | null;
    childSid?: string | null;
    browserLock: { appliedAt?: string | null; entries: number; error?: string | null; sid?: string | null };
    internetLock?: { applied: boolean; at?: string | null; error?: string | null };
  };
}

export interface Game {
  id: string;
  title: string;
  author: string;
  kind: 'swf' | 'html5' | 'web' | 'flashpoint' | 'classic';
  license: string;
  url: string;
  genre: string;
  available: boolean;
  strategy: number;
  price: number;
  hidden?: boolean;
  source?: 'bundled' | 'uploaded' | 'web' | 'flashpoint';
  thumbnail?: string;
  plays?: number;
}
export interface FlashpointGame { id: string; title: string; developer: string; genre: string; strategy: number }
export interface FpCatalogGame { id: string; title: string; developer: string; publisher: string; platform: string; tags: string; series: string; releaseDate: string; description: string }

/** More thinking = cheaper. Mirrors ArcadeSettings.DefaultPrice in Models.cs. */
/** Coins per 5 minutes of a game (must match ArcadeSettings.DefaultPrice). More thinking = cheaper. */
export const defaultArcadePrice = (strategy: number) => 9 - Math.max(1, Math.min(5, Math.round(strategy))); // 4 (heavy thinking) … 8 (pure reflex); must match ArcadeSettings.DefaultPrice
export const BLOCK_MINUTES = 5;
/** Must match ArcadeSettings.YouTubeBlockPrice: YouTube always costs more than the priciest arcade game. */
export function youTubeBlockPrice(cost: number, minutes: number, arcadePrices: number[]) {
  const own = minutes > 0 ? Math.ceil(cost / (minutes / BLOCK_MINUTES)) : cost;
  return Math.max(own, (arcadePrices.length ? Math.max(...arcadePrices) : defaultArcadePrice(1)) + 2);
}
/** Must match ArcadeSettings.AutoSamplerPrice. */
export function autoSamplerPrice(prices: number[], minutes: number) {
  const max = prices.length ? Math.max(...prices) : defaultArcadePrice(1);
  const blocks = Math.max(1, Math.ceil(minutes / BLOCK_MINUTES));
  return max * blocks + Math.max(2, Math.floor((max * blocks) / 5));
}
