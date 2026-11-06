import { useEffect, useState } from 'preact/hooks';
import { bridge } from '../core/bridge';

/** The PC's reading analysis (ReadingReport.cs): plain rules, so a parent can check every number by hand. */
export interface ReadingRow { at: string; book: string; chapter: number | null; title: string; level: number; formula: number | null; atos: number | null; lexile: number | null; firstTry: number; correct: number; total: number; tries: number; passed: boolean; wpm: number | null; status: 'comfortable' | 'challenge' | 'hard' }
export interface ReadingData {
  kid?: string;
  comfortable: number; comfortableAtos: number | null; comfortableLexile: number | null; comfortableFormula: number | null; current: number | null;
  stretch: { chapters: number; firstTry: number | null; level: number };
  firstTry30: number | null; firstTryAll: number | null; chapters30: number; wpm: number | null;
  chaptersPassed: number; wordsRead: number; minutesReading: number;
  windowDays: number; strongPercent: number; strongNeeded: number;
  levels: { level: number; chapters: number; strong: number; firstTry: number | null }[];
  weeks: { start: string; chapters: number; firstTry: number | null; wpm: number | null }[];
  recent: ReadingRow[];
}

export interface QuestData {
  rating: number; level: number; answered: number; percent30: number | null; answered30: number; percentAll: number | null;
  streak: number; bestStreak: number; wpm: number | null; minutes: number;
  history: { day: string; rating: number }[];
  types: { type: string; answered: number; right: number; percent: number }[];
  bands: { grade: number; answered: number; percent: number }[];
  pool: number; left: number;
}
const SKILL: Record<string, [string, string]> = {
  detail: ['Details', 'finding something the paragraph says'],
  'main-idea': ['Main idea', 'what the whole paragraph is about'],
  vocabulary: ['Word meaning', 'working out a word from the sentence'],
  inference: ['Reading between the lines', 'what the paragraph means but doesn\'t say'],
  sequence: ['Order of events', 'what happened first, next, last'],
  'cause-effect': ['Cause and effect', 'why something happened'],
};

/** Reading Quest: the adaptive short-paragraph practice. */
function QuestSection({ q, kid }: { q: QuestData; kid: string }) {
  const h = q.history;
  const lo = Math.min(...h.map((x) => x.rating), q.rating) - 0.5, hi = Math.max(...h.map((x) => x.rating), q.rating) + 0.5;
  const pts = h.map((x, i) => `${h.length === 1 ? 50 : (i / (h.length - 1)) * 100},${40 - ((x.rating - lo) / Math.max(0.1, hi - lo)) * 40}`).join(' ');
  return (
    <section class="ra-quest">
      <h4>🧭 Reading Quest (short paragraphs)</h4>
      <div class="ra-stats">
        <div class="ra-stat"><small>Quest rating</small><b>{q.rating.toFixed(1)}</b><small>paragraphs around grade {q.rating.toFixed(1)} difficulty · {kid} sees "Level {q.level}"</small></div>
        <div class="ra-stat"><small>Right answers</small><b>{q.percent30 ?? q.percentAll ?? '—'}{(q.percent30 ?? q.percentAll) != null && '%'}</b><small>{q.percent30 != null ? `last 30 days · ${q.answered30} paragraphs` : `all time · ${q.answered}`}</small></div>
        <div class="ra-stat"><small>Streak</small><b>🔥 {q.streak}</b><small>best {q.bestStreak} in a row</small></div>
        <div class="ra-stat"><small>Time</small><b>{q.minutes} <em>min</em></b><small>{q.wpm ? `about ${q.wpm} words/min incl. answering` : `${q.answered} paragraphs`}</small></div>
      </div>
      {h.length > 1 && <>
        <h4>Rating over time</h4>
        <svg class="ra-spark" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`Rating from ${h[0].rating} to ${h[h.length - 1].rating}`}>
          <polyline points={pts} fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" />
        </svg>
        <div class="row between muted small"><span>{h[0].day}</span><span>{h[h.length - 1].day}</span></div>
      </>}
      {q.types.length > 0 && <>
        <h4>By reading skill</h4>
        <div class="ra-skills">
          {q.types.map((t) => (
            <div class="ra-skill" title={SKILL[t.type]?.[1]}>
              <span>{SKILL[t.type]?.[0] ?? t.type}<small>{SKILL[t.type]?.[1]}</small></span>
              <span class="ra-meter"><i class={t.percent >= 80 ? 'ok' : t.percent >= 60 ? 'mid' : 'low'} style={{ width: `${t.percent}%` }} /></span>
              <b>{t.percent}%</b><small class="muted">{t.right}/{t.answered}</small>
            </div>
          ))}
        </div>
      </>}
      {q.bands.length > 0 && <>
        <h4>By paragraph difficulty</h4>
        <table class="ra-table"><thead><tr><th>Paragraphs at about</th><th>Read</th><th>Right</th></tr></thead>
          <tbody>{q.bands.map((b) => <tr><td>{b.grade === 0 ? 'Kindergarten–grade 1' : `Grade ${b.grade}`}</td><td>{b.answered}</td><td>{b.percent}%</td></tr>)}</tbody></table>
      </>}
      <p class="muted small">{q.left} of {q.pool} paragraphs not read yet.</p>
    </section>
  );
}

