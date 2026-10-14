import { useEffect, useRef, useState } from 'preact/hooks';
import type { Child, FlashpointGame, FpCatalogGame, Game, ParentState, Prize, WebGame } from '../core/types';
import { BLOCK_MINUTES, autoSamplerPrice, defaultArcadePrice, youTubeBlockPrice } from '../core/types';
import { bridge, type DiscStatus, type FpStatus, type RwtStatus } from '../core/bridge';
import { MODULES } from '../modules/registry';
import { SetupWizard } from './SetupWizard';
import { fmt } from '../modules/arcade/Arcade';
import { merge3 } from '../core/merge';

type Tab = 'today' | 'approvals' | 'allowed' | 'shop' | 'quests' | 'settings';

/** Five screens (plus Settings). Works standalone in the Parent Console app, or embedded in Scholar behind the PIN. */
export function ParentConsole({ embedded, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const [hello, setHello] = useState<{ isAdmin: boolean; setupNeeded: boolean; childId?: string } | null>(null);
  const [authed, setAuthed] = useState(false);
  const [state, setState] = useState<ParentState | null>(null);
  const [tab, setTab] = useState<Tab>('today');
  const [error, setError] = useState('');

  const sayHello = () => { setError(''); bridge.hello().then(setHello).catch((e) => setError(e.message)); };
  useEffect(sayHello, []);

  const refresh = () => bridge.parentState().then((s) => { setState(s); setError(''); }).catch((e) => setError(e.message));

  useEffect(() => {
    if (!authed) return;
    refresh();
    const off = bridge.on((ev) => { if (ev.name === 'approvals' || ev.name === 'state') refresh(); });
    const t = setInterval(refresh, 15000);
    return () => { off(); clearInterval(t); };
  }, [authed]);

  if (error && !hello) return (
    <div class="screen center">
      <h2>Can't reach the Guardian</h2>
      <p class="error">{error}</p>
      <p class="muted">The CoinQuest Guardian is a Windows service that should start automatically. If this keeps happening, open Services, find "CoinQuest Guardian" and start it, then check <code>C:\ProgramData\CoinQuest\logs\guardian.log</code>.</p>
      <button class="primary" onClick={sayHello}>Try again</button>
    </div>
  );
  if (!hello) return <div class="screen center"><p class="muted">Connecting…</p></div>;
  if (hello.setupNeeded) return <SetupWizard onDone={() => { setHello({ ...hello, setupNeeded: false }); setAuthed(true); }} />;

  // An admin account that isn't itself a managed child gets in without a PIN (it's the parent's own login).
  // Inside the child's session (embedded) the PIN is always required.
  const needsPin = embedded || !hello.isAdmin || !!hello.childId;
  if (!authed && needsPin) return <PinGate onOk={() => setAuthed(true)} onCancel={onClose} />;
  if (!authed) { setAuthed(true); return null; }
  if (!state) return <div class="screen center"><p class="muted">Loading…</p>{error && <p class="error">{error}</p>}</div>;

  const child = state.household.children[0];
  const pendingCount = state.pendingClaims.length;

  return (
    <div class="parent">
      <nav class="tabs">
        {([['today', 'Today'], ['approvals', pendingCount ? `Approvals (${pendingCount})` : 'Approvals'], ['allowed', 'Allowed'], ['shop', 'Shop'], ['quests', 'Quests'], ['settings', 'Settings']] as [Tab, string][]).map(([t, label]) => (
          <button class={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}</button>
        ))}
        {embedded && <button class="ghost close" onClick={onClose}>✕ Close</button>}
      </nav>
      {error && <p class="error">{error}</p>}
      <section class="tab-body">
        {!child && <p class="muted">No child set up yet.</p>}
        {child && tab === 'today' && <Today state={state} child={child} onChange={refresh} onGo={setTab} />}
        {child && tab === 'approvals' && <Approvals state={state} onChange={refresh} />}
        {child && tab === 'allowed' && <Allowed child={child} onSave={(c) => save(child, c, refresh, setError)} />}
        {child && tab === 'shop' && <ShopEditor child={child} onSave={(c) => save(child, c, refresh, setError)} />}
        {child && tab === 'quests' && <Quests child={child} onSave={(c) => save(child, c, refresh, setError)} />}
        {child && tab === 'settings' && <Settings state={state} child={child} onSave={(c) => save(child, c, refresh, setError)} onChange={refresh} />}
      </section>
    </div>
  );
}

/**
 * Saves never overwrite each other. Each screen edits the copy of the child it was showing (`base`); a save that lands
 * after another one (e.g. a YouTube channel that took a few seconds to look up, while a website was added) used to
 * send that older copy whole and wipe the other change out. Now saves run one at a time, each re-reads the latest
 * settings from the Guardian and applies only what this screen actually changed.
 */
let saveChain: Promise<unknown> = Promise.resolve();
function save(base: Child, mine: Child, refresh: () => void, setError: (s: string) => void) {
  saveChain = saveChain.then(async () => {
    try {
      const latest = (await bridge.parentState()).household.children.find((c) => c.id === base.id) ?? base;
      await bridge.parentUpdateChild(merge3(base, mine, latest) as Child);
      refresh();
    } catch (e) { setError((e as Error).message); }
  });
  return saveChain;
}


function PinGate({ onOk, onCancel }: { onOk: () => void; onCancel?: () => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  async function go(e: Event) {
    e.preventDefault();
    try { await bridge.parentLogin(pin); onOk(); } catch (ex) { setErr((ex as Error).message); setPin(''); }
  }
  return (
    <form class="screen center pin-gate" onSubmit={go}>
      <h2>Parent PIN</h2>
      <input type="password" inputMode="numeric" autofocus value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value)} maxLength={8} />
      {err && <p class="error">{err}</p>}
      <div class="row"><button class="primary" type="submit" disabled={pin.length < 4}>Open</button>{onCancel && <button class="ghost" type="button" onClick={onCancel}>Cancel</button>}</div>
    </form>
  );
}

// ---------------------------------------------------------------- Today

function ClassicsNudge({ child, onGo }: { child: Child; onGo: () => void }) {
  const [st, setSt] = useState<FpStatus | null>(null);
  useEffect(() => { bridge.parentFpStatus().then(setSt).catch(() => undefined); }, []);
  if (!st || (st.installed && (st.approved ?? 0) > 0)) return null;
  return (
    <div class="card nudge">
      <div class="row between">
        <span>🕹️ <b>{child.displayName}'s arcade only has the small built-in set.</b> One 5-minute install adds ~100 real 2000s classics (Fancy Pants, Bloons TD, Learn to Fly, Stick War…).</span>
        <button class="primary" onClick={onGo}>Set up classic games</button>
      </div>
    </div>
  );
}

