using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinQuest.Guardian.Economy;
using CoinQuest.Guardian.Enforcement;
using CoinQuest.Guardian.Native;
using CoinQuest.Guardian.Setup;
using CoinQuest.Guardian.Updates;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Ipc;
using CoinQuest.Shared.Ledgers;
using CoinQuest.Shared.Models;
using CoinQuest.Shared.Scoring;

namespace CoinQuest.Guardian.Ipc;

/// <summary>Turns requests into ledger entries, unlocks and household changes. All the rules live here.</summary>
public sealed class RequestRouter
{
    private readonly HouseholdStore _store;
    private readonly Ledger _ledger;
    private readonly ScoreEngine _scorer;
    private readonly UnlockManager _unlocks;
    private readonly SessionMonitor _session;
    private readonly BrowserPolicy _policy;
    private readonly UpdateChecker _updates;
    private readonly YouTubeService _youtube;
    private readonly FlashpointService _fp;
    private readonly ClassicsStocker _stocker;
    private readonly NetGate _gate;
    private readonly ClassicLibrary _lib;
    private readonly NetLock _netLock;
    private readonly ILogger<RequestRouter> _log;
    private readonly Dictionary<string, (string account, DateTimeOffset expires)> _tokens = new();

    public event Action? StateChanged;      // something a child UI should refresh
    public event Action? ApprovalsChanged;  // something a parent UI should refresh

    public RequestRouter(HouseholdStore store, Ledger ledger, ScoreEngine scorer, UnlockManager unlocks, SessionMonitor session,
        BrowserPolicy policy, UpdateChecker updates, YouTubeService youtube, FlashpointService fp, ClassicsStocker stocker, ClassicLibrary lib, NetGate gate, NetLock netLock, ILogger<RequestRouter> log)
    { _fp = fp; _stocker = stocker; _gate = gate; _lib = lib; _netLock = netLock; _store = store; _ledger = ledger; _scorer = scorer; _unlocks = unlocks; _session = session; _policy = policy; _updates = updates; _youtube = youtube; _log = log; }

    /// <summary>
    /// Requests that wait on the network or the disk run side by side; everything else (ledger, settings, timers)
    /// runs one at a time, because the ledger's database connection and the stores are not built for parallel use.
    /// </summary>
    private static readonly HashSet<string> Slow = new()
    {
        Ops.ArcadePrepare, Ops.ArcadeClassicFile, Ops.YouTubeLibrary, Ops.YouTubeCheck, Ops.YouTubeChannel, Ops.ParentYouTubeResolve, Ops.ParentCheckUpdate, Ops.ParentInstalledApps, Ops.SetupAccounts,
        Ops.ParentFpStatus, Ops.ParentFpSearch, Ops.ParentFpSuggest, Ops.ParentFpInstallClifp, Ops.ParentFpDownloadInstaller, Ops.ParentFpThumbs, Ops.ParentFpStockNow, Ops.ParentBlocked, Ops.ParentDiagnostics,
    };
    private readonly object _sync = new();

    public Task<Response> Handle(Request req, PipeServer.Client client)
    {
        if (Slow.Contains(req.Op)) return HandleCore(req, client);
        lock (_sync) return HandleCore(req, client);
    }

