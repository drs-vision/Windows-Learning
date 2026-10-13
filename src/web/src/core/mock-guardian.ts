// In-browser stand-in for the Guardian so `npm run dev` shows the whole product without Windows.
// Mirrors the rules in src/Guardian/Ipc/RequestRouter.cs. Keep them in step.

import type { Child, ChildState, LedgerEntry, ParentState, PendingClaim, Prize, Unlock } from './types';
import { scoreModule } from '../scorers';
import { autoSamplerPrice, defaultArcadePrice, youTubeBlockPrice } from './types';
import type { Ev } from './bridge';

const STARTER_PRIZES: Prize[] = [
  { id: 'p-yt', name: '20 minutes of YouTube', cost: 48, kind: 'youTube', minutes: 20, dailyCap: 3, boughtToday: 0, targets: [] },
  { id: 'p-ext', name: 'Extra 15 minutes tonight', cost: 30, kind: 'screenTimeExtension', minutes: 15, dailyCap: 1, boughtToday: 0, targets: [] },
  { id: 'p-movie', name: "Pick Friday's movie", cost: 150, kind: 'realWorld', minutes: 0, dailyCap: 1, boughtToday: 0, targets: [] },
];

export class MockGuardian {
  private setupDone = localStorage.getItem('cq.mock.setup') === '1';
  private pin = localStorage.getItem('cq.mock.pin') ?? '';
  private child: Child = JSON.parse(localStorage.getItem('cq.mock.child') ?? 'null') ?? {
    id: 'c1', displayName: 'Sam', windowsAccount: 'sam', windowsSid: 'S-1-5-21-mock',
    allowlist: { apps: ['msedge.exe', 'chrome.exe', 'calc.exe'], sites: ['khanacademy.org', 'wikipedia.org'] },
    prizes: STARTER_PRIZES,
    youTubeChannels: [{ id: 'UCY1kMZp36IQSyNx_9h4mpCg', title: 'Mark Rober', url: 'https://www.youtube.com/@MarkRober' }],
    arcade: { minutesPerPlay: 15, priceOverrides: {}, hidden: [], webGames: [], flashpoint: [
      { id: '11111111-0000-0000-0000-000000000001', title: 'Gravity Guy', developer: 'Miniclip', genre: 'Runner', strategy: 1 },
      { id: '11111111-0000-0000-0000-000000000002', title: 'Fancy Pants Adventures', developer: 'Brad Borne', genre: 'Platformer', strategy: 2 },
      { id: '11111111-0000-0000-0000-000000000003', title: 'Bloons Tower Defense 4', developer: 'Ninja Kiwi', genre: 'Tower defense', strategy: 5 },
      { id: '11111111-0000-0000-0000-000000000004', title: 'Learn to Fly 2', developer: 'Light Bringer Games', genre: 'Launch & upgrade', strategy: 3 },
      { id: '11111111-0000-0000-0000-000000000005', title: 'Raft Wars', developer: 'Martijn Kunst', genre: 'Artillery', strategy: 3 },
      { id: '11111111-0000-0000-0000-000000000006', title: 'Cyclomaniacs', developer: 'Max Games', genre: 'Racing', strategy: 2 },
      { id: '11111111-0000-0000-0000-000000000007', title: 'Henry Stickmin: Breaking the Bank', developer: 'PuffballsUnited', genre: 'Choose your path', strategy: 4 },
      { id: '11111111-0000-0000-0000-000000000008', title: 'Age of War', developer: 'Max Games', genre: 'Strategy', strategy: 4 },
    ] },
    modules: {
      'sound-keys': { enabled: true, coinsPerActivity: 12, dailyCap: 100, requireApproval: false, options: {} },
      'typing-quest': { enabled: false, coinsPerActivity: 10, dailyCap: 80, requireApproval: false },
      'bible-typing': { enabled: true, coinsPerActivity: 15, dailyCap: 60, requireApproval: false },
      'khan-academy': { enabled: true, coinsPerActivity: 5, dailyCap: 80, requireApproval: false },
    },
  };
  private ledger: LedgerEntry[] = JSON.parse(localStorage.getItem('cq.mock.ledger') ?? '[]');
  private claims: PendingClaim[] = JSON.parse(localStorage.getItem('cq.mock.claims') ?? '[]');
  private unlocks: Unlock[] = [];
  private progress: Record<string, any> = JSON.parse(localStorage.getItem('cq.mock.progress') ?? '{}');
  private seq = this.ledger.length;
  private token: string | null = null;

