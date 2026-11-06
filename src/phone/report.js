// Activity reports: one shared look for the parent's phone and the PC's Parent Console.
// A daily report (built on the PC, see ActivityStore.Report) is additive, so a week is just its days added up.
// Everything here is pure: data in, HTML out. Pages wire the clicks with the data-* attributes.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const QUEST_NAMES = {
  'sound-keys': 'Letter Rescue', 'typing-quest': 'TypingQuest', 'bible-typing': 'Scripture Typing', 'my-passages': 'Family Passages',
  'khan-academy': 'Khan Academy', duolingo: 'Duolingo', rwt: 'Read, Write & Type!', discgames: 'Classic CD games',
  parent: 'Given by a parent', arcade: 'Arcade', youtube: 'YouTube',
};

const KINDS = {
  quest: ['🎯', 'Quests', '#4f7cff'],
  site: ['🌐', 'Websites', '#16a34a'],
  youtube: ['▶️', 'YouTube', '#ef4444'],
  arcade: ['🕹️', 'Games', '#a855f7'],
  app: ['💻', 'Apps & CD games', '#f59e0b'],
  coinquest: ['🏠', 'CoinQuest menus', '#94a3b8'],
};

const DONE = {
  'khan-academy:correct': 'Khan Academy correct answers',
  'khan-academy:videos': 'Khan Academy videos',
  'khan-academy:exercises': 'Khan Academy exercises & quizzes',
  'duolingo:lessons': 'Duolingo lessons',
  'sound-keys:finished': 'Letter Rescue lessons',
  'typing-quest:finished': 'TypingQuest drills',
  'bible-typing:finished': 'Scripture passages typed',
  'my-passages:finished': 'Family passages typed',
  'rwt:finished': 'Read, Write & Type! activities',
  'discgames:finished': 'CD game progress',
};
const doneName = (k) => DONE[k] ?? `${QUEST_NAMES[k.split(':')[0]] ?? k.split(':')[0]} finished`;

export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
/** Monday of the week a day is in. */
export const weekStart = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** Total seconds on the computer in a day's report. */
export const daySeconds = (r) => (r?.time ?? []).reduce((a, t) => a + (t.sec || 0), 0);

/** Add daily reports together. */
export function merge(days) {
  const time = new Map(), done = {}, earned = {}, spent = {};
  const typing = { sessions: 0, chars: 0, ms: 0, best: 0 };
  for (const r of days) {
    for (const t of r.time ?? []) {
      const k = t.kind + '|' + t.label;
      time.set(k, { kind: t.kind, label: t.label, sec: (time.get(k)?.sec ?? 0) + (t.sec || 0) });
    }
    const ty = r.typing ?? {};
    typing.sessions += ty.sessions || 0; typing.chars += ty.chars || 0; typing.ms += ty.ms || 0; typing.best = Math.max(typing.best, ty.best || 0);
    for (const [k, v] of Object.entries(r.done ?? {})) done[k] = (done[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.earned ?? {})) earned[k] = (earned[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.spent ?? {})) spent[k] = (spent[k] ?? 0) + v;
  }
  const list = [...time.values()].sort((a, b) => b.sec - a.sec);
  return { days: days.length, total: list.reduce((a, t) => a + t.sec, 0), time: list, typing, done, earned, spent };
}

export const fmtTime = (sec) => {
  const m = Math.round(sec / 60);
  if (m < 1) return sec > 0 ? '<1m' : '0m';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
};
const sum = (o) => Object.values(o).reduce((a, v) => a + v, 0);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * A month calendar. byDay: { 'yyyy-mm-dd': report }. Each day's dot grows with time on the computer.
 * Clicks: data-cal-day="yyyy-mm-dd", data-cal-month="-1|1".
 */
export function calendarHtml(month, byDay, selected, mode) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = weekStart(first);
  const today = dayKey(new Date());
  const sel = parseDay(selected);
  const selWeek = dayKey(weekStart(sel));
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i % 7 === 0 && d.getMonth() !== month.getMonth() && i > 27) break;
    const k = dayKey(d);
    const sec = daySeconds(byDay[k]);
    const size = sec ? Math.round(6 + Math.min(1, sec / (3 * 3600)) * 12) : 0;
    const inSel = mode === 'week' ? dayKey(weekStart(d)) === selWeek : k === selected;
    const cls = ['cal-day', d.getMonth() !== month.getMonth() ? 'out' : '', k === today ? 'today' : '', inSel ? 'sel' : '', k > today ? 'future' : ''].filter(Boolean).join(' ');
    cells += `<button type="button" class="${cls}" data-cal-day="${k}" ${k > today ? 'disabled' : ''} aria-label="${esc(d.toDateString())}${sec ? ', ' + fmtTime(sec) : ''}">
      <span class="n">${d.getDate()}</span><span class="dot" style="width:${size}px;height:${size}px"></span></button>`;
  }
  return `<div class="cal">
    <div class="cal-head"><button type="button" class="cal-nav" data-cal-month="-1" aria-label="Previous month">‹</button>
      <b>${MONTHS[month.getMonth()]} ${month.getFullYear()}</b>
      <button type="button" class="cal-nav" data-cal-month="1" aria-label="Next month" ${month.getFullYear() * 12 + month.getMonth() >= new Date().getFullYear() * 12 + new Date().getMonth() ? 'disabled' : ''}>›</button></div>
    <div class="cal-grid">${DOW.map((d) => `<span class="cal-dow">${d}</span>`).join('')}${cells}</div>
  </div>`;
}

