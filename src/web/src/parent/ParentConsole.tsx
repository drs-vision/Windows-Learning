import { useEffect, useRef, useState } from 'preact/hooks';
import type { Child, FlashpointGame, FpCatalogGame, Game, LockSummary, LockTime, ParentState, Prize, WebGame } from '../core/types';
import { BLOCK_MINUTES, kidColor, defaultArcadePrice } from '../core/types';
import { ReadingAnalysis } from './reading';
import { DAY_LETTERS, DAY_NAMES, daysText, timeText, untilText } from '../core/lock';
import { KidAccount, type WinAccount } from './KidAccount';
import { bridge, type DiscStatus, type FpStatus, type PhoneLinks, type RwtStatus } from '../core/bridge';
import qrcode from 'qrcode-generator';
import { MODULES } from '../modules/registry';
import { familyPassages, type FamilyPassage } from '../modules/my-passages/score';
import { wordCount } from '../modules/bible-typing/score';
import { keyboardText } from '../core/keyboardText';
import * as rep from '../../../phone/report.js';
import { SetupWizard } from './SetupWizard';
import { fmt } from '../modules/arcade/Arcade';
import { merge3 } from '../core/merge';

type Tab = 'today' | 'earn' | 'rewards' | 'allowed' | 'settings';

/** Five screens (plus Settings). Works standalone in the Parent Console app, or embedded in Scholar behind the PIN. */
export function ParentConsole({ embedded, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const [hello, setHello] = useState<{ isAdmin: boolean; setupNeeded: boolean; childId?: string } | null>(null);
  const [authed, setAuthed] = useState(false);
  const [state, setState] = useState<ParentState | null>(null);
  const [tab, setTab] = useState<Tab>('today');
  const [kidId, setKidId] = useState<string | null>(() => { try { return localStorage.getItem('cq.parent.kid'); } catch { return null; } });
  const [adding, setAdding] = useState(false);
  const pickKid = (id: string) => { setKidId(id); try { localStorage.setItem('cq.parent.kid', id); } catch { /* fine */ } };
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
  // After setup, ask the Guardian again who this is: an account that just became a kid's (or any non-admin) needs the PIN.
  if (hello.setupNeeded) return <SetupWizard onDone={() => { setAuthed(false); setHello(null); sayHello(); }} />;

  // An admin account that isn't itself a managed child gets in without a PIN (it's the parent's own login).
  // Inside the child's session (embedded) the PIN is always required.
  const needsPin = embedded || !hello.isAdmin || !!hello.childId;
  if (!authed && needsPin) return <PinGate onOk={() => setAuthed(true)} onCancel={onClose} />;
  if (!authed) { setAuthed(true); return null; }
  if (!state) return <div class="screen center"><p class="muted">Loading…</p>{error && <p class="error">{error}</p>}</div>;

  const kids = state.household.children;
  const child = kids.find((k) => k.id === kidId) ?? kids[0];
  const pendingCount = state.pendingClaims.length;

  return (
    <div class="parent">
      <nav class="tabs">
        {([['today', 'Today'], ['earn', 'Ways to earn'], ['rewards', 'Rewards'], ['allowed', 'Allowed'], ['settings', 'Settings']] as [Tab, string][]).map(([t, label]) => (
          <button class={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}{t === 'today' && pendingCount > 0 && <i class="tab-badge">{pendingCount}</i>}</button>
        ))}
        {embedded && <button class="ghost close" onClick={onClose}>✕ Close</button>}
      </nav>
      {/* Kids on this PC: tap to switch; every tab follows the chosen kid. */}
      <div class="kid-row" role="tablist" aria-label="Kids">
        {kids.map((k) => <button role="tab" class={'kid-pill' + (k.id === child?.id ? ' on' : '')} style={{ '--kid': kidColor(kids, k.id) } as any} onClick={() => pickKid(k.id)}>{state.locks?.[k.id]?.locked && <span class="pill-lock" aria-label="locked">🔒</span>}{k.displayName}</button>)}
        <button class="kid-pill add" onClick={() => setAdding(true)}>＋ Add a kid</button>
        {child && <LockControl child={child} lock={state.locks?.[child.id]} onChange={refresh} />}
      </div>
      {adding && <AddKid taken={kids.map((k) => kidColor(kids, k.id))} onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); pickKid(id); refresh(); }} />}
      {error && <p class="error">{error}</p>}
      <section class="tab-body">
        {!child && <p class="muted">No child set up yet.</p>}
        {tab === 'today' && <GettingStarted state={state} />}
        {child && tab === 'today' && <Today state={state} child={child} onChange={refresh} onGo={setTab} />}
        {child && tab === 'earn' && <Quests child={child} onSave={(c) => save(child, c, refresh, setError)} />}
        {child && tab === 'rewards' && <ShopEditor child={child} rising={state.perChild[child.id]?.rising ?? {}} onSave={(c) => save(child, c, refresh, setError)} />}
        {child && tab === 'allowed' && <><LockStatus state={state} child={child} /><Allowed child={child} onSave={(c) => save(child, c, refresh, setError)} /></>}
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


/**
 * "Add a kid": a new Windows account for them (or one already on this PC), then their own coins, quests and limits.
 * Then the phone: phones already linked to this PC show the new kid by themselves; a new phone scans the code here.
 */
function AddKid({ onClose, onAdded, taken }: { onClose: () => void; onAdded: (childId: string) => void; taken: string[] }) {
  const [accounts, setAccounts] = useState<WinAccount[] | null>(null);
  const [added, setAdded] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => { bridge.parentAccounts().then(setAccounts).catch(() => setAccounts([])); }, []);
  const close = () => { if (added) onAdded(added.id); else onClose(); };
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [added]);
  return (
    <div class="modal" onClick={close}>
      <div class="card add-kid" role="dialog" aria-label="Add a kid" onClick={(e) => e.stopPropagation()}>
        <div class="row between"><h3>{added ? `${added.name} is set up` : 'Add a kid'}</h3><button class="ghost small" onClick={close}>{added ? 'Done' : 'Close'}</button></div>
        {added ? (
          <>
            <p class="muted">Phones already linked to this computer show {added.name} now. To see {added.name} on a new phone, scan this code with it.</p>
            <PhoneControl compact />
          </>
        ) : (
          <>
            <p class="muted small">They get their own Windows sign-in, coins, quests and limits.</p>
            <KidAccount accounts={accounts} action="Add" taken={taken} create={(u, f, p) => bridge.parentCreateAccount(u, f, p)}
              onPicked={async (k) => { const r = await bridge.parentAddChild(k.displayName, k.account, k.color); setAdded({ id: r.childId, name: k.displayName }); }} />
          </>
        )}
      </div>
    </div>
  );
}

function PinGate({ onOk, onCancel }: { onOk: () => void; onCancel?: () => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  async function go(e: Event) {
    e.preventDefault();
    try { await bridge.parentLogin(pin); onOk(); } catch (ex) { setErr((ex as Error).message); setPin(''); }
  }
  return (
    <div class="screen center">
      <form class="card pin-gate" onSubmit={go}>
        <div class="pin-icon" aria-hidden="true">🔒</div>
        <h2>Parent PIN</h2>
        <p class="muted small">Enter your PIN to open the parent controls.</p>
        <input type="password" inputMode="numeric" autocomplete="off" aria-label="Parent PIN" autofocus value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value.replace(/\D/g, ''))} maxLength={8} />
        {err && <p class="error small">{err === 'wrong PIN' ? "That PIN isn't right — try again." : err}</p>}
        <button class="primary wide" type="submit" disabled={pin.length < 4}>Open</button>
        {onCancel && <button class="ghost wide" type="button" onClick={onCancel}>Cancel</button>}
      </form>
    </div>
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
  const [give, setGive] = useState<1 | -1 | null>(null);
  const net = state.enforcement?.internetLock;
  const netOk = !state.enforcement || (!!net?.applied && !net.error);
  return (
    <div class="today">
      <div class="card kid-head">
        <div class="kid-who">
          <h2>{child.displayName}</h2>
          <p class={'lock-line ' + (netOk ? 'ok' : 'bad')}>
            {netOk ? '🔒 Internet lock on' : '⚠️ Internet lock is off'}
            {state.enforcement?.childAtKeyboard ? ` · ${child.displayName} is on the computer now` : ''}
            {!netOk && <button class="link" onClick={() => onGo('allowed')}>See why</button>}
          </p>
        </div>
        <div class="kid-balance"><small>Coins</small><b>🪙 {pc.balance}</b></div>
        <div class="kid-actions">
          <button class="primary" onClick={() => setGive(give === 1 ? null : 1)}>＋ Give</button>
          <button class="secondary" onClick={() => setGive(give === -1 ? null : -1)}>－ Take</button>
        </div>
        {give && <GiveCoins child={child} sign={give} onDone={() => { setGive(null); onChange(); }} />}
      </div>
      {state.pendingClaims.length > 0 && (
        <div class="card">
          <h3>Waiting for your OK</h3>
          <Approvals state={state} onChange={onChange} />
        </div>
      )}
      {pc.unlocks.length > 0 && (
        <div class="card">
          <h3>Running now</h3>
          {pc.unlocks.map((u) => <div class="row between"><span>{u.prizeName} · {fmt(Math.max(0, Math.round((Date.parse(u.expiresAt) - Date.now()) / 1000)))} left</span><button class="ghost small" onClick={() => bridge.parentEndUnlock(u.id).then(onChange)}>End now</button></div>)}
        </div>
      )}
      <ActivityPanel child={child} />
      <ClassicsNudge child={child} onGo={() => { onGo('rewards'); setTimeout(() => document.querySelector('.fp-panel')?.scrollIntoView({ behavior: 'smooth' }), 300); }} />
      {!state.ledgerIntact && <p class="error">⚠️ The coin ledger failed its integrity check. Someone may have edited it directly.</p>}
    </div>
  );
}