    private Task<Response> HandleCore(Request req, PipeServer.Client client)
    {
        var child = _store.FindChildByAccount(client.Account);
        return Task.FromResult(req.Op switch
        {
            Ops.Hello => Response.Success(req.Id, new { version = Version, account = client.Account, isAdmin = client.IsAdmin, childId = child?.Id, setupNeeded = !_store.HasPin }),

            // ---- child ----
            Ops.State => child is null ? Response.Fail(req.Id, "not a managed account") : Response.Success(req.Id, ChildState(child)),
            Ops.Submit => child is null ? Response.Fail(req.Id, "not a managed account") : Submit(req, child, client.Account),
            Ops.Buy => child is null ? Response.Fail(req.Id, "not a managed account") : Buy(req, child, client.Account),
            Ops.Progress => child is null ? Response.Fail(req.Id, "not a managed account") : SaveProgress(req, child),
            Ops.ArcadeList => child is null ? Response.Success(req.Id, new { games = Array.Empty<object>() })
                : ArcadeList(req, child),
            Ops.ArcadeQuit => child is null ? Response.Fail(req.Id, "not a managed account") : ArcadeQuit(req, child),
            Ops.ArcadePlay => child is null ? Response.Fail(req.Id, "not a managed account") : ArcadePlay(req, child, client.Account),
            Ops.ArcadePrepare => child is null ? Response.Fail(req.Id, "not a managed account") : ArcadePrepare(req, child),
            Ops.ArcadeClassicFile => child is null ? Response.Fail(req.Id, "not a managed account") : ClassicFile(req, child),
            Ops.ArcadeReportBroken => child is null ? Response.Fail(req.Id, "not a managed account") : ReportBroken(req, child),
            Ops.ArcadeSampler => child is null ? Response.Fail(req.Id, "not a managed account") : ArcadeSampler(req, child, client.Account),
            Ops.YouTubeLibrary => child is null ? Response.Fail(req.Id, "not a managed account") : Response.Success(req.Id, _youtube.Library(child).GetAwaiter().GetResult()),
            Ops.YouTubeChannel => child is null ? Response.Fail(req.Id, "not a managed account")
                : Response.Success(req.Id, _youtube.ChannelPage(child, Str(req, "channelId"), OptStr(req, "next")).GetAwaiter().GetResult()),
            Ops.YouTubeCheck => child is null ? Response.Fail(req.Id, "not a managed account")
                : Response.Success(req.Id, new { allowed = _unlocks.ActiveFor(child.Id).Any(u => u.Kind == PrizeKind.YouTube) && _youtube.IsAllowed(child, Str(req, "videoId")).GetAwaiter().GetResult() }),

            // ---- parent ----
            Ops.ParentLogin => ParentLogin(req, client),
            Ops.ParentState => Parent(req, client, child, () => ParentState()),
            Ops.ParentUpdateChild => Parent(req, client, child, () => UpdateChild(req)),
            Ops.ParentResolveClaim => Parent(req, client, child, () => ResolveClaim(req, client.Account)),
            Ops.ParentAdjust => Parent(req, client, child, () => Adjust(req, client.Account)),
            Ops.ParentSetPin => Parent(req, client, child, () => { _store.SetPin(Str(req, "pin")); return new { ok = true }; }),
            Ops.ParentInstalledApps => Parent(req, client, child, () => InstalledApps.Scan()),
            Ops.ParentCheckUpdate => Parent(req, client, child, () => _updates.CheckNow().GetAwaiter().GetResult()),
            Ops.ParentEndUnlock => Parent(req, client, child, () => { var ok = _unlocks.End(Str(req, "unlockId")); AfterChange(); return new { ok }; }),
            Ops.ParentVersion => Response.Success(req.Id, new { version = Version, status = _updates.Status }),
            Ops.ParentYouTubeResolve => Parent(req, client, child, () => _youtube.Resolve(Str(req, "url")).GetAwaiter().GetResult()),
            Ops.ParentArcadeCatalog => Parent(req, client, child, () => FirstChild() is { } c ? new { games = Arcade.Catalog(c), settings = c.Arcade } : new { games = new List<Arcade.Game>(), settings = new ArcadeSettings() }),
            Ops.ParentArcadeUpload => Parent(req, client, child, () => Arcade.Upload(FirstChild() ?? throw new InvalidOperationException("set up a child first"),
                Str(req, "fileName"), Str(req, "data"), req.Payload?["title"]?.GetValue<string>(), req.Payload?["strategy"]?.GetValue<int>() ?? 3)),
            Ops.ParentDiagnostics => Parent(req, client, child, () => new { version = Version, problems = CoinQuest.Guardian.FileLoggerProvider.Recent(), blocked = _gate.RecentlyBlocked().Take(20).Select(b => b.Host), internetLock = _netLock.Status }),
            Ops.ParentBlocked => Parent(req, client, child, () => _gate.RecentlyBlocked().Select(b => new { host = b.Host, at = b.At, reason = b.Reason })),
            Ops.ParentFpStatus => Parent(req, client, child, () => FpStatus()),
            Ops.ParentFpStockNow => Parent(req, client, child, () => { _stocker.Tick(force: true); return FpStatus(); }),
            Ops.ParentFpSearch => Parent(req, client, child, () => _fp.Root(FirstChild()?.Arcade.FlashpointRoot) is { } r ? _fp.Search(r, Str(req, "q"))
                : _lib.Search(Str(req, "q"), 40).GetAwaiter().GetResult().Where(g => g.Platform == "Flash").ToList()),
            Ops.ParentFpSuggest => Parent(req, client, child, () => FpSuggest()),
            Ops.ParentFpInstallClifp => Parent(req, client, child, () => { _fp.InstallClifp(FpRoot()).GetAwaiter().GetResult(); _stocker.Tick(force: true); return FpStatus(); }),
            Ops.ParentFpDownloadInstaller => Parent(req, client, child, () => DownloadFpInstaller()),
            Ops.ParentFpThumbs => Parent(req, client, child, () =>
            {
                var root = _fp.Root(FirstChild()?.Arcade.FlashpointRoot);
                var ids = req.Payload?["ids"]?.AsArray().Select(n => n!.GetValue<string>()).ToList() ?? new();
                return ids.ToDictionary(id => id, id => _fp.Thumb(root, id).GetAwaiter().GetResult() is { } f ? $"https://coinquest-thumbs.local/{f}" : "");
            }),
            Ops.ParentArcadeRemove => Parent(req, client, child, () => { Arcade.RemoveUpload(Str(req, "gameId")); return new { ok = true }; }),

            // ---- setup ----
            Ops.SetupAccounts => Setup(req, client, () => LocalAccounts.List()),
            Ops.SetupComplete => Setup(req, client, () => SetupComplete(req)),

            _ => Response.Fail(req.Id, $"unknown op {req.Op}")
        });
    }