const STATUS = { comfortable: ['Comfortable', 'ok'], challenge: ['Good challenge', 'mid'], hard: ['Hard for now', 'low'] } as const;
const fmtDate = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
const measures = (r: { atos: number | null; lexile: number | null; formula: number | null }) =>
  [r.atos != null ? `ATOS ${r.atos.toFixed(1)}` : '', r.lexile != null ? `${r.lexile}L` : '', r.atos == null && r.lexile == null && r.formula != null ? `formula grade ${r.formula.toFixed(1)}` : ''].filter(Boolean).join(' · ');

/** One plain sentence a parent can take away. Fixed wording from the numbers, nothing guessed. */
function insight(d: ReadingData, kid: string) {
  if (!d.recent.length) return `${kid} hasn't taken a reading quiz yet. Numbers appear after the first chapter.`;
  const parts: string[] = [];
  if (d.comfortable) parts.push(`${kid} reads Level ${d.comfortable} books comfortably`);
  else parts.push(`${kid} is getting started — a comfortable level shows after ${d.strongNeeded} chapters at one level score ${d.strongPercent}% or more on the first try`);
  if (d.stretch.chapters && d.comfortable) parts.push(d.stretch.firstTry != null && d.stretch.firstTry >= 70
    ? `and is doing well with harder books (Level ${d.stretch.level}, ${d.stretch.firstTry}% on first tries)`
    : `and is trying harder books (Level ${d.stretch.level}) — a stretch, which is good`);
  return parts.join(' ') + '.';
}

