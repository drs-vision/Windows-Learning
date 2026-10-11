import { useEffect, useState } from 'preact/hooks';
import type { Child, ParentState, Prize } from '../core/types';
import { bridge } from '../core/bridge';
import { MODULES } from '../modules/registry';
import { SetupWizard } from './SetupWizard';
import { fmt } from '../modules/arcade/Arcade';

type Tab = 'today' | 'approvals' | 'allowed' | 'shop' | 'quests' | 'settings';

/** Five screens (plus Settings). Works standalone in the Parent Console app, or embedded in Scholar behind the PIN. */
export function ParentConsole({ embedded, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const [hello, setHello] = useState<{ isAdmin: boolean; setupNeeded: boolean; childId?: string } | null>(null);
  const [authed, setAuthed] = useState(false);
  const [state, setState] = useState<ParentState | null>(null);
  const [tab, setTab] = useState<Tab>('today');
  const [error, setError] = useState('');

  useEffect(() => { bridge.hello().then(setHello).catch((e) => setError(e.message)); }, []);

  const refresh = () => bridge.parentState().then((s) => { setState(s); setError(''); }).catch((e) => setError(e.message));

  useEffect(() => {
    if (!authed) return;
    refresh();
    const off = bridge.on((ev) => { if (ev.name === 'approvals' || ev.name === 'state') refresh(); });
    const t = setInterval(refresh, 15000);
    return () => { off(); clearInterval(t); };
  }, [authed]);

  if (error && !hello) return <div class="screen center"><p class="error">{error}</p></div>;
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
        {child && tab === 'today' && <Today state={state} child={child} onChange={refresh} />}
        {child && tab === 'approvals' && <Approvals state={state} onChange={refresh} />}
        {child && tab === 'allowed' && <Allowed child={child} onSave={(c) => save(c, refresh, setError)} />}
        {child && tab === 'shop' && <ShopEditor child={child} onSave={(c) => save(c, refresh, setError)} />}
        {child && tab === 'quests' && <Quests child={child} onSave={(c) => save(c, refresh, setError)} />}
        {child && tab === 'settings' && <Settings state={state} child={child} onSave={(c) => save(c, refresh, setError)} onChange={refresh} />}
      </section>
    </div>
  );
}