    public static string Version => typeof(RequestRouter).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    // ---------------------------------------------------------------- child

    private object ChildState(Child child)
    {
        var today = DateTimeOffset.Now.Date;
        return new
        {
            child = new { child.Id, child.DisplayName },
            balance = _ledger.Balance(child.Id),
            unlocks = _unlocks.ActiveFor(child.Id).Select(u => new { u.Id, u.Kind, u.Targets, u.PrizeName, u.ExpiresAt, u.SecondsLeft }),
            prizes = child.Prizes.Where(p => p.Enabled).Select(p => new { p.Id, p.Name, p.Cost, p.Kind, p.Minutes, p.DailyCap, boughtToday = _ledger.PurchasesToday(child.Id, p.Id),
                blockPrice = p.Kind == PrizeKind.YouTube ? YouTubeBlockPrice(child, p) : (int?)null, blockMinutes = ArcadeSettings.BlockMinutes }),
            modules = child.Modules.ToDictionary(kv => kv.Key, kv => new { kv.Value.Enabled, kv.Value.CoinsPerActivity, kv.Value.DailyCap, kv.Value.RequireApproval, kv.Value.Options, earnedToday = _ledger.EarnedToday(child.Id, kv.Key) }),
            recent = _ledger.Recent(child.Id, 30, new DateTimeOffset(today)),
            pendingClaims = _ledger.PendingClaims(child.Id),
            progress = ProgressStore.LoadAll(child.Id),
            sites = child.Allowlist.Sites,
            youtubeChannels = child.YouTubeChannels.Count,
            arcadeMinutesPerPlay = child.Arcade.MinutesPerPlay,
        };
    }

