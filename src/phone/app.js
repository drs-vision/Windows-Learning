// CoinQuest on a parent's phone. Linked by scanning the QR code in the parent app on the PC (no account).
// Talks to the PC through the relay with messages scrambled by wire.js; see src/Guardian/Phone/PhoneLinkService.cs.
// From here a parent can: see coins and requests, give/take coins, approve, end game time, read the full history,
// and change quests (coins, limits, on/off), shop prizes (incl. website and app time), allowed websites, apps and YouTube channels. The parent PIN,
// internet lock, arcade, updates and CD games stay on the PC.
import * as w from './wire.js';

const app = document.getElementById('app');
const sheet = document.getElementById('sheet');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: the link stays in the address */ } },
};

// ---- which PC ----------------------------------------------------------------------------------------------------
// The link lives in the address after '#' (so a home-screen icon keeps it) and in this phone's storage.
// Scanning a PC's QR code again replaces the older link to that same PC (and an old QR, say from an old home-screen
// icon, never replaces a newer one). Links the PC has since removed, or that never answer while another link to
// a PC of the same name does, are removed (see tidyLinks).
let links = store.get('cq.links', []).map((r) => w.parseLink(r)).filter(Boolean);
const meta = store.get('cq.meta', {});        // per topicIn: { pc, pcName, ok }
let forgot = store.get('cq.forgot', []);      // links tidied away or forgotten: an old icon mustn't bring them back
const pcOf = (l) => l.pc || meta[l.topicIn]?.pc || null;
const saveLinks = () => { store.set('cq.links', links.map((l) => l.raw)); store.set('cq.meta', meta); store.set('cq.forgot', forgot.slice(-100)); };
function dropLink(l) {
  links = links.filter((x) => x !== l);
  delete meta[l.topicIn]; forgot.push(l.topicIn); localStorage.removeItem('cq.state.' + l.topicIn);
}
function addLink(nl) {
  const have = links.find((l) => l.topicIn === nl.topicIn);
  if (have) return have;
  if (forgot.includes(nl.topicIn) && links.length) return null; // an old icon's link that's already been tidied away
  const same = nl.pc ? links.filter((l) => pcOf(l) === nl.pc) : [];
  const newer = same.filter((l) => (l.made || 0) > nl.made).sort((a, b) => b.made - a.made)[0];
  if (newer) return newer;
  same.forEach(dropLink);
  forgot = forgot.filter((t) => t !== nl.topicIn);
  links.push(nl);
  return nl;
}
const fromHash = location.hash.length > 20 ? w.parseLink(location.hash) : null;
const hashLink = fromHash ? addLink(fromHash) : null;
saveLinks();
let link = hashLink ?? links.find((l) => l.topicIn === store.get('cq.current', '')) ?? links[0] ?? null;

/**
 * The PC answered on this link, so it works. Every other link to a PC of the same family name is checked right
 * away: links the PC says it still has or has removed go, and so does any that doesn't answer within 25 seconds
 * while this one does (an old link from before a re-scan). Works with any PC version; newer PCs say more.
 */
const checked = new Set();
async function tidyLinks(l, pc) {
  if (pc?.id) meta[l.topicIn] = { ...meta[l.topicIn], pc: pc.id, pcName: pc.name || '', ok: Date.now() };
  else meta[l.topicIn] = { ...meta[l.topicIn], ok: Date.now() };
  saveLinks();
  for (const o of links.filter((x) => x !== l && !checked.has(x.topicIn))) {
    const t = await w.tag(o.topicIn);
    const samePc = pc?.id && (pcOf(o) === pc.id || (pc.live || []).includes(t) || (pc.gone || []).includes(t));
    if (samePc) { dropLink(o); render(); continue; }
    if (o.household !== l.household && pcOf(o)) continue; // a different PC: leave it be
    checked.add(o.topicIn);
    probe(o, l);
  }
}

/** Ask another link whether its PC is there. No answer (while `working` does) → it's an old link: remove it. */
async function probe(o, working) {
  if (!cqRelay) return;
  const k = await w.importKey(o.key), a = w.assembler();
  const id = w.b64url(crypto.getRandomValues(new Uint8Array(9)));
  const answered = await new Promise((resolve) => {
    let ws;
    const end = (v) => { clearTimeout(timer); try { ws.close(); } catch { } resolve(v); };
    const timer = setTimeout(() => end(null), 25000);
    try { ws = new WebSocket(`${cqRelay.replace(/^http/, 'ws')}/${o.topicOut}/ws?since=${Math.floor(Date.now() / 1000) - 5}`); } catch { end(undefined); return; }
    ws.onmessage = async (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      const whole = msg.event === 'message' && a.add(msg.message);
      const r = whole && await w.open(k, whole);
      if (r && r.re === id) end(r);
    };
    ws.onerror = () => end(undefined);
    ws.onopen = async () => {
      try { for (const part of w.split(await w.seal(k, { id, ts: Date.now(), op: 'state', a: {} }))) { const r = await fetch(`${cqRelay}/${o.topicIn}`, { method: 'POST', body: part }); if (!r.ok) throw new Error(); } }
      catch { end(undefined); }
    };
  });
  if (answered === undefined || o === link || !links.includes(o)) return; // couldn't ask (offline), or in use now
  if (!answered) {
    if (o.household === working.household) { dropLink(o); saveLinks(); render(); }
    return;
  }
  // It works too. The same PC twice → keep the one in use; a different PC → keep it and remember which it is.
  const id2 = answered.pc?.id;
  if (id2 && id2 === pcOf(working)) dropLink(o);
  else meta[o.topicIn] = { ...meta[o.topicIn], pc: id2 ?? pcOf(o), pcName: answered.pc?.name ?? '', ok: Date.now() };
  saveLinks(); render();
}

