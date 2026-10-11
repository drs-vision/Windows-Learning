// Shared types between the UI, the modules, and the scorers.
// Keep this file free of DOM/Preact imports: scorers.ts pulls from it and runs inside the Guardian.

export type Verification = 'in_app' | 'observed' | 'parent_approved';

export interface ModuleSettings {
  enabled: boolean;
  coinsPerActivity: number;
  dailyCap: number;
  requireApproval: boolean;
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
  kind: 'siteUnlock' | 'arcadeUnlock' | 'appUnlock' | 'screenTimeExtension' | 'realWorld';
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
  prizes: Prize[];
  modules: Record<string, ModuleSettings & { earnedToday: number }>;
  recent: LedgerEntry[];
  pendingClaims: PendingClaim[];
  progress: Record<string, Progress | null>;
  sites: string[];
}

export interface Child {
  id: string;
  displayName: string;
  windowsAccount: string;
  windowsSid: string;
  allowlist: { apps: string[]; sites: string[] };
  prizes: Prize[];
  modules: Record<string, ModuleSettings>;
  dailyScreenTimeCapMinutes?: number | null;
}

export interface ParentState {
  household: { id: string; name: string; children: Child[] };
  pendingClaims: PendingClaim[];
  perChild: Record<string, { balance: number; today: LedgerEntry[]; unlocks: Unlock[]; earnedToday: Record<string, number> }>;
  activeChildId?: string | null;
  version: string;
  updateStatus: { current: string; latest?: string | null; state: string; message?: string | null; lastChecked?: string | null };
  ledgerIntact: boolean;
}

export interface Game {
  id: string;
  title: string;
  author: string;
  kind: 'swf' | 'html5';
  license: string;
  url: string;
  genre: string;
  available: boolean;
}