    private Response Submit(Request req, Child child, string account)
    {
        var moduleId = Str(req, "moduleId");
        if (!child.Modules.TryGetValue(moduleId, out var settings) || !settings.Enabled)
            return Response.Fail(req.Id, "that quest isn't turned on");

        var settingsNode = JsonSerializer.SerializeToNode(settings, HouseholdStore.Json);
        var outcome = _scorer.Score(moduleId, req.Payload?["activity"], req.Payload?["result"], settingsNode);
        if (!outcome.Valid)
        {
            _log.LogWarning("Rejected submission for {Module} from {Account}: {Reason}", moduleId, account, outcome.Reason);
            return Response.Fail(req.Id, outcome.Reason ?? "that didn't check out");
        }

        var earnedToday = _ledger.EarnedToday(child.Id, moduleId);
        var room = settings.DailyCap > 0 ? Math.Max(0, settings.DailyCap - earnedToday) : int.MaxValue;
        var coins = Math.Min(outcome.Coins, room);
        var capped = coins < outcome.Coins;

        object result;
        if (outcome.NeedsApproval || settings.RequireApproval)
        {
            var claim = _ledger.FileClaim(child.Id, moduleId, coins, outcome.Detail, account);
            ApprovalsChanged?.Invoke();
            result = new { coins, pending = true, capped, detail = outcome.Detail, claimSeq = claim.LedgerSeq, balance = _ledger.Balance(child.Id) };
        }
        else
        {
            if (coins > 0) _ledger.Append(child.Id, LedgerKind.Earn, coins, moduleId, outcome.Detail, account);
            result = new { coins, pending = false, capped, detail = outcome.Detail, balance = _ledger.Balance(child.Id) };
        }

        if (outcome.ProgressDelta is not null) ProgressStore.Merge(child.Id, moduleId, outcome.ProgressDelta);
        AfterChange();
        return Response.Success(req.Id, result);
    }

    private Response Buy(Request req, Child child, string account)
    {
        var prizeId = Str(req, "prizeId");
        var prize = child.Prizes.FirstOrDefault(p => p.Id == prizeId && p.Enabled);
        if (prize is null) return Response.Fail(req.Id, "that prize isn't available");
        if (prize.Kind == PrizeKind.YouTube)
        {
            // Like the arcade: "+" buys 5-minute blocks (priced above the arcade).
            var blocks = Math.Clamp(req.Payload?["blocks"]?.GetValue<int>() ?? Math.Max(1, prize.Minutes / ArcadeSettings.BlockMinutes), 1, ArcadeSettings.MaxBlocks);
            prize = prize with { Cost = YouTubeBlockPrice(child, prize) * blocks, Minutes = blocks * ArcadeSettings.BlockMinutes, Name = $"{blocks * ArcadeSettings.BlockMinutes} minutes of YouTube" };
        }
        var balance = _ledger.Balance(child.Id);
        if (balance < prize.Cost) return Response.Fail(req.Id, $"you need {prize.Cost - balance} more coins");
        if (prize.DailyCap > 0 && _ledger.PurchasesToday(child.Id, prizeId) >= prize.DailyCap) return Response.Fail(req.Id, "you've had that one enough for today");
        if (prize.Kind == PrizeKind.YouTube && child.YouTubeChannels.Count == 0) return Response.Fail(req.Id, "no YouTube channels are set up yet — ask a parent");

        _ledger.Append(child.Id, LedgerKind.Spend, -prize.Cost, prize.Id, prize.Name, account);
        Unlock? unlock = null;
        if (prize.Minutes > 0 && prize.Kind != PrizeKind.RealWorld) unlock = _unlocks.Start(child, prize);
        if (prize.Kind == PrizeKind.RealWorld) ApprovalsChanged?.Invoke();
        AfterChange();
        return Response.Success(req.Id, new { balance = _ledger.Balance(child.Id), unlock });
    }

