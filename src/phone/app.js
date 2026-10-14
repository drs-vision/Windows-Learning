// CoinQuest on a parent's phone. Linked by scanning the QR code in the parent app on the PC (no account).
// Talks to the PC through the relay with messages scrambled by wire.js; see src/Guardian/Phone/PhoneLinkService.cs.
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
let links = store.get('cq.links', []).map((r) => w.parseLink(r)).filter(Boolean);
const fromHash = location.hash.length > 20 ? w.parseLink(location.hash) : null;
if (fromHash && !links.some((l) => l.topicIn === fromHash.topicIn)) links.push(fromHash);
store.set('cq.links', links.map((l) => l.raw));
let link = fromHash ? links.find((l) => l.topicIn === fromHash.topicIn) : links.find((l) => l.topicIn === store.get('cq.current', '')) ?? links[0];

let key = null, source = null, asm = null;
const waiting = new Map();
let state = null, status = 'wait', error = '', updatedAt = 0;

async function connect() {
  if (source) source.close();
  waiting.clear(); state = null; error = '';
  if (!link) { render(); return; }
  store.set('cq.current', link.topicIn);
  if (location.hash.slice(1) !== link.raw) history.replaceState(null, '', '#' + link.raw);
  key = await w.importKey(link.key);
  asm = w.assembler();
  render();
  // Answers from the PC arrive on our own topic; listen first, then ask.
  source = new EventSource(`${link.relay}/${link.topicOut}/sse?since=${Math.floor(Date.now() / 1000) - 5}`);
  source.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.event !== 'message' || typeof m.message !== 'string') return;
    const whole = asm.add(m.message);
    if (!whole) return;
    const reply = await w.open(key, whole);
    if (!reply) return;
    if (reply.ok && reply.d?.state) { state = reply.d.state; status = 'on'; updatedAt = Date.now(); }
    const p = waiting.get(reply.re);
    if (p) { waiting.delete(reply.re); reply.ok ? p.resolve(reply.d) : p.reject(new Error(reply.e || 'The PC said no')); }
    render();
  };
  source.onerror = () => { if (status !== 'on') { status = 'off'; render(); } };
  refresh();
}

function send(op, args = {}) {
  const id = w.b64url(crypto.getRandomValues(new Uint8Array(9)));
  const done = new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    setTimeout(() => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      reject(new Error("The PC didn't answer. It may be off, asleep or offline — what you sent will reach it when it's back (within 12 hours)."));
    }, 25000);
  });
  (async () => {
    for (const part of w.split(await w.seal(key, { id, ts: Date.now(), op, a: args }))) {
      const r = await fetch(`${link.relay}/${link.topicIn}`, { method: 'POST', body: part });
      if (!r.ok) throw new Error(r.status === 429 ? 'Too many messages right now — try again in a minute.' : `The relay said ${r.status}.`);
    }
  })().catch((e) => { const p = waiting.get(id); if (p) { waiting.delete(id); p.reject(e); } });
  return done;
}

async function refresh() {
  status = 'wait'; error = ''; render();
  try { await send('state'); }
  catch (e) { status = 'off'; error = e.message; render(); }
}

async function act(op, args, label) {
  error = ''; status = 'wait'; render();
  try { await send(op, args); toast(label); }
  catch (e) { error = e.message; status = 'off'; render(); }
}

// ---- screens -----------------------------------------------------------------------------------------------------

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
const mins = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : `${Math.max(1, Math.round(sec / 60))} min`);
const coins = (n) => `<span class="coin"></span>${n}`;