  constructor(private emit: (ev: Ev) => void) {
    setInterval(() => {
      const before = this.unlocks.length;
      const now = Date.now();
      for (const u of this.unlocks) u.secondsLeft = Math.max(0, Math.round((Date.parse(u.expiresAt) - now) / 1000));
      const expired = this.unlocks.filter((u) => u.secondsLeft === 0);
      this.unlocks = this.unlocks.filter((u) => u.secondsLeft > 0);
      for (const u of expired) emit({ name: 'unlockEnded', payload: { unlockId: u.id, prizeName: u.prizeName } });
      if (before !== this.unlocks.length) emit({ name: 'state' });
    }, 1000);
  }

  private persist() {
    localStorage.setItem('cq.mock.ledger', JSON.stringify(this.ledger));
    localStorage.setItem('cq.mock.claims', JSON.stringify(this.claims));
    localStorage.setItem('cq.mock.child', JSON.stringify(this.child));
    localStorage.setItem('cq.mock.progress', JSON.stringify(this.progress));
  }

  private append(kind: LedgerEntry['kind'], delta: number, source: string, detail: string): LedgerEntry {
    const e = { seq: ++this.seq, at: new Date().toISOString(), kind, delta, source, detail };
    this.ledger.push(e); this.persist(); return e;
  }
  private balance() { return this.ledger.reduce((s, e) => s + e.delta, 0); }
  private todayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }
  private earnedToday(source: string) { const t = this.todayStart(); return this.ledger.filter((e) => e.source === source && e.at >= t && (e.kind === 'earn' || e.kind === 'claimApproved')).reduce((s, e) => s + e.delta, 0); }
  private boughtToday(prizeId: string) { const t = this.todayStart(); return this.ledger.filter((e) => e.source === prizeId && e.kind === 'spend' && e.at >= t).length; }

  private childState(): ChildState {
    const t = this.todayStart();
    return {
      child: { id: this.child.id, displayName: this.child.displayName },
      balance: this.balance(),
      unlocks: this.unlocks,
      prizes: this.child.prizes.filter((p) => p.enabled !== false).map((p) => ({ ...p, boughtToday: this.boughtToday(p.id), blockMinutes: 5,
        blockPrice: p.kind === 'youTube' ? youTubeBlockPrice(p.cost, p.minutes, [6]) : null })),
      modules: Object.fromEntries(Object.entries(this.child.modules).map(([k, v]) => [k, { ...v, earnedToday: this.earnedToday(k) }])),
      recent: this.ledger.filter((e) => e.at >= t).slice(-30).reverse(),
      pendingClaims: this.claims,
      progress: this.progress,
      sites: this.child.allowlist.sites,
    };
  }

  private parentState(): ParentState {
    const t = this.todayStart();
    return {
      household: { id: 'local', name: 'My family', children: [this.child] },
      pendingClaims: this.claims,
      perChild: { [this.child.id]: { balance: this.balance(), today: this.ledger.filter((e) => e.at >= t).reverse(), unlocks: this.unlocks, earnedToday: Object.fromEntries(Object.keys(this.child.modules).map((m) => [m, this.earnedToday(m)])) } },
      activeChildId: this.child.id,
      version: '0.1.0-dev',
      updateStatus: { current: '0.1.0-dev', latest: null, state: 'upToDate', lastChecked: new Date().toISOString() },
      ledgerIntact: true,
      enforcement: { consoleAccount: 'DESKTOP\\you', childAtKeyboard: false, childAccount: this.child.windowsAccount, browserLock: { entries: 0 }, internetLock: { applied: true, at: new Date().toISOString() } },
    };
  }

  async handle(req: { id: string; op: string; token?: string; payload?: any }): Promise<{ id: string; ok: boolean; payload?: any; error?: string }> {
    const ok = (payload?: unknown) => ({ id: req.id, ok: true, payload });
    const fail = (error: string) => ({ id: req.id, ok: false, error });
    const p = req.payload ?? {};
    const parentOk = req.token && req.token === this.token;
    await new Promise((r) => setTimeout(r, 30));
    switch (req.op) {
      case 'hello': return ok({ version: '0.1.0-dev', account: 'DEV\\you', isAdmin: true, childId: this.child.id, setupNeeded: !this.setupDone });
      case 'shell.info': return ok({ app: new URLSearchParams(location.search).get('app') ?? 'scholar', kiosk: false, version: '0.1.0-dev', account: 'you' });
      case 'shell.openBrowser': window.open(p.url, '_blank'); return ok({ ok: true });
      case 'state': return ok(this.childState());
      case 'progress': this.progress[p.moduleId] = p.progress; this.persist(); return ok();
      case 'arcade.list': {
        const a = this.child.arcade!;
        const price = (id: string, st: number) => a.priceOverrides[id] ?? defaultArcadePrice(st);
        const plays = (id: string) => this.ledger.filter((e) => e.source === 'arcade:' + id).length;
        const bundled = ((await (await fetch('./content/games/MANIFEST.json').catch(() => null))?.json().catch(() => null))?.games ?? [])
          .filter((g: any) => g.enabled !== false)
          .map((g: any) => ({ ...g, url: './content/games/' + g.path, available: true, price: price(g.id, g.strategy ?? 2), plays: plays(g.id), source: 'bundled' }));
        const fp = (a.flashpoint ?? []).map((f) => ({ id: 'fp-' + f.id, title: f.title, author: f.developer, kind: 'classic', license: 'via Flashpoint', url: f.id, genre: f.genre, strategy: f.strategy, price: price('fp-' + f.id, f.strategy), available: true, plays: plays('fp-' + f.id), source: 'flashpoint' }));
        const games = [...fp, ...bundled];
        const sm = a.samplerMinutes ?? 10;
        return ok({ games, blockMinutes: 5, maxBlocks: 12, sampler: { minutes: sm, price: a.samplerPrice || autoSamplerPrice(games.map((g: any) => g.price), sm) }, flashpointRoot: 'C:\\Flashpoint' });
      }
      case 'arcade.play': {
        const list = (await this.handle({ id: 'x', op: 'arcade.list' })).payload as any;
        const g = list.games.find((x: any) => x.id === p.gameId);
        if (!g) return fail("that game isn't in the arcade");
        const blocks = Number(p.blocks ?? 1);
        const running = this.unlocks.find((u) => u.kind === 'arcadeUnlock' && (u.targets.includes(g.id) || u.targets.includes('*')));
        if (blocks === 0) { if (!running) return fail('add some time first (press +)'); return ok({ balance: this.balance(), unlock: running, game: g, alreadyPlaying: true }); }
        const cost = g.price * blocks;
        if (this.balance() < cost) return fail(`you need ${cost - this.balance()} more coins`);
        this.append('spend', -cost, 'arcade:' + g.id, `Arcade: ${blocks * 5} min of ${g.title}`);
        const own = this.unlocks.find((u) => u.kind === 'arcadeUnlock' && u.targets.includes(g.id));
        const unlock: Unlock = own ?? { id: 'u' + Date.now(), kind: 'arcadeUnlock', targets: [g.id], prizeName: g.title, expiresAt: new Date().toISOString(), secondsLeft: 0 };
        unlock.secondsLeft += blocks * 300; unlock.expiresAt = new Date(Date.now() + unlock.secondsLeft * 1000).toISOString();
        if (!own) this.unlocks.push(unlock);
        this.emit({ name: 'state' });
        return ok({ balance: this.balance(), unlock, game: g, flashpointRoot: 'C:\\Flashpoint' });
      }
      case 'arcade.quit': return ok({ ok: true }); // paid time keeps counting; he can jump back in
      case 'arcade.sampler': {
        const list = (await this.handle({ id: 'x', op: 'arcade.list' })).payload as any;
        const { minutes, price } = list.sampler;
        if (this.balance() < price) return fail(`you need ${price - this.balance()} more coins`);
        this.append('spend', -price, 'arcade:sampler', `Arcade: ${minutes}-minute sampler pass`);
        const unlock: Unlock = { id: 'u' + Date.now(), kind: 'arcadeUnlock', targets: ['*'], prizeName: 'Sampler pass', expiresAt: new Date(Date.now() + minutes * 60000).toISOString(), secondsLeft: minutes * 60 };
        this.unlocks.push(unlock); this.emit({ name: 'state' });
        return ok({ balance: this.balance(), unlock });
      }
      case 'shell.flashpoint': case 'shell.openGame': case 'shell.openSite': case 'shell.closeGame': case 'shell.launch': return ok({ ok: true });
      case 'youtube.library': return ok({ channels: this.child.youTubeChannels, errors: [], videos: Array.from({ length: 9 }, (_, i) => ({ id: 'dQw4w9WgXcQ', title: `Amazing science video #${i + 1}`, channelId: this.child.youTubeChannels![0].id, channelTitle: 'Mark Rober', published: new Date().toISOString(), thumbnail: '' })) });
      case 'youtube.channel': { const n = Number(p?.next || 0); return ok({ videos: Array.from({ length: 12 }, (_, i) => ({ id: 'vid' + String(n * 12 + i).padStart(8, '0'), title: `Older video #${n * 12 + i + 1}`, channelId: p?.channelId, channelTitle: 'Mark Rober', published: new Date().toISOString(), thumbnail: '' })), next: n < 2 ? String(n + 1) : null }); }
      case 'youtube.check': return ok({ allowed: this.unlocks.some((u) => u.kind === 'youTube') });
      case 'parent.youtubeResolve': return ok({ id: 'UC' + Math.random().toString(36).slice(2).padEnd(22, 'x').slice(0, 22), title: String(p.url).split('@')[1] ?? 'Channel', url: p.url });
      case 'parent.arcadeCatalog': { const l = (await this.handle({ id: 'x', op: 'arcade.list' })).payload as any; return ok({ games: l.games, settings: this.child.arcade }); }
      case 'parent.fpStatus': case 'parent.fpStockNow': return ok({ installed: true, root: 'C:\\Flashpoint', clifp: true, installerUrl: '', autoClassics: true, approved: 84, stock: { stage: 'downloading', approved: 84, downloaded: 31, queued: 53 } });
      case 'parent.fpSuggest': return ok(['Gravity Guy', 'Fancy Pants Adventures', 'Bloons Tower Defense 4', 'Learn to Fly 2', 'Raft Wars', 'Stick War', 'Fireboy and Watergirl in The Forest Temple'].map((t, i) => ({ pick: { search: t, genre: 'Classic', strategy: 3 }, game: { id: '11111111-0000-0000-0000-00000000000' + (i + 1), title: t, developer: '', publisher: '', platform: 'Flash', tags: 'Action', series: '', releaseDate: '2009', description: '' }, approved: i < 5 })));
      case 'parent.fpSearch': return ok([]);
      case 'arcade.prepare': return ok({ url: './content/games/swf/ending.swf', base: './content/games/swf/', prefix: './content/games/swf/', platform: 'Flash' });
      case 'arcade.reportBroken': return ok({ ok: true });
      case 'parent.diagnostics': return ok({ version: '0.0.0-mock', problems: ['10-12 21:40 YouTubeService: Feed failed for Mark Rober — HttpRequestException: example'], blocked: ['d35aaqx5ub95lt.cloudfront.net'], internetLock: { applied: true } });
      case 'parent.blocked': return ok([{ host: 'd35aaqx5ub95lt.cloudfront.net', at: new Date().toISOString(), reason: 'not on the list' }]);
      case 'parent.fpThumbs': return ok({});
      case 'submit': {
        const settings = this.child.modules[p.moduleId];
        if (!settings?.enabled) return fail("that quest isn't turned on");
        const out = scoreModule(p.moduleId, p.activity, p.result, settings);
        if (!out.valid) return fail(out.reason ?? "that didn't check out");
        const room = settings.dailyCap > 0 ? Math.max(0, settings.dailyCap - this.earnedToday(p.moduleId)) : Infinity;
        const coins = Math.min(out.coins, room);
        if (out.progressDelta) { this.progress[p.moduleId] = { ...(this.progress[p.moduleId] ?? {}), ...out.progressDelta }; }
        if (out.needsApproval || settings.requireApproval) {
          const e = this.append('claim', 0, p.moduleId, out.detail);
          this.claims.push({ ledgerSeq: e.seq, childId: this.child.id, moduleId: p.moduleId, coins, detail: out.detail, at: e.at });
          this.persist(); this.emit({ name: 'approvals' }); this.emit({ name: 'state' });
          return ok({ coins, pending: true, capped: coins < out.coins, detail: out.detail, balance: this.balance() });
        }
        if (coins > 0) this.append('earn', coins, p.moduleId, out.detail);
        this.persist(); this.emit({ name: 'state' });
        return ok({ coins, pending: false, capped: coins < out.coins, detail: out.detail, balance: this.balance() });
      }
      case 'buy': {
        let prize = this.child.prizes.find((x) => x.id === p.prizeId);
        if (!prize) return fail("that prize isn't available");
        if (prize.kind === 'youTube') {
          const blocks = Math.max(1, Math.min(12, Number(p.blocks ?? prize.minutes / 5)));
          prize = { ...prize, cost: youTubeBlockPrice(prize.cost, prize.minutes, [6]) * blocks, minutes: blocks * 5, name: `${blocks * 5} minutes of YouTube` };
        }
        if (this.balance() < prize.cost) return fail(`you need ${prize.cost - this.balance()} more coins`);
        if (prize.dailyCap > 0 && this.boughtToday(prize.id) >= prize.dailyCap) return fail("you've had that one enough for today");
        this.append('spend', -prize.cost, prize.id, prize.name);
        let unlock: Unlock | undefined;
        if (prize.kind === 'youTube' && !(this.child.youTubeChannels?.length)) return fail('no YouTube channels are set up yet — ask a parent');
        if (prize.minutes > 0 && prize.kind !== 'realWorld') {
          const existing = this.unlocks.find((u) => u.kind === prize!.kind && (u.prizeName === prize!.name || u.kind === 'youTube'));
          if (existing) { existing.expiresAt = new Date(Date.parse(existing.expiresAt) + prize.minutes * 60000).toISOString(); unlock = existing; }
          else { unlock = { id: 'u' + Date.now(), kind: prize.kind, targets: prize.targets ?? [], prizeName: prize.name, expiresAt: new Date(Date.now() + prize.minutes * 60000).toISOString(), secondsLeft: prize.minutes * 60 }; this.unlocks.push(unlock); }
        }
        this.emit({ name: 'state' });
        return ok({ balance: this.balance(), unlock });
      }
      case 'parent.login':
        if (p.pin !== this.pin) return fail('wrong PIN');
        this.token = 't' + Math.random(); return ok({ token: this.token, expiresInSeconds: 1800 });
      case 'parent.state': if (!parentOk) return fail('parent PIN required'); return ok(this.parentState());
      case 'parent.updateChild': if (!parentOk) return fail('parent PIN required'); this.child = p.child; this.persist(); this.emit({ name: 'state' }); return ok({ ok: true });
      case 'parent.resolveClaim': {
        if (!parentOk) return fail('parent PIN required');
        const i = this.claims.findIndex((c) => c.ledgerSeq === p.seq);
        if (i < 0) return ok({ ok: false });
        const [c] = this.claims.splice(i, 1);
        const entry = this.append(p.approve ? 'claimApproved' : 'claimDenied', p.approve ? (p.coins ?? c.coins) : 0, c.moduleId, c.detail);
        this.emit({ name: 'approvals' }); this.emit({ name: 'state' });
        return ok({ ok: true, entry });
      }
      case 'parent.adjust': if (!parentOk) return fail('parent PIN required'); this.append('adjust', p.delta, 'parent', p.reason); this.emit({ name: 'state' }); return ok({ balance: this.balance() });
      case 'parent.setPin': if (!parentOk) return fail('parent PIN required'); this.pin = p.pin; localStorage.setItem('cq.mock.pin', this.pin); return ok({ ok: true });
      case 'parent.installedApps': return ok([{ name: 'Microsoft Edge', exe: 'msedge.exe', path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' }, { name: 'Minecraft Launcher', exe: 'MinecraftLauncher.exe', path: 'C:\\Program Files\\Minecraft Launcher\\MinecraftLauncher.exe' }, { name: 'Scratch Desktop', exe: 'Scratch Desktop.exe', path: 'C:\\Program Files\\Scratch 3\\Scratch Desktop.exe' }, { name: 'Calculator', exe: 'calc.exe', path: 'C:\\Windows\\System32\\calc.exe' }]);
      case 'parent.checkUpdate': return ok({ current: '0.1.0-dev', latest: '0.1.0-dev', state: 'upToDate', lastChecked: new Date().toISOString() });
      case 'parent.endUnlock': { const u = this.unlocks.find((x) => x.id === p.unlockId); if (u) { this.unlocks = this.unlocks.filter((x) => x !== u); this.emit({ name: 'unlockEnded', payload: { unlockId: u.id, prizeName: u.prizeName } }); this.emit({ name: 'state' }); } return ok({ ok: !!u }); }
      case 'parent.version': return ok({ version: '0.1.0-dev', status: { state: 'upToDate' } });
      case 'setup.accounts': return ok([{ name: 'david', fullName: 'David', isAdmin: true, disabled: false, sid: 'S-1' }, { name: 'sam', fullName: 'Sam', isAdmin: false, disabled: false, sid: 'S-2' }]);
      case 'setup.complete':
        this.pin = p.pin; this.child = { ...this.child, displayName: p.child.displayName, windowsAccount: p.child.windowsAccount };
        this.setupDone = true; localStorage.setItem('cq.mock.setup', '1'); localStorage.setItem('cq.mock.pin', this.pin); this.persist();
        return ok({ ok: true, childId: this.child.id });
      default: return fail('unknown op ' + req.op);
    }
  }
}
