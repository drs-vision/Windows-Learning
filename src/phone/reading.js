// The reading dashboard: one shared look for the parent's phone and the PC's Parent Console.
// Data in (the PC's parent.reading = ReadingReport.cs and parent.quest = ReadingQuest.Report), HTML out.
// Sections fold open one at a time (<details name="rd">), so a parent sees only what they want; the summary at the top
// is always there. Pages remember which section was open with data-rd-sec on the <details>.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => (v == null ? '—' : `${v}%`);
const fmtDate = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
const tone = (p, strong = 80) => (p == null ? '' : p >= strong ? 'ok' : p >= 60 ? 'mid' : 'low');
const hours = (min) => (min >= 90 ? `${Math.round(min / 60)} hours` : `${min} min`);

const SKILL = {
  detail: ['Details', 'finding something the paragraph says'],
  'main-idea': ['Main idea', 'what the whole paragraph is about'],
  vocabulary: ['Word meaning', 'working out a word from the sentence'],
  inference: ['Reading between the lines', "what the paragraph means but doesn't say"],
  sequence: ['Order of events', 'what happened first, next, last'],
  'cause-effect': ['Cause and effect', 'why something happened'],
};
const STATUS = { comfortable: ['Comfortable', 'ok'], challenge: ['Good challenge', 'mid'], hard: ['Hard for now', 'low'], read: ['Read', 'read'] };
const measures = (r) => [r.atos != null ? `ATOS ${r.atos.toFixed(1)}` : '', r.lexile != null ? `${r.lexile}L` : '', r.atos == null && r.lexile == null && r.formula != null ? `formula grade ${r.formula.toFixed(1)}` : ''].filter(Boolean).join(' · ');

const tile = (label, big, small) => `<div class="rd-tile"><small>${label}</small><b>${big}</b>${small ? `<small>${small}</small>` : ''}</div>`;
const section = (id, open, title, sub, body) =>
  `<details class="rd-sec" name="rd" data-rd-sec="${id}"${open ? ' open' : ''}><summary><span class="rd-sum-t">${title}</span>${sub ? `<span class="rd-sum-s">${sub}</span>` : ''}</summary><div class="rd-body">${body}</div></details>`;

function insight(d, q, kid) {
  const parts = [];
  if (d && d.chaptersQuizzed && d.comfortable) parts.push(`${kid} reads Level ${d.comfortable} books comfortably`);
  if (d && d.chaptersQuizzed && d.comfortable && d.stretch?.chapters) parts.push(d.stretch.firstTry != null && d.stretch.firstTry >= 70
    ? `and is doing well with harder books (Level ${d.stretch.level}, ${d.stretch.firstTry}% on first tries)`
    : `and is trying harder books (Level ${d.stretch.level}), a stretch, which is good`);
  let s = parts.length ? parts.join(' ') + '.' : '';
  if (q && q.answered) s += s ? ` Reading Quest: Level ${q.level}${q.percent30 != null ? `, ${q.percent30}% right this month` : ''}.` : `${kid} is at Level ${q.level} in Reading Quest${q.percent30 != null ? `, ${q.percent30}% right this month` : ''}.`;
  if (!s && d && (d.chaptersRead ?? 0) > 0) s = `${kid} has read ${d.chaptersRead} chapter${d.chaptersRead === 1 ? '' : 's'} so far without quizzes (they're optional). A comfortable level shows once ${d.strongNeeded} chapters at one level score ${d.strongPercent}%+ on a first-try quiz.`;
  return s || `${kid} hasn't read anything yet. Numbers appear after the first chapter or Reading Quest paragraph.`;
}