let key = null, source = null, sock = null, asm = null;
let cqRelay = null;                            // CoinQuest's own relay (from relay.json); ntfy.sh stays as the fallback
let stateAt = 0;                               // when the shown state was made (a snapshot can be older)
const waiting = new Map();
let state = null, status = 'wait', error = '', updatedAt = 0;
let tab = 'home', kidId = null;               // which screen, which child (for per-child screens)
let config = null;                             // quests, prizes, websites, channels (loaded when needed)
let hist = { kid: null, entries: [], more: false, loading: false };

async function connect() {
  if (source) source.close();
  if (sock) { sock.onclose = null; sock.close(); sock = null; }
  waiting.clear(); state = null; config = null; pcApps = null; error = ''; stateAt = 0; hist = { kid: null, entries: [], more: false, loading: false };
  if (!link) { render(); return; }
  store.set('cq.current', link.topicIn);
  if (location.hash.slice(1) !== link.raw) history.replaceState(null, '', '#' + link.raw);
  key = await w.importKey(link.key);
  asm = w.assembler();
  // What this phone last saw, so the screen isn't empty while we ask.
  const cached = store.get('cq.state.' + link.topicIn, null);
  if (cached?.state) { state = cached.state; stateAt = cached.at; }
  render();
  try { cqRelay = ((await (await fetch('relay.json', { cache: 'no-store' })).json()).relays ?? []).map((r) => r.url?.replace(/\/+$/, '')).find((u) => u && !u.startsWith(link.relay)) ?? null; }
  catch { cqRelay = null; }
  // Answers from the PC arrive on our own topic; listen first (on both relays), then ask.
  const since = Math.floor(Date.now() / 1000) - 5;
  source = new EventSource(`${link.relay}/${link.topicOut}/sse?since=${since}`);
  source.onmessage = (ev) => onRelayMessage(ev.data);
  source.onerror = () => { if (status !== 'on' && !sock) { status = 'off'; render(); } };
  if (cqRelay) { openSocket(since); loadSnapshot(); }
  refresh();
}

function openSocket(since) {
  const ws = new WebSocket(`${cqRelay.replace(/^http/, 'ws')}/${link.topicOut}/ws?since=${since}`);
  sock = ws;
  ws.onmessage = (ev) => { if (ev.data !== 'pong') onRelayMessage(ev.data); };
  ws.onclose = () => { if (sock === ws) { sock = null; setTimeout(() => { if (!sock && link) openSocket(Math.floor(Date.now() / 1000) - 30); }, 5000); } };
  const ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); else clearInterval(ping); }, 30000);
}

/** The PC's latest snapshot on CoinQuest's relay: coins and requests even while the PC is off. */
async function loadSnapshot() {
  try {
    const r = await fetch(`${cqRelay}/${link.topicOut}-snap/latest`, { cache: 'no-store' });
    if (!r.ok) return;
    const m = await r.json();
    const sealed = w.assembler().add(m.message);
    const snap = sealed && await w.open(key, sealed);
    if (snap?.d?.state && m.time * 1000 > stateAt) { state = snap.d.state; stateAt = m.time * 1000; render(); }
  } catch { /* not there yet */ }
}

async function onRelayMessage(data) {
  let m; try { m = JSON.parse(data); } catch { return; }
  if (m.event !== 'message' || typeof m.message !== 'string') return;
  const whole = asm.add(m.message);
  if (!whole) return;
  const reply = await w.open(key, whole);
  if (!reply) return;
  if (reply.ok && reply.re && waiting.has(reply.re)) tidyLinks(link, reply.pc);
  if (reply.ok && reply.d?.state) {
    state = reply.d.state; status = 'on'; updatedAt = stateAt = Date.now();
    store.set('cq.state.' + link.topicIn, { state, at: stateAt });
  }
  if (reply.ok && reply.d?.result?.children?.[0]?.modules) config = reply.d.result;
  const p = waiting.get(reply.re);
  if (p) { waiting.delete(reply.re); reply.ok ? p.resolve(reply.d) : p.reject(new Error(reply.e || 'The PC said no')); }
  render();
}

function send(op, args = {}) {
  const id = w.b64url(crypto.getRandomValues(new Uint8Array(9)));
  const done = new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    setTimeout(() => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      reject(new Error(op === 'state' || op === 'config' || op === 'history' || op === 'apps'
        ? "The PC isn't answering — it may be off, asleep or offline."
        : `The PC isn't answering right now — this will happen when it's back online (within ${cqRelay ? '7 days' : '12 hours'}).`));
    }, 30000);
  });
  (async () => {
    const parts = w.split(await w.seal(key, { id, ts: Date.now(), op, a: args }));
    // CoinQuest's own relay first; the public one if that can't be reached.
    for (const relay of cqRelay ? [cqRelay, link.relay] : [link.relay]) {
      try {
        for (const part of parts) {
          const r = await fetch(`${relay}/${link.topicIn}`, { method: 'POST', body: part });
          if (!r.ok) throw new Error(r.status === 429 ? 'Too many messages right now — wait a minute and try again.' : `The relay said ${r.status}.`);
        }
        return;
      } catch (e) { if (relay === link.relay || !cqRelay) throw e; }
    }
  })().catch((e) => { const p = waiting.get(id); if (p) { waiting.delete(id); p.reject(e); } });
  return done;
}

async function refresh() {
  status = 'wait'; error = ''; render();
  try {
    await send('state');
    if (tab === 'rewards' || tab === 'shop' || tab === 'allowed') await loadConfig();
    if (tab === 'history') await loadHistory(true);
  } catch (e) { status = 'off'; error = state ? '' : e.message; render(); }
}