/** The days a selection covers: one day, or Monday–Sunday of its week (never past today). */
export function rangeOf(selected, mode) {
  const d = parseDay(selected);
  if (mode === 'day') return [selected];
  const s = weekStart(d), out = [], today = dayKey(new Date());
  for (let i = 0; i < 7; i++) { const k = dayKey(addDays(s, i)); if (k <= today) out.push(k); }
  return out;
}

export function titleOf(selected, mode) {
  const d = parseDay(selected);
  if (mode === 'day') {
    const today = dayKey(new Date()), yest = dayKey(addDays(new Date(), -1));
    return selected === today ? 'Today' : selected === yest ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
  const s = weekStart(d), e = addDays(s, 6);
  const f = (x) => x.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `Week of ${f(s)} – ${f(e)}`;
}

/** The report for a selection. reports: the daily reports it covers (missing days = nothing recorded). */
export function reportHtml(reports, { title, note } = {}) {
  const m = merge(reports);
  if (!m.total && !sum(m.earned) && !sum(m.spent) && !sum(m.done)) {
    return `<div class="rep"><h3 class="rep-title">${esc(title)}</h3><p class="rep-empty">Nothing recorded${note ? '. ' + esc(note) : '.'}</p></div>`;
  }
  // Time by kind, as one stacked bar.
  const byKind = {};
  for (const t of m.time) byKind[t.kind] = (byKind[t.kind] ?? 0) + t.sec;
  const kinds = Object.entries(byKind).sort((a, b) => b[1] - a[1]);
  const bar = m.total ? `<div class="rep-bar">${kinds.map(([k, s]) => `<span style="flex:${s};background:${(KINDS[k] ?? KINDS.coinquest)[2]}" title="${esc((KINDS[k] ?? KINDS.coinquest)[1])}"></span>`).join('')}</div>
    <div class="rep-legend">${kinds.map(([k, s]) => `<span><i style="background:${(KINDS[k] ?? KINDS.coinquest)[2]}"></i>${esc((KINDS[k] ?? KINDS.coinquest)[1])} ${fmtTime(s)}</span>`).join('')}</div>` : '';
  const top = m.time.filter((t) => t.sec >= 30).slice(0, 10);
  const max = top[0]?.sec || 1;
  const topHtml = top.length ? `<h4>Top activities</h4><ul class="rep-top">${top.map((t) => `<li><span class="rep-ico">${(KINDS[t.kind] ?? KINDS.coinquest)[0]}</span><span class="rep-name">${esc(t.label || (KINDS[t.kind] ?? KINDS.coinquest)[1])}</span><span class="rep-track"><span style="width:${Math.max(4, Math.round(t.sec / max * 100))}%;background:${(KINDS[t.kind] ?? KINDS.coinquest)[2]}"></span></span><span class="rep-min">${fmtTime(t.sec)}</span></li>`).join('')}</ul>` : '';
  // Tiles: coins, typing.
  const earned = sum(m.earned), spentTotal = sum(m.spent);
  const wpm = m.typing.ms > 0 ? Math.round(m.typing.chars / 5 / (m.typing.ms / 60000)) : 0;
  const tiles = [
    `<div class="rep-tile"><small>Coins earned</small><b>${earned}</b></div>`,
    `<div class="rep-tile"><small>Coins spent</small><b>${spentTotal}</b></div>`,
    m.typing.sessions ? `<div class="rep-tile"><small>Typing speed</small><b>${wpm} <em>WPM</em></b><small>best ${m.typing.best} · ${Math.round(m.typing.chars / 5)} words</small></div>` : '',
  ].join('');
  const done = Object.entries(m.done).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const doneHtml = done.length ? `<h4>Finished</h4><ul class="rep-list">${done.map(([k, v]) => `<li><span>${esc(doneName(k))}</span><b>${v}</b></li>`).join('')}</ul>` : '';
  const src = Object.entries(m.earned).filter(([, v]) => v).sort((a, b) => b[1] - a[1]);
  const srcHtml = src.length ? `<h4>Coins came from</h4><ul class="rep-list">${src.map(([k, v]) => `<li><span>${esc(QUEST_NAMES[k] ?? k)}</span><b>+${v}</b></li>`).join('')}</ul>` : '';
  const sp = Object.entries(m.spent).filter(([, v]) => v).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const spHtml = sp.length ? `<h4>Coins went to</h4><ul class="rep-list">${sp.map(([k, v]) => `<li><span>${esc(QUEST_NAMES[k] ?? k)}</span><b>−${v}</b></li>`).join('')}</ul>` : '';
  return `<div class="rep">
    <h3 class="rep-title">${esc(title)}</h3>
    <p class="rep-total"><b>${fmtTime(m.total)}</b> on the computer${m.days > 1 ? ` · ${fmtTime(m.total / Math.max(1, reports.filter((r) => daySeconds(r)).length))} a day on days used` : ''}</p>
    ${bar}
    <div class="rep-tiles">${tiles}</div>
    ${topHtml}${doneHtml}${srcHtml}${spHtml}
    ${note ? `<p class="rep-note">${esc(note)}</p>` : ''}
  </div>`;
}

/** Styles for both pages (scoped under .activity). Uses the page's own colour variables where they exist. */
export const REPORT_CSS = `
.activity .cal { border: 1px solid var(--line, rgba(127,127,127,.25)); border-radius: 14px; padding: 10px; }
.activity .cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.activity .cal-nav { min-width: 40px; min-height: 36px; border: 0; background: transparent; font-size: 22px; cursor: pointer; color: inherit; }
.activity .cal-nav:disabled { opacity: .25; cursor: default; }
.activity .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.activity .cal-dow { text-align: center; font-size: 11px; opacity: .6; padding: 2px 0 4px; }
.activity .cal-day { position: relative; height: 44px; border: 0; border-radius: 10px; background: transparent; color: inherit; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding-top: 4px; font: inherit; }
.activity .cal-day .n { font-size: 13px; }
.activity .cal-day .dot { display: block; flex: none; margin-top: 3px; border-radius: 50%; background: var(--accent, #4f7cff); opacity: .85; }
.activity .cal-day.out { opacity: .35; }
.activity .cal-day.future { opacity: .2; cursor: default; }
.activity .cal-day.today .n { font-weight: 700; text-decoration: underline; }
.activity .cal-day.sel { background: color-mix(in srgb, var(--accent, #4f7cff) 16%, transparent); }
.activity .seg { display: inline-flex; border: 1px solid var(--line, rgba(127,127,127,.3)); border-radius: 10px; overflow: hidden; }
.activity .seg button { border: 0; background: transparent; padding: 7px 16px; font: inherit; cursor: pointer; color: inherit; }
.activity .seg button.on { background: var(--accent, #4f7cff); color: #fff; }
.activity .act-bar { display: flex; gap: 8px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin: 0 0 10px; }
.activity .rep { margin-top: 2px; }
.activity .act-body > .card { margin-top: 12px; }
@media (min-width: 820px) { .activity .act-body { display: grid; grid-template-columns: minmax(300px, 380px) 1fr; gap: 16px; align-items: start; } .activity .act-body > .card { margin-top: 0; } }
.activity .rep-title { margin: 0 0 2px; font-size: 18px; }
.activity .rep-total { margin: 0 0 10px; opacity: .8; } .activity .rep-total b { font-size: 22px; opacity: 1; }
.activity .rep-empty, .activity .rep-note { opacity: .65; font-size: 14px; }
.activity .rep-bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; gap: 2px; }
.activity .rep-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; margin: 6px 0 12px; opacity: .85; }
.activity .rep-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
.activity .rep-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin: 4px 0 6px; }
.activity .rep-tile { border: 1px solid var(--line, rgba(127,127,127,.25)); border-radius: 12px; padding: 10px 12px; display: grid; gap: 2px; }
.activity .rep-tile small { opacity: .65; font-size: 12px; } .activity .rep-tile b { font-size: 22px; } .activity .rep-tile em { font-style: normal; font-size: 13px; opacity: .7; }
.activity h4 { margin: 16px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
.activity .rep-top, .activity .rep-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.activity .rep-top li { display: grid; grid-template-columns: 22px minmax(0, 1.4fr) 1fr auto; gap: 8px; align-items: center; font-size: 14px; }
.activity .rep-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity .rep-track { height: 8px; border-radius: 4px; background: rgba(127,127,127,.15); overflow: hidden; } .activity .rep-track span { display: block; height: 100%; border-radius: 4px; }
.activity .rep-min { font-variant-numeric: tabular-nums; opacity: .8; font-size: 13px; min-width: 48px; text-align: right; }
.activity .rep-list li { display: flex; justify-content: space-between; gap: 10px; font-size: 14px; padding: 2px 0; border-bottom: 1px dashed rgba(127,127,127,.18); }
`;