function questBody(q, kid) {
  const h = q.history ?? [];
  let spark = '';
  if (h.length > 1) {
    const lo = Math.min(...h.map((x) => x.rating), q.rating) - 0.5, hi = Math.max(...h.map((x) => x.rating), q.rating) + 0.5;
    const pts = h.map((x, i) => `${(i / (h.length - 1)) * 100},${40 - ((x.rating - lo) / Math.max(0.1, hi - lo)) * 40}`).join(' ');
    spark = `<h4>Rating over time</h4><svg class="rd-spark" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Rating from ${h[0].rating} to ${h[h.length - 1].rating}"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg><div class="rd-ends"><span>${fmtDate(h[0].day)}</span><span>${fmtDate(h[h.length - 1].day)}</span></div>`;
  }
  const skills = q.types?.length ? `<h4>By reading skill</h4><div class="rd-skills">${q.types.map((t) => `<div class="rd-skill" title="${esc(SKILL[t.type]?.[1] ?? '')}"><span>${esc(SKILL[t.type]?.[0] ?? t.type)}<small>${esc(SKILL[t.type]?.[1] ?? '')}</small></span><span class="rd-meter"><i class="${tone(t.percent)}" style="width:${t.percent}%"></i></span><b>${t.percent}%</b><small>${t.right}/${t.answered}</small></div>`).join('')}</div>` : '';
  const bands = q.bands?.length ? `<h4>By paragraph difficulty</h4><table class="rd-table"><thead><tr><th>Paragraphs at about</th><th>Answered</th><th>Right</th></tr></thead><tbody>${q.bands.map((b) => `<tr><td>${b.grade === 0 ? 'Kindergarten-grade 1' : `Grade ${b.grade}`}</td><td>${b.answered}</td><td>${b.percent}%</td></tr>`).join('')}</tbody></table>` : '';
  return `<div class="rd-tiles">
      ${tile('Quest level', `Level ${q.level}`, `rating ${q.rating.toFixed(1)} · what ${esc(kid)} sees`)}
      ${tile('Right answers', pct(q.percent30 ?? q.percentAll), q.percent30 != null ? `last 30 days · ${q.answered30} questions` : `all time · ${q.answered}`)}
      ${tile('Streak', `🔥 ${q.streak}`, `best ${q.bestStreak} in a row`)}
      ${tile('Time', `${q.minutes} <em>min</em>`, q.wpm ? `about ${q.wpm} words/min incl. answering` : '')}
    </div>${spark}${skills}${bands}<p class="rd-note">${q.left} of ${q.pool} questions not tried yet.</p>`;
}

function booksBody(d) {
  const maxWeek = Math.max(1, ...d.weeks.map((w) => w.chapters));
  const speed = d.wpm != null ? `median of ${d.wpmChapters ?? 0} chapter${d.wpmChapters === 1 ? '' : 's'}${d.wpmLow != null && d.wpmHigh != null && (d.wpmChapters ?? 0) >= 4 ? ` · usually ${d.wpmLow}-${d.wpmHigh}` : ''}` : 'after the first chapter read';
  const weeks = `<h4>Last 12 weeks</h4><div class="rd-weeks" role="img" aria-label="Chapters read and first-try accuracy by week">${d.weeks.map((w) => `<div class="rd-week" title="Week of ${fmtDate(w.start)}: ${w.chapters} chapter${w.chapters === 1 ? '' : 's'} read${w.firstTry != null ? `, ${w.firstTry}% first try` : ''}${w.wpm ? `, ${w.wpm} words/min` : ''}"><span class="rd-pct">${w.firstTry != null ? `${w.firstTry}%` : ''}</span><span class="rd-bar"><i class="${tone(w.firstTry, d.strongPercent)}" style="height:${Math.round(w.chapters / maxWeek * 100)}%"></i></span><small>${fmtDate(w.start)}</small></div>`).join('')}</div>
    <p class="rd-note">Bar height: chapters read that week. Colour and number: first-try quiz accuracy (green ${d.strongPercent}%+, amber 60-${d.strongPercent - 1}%, red under 60%, grey = no quizzes).</p>`;
  const levels = d.levels.length ? `<h4>Chapters read by level</h4><div class="rd-scroll"><table class="rd-table"><thead><tr><th>Level</th><th>Read</th><th>Words</th><th>Speed</th><th>Quizzes</th><th>First try</th></tr></thead><tbody>${d.levels.map((l) => `<tr class="${l.level === d.comfortable ? 'here' : ''}"><td>Level ${l.level}${l.level === d.comfortable ? ' ✓' : ''}</td><td>${l.read ?? l.chapters}</td><td>${l.words != null ? l.words.toLocaleString() : '—'}</td><td>${l.wpm ? `${l.wpm}/min` : '—'}</td><td>${l.chapters}</td><td>${pct(l.firstTry)}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `<div class="rd-tiles">
      ${tile('Comfortable level', d.comfortable ? `Level ${d.comfortable}` : 'Not yet', d.comfortable
        ? [d.comfortableAtos != null ? `books around ATOS ${d.comfortableAtos.toFixed(1)}` : '', d.comfortableLexile != null ? `${d.comfortableLexile}L` : ''].filter(Boolean).join(' · ') || `${d.strongNeeded}+ chapters at ${d.strongPercent}%+`
        : `needs ${d.strongNeeded} quizzed chapters at ${d.strongPercent}%+ first try`)}
      ${tile('First-try accuracy', pct(d.firstTry30 ?? d.firstTryAll), d.firstTry30 != null ? `last 30 days · ${d.chapters30} quiz${d.chapters30 === 1 ? '' : 'zes'}` : 'all time')}
      ${tile('Reading speed (estimate)', d.wpm != null ? `${d.wpm} <em>words/min</em>` : '—', speed)}
      ${tile('Chapters read', `${d.chaptersRead ?? d.chaptersPassed}`, `${d.chaptersRead30 != null ? `${d.chaptersRead30} in 30 days · ` : ''}${d.wordsRead.toLocaleString()} words · ${hours(d.minutesReading)} · ${d.chaptersQuizzed ?? 0} with a quiz`)}
    </div>${weeks}${levels}`;
}