    private int YouTubeBlockPrice(Child child, Prize p) =>
        ArcadeSettings.YouTubeBlockPrice(p, Arcade.Catalog(child).Where(g => !g.Hidden && g.Available).Select(g => g.Price));

    /// <summary>"*" = sampler pass (any game).</summary>
    private Unlock? ArcadeTime(Child child, string gameId) =>
        _unlocks.ActiveFor(child.Id).Where(u => u.Kind == PrizeKind.ArcadeUnlock && (u.Targets.Contains(gameId) || u.Targets.Contains("*")))
            .OrderByDescending(u => u.ExpiresAt).FirstOrDefault();

    private int SamplerPrice(Child child) =>
        child.Arcade.SamplerPrice > 0 ? child.Arcade.SamplerPrice
            : ArcadeSettings.AutoSamplerPrice(Arcade.Catalog(child).Where(g => !g.Hidden && g.Available).Select(g => g.Price), child.Arcade.SamplerMinutes);

    /// <summary>Buy blocks × 5 minutes of one game (or resume time already bought / use a running sampler pass).</summary>
    private Response ArcadePlay(Request req, Child child, string account)
    {
        var gameId = Str(req, "gameId");
        var blocks = Math.Clamp(req.Payload?["blocks"]?.GetValue<int>() ?? 1, 0, ArcadeSettings.MaxBlocks);
        var game = Arcade.Catalog(child).FirstOrDefault(g => g.Id == gameId && !g.Hidden && g.Available);
        if (game is null) return Response.Fail(req.Id, "that game isn't in the arcade");
        var fpRoot = game.Kind == "flashpoint" ? _fp.Root(child.Arcade.FlashpointRoot) : null;

        var running = ArcadeTime(child, game.Id);
        if (blocks == 0)
        {
            if (running is null) return Response.Fail(req.Id, "add some time first (press +)");
            return Response.Success(req.Id, new { balance = _ledger.Balance(child.Id), unlock = running, game, flashpointRoot = fpRoot, alreadyPlaying = true });
        }
        var cost = game.Price * blocks;
        var balance = _ledger.Balance(child.Id);
        if (balance < cost) return Response.Fail(req.Id, $"you need {cost - balance} more coins");
        var minutes = blocks * ArcadeSettings.BlockMinutes;
        _ledger.Append(child.Id, LedgerKind.Spend, -cost, "arcade:" + game.Id, $"Arcade: {minutes} min of {game.Title}", account);
        // Same game again = more time on the same clock.
        var unlock = _unlocks.Start(child, new Prize { Id = "arcade:" + game.Id, Name = game.Title, Kind = PrizeKind.ArcadeUnlock, Targets = new() { game.Id }, Minutes = minutes });
        AfterChange();
        return Response.Success(req.Id, new { balance = _ledger.Balance(child.Id), unlock, game, flashpointRoot = fpRoot });
    }

    private Response ArcadeSampler(Request req, Child child, string account)
    {
        var cost = SamplerPrice(child);
        var balance = _ledger.Balance(child.Id);
        if (balance < cost) return Response.Fail(req.Id, $"you need {cost - balance} more coins");
        _ledger.Append(child.Id, LedgerKind.Spend, -cost, "arcade:sampler", $"Arcade: {child.Arcade.SamplerMinutes}-minute sampler pass", account);
        var unlock = _unlocks.Start(child, new Prize { Id = "arcade:sampler", Name = "Sampler pass", Kind = PrizeKind.ArcadeUnlock, Targets = new() { "*" }, Minutes = child.Arcade.SamplerMinutes });
        AfterChange();
        return Response.Success(req.Id, new { balance = _ledger.Balance(child.Id), unlock });
    }