async function save(child: Child, refresh: () => void, setError: (s: string) => void) {
  try { await bridge.parentUpdateChild(child); refresh(); } catch (e) { setError((e as Error).message); }
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

function Today({ state, child, onChange }: { state: ParentState; child: Child; onChange: () => void }) {
  const pc = state.perChild[child.id];
  const earned = pc.today.filter((e) => e.delta > 0).reduce((s, e) => s + e.delta, 0);
  const spent = -pc.today.filter((e) => e.delta < 0).reduce((s, e) => s + e.delta, 0);
  return (
    <div class="today">
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

  const setSites = (s: string[]) => onSave({ ...child, allowlist: { ...child.allowlist, sites: s } });
  const setApps2 = (a: string[]) => onSave({ ...child, allowlist: { ...child.allowlist, apps: a } });
  const addSite = () => { const s = site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; if (s && !sites.includes(s)) setSites([...sites, s]); setSite(''); };

  return (
    <div class="allowed two-col">
      <div class="card">
        <h3>Websites</h3>
        <p class="muted">Everything is blocked except these. Prizes (like YouTube) unlock extra sites temporarily.</p>
        <div class="row"><input value={site} placeholder="e.g. duolingo.com" onInput={(e) => setSite((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && addSite()} /><button class="primary" onClick={addSite}>Add</button></div>
        <div class="chips">{sites.map((s) => <span class="chip">{s}<button onClick={() => setSites(sites.filter((x) => x !== s))}>✕</button></span>)}</div>
        <div class="presets">{Object.entries(SITE_PRESETS).map(([name, list]) => <button class="ghost small" onClick={() => setSites([...new Set([...sites, ...list])])}>+ {name}</button>)}</div>
      </div>
      <div class="card">
        <h3>Apps</h3>
        <p class="muted">Anything not listed is closed the moment it opens. Browsers and CoinQuest are always included.</p>
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

// ---------------------------------------------------------------- Shop editor

const KINDS: [Prize['kind'], string][] = [['siteUnlock', 'Unlock a website for N minutes'], ['arcadeUnlock', 'Arcade minutes'], ['appUnlock', 'Unlock an app for N minutes'], ['screenTimeExtension', 'Extra screen time tonight'], ['realWorld', 'Real-world reward (just logged)']];

function ShopEditor({ child, onSave }: { child: Child; onSave: (c: Child) => void }) {
  const [editing, setEditing] = useState<Prize | null>(null);
  const prizes = child.prizes;
  const put = (p: Prize) => { const i = prizes.findIndex((x) => x.id === p.id); const next = [...prizes]; if (i >= 0) next[i] = p; else next.push(p); onSave({ ...child, prizes: next }); setEditing(null); };
  const blank = (): Prize => ({ id: 'p' + Math.random().toString(36).slice(2, 10), name: '', cost: 50, kind: 'siteUnlock', minutes: 20, dailyCap: 1, boughtToday: 0, targets: [], enabled: true });

  return (
    <div class="shop-editor">
      <p class="muted">What coins can buy. Tap one to change it.</p>
      <div class="prize-list">
        {prizes.map((p) => <button class={'prize-row' + (p.enabled === false ? ' off' : '')} onClick={() => setEditing({ ...p })}><span class="icon">{{ siteUnlock: '▶️', arcadeUnlock: '🕹️', appUnlock: '💻', screenTimeExtension: '⏰', realWorld: '🎁' }[p.kind]}</span><b>{p.name}</b><span>🪙 {p.cost}</span><small class="muted">{p.minutes ? `${p.minutes} min` : ''}{p.dailyCap ? ` · max ${p.dailyCap}/day` : ''}{p.enabled === false ? ' · hidden' : ''}</small></button>)}
      </div>
      <button class="secondary" onClick={() => setEditing(blank())}>+ New prize</button>
      {editing && (
        <div class="modal"><div class="card form">
          <h3>{prizes.some((p) => p.id === editing.id) ? 'Edit prize' : 'New prize'}</h3>
          <label>Name<input value={editing.name} onInput={(e) => setEditing({ ...editing, name: (e.target as HTMLInputElement).value })} placeholder="20 minutes of YouTube" /></label>
          <label>What it does<select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: (e.target as HTMLSelectElement).value as Prize['kind'] })}>{KINDS.map(([k, l]) => <option value={k}>{l}</option>)}</select></label>
          {(editing.kind === 'siteUnlock' || editing.kind === 'appUnlock') && <label>{editing.kind === 'siteUnlock' ? 'Websites (comma-separated)' : 'Apps (exe names, comma-separated)'}<input value={(editing.targets ?? []).join(', ')} onInput={(e) => setEditing({ ...editing, targets: (e.target as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder={editing.kind === 'siteUnlock' ? 'youtube.com, googlevideo.com, ytimg.com' : 'Minecraft.exe'} /></label>}
          <div class="row">
            <label>Cost 🪙<input type="number" value={editing.cost} min={1} onInput={(e) => setEditing({ ...editing, cost: Number((e.target as HTMLInputElement).value) })} /></label>
            {editing.kind !== 'realWorld' && <label>Minutes<input type="number" value={editing.minutes} min={1} onInput={(e) => setEditing({ ...editing, minutes: Number((e.target as HTMLInputElement).value) })} /></label>}
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
            <div class="row">
              <label>Coins per activity<input type="number" min={0} value={s.coinsPerActivity} onChange={(e) => setMod(m.id, { coinsPerActivity: Number((e.target as HTMLInputElement).value) })} /></label>
              <label>Daily limit (0 = none)<input type="number" min={0} value={s.dailyCap} onChange={(e) => setMod(m.id, { dailyCap: Number((e.target as HTMLInputElement).value) })} /></label>
              <label class="check"><input type="checkbox" checked={s.requireApproval || m.verification === 'parent_approved'} disabled={m.verification === 'parent_approved'} onChange={(e) => setMod(m.id, { requireApproval: (e.target as HTMLInputElement).checked })} /> Needs my OK</label>
            </div>
          </div>
        );
      })}
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
        <p>Version <b>{u.current}</b> — {u.state === 'upToDate' ? 'up to date' : u.state === 'readyToApply' ? `version ${u.latest} will install when ${child.displayName} logs off` : u.state === 'error' ? `couldn't check (${u.message})` : u.state}{u.lastChecked && <small class="muted"> · checked {new Date(u.lastChecked).toLocaleString()}</small>}</p>
        <button class="secondary" onClick={() => bridge.parentCheckUpdate().then(setUpd).catch((e) => setUpd({ ...u, state: 'error', message: e.message }))}>Check now</button>
        <h3>Honest limits</h3>
        <p class="muted small">A young child can't get around this. A determined teenager with physical access could boot from USB or reinstall Windows; BitLocker plus a BIOS password closes that.</p>
      </div>
    </div>
  );
}