async function act(op, args, label) {
  error = ''; status = 'wait'; render();
  try { const d = await send(op, args); if (label) toast(label); return d; }
  catch (e) { error = e.message; status = 'off'; render(); return null; }
}

async function loadConfig() { if (!config) await send('config'); }

async function loadHistory(reset) {
  const k = kid();
  if (!k) return;
  if (reset || hist.kid !== k.id) hist = { kid: k.id, entries: [], more: false, loading: false };
  hist.loading = true; render();
  try {
    const before = hist.entries.length ? hist.entries[hist.entries.length - 1].seq : undefined;
    const d = await send('history', before ? { childId: k.id, before } : { childId: k.id });
    const seen = new Set(hist.entries.map((x) => x.seq));
    hist.entries.push(...(d.result?.entries ?? []).filter((x) => !seen.has(x.seq))); hist.more = !!d.result?.more;
  } catch (e) { error = e.message; }
  hist.loading = false; render();
}

// ---- helpers -----------------------------------------------------------------------------------------------------

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
const dayLabel = (iso) => {
  const d = new Date(iso), t = new Date(); const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(t) - day(d)) / 86400000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
};
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const mins = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : `${Math.max(1, Math.round(sec / 60))} min`);
const coins = (n) => `<span class="coin"></span>${n}`;
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
const num = (v) => { const n = Math.round(Number(String(v).replace(/[−–]/g, '-').replace(/[^0-9-]/g, '').replace(/(?!^)-/g, ''))); return Number.isFinite(n) ? n : 0; };

function kid() {
  const list = (config?.children ?? state?.children ?? []);
  return list.find((k) => k.id === kidId) ?? list[0] ?? null;
}
const kidConfig = () => config?.children.find((k) => k.id === (kid()?.id)) ?? null;

const QUESTS = {
  'sound-keys': ['🔤', 'Letter Rescue'], 'typing-quest': ['⌨️', 'TypingQuest'], 'bible-typing': ['📖', 'Scripture Typing'],
  'khan-academy': ['🎓', 'Khan Academy'], duolingo: ['🦉', 'Duolingo'], rwt: ['✏️', 'Read, Write & Type!'], discgames: ['💿', 'Classic CD games'],
};
const OPTION_LABELS = { perAnswer: 'Coins per correct answer', perVideo: 'Coins per finished video', perStory: 'Coins per finished story', wordsPer: 'Pay', repeatsPerDay: 'Each passage can earn' };
const OPTION_CHOICES = {
  wordsPer: [['0', 'Same for every passage'], ['10', 'Per 10 words'], ['20', 'Per 20 words'], ['25', 'Per 25 words'], ['50', 'Per 50 words']],
  repeatsPerDay: [['1', 'Once a day'], ['2', 'Twice a day'], ['3', '3 times a day'], ['0', 'Any number of times']],
};
const quest = (id) => QUESTS[id] ?? ['⭐', id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' ')];
const KINDS = { RealWorld: ['🎁', 'Treat'], YouTube: ['▶️', 'YouTube time'], ScreenTimeExtension: ['⏰', 'Extra screen time'], SiteUnlock: ['🌐', 'Website time'], ArcadeUnlock: ['🕹️', 'Arcade time'], AppUnlock: ['💻', 'App time'] };
const SOURCES = { parent: 'Parent', arcade: 'Arcade', youtube: 'YouTube', discgames: 'Classic CD games', rwt: 'Read, Write & Type!' };
const sourceName = (s) => QUESTS[s]?.[1] ?? SOURCES[s] ?? s;

// Don't redraw under a parent's thumb while they're typing.
function render() {
  const a = document.activeElement;
  if (a && app.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) { pendingRender = true; return; }
  pendingRender = false; draw();
}
let pendingRender = false;
app.addEventListener('focusout', () => setTimeout(() => { if (pendingRender) render(); }, 0));

// ---- screens -----------------------------------------------------------------------------------------------------