/** Give or take coins, with a reason the child sees in their history. */
function GiveCoins({ child, sign, onDone }: { child: Child; sign: 1 | -1; onDone: () => void }) {
  const [n, setN] = useState(5);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const go = () => bridge.parentAdjust(child.id, sign * Math.abs(n), reason.trim() || (sign > 0 ? 'From a parent' : 'Taken by a parent')).then(onDone).catch((e) => setErr(e.message));
  return (
    <div class="give-coins">
      <div class="give-amounts">{[1, 5, 10, 25, 50].map((v) => <button class={'chip-btn' + (n === v ? ' on' : '')} onClick={() => setN(v)}>{v}</button>)}
        <label class="coin-field"><input type="number" min={1} class="coins-input" value={n} onInput={(e) => setN(Math.abs(Math.round(Number((e.target as HTMLInputElement).value) || 0)))} /><span>🪙</span></label></div>
      <input class="grow" placeholder={sign > 0 ? 'What for? (e.g. Cleaned their room)' : 'Why? (e.g. Didn\'t do chores)'} value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && n > 0 && go()} />
      <button class={sign > 0 ? 'primary' : 'danger'} disabled={!n} onClick={go}>{sign > 0 ? `Give ${n} 🪙` : `Take ${n} 🪙`}</button>
      {err && <p class="error">{err}</p>}
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
        <b>{netOk ? `Internet lock is on for ${child.displayName}` : `Internet lock is off`}</b>
        <p class="muted small">
          {netOk
            ? `${child.displayName} can only reach the websites and apps on this page (YouTube is under Rewards). Your own account isn't affected.`
            : `It couldn't be turned on (${net?.error ?? 'not applied yet'}). Restart the computer; if it stays off, see Settings → Advanced.`}
        </p>
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
          <div class="claim-text">{state.household.children.length > 1 && <small class="claim-kid">{state.household.children.find((k) => k.id === c.childId)?.displayName}</small>}<b>{c.moduleId === 'allow-ads' ? '🚫 Allow ads?' : c.moduleId === 'open-profile' ? '🔒 Open the computer?' : labelFor(c.moduleId)}</b><p>{c.detail}{c.moduleId === 'allow-ads' && <><br /><small class="muted">Ads are hidden on every site. Allow them here only if the site won't work without them.</small></>}</p><small class="muted">{when(c.at)}</small></div>
          {c.moduleId === 'open-profile' ? <div class="claim-actions">
            <button class="primary" onClick={() => bridge.parentResolveClaim(c.ledgerSeq, true, 0).then(onChange)}>Open it</button>
            <button class="ghost" onClick={() => bridge.parentResolveClaim(c.ledgerSeq, false).then(onChange)}>Keep locked</button>
          </div> : c.moduleId === 'allow-ads' ? <div class="claim-actions">
            <button class="primary" onClick={() => bridge.parentResolveClaim(c.ledgerSeq, true, 0).then(onChange)}>Allow ads</button>
            <button class="ghost" onClick={() => bridge.parentResolveClaim(c.ledgerSeq, false).then(onChange)}>Keep hidden</button>
          </div> : <div class="claim-actions">
            <label class="coin-field" title="Coins to give (can be negative)"><input type="number" class="coins-input" value={coins[c.ledgerSeq] ?? c.coins} min={-500} max={500} onInput={(e) => setCoins({ ...coins, [c.ledgerSeq]: Number((e.target as HTMLInputElement).value) })} /><span>🪙</span></label>
            <button class="primary" onClick={() => bridge.parentResolveClaim(c.ledgerSeq, true, coins[c.ledgerSeq] ?? c.coins).then(onChange)}>Approve</button>
            <button class="ghost" onClick={() => bridge.parentResolveClaim(c.ledgerSeq, false).then(onChange)}>Deny</button>
          </div>}
        </div>
      ))}
    </div>
  );
}

const labelFor = (id: string) => MODULES.find((m) => m.id === id)?.title ?? (id.charAt(0).toUpperCase() + id.slice(1)).replace(/[-_]/g, ' ');

/** "Today 9:41 PM", "Yesterday 8:02 AM", "Oct 12, 3:15 PM". */
function when(iso: string) {
  const d = new Date(iso), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  return diff === 0 ? `Today ${time}` : diff === 1 ? `Yesterday ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
const signed = (n: number) => (n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0');

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
  const ads = child.allowlist.adsAllowed ?? [];
  const setAds = (site: string, on: boolean) => onSave({ ...child, allowlist: { ...child.allowlist, adsAllowed: on ? [...new Set([...ads, site])] : ads.filter((x) => x !== site) } });

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
      <div class="card">
        <h3>Websites</h3>
        <p class="muted">These are the only websites that open (inside CoinQuest's locked browser). Everything else is blocked.</p>
        <div class="row"><input value={site} placeholder="e.g. duolingo.com" onInput={(e) => setSite((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && addSite()} /><button class="primary" onClick={addSite}>Add</button></div>
        <div class="chips">{sites.map((s) => {
          const adsOn = ads.includes(s);
          return <span class="chip">{s}<button class={'chip-ads' + (adsOn ? ' on' : '')} title={adsOn ? 'Ads are shown on this site. Click to hide them again.' : 'Ads are hidden on this site. Click to allow them (for a site that won\'t work without them).'} onClick={() => setAds(s, !adsOn)}>{adsOn ? 'ads shown' : 'ads hidden'}</button><button aria-label={`Remove ${s}`} onClick={() => setSites(sites.filter((x) => x !== s))}>✕</button></span>;
        })}</div>
        <p class="muted small">CoinQuest hides ads on every site. If a site won't work without them, click "ads hidden" to allow them there. Your child can also ask from the site; you'll see it under requests.</p>
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

/**
 * Everything about YouTube in one fold-away section of Rewards (like the arcade): what it costs, an optional daily
 * limit, which channels; and, tucked under Advanced, turning channel filtering off.
 */
function YouTubeSection({ child, onSave }: { child: Child; onSave: (c: Child) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const list = child.youTubeChannels ?? [];
  const yt = child.prizes.find((p) => p.kind === 'youTube');
  const on = !!yt && yt.enabled !== false;
  const any = !!child.youTubeAnyVideo;
  async function add() {
    setBusy(true); setErr('');
    try {
      const ch = await bridge.parentYouTubeResolve(url.trim());
      if (!list.some((c) => c.id === ch.id)) onSave({ ...child, youTubeChannels: [...list, ch] });
      setUrl('');
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  const perBlock = yt ? Math.ceil(yt.cost / ((yt.minutes || 20) / BLOCK_MINUTES)) : null;
  return (
    <details class="card fold yt-section">
      <summary><h3>▶️ YouTube</h3><span class="muted small">{!on ? 'off' : [`🪙 ${perBlock} per ${BLOCK_MINUTES} min`, yt?.maxMinutesPerDay ? `⏱️ ${yt.maxMinutesPerDay} min a day` : '', any ? 'any video' : `${list.length} channel${list.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</span></summary>
      <YouTubePrice child={child} onSave={onSave} />
      <h4>Channels</h4>
      <p class="muted small">Only these channels' videos. Paste a channel link, like youtube.com/@MarkRober.</p>
      <div class="row"><input style={{ flex: 1 }} value={url} placeholder="https://www.youtube.com/@channel" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && url && add()} /><button class="primary" disabled={!url || busy} onClick={add}>{busy ? 'Finding…' : 'Add channel'}</button></div>
      {err && <p class="error">{err}</p>}
      <div class="chips">{list.map((c) => <span class="chip">{c.title}<button onClick={() => onSave({ ...child, youTubeChannels: list.filter((x) => x.id !== c.id) })}>✕</button></span>)}</div>
      {list.length === 0 && !any && <p class="muted small">No channels yet: the YouTube button won't appear for {child.displayName} until you add one.</p>}
      <details class="more advanced">
        <summary><span class="muted small">Advanced</span></summary>
        <label class="check"><input type="checkbox" checked={any} onChange={(e) => onSave({ ...child, youTubeAnyVideo: (e.target as HTMLInputElement).checked })} />
          <span>Allow any YouTube video during YouTube time <span class="muted small">(no channel filtering: {child.displayName} can search and watch anything on youtube.com while their YouTube time runs; the timer and price still apply)</span></span></label>
      </details>
    </details>
  );
}

/**
 * What YouTube time costs: coins per 5 minutes (the kid buys it with + in 5-minute steps)
 * and at most how many minutes a day. Stored as the YouTube reward (cost for its minutes), so price changes ease in like any other.
 */
function YouTubePrice({ child, onSave }: { child: Child; onSave: (c: Child) => void }) {
  const prizes = child.prizes;
  const yt = prizes.find((p) => p.kind === 'youTube');
  const minutes = yt?.minutes || 20;
  const perBlock = yt ? Math.ceil(yt.cost / (minutes / BLOCK_MINUTES)) : 12;
  const put = (p: Prize) => onSave({ ...child, prizes: yt ? prizes.map((x) => (x.id === yt.id ? p : x)) : [...prizes, p] });
  const base: Prize = yt ?? { id: 'p' + Math.random().toString(36).slice(2, 10), name: 'YouTube time', cost: perBlock * (minutes / BLOCK_MINUTES), kind: 'youTube', minutes, dailyCap: 0, boughtToday: 0, targets: [], enabled: true };
  const on = !!yt && yt.enabled !== false;
  return (
    <div class="yt-price">
      <div class="sentence">
        <label class="check"><input type="checkbox" checked={on} onChange={(e) => put({ ...base, enabled: (e.target as HTMLInputElement).checked })} /> YouTube time costs</label>
        <input type="number" min={1} class="num" value={perBlock} disabled={!on}
          onChange={(e) => { const v = Math.max(1, Number((e.target as HTMLInputElement).value) || 1); put({ ...base, cost: Math.round(v * (minutes / BLOCK_MINUTES)) }); }} />
        <span>🪙 per {BLOCK_MINUTES} minutes</span>
      </div>
      {on && <div class="daily-limit">
        <span>⏱️ Daily limit</span>
        <input type="number" min={0} step={5} class="num" value={yt?.maxMinutesPerDay || ''} placeholder="none" style={{ width: '5.5em' }}
          onChange={(e) => put({ ...base, dailyCap: 0, maxMinutesPerDay: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })} />
        <span>minutes</span>
      </div>}
    </div>
  );
}

// ---------------------------------------------------------------- Shop editor

/** What a reward can give: pick any mix of time (one clock), or something real. */
const GIVES: [string, string, string][] = [['games', '🕹️', 'Any game'], ['youtube', '▶️', 'YouTube'], ['sites', '🌐', 'Websites'], ['apps', '💻', 'Apps'], ['real', '🎁', 'Something real']];
const GIVE_WORDS: Record<string, string> = { games: 'any game', youtube: 'YouTube', sites: 'websites', apps: 'apps' };
/** What an older single-kind reward gives, in the new terms. */
const givesOf = (p: Prize): string[] =>
  p.kind === 'realWorld' ? ['real'] : p.kind === 'pass' || p.kind === 'screenTimeExtension' ? (p.includes?.length ? p.includes : ['games', 'youtube'])
  : p.kind === 'siteUnlock' ? ['sites'] : p.kind === 'appUnlock' ? ['apps'] : p.kind === 'arcadeUnlock' ? ['games'] : p.kind === 'youTube' ? ['youtube'] : [];
