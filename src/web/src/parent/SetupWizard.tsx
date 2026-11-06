import { useEffect, useState } from 'preact/hooks';
import { bridge } from '../core/bridge';
import { KidAccount, type WinAccount } from './KidAccount';
import { GettingStarted, PcMap } from './ParentConsole';
import type { ParentState } from '../core/types';


/** First run. Three questions, then done. */
export function SetupWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(-1); // -1 = welcome
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
      setStep(3);
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const steps = ['Your child', 'Parent PIN', 'Starting point', 'Check it works'];
  return (
    <div class="wizard">
      <h1>Welcome to CoinQuest</h1>
      {step >= 0 && <ol class="steps">{steps.map((s, i) => <li class={i === step ? 'on' : i < step ? 'done' : ''}>{s}</li>)}</ol>}

      {step === -1 && (
        <div class="card welcome">
          <h2>Kids earn their screen time here</h2>
          <p>Your child earns coins by reading, typing and learning, and spends them on games, YouTube and other rewards you choose. Everything else on their Windows account stays locked.</p>
          <ol class="welcome-steps">
            <li><b>Add your child</b> · CoinQuest can make their Windows account for you.</li>
            <li><b>Pick a parent PIN</b> · it opens these settings from their account.</li>
            <li><b>Choose a starting point</b> · you can change everything later.</li>
            <li><b>Check it works</b> · and link your phone if you like.</li>
          </ol>
          <PcMap kids={[]} />
          <p class="muted small">About 2 minutes.</p>
          <button class="primary big" onClick={() => setStep(0)}>Start</button>
        </div>
      )}

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
          <div class="row"><button class="ghost" onClick={() => setStep(1)}>Back</button><button class="primary" disabled={busy} onClick={finish}>{busy ? 'Setting up…' : 'Set it up'}</button></div>
        </div>
      )}

      {step === 3 && <CheckItWorks name={displayName || account} onDone={onDone} />}
    </div>
  );
}

/** The last setup step: live checks that it's working, how to try it, and the phone code. */
function CheckItWorks({ name, onDone }: { name: string; onDone: () => void }) {
  const [state, setState] = useState<ParentState | null>(null);
  useEffect(() => { const load = () => bridge.parentState().then(setState).catch(() => undefined); load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  return (
    <div class="card">
      <h2>Check it works</h2>
      {state ? <GettingStarted state={state} inSetup /> : <p class="muted">Checking…</p>}
      <p class="muted small">You can come back to this list any time: it stays on the Parent Console's Today page until everything is done.</p>
      <button class="primary" onClick={onDone}>Open the Parent Console</button>
    </div>
  );
}