function draw() {
  if (!link) {
    app.innerHTML = `
      <header><img src="icon-192.png" alt=""><h1>CoinQuest</h1></header>
      <div class="card empty">
        <h2>Link this phone to your kids' PC</h2>
        <ol>
          <li>On the kids' PC, open the <b>parent app</b> (enter your parent PIN).</li>
          <li>Go to <b>Settings</b> and press <b>Show the code</b> under <b>Control from my phone</b>.</li>
          <li>Point this phone's camera at the code that appears.</li>
        </ol>
        <p class="note">No account or password — the code is the key. You can remove this phone from the PC any time.</p>
      </div>`;
    return;
  }
  const pcs = links.length > 1
    ? `<div class="pills">${links.map((l, i) => { const pcName = meta[l.topicIn]?.pcName || l.pcName; return `<button data-pc="${i}" class="${l === link ? 'on' : ''}">${esc(pcName && links.some((x) => x !== l && x.household === l.household) ? pcName : l.household)}</button>`; }).join('')}</div>` : '';
  const kids = (config?.children ?? state?.children ?? []);
  const kidPicker = tab !== 'home' && kids.length > 1
    ? `<div class="pills">${kids.map((k) => `<button data-kid="${esc(k.id)}" class="${k.id === kid()?.id ? 'on' : ''}">${esc(k.name)}</button>`).join('')}</div>` : '';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const hint = tab === 'home' && !standalone && !store.get('cq.hintDone', false)
    ? `<div class="hint"><div><b>Tip:</b> add this to your home screen so it opens like an app — in Safari tap <b>Share → Add to Home Screen</b>; in Chrome tap <b>⋮ → Add to Home screen</b>.</div><button data-hint aria-label="Dismiss">×</button></div>` : '';
  const asOf = stateAt ? new Date(stateAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const statusText = status === 'on' ? `PC answered ${ago(new Date(updatedAt).toISOString())}`
    : status === 'wait' ? (state && asOf ? `Asking the PC… (showing ${asOf})` : 'Asking the PC…')
    : state && asOf ? `PC is offline — showing what it last sent (${asOf})` : 'Not connected to the PC';
  const body = { home: homeScreen, history: historyScreen, rewards: rewardsScreen, shop: shopScreen, allowed: allowedScreen }[tab]();
  const tabs = [['home', '🏠', 'Home'], ['history', '🧾', 'History'], ['rewards', '⭐', 'Rewards'], ['shop', '🛍️', 'Shop'], ['allowed', '🌐', 'Allowed']];
  app.innerHTML = `
    <header><img src="icon-192.png" alt=""><h1>${esc(state?.household || link.household)}</h1><button class="icon" data-refresh aria-label="Refresh">↻</button></header>
    ${pcs}
    <div class="status"><span class="dot ${status}"></span>${statusText}</div>
    ${hint}
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    ${kidPicker}
    ${body}
    <nav class="tabbar">${tabs.map(([id, icon, label]) => `<button data-tab="${id}" class="${tab === id ? 'on' : ''}" aria-label="${label}"><span>${icon}</span>${label}${id === 'home' && state?.claims?.length ? `<i>${state.claims.length}</i>` : ''}</button>`).join('')}</nav>`;
}

function homeScreen() {
  if (!state) return status !== 'off' ? `<div class="card empty"><p>Asking the PC…</p></div>` : '';
  const claims = state.claims || [];
  let out = claims.length ? `<h2>Waiting for you</h2>` + claims.map((c) => `
      <div class="card claim">
        <div><span class="who">${esc(c.child)}</span> <span class="t">${ago(c.at)}</span></div>
        <p>${esc(c.what)} · ${coins(c.coins)}</p>
        <div class="row"><button class="give" data-claim="${c.seq}" data-ok="1">Approve</button><button class="take" data-claim="${c.seq}" data-ok="0">Not this time</button></div>
      </div>`).join('') : '';
  out += (state.children || []).map((k) => `
      <div class="card">
        <div class="kid-top">
          <p class="kid-name">${esc(k.name)}${state.atKeyboard === k.id ? '<span class="here">at the PC</span>' : ''}</p>
          <div class="balance">${coins(k.balance)}</div>
        </div>
        <div class="today">Today: <span class="plus">+${k.earnedToday}</span> earned · <span class="minus">${k.spentToday ? '−' + k.spentToday : '0'}</span> spent</div>
        <div class="row"><button class="give" data-give="${esc(k.id)}">＋ Give</button><button class="take" data-take="${esc(k.id)}">－ Take</button></div>
        ${(k.unlocks || []).map((u) => `<div class="unlock"><span>▶ ${esc(u.name)} · ${mins(u.secondsLeft)} left</span><button data-end="${esc(u.id)}">End now</button></div>`).join('')}
        ${k.recent?.length ? `<details><summary>Today's activity</summary><ul class="feed">${k.recent.map((e) => `<li><span class="what">${esc(e.what)}<br><span class="t">${ago(e.at)}</span></span><span class="${e.delta >= 0 ? 'plus' : 'minus'}">${signed(e.delta)}</span></li>`).join('')}</ul><button class="link" data-tab="history" data-kidgo="${esc(k.id)}">See all history →</button></details>` : ''}
      </div>`).join('');
  if (!(state.children || []).length) out += `<div class="card empty"><p>No children are set up on this PC yet.</p></div>`;
  return out + `<p class="note">Linked as “${esc(link.phone)}”. To unlink, remove this phone in the parent app on the PC.<br><button data-forget class="small">Forget this PC on this phone</button></p>`;
}

function historyScreen() {
  const k = kid();
  if (!k) return `<div class="card empty"><p>Asking the PC…</p></div>`;
  if (hist.kid !== k.id && !hist.loading) { setTimeout(() => loadHistory(true), 0); return `<div class="card empty"><p>Loading history…</p></div>`; }
  if (!hist.entries.length) return hist.loading ? `<div class="card empty"><p>Loading history…</p></div>` : `<div class="card empty"><p>Nothing yet.</p></div>`;
  let out = '', day = '';
  for (const e of hist.entries) {
    const d = dayLabel(e.at);
    if (d !== day) { out += `${day ? '</ul></div>' : ''}<h2>${esc(d)}</h2><div class="card list"><ul class="feed">`; day = d; }
    const pending = e.kind === 'Claim';
    const who = e.source === 'parent' && e.actor ? (String(e.actor).startsWith('phone:') ? ` · ${esc(String(e.actor).slice(6))}` : ' · on the PC') : '';
    out += `<li><span class="what">${esc(e.detail || sourceName(e.source))}<br><span class="t">${clock(e.at)} · ${esc(sourceName(e.source))}${who}${pending ? ' · waiting for you' : e.kind === 'ClaimDenied' ? ' · declined' : ''}</span></span><span class="${pending ? 't' : e.delta >= 0 ? 'plus' : 'minus'}">${pending ? '⏳' : signed(e.delta)}</span></li>`;
  }
  out += '</ul></div>';
  if (hist.more) out += `<button class="wide" data-more ${hist.loading ? 'disabled' : ''}>${hist.loading ? 'Loading…' : 'Show older'}</button>`;
  return out;
}

const field = (label, attrs, hint = '') => `<label class="field"><span>${label}${hint ? `<small>${hint}</small>` : ''}</span><input ${attrs}></label>`;
const toggle = (on, attrs) => `<label class="switch"><input type="checkbox" ${on ? 'checked' : ''} ${attrs}><span></span></label>`;

function rewardsScreen() {
  const kc = kidConfig();
  if (!kc) { if (status !== 'off') setTimeout(() => loadConfig().catch((e) => { error = e.message; render(); }), 0); return `<div class="card empty"><p>Loading quests…</p></div>`; }
  return `<p class="lead">Coins ${esc(kc.name)} earns for each quest. A negative number takes coins away instead. Changes save as you go.</p>` +
    kc.modules.map((m) => {
      const [icon, title] = quest(m.id);
      const opts = Object.entries(m.options || {}).filter(([k]) => OPTION_LABELS[k]);
      return `
      <div class="card quest ${m.enabled ? '' : 'off'}">
        <div class="quest-top"><p class="kid-name">${icon} ${esc(title)}</p>${toggle(m.enabled, `data-q="${esc(m.id)}" data-f="enabled" aria-label="${esc(title)} on or off"`)}</div>
        ${m.enabled ? `
        <div class="grid2">
          ${field(m.id === 'discgames' ? 'Coins per progress' : m.id === 'rwt' ? 'Coins per level' : m.id === 'bible-typing' ? (+m.options?.wordsPer ? `Coins per ${m.options.wordsPer} words` : 'Coins per passage') : 'Coins per activity', `type="text" inputmode="numeric" value="${m.coinsPerActivity}" data-q="${esc(m.id)}" data-f="coinsPerActivity"`)}
          ${field('Daily limit', `type="text" inputmode="numeric" value="${m.dailyCap}" data-q="${esc(m.id)}" data-f="dailyCap"`, '0 = none')}
          ${opts.filter(([k]) => !OPTION_CHOICES[k]).map(([k, v]) => field(OPTION_LABELS[k], `type="text" inputmode="numeric" value="${esc(v)}" data-q="${esc(m.id)}" data-opt="${esc(k)}"`)).join('')}
        </div>
        ${opts.filter(([k]) => OPTION_CHOICES[k]).map(([k, v]) => `<label class="field"><span>${esc(OPTION_LABELS[k])}</span><select data-q="${esc(m.id)}" data-opt="${esc(k)}">${OPTION_CHOICES[k].map(([cv, cl]) => `<option value="${cv}" ${cv === String(v) ? 'selected' : ''}>${esc(cl)}</option>`).join('')}</select></label>`).join('')}
        <div class="row between"><span>Needs my OK first</span>${toggle(m.requireApproval, `data-q="${esc(m.id)}" data-f="requireApproval" aria-label="Needs my OK"`)}</div>
        <p class="t">Earned today: ${signed(m.earnedToday)}</p>` : ''}
      </div>`;
    }).join('');
}

function shopScreen() {
  const kc = kidConfig();
  if (!kc) { if (status !== 'off') setTimeout(() => loadConfig().catch((e) => { error = e.message; render(); }), 0); return `<div class="card empty"><p>Loading the shop…</p></div>`; }
  return `<p class="lead">What ${esc(kc.name)} can buy with coins. Tap one to change it.</p>
    <div class="card list"><ul class="prizes">${kc.prizes.map((p) => `
      <li><button data-prize="${esc(p.id)}" class="${p.enabled ? '' : 'off'}"><span class="pi">${(KINDS[p.kind] ?? ['🎁'])[0]}</span><span class="what"><b>${esc(p.name)}</b><br><span class="t">${[p.minutes ? `${p.minutes} min` : '', (p.targets || []).length ? targetText(p) : '', p.dailyCap ? `max ${p.dailyCap}/day` : '', p.enabled ? '' : 'hidden'].filter(Boolean).join(' · ') || (KINDS[p.kind] ?? ['', ''])[1]}</span></span><span class="price">${coins(p.cost)}</span></button></li>`).join('')}
    </ul></div>
    <button class="wide primary" data-newprize>＋ New prize</button>
    <p class="note">Arcade prizes and prices are set up on the PC.</p>`;
}

function allowedScreen() {
  const kc = kidConfig();
  if (!kc) { if (status !== 'off') setTimeout(() => loadConfig().catch((e) => { error = e.message; render(); }), 0); return `<div class="card empty"><p>Loading…</p></div>`; }
  return `
    <h2>Websites</h2>
    <div class="card">
      <p class="t" style="margin-top:0">The only websites that open for ${esc(kc.name)} (inside CoinQuest's locked browser).</p>
      <div class="chips">${kc.sites.map((s) => `<span class="chip">${esc(s)}<button data-unsite="${esc(s)}" aria-label="Remove ${esc(s)}">×</button></span>`).join('') || '<span class="t">None yet.</span>'}</div>
      <form class="row" data-addsite><input type="text" inputmode="url" autocapitalize="off" autocomplete="off" placeholder="e.g. duolingo.com" name="site"><button class="primary" type="submit">Add</button></form>
    </div>
    <h2>Apps</h2>
    <div class="card">
      <p class="t" style="margin-top:0">Programs ${esc(kc.name)} can always open, on top of CoinQuest's own.</p>
      <div class="chips">${(kc.apps || []).map((a) => `<span class="chip">${esc(appName(a))}<button data-unapp="${esc(a)}" aria-label="Remove ${esc(a)}">×</button></span>`).join('') || '<span class="t">None yet.</span>'}</div>
      <button class="wide primary" data-addapp>＋ Add an app</button>
    </div>
    <h2>YouTube channels</h2>
    <div class="card">
      <p class="t" style="margin-top:0">During YouTube time, ${esc(kc.name)} sees recent videos from these channels only.</p>
      <ul class="feed">${kc.channels.map((c) => `<li><span class="what">${esc(c.title || c.url)}</span><button class="small" data-unchan="${esc(c.id)}">Remove</button></li>`).join('') || '<li><span class="t">None yet.</span></li>'}</ul>
      <form class="row" data-addchan style="margin-top:10px"><input type="text" inputmode="url" autocapitalize="off" autocomplete="off" placeholder="Paste a channel link, e.g. youtube.com/@MarkRober" name="chan"><button class="primary" type="submit">Add</button></form>
    </div>
    <p class="note">The internet lock and the parent PIN are only changed on the PC.</p>`;
}

// ---- sheets ------------------------------------------------------------------------------------------------------

function giveSheet(childId, sign) {
  const k = state.children.find((c) => c.id === childId);
  let amount = 5;
  const presets = [1, 5, 10, 25];
  sheet.innerHTML = `
    <form method="dialog">
      <h3>${sign > 0 ? 'Give coins to' : 'Take coins from'} ${esc(k.name)}</h3>
      <div class="amounts">${presets.map((n) => `<button type="button" data-amt="${n}" class="${n === amount ? 'sel' : ''}">${n}</button>`).join('')}</div>
      <div class="row" style="gap:8px;margin-bottom:10px"><input type="text" inputmode="numeric" autocomplete="off" placeholder="Other amount (can be negative)" id="amt" style="margin:0;flex:1"><button type="button" data-sign style="flex:none;min-width:56px" aria-label="Make negative or positive">±</button></div>
      <input type="text" id="why" maxlength="80" placeholder="${sign > 0 ? 'What for? (e.g. Helped with dishes)' : 'Why? (optional)'}">
      <div class="row"><button type="button" data-cancel>Cancel</button><button type="submit" class="${sign > 0 ? 'give' : 'take'}" data-ok>${sign > 0 ? 'Give' : 'Take'} <span id="amtLabel">${amount}</span></button></div>
    </form>`;
  const label = sheet.querySelector('#amtLabel');
  const amt = sheet.querySelector('#amt');
  sheet.querySelectorAll('[data-amt]').forEach((b) => b.addEventListener('click', () => {
    amount = +b.dataset.amt; label.textContent = amount; amt.value = '';
    sheet.querySelectorAll('[data-amt]').forEach((x) => x.classList.toggle('sel', x === b));
  }));
  amt.addEventListener('input', () => {
    const v = num(amt.value);
    if (v !== 0) { amount = Math.max(-1000, Math.min(1000, v)); label.textContent = amount; sheet.querySelectorAll('[data-amt]').forEach((x) => x.classList.remove('sel')); }
  });
  sheet.querySelector('[data-sign]').addEventListener('click', () => {
    amount = -amount; amt.value = String(amount); label.textContent = amount;
    sheet.querySelectorAll('[data-amt]').forEach((x) => x.classList.toggle('sel', +x.dataset.amt === amount));
  });
  sheet.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  sheet.querySelector('form').addEventListener('submit', () => {
    const why = sheet.querySelector('#why').value.trim();
    act('adjust', { childId, delta: sign * amount, reason: why || (sign > 0 ? 'From a parent (phone)' : 'Taken by a parent (phone)') },
      `${sign > 0 ? 'Gave' : 'Took'} ${amount} ${sign > 0 ? 'to' : 'from'} ${k.name}`).then(() => { if (tab === 'history') loadHistory(true); });
  });
  sheet.showModal();
}

// ---- apps on the PC (for app prizes and allowed apps) ------------------------------------------------------------
let pcApps = null; // [{ name, exe }] from the PC's Start menu, loaded once
const appName = (exe) => pcApps?.find((a) => a.exe.toLowerCase() === exe.toLowerCase())?.name ?? exe.replace(/\.exe$/i, '');
const targetText = (p) => p.targets.map((t) => p.kind === 'AppUnlock' ? appName(t) : t).join(', ');
async function loadApps() {
  if (!pcApps) { const d = await send('apps'); pcApps = Array.isArray(d?.result) ? d.result : []; }
  return pcApps;
}

/** A searchable list of the PC's apps with tick boxes, plus "another program" by name. Calls back with the ticked exes. */
function appPicker(host, chosen, onChange) {
  const draw = (q = '') => {
    // Programs already picked that aren't in the Start menu (typed by name) are listed too, so they can be unticked.
    const extra = chosen.filter((c) => !(pcApps || []).some((a) => a.exe.toLowerCase() === c.toLowerCase())).map((c) => ({ name: c.replace(/\.exe$/i, ''), exe: c }));
    const list = [...extra, ...(pcApps || [])].filter((a) => !q || (a.name + ' ' + a.exe).toLowerCase().includes(q.toLowerCase()));
    host.querySelector('.applist').innerHTML = pcApps === null ? '<li class="t">Asking the PC for its apps…</li>'
      : list.map((a) => `<li><label class="pick"><input type="checkbox" value="${esc(a.exe)}" ${chosen.some((c) => c.toLowerCase() === a.exe.toLowerCase()) ? 'checked' : ''}><span><b>${esc(a.name)}</b><br><span class="t">${esc(a.exe)}</span></span></label></li>`).join('')
        || '<li class="t">No apps match. Type the program name below instead.</li>';
  };
  host.innerHTML = `<input type="search" placeholder="Search apps on the PC" class="appq" autocomplete="off">
    <ul class="applist"></ul>
    <div class="row" style="gap:8px"><input type="text" class="appother" autocapitalize="off" autocomplete="off" placeholder="Another program, e.g. Minecraft.exe" style="margin:0;flex:1"><button type="button" class="appadd" style="flex:none">Add</button></div>`;
  const q = host.querySelector('.appq');
  q.addEventListener('input', () => draw(q.value));
  host.querySelector('.applist').addEventListener('change', (e) => {
    const exe = e.target.value;
    if (e.target.checked) { if (!chosen.includes(exe)) chosen.push(exe); } else if (chosen.includes(exe)) chosen.splice(chosen.indexOf(exe), 1);
    onChange(chosen);
  });
  host.querySelector('.appadd').addEventListener('click', () => {
    const o = host.querySelector('.appother'); let v = o.value.trim().split(/[\\/]/).pop();
    if (!v) return; if (!/\.exe$/i.test(v)) v += '.exe';
    if (!chosen.some((c) => c.toLowerCase() === v.toLowerCase())) chosen.push(v);
    o.value = ''; onChange(chosen); draw(q.value);
  });
  draw();
  loadApps().then(() => draw(q.value)).catch(() => { pcApps = []; draw(q.value); });
}

function addAppSheet() {
  const kc = kidConfig();
  const chosen = [];
  sheet.innerHTML = `
    <form method="dialog">
      <h3>Add apps for ${esc(kc.name)}</h3>
      <p class="t">Ticked programs open any time. Web browsers stay blocked; add websites instead.</p>
      <div id="picker"></div>
      <div class="row"><button type="button" data-cancel>Cancel</button><button type="submit" class="give" id="ok" disabled>Add</button></div>
    </form>`;
  const ok = sheet.querySelector('#ok');
  appPicker(sheet.querySelector('#picker'), chosen, (c) => { ok.disabled = c.length === 0; ok.textContent = c.length > 1 ? `Add ${c.length}` : 'Add'; });
  sheet.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  sheet.querySelector('form').addEventListener('submit', (e) => {
    if (!chosen.length) { e.preventDefault(); return; }
    act('setApps', { childId: kc.id, add: chosen }, chosen.length > 1 ? `Added ${chosen.length} apps` : `Added ${appName(chosen[0])}`);
  });
  sheet.showModal();
}

const NEW_KINDS = ['RealWorld', 'YouTube', 'ScreenTimeExtension', 'SiteUnlock', 'AppUnlock'];

function prizeSheet(p) {
  const kc = kidConfig();
  const isNew = !p;
  p = p ?? { name: '', cost: 30, kind: 'RealWorld', minutes: 15, dailyCap: 1, enabled: true, targets: [] };
  let kind = p.kind;
  const targets = [...(p.targets || [])];
  const timed = (k) => k !== 'RealWorld';
  const hasTargets = (k) => k === 'SiteUnlock' || k === 'AppUnlock';
  sheet.innerHTML = `
    <form method="dialog">
      <h3>${isNew ? 'New prize' : 'Edit prize'}</h3>
      ${isNew ? `<label class="field"><span>Kind</span><select id="pk">${NEW_KINDS.map((k) => `<option value="${k}">${KINDS[k][0]} ${KINDS[k][1]}</option>`).join('')}</select></label>` : `<p class="t">${(KINDS[p.kind] ?? ['', ''])[0]} ${(KINDS[p.kind] ?? ['', 'Prize'])[1]}</p>`}
      ${field('Name', `type="text" id="pn" maxlength="60" value="${esc(p.name)}" placeholder="e.g. Pick Friday's movie"`)}
      <div id="ptw"></div>
      <div class="grid2">
        ${field('Price', `type="text" inputmode="numeric" id="pc" value="${p.cost}"`, 'coins')}
        ${field('Max per day', `type="text" inputmode="numeric" id="pd" value="${p.dailyCap}"`, '0 = no limit')}
        <span id="pmw" ${timed(kind) ? '' : 'hidden'}>${field('Minutes', `type="text" inputmode="numeric" id="pm" value="${p.minutes || 15}"`)}</span>
      </div>
      <div class="row between" style="margin:6px 0 14px"><span>Shown in the shop</span>${toggle(p.enabled, 'id="pe"')}</div>
      ${!isNew && timed(kind) ? `<button type="button" class="wide" data-grant>▶ Start it now, free</button>` : ''}
      <div class="row">${isNew ? '' : '<button type="button" class="take" data-del>Delete</button>'}<button type="button" data-cancel>Cancel</button><button type="submit" class="give">Save</button></div>
    </form>`;
  const ptw = sheet.querySelector('#ptw');
  const drawTargets = () => {
    if (!hasTargets(kind)) { ptw.innerHTML = ''; return; }
    if (kind === 'SiteUnlock') {
      ptw.innerHTML = `<label class="field"><span>Websites it opens</span></label>
        <div class="chips">${targets.map((t, i) => `<span class="chip">${esc(t)}<button type="button" data-untarget="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join('') || '<span class="t">None yet.</span>'}</div>
        <div class="row" style="gap:8px;margin-bottom:10px"><input type="text" inputmode="url" autocapitalize="off" autocomplete="off" id="psite" placeholder="e.g. minecraft.net" style="margin:0;flex:1"><button type="button" id="psadd" style="flex:none">Add</button></div>`;
      const add = () => { const i = ptw.querySelector('#psite'); const v = i.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]; if (v && !targets.includes(v)) targets.push(v); drawTargets(); ptw.querySelector('#psite').focus(); };
      ptw.querySelector('#psadd').addEventListener('click', add);
      ptw.querySelector('#psite').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    } else {
      ptw.innerHTML = `<label class="field"><span>Apps it opens</span></label><div id="pp"></div>`;
      appPicker(ptw.querySelector('#pp'), targets, () => {});
    }
    ptw.querySelectorAll('[data-untarget]').forEach((b) => b.addEventListener('click', () => { targets.splice(+b.dataset.untarget, 1); drawTargets(); }));
  };
  drawTargets();
  const kindSel = sheet.querySelector('#pk');
  kindSel?.addEventListener('change', () => {
    kind = kindSel.value; targets.length = 0;
    sheet.querySelector('#pmw').hidden = !timed(kind);
    drawTargets();
  });
  sheet.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  sheet.querySelector('[data-del]')?.addEventListener('click', () => {
    sheet.close();
    act('deletePrize', { childId: kc.id, id: p.id }, `Removed “${p.name}”`);
  });
  sheet.querySelector('[data-grant]')?.addEventListener('click', () => {
    const minutes = Math.max(1, num(sheet.querySelector('#pm').value));
    sheet.close();
    act('grant', { childId: kc.id, prizeId: p.id, minutes }, `${p.name}: ${minutes} min started for ${kc.name}`);
  });
  sheet.querySelector('form').addEventListener('submit', (e) => {
    const name = sheet.querySelector('#pn').value.trim();
    if (!name) { e.preventDefault(); sheet.querySelector('#pn').focus(); return; }
    if (hasTargets(kind) && !targets.length) { e.preventDefault(); (ptw.querySelector('#psite') || ptw.querySelector('.appq'))?.focus(); return; }
    const prize = { id: isNew ? undefined : p.id, kind, name, cost: Math.max(0, num(sheet.querySelector('#pc').value)), dailyCap: Math.max(0, num(sheet.querySelector('#pd').value)), minutes: Math.max(0, num(sheet.querySelector('#pm').value)), enabled: sheet.querySelector('#pe').checked };
    if (hasTargets(kind)) prize.targets = targets;
    act('setPrize', { childId: kc.id, prize }, isNew ? `Added “${name}”` : 'Saved');
  });
  sheet.showModal();
}

let toastTimer;
function toast(text) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = '✓ ' + text; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.style.display = 'none'), 2500);
}

