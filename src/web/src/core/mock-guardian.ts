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
      books: { enabled: true, coinsPerActivity: 3, dailyCap: 120, requireApproval: false, options: { waitMinutes: '5', wordsPer: '20', allowed: '*' } },
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
      case 'shell.context': case 'shell.flashpoint': case 'shell.openGame': case 'shell.openSite': case 'shell.closeGame': case 'shell.launch': return ok({ ok: true });
      case 'youtube.library': return ok({ channels: this.child.youTubeChannels, errors: [], videos: Array.from({ length: 9 }, (_, i) => ({ id: 'dQw4w9WgXcQ', title: `Amazing science video #${i + 1}`, channelId: this.child.youTubeChannels![0].id, channelTitle: 'Mark Rober', published: new Date().toISOString(), thumbnail: '' })) });
      case 'youtube.channel': { const n = Number(p?.next || 0); return ok({ videos: Array.from({ length: 12 }, (_, i) => ({ id: 'vid' + String(n * 12 + i).padStart(8, '0'), title: `Older video #${n * 12 + i + 1}`, channelId: p?.channelId, channelTitle: 'Mark Rober', published: new Date().toISOString(), thumbnail: '' })), next: n < 2 ? String(n + 1) : null }); }
      case 'youtube.check': return ok({ allowed: this.unlocks.some((u) => u.kind === 'youTube') });
      case 'parent.youtubeResolve': return ok({ id: 'UC' + Math.random().toString(36).slice(2).padEnd(22, 'x').slice(0, 22), title: String(p.url).split('@')[1] ?? 'Channel', url: p.url });
      case 'parent.arcadeCatalog': { const l = (await this.handle({ id: 'x', op: 'arcade.list' })).payload as any; return ok({ games: l.games, settings: this.child.arcade }); }
      case 'parent.fpStatus': case 'parent.fpStockNow': return ok({ installed: true, root: 'C:\\Flashpoint', clifp: true, installerUrl: '', autoClassics: true, approved: 84, stock: { stage: 'downloading', approved: 84, downloaded: 31, queued: 53 } });
      case 'parent.fpSuggest': return ok(['Gravity Guy', 'Fancy Pants Adventures', 'Bloons Tower Defense 4', 'Learn to Fly 2', 'Raft Wars', 'Stick War', 'Fireboy and Watergirl in The Forest Temple'].map((t, i) => ({ pick: { search: t, genre: 'Classic', strategy: 3 }, game: { id: '11111111-0000-0000-0000-00000000000' + (i + 1), title: t, developer: '', publisher: '', platform: 'Flash', tags: 'Action', series: '', releaseDate: '2009', description: '' }, approved: i < 5 })));
      case 'parent.fpSearch': return ok([]);
      case 'arcade.prepare': return ok({ url: './content/games/swf/ending.swf', base: './content/games/swf/', prefix: './content/games/swf/', platform: 'Flash' });
      case 'arcade.reportBroken': return ok({ ok: true, refund: 6 });
      case 'parent.phoneLinks':
      case 'parent.phoneUnlink': return ok({ relay: 'https://ntfy.sh', status: 'no phones linked', phones: [] });
      case 'parent.phoneLink': return ok({ id: 'demo', name: 'Phone', url: 'https://drs-vision.github.io/Windows-Learning/#demo' });
      case 'parent.discCoins':
      case 'parent.discStatus': return ok({ stage: 'idle', games: [], root: 'C:\\ProgramData\\CoinQuest\\discgames' });
      case 'parent.activity': {
        // Sample reports so the Activity tab can be seen in the browser preview.
        const days = [];
        const end = new Date(String(p?.to ?? '') || Date.now()), start = new Date(String(p?.from ?? '') || Date.now());
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const seed = (d.getDate() * 37) % 11;
          if (seed < 3 && d.toDateString() !== new Date().toDateString()) continue;
          const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          days.push({ day: k, childId: 'c1', kid: 'Sam', time: [
            { kind: 'quest', label: 'Khan Academy', sec: 900 + seed * 120 }, { kind: 'site', label: 'khanacademy.org', sec: 1500 + seed * 60 },
            { kind: 'youtube', label: 'Mark Rober', sec: 600 + seed * 90 }, { kind: 'quest', label: 'Scripture Typing', sec: 420 },
            { kind: 'arcade', label: '2048', sec: 300 + seed * 30 }, { kind: 'app', label: 'Read, Write & Type!', sec: 780 }, { kind: 'coinquest', label: 'Home', sec: 240 } ],
            typing: { sessions: 3, chars: 2400 + seed * 100, ms: 900000, best: 28 + seed }, done: { 'khan-academy:correct': 12 + seed, 'khan-academy:videos': 2, 'bible-typing:finished': 2, 'duolingo:lessons': seed % 3, 'books:chapters': 1 + (seed % 2), 'books:answered': 12, 'books:correct': 9 + (seed % 3), 'books:readWords': 2600, 'books:readSec': 1150 + seed * 20 },
            earned: { 'khan-academy': 30 + seed, 'bible-typing': 9, rwt: 20 }, spent: { '20 minutes of YouTube': 48 },
            log: [{ t: '15:42', d: 9, k: 'Earn', s: 'bible-typing', x: 'Psalm 23 · 118 words' }, { t: '16:05', d: 12, k: 'Earn', s: 'khan-academy', x: 'Khan Academy: 1 finished exercise + 7 correct answers' }, { t: '16:30', d: -48, k: 'Spend', s: 'p-yt', x: '20 minutes of YouTube' }, { t: '17:10', d: 5, k: 'Adjust', s: 'parent', x: 'Cleaned his room' }] });
        }
        if (days.length) (days[days.length - 1] as any).reading = { chapters: 23, firstTry: 84, wpm: 142, level: 4, verified: 3 };
        return ok({ childId: 'c1', kid: 'Sam', enabled: true, days });
      }
      // Reading, for the browser preview: one real book (Peter Rabbit). The real marking happens in the Guardian.
      case 'parent.books': return ok({ flagged: 0, books: shelf.map((b) => ({ id: b.id, title: b.title, author: b.author, published: b.published, level: b.level, grade: b.grade, summary: b.summary, edited: b.edited, measures: b.measures, formulaGrade: b.readability?.grade, chapters: b.chapters.length, words: b.chapters.reduce((t, c) => t + c.words, 0), ready: b.chapters.length, done: b.id === 'peter-rabbit' && mb.passed ? 1 : 0, started: b.id === 'peter-rabbit' && mb.attempts > 0 })) });
      case 'parent.reading': {
        // A sample history so the reading analysis can be seen in the browser preview.
        const d = (n: number) => { const x = new Date(); x.setDate(x.getDate() - n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
        const row = (n: number, book: string, chapter: number | null, level: number, atos: number | null, lexile: number | null, c: number, t: number, tries: number, wpm: number | null) =>
          ({ at: d(n), book, chapter, title: '', level, formula: null, atos, lexile, firstTry: Math.round(100 * c / t), correct: c, total: t, tries, passed: c * 10 >= t * 7 || tries > 1, wpm, status: c / t >= 0.8 ? 'comfortable' : c / t >= 0.6 ? 'challenge' : 'hard' });
        const recent = [row(0, 'Treasure Island', 9, 4, 6.6, 1070, 6, 10, 1, 151), row(1, 'Kidnapped', 2, 5, 7.0, 1070, 5, 8, 2, 133), row(2, 'Treasure Island', 8, 4, 6.6, 1070, 9, 10, 1, 148),
          row(4, 'Treasure Island', 7, 4, 6.6, 1070, 8, 9, 1, 156), row(6, 'Treasure Island', 6, 4, 6.6, 1070, 9, 9, 1, 139), row(9, 'The Call of the Wild', 1, 4, 6.9, 1120, 9, 10, 1, 144),
          row(12, 'Black Beauty', 14, 3, 5.4, 1010, 7, 8, 1, 162), row(15, 'The Tale of Peter Rabbit', null, 1, 3.4, 660, 4, 4, 1, 210)];
        const weeks = Array.from({ length: 12 }, (_, i) => { const n = (11 - i) * 7; return { start: d(n), chapters: [2, 3, 1, 4, 3, 5, 2, 4, 6, 3, 5, 4][i], firstTry: [70, 78, 80, 75, 83, 81, 86, 79, 88, 84, 85, 81][i], wpm: 120 + i * 3 }; });
        return ok({ kid: 'Sam', comfortable: 4, comfortableAtos: 6.6, comfortableLexile: 1070, comfortableFormula: 6.8, current: 4, stretch: { chapters: 2, firstTry: 58, level: 5 },
          firstTry30: 84, firstTryAll: 82, chapters30: 17, wpm: 148, chaptersPassed: 42, wordsRead: 96500, minutesReading: 690, windowDays: 90, strongPercent: 80, strongNeeded: 3,
          levels: [{ level: 1, chapters: 6, strong: 6, firstTry: 96 }, { level: 2, chapters: 9, strong: 8, firstTry: 90 }, { level: 3, chapters: 14, strong: 11, firstTry: 85 }, { level: 4, chapters: 11, strong: 8, firstTry: 83 }, { level: 5, chapters: 2, strong: 0, firstTry: 58 }],
          weeks, recent });
      }
      case 'parent.booksReset': if (p.bookId === 'peter-rabbit') Object.assign(mb, { passed: false, correct: 0, total: 0, attempts: 0, retakeAt: null, seen: [], bonusDone: [], quiz: null, bonus: null, typed: 0 }); return ok({ ok: true });
      case 'quest.state': case 'quest.next': case 'quest.answer': {
        const r = await mockQuest(req.op, p);
        if (r?.coins > 0 || r?.bonus > 0) { this.append('earn', (r.coins ?? 0) + (r.bonus ?? 0), 'reading-quest', 'Reading Quest'); this.persist(); this.emit({ name: 'state' }); }
        return ok(r);
      }
      case 'parent.quest': return ok(mockQuestReport());
      case 'books.list': case 'books.chapter': case 'books.quiz': case 'books.grade': case 'books.bonus': case 'books.bonusAnswer': case 'books.typed': {
        const r = mockBooks(req.op, p);
        if (r?.coins > 0) { this.append('earn', r.coins, 'books', 'Reading'); r.balance = this.balance(); this.persist(); this.emit({ name: 'state' }); }
        return ok(r);
      }
      case 'parent.rwtStatus': return ok({ installed: false, otvdm: false, stage: 'idle', patches: [], players: [], root: 'C:\\ProgramData\\CoinQuest\\rwt' });
      case 'shell.pickFile': return ok({ path: null });
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

// ---- Reading (preview only) ----
import prText from '../../../../content/books/peter-rabbit/01-the-tale-of-peter-rabbit.txt?raw';
import prQs from '../../../../content/books/peter-rabbit/01-the-tale-of-peter-rabbit.questions.json';
const mb = { passed: false, correct: 0, total: 0, attempts: 0, retakeAt: null as string | null, seen: [] as string[], bonusDone: [] as string[], quiz: null as null | { id: string; ids: string[]; orders: number[][] }, bonus: null as null | { id: string; order: number[] }, typed: 0 };
const mbBank = (prQs as { questions: { id: string; q: string; choices: string[]; answer: number }[] }).questions;
const mbParts = prText.trim().split(/\n\s*\n/).reduce((acc: string[], p) => { const last = acc[acc.length - 1]; if (last && (last + ' ' + p).split(' ').length <= 170) acc[acc.length - 1] = last + ' ' + p; else acc.push(p); return acc; }, []);
type ShelfBook = { id: string; title: string; author: string; published: number; level: number; edited?: string; measures?: any; readability?: { grade: number }; grade: { min: number; max: number; label: string }; summary: string; chapters: { n: number; title: string; words: number }[] };
// Only the books' metadata (small): the preview can open Peter Rabbit, the other books list their chapters.
const shelf = Object.values(import.meta.glob('../../../../content/books/*/book.json', { eager: true, import: 'default' }) as Record<string, ShelfBook>)
  .sort((a, b) => a.level - b.level || a.grade.min - b.grade.min || a.title.localeCompare(b.title));
const quizSize = (w: number) => Math.max(4, Math.min(10, Math.round(w / 250)));
const shuffle = () => [0, 1, 2, 3].sort(() => Math.random() - 0.5);
function mockBooks(op: string, p: any): any {
  const status = () => ({ n: 1, title: 'The Tale of Peter Rabbit', words: 948, quizSize: 4, hasQuiz: true, passed: mb.passed, correct: mb.correct, total: mb.total, attempts: mb.attempts, retakeAt: mb.retakeAt && Date.parse(mb.retakeAt) > Date.now() ? mb.retakeAt : null, bonusLeft: mb.passed ? Math.min(mbBank.filter((q) => !mb.seen.includes(q.id) && !mb.bonusDone.includes(q.id)).length, 4 - mb.bonusDone.length) : 0, typed: mb.typed });
  const show = (id: string, order: number[]) => { const q = mbBank.find((x) => x.id === id)!; return { id, q: q.q, choices: order.map((i) => q.choices[i]) }; };
  if (op === 'books.list') return { perCorrect: 3, wordsPer: 20, books: shelf.map((b) => ({ id: b.id, title: b.title, author: b.author, level: b.level, summary: b.summary, chapters: b.id === 'peter-rabbit' ? [status()] : b.chapters.map((c) => ({ n: c.n, title: c.title, words: c.words, quizSize: quizSize(c.words), hasQuiz: true, passed: false, correct: 0, total: 0, attempts: 0, retakeAt: null, bonusLeft: 0, typed: 0 })) })) };
  if (op === 'books.chapter' && p.bookId !== 'peter-rabbit') { const b = shelf.find((x) => x.id === p.bookId)!; const c = b.chapters.find((x) => x.n === p.n)!; return { book: b.title, text: `(This preview only opens The Tale of Peter Rabbit. In CoinQuest, "${c.title}" opens here.)`, parts: [], status: { n: c.n, title: c.title, words: c.words, quizSize: quizSize(c.words), hasQuiz: false, passed: false, correct: 0, total: 0, attempts: 0, retakeAt: null, bonusLeft: 0, typed: 0 }, quiz: null }; }
  if (op === 'books.chapter') return { book: 'The Tale of Peter Rabbit', text: prText, parts: mbParts, status: status(), quiz: mb.quiz ? { id: mb.quiz.id, questions: mb.quiz.ids.map((id, i) => show(id, mb.quiz!.orders[i])) } : null };
  if (op === 'books.quiz') {
    if (mb.quiz) return { id: mb.quiz.id, questions: mb.quiz.ids.map((id, i) => show(id, mb.quiz!.orders[i])) }; // still open: the same quiz
    if (mb.retakeAt && Date.parse(mb.retakeAt) > Date.now()) throw new Error('You can try again soon');
    const ids = [...mbBank.filter((q) => !mb.seen.includes(q.id)), ...mbBank.filter((q) => mb.seen.includes(q.id))].slice(0, 4).map((q) => q.id);
    mb.quiz = { id: 'q' + Date.now(), ids, orders: ids.map(shuffle) };
    return { id: mb.quiz.id, questions: ids.map((id, i) => show(id, mb.quiz!.orders[i])) };
  }
  if (op === 'books.grade') {
    const qz = mb.quiz!; let correct = 0; const review = qz.ids.map((id, i) => { const q = mbBank.find((x) => x.id === id)!; const right = qz.orders[i].indexOf(q.answer); if (p.answers[i] === right) correct++; if (!mb.seen.includes(id)) mb.seen.push(id); return { id, q: q.q, choices: qz.orders[i].map((k) => q.choices[k]), picked: p.answers[i], right }; });
    mb.quiz = null; mb.attempts++;
    const passed = correct >= Math.ceil(0.7 * qz.ids.length);
    if (passed) { mb.passed = true; mb.correct = correct; mb.total = qz.ids.length; } else mb.retakeAt = new Date(Date.now() + 600000).toISOString();
    return { passed, correct, total: qz.ids.length, percent: Math.round(100 * correct / qz.ids.length), retakeAt: passed ? null : mb.retakeAt, review: passed ? review : null, coins: passed ? correct * 3 : 0, pending: false, bonusLeft: status().bonusLeft };
  }
  if (op === 'books.bonus') { if (status().bonusLeft <= 0) return { question: null, left: 0 }; const q = mbBank.find((x) => !mb.seen.includes(x.id) && !mb.bonusDone.includes(x.id)); if (!q) return { question: null, left: 0 }; mb.bonus = { id: q.id, order: shuffle() }; return { question: show(q.id, mb.bonus.order), left: status().bonusLeft }; }
  if (op === 'books.bonusAnswer') { const q = mbBank.find((x) => x.id === p.qid)!; const right = mb.bonus!.order.indexOf(q.answer); mb.bonusDone.push(q.id); return { right: p.choice === right, rightChoice: right, coins: p.choice === right ? 1 : 0, left: status().bonusLeft }; }
  if (op === 'books.typed') { mb.typed = Math.max(mb.typed, p.part + 1); return { coins: 2, pending: false, again: false, typed: mb.typed }; }
  return null;
}


// ---- Reading Quest preview: the same rules as ReadingQuest.cs, on the real paragraphs (loaded only in the preview) ----
type QP = { id: string; title: string; topic: string; text: string; source: { name: string; url: string; license: string; author?: string }; readability: { grade: number }; question: { type: string; q: string; choices: string[]; answer: number; evidence: string; explain: string } };
let qpool: QP[] | null = null;
const qs = { rating: 1, answered: 0, streak: 0, best: 0, misses: 0, done: {} as Record<string, boolean>, retry: {} as Record<string, number>, open: null as null | { id: string; order: number[]; at: number; retry: boolean } };
async function questPool(): Promise<QP[]> {
  if (qpool) return qpool;
  const files = import.meta.glob('../../../../content/passages/*.json', { import: 'default' });
  const docs = await Promise.all(Object.values(files).map((f) => f() as Promise<{ passages: QP[] }>));
  qpool = docs.flatMap((d) => d.passages ?? []);
  return qpool;
}
const qme = (pool: QP[]) => ({ level: Math.floor(qs.rating) + 1, progress: Math.round((qs.rating - Math.floor(qs.rating)) * 100) / 100, streak: qs.streak, bestStreak: qs.best, streakEvery: 5, answered: qs.answered, perQuest: 6, earnedToday: 0, dailyCap: 40, left: pool.filter((p) => !(p.id in qs.done)).length });
async function mockQuest(op: string, p: any): Promise<any> {
  const pool = await questPool();
  const secs = (x: QP) => Math.min(30, Math.max(15, Math.round(x.text.split(/\s+/).length / 4)));
  const show = (x: QP, o: { order: number[]; at: number; retry: boolean }) => ({ id: x.id, title: x.title, text: x.text, q: x.question.q, choices: o.order.map((i) => x.question.choices[i]), sourceName: x.source.name, sourceUrl: x.source.url, license: x.source.license, author: x.source.author ?? null, retry: o.retry, readSeconds: secs(x), waitLeft: Math.max(0, Math.ceil(secs(x) - (Date.now() - o.at) / 1000)) });
  if (op === 'quest.state') return qme(pool);
  if (op === 'quest.next') {
    if (qs.open) { const x = pool.find((y) => y.id === qs.open!.id)!; return { passage: show(x, qs.open), me: qme(pool) }; }
    const due = Object.entries(qs.retry).find(([, n]) => n <= qs.answered);
    if (due) { const x = pool.find((y) => y.id === due[0])!; qs.open = { id: x.id, order: [0, 1, 2, 3].sort(() => Math.random() - 0.5), at: Date.now(), retry: true }; return { passage: show(x, qs.open), me: qme(pool) }; }
    const target = qs.misses >= 2 ? qs.rating - 1 : qs.rating + 0.3;
    const near = pool.filter((x) => !(x.id in qs.done)).sort((a, b) => Math.abs(a.readability.grade - target) - Math.abs(b.readability.grade - target)).slice(0, 6);
    if (!near.length) return { passage: null, me: qme(pool) };
    const x = near[Math.floor(Math.random() * near.length)];
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    qs.open = { id: x.id, order, at: Date.now(), retry: false };
    return { passage: show(x, qs.open), me: qme(pool) };
  }
  const x = pool.find((y) => y.id === p.id)!;
  const rightChoice = qs.open!.order.indexOf(x.question.answer);
  const right = p.pick === rightChoice;
  if (qs.open!.retry) { delete qs.retry[x.id]; qs.open = null; return { retry: true, right, rightChoice, evidence: x.question.evidence, explain: x.question.explain, streak: qs.streak, streakUp: false, coins: 0, bonus: 0, pending: false, levelBefore: Math.floor(qs.rating) + 1, me: qme(pool) }; }
  const before = qs.rating;
  const e = 1 / (1 + Math.pow(10, (x.readability.grade - qs.rating) / 2));
  qs.rating = Math.min(13, Math.max(0, qs.rating + (qs.answered < 15 ? 0.8 : 0.4) * ((right ? 1 : 0) - e)));
  qs.answered++; qs.done[x.id] = right; qs.open = null; if (!right) qs.retry[x.id] = qs.answered + 5;
  let streakUp = false;
  if (right) { qs.streak++; qs.best = Math.max(qs.best, qs.streak); streakUp = qs.streak % 5 === 0; qs.misses = 0; } else { qs.streak = 0; qs.misses++; }
  const words = x.text.split(/\s+/).length;
  return { retry: false, right, rightChoice, evidence: x.question.evidence, explain: x.question.explain, streak: qs.streak, streakUp, coins: right ? Math.max(1, Math.ceil(words / 100)) : 0, bonus: streakUp ? qs.streak / 5 : 0, pending: false, levelBefore: Math.floor(before) + 1, me: qme(pool) };
}
function mockQuestReport() {
  const d = (n: number) => { const x = new Date(); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10); };
  return { rating: 2.8, level: 3, answered: 64, percent30: 78, answered30: 41, percentAll: 75, streak: 3, bestStreak: 11, wpm: 118, minutes: 52,
    history: Array.from({ length: 21 }, (_, i) => ({ day: d(20 - i), rating: Math.round((1 + i * 0.09 + Math.sin(i) * 0.15) * 10) / 10 })),
    types: [{ type: 'detail', answered: 20, right: 18, percent: 90 }, { type: 'main-idea', answered: 11, right: 8, percent: 73 }, { type: 'vocabulary', answered: 9, right: 7, percent: 78 }, { type: 'inference', answered: 12, right: 6, percent: 50 }, { type: 'sequence', answered: 6, right: 5, percent: 83 }, { type: 'cause-effect', answered: 6, right: 4, percent: 67 }],
    bands: [{ grade: 0, answered: 9, percent: 100 }, { grade: 1, answered: 14, percent: 86 }, { grade: 2, answered: 20, percent: 75 }, { grade: 3, answered: 15, percent: 60 }, { grade: 4, answered: 6, percent: 50 }],
    recent: [], pool: 300, left: 236 };
}
