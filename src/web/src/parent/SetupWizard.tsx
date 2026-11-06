import { useEffect, useState } from 'preact/hooks';
import { bridge } from '../core/bridge';
import { KidAccount, type WinAccount } from './KidAccount';


/** First run. Three questions, then done. */
export function SetupWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [accounts, setAccounts] = useState<WinAccount[] | null>(null);
  const [account, setAccount] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [color, setColor] = useState('');
  const [pin, setPin] = useState(''); const [pin2, setPin2] = useState('');
  const [preset, setPreset] = useState('school');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { bridge.setupAccounts().then(setAccounts).catch((e) => { setError(e.message); setAccounts([]); }); }, []);

  async function finish() {
    setBusy(true); setError('');
    try {
      await bridge.setupComplete(pin, { displayName: displayName || account, windowsAccount: account, color }, preset);
      await bridge.parentLogin(pin).catch(() => { /* admin accounts don't need it */ });
      onDone();
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const steps = ['Your child', 'Parent PIN', 'Starting point'];
  return (
    <div class="wizard">
      <h1>Welcome to CoinQuest</h1>
      <ol class="steps">{steps.map((s, i) => <li class={i === step ? 'on' : i < step ? 'done' : ''}>{s}</li>)}</ol>

      {step === 0 && (
        <div class="card">
          <h2>Who's the child?</h2>
          <p class="muted">Rules apply only to their Windows account; your own account is never restricted. You can add more kids later in the Parent Console.</p>
          <KidAccount accounts={accounts} allowAdmin create={(u, f, p) => bridge.setupCreateAccount(u, f, p)}
            onPicked={(k) => { setAccount(k.account); setDisplayName(k.displayName); setColor(k.color); setStep(1); }} />
          {account && <p class="muted small">Chosen: {displayName} ({account})</p>}
        </div>
      )}

      {step === 1 && (
        <div class="card">
          <h2>Choose a parent PIN</h2>
          <p class="muted">4–8 digits. Opens the Parent Console from inside your child's account (Ctrl+Shift+P). From your own account you won't need it.</p>
          <div class="row">
            <label>PIN<input type="password" inputMode="numeric" value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value)} maxLength={8} /></label>
            <label>Again<input type="password" inputMode="numeric" value={pin2} onInput={(e) => setPin2((e.target as HTMLInputElement).value)} maxLength={8} /></label>
          </div>
          {pin && pin2 && pin !== pin2 && <p class="error">Those don't match.</p>}
          <div class="row"><button class="ghost" onClick={() => setStep(0)}>Back</button><button class="primary" disabled={!/^\d{4,8}$/.test(pin) || pin !== pin2} onClick={() => setStep(2)}>Next</button></div>
        </div>
      )}

      {step === 2 && (
        <div class="card">
          <h2>Starting point</h2>
          <p class="muted">You can change every detail later in Allowed, Shop and Quests.</p>
          <div class="preset-list">
            <button class={'preset' + (preset === 'school' ? ' picked' : '')} onClick={() => setPreset('school')}><b>School basics</b><small>Khan Academy, dictionary, Wikipedia, calculator, Notepad, Paint. YouTube and the arcade only as prizes.</small></button>
          </div>
          {error && <p class="error">{error}</p>}
          <div class="row"><button class="ghost" onClick={() => setStep(1)}>Back</button><button class="primary" disabled={busy} onClick={finish}>{busy ? 'Setting up…' : 'Finish'}</button></div>
        </div>
      )}
    </div>
  );
}
