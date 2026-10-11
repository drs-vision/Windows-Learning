// The one place the UI talks to the outside world.
// Inside the Windows shell: window.chrome.webview.postMessage → C# → named pipe → Guardian.
// In a plain browser (npm run dev): an in-memory mock Guardian so the whole UI can be developed and demoed.

import type { ChildState, Game, ParentState } from './types';
import { MockGuardian } from './mock-guardian';

interface Req { id: string; op: string; token?: string; payload?: unknown }
interface Resp { id: string; ok: boolean; error?: string; payload?: any }
export interface Ev { name: string; payload?: any }

type Listener = (ev: Ev) => void;

declare global {
  interface Window { chrome?: { webview?: { postMessage(s: string): void; addEventListener(t: 'message', h: (e: { data: string }) => void): void } } }
}

class Bridge {
  private pending = new Map<string, { resolve: (r: Resp) => void }>();
  private listeners = new Set<Listener>();
  private mock: MockGuardian | null = null;
  parentToken: string | null = null;
  readonly isShell: boolean;

  constructor() {
    this.isShell = !!window.chrome?.webview;
    if (this.isShell) {
      window.chrome!.webview!.addEventListener('message', (e) => this.onMessage(e.data));
    } else {
      this.mock = new MockGuardian((ev) => this.dispatch(ev));
    }
  }

  private onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      this.pending.get(msg.id)!.resolve(msg);
      this.pending.delete(msg.id);
    } else if (msg.name) {
      this.dispatch(msg);
    }
  }

  private dispatch(ev: Ev) { for (const l of this.listeners) l(ev); }

  on(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }

  async call<T = any>(op: string, payload?: unknown, opts: { parent?: boolean } = {}): Promise<T> {
    const req: Req = { id: Math.random().toString(36).slice(2), op, payload };
    if (opts.parent && this.parentToken) req.token = this.parentToken;
    let resp: Resp;
    if (this.mock) resp = await this.mock.handle(req);
    else {
      resp = await new Promise<Resp>((resolve) => {
        this.pending.set(req.id, { resolve });
        window.chrome!.webview!.postMessage(JSON.stringify(req));
        setTimeout(() => { if (this.pending.has(req.id)) { this.pending.delete(req.id); resolve({ id: req.id, ok: false, error: 'timeout' }); } }, 20000);
      });
    }
    if (!resp.ok) throw new Error(resp.error ?? 'failed');
    return resp.payload as T;
  }

  // ---- typed helpers ----
  hello() { return this.call<{ version: string; account: string; isAdmin: boolean; childId?: string; setupNeeded: boolean }>('hello'); }
  state() { return this.call<ChildState>('state'); }
  submit(moduleId: string, activity: unknown, result: unknown) { return this.call<{ coins: number; pending: boolean; capped: boolean; detail: string; balance: number }>('submit', { moduleId, activity, result }); }
  buy(prizeId: string) { return this.call<{ balance: number; unlock?: unknown }>('buy', { prizeId }); }
  saveProgress(moduleId: string, progress: unknown) { return this.call('progress', { moduleId, progress }); }
  arcade() { return this.call<{ games: Game[] }>('arcade.list'); }

  async parentLogin(pin: string) {
    const r = await this.call<{ token: string }>('parent.login', { pin });
    this.parentToken = r.token;
    return r;
  }
  parentState() { return this.call<ParentState>('parent.state', undefined, { parent: true }); }
  parentUpdateChild(child: unknown) { return this.call('parent.updateChild', { child }, { parent: true }); }
  parentResolveClaim(seq: number, approve: boolean, coins?: number) { return this.call('parent.resolveClaim', { seq, approve, coins }, { parent: true }); }
  parentAdjust(childId: string, delta: number, reason: string) { return this.call('parent.adjust', { childId, delta, reason }, { parent: true }); }
  parentSetPin(pin: string) { return this.call('parent.setPin', { pin }, { parent: true }); }
  parentInstalledApps() { return this.call<{ name: string; exe: string; path: string }[]>('parent.installedApps', undefined, { parent: true }); }
  parentCheckUpdate() { return this.call<ParentState['updateStatus']>('parent.checkUpdate', undefined, { parent: true }); }
  parentEndUnlock(unlockId: string) { return this.call('parent.endUnlock', { unlockId }, { parent: true }); }
  setupAccounts() { return this.call<{ name: string; fullName: string; isAdmin: boolean; disabled: boolean; sid: string }[]>('setup.accounts'); }
  setupComplete(pin: string, child: { displayName: string; windowsAccount: string }, preset: string) { return this.call('setup.complete', { pin, child, preset }); }

  // shell-local
  openBrowser(url: string) { return this.call('shell.openBrowser', { url }); }
  shellInfo() { return this.call<{ app: string; kiosk: boolean; version: string; account: string }>('shell.info'); }
}

export const bridge = new Bridge();
