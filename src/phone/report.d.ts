export interface DayReport { v?: number; day: string; kid?: string; childId?: string; time?: { kind: string; label: string; sec: number }[]; typing?: { sessions: number; chars: number; ms: number; best: number }; done?: Record<string, number>; earned?: Record<string, number>; spent?: Record<string, number>; log?: { t: string; d: number; k: string; s: string; x: string }[]; reading?: { chapters: number; passed?: number; firstTry: number | null; wpm: number | null; level: number | null; verified: number; questLevel?: number | null } }
export const QUEST_NAMES: Record<string, string>;
export function dayKey(d: Date): string;
export function parseDay(s: string): Date;
export function weekStart(d: Date): Date;
export function daySeconds(r: DayReport | undefined): number;
export function fmtTime(sec: number): string;
export function calendarHtml(month: Date, byDay: Record<string, DayReport>, selected: string, mode: 'day' | 'week'): string;
export function rangeOf(selected: string, mode: 'day' | 'week'): string[];
export function titleOf(selected: string, mode: 'day' | 'week'): string;
export function reportHtml(reports: DayReport[], opts?: { title?: string; note?: string; readingLink?: boolean }): string;
export const REPORT_CSS: string;
export function step(selected: string, mode: 'day' | 'week', dir: number): string;
export function navHtml(selected: string, mode: 'day' | 'week', calendarOpen: boolean): string;