    /// <summary>Get a classic's files ready (downloads them the first time) and say where the player loads it from.</summary>
    private Response ArcadePrepare(Request req, Child child)
    {
        var gameId = Str(req, "gameId");
        var game = Arcade.Catalog(child).FirstOrDefault(g => g.Id == gameId && !g.Hidden && g.Kind == "classic");
        if (game is null) return Response.Fail(req.Id, "that game isn't in the arcade");
        try { return Response.Success(req.Id, _lib.Prepare(game.Url).GetAwaiter().GetResult()); }
        catch (Exception ex) { _log.LogWarning(ex, "Couldn't get {Title} ready", game.Title); return Response.Fail(req.Id, $"Couldn't get {game.Title} ready: {ex.Message}"); }
    }

    /// <summary>The player asks for a file a classic needs that isn't on disk yet. Only for classics in this child's arcade.</summary>
    private Response ClassicFile(Request req, Child child)
    {
        var fpId = Str(req, "fpId");
        if (!child.Arcade.Flashpoint.Any(f => f.Id == fpId)) return Response.Fail(req.Id, "not in the arcade");
        var local = _lib.FetchFile(fpId, Str(req, "host"), Str(req, "path")).GetAwaiter().GetResult();
        return Response.Success(req.Id, new { ok = local is not null });
    }

    /// <summary>"This game doesn't work": hide it from the arcade. It shows as hidden in the Parent Console, which can bring it back.</summary>
    private Response ReportBroken(Request req, Child child)
    {
        var gameId = Str(req, "gameId");
        var game = Arcade.Catalog(child).FirstOrDefault(g => g.Id == gameId);
        if (game is null) return Response.Fail(req.Id, "no such game");
        _store.Update(h => h with { Children = h.Children.Select(c => c.Id != child.Id || c.Arcade.Hidden.Contains(gameId) ? c : c with { Arcade = c.Arcade with { Hidden = c.Arcade.Hidden.Append(gameId).ToList() } }).ToList() });
        _log.LogWarning("Reported broken and hidden from the arcade: {Title} ({Id})", game.Title, gameId);
        AfterChange();
        return Response.Success(req.Id, new { ok = true });
    }

    private Response ArcadeList(Request req, Child child)
    {
        var plays = _ledger.ArcadePlays(child.Id);
        var games = Arcade.Catalog(child).Where(g => !g.Hidden && g.Available).Select(g => g with { Plays = plays.GetValueOrDefault(g.Id) });
        return Response.Success(req.Id, new
        {
            games, blockMinutes = ArcadeSettings.BlockMinutes, maxBlocks = ArcadeSettings.MaxBlocks,
            sampler = new { minutes = child.Arcade.SamplerMinutes, price = SamplerPrice(child) },
            flashpointRoot = child.Arcade.Flashpoint.Count > 0 ? _fp.Root(child.Arcade.FlashpointRoot) : null,
        });
    }

    private object FpStatus()
    {
        var c = FirstChild();
        var root = _fp.Root(c?.Arcade.FlashpointRoot);
        return new
        {
            installed = true, online = root is null, root, clifp = true, installerUrl = FlashpointService.InstallerUrl,
            autoClassics = c?.Arcade.AutoClassics ?? true, approved = c?.Arcade.Flashpoint.Count ?? 0, stock = _stocker.Status,
        };
    }

    private Child? FirstChild() => _store.Current.Children.FirstOrDefault();

    private string FpRoot() => _fp.Root(FirstChild()?.Arcade.FlashpointRoot) ?? throw new InvalidOperationException("Flashpoint isn't installed yet.");

    private object FpSuggest()
    {
        var root = _fp.Root(FirstChild()?.Arcade.FlashpointRoot);
        if (root is null)
        {
            // Online catalog: list what's already in the arcade (the stocker adds the curated picks by itself).
            return (FirstChild()?.Arcade.Flashpoint ?? new()).Select(f => new
            {
                pick = new Classics.Pick(f.Title, f.Genre, f.Strategy),
                game = new FlashpointService.FpGame(f.Id, f.Title, f.Developer, "", "Flash", "", "", "", ""),
                approved = true,
            }).ToList();
        }
        var approved = FirstChild()?.Arcade.Flashpoint.Select(f => f.Id).ToHashSet() ?? new();
        return Classics.List.Select(p =>
        {
            var hit = _stocker.Match(root, p);
            return new { pick = p, game = hit, approved = hit is not null && approved.Contains(hit.Id) };
        }).Where(x => x.game is not null).ToList();
    }