export function ReadingAnalysis({ childId, kid, onBack }: { childId: string; kid: string; onBack: () => void }) {
  const [d, setD] = useState<ReadingData | null>(null);
  const [err, setErr] = useState('');
  const [about, setAbout] = useState(false);
  const [q, setQ] = useState<QuestData | null>(null);
  useEffect(() => { bridge.parentReading(childId).then(setD).catch((e) => setErr((e as Error).message)); bridge.parentQuest(childId).then(setQ).catch(() => setQ(null)); }, [childId]);
  if (err) return <div class="reading-analysis"><button class="ghost" onClick={onBack}>← Today</button><p class="error">{err}</p></div>;
  if (!d) return <div class="reading-analysis"><button class="ghost" onClick={onBack}>← Today</button><p class="muted">Loading…</p></div>;
  const maxWeek = Math.max(1, ...d.weeks.map((w) => w.chapters));
  return (
    <div class="reading-analysis">
      <div class="ra-head">
        <button class="ghost" onClick={onBack}>← Today</button>
        <h3>📚 {kid}'s reading</h3>
        <button class="ghost small" onClick={() => setAbout(true)}>ⓘ About these numbers</button>
      </div>
      {q && q.answered > 0 && <QuestSection q={q} kid={kid} />}
      {q && q.answered > 0 && <h4>📚 Bookshelf (chapters)</h4>}
      <p class="ra-insight">{insight(d, kid)}</p>

      <div class="ra-stats">
        <div class="ra-stat">
          <small>Comfortable level</small>
          <b>{d.comfortable ? `Level ${d.comfortable}` : 'Not yet'}</b>
          <small>{d.comfortable
            ? [d.comfortableAtos != null ? `books around ATOS ${d.comfortableAtos.toFixed(1)}` : '', d.comfortableLexile != null ? `${d.comfortableLexile}L` : ''].filter(Boolean).join(' · ') || `${d.strongNeeded}+ chapters at ${d.strongPercent}%+`
            : `needs ${d.strongNeeded} chapters at ${d.strongPercent}%+ first try`}</small>
        </div>
        <div class="ra-stat">
          <small>First-try accuracy</small>
          <b>{d.firstTry30 ?? d.firstTryAll ?? '—'}{(d.firstTry30 ?? d.firstTryAll) != null && '%'}</b>
          <small>{d.firstTry30 != null ? `last 30 days · ${d.chapters30} quiz${d.chapters30 === 1 ? '' : 'zes'}` : 'all time'}</small>
        </div>
        <div class="ra-stat">
          <small>Reading speed</small>
          <b>{d.wpm ?? '—'}{d.wpm != null && <em> words/min</em>}</b>
          <small>silent reading, median</small>
        </div>
        <div class="ra-stat">
          <small>Read so far</small>
          <b>{d.chaptersPassed} <em>{d.chaptersPassed === 1 ? 'chapter' : 'chapters'}</em></b>
          <small>{d.wordsRead.toLocaleString()} words · {d.minutesReading >= 90 ? `${Math.round(d.minutesReading / 60)} hours` : `${d.minutesReading} min`} reading</small>
        </div>
      </div>

      <h4>Last 12 weeks</h4>
      <div class="ra-weeks" role="img" aria-label="Chapters and first-try accuracy by week">
        {d.weeks.map((w) => (
          <div class="ra-week" title={`Week of ${fmtDate(w.start)}: ${w.chapters} quiz${w.chapters === 1 ? '' : 'zes'}${w.firstTry != null ? `, ${w.firstTry}% first try` : ''}${w.wpm ? `, ${w.wpm} words/min` : ''}`}>
            <span class="ra-pct">{w.firstTry != null ? `${w.firstTry}%` : ''}</span>
            <span class="ra-bar"><i class={w.firstTry == null ? '' : w.firstTry >= d.strongPercent ? 'ok' : w.firstTry >= 60 ? 'mid' : 'low'} style={{ height: `${Math.round(w.chapters / maxWeek * 100)}%` }} /></span>
            <small>{fmtDate(w.start)}</small>
          </div>
        ))}
      </div>
      <p class="muted small">Bar height: quizzes taken that week. Colour and number: first-try accuracy (green {d.strongPercent}%+, amber 60–{d.strongPercent - 1}%, red under 60%).</p>

      {d.levels.length > 0 && <>
        <h4>By level</h4>
        <table class="ra-table">
          <thead><tr><th>Level</th><th>Quizzes</th><th>First-try accuracy</th><th>At {d.strongPercent}%+</th></tr></thead>
          <tbody>{d.levels.map((l) => <tr class={l.level === d.comfortable ? 'here' : ''}><td>Level {l.level}{l.level === d.comfortable ? ' ✓' : ''}</td><td>{l.chapters}</td><td>{l.firstTry != null ? `${l.firstTry}%` : '—'}</td><td>{l.strong}</td></tr>)}</tbody>
        </table>
      </>}

      {d.recent.length > 0 && <>
        <h4>Recent chapters</h4>
        <ul class="ra-recent">
          {d.recent.map((r) => (
            <li>
              <span class="ra-date">{fmtDate(r.at)}</span>
              <span class="ra-what"><b>{r.book}</b>{r.chapter != null && <> · ch. {r.chapter}</>}<small>Level {r.level}{measures(r) && ` · ${measures(r)}`}{r.wpm ? ` · ${r.wpm} words/min` : ''}</small></span>
              <span class="ra-score">{r.firstTry}%<small>{r.correct}/{r.total} first try{r.tries > 1 ? ` · ${r.passed ? 'passed' : 'tried'} on try ${r.tries}` : ''}</small></span>
              <span class={'ra-chip ' + STATUS[r.status][1]}>{STATUS[r.status][0]}</span>
            </li>
          ))}
        </ul>
      </>}
      {about && <AboutReading d={d} onClose={() => setAbout(false)} />}
    </div>
  );
}