function recentBody(d) {
  return `<ul class="rd-recent">${d.recent.map((r) => `<li>
      <span class="rd-date">${fmtDate(r.at)}</span>
      <span class="rd-what"><b>${esc(r.book)}</b>${r.chapter != null ? ` · ch. ${r.chapter}` : ''}<small>Level ${r.level}${measures(r) ? ` · ${measures(r)}` : ''}${r.wpm ? ` · ${r.wpm} words/min` : ''}</small></span>
      ${r.firstTry != null ? `<span class="rd-score">${r.firstTry}%<small>${r.correct}/${r.total} first try${r.tries > 1 ? ` · ${r.passed ? 'passed' : 'tried'} on try ${r.tries}` : ''}</small></span>` : '<span class="rd-score">—<small>no quiz</small></span>'}
      <span class="rd-chip ${(STATUS[r.status] ?? STATUS.read)[1]}">${(STATUS[r.status] ?? STATUS.read)[0]}</span>
    </li>`).join('')}</ul>`;
}

const a = (href, text) => `<a href="${href}" target="_blank" rel="noreferrer">${text}</a>`;
function aboutBody(d) {
  const strong = d?.strongPercent ?? 80, need = d?.strongNeeded ?? 3, days = d?.windowDays ?? 90;
  return `<p>Everything here is worked out on the PC with fixed rules (no AI, nothing sent anywhere except to your linked phone), so the same reading always gives the same numbers. Your child never sees any of it; they only see <b>Level 1, 2, 3...</b>, so reading an easier book never feels like being "behind".</p>
    <h4>Levels</h4>
    <p>One scale for the bookshelf and Reading Quest, so "Level 4" means the same in both. Level 1 is below grade 2, then Level N is grade N up to N+1. A book's level is the whole number of its published ATOS book level (below); a book without one sits next to similar books. In Reading Quest, your child's level is the level of text they get about 3 in 4 questions right, so a child at Quest Level 4 is ready for Level 4 books.</p>
    <h4>Reading Quest rating</h4>
    <p>Reading Quest shows a paragraph written by real authors with a question under it; at higher levels the paragraphs get longer (up to about 280 words) with a question per ~100 words. Each question is marked the moment it's answered; a missed one comes back by itself on a later day, and a right one never comes back. Each paragraph's difficulty is its readability grade (below). The rating works like a chess rating (Elo): a right answer raises it, more for a hard paragraph; a miss lowers it, more for an easy one. The next paragraph is picked a little above the rating; after two misses in a row an easier one comes next. A rating of 5.0 means about half right on grade-5 paragraphs and about 3 in 4 on grade-4 ones, which is Level 4. <b>By reading skill</b> groups the questions by what they ask, to show what to practise together.</p>
    <h4>Comfortable level</h4>
    <p>The highest level where at least <b>${need} chapters</b> scored <b>${strong}% or better on the first try</b>, over the last ${days} days (or all time, if there's been little reading lately). It's deliberately cautious: one great chapter in a hard book doesn't set it, and a missed quiz in a hard book or a perfect score in an easy one doesn't move it. For scale: reading teachers traditionally call about 90%+ comprehension "independent" and about 75-89% "instructional" (Emmett Betts' reading levels); Accelerated Reader suggests an average of 85% on its quizzes. ${strong}% sits in that range: solid understanding.</p>
    <h4>First-try accuracy</h4>
    <p>Quizzes are optional. Only the first attempt at each chapter's quiz counts; a retake completes the chapter and pays, but doesn't change these numbers. Results show as <b>Comfortable</b> (80%+), <b>Good challenge</b> (60-79%) or <b>Hard for now</b> (under 60%). Chapters read without a quiz show how much and how fast your child reads, but not how well they understood it.</p>
    <h4>How hard a book is</h4>
    <ul>
      <li><b>ATOS book level</b> (Renaissance, used by Accelerated Reader): the reading skill a book needs, as a school grade (4.5 = fifth month of 4th grade). Interest level: LG = grades K-3, MG = 4-8, UG = 9-12. ${a('https://uk.renaissance.com/blog/ar-book-levels-not/', 'How ATOS levels are set')} · ${a('https://www.arbookfind.com/', 'AR BookFinder')}</li>
      <li><b>Lexile text measure</b> (MetaMetrics), e.g. 1070L: higher is harder. <b>AD</b> = "adult directed" (usually read aloud), <b>NC</b> = harder than usual for its age group. Typical mid-year student measures (middle 50%): grade 2 ≈ 75-475L, grade 4 ≈ 465-865L, grade 6 ≈ 750-1145L, grade 8 ≈ 930-1320L. ${a('https://hub.lexile.com/lexile-grade-level-charts/', 'Lexile grade level charts')}</li>
      <li><b>Readability formulas</b>, computed from the text: ${a('https://en.wikipedia.org/wiki/Flesch%E2%80%93Kincaid_readability_tests', 'Flesch-Kincaid grade')}, ${a('https://en.wikipedia.org/wiki/Coleman%E2%80%93Liau_index', 'Coleman-Liau')} and the ${a('https://en.wikipedia.org/wiki/Automated_readability_index', 'Automated Readability Index')}, averaged. They only count sentence and word length, so old books with long sentences can measure harder than they are; that's why published ATOS and Lexile numbers come first for books.</li>
    </ul>
    <h4>Reading speed</h4>
    <p>An estimate, from time on the page: chapter words ÷ minutes the chapter was on screen and in use until it was first read to the end (window focused, some scrolling, clicking or typing in the last 2 minutes; time away isn't counted). A chapter only counts as read after a believable time for its length (600 words a minute at most). The median of the last 30 days is shown, with the middle half of chapters as "usually"; under 40 or over 600 words a minute is left out. It settles over weeks; a single chapter can be off either way. Average silent reading rates with comprehension across US students (Spichtig et al., 2016): grade 2 ≈ 115, grade 4 ≈ 147, grade 6 ≈ 165, grade 8 ≈ 166, grade 10 ≈ 185 words/min (children vary by about ±40-60). ${a('https://ila.onlinelibrary.wiley.com/doi/full/10.1002/rrq.137', 'Reading Research Quarterly 51(2), 2016')}</p>
    <h4>What these numbers can't tell you</h4>
    <p>Quizzes and Reading Quest questions are short, so one result can be luck either way. Look at the trend over weeks, not a single day. They check that something was read and understood; they aren't a standardized reading test.</p>`;
}