    private object DownloadFpInstaller()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonDocuments), "..", "Downloads");
        dir = Path.GetFullPath(dir);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "FlashpointInstaller.exe");
        using var http = new HttpClient();
        File.WriteAllBytes(path, http.GetByteArrayAsync(FlashpointService.InstallerUrl).GetAwaiter().GetResult());
        return new { path };
    }

    /// <summary>Leaving a game doesn't throw away time already paid for: it keeps counting down and he can jump back in.</summary>
    private Response ArcadeQuit(Request req, Child child)
    {
        AfterChange();
        return Response.Success(req.Id, new { ok = true });
    }

    private Response SaveProgress(Request req, Child child)
    {
        var moduleId = Str(req, "moduleId");
        if (req.Payload?["progress"] is { } p) ProgressStore.Save(child.Id, moduleId, p);
        return Response.Success(req.Id);
    }

    // ---------------------------------------------------------------- parent

    private Response ParentLogin(Request req, PipeServer.Client client)
    {
        var pin = Str(req, "pin");
        if (!_store.VerifyPin(pin))
        {
            var locked = _store.Current.PinLockedUntil is { } u && u > DateTimeOffset.UtcNow;
            return Response.Fail(req.Id, locked ? "too many tries — wait 5 minutes" : "wrong PIN");
        }
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        lock (_tokens) { _tokens[token] = (client.Account, DateTimeOffset.UtcNow.AddMinutes(30)); }
        return Response.Success(req.Id, new { token, expiresInSeconds = 1800 });
    }

    /// <summary>A parent op is allowed with a valid PIN token, or from an administrator account that is not itself a managed child.</summary>
    private Response Parent(Request req, PipeServer.Client client, Child? callerIsChild, Func<object?> action)
    {
        var ok = false;
        if (req.Token is not null)
            lock (_tokens) ok = _tokens.TryGetValue(req.Token, out var t) && t.account == client.Account && t.expires > DateTimeOffset.UtcNow;
        if (!ok && client.IsAdmin && callerIsChild is null) ok = true;
        if (!ok) { _log.LogInformation("Parent request {Op} refused: PIN required ({Account})", req.Op, client.Account); return Response.Fail(req.Id, "parent PIN required"); }
        return Response.Success(req.Id, action());
    }

    private object ParentState()
    {
        var h = _store.Current;
        var today = new DateTimeOffset(DateTimeOffset.Now.Date);
        return new
        {
            household = new { h.Id, h.Name, children = h.Children },
            pendingClaims = _ledger.PendingClaims(),
            perChild = h.Children.ToDictionary(c => c.Id, c => new
            {
                balance = _ledger.Balance(c.Id),
                today = _ledger.Recent(c.Id, 200, today),
                unlocks = _unlocks.ActiveFor(c.Id),
                earnedToday = c.Modules.Keys.ToDictionary(m => m, m => _ledger.EarnedToday(c.Id, m)),
            }),
            activeChildId = _session.Current?.Child.Id,
            version = Version,
            updateStatus = _updates.Status,
            ledgerIntact = _ledger.Verify() is null,
            enforcement = new
            {
                consoleAccount = _session.ConsoleAccount,
                childAtKeyboard = _session.Current is not null,
                childAccount = h.Children.FirstOrDefault()?.WindowsAccount,
                childSid = h.Children.FirstOrDefault()?.WindowsSid,
                browserLock = _policy.Status,
                internetLock = _netLock.Status,
            },
        };
    }

    private object UpdateChild(Request req)
    {
        var incoming = req.Payload?["child"]?.Deserialize<Child>(HouseholdStore.Json) ?? throw new ArgumentException("child required");
        _store.Update(h =>
        {
            var list = h.Children.ToList();
            var i = list.FindIndex(c => c.Id == incoming.Id);
            var sid = incoming.WindowsSid;
            if (string.IsNullOrEmpty(sid) && !string.IsNullOrEmpty(incoming.WindowsAccount)) sid = Wts.SidForAccount(incoming.WindowsAccount) ?? "";
            var fixedUp = incoming with { WindowsSid = sid };
            if (i >= 0) list[i] = fixedUp; else list.Add(fixedUp);
            return h with { Children = list };
        });
        _policy.Invalidate();
        AfterChange();
        _log.LogInformation("Settings saved for {Child}: {Sites} sites, {Apps} apps, {Channels} channels, {Classics} classics",
            incoming.DisplayName, incoming.Allowlist.Sites.Count, incoming.Allowlist.Apps.Count, incoming.YouTubeChannels.Count, incoming.Arcade.Flashpoint.Count);
        return new { ok = true };
    }

    private object ResolveClaim(Request req, string actor)
    {
        var seq = req.Payload?["seq"]?.GetValue<long>() ?? throw new ArgumentException("seq required");
        var approve = req.Payload?["approve"]?.GetValue<bool>() ?? false;
        int? coins = req.Payload?["coins"]?.GetValue<int>();
        var entry = _ledger.ResolveClaim(seq, approve, actor, coins);
        ApprovalsChanged?.Invoke();
        AfterChange();
        return new { ok = entry is not null, entry };
    }

    private object Adjust(Request req, string actor)
    {
        var childId = Str(req, "childId");
        var delta = req.Payload?["delta"]?.GetValue<int>() ?? 0;
        var reason = req.Payload?["reason"]?.GetValue<string>() ?? "Parent adjustment";
        if (delta == 0) throw new ArgumentException("delta required");
        _ledger.Append(childId, LedgerKind.Adjust, delta, "parent", reason, actor);
        AfterChange();
        return new { balance = _ledger.Balance(childId) };
    }

    // ---------------------------------------------------------------- setup

    private Response Setup(Request req, PipeServer.Client client, Func<object?> action)
    {
        if (_store.HasPin) return Response.Fail(req.Id, "already set up — use the Parent Console");
        if (!client.IsAdmin) return Response.Fail(req.Id, "setup must run from an administrator account");
        return Response.Success(req.Id, action());
    }

    private object SetupComplete(Request req)
    {
        var pin = Str(req, "pin");
        var displayName = req.Payload?["child"]?["displayName"]?.GetValue<string>() ?? "Kid";
        var account = req.Payload?["child"]?["windowsAccount"]?.GetValue<string>() ?? throw new ArgumentException("windowsAccount required");
        var preset = req.Payload?["preset"]?.GetValue<string>() ?? "school";
        var sid = Wts.SidForAccount(account) ?? throw new ArgumentException($"Windows account '{account}' not found");
        if (pin.Length is < 4 or > 8 || !pin.All(char.IsDigit)) throw new ArgumentException("PIN must be 4–8 digits");

        LocalAccounts.EnsureStandardUser(account);

        var child = new Child { DisplayName = displayName, WindowsAccount = account, WindowsSid = sid, Allowlist = Allowlist.SchoolBasics() };
        _store.Update(h => h with { Children = new List<Child> { child } });
        _store.SetPin(pin);
        _policy.Invalidate();
        AfterChange();
        _log.LogInformation("Setup complete for {Child} ({Account})", displayName, account);
        return new { ok = true, childId = child.Id };
    }

    // ---------------------------------------------------------------- helpers

    private void AfterChange()
    {
        if (_session.Current is { } s) _policy.Apply(_store.FindChild(s.Child.Id) ?? s.Child);
        StateChanged?.Invoke();
    }

    private static string? OptStr(Request req, string key) => req.Payload?[key] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;

    private static string Str(Request req, string key) =>
        req.Payload?[key]?.GetValue<string>() ?? throw new ArgumentException($"{key} required");
}