// ---- events ------------------------------------------------------------------------------------------------------

app.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || (b.type === 'submit' && b.form)) return;
  if (b.dataset.refresh !== undefined) { if (tab !== 'home') config = null; refresh(); }
  else if (b.dataset.tab) {
    if (b.dataset.kidgo) kidId = b.dataset.kidgo;
    tab = b.dataset.tab; error = ''; window.scrollTo(0, 0);
    if (tab === 'history') hist.kid = null; // the screen loads the newest page itself
    render();
  }
  else if (b.dataset.kid) { kidId = b.dataset.kid; render(); }
  else if (b.dataset.give) giveSheet(b.dataset.give, +1);
  else if (b.dataset.take) giveSheet(b.dataset.take, -1);
  else if (b.dataset.claim) act('claim', { seq: +b.dataset.claim, approve: b.dataset.ok === '1' }, b.dataset.ok === '1' ? 'Approved' : 'Declined');
  else if (b.dataset.end) act('endUnlock', { unlockId: b.dataset.end }, 'Game time ended');
  else if (b.dataset.more !== undefined) loadHistory(false);
  else if (b.dataset.prize) prizeSheet(kidConfig().prizes.find((p) => p.id === b.dataset.prize));
  else if (b.dataset.newprize !== undefined) prizeSheet(null);
  else if (b.dataset.addapp !== undefined) addAppSheet();
  else if (b.dataset.unapp) act('setApps', { childId: kidConfig().id, remove: b.dataset.unapp }, `Removed ${appName(b.dataset.unapp)}`);
  else if (b.dataset.unsite) act('setSites', { childId: kidConfig().id, remove: b.dataset.unsite }, `Removed ${b.dataset.unsite}`);
  else if (b.dataset.unchan) act('removeChannel', { childId: kidConfig().id, id: b.dataset.unchan }, 'Channel removed');
  else if (b.dataset.pc) { link = links[+b.dataset.pc]; connect(); }
  else if (b.dataset.hint !== undefined) { store.set('cq.hintDone', true); render(); }
  else if (b.dataset.forget !== undefined) {
    dropLink(link); saveLinks();
    link = links[0] ?? null; history.replaceState(null, '', location.pathname); connect();
  }
});

