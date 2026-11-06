import { useEffect, useState } from 'preact/hooks';
import { KID_COLORS } from '../core/types';

export interface WinAccount { name: string; fullName: string; isAdmin: boolean; disabled: boolean; sid: string; usedBy?: string | null }

/** "Sam Smith" → "sam" (a Windows sign-in name: letters and digits, 20 at most). */
const signInName = (display: string) => display.trim().split(/\s+/)[0]?.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 20) ?? '';

/**
 * Who the child is on Windows: a new Standard account made for them (the usual case), or one that's already on this PC.
 * Used by the first-run setup and by "Add a kid". `create` makes the account (setup or parent call) and returns its
 * name; `onPicked` gets the child's name and Windows account. `allowAdmin`: setup may convert an existing
 * administrator account (with a warning); adding a kid later never touches an administrator.
 */
export function KidAccount({ accounts, create, onPicked, allowAdmin = false, action = 'Next', taken = [] }: {
  accounts: WinAccount[] | null;
  create: (userName: string, fullName: string, password: string) => Promise<{ account: string }>;
  onPicked: (kid: { displayName: string; account: string; color: string }) => Promise<void> | void;
  allowAdmin?: boolean;
  action?: string;
  /** Colors other kids already have (the first free one is preselected). */
  taken?: string[];
}) {
  const free = (accounts ?? []).filter((a) => !a.usedBy && !a.disabled && (allowAdmin || !a.isAdmin));
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState('');
  const [user, setUser] = useState(''); const [userEdited, setUserEdited] = useState(false);
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [picked, setPicked] = useState('');
  const [color, setColor] = useState(() => KID_COLORS.find((c) => !taken.includes(c)) ?? KID_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // An account that's already here and not used by another kid? Offer it first.
  useEffect(() => { if (accounts && free.some((a) => !a.isAdmin)) setMode('existing'); }, [accounts === null]);
  useEffect(() => { if (!userEdited) setUser(signInName(name)); }, [name]);

  const ready = name.trim().length > 0 && (mode === 'existing' ? !!picked : /^[A-Za-z0-9 ._-]{1,20}$/.test(user.trim()) && pw === pw2);
  async function go() {
    setBusy(true); setErr('');
    try {
      const account = mode === 'existing' ? picked : (await create(user.trim(), name.trim(), pw)).account;
      await onPicked({ displayName: name.trim(), account, color });
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  return (
    <div class="kid-account">
      <label>Child's name<input value={name} placeholder="Sam" onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
      <div class="kid-colors" role="radiogroup" aria-label="Their color">
        <span class="muted small">Their color</span>
        {KID_COLORS.map((c) => <button role="radio" aria-checked={c === color} aria-label={c} class={'swatch' + (c === color ? ' on' : '')} style={{ background: c }} onClick={() => setColor(c)} />)}
      </div>
      <div class="seg kid-mode" role="tablist">
        <button role="tab" class={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>New Windows account</button>
        <button role="tab" class={mode === 'existing' ? 'on' : ''} onClick={() => setMode('existing')}>Account already on this PC</button>
      </div>
      {mode === 'new' ? (
        <div class="kid-new">
          <p class="muted small">CoinQuest makes a Standard account for {name.trim() || 'them'} on this PC. It appears on the Windows sign-in screen; the first sign-in takes a minute while Windows sets it up.</p>
          <label>Sign-in name<input value={user} maxLength={20} onInput={(e) => { setUser((e.target as HTMLInputElement).value); setUserEdited(true); }} /></label>
          <div class="row">
            <label>Password (optional)<input type="password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} /></label>
            <label>Again<input type="password" value={pw2} onInput={(e) => setPw2((e.target as HTMLInputElement).value)} /></label>
          </div>
          {pw !== pw2 && pw2 && <p class="error small">Those don't match.</p>}
          {!pw && <p class="muted small">No password: {name.trim() || 'they'} can sign in with one click.</p>}
        </div>
      ) : (
        <div class="account-list">
          {accounts === null && <p class="muted">Looking…</p>}
          {accounts && free.length === 0 && <p class="muted">No free accounts here. Make a new one instead.</p>}
          {free.map((a) => (
            <button class={'account' + (picked === a.name ? ' picked' : '') + (a.isAdmin ? ' admin' : '')} onClick={() => { setPicked(a.name); if (!name) setName(a.fullName || a.name); }}>
              <b>{a.fullName || a.name}</b><small>{a.name}{a.isAdmin ? ' · administrator (will be changed to Standard)' : ''}</small>
            </button>
          ))}
          {(accounts ?? []).filter((a) => a.usedBy).map((a) => <div class="account used"><b>{a.fullName || a.name}</b><small>{a.name} · already {a.usedBy}'s</small></div>)}
        </div>
      )}
      {err && <p class="error">{err}</p>}
      <button class="primary" disabled={!ready || busy} onClick={go}>{busy ? 'One moment…' : action}</button>
    </div>
  );
}