/** What each number means, how it's worked out, and where to read more. */
function AboutReading({ d, onClose }: { d: ReadingData; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  return (
    <div class="modal" onClick={onClose}>
      <div class="card ra-about" role="dialog" aria-label="About these numbers" onClick={(e) => e.stopPropagation()}>
        <div class="ra-head"><h3>About these numbers</h3><button class="ghost small" onClick={onClose}>Close</button></div>
        <p>Everything here is worked out on the PC with fixed rules — no AI and nothing sent anywhere — so the same reading always gives the same numbers. Your child never sees any of it; on their shelf, books just say <b>Level 1, 2, 3…</b> so reading an easier book never feels like being "behind".</p>

        <h4>Levels</h4>
        <p>CoinQuest's own shelf order, 1 = easiest. Books are placed by the published measures below (mainly ATOS), adjusted a little for old-fashioned language and dialect. A level is a group of books of about the same difficulty, not a school grade.</p>

        <h4>Reading Quest rating</h4>
        <p>Reading Quest shows one short paragraph (3–6 sentences, written by real authors) and one question. Each paragraph's difficulty is its readability grade (below). The rating works like a chess rating (Elo): a right answer raises it — more for a hard paragraph, less for an easy one — and a miss lowers it — more for an easy paragraph. The next paragraph is picked near the rating, a little above it, so it stays challenging but doable; after two misses in a row an easier one comes next. A rating of 3.0 means your child usually gets paragraphs of about grade-3 difficulty right. Your child only sees "Level" (the rating's whole number + 1) and a bar towards the next level.</p>
        <p><b>By reading skill</b> groups the questions by what they ask: details, main idea, word meaning, reading between the lines (inference), order of events and cause and effect. A lower score in one skill shows what to practise together.</p>
        <h4>Comfortable level</h4>
        <p>The highest level where at least <b>{d.strongNeeded} chapters</b> scored <b>{d.strongPercent}% or better on the first try</b>, over the last {d.windowDays} days (or all time, if there's been little reading lately). It's deliberately cautious: one great chapter in a hard book doesn't set it, and a missed quiz in a hard book or a perfect score in an easy one doesn't move it. For scale: reading teachers traditionally call about 90%+ comprehension "independent" (reads it alone with ease) and about 75–89% "instructional" (learning, with a little help), after Emmett Betts' reading levels; Accelerated Reader suggests an average of 85% on its quizzes. 80% sits in that instructional-to-independent range: solid understanding.</p>

        <h4>First-try accuracy</h4>
        <p>Only the first attempt at each chapter's quiz counts. A retake (after the wait and a reread) completes the chapter and pays, but it doesn't change these numbers. Each result is shown as <b>Comfortable</b> (80%+), <b>Good challenge</b> (60–79%) or <b>Hard for now</b> (under 60%).</p>

        <h4>How hard a book is</h4>
        <ul>
          <li><b>ATOS book level</b> (Renaissance, used by Accelerated Reader): the reading skill a book needs, as a school grade. A book level of 4.5 means a typical student in the fifth month of 4th grade could read it on their own. Its interest level says who the story is written for: LG = grades K–3, MG = 4–8, UG = 9–12. <a href="https://uk.renaissance.com/blog/ar-book-levels-not/" target="_blank" rel="noreferrer">How ATOS levels are set</a> · <a href="https://www.arbookfind.com/" target="_blank" rel="noreferrer">AR BookFinder</a></li>
          <li><b>Lexile text measure</b> (MetaMetrics), e.g. 1070L: higher is harder. Codes: <b>AD</b> = "adult directed", usually read aloud with a grown-up (most Beatrix Potter tales); <b>NC</b> = harder text than usual for its age group. Typical mid-year student measures (middle 50%): grade 2 ≈ 75–475L, grade 4 ≈ 465–865L, grade 6 ≈ 750–1145L, grade 8 ≈ 930–1320L. <a href="https://hub.lexile.com/lexile-grade-level-charts/" target="_blank" rel="noreferrer">Lexile grade level charts</a> · <a href="https://hub.lexile.com/find-a-book" target="_blank" rel="noreferrer">Find a Book</a></li>
          <li>Each book's ATOS and Lexile numbers were taken from public library catalogs and book distributors that carry the publishers' data; the link on each book (Ways to earn → Reading) opens the page it came from. Editions differ a little, so where they disagree the other value is noted.</li>
          <li><b>Readability formulas</b>, computed here from each chapter's text: <a href="https://en.wikipedia.org/wiki/Flesch%E2%80%93Kincaid_readability_tests" target="_blank" rel="noreferrer">Flesch-Kincaid grade</a> (<a href="https://apps.dtic.mil/sti/pdfs/ADA006655.pdf" target="_blank" rel="noreferrer">Kincaid et al., 1975</a>), <a href="https://en.wikipedia.org/wiki/Coleman%E2%80%93Liau_index" target="_blank" rel="noreferrer">Coleman-Liau</a> and the <a href="https://en.wikipedia.org/wiki/Automated_readability_index" target="_blank" rel="noreferrer">Automated Readability Index</a>, averaged. They only count sentence and word length, so old books with long sentences can measure harder than they are (Peter Rabbit measures about grade 6.6). That's why the published ATOS and Lexile numbers come first when a book has them.</li>
        </ul>

        <h4>Reading speed</h4>
        <p>Chapter words ÷ minutes the chapter was on screen and in use before its first quiz (the window open and focused, with some scrolling, clicking or typing in the last 2 minutes). The median is shown, so one distracted session doesn't skew it; anything under 40 or over 600 words a minute is ignored. Typing mode doesn't count as reading time.</p>
        <p>For a sense of scale, average silent reading rates with comprehension measured across US students (Spichtig et al., 2016):</p>
        <table class="ra-table small"><thead><tr><th>Grade</th><th>2</th><th>4</th><th>6</th><th>8</th><th>10</th><th>11–12</th></tr></thead><tbody><tr><td>Words/min</td><td>115</td><td>147</td><td>165</td><td>166</td><td>185</td><td>192</td></tr></tbody></table>
        <p class="muted small">Averages; children vary a lot (roughly ±40–60 words/min). Source: <a href="https://ila.onlinelibrary.wiley.com/doi/full/10.1002/rrq.137" target="_blank" rel="noreferrer">"The Decline of Comprehension-Based Silent Reading Efficiency in the United States", Reading Research Quarterly 51(2), 2016</a>.</p>

        <h4>What these numbers can't tell you</h4>
        <p>Each quiz is short (4–10 questions), so one result can be luck either way. Look at the trend over weeks, not a single day. The quizzes check that a chapter was read and understood; they aren't a standardized reading test.</p>
      </div>
    </div>
  );
}