/**
 * The whole dashboard. books / quest may be null (not loaded or not used yet). open: the section id to show open
 * ('quest' | 'books' | 'recent' | 'about'), or none. note: a line under the summary (e.g. "Updated 2 min ago").
 */
export function readingHtml({ books, quest, kid = 'Your child', open = '', note = '' }) {
  const d = books, q = quest && quest.answered > 0 ? quest : null;
  const level = d?.comfortable ? `Level ${d.comfortable}` : q ? `Level ${q.level}` : '—';
  const levelSub = d?.comfortable ? `books, verified${q ? ` · Quest Level ${q.level}` : ''}` : q ? 'from Reading Quest' : 'not yet';
  const summary = `<div class="rd-tiles rd-top">
      ${tile('Reading level', level, levelSub)}
      ${tile('Chapters read', d ? `${d.chaptersRead ?? d.chaptersPassed}` : '—', d ? `${d.wordsRead.toLocaleString()} words` : '')}
      ${tile('Reading speed', d?.wpm != null ? `${d.wpm} <em>wpm</em>` : '—', d?.wpm != null ? 'estimate' : '')}
      ${tile('Reading Quest', q ? pct(q.percent30 ?? q.percentAll) : '—', q ? `right · ${q.answered} questions` : 'not started')}
    </div>`;
  const parts = [`<p class="rd-insight">${esc(insight(d, q, kid))}</p>`, summary, note ? `<p class="rd-note">${esc(note)}</p>` : ''];
  if (q) parts.push(section('quest', open === 'quest', '🧭 Reading Quest', `Level ${q.level} · ${pct(q.percent30 ?? q.percentAll)} right`, questBody(q, kid)));
  if (d) parts.push(section('books', open === 'books', '📚 Books', `${d.chaptersRead ?? d.chaptersPassed} read · ${pct(d.firstTry30 ?? d.firstTryAll)} first try`, booksBody(d)));
  if (d?.recent?.length) parts.push(section('recent', open === 'recent', 'Recent chapters', `${d.recent.length}`, recentBody(d)));
  parts.push(section('about', open === 'about', 'ⓘ About these numbers', '', aboutBody(d)));
  return `<div class="rd">${parts.join('')}</div>`;
}