const autoName = (gives: string[], minutes: number) => gives.includes('real') ? '' : gives.length ? `${minutes} minutes of ${((w) => w.length > 1 ? w.slice(0, -1).join(', ') + ' or ' + w[w.length - 1] : w[0])(gives.map((g) => GIVE_WORDS[g]))}` : '';

/** One clean form: what it gives (tap any mix), for how long, the price, how often. The name fills itself in. */
function PrizeEditor({ prize, isNew, onSave, onCancel, onDelete }: { prize: Prize; isNew: boolean; onSave: (p: Prize) => void; onCancel: () => void; onDelete: () => void }) {
  // A name that was filled in automatically keeps following the choices.
  const [p, setP] = useState(() => ({ ...prize, name: prize.name === autoName(givesOf(prize), prize.minutes) ? '' : prize.name }));
  const [gives, setGives] = useState<string[]>(givesOf(prize));
  const [sites, setSites] = useState((prize.kind === 'appUnlock' ? [] : prize.targets ?? []).join(', '));
  const [apps, setApps] = useState((prize.kind === 'appUnlock' ? prize.targets ?? [] : prize.apps ?? []).join(', '));
  const real = gives.includes('real');
  const toggle = (g: string) => setGives(g === 'real' ? (real ? [] : ['real']) : gives.includes(g) ? gives.filter((x) => x !== g) : [...gives.filter((x) => x !== 'real'), g]);
  const list = (t: string) => t.split(',').map((x) => x.trim()).filter(Boolean);
  const auto = autoName(gives, p.minutes || 15);
  const name = p.name.trim() || auto;
  function save() {
    onSave(real
      ? { ...p, name, kind: 'realWorld', includes: [], targets: [], apps: [], minutes: 0 }
      : { ...p, name, kind: 'pass', includes: gives, targets: gives.includes('sites') ? list(sites) : [], apps: gives.includes('apps') ? list(apps) : [], minutes: p.minutes || 15 });
  }
  const ok = name && gives.length > 0 && (!gives.includes('sites') || list(sites).length > 0) && (!gives.includes('apps') || list(apps).length > 0);
  return (
    <div class="modal"><div class="card form prize-editor">
      <h3>{isNew ? 'New reward' : 'Edit reward'}</h3>
      <div class="gives" role="group" aria-label="It gives">
        {GIVES.map(([g, icon, label]) => <button type="button" class={'give-chip' + (gives.includes(g) ? ' on' : '')} aria-pressed={gives.includes(g)} onClick={() => toggle(g)}>{icon} {label}</button>)}
      </div>
      {gives.includes('sites') && <label>Websites<input value={sites} placeholder="scratch.mit.edu, minecraft.net" onInput={(e) => setSites((e.target as HTMLInputElement).value)} /></label>}
      {gives.includes('apps') && <label>Apps<input value={apps} placeholder="Minecraft.exe" onInput={(e) => setApps((e.target as HTMLInputElement).value)} /></label>}
      <div class="sentence">
        {!real && <><span>For</span><input type="number" class="num" min={5} step={5} value={p.minutes || 15} onInput={(e) => setP({ ...p, minutes: Number((e.target as HTMLInputElement).value) })} /><span>minutes,</span></>}
        <span>{real ? 'Costs' : 'costs'}</span><input type="number" class="num" min={1} value={p.cost} onInput={(e) => setP({ ...p, cost: Number((e.target as HTMLInputElement).value) })} /><span>🪙,</span>
        <input type="number" class="num" min={0} value={p.dailyCap || ''} placeholder="any" onInput={(e) => setP({ ...p, dailyCap: Number((e.target as HTMLInputElement).value) || 0 })} /><span>times a day</span>
      </div>
      <label>Name<input value={p.name} placeholder={auto || "Pick Friday's movie"} onInput={(e) => setP({ ...p, name: (e.target as HTMLInputElement).value })} /></label>
      <label class="check"><input type="checkbox" checked={p.enabled !== false} onChange={(e) => setP({ ...p, enabled: (e.target as HTMLInputElement).checked })} /> Show in shop</label>
      <div class="row">
        <button class="primary" disabled={!ok} onClick={save}>Save</button>
        <button class="ghost" onClick={onCancel}>Cancel</button>
        {!isNew && <button class="ghost danger" onClick={onDelete}>Delete</button>}
      </div>
    </div></div>
  );
}

/**
 * How price rises reach the kid. A tool for the kid's feelings, not the parent's wallet: small steps sit under what
 * people notice, so 48 → 60 doesn't feel like a jump; while it eases in the kid sees the coming price crossed out and
 * today's as a limited-time deal. Drops always apply at once and show as a deal.
 */
function PriceEaseIn({ child, rising, onSave }: { child: Child; rising: Record<string, number>; onSave: (c: Child) => void }) {
  const on = child.priceRisesEaseIn !== false;
  const easing = Object.keys(rising).length;
  return (
    <details class="more price-ease">
      <summary><span class="muted small">💡 Price rises {on ? 'ease in over a few days' : 'apply right away'}{easing ? ` · ${easing} easing in now` : ''}</span></summary>
      <p class="muted small">This is for {child.displayName}'s feelings: a big jump (48 → 60) feels unfair, small steps don't. A rise eases in over about 3 days in equal steps (bigger ones take up to a week so no single step is more than 10%; a 1-coin or under-8% rise applies at once), and meanwhile {child.displayName} sees the new price crossed out and today's as a "Limited time!" deal. Price drops always apply at once and show as "Price drop!". You always set the real price.</p>
      <label class="check"><input type="checkbox" checked={on} onChange={(e) => onSave({ ...child, priceRisesEaseIn: (e.target as HTMLInputElement).checked })} /> Ease price rises in (recommended)</label>
      {easing > 0 && <button class="ghost small" onClick={() => bridge.parentPricesNow(child.id).then(() => onSave({ ...child }))}>Finish the {easing} rise{easing === 1 ? '' : 's'} now</button>}
    </details>
  );
}

function ShopEditor({ child, rising, onSave }: { child: Child; rising: Record<string, number>; onSave: (c: Child) => void }) {
  const [editing, setEditing] = useState<Prize | null>(null);
  const prizes = child.prizes;
  const put = (p: Prize) => { const i = prizes.findIndex((x) => x.id === p.id); const next = [...prizes]; if (i >= 0) next[i] = p; else next.push(p); onSave({ ...child, prizes: next }); setEditing(null); };
  const blank = (): Prize => ({ id: 'p' + Math.random().toString(36).slice(2, 10), name: '', cost: 30, kind: 'pass', includes: ['games'], minutes: 15, dailyCap: 0, boughtToday: 0, targets: [], enabled: true });

  return (
    <div class="shop-editor">
      <p class="muted lead">What {child.displayName} can spend coins on. Tap one to change it. YouTube and the arcade are below.</p>
      <div class="prize-list">
        {prizes.filter((p) => p.kind !== 'youTube').map((p) => <button class={'prize-row' + (p.enabled === false ? ' off' : '')} onClick={() => setEditing({ ...p })}><span class="icon">{givesOf(p).map((g) => GIVES.find((x) => x[0] === g)?.[1]).join('')}</span><b>{p.name}</b><span>🪙 {p.cost}{rising['prize:' + p.id] != null && <small class="muted rising" title="Easing in: a little more each day, so it doesn't feel like a jump."> ({rising['prize:' + p.id]} today)</small>}</span><small class="muted">{[p.minutes ? `${p.minutes} min` : '', p.dailyCap ? `max ${p.dailyCap}/day` : '', p.enabled === false ? 'hidden' : ''].filter(Boolean).join(' · ')}</small></button>)}
      </div>
      <div class="section-actions"><button class="secondary" onClick={() => setEditing(blank())}>＋ Add a reward</button></div>
      <PriceEaseIn child={child} rising={rising} onSave={onSave} />
      <YouTubeSection child={child} onSave={onSave} />
      <ArcadeManager child={child} onSave={onSave} />
      {editing && <PrizeEditor prize={editing} isNew={!prizes.some((p) => p.id === editing.id)} onSave={put} onCancel={() => setEditing(null)}
        onDelete={() => { onSave({ ...child, prizes: prizes.filter((p) => p.id !== editing.id) }); setEditing(null); }} />}
    </div>
  );
}

