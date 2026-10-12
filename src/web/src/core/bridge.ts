// The one place the UI talks to the outside world.
// Inside the Windows shell: window.chrome.webview.postMessage → C# → named pipe → Guardian.
// In a plain browser (npm run dev): an in-memory mock Guardian so the whole UI can be developed and demoed.

import type { ArcadeSettings, ChildState, FpCatalogGame, Game, ParentState, Unlock, Video, YouTubeChannel } from './types';
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
  buy(prizeId: string, blocks?: number) { return this.call<{ balance: number; unlock?: unknown }>('buy', { prizeId, blocks }); }
  saveProgress(moduleId: string, progress: unknown) { return this.call('progress', { moduleId, progress }); }
  arcade() { return this.call<{ games: Game[]; blockMinutes?: number; maxBlocks?: number; sampler?: { minutes: number; price: number }; flashpointRoot?: string | null }>('arcade.list'); }
  /** blocks × 5 minutes of one game; blocks 0 = jump back in with time already bought (or a sampler pass). */
  arcadePlay(gameId: string, blocks: number) { return this.call<{ balance: number; unlock?: Unlock; game: Game; flashpointRoot?: string | null; alreadyPlaying?: boolean }>('arcade.play', { gameId, blocks }); }
  arcadeSampler() { return this.call<{ balance: number; unlock: Unlock }>('arcade.sampler'); }
  arcadeQuit(gameId: string) { return this.call('arcade.quit', { gameId }).catch(() => undefined); }
  flashpoint(root: string, id: string, verb: 'play' | 'prepare' = 'play') { return this.call('shell.flashpoint', { root, id, verb }); }
  youtubeLibrary() { return this.call<{ channels: { id: string; title: string }[]; videos: Video[]; errors: string[] }>('youtube.library'); }
  youtubeCheck(videoId: string) { return this.call<{ allowed: boolean }>('youtube.check', { videoId }); }

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
  parentYouTubeResolve(url: string) { return this.call<YouTubeChannel>('parent.youtubeResolve', { url }, { parent: true }); }
  parentArcadeCatalog() { return this.call<{ games: Game[]; settings: ArcadeSettings }>('parent.arcadeCatalog', undefined, { parent: true }); }
  parentArcadeUpload(fileName: string, data: string, title: string, strategy: number) { return this.call<Game>('parent.arcadeUpload', { fileName, data, title, strategy }, { parent: true }); }
  parentArcadeRemove(gameId: string) { return this.call('parent.arcadeRemove', { gameId }, { parent: true }); }
  parentFpStatus() { return this.call<FpStatus>('parent.fpStatus', undefined, { parent: true }); }
  parentFpStockNow() { return this.call<FpStatus>('parent.fpStockNow', undefined, { parent: true }); }
  parentFpSearch(q: string) { return this.call<FpCatalogGame[]>('parent.fpSearch', { q }, { parent: true }); }
  parentFpSuggest() { return this.call<{ pick: { search: string; genre: string; strategy: number; note?: string | null }; game: FpCatalogGame; approved: boolean }[]>('parent.fpSuggest', undefined, { parent: true }); }
  parentFpInstallClifp() { return this.call<FpStatus>('parent.fpInstallClifp', undefined, { parent: true }); }
  parentFpDownloadInstaller() { return this.call<{ path: string }>('parent.fpDownloadInstaller', undefined, { parent: true }); }
  parentFpThumbs(ids: string[]) { return this.call<Record<string, string>>('parent.fpThumbs', { ids }, { parent: true }); }
  launch(exe: string) { return this.call('shell.launch', { exe }); }
  setupAccounts() { return this.call<{ name: string; fullName: string; isAdmin: boolean; disabled: boolean; sid: string }[]>('setup.accounts'); }
  setupComplete(pin: string, child: { displayName: string; windowsAccount: string }, preset: string) { return this.call('setup.complete', { pin, child, preset }); }

  // shell-local
  openBrowser(url: string) { return this.call('shell.openBrowser', { url }); }
  openSite(url: string, title: string, allow: string[]) { return this.call('shell.openSite', { url, title, allow }); }
  openGame(url: string, title: string) { return this.call('shell.openGame', { url, title }); }
  closeGame() { return this.call('shell.closeGame').catch(() => undefined); }
  shellInfo() { return this.call<{ app: string; kiosk: boolean; version: string; account: string }>('shell.info'); }
}

export const bridge = new Bridge();

export interface FpStatus {
  installed: boolean; root?: string | null; clifp: boolean; installerUrl: string;
  autoClassics?: boolean; approved?: number;
  /** stage: idle | not-installed | installing-launcher | downloading | ready */
  stock?: { stage: string; approved: number; downloaded: number; queued: number; error?: string | null };
}
