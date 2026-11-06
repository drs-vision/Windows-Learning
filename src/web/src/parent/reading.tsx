import { useEffect, useRef, useState } from 'preact/hooks';
import { bridge } from '../core/bridge';
import * as rd from '../../../phone/reading.js';

/** The PC's reading analysis (ReadingReport.cs): plain rules, so a parent can check every number by hand. */
export interface ReadingRow { at: string; book: string; chapter: number | null; title: string; level: number; formula: number | null; atos: number | null; lexile: number | null; read?: boolean; quizzed?: boolean; firstTry: number | null; correct: number; total: number; tries: number; passed: boolean; wpm: number | null; status: 'comfortable' | 'challenge' | 'hard' | 'read' }
export interface ReadingData {
  kid?: string;
  comfortable: number; comfortableAtos: number | null; comfortableLexile: number | null; comfortableFormula: number | null; current: number | null;
  stretch: { chapters: number; firstTry: number | null; level: number };
  firstTry30: number | null; firstTryAll: number | null; chapters30: number; wpm: number | null;
  chaptersPassed: number; wordsRead: number; minutesReading: number;
  chaptersRead?: number; chaptersRead30?: number; chaptersQuizzed?: number; wpmLow?: number | null; wpmHigh?: number | null; wpmChapters?: number;
  windowDays: number; strongPercent: number; strongNeeded: number;
  levels: { level: number; read?: number; words?: number; wpm?: number | null; chapters: number; strong: number; firstTry: number | null }[];
  weeks: { start: string; chapters: number; firstTry: number | null; wpm: number | null }[];
  recent: ReadingRow[];
}

/** Reading Quest numbers (ReadingQuest.Report). */
export interface QuestData {
  rating: number; level: number; answered: number; percent30: number | null; answered30: number; percentAll: number | null;
  streak: number; bestStreak: number; wpm: number | null; minutes: number;
  history: { day: string; rating: number }[];
  types: { type: string; answered: number; right: number; percent: number }[];
  bands: { grade: number; answered: number; percent: number }[];
  pool: number; left: number;
}

const OPEN_KEY = 'cq.parent.readingOpen';

/**
 * The reading dashboard (Today → Reading tile): books and Reading Quest together, drawn by the same code as the phone
 * (src/phone/reading.js). Sections open one at a time; the one left open is remembered.
 */
export function ReadingAnalysis({ childId, kid, onBack }: { childId: string; kid: string; onBack: () => void }) {
  const [books, setBooks] = useState<ReadingData | null>(null);
  const [quest, setQuest] = useState<QuestData | null>(null);
  const [err, setErr] = useState('');
  const [loaded, setLoaded] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const open = (() => { try { return localStorage.getItem(OPEN_KEY) ?? ''; } catch { return ''; } })();
  useEffect(() => {
    Promise.allSettled([bridge.parentReading(childId), bridge.parentQuest(childId)]).then(([b, q]) => {
      if (b.status === 'fulfilled') setBooks(b.value); else setErr((b.reason as Error).message);
      if (q.status === 'fulfilled') setQuest(q.value);
      setLoaded(true);
    });
  }, [childId]);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onToggle = (e: Event) => {
      const sec = (e.target as HTMLElement).closest?.('details[data-rd-sec]') as HTMLDetailsElement | null;
      if (!sec) return;
      try {
        if (sec.open) localStorage.setItem(OPEN_KEY, sec.dataset.rdSec ?? '');
        else if (localStorage.getItem(OPEN_KEY) === sec.dataset.rdSec) localStorage.setItem(OPEN_KEY, '');
      } catch { /* fine */ }
    };
    el.addEventListener('toggle', onToggle, true);
    return () => el.removeEventListener('toggle', onToggle, true);
  }, [loaded]);
  return (
    <div class="reading-analysis">
      <style dangerouslySetInnerHTML={{ __html: rd.READING_CSS }} />
      <div class="ra-head">
        <button class="ghost" onClick={onBack}>← Today</button>
        <h3>📚 {kid}'s reading</h3>
        <span />
      </div>
      {err && !books && <p class="error">{err}</p>}
      {!loaded ? <p class="muted">Loading…</p>
        : <div ref={host} dangerouslySetInnerHTML={{ __html: rd.readingHtml({ books, quest, kid, open }) }} />}
    </div>
  );
}