function ArcadeManager({ child, onSave }: { child: Child; onSave: (c: Child) => void }) {
  const [games, setGames] = useState<Game[] | null>(null);
  const [err, setErr] = useState('');
  const [web, setWeb] = useState<WebGame>({ id: '', title: '', url: '', strategy: 3 });
  const [upload, setUpload] = useState<{ file: File; title: string; strategy: number } | null>(null);
  const settings = child.arcade ?? { minutesPerPlay: 10, priceOverrides: {}, hidden: [], webGames: [] };
  const reload = () => bridge.parentArcadeCatalog(child.id).then((r) => setGames(r.games)).catch((e) => setErr(e.message));
  useEffect(() => { reload(); }, [child]);
  const saveArcade = (a: typeof settings) => onSave({ ...child, arcade: a });
  /** Every shown game one coin cheaper or dearer (never below 1). */
  const bumpAll = (d: number) => {
    const o = { ...settings.priceOverrides };
    for (const g of (games ?? []).filter((x) => x.available && !settings.hidden.includes(x.id))) {
      const v = Math.max(1, (g.target ?? g.price) + d);
      if (v === defaultArcadePrice(g.strategy)) delete o[g.id]; else o[g.id] = v;
    }
    saveArcade({ ...settings, priceOverrides: o });
  };

  async function doUpload() {
    if (!upload) return;
    setErr('');
    try {
      const buf = new Uint8Array(await upload.file.arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      await bridge.parentArcadeUpload(upload.file.name, btoa(bin), upload.title || upload.file.name.replace(/\.swf$/i, ''), upload.strategy, child.id);
      setUpload(null); reload();
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <details class="card arcade-manager fold">
      <summary><h3>🕹️ Arcade</h3><span class="muted small">{(games ?? []).filter((g) => g.available && !settings.hidden.includes(g.id)).length} games{settings.maxMinutesPerDay ? ` · ⏱️ ${settings.maxMinutesPerDay} min a day` : ''}</span></summary>
      <div class="daily-limit">
        <span>⏱️ Daily limit</span>
        <input type="number" min={0} step={5} class="num" value={settings.maxMinutesPerDay || ''} placeholder="none" style={{ width: '5.5em' }}
          onChange={(e) => saveArcade({ ...settings, maxMinutesPerDay: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })} />
        <span>minutes</span>
      </div>
      <p class="muted small">Prices are 🪙 per {BLOCK_MINUTES} minutes. More 🧠 = cheaper.</p>
      {err && <p class="error">{err}</p>}
      <table class="arcade-table">
        <thead><tr><th>Game</th><th>Thinking</th><th>🪙 per {BLOCK_MINUTES} min
          <span class="bulk-price" title="Change every game's price by one coin. A rise reaches the kid a little each day; a drop shows as a deal.">
            <button class="ghost small" aria-label="All games one coin cheaper" onClick={() => bumpAll(-1)}>−1</button><button class="ghost small" aria-label="All games one coin dearer" onClick={() => bumpAll(1)}>+1</button>
          </span></th><th>Show</th><th /></tr></thead>
        <tbody>
          {(games ?? []).filter((g) => g.available).map((g) => {
            const hidden = settings.hidden.includes(g.id);
            return (
              <tr class={hidden ? 'off' : ''}>
                <td><b>{g.title}</b><br /><small class="muted">{g.source === 'web' ? g.author : g.source === 'uploaded' ? 'added by you' : g.license}</small></td>
                <td>{'🧠'.repeat(g.strategy)}</td>
                <td><input type="number" min={0} value={g.target ?? g.price} style={{ width: '5em' }}
                  onChange={(e) => { const v = Number((e.target as HTMLInputElement).value); const o = { ...settings.priceOverrides }; if (v === defaultArcadePrice(g.strategy)) delete o[g.id]; else o[g.id] = v; saveArcade({ ...settings, priceOverrides: o }); }} />
                  {g.target != null && g.price < g.target && <small class="muted rising" title="Rises reach your kid a little each day, so it doesn't feel like a jump.">{g.price} today</small>}</td>
                <td><input type="checkbox" checked={!hidden} onChange={(e) => saveArcade({ ...settings, hidden: (e.target as HTMLInputElement).checked ? settings.hidden.filter((x) => x !== g.id) : [...settings.hidden, g.id] })} /></td>
                <td>{g.source === 'uploaded' && <button class="ghost small danger" onClick={() => bridge.parentArcadeRemove(g.id).then(reload)}>Remove</button>}
                  {g.source === 'web' && <button class="ghost small danger" onClick={() => saveArcade({ ...settings, webGames: settings.webGames.filter((w) => w.id !== g.id) })}>Remove</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <details class="more" open={(games ?? []).filter((g) => g.available).length < 5}>
      <summary><b>Add more games</b> <span class="muted small">— classic games library, your own game files, game websites</span></summary>
      <FlashpointPanel child={child} onSave={onSave} onChanged={reload} />
      <div class="two-col">
        <div>
          <h4>Add a Flash game file (.swf)</h4>
          <p class="muted small">For games you own or that the author lets you download.</p>
          <label class="file-pick"><input type="file" accept=".swf" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) setUpload({ file: f, title: f.name.replace(/\.swf$/i, ''), strategy: 3 }); }} /><span class="button secondary">Choose a .swf file…</span>{upload && <span class="muted small">{upload.file.name}</span>}</label>
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
      </details>
    </details>
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
                    <span><b>{x.game.title}</b> <small class="muted">{[x.pick.genre, x.game.developer, x.pick.note].filter(Boolean).join(' · ')}</small></span>
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

/** How each quest pays, in one line: "10 🪙 each · up to 80 a day · asks you first". */
function paySummary(m: (typeof MODULES)[number], s: ModSettings): string {
  const o = s.options ?? {};
  const pay = m.paysByWords ? `1 🪙 per ${o.wordsPer ?? 20} words`
    : m.id === 'khan-academy' ? `${o.perAnswer ?? 1} 🪙 per right answer${Number(o.perVideo ?? 0) > 0 ? ` · ${o.perVideo} per video` : ' · videos don\'t pay'}${s.coinsPerActivity > 0 ? ` · ${s.coinsPerActivity} per finished exercise` : ''}`
    : m.id === 'books' ? `${s.coinsPerActivity} 🪙 per right answer · ${allowedLabel(o.allowed)}`
    : m.id === 'reading-quest' ? `${s.coinsPerActivity} 🪙 per right answer · streak bonus every ${o.streakEvery ?? 2}`
    : m.id === 'duolingo' ? `${s.coinsPerActivity} 🪙 per lesson`
    : m.id === 'discgames' ? `${s.coinsPerActivity} 🪙 per bit of progress`
    : m.id === 'sound-keys' ? `${s.coinsPerActivity} 🪙 per lesson`
    : m.id === 'typing-quest' ? `${s.coinsPerActivity} 🪙 per drill`
    : `${s.coinsPerActivity} 🪙 each`;
  return [pay, s.dailyCap > 0 ? `up to ${s.dailyCap} a day` : 'no daily limit', s.requireApproval || m.verification === 'parent_approved' ? 'asks you first' : ''].filter(Boolean).join(' · ');
}

const EARN_GROUPS: [string, string[]][] = [
  ['Reading', ['reading-quest', 'books']],
  ['Typing', ['sound-keys', 'typing-quest', 'passages']],
  ['Learning websites', ['khan-academy', 'duolingo']],
  ['Classic games', ['discgames']],
];

/** Ways to earn: each quest is one line (what it pays) with a switch; Edit opens its settings. */
function Quests({ child, onSave }: { child: Child; onSave: (c: Child) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const cur = (id: string): ModSettings => child.modules[id] ?? { enabled: false, requireApproval: false, ...MODULES.find((m) => m.id === id)!.defaults };
  /** Change one or more quests in one save. */
  const setMods = (ids: string[], patch: Partial<ModSettings>) => {
    const modules = { ...child.modules };
    let allowlist = child.allowlist;
    for (const id of ids) {
      const mod = MODULES.find((m) => m.id === id)!;
      const c = cur(id);
      modules[id] = { ...c, ...patch, options: patch.options ? { ...(c.options ?? {}), ...patch.options } : c.options };
      // Turning a quest on adds the sites it needs.
      if (patch.enabled && mod.requiredSites) allowlist = { ...allowlist, sites: [...new Set([...allowlist.sites, ...mod.requiredSites])] };
    }
    onSave({ ...child, modules, allowlist });
  };
  const setMod = (id: string, patch: Partial<ModSettings>) => setMods([id], patch);
  const grouped = new Set(EARN_GROUPS.flatMap(([, ids]) => ids));
  const others = MODULES.filter((m) => !grouped.has(m.id) && m.id !== 'rwt' && m.id !== 'bible-typing' && m.id !== 'my-passages').map((m) => m.id);
  const groups = others.length ? [...EARN_GROUPS, ['More', others] as [string, string[]]] : EARN_GROUPS;

  function card(id: string) {
    if (id === 'passages') return <PassagesCard key="passages" child={child} open={open === 'passages'} onToggle={() => setOpen(open === 'passages' ? null : 'passages')} cur={cur} setMods={setMods} />;
    const m = MODULES.find((x) => x.id === id);
    if (!m) return null;
    const s = cur(id);
    const isOpen = open === id;
    return (
      <div class={'card quest-row' + (s.enabled ? '' : ' off') + (isOpen ? ' open' : '')}>
        <div class="quest-line">
          <span class="quest-ico">{m.icon}</span>
          <div class="quest-name"><b>{m.title}</b><small>{s.enabled ? paySummary(m, s) : 'Off'}</small></div>
          <button class="ghost small" onClick={() => setOpen(isOpen ? null : id)}>{isOpen ? 'Done' : 'Edit'}</button>
          <label class="switch" title={s.enabled ? 'On' : 'Off'}><input type="checkbox" checked={s.enabled} onChange={(e) => setMod(id, { enabled: (e.target as HTMLInputElement).checked })} /><span>{s.enabled ? 'On' : 'Off'}</span></label>
        </div>
        {isOpen && (
          <div class="quest-body">
            <p class="muted">{m.description}</p>
            {id === 'books' && <BookPicker childId={child.id} s={s} set={(p) => setMod(id, p)} />}
            {id === 'discgames' && <DiscImport rwt={{ s: cur('rwt'), set: (p) => setMod('rwt', p) }} />}
            <div class="row">
              <label>{id === 'books' ? 'Coins per right answer' : id === 'discgames' ? 'Coins per bit of progress' : id === 'khan-academy' ? 'Coins per finished exercise' : id === 'duolingo' ? 'Coins per lesson' : id === 'sound-keys' ? 'Coins per lesson' : id === 'typing-quest' ? 'Coins per drill' : 'Coins each'}
                <input type="number" value={s.coinsPerActivity} onChange={(e) => setMod(id, { coinsPerActivity: Number((e.target as HTMLInputElement).value) })} /></label>
              {(m.options ?? []).map((o) => (
                <label title={o.help}>{o.label}
                  {o.number
                    ? <span class="per-words"><input type="number" min={o.number.min} max={o.number.max} value={s.options?.[o.key] ?? o.default}
                        onChange={(e) => { const v = Math.max(o.number!.min, Math.min(o.number!.max, Math.round(Number((e.target as HTMLInputElement).value) || 0))); setMod(id, { options: { [o.key]: String(v) } }); }} />{o.suffix && ` ${o.suffix}`}</span>
                    : <select value={s.options?.[o.key] ?? o.default} onChange={(e) => setMod(id, { options: { [o.key]: (e.target as HTMLSelectElement).value } })}>
                        {(o.choices ?? []).map(([v, l]) => <option value={v}>{l}</option>)}
                      </select>}
                </label>
              ))}
              <label title="0 = no limit">Most per day (0 = no limit)<input type="number" min={0} value={s.dailyCap} onChange={(e) => setMod(id, { dailyCap: Number((e.target as HTMLInputElement).value) })} /></label>
              <label class="check"><input type="checkbox" checked={s.requireApproval || m.verification === 'parent_approved'} disabled={m.verification === 'parent_approved'} onChange={(e) => setMod(id, { requireApproval: (e.target as HTMLInputElement).checked })} /> Ask me before paying</label>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div class="quests-editor">
      <p class="muted lead">What {child.displayName} can do to earn coins. Turn each one on or off; <b>Edit</b> changes what it pays.</p>
      {groups.map(([name, ids]) => (
        <section class="quest-group">
          <h4>{name}</h4>
          {ids.map(card)}
        </section>
      ))}
    </div>
  );
}

const allowedLabel = (a?: string) => { if (!a || a === '*') return 'every book'; try { const n = (JSON.parse(a) as string[]).length; return `${n} book${n === 1 ? '' : 's'}`; } catch { return 'every book'; } };

/** Choose the books on the child's shelf, grouped by US grade level. */
function BookPicker({ childId, s, set }: { childId: string; s: ModSettings; set: (p: Partial<ModSettings>) => void }) {
  const [cat, setCat] = useState<Awaited<ReturnType<typeof bridge.parentBooks>> | null>(null);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = () => bridge.parentBooks(childId).then(setCat).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); }, [childId]);
  if (err) return <p class="error">{err}</p>;
  if (!cat) return <p class="muted">Loading the library…</p>;
  const all = cat.books.map((b) => b.id);
  const raw = s.options?.allowed ?? '*';
  let chosen: string[];
  try { chosen = raw === '*' ? all : (JSON.parse(raw) as string[]); } catch { chosen = all; }
  const save = (ids: string[]) => set({ options: { ...(s.options ?? {}), allowed: ids.length === all.length && all.every((x) => ids.includes(x)) ? '*' : JSON.stringify(ids) } });
  const levels = new Map<number, typeof cat.books>();
  for (const b of cat.books) levels.set(b.level, [...(levels.get(b.level) ?? []), b]);
  const grades = (list: typeof cat.books) => { const lo = Math.min(...list.map((b) => b.grade.min)), hi = Math.max(...list.map((b) => b.grade.max)); return `about grades ${lo === 0 ? 'K' : lo}–${hi}`; };
  const reading = (w: number) => (w < 10800 ? `${Math.max(5, Math.round(w / 180 / 5) * 5)} minutes` : `${Math.round(w / 180 / 60)} hours`);
  async function startOver(id: string) { setConfirm(null); try { await bridge.parentBooksReset(childId, id); await load(); } catch (e) { setErr((e as Error).message); } }
  return (
    <div class="book-picker">
      <div class="row between"><h4>Books on the shelf</h4><span><button class="ghost small" onClick={() => save(all)}>All</button><button class="ghost small" onClick={() => save([])}>None</button></span></div>
      <p class="muted small">Your child sees only the level, never a grade. Each chapter pays once; <b>Start over</b> lets them read a book again for coins.</p>
      {cat.flagged > 0 && <p class="muted small">⚑ {cat.flagged} question{cat.flagged === 1 ? ' was' : 's were'} flagged as wrong by your kids — they're listed in the PC's data folder (books-flagged.json) for fixing.</p>}
      {[...levels.entries()].map(([level, list]) => (
        <div class="book-group">
          <h5>Level {level} <span class="muted">· {grades(list)}</span></h5>
          {list.map((b) => (
            <div class="book-pick">
              <input type="checkbox" checked={chosen.includes(b.id)} aria-label={b.title} onChange={(e) => save((e.target as HTMLInputElement).checked ? [...chosen, b.id] : chosen.filter((x) => x !== b.id))} />
              <span>
                <b>{b.title}</b> <span class="muted">· {b.author}, {b.published}</span><br />
                <small class="muted">{b.summary} {b.chapters === 1 ? 'One story' : `${b.chapters} chapters`}, about {reading(b.words)} of reading{b.ready < b.chapters ? ` · quizzes ready for ${b.ready} of ${b.chapters}` : ''}.{b.edited ? ' Lightly edited for today\'s readers.' : ''}</small>
                {(b.measures?.lexile || b.measures?.atos) && <small class="book-measures">{b.measures?.lexile && <a href={b.measures.lexile.url} target="_blank" rel="noreferrer" title={b.measures.lexile.note ?? 'Lexile measure (MetaMetrics)'}>Lexile {b.measures.lexile.code ?? ''}{b.measures.lexile.value}L</a>}{b.measures?.atos && <a href={b.measures.atos.url} target="_blank" rel="noreferrer" title={b.measures.atos.note ?? 'ATOS book level (Renaissance Accelerated Reader)'}>ATOS {b.measures.atos.level.toFixed(1)}</a>}{(b.measures?.lexile?.note || b.measures?.atos?.note) && <span class="muted">{b.measures?.atos?.note ?? b.measures?.lexile?.note}</span>}</small>}
                {b.started && <small class="book-progress">{b.done ? `✓ ${b.chapters === 1 ? 'Read' : `${b.done} of ${b.chapters} chapters passed`}` : 'Started'} · {confirm === b.id
                  ? <><button class="ghost small danger" onClick={() => startOver(b.id)}>Yes, start over</button><button class="ghost small" onClick={() => setConfirm(null)}>Cancel</button></>
                  : <button class="link small" onClick={() => setConfirm(b.id)}>Start over</button>}</small>}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Scripture and the family's own passages: one card, one set of pay rules for both. */
function PassagesCard({ child, open, onToggle, cur, setMods }: { child: Child; open: boolean; onToggle: () => void; cur: (id: string) => ModSettings; setMods: (ids: string[], p: Partial<ModSettings>) => void }) {
  const bible = cur('bible-typing'), mine = cur('my-passages');
  const on = bible.enabled || mine.enabled;
  const both = ['bible-typing', 'my-passages'];
  const own = familyPassages(mine).length;
  const sources = [bible.enabled ? 'Scripture' : '', mine.enabled ? `${own} of your own` : ''].filter(Boolean).join(' + ');
  const sum = `${sources || 'No passages chosen'} · 1 🪙 per ${bible.options?.wordsPer ?? 20} words · ${bible.options?.repeatsPerDay === '0' ? 'pays every time' : bible.options?.repeatsPerDay === 'ever' ? 'each passage pays once' : `each passage pays ${{ '1': 'once', '2': 'twice', '3': '3 times' }[bible.options?.repeatsPerDay ?? '1'] ?? 'once'} a day`}`;
  return (
    <div class={'card quest-row' + (on ? '' : ' off') + (open ? ' open' : '')}>
      <div class="quest-line">
        <span class="quest-ico">📖</span>
        <div class="quest-name"><b>Passage Typing</b><small>{on ? sum : 'Off'}</small></div>
        <button class="ghost small" onClick={onToggle}>{open ? 'Done' : 'Edit'}</button>
        <label class="switch"><input type="checkbox" checked={on} onChange={(e) => { const v = (e.target as HTMLInputElement).checked; setMods(v ? (own ? both : ['bible-typing']) : both, { enabled: v }); }} /><span>{on ? 'On' : 'Off'}</span></label>
      </div>
      {open && (
        <div class="quest-body">
          <p class="muted">Type a passage start to finish. Only the right key goes in, and there's no clock. Longer passages pay more.</p>
          <div class="row">
            <label class="check"><input type="checkbox" checked={bible.enabled} onChange={(e) => setMods(['bible-typing'], { enabled: (e.target as HTMLInputElement).checked })} /> 📖 Scripture (King James Bible)</label>
            <label class="check"><input type="checkbox" checked={mine.enabled} onChange={(e) => setMods(['my-passages'], { enabled: (e.target as HTMLInputElement).checked })} /> 📝 Your own passages</label>
          </div>
          <div class="row">
            <label title="Rounded to the nearest: with 20, a 9-word passage pays nothing, 10–29 words pay 1 coin, 30–49 pay 2.">Pay<span class="per-words">1 🪙 per <input type="number" min={1} max={500} value={bible.options?.wordsPer ?? '20'} onChange={(e) => setMods(both, { options: { wordsPer: String(Math.max(1, Math.min(500, Math.round(Number((e.target as HTMLInputElement).value) || 20)))) } })} /> words</span></label>
            <label title="After that, typing it again is practice without coins.">Each passage pays<select value={bible.options?.repeatsPerDay ?? '1'} onChange={(e) => setMods(both, { options: { repeatsPerDay: (e.target as HTMLSelectElement).value } })}>
              {[['ever', 'Only the first time'], ['1', 'Once a day'], ['2', 'Twice a day'], ['3', '3 times a day'], ['0', 'Every time']].map(([v, l]) => <option value={v}>{l}</option>)}
            </select></label>
            <label title="0 = no limit. Scripture and your own passages share this limit.">Most per day (0 = no limit)<input type="number" min={0} value={bible.dailyCap} onChange={(e) => setMods(both, { dailyCap: Number((e.target as HTMLInputElement).value) })} /></label>
            <label class="check"><input type="checkbox" checked={bible.requireApproval} onChange={(e) => setMods(both, { requireApproval: (e.target as HTMLInputElement).checked })} /> Ask me before paying</label>
          </div>
          <h4>Your own passages</h4>
          <PassageEditor s={mine} set={(p) => setMods(['my-passages'], p)} />
        </div>
      )}
    </div>
  );
}

/** What the child did on a day or in a week: time, coins, typing, things finished, and the coin history. Same look as the phone. */
function ActivityPanel({ child }: { child: Child }) {
  const now = new Date();
  const [mode, setMode] = useState<'day' | 'week'>('day');
  const [sel, setSel] = useState(rep.dayKey(now));
  const [cal, setCal] = useState(false);
  const [month, setMonth] = useState(new Date(now.getFullYear(), now.getMonth(), 1));
  const [byDay, setByDay] = useState<Record<string, rep.DayReport>>({});
  const [err, setErr] = useState('');
  const [reading, setReading] = useState(false);
  // Load the weeks around what's on screen (the calendar's month, or the selected day).
  const anchor = cal ? month : rep.parseDay(sel);
  const loadKey = `${anchor.getFullYear()}-${anchor.getMonth()}`;
  useEffect(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 6);
    bridge.parentActivity(child.id, rep.dayKey(rep.weekStart(first)), rep.dayKey(last > new Date() ? new Date() : last))
      .then((r) => { setErr(''); setByDay((p) => ({ ...p, ...Object.fromEntries(r.days.map((d) => [d.day, d])) })); })
      .catch((e) => setErr((e as Error).message));
  }, [child.id, loadKey]);
  // Refresh today now and then while the page is open.
  useEffect(() => {
    const t = setInterval(() => { const k = rep.dayKey(new Date()); bridge.parentActivity(child.id, k, k).then((r) => setByDay((p) => ({ ...p, ...Object.fromEntries(r.days.map((d) => [d.day, d])) }))).catch(() => undefined); }, 60000);
    return () => clearInterval(t);
  }, [child.id]);
  const days = rep.rangeOf(sel, mode);
  const html = rep.navHtml(sel, mode, cal)
    + (cal ? rep.calendarHtml(month, byDay, sel, mode) : '')
    + rep.reportHtml(days.map((d) => byDay[d]).filter(Boolean) as rep.DayReport[], { readingLink: true });
  function click(e: MouseEvent) {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.calDay) { setSel(b.dataset.calDay); setCal(false); }
    else if (b.dataset.calMonth) setMonth(new Date(month.getFullYear(), month.getMonth() + Number(b.dataset.calMonth), 1));
    else if (b.dataset.repStep) setSel(rep.step(sel, mode, Number(b.dataset.repStep)));
    else if (b.dataset.repCal !== undefined) { const d = rep.parseDay(sel); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); setCal(!cal); }
    else if (b.dataset.repMode) setMode(b.dataset.repMode as 'day' | 'week');
    else if (b.dataset.repReading !== undefined) setReading(true);
  }
  if (reading) return <div class="card activity"><ReadingAnalysis childId={child.id} kid={child.displayName} onBack={() => setReading(false)} /></div>;
  return (
    <div class="card activity">
      <style dangerouslySetInnerHTML={{ __html: rep.REPORT_CSS }} />
      {err && <p class="error">{err}</p>}
      <div onClick={click} dangerouslySetInnerHTML={{ __html: html }} />
      {child.activityReports === false && <p class="muted small">Activity reports are off for {child.displayName} (Settings), so only coins show.</p>}
    </div>
  );
}

/** The family's own typing passages: paste text in, it's cleaned to keyboard characters, and it's ready to type. */
function PassageEditor({ s, set }: { s: Child['modules'][string]; set: (p: Partial<Child['modules'][string]>) => void }) {
  const list = familyPassages(s);
  const [title, setTitle] = useState('');
  const [raw, setRaw] = useState('');
  const clean = keyboardText(raw);
  const name = title.trim().replace(/\s+/g, ' ').slice(0, 60);
  const clash = list.some((p) => p.title.toLowerCase() === name.toLowerCase());
  const save = (next: FamilyPassage[], extra: Partial<Child['modules'][string]> = {}) =>
    set({ ...extra, options: { wordsPer: '20', repeatsPerDay: '1', ...(s.options ?? {}), passages: JSON.stringify(next) } });
  function add() {
    if (!name || !clean.text || clash) return;
    // The first passage turns the quest on, so it shows up for the child straight away.
    save([...list, { id: Date.now().toString(36), title: name, text: clean.text.slice(0, 3000) }], list.length === 0 ? { enabled: true } : {});
    setTitle(''); setRaw('');
  }
  return (
    <div class="passage-editor">
      {list.length > 0 && (
        <ul class="passage-rows">
          {list.map((p) => (
            <li>
              <div><b>{p.title}</b><small class="muted"> · {wordCount(p.text)} words</small><p class="muted small clip">{p.text}</p></div>
              <button class="ghost small" onClick={() => save(list.filter((x) => x !== p))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div class="passage-add">
        <label>Title<input type="text" maxLength={60} placeholder="e.g. The Road Not Taken" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} /></label>
        <label>Passage<textarea rows={4} placeholder="Paste or type the passage here" value={raw} onInput={(e) => setRaw((e.target as HTMLTextAreaElement).value)} /></label>
        {raw && (clean.swapped.length > 0 || clean.removed.length > 0) && (
          <p class="muted small">
            {clean.swapped.length > 0 && <>Changed to keyboard characters: {clean.swapped.map((c) => <code>{c}</code>)}. </>}
            {clean.removed.length > 0 && <>Removed (not on a keyboard): {clean.removed.map((c) => <code>{c}</code>)}.</>}
          </p>
        )}
        {clash && <p class="error small">There's already a passage called “{name}”.</p>}
        <div class="row between">
          <small class="muted">{clean.text ? `${wordCount(clean.text)} words` : ''}{clean.text.length > 3000 ? ' · only the first 3,000 characters are kept' : ''}</small>
          <button class="primary small" disabled={!name || !clean.text || clash} onClick={add}>Add passage</button>
        </div>
      </div>
    </div>
  );
}

/** Bring the family's own Read, Write & Type! disc image into CoinQuest, once. */
type ModSettings = Child['modules'][string];
function DiscImport({ rwt }: { rwt: { s: ModSettings; set: (p: Partial<ModSettings>) => void } }) {
  const [st, setSt] = useState<DiscStatus | null>(null);
  const [rw, setRw] = useState<RwtStatus | null>(null);
  const loadRw = () => bridge.parentRwtStatus().then(setRw).catch(() => {});
  useEffect(() => { loadRw(); }, [st?.stage]);
  useEffect(() => { if (rw?.stage === 'importing') { const t = setTimeout(loadRw, 1500); return () => clearTimeout(t); } }, [rw]);
  async function rwtPick() {
    setErr('');
    try {
      const r = await bridge.pickFile('Choose your Read, Write & Type! disc image', 'Disc image (*.iso, *.zip)|*.iso;*.zip|All files|*.*');
      if (r.path) setRw(await bridge.parentRwtImport(r.path));
    } catch (e) { setErr((e as Error).message); }
  }
  async function rwtTry() { setErr(''); try { await bridge.playRwt(); } catch (e) { setErr((e as Error).message); } }
  async function setCoins(id: string, v: string) {
    setErr('');
    try { setSt(await bridge.parentDiscCoins(id, v.trim() === '' ? null : Math.round(Number(v) || 0))); } catch (e) { setErr((e as Error).message); }
  }
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
  async function tryIt(id: string) { setErr(''); try { const r = await bridge.playDisc(id); setSetupMsg(r.drive ? `Started — its disc is in drive ${r.drive}.` : 'Started.'); } catch (e) { setErr((e as Error).message); } }
  const [setup, setSetup] = useState<{ id: string; title: string; drive: string; installer: string } | null>(null);
  const [setupMsg, setSetupMsg] = useState('');
  // While an installer runs, CoinQuest finishes by itself once it closes — watch for that.
  useEffect(() => {
    if (!setup) return;
    const t = setInterval(async () => {
      try {
        const s = await bridge.parentDiscStatus();
        const g = s.games.find((x) => x.id === setup.id);
        if (g?.mode === 'installed') { clearInterval(t); setSetup(null); setSt(s); setSetupMsg(`✅ ${g.title} is installed${g.runs ? ` (${g.runs})` : ''}. Press "Try it" to check it runs.`); }
      } catch { /* keep waiting */ }
    }, 5000);
    return () => clearInterval(t);
  }, [setup]);
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
  async function chooseProgram(id: string, title: string, runs?: string | null) {
    setErr('');
    const dir = runs ? runs.replace(/\\[^\\]*$/, '') : 'C:\\Program Files (x86)';
    const p = await bridge.pickFile(`Choose the program that starts ${title} (the game itself, not an installer or launcher)`, 'Programs (*.exe)|*.exe', dir);
    if (!p.path) return;
    try { const r = await bridge.parentDiscSetupFinish(id, undefined, p.path); setSetup(null); setSetupMsg(`✅ ${r.title} will start ${r.exe}. Press "Try it" to check it runs.`); load(); }
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
      <ul class="disc-games">
        {rw && (
          <li class={rwt.s.enabled ? '' : 'off'}>
            <div class="row between" style="gap:.6em;align-items:center">
              <div style="flex:1;min-width:0">
                <b>Read, Write &amp; Type!</b>
                {rw.stage === 'importing' ? <span class="muted small"> — ⏳ {rw.message ?? 'importing…'}</span>
                  : !rw.installed ? <span class="muted small"> — not added yet (include its disc in an import, or choose it below)</span>
                  : <span class="muted small"> — {rw.players.length ? rw.players.join(', ') : 'no players yet (progress is saved for a signed-in player)'}</span>}
                <div class="row" style="gap:.4em;margin-top:.3em;flex-wrap:wrap;align-items:center">
                  {rw.installed ? <button class="ghost small" onClick={rwtTry}>Try it</button> : null}
                  <button class="ghost small" onClick={rwtPick}>{rw.installed ? 'Import again…' : 'Import its disc…'}</button>
                  <label class="small inline-num">🪙 per finished activity<input type="number" value={rwt.s.coinsPerActivity} onChange={(e) => rwt.set({ coinsPerActivity: Number((e.target as HTMLInputElement).value) })} /></label>
                  <label class="small inline-num">daily limit<input type="number" min={0} value={rwt.s.dailyCap} onChange={(e) => rwt.set({ dailyCap: Number((e.target as HTMLInputElement).value) })} /></label>
                  <label class="check small"><input type="checkbox" checked={rwt.s.requireApproval} onChange={(e) => rwt.set({ requireApproval: (e.target as HTMLInputElement).checked })} /> Needs my OK</label>
                </div>
                {rw.patches.some((p) => p.includes('NOT APPLIED')) && <p class="error small">This copy is a different version than expected: {rw.patches.filter((p) => p.includes('NOT')).join('; ')}</p>}
              </div>
              <label class="switch" title={rwt.s.enabled ? 'Shown to the kids' : 'Hidden from the kids'}><input type="checkbox" checked={rwt.s.enabled} onChange={(e) => rwt.set({ enabled: (e.target as HTMLInputElement).checked })} /><span>{rwt.s.enabled ? 'On' : 'Off'}</span></label>
            </div>
          </li>
        )}
        {st.games.map((g) => (
        <li class={g.hidden ? 'off' : ''}>
          <div class="row between" style="gap:.6em;align-items:center">
            <div style="flex:1;min-width:0">
              <b>{g.title}</b>
              {g.mode === 'pending' ? <span class="muted small"> — not installed yet</span>
                : g.players.length > 0 ? <span class="muted small"> — {g.players.map((p) => `${p.name} (level ${p.level}, score ${p.score})`).join(', ')}</span>
                : <span class="muted small"> — no players yet</span>}
              {g.runs && <div class="muted small" style="overflow-wrap:anywhere">Runs: {g.runs}</div>}
              <div class="row" style="gap:.4em;margin-top:.3em;flex-wrap:wrap">
                {g.mode === 'pending'
                  ? <><button class="secondary small" onClick={() => beginSetup(g.id)}>Set up (run its installer)</button>
                      <button class="ghost small" onClick={() => alreadyInstalled(g.id, g.title)}>Already installed? Choose its folder…</button></>
                  : <><button class="ghost small" onClick={() => tryIt(g.id)}>Try it</button>
                      {g.mode === 'copy' && <button class="ghost small" title="If it crashes or misbehaves: re-import it and run the disc's own installer instead" onClick={() => viaInstaller(g.title)}>Problems? Use its installer…</button>}
                      {g.mode === 'installed' && <button class="ghost small" title="If it starts the wrong thing (an installer or launcher): pick the game's own program" onClick={() => chooseProgram(g.id, g.title, g.runs)}>Wrong program? Choose it…</button>}</>}
                {removing === g.id
                  ? <><button class="danger small" onClick={() => remove(g.id)}>Yes, remove {g.title}</button><button class="ghost small" onClick={() => setRemoving(null)}>Keep it</button></>
                  : <button class="ghost small" title="Delete CoinQuest's copy of this game and its disc image" onClick={() => setRemoving(g.id)}>🗑 Remove</button>}
                {g.mode !== 'pending' && <label class="small inline-num" title="Coins for each level-up or saved progress in this game (blank: the Classic CD games setting below)">🪙 per progress<input type="number" placeholder="default" value={g.coins ?? ''} onChange={(e) => setCoins(g.id, (e.target as HTMLInputElement).value)} /></label>}
              </div>
              {removing === g.id && <p class="muted small">Players' progress in this game is deleted too.{g.mode === 'installed' ? ' The installed program stays on the PC — uninstall it from Windows Settings → Apps if you want it gone completely.' : ''}</p>}
            </div>
            {g.mode !== 'pending' && <label class="switch" title={g.hidden ? 'Hidden from the kids' : 'Shown to the kids'}><input type="checkbox" checked={!g.hidden} onChange={(e) => hide(g.id, !(e.target as HTMLInputElement).checked)} /><span>{g.hidden ? 'Off' : 'On'}</span></label>}
          </div>
        </li>))}
      </ul>
      {setup && (
        <div class="card nudge" style="text-align:left">
          <b>Installing {setup.title}</b>
          <ol class="small">
            <li>The disc is in the virtual drive <b>{setup.drive}</b> and its installer has opened (Windows may ask for permission first).</li>
            <li>Click through it with the normal choices. If it offers extras (Acrobat Reader, AOL, registration, DirectX), you can skip them.</li>
            <li>When it's finished (don't start the game from it), CoinQuest notices by itself within a minute. If it doesn't, press "Done installing":</li>
          </ol>
          <div class="row" style="gap:.5em"><button class="primary" onClick={() => finishSetup()}>Done installing</button><button class="ghost small" onClick={() => finishSetup(true)}>Choose its folder…</button><button class="ghost small" onClick={() => bridge.runSetup(setup.installer)}>Open the installer again</button><button class="ghost small" onClick={() => setSetup(null)}>Cancel</button></div>
        </div>
      )}
      {setupMsg && <p class="muted small">{setupMsg}</p>}
      {st.stage === 'importing' ? <p>⏳ {st.message ?? 'Importing…'}</p>
        : <>
            <p class="small">Add your discs: choose one image (<code>.zip</code>, <code>.iso</code>, <code>.img</code> or <code>.bin</code>), a whole folder of them, or paste a Dropbox link to a file or folder. ClueFinders and similar Learning Company titles, and Read, Write &amp; Type!, are set up automatically. Any other disc is kept as a virtual CD: press <b>Set up</b> once to run its own installer (CoinQuest notices when it's done), and Play puts the disc in the virtual drive each time.</p>
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

/**
 * How CoinQuest sits on this PC, in one picture: the kid's account is locked; the parent's account (and every other)
 * stays normal, and that's where the Parent Console is. So other accounts need passwords the kid doesn't know.
 */
export function PcMap({ kids }: { kids: string[] }) {
  const who = kids.length ? kids.join(' and ') : 'Your child';
  const whose = kids.length === 1 ? `${kids[0]}'s account` : kids.length ? `${who}'s accounts` : "Your child's account";
  return (
    <div class="pc-map">
      <div class="pc-side locked">
        <span class="pc-ico" aria-hidden="true">🔒</span>
        <b>{whose}</b>
        <p>Only what you allow: CoinQuest, and the websites, apps and rewards you pick. Everything else is locked.</p>
      </div>
      <div class="pc-side open">
        <span class="pc-ico" aria-hidden="true">🔓</span>
        <b>Your account, and every other one</b>
        <p>Normal: full internet, nothing locked. <b>The Parent Console lives here</b>: Start menu or desktop → <i>CoinQuest Parent Console</i>.</p>
      </div>
      <p class="pc-note">So keep a password on your account (and any other) that {kids.length === 1 ? `${kids[0]} doesn't` : kids.length ? "your kids don't" : "your child doesn't"} know. At {kids.length === 1 ? `${kids[0]}'s` : "a kid's"} account, Ctrl+Shift+P and your PIN open the Parent Console too.</p>
    </div>
  );
}

/**
 * Getting started: a short checklist that proves CoinQuest is working, checked live on this PC. Shown at the end of
 * setup and on Today until everything is done (or the parent hides it). Phone linking is optional.
 */
export function GettingStarted({ state, inSetup }: { state: ParentState; inSetup?: boolean }) {
  const [hidden, setHidden] = useState(() => { try { return !inSetup && localStorage.getItem('cq.parent.gsHidden') === '1'; } catch { return false; } });
  const [showCode, setShowCode] = useState(false);
  const kids = state.household.children;
  const names = kids.map((k) => k.displayName).join(' and ') || 'your child';
  const net = state.enforcement?.internetLock;
  const lockOn = !!net?.applied && !net.error;
  const tried = kids.filter((k) => state.gettingStarted?.used?.[k.id]);
  const notTried = kids.filter((k) => !state.gettingStarted?.used?.[k.id]);
  const phone = (state.gettingStarted?.phones ?? 0) > 0;
  const open = state.gettingStarted?.openAccounts ?? [];
  const done = kids.length > 0 && lockOn && notTried.length === 0 && phone && open.length === 0;
  if (hidden || (done && !inSetup)) return null;
  const item = (ok: boolean, title: preact.ComponentChildren, detail?: preact.ComponentChildren, optional?: boolean) => (
    <li class={ok ? 'ok' : optional ? 'opt' : 'todo'}><span class="gs-mark" aria-label={ok ? 'done' : 'to do'}>{ok ? '✓' : ''}</span><div><b>{title}</b>{detail && <p class="muted small">{detail}</p>}</div></li>
  );
  return (
    <div class={'card getting-started' + (inSetup ? ' in-setup' : '')}>
      {!inSetup && <div class="row between"><h3>Getting started</h3><button class="ghost small" onClick={() => { setHidden(true); try { localStorage.setItem('cq.parent.gsHidden', '1'); } catch { /* fine */ } }}>Hide</button></div>}
      <PcMap kids={kids.map((k) => k.displayName)} />
      <ul class="gs-list">
        {item(kids.length > 0, kids.length ? `${names} ${kids.length === 1 ? 'is' : 'are'} set up` : 'Add your child', kids.length ? 'Each kid has their own Windows sign-in, coins and rules.' : 'Use ＋ Add a kid above.')}
        {item(lockOn, lockOn ? 'Internet lock is on' : 'Internet lock is off', lockOn ? `${names} can only reach what you allow. Your own account isn't affected.` : `It couldn't be turned on (${net?.error ?? 'not yet'}). Restarting the computer usually fixes it.`)}
        {item(notTried.length === 0 && kids.length > 0, notTried.length ? `Try it: sign in to Windows as ${notTried.map((k) => k.displayName).join(' or ')}` : `${tried.map((k) => k.displayName).join(' and ')} ${tried.length === 1 ? 'has' : 'have'} used CoinQuest`,
          notTried.length ? <>Sign out of your account, then pick {notTried[0].displayName} on the sign-in screen: CoinQuest opens by itself. A new account takes a minute the first time. Sign back in as you to come back here; this ticks itself off.</> : undefined)}
        {item(open.length === 0, open.length ? `${open.join(', ')} ${open.length === 1 ? 'has' : 'have'} no password` : 'Other accounts have passwords',
          open.length ? <>{kids[0]?.displayName ?? 'Your child'} could sign in there and skip every rule. Add a password: sign in to that account, then Windows Settings → Accounts → Sign-in options → Password. This ticks itself off.</> : 'Nobody can just sign in to an unlocked account.')}
        {item(phone, phone ? 'Your phone is linked' : 'Link your phone (optional)',
          phone ? 'Coins, requests and reports from anywhere.' : <>See coins, answer requests and read reports from anywhere. <button class="link-btn" onClick={() => setShowCode(!showCode)}>{showCode ? 'Hide the code' : 'Show the code'}</button></>, true)}
      </ul>
      {showCode && !phone && <PhoneControl compact />}
    </div>
  );
}

/** "Control from my phone": a QR code a parent scans once; then coins and requests from their phone, anywhere. */
function PhoneControl({ compact }: { compact?: boolean } = {}) {
  const [st, setSt] = useState<PhoneLinks | null>(null);
  const [name, setName] = useState('');
  const [qr, setQr] = useState<{ name: string; svg: string } | null>(null);
  const [err, setErr] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const load = () => bridge.parentPhoneLinks().then(setSt).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  // While the code is showing, watch for the phone's first visit so the card can say it worked.
  useEffect(() => { if (!qr) return; const t = setInterval(load, 4000); return () => clearInterval(t); }, [qr]);
  async function link() {
    setErr('');
    try {
      const r = await bridge.parentPhoneLink(name.trim() || 'Phone');
      const q = qrcode(0, 'M'); q.addData(r.url); q.make();
      setQr({ name: r.name, svg: q.createSvgTag({ cellSize: 5, margin: 2, scalable: true }) });
      setName(''); load();
    } catch (e) { setErr((e as Error).message); }
  }
  async function unlink(id: string) { setErr(''); try { setSt(await bridge.parentPhoneUnlink(id)); setRemoving(null); } catch (e) { setErr((e as Error).message); } }
  const linkedNow = qr && st?.phones.find((p) => p.name === qr.name && p.lastSeen);
  return (
    <div class={compact ? 'phone-control compact' : 'card phone-control'}>
      {!compact && <h3>📱 Control from my phone</h3>}
      {qr ? (
        <div class="qr-box">
          {linkedNow
            ? <p>✅ <b>{qr.name}</b> is linked. You can close this.</p>
            : <p>Point your phone's camera at this code, then tap the link that appears. Add the page to your home screen so it opens like an app.</p>}
          <div class="qr" dangerouslySetInnerHTML={{ __html: qr.svg }} />
          <p class="muted small">Anyone with this code can give or take coins, so don't share a photo of it.</p>
          {!compact && <button class="secondary" onClick={() => { setQr(null); load(); }}>Done</button>}
        </div>
      ) : (
        <>
          {!compact && <p class="muted">See coins, give or take them, answer requests, and end game time from your phone, anywhere. No account or password: the code is the key. A linked phone can't add kids or Windows accounts; only this console can.</p>}
          <div class="row"><input placeholder="Whose phone? (e.g. Mom)" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} maxLength={30} /><button class="primary" onClick={link}>Show the code</button></div>
        </>
      )}
      {!compact && st && st.phones.length > 0 && (
        <ul class="phones">
          {st.phones.map((p) => (
            <li>
              <span><b>{p.name}</b> <span class="muted small">{p.lastSeen ? `last used ${when(p.lastSeen)}` : 'not used yet'}</span></span>
              {removing === p.id
                ? <span><button class="danger small" onClick={() => unlink(p.id)}>Yes, remove</button> <button class="ghost small" onClick={() => setRemoving(null)}>Keep</button></span>
                : <button class="ghost small" onClick={() => setRemoving(p.id)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {!compact && st && st.phones.length > 0 && <p class="muted small">Connection: {st.status}</p>}
      {err && <p class="error small">{err}</p>}
    </div>
  );
}

/**
 * Lock a kid's whole profile (nothing opens, no internet) now or on a schedule — e.g. "4–5 pm is Ava's turn".
 * Tucked away as one small lock button at the end of the kid row; the kid can ask to open it from their lock screen.
 */
function LockControl({ child, lock, onChange }: { child: Child; lock?: LockSummary; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LockTime | null>(null);
  const [err, setErr] = useState('');
  const name = child.displayName;
  const schedule = lock?.schedule ?? [];
  const run = (change: Parameters<typeof bridge.parentLock>[1]) => { setErr(''); return bridge.parentLock(child.id, change).then(onChange).catch((e) => setErr((e as Error).message)); };
  const saveTime = () => { if (!editing) return; const t = editing; if (!t.days.length || !t.from || !t.to || t.from === t.to) { setErr('Pick at least one day and two different times.'); return; } run({ schedule: [...schedule, t] }).then(() => setEditing(null)); };
  return (
    <div class="lock-ctl">
      <button class={'lock-btn' + (lock?.locked ? ' on' : '') + (schedule.length ? ' sched' : '')} title={lock?.locked ? `${name} is locked` : `Lock ${name}`} aria-label={`Lock ${name}`} aria-expanded={open} onClick={() => setOpen(!open)}>🔒</button>
      {open && <>
        <div class="lock-back" onClick={() => { setOpen(false); setEditing(null); }} />
        <div class="lock-pop card" role="dialog" aria-label={`Lock ${name}`}>
          {lock?.locked ? (
            <div class="row between"><span>🔒 <b>{name}</b> is locked{lock.until ? <> until <b>{untilText(lock.until)}</b></> : ''}</span><button class="primary small" onClick={() => run({ action: 'open' })}>Open now</button></div>
          ) : (
            <div class="lock-now">
              <span>Lock <b>{name}</b> now</span>
              <div class="chips">
                {[[30, '30 min'], [60, '1 hr'], [120, '2 hr']].map(([m, l]) => <button class="chip" onClick={() => run({ action: 'lock', minutes: m as number })}>{l}</button>)}
                <button class="chip" onClick={() => run({ action: 'lock', minutes: null })}>Until I open it</button>
              </div>
            </div>
          )}
          <div class="lock-sched">
            <small class="muted">Every week</small>
            {schedule.map((t, i) => (
              <div class="lock-time"><span>{daysText(t.days)} · {timeText(t.from)}–{timeText(t.to)}</span><button class="ghost small" aria-label="Remove" onClick={() => run({ schedule: schedule.filter((_, j) => j !== i) })}>✕</button></div>
            ))}
            {editing ? (
              <div class="lock-edit">
                <div class="days">{DAY_LETTERS.map((d, i) => <button class={'day' + (editing.days.includes(i) ? ' on' : '')} aria-label={DAY_NAMES[i]} aria-pressed={editing.days.includes(i)} onClick={() => setEditing({ ...editing, days: editing.days.includes(i) ? editing.days.filter((x) => x !== i) : [...editing.days, i].sort() })}>{d}</button>)}</div>
                <div class="row nowrap"><input type="time" value={editing.from} onInput={(e) => setEditing({ ...editing, from: (e.target as HTMLInputElement).value })} /><span class="muted">to</span><input type="time" value={editing.to} onInput={(e) => setEditing({ ...editing, to: (e.target as HTMLInputElement).value })} /></div>
                <div class="row"><button class="primary small" onClick={saveTime}>Add</button><button class="ghost small" onClick={() => setEditing(null)}>Cancel</button></div>
              </div>
            ) : <button class="link small" onClick={() => setEditing({ days: [1, 2, 3, 4, 5], from: '16:00', to: '17:00' })}>＋ Add a time</button>}
          </div>
          {err && <p class="error small">{err}</p>}
          <p class="muted small">While locked, nothing opens and there's no internet. {name} can ask you to open it.</p>
        </div>
      </>}
    </div>
  );
}

/** "Remove {kid}": a clear warning, typing their name to confirm, and an opt-in to delete their Windows account too. */
function RemoveKid({ child, only, onDone }: { child: Child; only: boolean; onDone: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [alsoAccount, setAlsoAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const name = child.displayName;
  const account = child.windowsAccount?.replace(/^.*\\/, '') ?? '';
  if (!open) return (
    <div class="danger-zone">
      {!only && <button class="danger-ghost" onClick={() => setOpen(true)}>Remove {name}…</button>}
      {only && <p class="muted small">{name} is the only kid here. To take CoinQuest off this PC entirely, uninstall it from Windows Settings → Apps.</p>}
    </div>
  );
  async function go() {
    setBusy(true); setErr('');
    try {
      const r = await bridge.parentRemoveChild(child.id, alsoAccount);
      onDone(r.accountError ? `${name} was removed from CoinQuest, but their Windows account wasn't deleted: ${r.accountError}` : `${name} was removed${r.accountDeleted ? ', along with their Windows account' : ''}.`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <div class="danger-zone">
      <div class="remove-kid" role="alertdialog" aria-label={`Remove ${name}`}>
        <b>⚠️ Remove {name} from CoinQuest?</b>
        <ul>
          <li>Their coins, quest progress, books, reading history and activity reports are <b>deleted for good</b>.</li>
          <li>Their Windows account{account ? <> (<b>{account}</b>)</> : null} is no longer locked: it gets the full internet and opens normally, without CoinQuest.</li>
          <li>Linked phones stop showing {name} after they refresh.</li>
        </ul>
        <label class="check"><input type="checkbox" checked={alsoAccount} onChange={(e) => setAlsoAccount((e.target as HTMLInputElement).checked)} />
          <span>Also delete their Windows account{account ? ` “${account}”` : ''}. <span class="muted small">Their files in {'C:\\Users\\' + (account || 'name')} stay on the PC until you delete them. They need to be signed out.</span></span></label>
        <label class="confirm-label"><span>Type <b>{name}</b> to confirm</span><input type="text" value={typed} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} autoComplete="off" /></label>
        {err && <p class="error small">{err}</p>}
        <div class="row">
          <button class="danger" disabled={busy || only || typed.trim().toLowerCase() !== name.trim().toLowerCase()} onClick={go}>{busy ? 'Removing…' : `Remove ${name}`}</button>
          <button class="ghost" onClick={() => { setOpen(false); setTyped(''); setAlsoAccount(false); setErr(''); }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function Settings({ state, child, onSave, onChange }: { state: ParentState; child: Child; onSave: (c: Child) => void; onChange: () => void }) {
  const [pin, setPin] = useState(''); const [pinMsg, setPinMsg] = useState('');
  const [removed, setRemoved] = useState('');
  const [upd, setUpd] = useState(state.updateStatus);
  const u = upd;
  return (
    <div class="settings">
      <div class="settings-cols">
        <div class="settings-col">
      {removed && <p class="notice-done">✓ {removed}</p>}
      <div class="card">
        <h3>Child</h3>
        <label>Name<input value={child.displayName} onChange={(e) => onSave({ ...child, displayName: (e.target as HTMLInputElement).value })} /></label>
        <label class="check"><input type="checkbox" checked={child.activityReports !== false} onChange={(e) => onSave({ ...child, activityReports: (e.target as HTMLInputElement).checked })} /> Keep activity reports (time on each quest, site, channel and app; typing; what was finished)</label>
        <RemoveKid key={child.id} child={child} only={state.household.children.length <= 1} onDone={(m) => { setRemoved(m); onChange(); }} />
      </div>
      <div class="card">
        <h3>Parent PIN</h3>
        <div class="row nowrap"><input class="grow" type="password" inputMode="numeric" placeholder="New PIN (4–8 digits)" value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value)} /><button class="primary" disabled={!/^\d{4,8}$/.test(pin)} onClick={() => bridge.parentSetPin(pin).then(() => { setPin(''); setPinMsg('PIN changed.'); }).catch((e) => setPinMsg(e.message))}>Change</button></div>
        {pinMsg && <p class="muted">{pinMsg}</p>}
      </div>
        </div>
        <div class="settings-col">
      <PhoneControl />
      <div class="card">
        <h3>Updates</h3>
        <p>Version <b>{u.current}</b> — {u.state === 'upToDate' ? 'up to date' : u.state === 'readyToApply' ? `version ${u.latest} is downloaded and installs when ${child.displayName} signs out or next opens CoinQuest` : u.state === 'installing' || u.state === 'applying' ? `installing ${u.latest ? 'version ' + u.latest : 'an update'}… CoinQuest restarts by itself` : u.state === 'downloading' ? `downloading ${u.latest}…` : u.state === 'error' ? `couldn't check (${u.message})` : u.state === 'idle' ? 'not checked yet' : u.state}</p>
        {u.lastChecked && <p class="muted small">Last checked {when(u.lastChecked)}</p>}
        <button class="secondary" onClick={() => bridge.parentCheckUpdate().then(setUpd).catch((e) => setUpd({ ...u, state: 'error', message: e.message }))}>Check now</button>
      </div>
        </div>
      </div>
      <details class="card advanced">
        <summary><b>Advanced</b> <span class="muted small">— troubleshooting, recent problems, blocked addresses</span></summary>
        <p class="muted small">Windows account: <code>{child.windowsAccount}</code>. How strong is the lock? A young child can't get around it. A determined teenager with the PC in hand could start it from a USB stick or reinstall Windows; turning on BitLocker and a BIOS password closes that.</p>
        <Troubleshooting />
        <RecentlyBlocked sites={child.allowlist.sites} onAllow={(h) => onSave({ ...child, allowlist: { ...child.allowlist, sites: [...new Set([...child.allowlist.sites, h])] } })} />
      </details>
    </div>
  );
}