function render() {
  if (!link) {
    app.innerHTML = `
      <header><img src="icon-192.png" alt=""><h1>CoinQuest</h1></header>
      <div class="card empty">
        <h2>Link this phone to your kids' PC</h2>
        <ol>
          <li>On the kids' PC, open the <b>parent app</b> (enter your parent PIN).</li>
          <li>Go to <b>Settings</b> and press <b>Control from my phone</b>.</li>
          <li>Point this phone's camera at the code that appears.</li>
        </ol>
        <p class="note">No account or password — the code is the key. You can remove this phone from the PC any time.</p>
      </div>`;
    return;
  }
  const pcs = links.length > 1
    ? `<div class="pcs">${links.map((l, i) => `<button data-pc="${i}" class="${l === link ? 'on' : ''}">${esc(l.household)}</button>`).join('')}</div>` : '';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const hint = !standalone && !store.get('cq.hintDone', false)
    ? `<div class="hint"><div><b>Tip:</b> add this to your home screen so it opens like an app — in Safari tap <b>Share → Add to Home Screen</b>; in Chrome tap <b>⋮ → Add to Home screen</b>.</div><button data-hint aria-label="Dismiss">×</button></div>` : '';
  const statusText = status === 'on' ? `PC answered ${ago(new Date(updatedAt).toISOString())}` : status === 'wait' ? 'Asking the PC…' : 'Not connected to the PC';
  let body = '';
  if (state) {
    const claims = state.claims || [];
    body += claims.length ? `<h2>Waiting for you</h2>` + claims.map((c) => `
      <div class="card claim">
        <div><span class="who">${esc(c.child)}</span> <span class="t">${ago(c.at)}</span></div>
        <p>${esc(c.what)} · ${coins(c.coins)}</p>
        <div class="row"><button class="give" data-claim="${c.seq}" data-ok="1">Approve</button><button class="take" data-claim="${c.seq}" data-ok="0">Not this time</button></div>
      </div>`).join('') : '';
    body += (state.children || []).map((k) => `
      <div class="card">
        <div class="kid-top">
          <p class="kid-name">${esc(k.name)}${state.atKeyboard === k.id ? '<span class="here">at the PC</span>' : ''}</p>
          <div class="balance">${coins(k.balance)}</div>
        </div>
        <div class="today">Today: <span class="plus">+${k.earnedToday}</span> earned · <span class="minus">${k.spentToday ? "−" + k.spentToday : "0"}</span> spent</div>
        <div class="row"><button class="give" data-give="${esc(k.id)}">＋ Give</button><button class="take" data-take="${esc(k.id)}">－ Take</button></div>
        ${(k.unlocks || []).map((u) => `<div class="unlock"><span>▶ ${esc(u.name)} · ${mins(u.secondsLeft)} left</span><button data-end="${esc(u.id)}">End now</button></div>`).join('')}
        ${k.recent?.length ? `<details><summary>Today's activity</summary><ul class="feed">${k.recent.map((e) => `<li><span class="what">${esc(e.what)}<br><span class="t">${ago(e.at)}</span></span><span class="${e.delta >= 0 ? 'plus' : 'minus'}">${e.delta >= 0 ? '+' : '−'}${Math.abs(e.delta)}</span></li>`).join('')}</ul></details>` : ''}
      </div>`).join('');
    if (!(state.children || []).length) body += `<div class="card empty"><p>No children are set up on this PC yet.</p></div>`;
  } else if (status !== 'off') {
    body = `<div class="card empty"><p>Asking the PC…</p></div>`;
  }
  app.innerHTML = `
    <header><img src="icon-192.png" alt=""><h1>${esc(state?.household || link.household)}</h1><button class="icon" data-refresh aria-label="Refresh">↻</button></header>
    ${pcs}
    <div class="status"><span class="dot ${status}"></span>${statusText}</div>
    ${hint}
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    ${body}
    <p class="note">Linked as “${esc(link.phone)}”. To unlink, remove this phone in the parent app on the PC.<br><button data-forget style="min-height:0;padding:6px 10px;margin-top:8px;font-size:13px">Forget this PC on this phone</button></p>`;
}

function giveSheet(childId, sign) {
  const kid = state.children.find((c) => c.id === childId);
  let amount = 5;
  const presets = [1, 5, 10, 25];
  sheet.innerHTML = `
    <form method="dialog">
      <h3>${sign > 0 ? 'Give coins to' : 'Take coins from'} ${esc(kid.name)}</h3>
      <div class="amounts">${presets.map((n) => `<button type="button" data-amt="${n}" class="${n === amount ? 'sel' : ''}">${n}</button>`).join('')}</div>
      <input type="number" inputmode="numeric" min="1" max="1000" placeholder="Other amount" id="amt">
      <input type="text" id="why" maxlength="80" placeholder="${sign > 0 ? 'What for? (e.g. Helped with dishes)' : 'Why? (optional)'}">
      <div class="row"><button type="button" data-cancel>Cancel</button><button type="submit" class="${sign > 0 ? 'give' : 'take'}" data-ok>${sign > 0 ? 'Give' : 'Take'} <span id="amtLabel">${amount}</span></button></div>
    </form>`;
  const label = sheet.querySelector('#amtLabel');
  sheet.querySelectorAll('[data-amt]').forEach((b) => b.addEventListener('click', () => {
    amount = +b.dataset.amt; label.textContent = amount; sheet.querySelector('#amt').value = '';
    sheet.querySelectorAll('[data-amt]').forEach((x) => x.classList.toggle('sel', x === b));
  }));
  sheet.querySelector('#amt').addEventListener('input', (e) => {
    const v = Math.round(+e.target.value);
    if (v > 0) { amount = Math.min(1000, v); label.textContent = amount; sheet.querySelectorAll('[data-amt]').forEach((x) => x.classList.remove('sel')); }
  });
  sheet.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  sheet.querySelector('form').addEventListener('submit', () => {
    const why = sheet.querySelector('#why').value.trim();
    act('adjust', { childId, delta: sign * amount, reason: why || (sign > 0 ? 'From a parent (phone)' : 'Taken by a parent (phone)') },
      `${sign > 0 ? 'Gave' : 'Took'} ${amount} ${sign > 0 ? 'to' : 'from'} ${kid.name}`);
  });
  sheet.showModal();
}

let toastTimer;
function toast(text) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div'); t.id = 'toast';
    t.style.cssText = 'position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:99px;font-size:14px;z-index:9;max-width:90vw';
    document.body.appendChild(t);
  }
  t.textContent = '✓ ' + text; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.style.display = 'none'), 2500);
}

app.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.refresh !== undefined) refresh();
  else if (b.dataset.give) giveSheet(b.dataset.give, +1);
  else if (b.dataset.take) giveSheet(b.dataset.take, -1);
  else if (b.dataset.claim) act('claim', { seq: +b.dataset.claim, approve: b.dataset.ok === '1' }, b.dataset.ok === '1' ? 'Approved' : 'Declined');
  else if (b.dataset.end) act('endUnlock', { unlockId: b.dataset.end }, 'Game time ended');
  else if (b.dataset.pc) { link = links[+b.dataset.pc]; connect(); }
  else if (b.dataset.hint !== undefined) { store.set('cq.hintDone', true); render(); }
  else if (b.dataset.forget !== undefined) {
    links = links.filter((l) => l !== link); store.set('cq.links', links.map((l) => l.raw));
    link = links[0] ?? null; history.replaceState(null, '', location.pathname); connect();
  }
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && link) refresh(); });
setInterval(() => { if (status === 'on') render(); }, 30000); // keep "answered … ago" fresh

connect();