function Today({ state, child, onChange, onGo }: { state: ParentState; child: Child; onChange: () => void; onGo: (t: Tab) => void }) {
  const pc = state.perChild[child.id];
  const earned = pc.today.filter((e) => e.delta > 0).reduce((s, e) => s + e.delta, 0);
  const spent = -pc.today.filter((e) => e.delta < 0).reduce((s, e) => s + e.delta, 0);
  return (
    <div class="today">
      <LockStatus state={state} child={child} />
      <ClassicsNudge child={child} onGo={() => { onGo('shop'); setTimeout(() => document.querySelector('.fp-panel')?.scrollIntoView({ behavior: 'smooth' }), 300); }} />
      <div class="stat-row">
        <div class="stat"><small>{child.displayName}'s balance</small><b>🪙 {pc.balance}</b></div>
        <div class="stat"><small>Earned today</small><b>+{earned}</b></div>
        <div class="stat"><small>Spent today</small><b>−{spent}</b></div>
        <div class="stat"><small>Waiting on you</small><b>{state.pendingClaims.length}</b></div>
      </div>
      {pc.unlocks.length > 0 && (
        <div class="card">
          <h3>Running now</h3>
          {pc.unlocks.map((u) => <div class="row between"><span>{u.prizeName} · {fmt(Math.max(0, Math.round((Date.parse(u.expiresAt) - Date.now()) / 1000)))} left</span><button class="ghost small" onClick={() => bridge.parentEndUnlock(u.id).then(onChange)}>End now</button></div>)}
        </div>
      )}
      <div class="card">
        <h3>Today's activity</h3>
        {pc.today.length === 0 && <p class="muted">Nothing yet today.</p>}
        <ul class="ledger">
          {pc.today.map((e) => <li class={e.kind}><span class="time">{new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span><span class="delta">{e.kind === 'claim' ? '⏳' : (e.delta > 0 ? '+' : '') + e.delta}</span><span>{e.detail}</span></li>)}
        </ul>
      </div>
      {!state.ledgerIntact && <p class="error">⚠️ The coin ledger failed its integrity check. Someone may have edited it directly.</p>}
    </div>
  );
}

function LockStatus({ state, child }: { state: ParentState; child: Child }) {
  const e = state.enforcement;
  if (!e) return null;
  const net = e.internetLock;
  const netOk = !!net?.applied && !net.error;
  return (
    <div class={'card lock-status ' + (netOk ? 'ok' : 'bad')}>
      <div class="lock-dot" />
      <div>
        <b>{netOk ? `Internet lock is ON for ${child.displayName}'s account` : `Internet lock is NOT active`}</b>
        <p class="muted small">
          {netOk
            ? `Every program on "${child.windowsAccount}" is blocked from the internet except the sites on your Allowed list (and YouTube channels you approved, during YouTube time). Your account is not affected.`
            : `Problem: ${net?.error ?? 'not applied yet'}. Send guardian.log if this stays red.`}
        </p>
        <p class="muted small">{e.childAtKeyboard ? `${child.displayName} is using the computer right now.` : `Right now "${e.consoleAccount ?? 'nobody'}" is at the keyboard.`}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Approvals

function Approvals({ state, onChange }: { state: ParentState; onChange: () => void }) {
  const [coins, setCoins] = useState<Record<number, number>>({});
  if (!state.pendingClaims.length) return <div class="empty"><h3>All caught up</h3><p class="muted">When {state.household.children[0]?.displayName ?? 'your child'} finishes something that needs your OK, it shows up here.</p></div>;
  return (
    <div class="approvals">
      {state.pendingClaims.map((c) => (
        <div class="card claim">
          <div><b>{labelFor(c.moduleId)}</b><p>{c.detail}</p><small class="muted">{new Date(c.at).toLocaleString()}</small></div>
          <div class="row">
            <input type="number" class="coins-input" value={coins[c.ledgerSeq] ?? c.coins} min={0} max={500} onInput={(e) => setCoins({ ...coins, [c.ledgerSeq]: Number((e.target as HTMLInputElement).value) })} /> 🪙
            <button class="primary" onClick={() => bridge.parentResolveClaim(c.ledgerSeq, true, coins[c.ledgerSeq] ?? c.coins).then(onChange)}>Approve</button>
            <button class="ghost" onClick={() => bridge.parentResolveClaim(c.ledgerSeq, false).then(onChange)}>Deny</button>
          </div>
        </div>
      ))}
    </div>
  );
}

const labelFor = (id: string) => MODULES.find((m) => m.id === id)?.title ?? id;

// ---------------------------------------------------------------- Allowed

const SITE_PRESETS: Record<string, string[]> = {
  'School basics': ['khanacademy.org', 'kastatic.org', 'kasandbox.org', 'merriam-webster.com', 'wikipedia.org', 'wikimedia.org'],
  'Coding': ['scratch.mit.edu', 'code.org', 'replit.com'],
  'Scripture study': ['churchofjesuschrist.org', 'biblegateway.com'],
  'Research': ['britannica.com', 'nasa.gov', 'kids.nationalgeographic.com'],
};

function Allowed({ child, onSave }: { child: Child; onSave: (c: Child) => void }) {
  const [site, setSite] = useState('');
  const [apps, setApps] = useState<{ name: string; exe: string; path: string }[] | null>(null);
  const [showApps, setShowApps] = useState(false);
  const sites = child.allowlist.sites; const appList = child.allowlist.apps;

  const setSites = (s: string[]) => {
    // Allowing a learning site that pays (Duolingo, Khan Academy) switches on its quest too.
    const modules = { ...child.modules };
    for (const m of MODULES) {
      const main = m.requiredSites?.[0];
      if (main && s.includes(main) && !sites.includes(main) && !modules[m.id]?.enabled)
        modules[m.id] = modules[m.id] ? { ...modules[m.id], enabled: true } : { ...m.defaults, requireApproval: false, enabled: true };
    }
    onSave({ ...child, modules, allowlist: { ...child.allowlist, sites: s } });
  };
  const setApps2 = (a: string[]) => onSave({ ...child, allowlist: { ...child.allowlist, apps: a } });
  const addSite = () => { const s = site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; if (s && !sites.includes(s)) setSites([...sites, s]); setSite(''); };

  return (
    <div class="allowed two-col">
      <YouTubeChannels child={child} onSave={onSave} />
      <div class="card">
        <h3>Websites</h3>
        <p class="muted">These are the only websites that open (inside CoinQuest's locked browser). Everything else is blocked.</p>
        <div class="row"><input value={site} placeholder="e.g. duolingo.com" onInput={(e) => setSite((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && addSite()} /><button class="primary" onClick={addSite}>Add</button></div>
        <div class="chips">{sites.map((s) => <span class="chip">{s}<button onClick={() => setSites(sites.filter((x) => x !== s))}>✕</button></span>)}</div>
        <div class="presets">{Object.entries(SITE_PRESETS).map(([name, list]) => <button class="ghost small" onClick={() => setSites([...new Set([...sites, ...list])])}>+ {name}</button>)}</div>
      </div>
      <div class="card">
        <h3>Apps</h3>
        <p class="muted">Anything not listed is closed the moment it opens. Web browsers never run on this account — websites open inside CoinQuest instead.</p>
        <div class="chips">{appList.map((a) => <span class="chip">{a.split('\\').pop()}<button onClick={() => setApps2(appList.filter((x) => x !== a))}>✕</button></span>)}</div>
        <button class="secondary" onClick={() => { setShowApps(!showApps); if (!apps) bridge.parentInstalledApps().then(setApps).catch(() => setApps([])); }}>{showApps ? 'Hide' : 'Add from apps on this computer'}</button>
        {showApps && (
          <div class="app-picker">
            {apps === null && <p class="muted">Scanning…</p>}
            {apps?.filter((a) => !appList.includes(a.path) && !appList.includes(a.exe)).map((a) => <button class="app-row" onClick={() => setApps2([...appList, a.path])}><b>{a.name}</b><small>{a.exe}</small></button>)}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A site that opens blank usually loads its pictures and code from other addresses (its "CDN"). Those show up here
 * as they're blocked; one click allows them. Open the site in the child's account first, then refresh this list.
 */
function RecentlyBlocked({ sites, onAllow }: { sites: string[]; onAllow: (host: string) => void }) {
  const [list, setList] = useState<{ host: string; at: string; reason: string }[] | null>(null);
  const load = () => bridge.parentBlocked().then(setList).catch(() => setList([]));
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);
  const shown = (list ?? []).filter((b) => !sites.some((s) => b.host === s || b.host.endsWith('.' + s))).slice(0, 25);
  return (
    <div class="blocked">
      <h4>Recently blocked <button class="ghost small" onClick={load}>↻</button></h4>
      <p class="muted small">If an allowed site opens blank, open it once in the child's account, then allow the addresses it needed here (they appear within a few seconds).</p>
      {list && shown.length === 0 && <p class="muted small">Nothing blocked recently.</p>}
      {shown.map((b) => (
        <div class="row between blocked-row">
          <span><code>{b.host}</code> <small class="muted">{new Date(b.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></span>
          <button class="secondary small" onClick={() => onAllow(b.host)}>Allow</button>
        </div>
      ))}
    </div>
  );
}

/** What went wrong recently, in one place — a screenshot of this card is usually enough to diagnose a problem. */
function Troubleshooting() {
  const [d, setD] = useState<Awaited<ReturnType<typeof bridge.parentDiagnostics>> | null>(null);
  const [err, setErr] = useState('');
  const load = () => bridge.parentDiagnostics().then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  return (
    <div class="troubleshooting">
      <div class="row between"><h3>Troubleshooting</h3><button class="ghost small" onClick={load}>↻ Refresh</button></div>
      {err && <p class="error">{err}</p>}
      {d && <>
        <p class="muted small">Version {d.version} · internet lock {d.internetLock?.applied ? 'on' : 'OFF' + (d.internetLock?.error ? ` (${d.internetLock.error})` : '')}</p>
        <h4>Internet check (from the CoinQuest service)</h4>
        <ul class="problems">{(d.net ?? []).map((n) => <li>{n.ok ? '✅' : '❌'} {n.site} — <code>{n.detail}</code></li>)}</ul>
        <h4>System check</h4>
        <ul class="problems">{(d.system ?? []).map((l) => <li><code>{l}</code></li>)}</ul>
        <h4>Recent problems</h4>
        {d.problems.length === 0 ? <p class="muted small">None. 👍</p> : <ul class="problems">{d.problems.map((p) => <li><code>{p}</code></li>)}</ul>}
      </>}
    </div>
  );
}

function YouTubeChannels({ child, onSave }: { child: Child; onSave: (c: Child) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const list = child.youTubeChannels ?? [];
  async function add() {
    setBusy(true); setErr('');
    try {
      const ch = await bridge.parentYouTubeResolve(url.trim());
      if (!list.some((c) => c.id === ch.id)) onSave({ ...child, youTubeChannels: [...list, ch] });
      setUrl('');
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div class="card" style={{ gridColumn: '1 / -1' }}>
      <h3>▶️ YouTube channels</h3>
      <p class="muted">youtube.com itself stays blocked. Inside CoinQuest, {child.displayName} can watch recent videos from these channels only, during YouTube time. Paste a channel link (for example youtube.com/@MarkRober).</p>
      <div class="row"><input style={{ flex: 1 }} value={url} placeholder="https://www.youtube.com/@channel" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && url && add()} /><button class="primary" disabled={!url || busy} onClick={add}>{busy ? 'Finding…' : 'Add channel'}</button></div>
      {err && <p class="error">{err}</p>}
      <div class="chips">{list.map((c) => <span class="chip">{c.title}<button onClick={() => onSave({ ...child, youTubeChannels: list.filter((x) => x.id !== c.id) })}>✕</button></span>)}</div>
      {list.length === 0 && <p class="muted small">No channels yet — the YouTube button won't appear for {child.displayName} until you add one.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Shop editor

const KINDS: [Prize['kind'], string][] = [['youTube', 'YouTube time (approved channels only)'], ['siteUnlock', 'Unlock a website for N minutes'], ['arcadeUnlock', 'Arcade time (any game)'], ['appUnlock', 'Unlock an app for N minutes'], ['screenTimeExtension', 'Extra screen time tonight'], ['realWorld', 'Real-world reward (just logged)']];

function ShopEditor({ child, onSave }: { child: Child; onSave: (c: Child) => void }) {
  const [editing, setEditing] = useState<Prize | null>(null);
  const prizes = child.prizes;
  const put = (p: Prize) => { const i = prizes.findIndex((x) => x.id === p.id); const next = [...prizes]; if (i >= 0) next[i] = p; else next.push(p); onSave({ ...child, prizes: next }); setEditing(null); };
  const blank = (): Prize => ({ id: 'p' + Math.random().toString(36).slice(2, 10), name: '', cost: 50, kind: 'siteUnlock', minutes: 20, dailyCap: 1, boughtToday: 0, targets: [], enabled: true });

  return (
    <div class="shop-editor">
      <p class="muted">What coins can buy. Tap one to change it.</p>
      <div class="prize-list">
        {prizes.map((p) => <button class={'prize-row' + (p.enabled === false ? ' off' : '')} onClick={() => setEditing({ ...p })}><span class="icon">{{ youTube: '▶️', siteUnlock: '🌐', arcadeUnlock: '🕹️', appUnlock: '💻', screenTimeExtension: '⏰', realWorld: '🎁' }[p.kind]}</span><b>{p.name}</b><span>🪙 {p.cost}</span><small class="muted">{p.minutes ? `${p.minutes} min` : ''}{p.dailyCap ? ` · max ${p.dailyCap}/day` : ''}{p.enabled === false ? ' · hidden' : ''}</small></button>)}
      </div>
      <button class="secondary" onClick={() => setEditing(blank())}>+ New prize</button>
      <ArcadeManager child={child} onSave={onSave} />
      {editing && (
        <div class="modal"><div class="card form">
          <h3>{prizes.some((p) => p.id === editing.id) ? 'Edit prize' : 'New prize'}</h3>
          <label>Name<input value={editing.name} onInput={(e) => setEditing({ ...editing, name: (e.target as HTMLInputElement).value })} placeholder="20 minutes of YouTube" /></label>
          <label>What it does<select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: (e.target as HTMLSelectElement).value as Prize['kind'] })}>{KINDS.map(([k, l]) => <option value={k}>{l}</option>)}</select></label>
          {(editing.kind === 'siteUnlock' || editing.kind === 'appUnlock') && <label>{editing.kind === 'siteUnlock' ? 'Websites (comma-separated)' : 'Apps (exe names, comma-separated)'}<input value={(editing.targets ?? []).join(', ')} onInput={(e) => setEditing({ ...editing, targets: (e.target as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder={editing.kind === 'siteUnlock' ? 'youtube.com, googlevideo.com, ytimg.com' : 'Minecraft.exe'} /></label>}
          <div class="row">
            <label>Cost 🪙<input type="number" value={editing.cost} min={1} onInput={(e) => setEditing({ ...editing, cost: Number((e.target as HTMLInputElement).value) })} /></label>
            {editing.kind !== 'realWorld' && <label>Minutes<input type="number" value={editing.minutes} min={1} onInput={(e) => setEditing({ ...editing, minutes: Number((e.target as HTMLInputElement).value) })} /></label>}
            {editing.kind === 'youTube' && <p class="muted small" style={{ flexBasis: '100%' }}>{child.displayName} buys YouTube with + in 5-minute steps at <b>🪙 {youTubeBlockPrice(editing.cost, editing.minutes, [defaultArcadePrice(1)])} per 5 min</b> (this cost ÷ minutes, but never cheaper than 2 coins above the priciest arcade game — games beat videos). "Max per day" counts how many times he buys.</p>}
            <label>Max per day (0 = no limit)<input type="number" value={editing.dailyCap} min={0} onInput={(e) => setEditing({ ...editing, dailyCap: Number((e.target as HTMLInputElement).value) })} /></label>
          </div>
          <label class="check"><input type="checkbox" checked={editing.enabled !== false} onChange={(e) => setEditing({ ...editing, enabled: (e.target as HTMLInputElement).checked })} /> Show in shop</label>
          <div class="row">
            <button class="primary" disabled={!editing.name.trim()} onClick={() => put(editing)}>Save</button>
            <button class="ghost" onClick={() => setEditing(null)}>Cancel</button>
            {prizes.some((p) => p.id === editing.id) && <button class="ghost danger" onClick={() => { onSave({ ...child, prizes: prizes.filter((p) => p.id !== editing.id) }); setEditing(null); }}>Delete</button>}
          </div>
        </div></div>
      )}
    </div>
  );
}

function ArcadeManager({ child, onSave }: { child: Child; onSave: (c: Child) => void }) {
  const [games, setGames] = useState<Game[] | null>(null);
  const [err, setErr] = useState('');
  const [web, setWeb] = useState<WebGame>({ id: '', title: '', url: '', strategy: 3 });
  const [upload, setUpload] = useState<{ file: File; title: string; strategy: number } | null>(null);
  const settings = child.arcade ?? { minutesPerPlay: 10, priceOverrides: {}, hidden: [], webGames: [] };
  const reload = () => bridge.parentArcadeCatalog().then((r) => setGames(r.games)).catch((e) => setErr(e.message));
  useEffect(() => { reload(); }, [child]);
  const saveArcade = (a: typeof settings) => onSave({ ...child, arcade: a });

  async function doUpload() {
    if (!upload) return;
    setErr('');
    try {
      const buf = new Uint8Array(await upload.file.arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      await bridge.parentArcadeUpload(upload.file.name, btoa(bin), upload.title || upload.file.name.replace(/\.swf$/i, ''), upload.strategy);
      setUpload(null); reload();
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div class="card arcade-manager">
      <h3>🕹️ Arcade</h3>
      <FlashpointPanel child={child} onSave={onSave} onChanged={reload} />
      <h4>Prices</h4>
      <p class="muted">Like quarters in a machine: each <b>+</b> buys {BLOCK_MINUTES} more minutes of a game, then he presses Play. Games that take more thinking (🧠) cost less. Prices below are <b>coins per {BLOCK_MINUTES} minutes</b>. Time keeps counting once it starts; he can leave a game and come back while time is left.</p>
      <div class="row">
        <label>🎟️ Sampler pass — any game, for <input type="number" min={5} max={60} step={5} value={settings.samplerMinutes ?? 10} style={{ width: '4.5em' }}
          onChange={(e) => saveArcade({ ...settings, samplerMinutes: Number((e.target as HTMLInputElement).value) || 10 })} /> minutes</label>
        <label>costs <input type="number" min={0} value={settings.samplerPrice || ''} placeholder={String(autoSamplerPrice((games ?? []).filter((g) => !g.hidden).map((g) => g.price), settings.samplerMinutes ?? 10))} style={{ width: '5em' }}
          onChange={(e) => saveArcade({ ...settings, samplerPrice: Number((e.target as HTMLInputElement).value) || 0 })} /> 🪙 <span class="muted small">(blank = automatic: a little more than the same time on the priciest game)</span></label>
      </div>
      {err && <p class="error">{err}</p>}
      <table class="arcade-table">
        <thead><tr><th>Game</th><th>Thinking</th><th>🪙 per {BLOCK_MINUTES} min</th><th>Show</th><th /></tr></thead>
        <tbody>
          {(games ?? []).filter((g) => g.available).map((g) => {
            const hidden = settings.hidden.includes(g.id);
            return (
              <tr class={hidden ? 'off' : ''}>
                <td><b>{g.title}</b><br /><small class="muted">{g.source === 'web' ? g.author : g.source === 'uploaded' ? 'added by you' : g.license}</small></td>
                <td>{'🧠'.repeat(g.strategy)}</td>
                <td><input type="number" min={0} value={g.price} style={{ width: '5em' }}
                  onChange={(e) => { const v = Number((e.target as HTMLInputElement).value); const o = { ...settings.priceOverrides }; if (v === defaultArcadePrice(g.strategy)) delete o[g.id]; else o[g.id] = v; saveArcade({ ...settings, priceOverrides: o }); }} /></td>
                <td><input type="checkbox" checked={!hidden} onChange={(e) => saveArcade({ ...settings, hidden: (e.target as HTMLInputElement).checked ? settings.hidden.filter((x) => x !== g.id) : [...settings.hidden, g.id] })} /></td>
                <td>{g.source === 'uploaded' && <button class="ghost small danger" onClick={() => bridge.parentArcadeRemove(g.id).then(reload)}>Remove</button>}
                  {g.source === 'web' && <button class="ghost small danger" onClick={() => saveArcade({ ...settings, webGames: settings.webGames.filter((w) => w.id !== g.id) })}>Remove</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div class="two-col">
        <div>
          <h4>Add a Flash game file (.swf)</h4>
          <p class="muted small">For games you own or that the author lets you download.</p>
          <input type="file" accept=".swf" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) setUpload({ file: f, title: f.name.replace(/\.swf$/i, ''), strategy: 3 }); }} />
          {upload && <div class="form">
            <label>Name<input value={upload.title} onInput={(e) => setUpload({ ...upload, title: (e.target as HTMLInputElement).value })} /></label>
            <StrategyPicker value={upload.strategy} onChange={(v) => setUpload({ ...upload, strategy: v })} />
            <button class="primary" onClick={doUpload}>Add to arcade</button>
          </div>}
        </div>
        <div>
          <h4>Add a game from its official website</h4>
          <p class="muted small">Paste the page where the maker or publisher hosts it (e.g. Armor Games, Newgrounds). It opens in a locked window that can't leave that site.</p>
          <div class="form">
            <label>Name<input value={web.title} placeholder="Fancy Pants Adventures" onInput={(e) => setWeb({ ...web, title: (e.target as HTMLInputElement).value })} /></label>
            <label>Link<input value={web.url} placeholder="https://…" onInput={(e) => setWeb({ ...web, url: (e.target as HTMLInputElement).value })} /></label>
            <StrategyPicker value={web.strategy} onChange={(v) => setWeb({ ...web, strategy: v })} />
            <button class="primary" disabled={!web.title || !/^https?:\/\//.test(web.url)} onClick={() => { saveArcade({ ...settings, webGames: [...settings.webGames, { ...web, id: 'web-' + Math.random().toString(36).slice(2, 10) }] }); setWeb({ id: '', title: '', url: '', strategy: 3 }); }}>Add to arcade</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Guess how much thinking a Flashpoint game takes from its tags (parents can change the price anyway). */
function strategyFromTags(tags: string): number {
  const t = tags.toLowerCase();
  if (/tower defen|strategy|puzzle|logic|point.and.click|escape|word|trivia|chess|board/.test(t)) return 5;
  if (/simulation|management|cooking|rpg|role.playing|adventure/.test(t)) return 4;
  if (/physics|artillery|upgrade|launch|platform/.test(t)) return 3;
  if (/racing|driving|sports|runner|endless/.test(t)) return 2;
  return 2;
}
function genreFromTags(tags: string, fallback = ''): string {
  const t = tags.split(';').map((x) => x.trim()).filter(Boolean);
  const pref = ['Tower Defense', 'Racing', 'Strategy', 'Puzzle', 'Platformer', 'Sports', 'Physics', 'Shooter', 'Adventure', 'Arcade', 'Action'];
  return pref.find((p) => t.some((x) => x.toLowerCase() === p.toLowerCase())) ?? t[0] ?? fallback;
}

function FlashpointPanel({ child, onSave, onChanged }: { child: Child; onSave: (c: Child) => void; onChanged: () => void }) {
  const [st, setSt] = useState<FpStatus | null>(null);
  const [sugg, setSugg] = useState<Awaited<ReturnType<typeof bridge.parentFpSuggest>> | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<FpCatalogGame[] | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const arcade = child.arcade ?? { minutesPerPlay: 15, priceOverrides: {}, hidden: [], webGames: [] };
  const approved = new Set((arcade.flashpoint ?? []).map((f) => f.id));

  const check = () => bridge.parentFpStatus().then(setSt).catch((e) => setMsg(e.message));
  // Keep checking while this panel is open: it notices the Flashpoint install by itself and shows download progress.
  useEffect(() => { check(); const t = setInterval(check, 8000); return () => clearInterval(t); }, []);
  const lastApproved = useRef(0);
  useEffect(() => { if (st?.approved && st.approved !== lastApproved.current) { if (lastApproved.current) onChanged(); lastApproved.current = st.approved; } }, [st?.approved]);
  useEffect(() => { if (st?.installed && st.clifp && !sugg) bridge.parentFpSuggest().then(setSugg).catch((e) => setMsg(e.message)); }, [st]);

  function approve(list: { game: FpCatalogGame; genre?: string; strategy?: number }[]) {
    const add: FlashpointGame[] = list.filter((x) => !approved.has(x.game.id)).map((x) => ({
      id: x.game.id, title: x.game.title, developer: x.game.developer,
      genre: x.genre ?? genreFromTags(x.game.tags), strategy: x.strategy ?? strategyFromTags(x.game.tags),
    }));
    if (!add.length) return;
    onSave({ ...child, arcade: { ...arcade, flashpoint: [...(arcade.flashpoint ?? []), ...add] } });
    setMsg(`Added ${add.length} game${add.length > 1 ? 's' : ''}. Pictures and downloads happen in the background.`);
    bridge.parentFpThumbs(add.map((a) => a.id)).then(onChanged).catch(() => undefined);
    setTimeout(() => bridge.parentFpStockNow().then(setSt).catch(() => undefined), 1500); // CoinQuest downloads them ahead of time
  }
  const remove = (id: string) => onSave({ ...child, arcade: { ...arcade, flashpoint: (arcade.flashpoint ?? []).filter((f) => f.id !== id) } });

  async function install() {
    setBusy(true); setMsg('Downloading the Flashpoint installer…');
    try { const r = await bridge.parentFpDownloadInstaller(); await bridge.launch(r.path); setMsg('The Flashpoint installer is open. Install "Flashpoint Infinity", open Flashpoint once when it finishes, then press "Check again".'); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div class="fp-panel">
      <h4>🏆 Classic Flash games (Flashpoint Archive)</h4>
      {!st && <p class="muted">Checking…</p>}
      {st && !st.installed && (
        <div class="fp-setup">
          <p>Right now the arcade only has the small built-in set. The real 2000s classics — Fancy Pants, Gravity Guy, Bloons TD, Learn to Fly, Raft Wars, Stick War, Henry Stickmin, Papa's Pizzeria and about 100 more — come from <b>Flashpoint Archive</b>, the free game-preservation project. It's a one-time install, about 5 minutes:</p>
          <ol class="fp-steps">
            <li>Press <b>Install Flashpoint</b> below. Its installer opens.</li>
            <li>Choose <b>Flashpoint Infinity</b> (the small one — games download as needed) and install it to the suggested folder.</li>
            <li>That's it. CoinQuest notices it within a minute, adds the curated classics to {child.displayName}'s arcade and downloads them for him. Nothing marked adult ever appears.</li>
          </ol>
          <div class="row"><button class="primary big" disabled={busy} onClick={install}>Install Flashpoint</button><button class="ghost" onClick={check}>Check again</button></div>
        </div>
      )}
      {st?.installed && st.stock && (
        <div class={'fp-progress ' + st.stock.stage}>
          <b>{st.approved ?? 0} classic games in {child.displayName}'s arcade</b>
          {st.stock.stage === 'installing-launcher' && <span> · finishing Flashpoint setup…</span>}
          {st.stock.stage === 'downloading' && <span> · {st.stock.downloaded} ready, downloading {st.stock.queued} more in the background (any not downloaded yet still play — they just take a moment the first time)</span>}
          {st.stock.stage === 'ready' && <span> · all downloaded ✓</span>}
          {st.stock.error && <div class="muted small">Last problem: {st.stock.error}</div>}
          <div class="row">
            <label class="check"><input type="checkbox" checked={arcade.autoClassics !== false} onChange={(e) => onSave({ ...child, arcade: { ...arcade, autoClassics: (e.target as HTMLInputElement).checked } })} /> Add CoinQuest's kid-safe classics automatically</label>
            <button class="ghost small" onClick={() => bridge.parentFpStockNow().then(setSt).catch((e) => setMsg(e.message))}>Add / download now</button>
          </div>
        </div>
      )}
      {st?.installed && st.clifp && (
        <div>
          <p class="muted small">{st.root ? <>Using your Flashpoint install at <code>{st.root}</code></> : <>Straight from the Flashpoint Archive online — nothing to install</>} · {approved.size} games in the arcade · they play inside CoinQuest. Adult content (Flashpoint's "Extreme" tag) never shows up here.</p>
          {sugg && (
            <div class="fp-sugg">
              <div class="row between"><b>Suggested classics ({sugg.length})</b><button class="primary" title="Approves everything except the ones marked 'preview'" onClick={() => approve(sugg.filter((x) => !x.pick.note?.includes('preview')).map((x) => ({ game: x.game, genre: x.pick.genre, strategy: x.pick.strategy })))}>Approve all</button></div>
              <div class="fp-list">
                {sugg.map((x) => (
                  <label class={'fp-row' + (approved.has(x.game.id) ? ' on' : '')}>
                    <input type="checkbox" checked={approved.has(x.game.id)} onChange={(e) => (e.target as HTMLInputElement).checked ? approve([{ game: x.game, genre: x.pick.genre, strategy: x.pick.strategy }]) : remove(x.game.id)} />
                    <span><b>{x.game.title}</b> <small class="muted">{x.pick.genre} · {x.game.developer}{x.pick.note ? ` · ${x.pick.note}` : ''}</small></span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <h4>Find more</h4>
          <div class="row">
            <input style={{ flex: 1 }} value={q} placeholder="Search Flashpoint by name, e.g. Stick War" onInput={(e) => setQ((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && q && bridge.parentFpSearch(q).then(setResults).catch((er) => setMsg(er.message))} />
            <button class="secondary" disabled={!q} onClick={() => bridge.parentFpSearch(q).then(setResults).catch((er) => setMsg(er.message))}>Search</button>
          </div>
          <div class="presets">{['Racing', 'Tower Defense', 'Strategy', 'Puzzle', 'Platformer', 'Sports', 'Physics', 'Simulation'].map((t) =>
            <button class="ghost small" onClick={() => { setQ('tag:' + t); bridge.parentFpSearch('tag:' + t).then(setResults).catch((er) => setMsg(er.message)); }}>{t}</button>)}</div>
          {results && (
            <div class="fp-list">
              {results.length === 0 && <p class="muted">Nothing found.</p>}
              {results.map((g) => (
                <label class={'fp-row' + (approved.has(g.id) ? ' on' : '')}>
                  <input type="checkbox" checked={approved.has(g.id)} onChange={(e) => (e.target as HTMLInputElement).checked ? approve([{ game: g }]) : remove(g.id)} />
                  <span><b>{g.title}</b> <small class="muted">{[g.developer, g.releaseDate?.slice(0, 4), g.platform].filter(Boolean).join(' · ')}</small><br /><small class="muted">{g.tags.split(';').slice(0, 5).join(', ')}</small></span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      {msg && <p class="muted">{msg}</p>}
    </div>
  );
}

function StrategyPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <label>How much thinking? <span class="muted small">(more thinking = cheaper: {defaultArcadePrice(value)} 🪙)</span>
      <select value={value} onChange={(e) => onChange(Number((e.target as HTMLSelectElement).value))}>
        {[[1, 'Just reflexes'], [2, 'A little'], [3, 'Some planning'], [4, 'Lots of planning'], [5, 'Pure strategy / puzzle']].map(([v, l]) => <option value={v}>{'🧠'.repeat(v as number)} {l}</option>)}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------- Quests

function Quests({ child, onSave }: { child: Child; onSave: (c: Child) => void }) {
  const setMod = (id: string, patch: Partial<Child['modules'][string]>) => {
    const cur = child.modules[id] ?? { enabled: true, requireApproval: false, ...MODULES.find((m) => m.id === id)!.defaults };
    const mod = MODULES.find((m) => m.id === id)!;
    const next = { ...child, modules: { ...child.modules, [id]: { ...cur, ...patch } } };
    // Turning a quest on adds the sites it needs.
    if (patch.enabled && mod.requiredSites) next.allowlist = { ...next.allowlist, sites: [...new Set([...next.allowlist.sites, ...mod.requiredSites])] };
    onSave(next);
  };
  return (
    <div class="quests-editor">
      {MODULES.map((m) => {
        const s = child.modules[m.id] ?? { enabled: false, requireApproval: false, ...m.defaults };
        return (
          <div class={'card quest-settings' + (s.enabled ? '' : ' off')}>
            <div class="row between">
              <h3>{m.icon} {m.title}</h3>
              <label class="switch"><input type="checkbox" checked={s.enabled} onChange={(e) => setMod(m.id, { enabled: (e.target as HTMLInputElement).checked })} /><span>{s.enabled ? 'On' : 'Off'}</span></label>
            </div>
            <p class="muted">{m.description}</p>
            {m.id === 'rwt' && <RwtImport />}
            {m.id === 'discgames' && <DiscImport />}
            <div class="row">
              <label>Coins per activity<input type="number" min={0} value={s.coinsPerActivity} onChange={(e) => setMod(m.id, { coinsPerActivity: Number((e.target as HTMLInputElement).value) })} /></label>
              <label>Daily limit (0 = none)<input type="number" min={0} value={s.dailyCap} onChange={(e) => setMod(m.id, { dailyCap: Number((e.target as HTMLInputElement).value) })} /></label>
              <label class="check"><input type="checkbox" checked={s.requireApproval || m.verification === 'parent_approved'} disabled={m.verification === 'parent_approved'} onChange={(e) => setMod(m.id, { requireApproval: (e.target as HTMLInputElement).checked })} /> Needs my OK</label>
            </div>
            {m.options && s.enabled && (
              <div class="row module-options">
                {m.options.map((o) => (
                  <label title={o.help}>{o.label}
                    {o.number
                      ? <input type="number" min={o.number.min} max={o.number.max} value={s.options?.[o.key] ?? o.default}
                          onChange={(e) => { const v = Math.max(o.number!.min, Math.min(o.number!.max, Math.round(Number((e.target as HTMLInputElement).value) || 0))); setMod(m.id, { options: { ...(s.options ?? {}), [o.key]: String(v) } }); }} />
                      : <select value={s.options?.[o.key] ?? o.default} onChange={(e) => setMod(m.id, { options: { ...(s.options ?? {}), [o.key]: (e.target as HTMLSelectElement).value } })}>
                          {(o.choices ?? []).map(([v, l]) => <option value={v}>{l}</option>)}
                        </select>}
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Bring the family's own Read, Write & Type! disc image into CoinQuest, once. */
function DiscImport() {
  const [st, setSt] = useState<DiscStatus | null>(null);
  const [err, setErr] = useState('');
  const load = () => bridge.parentDiscStatus().then(setSt).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (st?.stage !== 'importing') return; const t = setInterval(load, 2000); return () => clearInterval(t); }, [st?.stage]);
  async function pick() {
    setErr('');
    try {
      const r = await bridge.pickFile('Choose a game disc image', 'Disc image (*.zip, *.iso, *.img, *.bin)|*.zip;*.iso;*.img;*.bin|All files|*.*');
      if (r.path) setSt(await bridge.parentDiscImport(r.path, useInst));
    } catch (e) { setErr((e as Error).message); }
  }
  const [link, setLink] = useState('');
  const [useInst, setUseInst] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  async function hide(id: string, hidden: boolean) { setErr(''); try { setSt(await bridge.parentDiscHide(id, hidden)); } catch (e) { setErr((e as Error).message); } }
  async function remove(id: string) { setErr(''); try { setSt(await bridge.parentDiscRemove(id)); setRemoving(null); } catch (e) { setErr((e as Error).message); } }
  async function viaInstaller(title: string) {
    setErr('');
    try {
      const r = await bridge.pickFile(`Choose the disc image for ${title}`, 'Disc image (*.zip, *.iso, *.img, *.bin)|*.zip;*.iso;*.img;*.bin|All files|*.*');
      if (r.path) setSt(await bridge.parentDiscImport(r.path, true));
    } catch (e) { setErr((e as Error).message); }
  }
  async function pickDir() {
    setErr('');
    try {
      const r = await bridge.pickFolder('Choose a folder of game discs (every disc image inside is imported)');
      if (r.path) setSt(await bridge.parentDiscImport(r.path, useInst));
    } catch (e) { setErr((e as Error).message); }
  }
  async function fromLink() {
    setErr('');
    try { if (link.trim()) { setSt(await bridge.parentDiscImport(link.trim(), useInst)); setLink(''); } } catch (e) { setErr((e as Error).message); }
  }
  async function tryIt(id: string) { setErr(''); try { await bridge.playDisc(id); } catch (e) { setErr((e as Error).message); } }
  const [setup, setSetup] = useState<{ id: string; title: string; drive: string; installer: string } | null>(null);
  const [setupMsg, setSetupMsg] = useState('');
  async function beginSetup(id: string) {
    setErr(''); setSetupMsg('Putting the disc in the virtual drive…');
    try { const s = await bridge.parentDiscSetupBegin(id); setSetup(s); await bridge.runSetup(s.installer); setSetupMsg(''); }
    catch (e) { setErr((e as Error).message); setSetupMsg(''); }
  }
  async function finishSetup(pick = false) {
    if (!setup) return;
    setErr('');
    let folder: string | undefined;
    if (pick) {
      const r = await bridge.pickFolder(`Choose the folder ${setup.title} installed to (e.g. in C:\\Program Files (x86))`);
      if (!r.path) return;
      folder = r.path;
    }
    try { const r = await bridge.parentDiscSetupFinish(setup.id, folder); setSetup(null); setSetupMsg(`✅ ${r.title} is installed (${r.exe}). Press "Try it" to check it runs.`); load(); }
    catch (e) { setErr((e as Error).message); }
  }
  async function alreadyInstalled(id: string, title: string) {
    setErr('');
    const p = await bridge.pickFolder(`Choose the folder ${title} installed to (e.g. in C:\\Program Files (x86))`);
    if (!p.path) return;
    try { const r = await bridge.parentDiscSetupFinish(id, p.path); setSetup(null); setSetupMsg(`✅ ${r.title} is installed (${r.exe}). Press "Try it" to check it runs.`); load(); }
    catch (e) { setErr((e as Error).message); }
  }
  if (!st) return <p class="muted small">Checking…</p>;
  return (
    <div class="rwt-import">
      {st.games.length > 0 && <ul class="disc-games">{st.games.map((g) => (
        <li class={g.hidden ? 'off' : ''}>
          <div class="row between" style="gap:.6em;align-items:center">
            <div style="flex:1;min-width:0">
              <b>{g.title}</b>
              {g.mode === 'pending' ? <span class="muted small"> — not installed yet</span>
                : g.players.length > 0 ? <span class="muted small"> — {g.players.map((p) => `${p.name} (level ${p.level}, score ${p.score})`).join(', ')}</span>
                : <span class="muted small"> — no players yet</span>}
              <div class="row" style="gap:.4em;margin-top:.3em;flex-wrap:wrap">
                {g.mode === 'pending'
                  ? <><button class="secondary small" onClick={() => beginSetup(g.id)}>Set up (run its installer)</button>
                      <button class="ghost small" onClick={() => alreadyInstalled(g.id, g.title)}>Already installed? Choose its folder…</button></>
                  : <><button class="ghost small" onClick={() => tryIt(g.id)}>Try it</button>
                      {g.mode === 'copy' && <button class="ghost small" title="If it crashes or misbehaves: re-import it and run the disc's own installer instead" onClick={() => viaInstaller(g.title)}>Problems? Use its installer…</button>}</>}
                {removing === g.id
                  ? <><button class="danger small" onClick={() => remove(g.id)}>Yes, remove {g.title}</button><button class="ghost small" onClick={() => setRemoving(null)}>Keep it</button></>
                  : <button class="ghost small" title="Delete CoinQuest's copy of this game and its disc image" onClick={() => setRemoving(g.id)}>🗑 Remove</button>}
              </div>
              {removing === g.id && <p class="muted small">Players' progress in this game is deleted too.{g.mode === 'installed' ? ' The installed program stays on the PC — uninstall it from Windows Settings → Apps if you want it gone completely.' : ''}</p>}
            </div>
            {g.mode !== 'pending' && <label class="switch" title={g.hidden ? 'Hidden from the kids' : 'Shown to the kids'}><input type="checkbox" checked={!g.hidden} onChange={(e) => hide(g.id, !(e.target as HTMLInputElement).checked)} /><span>{g.hidden ? 'Off' : 'On'}</span></label>}
          </div>
        </li>))}</ul>}
      {setup && (
        <div class="card nudge" style="text-align:left">
          <b>Installing {setup.title}</b>
          <ol class="small">
            <li>The disc is in the virtual drive <b>{setup.drive}</b> and its installer has opened (Windows may ask for permission first).</li>
            <li>Click through it with the normal choices. If it offers extras (Acrobat Reader, AOL, registration, DirectX), you can skip them.</li>
            <li>When it says it's finished (don't start the game from it), come back here:</li>
          </ol>
          <div class="row" style="gap:.5em"><button class="primary" onClick={() => finishSetup()}>Done installing</button><button class="ghost small" onClick={() => finishSetup(true)}>Choose its folder…</button><button class="ghost small" onClick={() => bridge.runSetup(setup.installer)}>Open the installer again</button><button class="ghost small" onClick={() => setSetup(null)}>Cancel</button></div>
        </div>
      )}
      {setupMsg && <p class="muted small">{setupMsg}</p>}
      {st.stage === 'importing' ? <p>⏳ {st.message ?? 'Importing…'}</p>
        : <>
            <p class="small">Add your discs: choose one image (<code>.zip</code>, <code>.iso</code>, <code>.img</code> or <code>.bin</code>), a whole folder of them, or paste a Dropbox link to a file or folder. ClueFinders and similar Learning Company titles are set up automatically. Any other disc is kept as a virtual CD: press <b>Set up</b> once to run its own installer, and Play puts the disc in the virtual drive each time.</p>
            <div class="row" style="flex-wrap:wrap;gap:.5em">
              <button class={st.games.length ? 'secondary' : 'primary'} onClick={pick}>Import a disc…</button>
              <button class="secondary" onClick={pickDir}>Import a folder…</button>
            </div>
            <label class="check small" style="margin-top:.4em"><input type="checkbox" checked={useInst} onChange={(e) => setUseInst((e.target as HTMLInputElement).checked)} /> Always use the disc's own installer (even for games CoinQuest knows)</label>
            <div class="row" style="gap:.5em;margin-top:.5em">
              <input type="url" placeholder="…or paste a Dropbox link" value={link} onInput={(e) => setLink((e.target as HTMLInputElement).value)} style="flex:1" />
              <button class="secondary" onClick={fromLink} disabled={!link.trim()}>Import from link</button>
            </div>
          </>}
      {st.message && st.stage !== 'importing' && <p class={st.stage === 'error' ? 'error small' : 'muted small'}>{st.message}</p>}
      {err && <p class="error">{err}</p>}
    </div>
  );
}

function RwtImport() {
  const [st, setSt] = useState<RwtStatus | null>(null);
  const [err, setErr] = useState('');
  const load = () => bridge.parentRwtStatus().then(setSt).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (st?.stage === 'importing') { const t = setTimeout(load, 1500); return () => clearTimeout(t); } }, [st]);
  async function pick() {
    setErr('');
    try {
      const r = await bridge.pickFile('Choose your Read, Write & Type! disc image', 'Disc image (*.iso, *.zip)|*.iso;*.zip|All files|*.*');
      if (r.path) setSt(await bridge.parentRwtImport(r.path));
    } catch (e) { setErr((e as Error).message); }
  }
  async function tryIt() { setErr(''); try { await bridge.playRwt(); } catch (e) { setErr((e as Error).message); } }
  if (!st) return <p class="muted small">Checking…</p>;
  return (
    <div class="rwt-import">
      {st.stage === 'importing' ? <p>⏳ {st.message ?? 'Importing…'}</p>
        : st.installed ? <>
            <p>✅ Imported — it's part of CoinQuest now (no disc or image needed).{st.players.length > 0 && <> Players: {st.players.join(', ')}.</>}{st.players.length === 0 && <> No players signed in yet — progress is only saved (and paid) for a signed-in player.</>}</p>
            <div class="row"><button class="secondary" onClick={tryIt}>Try it now (on this account)</button><button class="ghost small" onClick={pick}>Import again…</button></div>
          </>
        : <>
            <p>Bring in your own copy once: choose its disc image (<code>.iso</code>, or the <code>.zip</code> it came in). CoinQuest copies the game inside itself and gets the free helper that runs 1995 Windows programs (otvdm). After that the image isn't needed.</p>
            <button class="primary" onClick={pick}>Import disc image…</button>
          </>}
      {st.message && st.stage !== 'importing' && <p class="muted small">{st.message}</p>}
      {st.patches.some((p) => p.includes('NOT APPLIED')) && <p class="error small">This copy is a different version than expected: {st.patches.filter((p) => p.includes('NOT')).join('; ')}</p>}
      {err && <p class="error">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Settings

function Settings({ state, child, onSave, onChange }: { state: ParentState; child: Child; onSave: (c: Child) => void; onChange: () => void }) {
  const [pin, setPin] = useState(''); const [pinMsg, setPinMsg] = useState('');
  const [adj, setAdj] = useState(0); const [reason, setReason] = useState('');
  const [upd, setUpd] = useState(state.updateStatus);
  const u = upd;
  return (
    <div class="settings two-col">
      <div class="card">
        <h3>Child</h3>
        <label>Name<input value={child.displayName} onChange={(e) => onSave({ ...child, displayName: (e.target as HTMLInputElement).value })} /></label>
        <p class="muted">Windows account: <code>{child.windowsAccount}</code></p>
        <h3>Give or take coins</h3>
        <div class="row"><input type="number" value={adj} onInput={(e) => setAdj(Number((e.target as HTMLInputElement).value))} /><input placeholder="Reason (e.g. Cleaned room)" value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} /><button class="primary" disabled={!adj} onClick={() => bridge.parentAdjust(child.id, adj, reason || 'Parent adjustment').then(() => { setAdj(0); setReason(''); onChange(); })}>Apply</button></div>
      </div>
      <div class="card">
        <h3>Parent PIN</h3>
        <div class="row"><input type="password" inputMode="numeric" placeholder="New PIN (4–8 digits)" value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value)} /><button class="primary" disabled={!/^\d{4,8}$/.test(pin)} onClick={() => bridge.parentSetPin(pin).then(() => { setPin(''); setPinMsg('PIN changed.'); }).catch((e) => setPinMsg(e.message))}>Change</button></div>
        {pinMsg && <p class="muted">{pinMsg}</p>}
        <h3>Updates</h3>
        <p>Version <b>{u.current}</b> — {u.state === 'upToDate' ? 'up to date' : u.state === 'readyToApply' ? `version ${u.latest} is downloaded and installs as soon as ${child.displayName} isn't in paid game or YouTube time` : u.state === 'installing' || u.state === 'applying' ? `installing ${u.latest ? 'version ' + u.latest : 'an update'}… CoinQuest restarts by itself` : u.state === 'downloading' ? `downloading ${u.latest}…` : u.state === 'error' ? `couldn't check (${u.message})` : u.state}{u.lastChecked && <small class="muted"> · checked {new Date(u.lastChecked).toLocaleString()}</small>}</p>
        <button class="secondary" onClick={() => bridge.parentCheckUpdate().then(setUpd).catch((e) => setUpd({ ...u, state: 'error', message: e.message }))}>Check now</button>
        <h3>Honest limits</h3>
        <p class="muted small">A young child can't get around this. A determined teenager with physical access could boot from USB or reinstall Windows; BitLocker plus a BIOS password closes that.</p>
      </div>
      <details class="card advanced" style={{ gridColumn: '1 / -1' }}>
        <summary><b>Advanced</b> <span class="muted small">— troubleshooting, recent problems, blocked addresses</span></summary>
        <Troubleshooting />
        <RecentlyBlocked sites={child.allowlist.sites} onAllow={(h) => onSave({ ...child, allowlist: { ...child.allowlist, sites: [...new Set([...child.allowlist.sites, h])] } })} />
      </details>
    </div>
  );
}
