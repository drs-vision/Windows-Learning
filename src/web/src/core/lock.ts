import type { LockSummary, LockTime } from './types';

/** The stored lock (mirrors the Guardian's ProfileLock; used by the dev mock). */
export interface StoredLock { until?: string | null; schedule: LockTime[]; openUntil?: string | null }
const FOREVER = '9999-12-31T23:59:59Z';

const mins = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };

/** If a scheduled lock covers now, when it ends (same rules as ProfileLockRules.Window). */
export function windowEnd(schedule: LockTime[], now: Date): Date | null {
  let end: Date | null = null, at = now;
  for (let guard = 0; guard < 16; guard++) {
    let next: Date | null = null;
    for (const t of schedule) {
      const f = mins(t.from), to = mins(t.to);
      if (f === null || to === null || f === to) continue;
      for (const back of [1, 0]) {
        const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() - back);
        if (!t.days.includes(day.getDay())) continue;
        const s = new Date(day.getTime() + f * 60000);
        const e = new Date(day.getTime() + to * 60000 + (to <= f ? 86400000 : 0));
        if (s <= at && at < e && (!next || e > next)) next = e;
      }
    }
    if (!next) break;
    end = next; at = next;
  }
  return end;
}

export function lockNow(l: StoredLock, now = new Date()): LockSummary {
  const opened = !!l.openUntil && new Date(l.openUntil) > now;
  if (l.until && new Date(l.until) > now && !opened) return { locked: true, until: l.until === FOREVER ? null : l.until, scheduled: false, schedule: l.schedule };
  if (!opened) { const w = windowEnd(l.schedule, now); if (w) return { locked: true, until: w.toISOString(), scheduled: true, schedule: l.schedule }; }
  return { locked: false, until: null, scheduled: false, schedule: l.schedule };
}

export function lockFor(l: StoredLock, minutes: number | null | undefined, now = new Date()): StoredLock {
  return { ...l, until: minutes ? new Date(now.getTime() + minutes * 60000).toISOString() : FOREVER, openUntil: null };
}
export function openLock(l: StoredLock, now = new Date()): StoredLock {
  const st = lockNow(l, now);
  const w = windowEnd(l.schedule, now);
  return { ...l, until: null, openUntil: w ? w.toISOString() : st.locked && st.until ? st.until : l.openUntil ?? null };
}

/** "5:00 PM", "Tue 7:00 AM" when it isn't today. */
export function untilText(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}

export const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Weekdays", "Sat, Sun", "Every day"… */
export function daysText(days: number[]): string {
  const d = [...new Set(days)].sort();
  if (d.length === 7) return 'Every day';
  if (d.join() === '1,2,3,4,5') return 'Weekdays';
  if (d.join() === '0,6') return 'Weekends';
  return d.map((x) => DAY_NAMES[x]).join(', ');
}
/** "16:00" → "4:00 PM" */
export function timeText(hhmm: string): string {
  const m = mins(hhmm); if (m === null) return hhmm;
  return new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