/** Styles for both pages, scoped under .rd; uses the page's colour variables where they exist. */
export const READING_CSS = `
.rd { display: grid; gap: 10px; }
.rd h4 { margin: 14px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; opacity: .6; }
.rd .rd-insight { margin: 0; font-size: 15px; line-height: 1.45; }
.rd .rd-note { margin: 4px 0 0; font-size: 12.5px; opacity: .65; }
.rd .rd-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
.rd .rd-tile { border: 1px solid var(--line, rgba(127,127,127,.25)); border-radius: 12px; padding: 10px 12px; display: grid; gap: 2px; align-content: start; }
.rd .rd-tile small { opacity: .65; font-size: 12px; } .rd .rd-tile b { font-size: 21px; } .rd .rd-tile em { font-style: normal; font-size: 13px; opacity: .7; }
.rd .rd-sec { border: 1px solid var(--line, rgba(127,127,127,.25)); border-radius: 14px; overflow: hidden; }
.rd .rd-sec > summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 13px 14px; font-weight: 700; }
.rd .rd-sec > summary::-webkit-details-marker { display: none; }
.rd .rd-sec > summary::after { content: '›'; font-size: 20px; line-height: 1; opacity: .5; transition: transform .15s; align-self: center; }
.rd .rd-sec[open] > summary::after { transform: rotate(90deg); }
.rd .rd-sec > summary:hover { background: rgba(127,127,127,.07); }
.rd .rd-sum-t { flex: none; } .rd .rd-sum-s { flex: 1; text-align: right; font-weight: 400; font-size: 13.5px; opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd .rd-body { padding: 0 14px 14px; font-size: 14px; line-height: 1.5; }
.rd .rd-body ul { padding-left: 18px; }
.rd .rd-spark { width: 100%; height: 60px; color: var(--accent, #4f7cff); display: block; }
.rd .rd-ends { display: flex; justify-content: space-between; font-size: 12px; opacity: .6; }
.rd .rd-skills { display: grid; gap: 8px; }
.rd .rd-skill { display: grid; grid-template-columns: minmax(0, 1.6fr) 1fr auto auto; gap: 8px; align-items: center; }
.rd .rd-skill span small { display: block; font-size: 11.5px; opacity: .6; }
.rd .rd-skill > small { opacity: .6; font-size: 12px; }
.rd .rd-meter { height: 8px; border-radius: 4px; background: rgba(127,127,127,.15); overflow: hidden; } .rd .rd-meter i { display: block; height: 100%; }
.rd i.ok, .rd .rd-chip.ok { background: #16a34a; } .rd i.mid, .rd .rd-chip.mid { background: #f59e0b; } .rd i.low, .rd .rd-chip.low { background: #ef4444; } .rd .rd-chip.read { background: #64748b; }
.rd .rd-scroll { overflow-x: auto; }
.rd .rd-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.rd .rd-table th, .rd .rd-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line, rgba(127,127,127,.2)); white-space: nowrap; }
.rd .rd-table th { font-weight: 600; opacity: .7; font-size: 12px; } .rd .rd-table tr.here td { font-weight: 700; }
.rd .rd-weeks { display: grid; grid-template-columns: repeat(12, 1fr); gap: 4px; align-items: end; height: 120px; }
.rd .rd-week { display: grid; grid-template-rows: auto 1fr auto; height: 100%; text-align: center; gap: 2px; min-width: 0; }
.rd .rd-week small, .rd .rd-pct { font-size: 10px; opacity: .65; white-space: nowrap; overflow: hidden; }
.rd .rd-bar { display: flex; align-items: flex-end; background: rgba(127,127,127,.08); border-radius: 4px; overflow: hidden; }
.rd .rd-bar i { display: block; width: 100%; background: #94a3b8; border-radius: 4px 4px 0 0; }
.rd .rd-bar i.ok { background: #16a34a; } .rd .rd-bar i.mid { background: #f59e0b; } .rd .rd-bar i.low { background: #ef4444; }
.rd .rd-recent { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.rd .rd-recent li { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 7px 0; border-bottom: 1px dashed var(--line, rgba(127,127,127,.2)); }
.rd .rd-date { font-size: 12.5px; opacity: .65; } .rd .rd-what small, .rd .rd-score small { display: block; font-size: 12px; opacity: .65; }
.rd .rd-score { text-align: right; font-weight: 700; }
.rd .rd-chip { color: #fff; border-radius: 999px; padding: 2px 9px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
@media (max-width: 520px) { .rd .rd-recent li { grid-template-columns: 46px minmax(0, 1fr) auto; } .rd .rd-recent .rd-chip { display: none; } .rd .rd-weeks small { display: none; } }
`;