// Quest settings save when a field is finished (or a switch flipped).
app.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset?.q) return;
  const args = { childId: kidConfig().id, moduleId: el.dataset.q };
  if (el.dataset.opt) args.options = { [el.dataset.opt]: el.tagName === 'SELECT' ? el.value : String(num(el.value)) };
  else if (el.type === 'checkbox') args[el.dataset.f] = el.checked;
  else args[el.dataset.f] = el.dataset.f === 'dailyCap' ? Math.max(0, num(el.value)) : num(el.value);
  el.blur();
  act('setQuest', args, 'Saved');
});

app.addEventListener('submit', (e) => {
  const f = e.target;
  e.preventDefault();
  if (f.dataset.addsite !== undefined) {
    const v = f.site.value.trim(); if (!v) return;
    f.site.blur(); act('setSites', { childId: kidConfig().id, add: v }, `Added ${v}`);
  } else if (f.dataset.addchan !== undefined) {
    const v = f.chan.value.trim(); if (!v) return;
    f.chan.blur(); act('addChannel', { childId: kidConfig().id, url: v }, 'Channel added');
  }
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && link && Date.now() - updatedAt > 20000) refresh(); });
setInterval(() => { if (status === 'on' && tab === 'home') render(); }, 30000); // keep "answered … ago" fresh

connect();
