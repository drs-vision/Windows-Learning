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
    private readonly CoinQuest.Guardian.Rwt.RwtService _rwt;
    private readonly CoinQuest.Guardian.DiscGames.DiscGameService _discs;
    private readonly ILogger<RequestRouter> _log;
    private readonly Dictionary<string, (string account, DateTimeOffset expires)> _tokens = new();

    private readonly CoinQuest.Guardian.Phone.PhoneLinkService _phones;
    public event Action? StateChanged;      // something a child UI should refresh
    public event Action? ApprovalsChanged;  // something a parent UI should refresh

    public RequestRouter(HouseholdStore store, Ledger ledger, ScoreEngine scorer, UnlockManager unlocks, SessionMonitor session,
        BrowserPolicy policy, UpdateChecker updates, YouTubeService youtube, FlashpointService fp, ClassicsStocker stocker, ClassicLibrary lib, NetGate gate, NetLock netLock, CoinQuest.Guardian.Rwt.RwtService rwt, CoinQuest.Guardian.DiscGames.DiscGameService discs, CoinQuest.Guardian.Phone.PhoneLinkService phones, ILogger<RequestRouter> log)
    { _phones = phones; phones.Handler = HandlePhone; StateChanged += phones.NoteChange; ApprovalsChanged += phones.NoteChange; _rwt = rwt; rwt.ProgressSaved += PayRwt; _discs = discs; discs.ProgressSaved += PayDisc; discs.RwtImporter = rwt.ImportNow; _fp = fp; _stocker = stocker; _gate = gate; _lib = lib; _netLock = netLock; _store = store; _ledger = ledger; _scorer = scorer; _unlocks = unlocks; _session = session; _policy = policy; _updates = updates; _youtube = youtube; _log = log; }

    /// <summary>
    /// Requests that wait on the network or the disk run side by side; everything else (ledger, settings, timers)
    /// runs one at a time, because the ledger's database connection and the stores are not built for parallel use.
    /// </summary>
    private static readonly HashSet<string> Slow = new()
    {
        Ops.ArcadePrepare, Ops.ArcadeClassicFile, Ops.YouTubeLibrary, Ops.YouTubeCheck, Ops.YouTubeChannel, Ops.ParentYouTubeResolve, Ops.ParentCheckUpdate, Ops.ParentInstalledApps, Ops.SetupAccounts,
        Ops.ParentFpStatus, Ops.ParentFpSearch, Ops.ParentFpSuggest, Ops.ParentFpInstallClifp, Ops.ParentFpDownloadInstaller, Ops.ParentFpThumbs, Ops.ParentFpStockNow, Ops.ParentBlocked, Ops.ParentDiagnostics, Ops.ParentRwtImport, Ops.RwtLaunch, Ops.ParentDiscImport, Ops.ParentDiscSetupBegin, Ops.ParentDiscSetupFinish, Ops.DiscLaunch, Ops.ParentDiscRemove,
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
            Ops.ArcadeReportBroken => child is null ? Response.Fail(req.Id, "not a managed account") : ReportBroken(req, child, client),
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
            Ops.ParentRwtStatus => Parent(req, client, child, () => _rwt.Status()),
            Ops.ParentRwtImport => Parent(req, client, child, () => { _rwt.StartImport(Str(req, "path")); return _rwt.Status(); }),
            Ops.RwtLaunch => RwtLaunch(req, child),
            Ops.ParentDiscStatus => Parent(req, client, child, () => _discs.Status()),
            Ops.ParentDiscImport => Parent(req, client, child, () => { _discs.StartImport(Str(req, "path"), req.Payload?["useInstaller"]?.GetValue<bool>() == true); return _discs.Status(); }),
            Ops.ParentDiscSetupBegin => Parent(req, client, child, () => _discs.BeginSetup(Str(req, "id"))),
            Ops.ParentDiscSetupFinish => Parent(req, client, child, () => _discs.FinishSetup(Str(req, "id"), OptStr(req, "folder"), OptStr(req, "program"))),
            Ops.ParentPhoneLink => Parent(req, client, child, () => _phones.Create(OptStr(req, "name") ?? "Phone", _store.Current.Name)),
            Ops.ParentPhoneLinks => Parent(req, client, child, () => _phones.List()),
            Ops.ParentPhoneUnlink => Parent(req, client, child, () => _phones.Remove(Str(req, "id"))),
            Ops.ParentDiscCoins => Parent(req, client, child, () => _discs.SetCoins(Str(req, "id"), req.Payload?["coins"] is System.Text.Json.Nodes.JsonValue cv && cv.TryGetValue<int>(out var c) ? c : null)),
            Ops.ParentDiscHide => Parent(req, client, child, () => _discs.SetHidden(Str(req, "id"), req.Payload?["hidden"]?.GetValue<bool>() == true)),
            Ops.ParentDiscRemove => Parent(req, client, child, () => _discs.Remove(Str(req, "id"))),
            Ops.DiscLaunch => DiscLaunch(req, child),
            Ops.ParentDiagnostics => Parent(req, client, child, () => new { version = Version, problems = CoinQuest.Guardian.FileLoggerProvider.Recent(), blocked = _gate.RecentlyBlocked().Take(20).Select(b => b.Host), internetLock = _netLock.Status, net = NetCheck().GetAwaiter().GetResult(), system = SystemCheck() }),
            Ops.ParentBlocked => Parent(req, client, child, () => _gate.RecentlyBlocked().Select(b => new { host = b.Host, at = b.At, reason = b.Reason })),
            Ops.ParentFpStatus => Parent(req, client, child, () => FpStatus()),
            Ops.ParentFpStockNow => Parent(req, client, child, () => { _stocker.Tick(force: true); return FpStatus(); }),
            Ops.ParentFpSearch => Parent(req, client, child, () => _fp.Root(FirstChild()?.Arcade.FlashpointRoot) is { } r ? _fp.Search(r, Str(req, "q"))
                : _lib.Search(Str(req, "q"), 40).GetAwaiter().GetResult().Where(g => ClassicLibrary.Playable(g.Platform)).ToList()),
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
            rwtInstalled = CoinQuest.Guardian.Rwt.RwtService.Installed,
            discGames = CoinQuest.Guardian.DiscGames.DiscGameService.Games().Where(g => g.Mode != "pending" && !g.Hidden).Select(g => new { g.Id, g.Title }),
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
        // The daily limit caps earning; a negative amount (a parent's negative rate) is charged in full.
        var coins = outcome.Coins < 0 ? outcome.Coins : Math.Min(outcome.Coins, room);
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
            if (coins != 0) _ledger.Append(child.Id, LedgerKind.Earn, coins, moduleId, outcome.Detail, account);
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

    /// <summary>Where the game and the 16-bit helper are, for the shell to start them. Child (if the quest is on) or parent.</summary>
    private Response RwtLaunch(Request req, Child? child)
    {
        if (!CoinQuest.Guardian.Rwt.RwtService.Installed) return Response.Fail(req.Id, "Read, Write & Type! hasn't been imported yet — a parent can do it in the Parent Console → Quests.");
        if (child is not null && child.Modules.GetValueOrDefault("rwt") is { Enabled: false }) return Response.Fail(req.Id, "Read, Write & Type! is switched off — ask a parent");
        var otvdm = CoinQuest.Guardian.Rwt.RwtService.Otvdm;
        if (otvdm is null)
        {
            try { _rwt.EnsureOtvdm().GetAwaiter().GetResult(); otvdm = CoinQuest.Guardian.Rwt.RwtService.Otvdm; }
            catch (Exception ex) { return Response.Fail(req.Id, "Couldn't get the 16-bit helper (otvdm): " + ex.Message); }
        }
        if (otvdm is null) return Response.Fail(req.Id, "the 16-bit helper (otvdm) is missing");
        if (!CoinQuest.Guardian.Rwt.VcRuntime.Present)
            try { _rwt.EnsureRuntime().GetAwaiter().GetResult(); }
            catch (Exception ex) { return Response.Fail(req.Id, "Read, Write & Type! needs a Microsoft component that couldn't be installed: " + ex.Message); }
        _log.LogInformation("Read, Write & Type! started ({Who})", child?.DisplayName ?? "parent");
        return Response.Success(req.Id, new { otvdm, root = CoinQuest.Guardian.Rwt.RwtService.Root, exe = @"cd\RWTWINCD.EXE", data = "SIGNIN", cwd = "cd" });
    }

    /// <summary>Where a classic CD game's program is, for the shell to start it. Child (if the quest is on) or parent.</summary>
    private Response DiscLaunch(Request req, Child? child)
    {
        var g = CoinQuest.Guardian.DiscGames.DiscGameService.Find(Str(req, "id"));
        if (g is null) return Response.Fail(req.Id, "That game isn't imported on this computer — a parent can add it in the Parent Console → Quests.");
        if (child is not null && g.Hidden) return Response.Fail(req.Id, $"{g.Title} is switched off — ask a parent");
        if (g.Mode == "pending") return Response.Fail(req.Id, $"{g.Title} needs setting up first — a parent can do it in the Parent Console → Quests → Classic CD games.");
        if (child is not null && child.Modules.GetValueOrDefault("discgames") is { Enabled: false }) return Response.Fail(req.Id, "Classic CD games are switched off — ask a parent");
        var exe = CoinQuest.Guardian.DiscGames.DiscGameService.ProgramPath(g);
        string? drive = null;
        if (g.Mode == "installed" && g.Iso is { } iso && File.Exists(iso))
        {
            try { drive = CoinQuest.Guardian.DiscGames.DiscGameService.Mount(iso); } // "put the disc in the drive"
            catch (Exception ex) { return Response.Fail(req.Id, "Couldn't put the game's disc in the virtual drive: " + ex.Message); }
            try { _discs.PointAtDrive(g, drive); } catch (Exception ex) { _log.LogWarning(ex, "Couldn't point {Id} at {Drive}", g.Id, drive); }
        }
        var kind = CoinQuest.Guardian.DiscGames.DiscGameService.ExeKind(exe);
        if (kind == "dos") return Response.Fail(req.Id, $"{g.Title} is a DOS program — CoinQuest can't run those yet.");
        string? otvdm = null;
        if (kind == "ne")
        {
            otvdm = CoinQuest.Guardian.Rwt.RwtService.Otvdm;
            if (otvdm is null)
                try { _rwt.EnsureOtvdm().GetAwaiter().GetResult(); otvdm = CoinQuest.Guardian.Rwt.RwtService.Otvdm; }
                catch (Exception ex) { return Response.Fail(req.Id, "Couldn't get the 16-bit helper (otvdm): " + ex.Message); }
            if (!CoinQuest.Guardian.Rwt.VcRuntime.Present)
                try { _rwt.EnsureRuntime().GetAwaiter().GetResult(); }
                catch (Exception ex) { return Response.Fail(req.Id, "This 16-bit game needs a Microsoft component that couldn't be installed: " + ex.Message); }
        }
        _log.LogInformation("{Title} started ({Who}) {Kind}{Drive}", g.Title, child?.DisplayName ?? "parent", kind, drive is null ? "" : " disc in " + drive);
        var app = Path.Combine(CoinQuest.Guardian.DiscGames.DiscGameService.Root, g.Id, "app");
        return Response.Success(req.Id, new
        {
            id = g.Id, title = g.Title, exe, cwd = CoinQuest.Guardian.DiscGames.DiscGameService.WorkDir(g), args = g.Args ?? "", kind, otvdm = otvdm ?? "", drive = drive ?? "",
            ini = g.Mode == "copy" ? Path.Combine(app, g.Ini) : "", userDir = g.UserDir ?? "",
        });
    }

    private void PayDisc(List<string> what)
    {
        lock (_sync)
        {
            var child = _session.Current?.Child ?? _store.Current.Children.FirstOrDefault();
            if (child is null) return;
            var s = child.Modules.GetValueOrDefault("discgames") ?? new ModuleSettings { CoinsPerActivity = 5, DailyCap = 60 };
            if (!s.Enabled) return;
            // Each game pays its own rate (set per game by a parent), else the Classic CD games rate.
            var games = CoinQuest.Guardian.DiscGames.DiscGameService.Games();
            var due = what.Select(w => games.FirstOrDefault(g => w.StartsWith(g.Title + ":", StringComparison.Ordinal)))
                          .GroupBy(g => g?.Id).Sum(grp => grp.First()?.Coins ?? s.CoinsPerActivity);
            var room = s.DailyCap > 0 ? Math.Max(0, s.DailyCap - _ledger.EarnedToday(child.Id, "discgames")) : due;
            var coins = due < 0 ? due : Math.Min(due, room); // negative rates (a parent's choice) are charged in full
            if (coins == 0) return;
            _ledger.Append(child.Id, LedgerKind.Earn, coins, "discgames", string.Join("; ", what), "discgames");
            _log.LogInformation("Classic CD progress for {Child}: +{Coins}", child.DisplayName, coins);
            AfterChange();
        }
    }

    /// <summary>Facts for troubleshooting "access denied": who the service runs as, whether it can write its own folder,
    /// and which accounts the internet lock covers.</summary>
    private List<string> SystemCheck()
    {
        var lines = new List<string>();
        try
        {
            using (var imp = System.Security.Principal.WindowsIdentity.GetCurrent(true))
                if (imp is not null) lines.Add($"this request was acting as {imp.Name} — switching back");
            PipeServer.RevertToSelf();
            using var id = System.Security.Principal.WindowsIdentity.GetCurrent();
            lines.Add($"service runs as {id.Name} ({id.User?.Value}){(id.IsSystem ? "" : " — NOT the system account (check Services → CoinQuest Guardian → Log On: Local System)")}");
        }
        catch (Exception ex) { lines.Add("identity: " + ex.Message); }
        try
        {
            var probe = Path.Combine(CoinQuest.Shared.Config.Paths.DataRoot, "write-test.tmp");
            File.WriteAllText(probe, DateTime.Now.ToString("o")); File.Delete(probe);
            lines.Add("can write C:\\ProgramData\\CoinQuest: yes");
        }
        catch (Exception ex) { lines.Add("can write C:\\ProgramData\\CoinQuest: NO — " + ex.Message); }
        try
        {
            var f = Path.Combine(CoinQuest.Shared.Config.Paths.DataRoot, "unlocks.json");
            if (File.Exists(f)) lines.Add("unlocks.json: " + new FileInfo(f).Attributes + " · " + new FileInfo(f).GetAccessControl().GetSecurityDescriptorSddlForm(System.Security.AccessControl.AccessControlSections.Access));
        }
        catch (Exception ex) { lines.Add("unlocks.json: " + ex.Message); }
        foreach (var c in _store.Current.Children) lines.Add($"internet lock covers {c.DisplayName}: {c.WindowsAccount} {c.WindowsSid}");
        try
        {
            using var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows Defender\Windows Defender Exploit Guard\Controlled Folder Access");
            if (key?.GetValue("EnableControlledFolderAccess") is int cfa) lines.Add("Windows ransomware protection (Controlled folder access): " + (cfa == 1 ? "ON" : cfa == 2 ? "audit" : "off"));
        }
        catch { }
        return lines;
    }

    /// <summary>Can this computer's CoinQuest service reach the sites YouTube, the arcade and RWT need?</summary>
    private static async Task<List<object>> NetCheck()
    {
        var sites = new (string Name, string Url)[]
        {
            ("YouTube", "https://www.youtube.com/"), ("Arcade games", "https://infinity.flashpointarchive.org/"),
            ("Game search", "https://db-api.unstable.life/"), ("Updates & RWT helper", "https://api.github.com/"), ("Phone link relay", CoinQuest.Guardian.Phone.PhoneLinkService.Relay + "/v1/health"),
        };
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("CoinQuest/1.0");
        var tasks = sites.Select(async s =>
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                using var r = await http.GetAsync(s.Url, HttpCompletionOption.ResponseHeadersRead);
                return (object)new { site = s.Name, ok = (int)r.StatusCode < 500, detail = $"HTTP {(int)r.StatusCode} in {sw.ElapsedMilliseconds} ms" };
            }
            catch (Exception ex)
            {
                var e = ex; while (e.InnerException is not null) e = e.InnerException;
                return new { site = s.Name, ok = false, detail = $"{ex.GetType().Name}: {e.Message}" };
            }
        });
        return (await Task.WhenAll(tasks)).ToList();
    }

    private void PayRwt(List<string> players)
    {
        lock (_sync)
        {
            var child = _session.Current?.Child ?? _store.Current.Children.FirstOrDefault();
            if (child is null) return;
            var s = child.Modules.GetValueOrDefault("rwt") ?? new ModuleSettings { CoinsPerActivity = 5, DailyCap = 60 };
            if (!s.Enabled) return;
            var room = s.DailyCap > 0 ? Math.Max(0, s.DailyCap - _ledger.EarnedToday(child.Id, "rwt")) : s.CoinsPerActivity;
            var coins = s.CoinsPerActivity < 0 ? s.CoinsPerActivity : Math.Min(s.CoinsPerActivity, room);
            if (coins == 0) return;
            _ledger.Append(child.Id, LedgerKind.Earn, coins, "rwt", $"Read, Write & Type!: progress saved ({string.Join(", ", players)})", "rwt");
            _log.LogInformation("RWT progress for {Child}: +{Coins}", child.DisplayName, coins);
            AfterChange();
        }
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
    private Response ReportBroken(Request req, Child child, PipeServer.Client client)
    {
        var gameId = Str(req, "gameId");
        var game = Arcade.Catalog(child).FirstOrDefault(g => g.Id == gameId);
        if (game is null) return Response.Fail(req.Id, "no such game");
        _store.Update(h => h with { Children = h.Children.Select(c => c.Id != child.Id || c.Arcade.Hidden.Contains(gameId) ? c : c with { Arcade = c.Arcade with { Hidden = c.Arcade.Hidden.Append(gameId).ToList() } }).ToList() });

        // Give back what was paid for this game's current time: it didn't work, so it shouldn't cost anything.
        // (A sampler pass isn't refunded — it still works for every other game.)
        var refund = 0;
        var running = _unlocks.ActiveFor(child.Id).FirstOrDefault(u => u.Kind == PrizeKind.ArcadeUnlock && u.Targets.Contains(gameId));
        if (running is not null)
        {
            refund = -_ledger.Recent(child.Id, 200, running.StartedAt.AddSeconds(-5))
                .Where(e => e.Kind == LedgerKind.Spend && e.Source == "arcade:" + gameId).Sum(e => e.Delta);
            _unlocks.End(running.Id);
            if (refund > 0) _ledger.Append(child.Id, LedgerKind.Adjust, refund, "arcade:" + gameId, $"Refund: {game.Title} didn't work", client.Account);
        }
        _log.LogWarning("Reported broken and hidden from the arcade: {Title} ({Id}); refunded {Refund}", game.Title, gameId, refund);
        AfterChange();
        return Response.Success(req.Id, new { ok = true, refund, balance = _ledger.Balance(child.Id) });
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

    /// <summary>
    /// A request from a linked parent phone (already unscrambled with that phone's key, so it is the parent).
    /// A phone can see coins and history, give or take coins, answer requests, start or end time, and change quests,
    /// shop prizes (including website and app time), allowed websites, apps and YouTube channels. Never the parent
    /// PIN, the internet lock, updates, or who is a managed child.
    /// </summary>
    private object? HandlePhone(string op, System.Text.Json.Nodes.JsonObject args, string actor)
    {
        // Looking up a YouTube channel waits on the internet: do it before taking the lock.
        YouTubeChannel? channel = op == "addChannel" ? _youtube.Resolve(args["url"]?.GetValue<string>() ?? "").GetAwaiter().GetResult() : null;
        // Reading the Start menu takes a moment and touches no CoinQuest state: no lock either.
        if (op == "apps")
            return new { result = InstalledApps.Scan().Where(a => !Allowlist.Browsers.Contains(a.Exe, StringComparer.OrdinalIgnoreCase))
                .GroupBy(a => a.Exe, StringComparer.OrdinalIgnoreCase).Select(g => new { name = g.First().Name, exe = g.Key }).OrderBy(a => a.name).ToList() };
        lock (_sync)
        {
            var req = new Request { Id = "phone", Op = op, Payload = args.DeepClone() };
            object? result = op switch
            {
                "state" => null,
                "adjust" => Adjust(req, actor),
                "claim" => ResolveClaim(req, actor),
                "endUnlock" => new { ok = _unlocks.End(Str(req, "unlockId")) },
                "config" => PhoneConfig(),
                "history" => PhoneHistory(Str(req, "childId"), req.Payload?["before"]?.GetValue<long>()),
                "setQuest" => PhoneSetQuest(req),
                "setPrize" => PhoneSetPrize(req),
                "deletePrize" => PhoneEditChild(Str(req, "childId"), c => c with { Prizes = c.Prizes.Where(p => p.Id != Str(req, "id")).ToList() }),
                "setSites" => PhoneSetSites(req),
                "setApps" => PhoneSetApps(req),
                "grant" => PhoneGrant(req, actor),
                "addChannel" => PhoneEditChild(Str(req, "childId"), c => c.YouTubeChannels.Any(x => x.Id == channel!.Id) ? c : c with { YouTubeChannels = c.YouTubeChannels.Append(channel!).ToList() }),
                "removeChannel" => PhoneEditChild(Str(req, "childId"), c => c with { YouTubeChannels = c.YouTubeChannels.Where(x => x.Id != Str(req, "id")).ToList() }),
                _ => throw new InvalidOperationException("CoinQuest on the PC doesn't know that yet — update it"),
            };
            if (op == "endUnlock") AfterChange();
            if (op != "state") _log.LogInformation("Phone ({Actor}): {Op}", actor, op);
            return new { result, state = PhoneState() };
        }
    }

    // ---- phone: settings a parent can change from anywhere (never the PIN, internet lock, apps or updates) ----

    private object PhoneConfig() => new
    {
        children = _store.Current.Children.Select(c => new
        {
            id = c.Id,
            name = c.DisplayName,
            modules = c.Modules.Select(kv => new { id = kv.Key, enabled = kv.Value.Enabled, coinsPerActivity = kv.Value.CoinsPerActivity, dailyCap = kv.Value.DailyCap, requireApproval = kv.Value.RequireApproval, options = kv.Value.Options, earnedToday = _ledger.EarnedToday(c.Id, kv.Key) }).ToList(),
            prizes = c.Prizes.Select(p => new { id = p.Id, name = p.Name, cost = p.Cost, kind = p.Kind.ToString(), minutes = p.Minutes, dailyCap = p.DailyCap, enabled = p.Enabled, targets = p.Targets }).ToList(),
            sites = c.Allowlist.Sites,
            apps = c.Allowlist.Apps.Select(a => Path.GetFileName(a)).ToList(),
            channels = c.YouTubeChannels.Select(y => new { id = y.Id, title = y.Title, url = y.Url }).ToList(),
        }).ToList(),
    };

    private object PhoneHistory(string childId, long? before)
    {
        var page = _ledger.Page(childId, before, 40);
        return new
        {
            entries = page.Select(e => new { seq = e.Seq, at = e.At, kind = e.Kind.ToString(), delta = e.Delta, source = e.Source, detail = e.Detail, actor = e.ActorAccount }).ToList(),
            more = page.Count == 40,
        };
    }

    private object PhoneEditChild(string childId, Func<Child, Child> change)
    {
        if (_store.Current.Children.All(c => c.Id != childId)) throw new ArgumentException("That child isn't on this PC");
        _store.Update(h => h with { Children = h.Children.Select(c => c.Id == childId ? change(c) : c).ToList() });
        _policy.Invalidate();
        AfterChange();
        return PhoneConfig();
    }

    private object PhoneSetQuest(Request req)
    {
        var moduleId = Str(req, "moduleId");
        var p = req.Payload!;
        int? Int(string k) => p[k] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<int>(out var i) ? i : null;
        bool? Bool(string k) => p[k] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;
        return PhoneEditChild(Str(req, "childId"), c =>
        {
            if (!c.Modules.TryGetValue(moduleId, out var m)) throw new ArgumentException("That quest isn't on this PC");
            var options = new Dictionary<string, string>(m.Options);
            if (p["options"] is System.Text.Json.Nodes.JsonObject o)
                foreach (var (k, v) in o) if (options.ContainsKey(k) && v is System.Text.Json.Nodes.JsonValue jv) options[k] = jv.ToString();
            var next = m with
            {
                Enabled = Bool("enabled") ?? m.Enabled,
                CoinsPerActivity = Int("coinsPerActivity") is { } cpa ? Math.Clamp(cpa, -1000, 1000) : m.CoinsPerActivity,
                DailyCap = Int("dailyCap") is { } cap ? Math.Clamp(cap, 0, 100000) : m.DailyCap,
                RequireApproval = Bool("requireApproval") ?? m.RequireApproval,
                Options = options,
            };
            return c with { Modules = new Dictionary<string, ModuleSettings>(c.Modules) { [moduleId] = next } };
        });
    }

    private object PhoneSetPrize(Request req)
    {
        var p = req.Payload?["prize"] as System.Text.Json.Nodes.JsonObject ?? throw new ArgumentException("prize required");
        var id = p["id"]?.GetValue<string>();
        var name = (p["name"]?.GetValue<string>() ?? "").Trim();
        if (name.Length == 0) throw new ArgumentException("Give the prize a name");
        var cost = Math.Clamp(p["cost"]?.GetValue<int>() ?? 0, 0, 100000);
        var minutes = Math.Clamp(p["minutes"]?.GetValue<int>() ?? 0, 0, 600);
        var cap = Math.Clamp(p["dailyCap"]?.GetValue<int>() ?? 0, 0, 100);
        var enabled = p["enabled"]?.GetValue<bool>() ?? true;
        var targetsIn = p["targets"] is System.Text.Json.Nodes.JsonArray ta ? ta.Select(x => x?.GetValue<string>() ?? "").Where(x => x.Trim().Length > 0).ToList() : null;
        List<string> Targets(PrizeKind kind)
        {
            var t = (targetsIn ?? new()).Select(x => kind == PrizeKind.SiteUnlock ? SiteDomain(x) : AppExe(x)).Distinct(StringComparer.OrdinalIgnoreCase).Take(30).ToList();
            if (t.Count == 0) throw new ArgumentException(kind == PrizeKind.SiteUnlock ? "Add at least one website" : "Pick at least one app");
            return t;
        }
        return PhoneEditChild(Str(req, "childId"), c =>
        {
            var list = c.Prizes.ToList();
            var i = id is null ? -1 : list.FindIndex(x => x.Id == id);
            if (i >= 0)
            {
                var old = list[i];
                var targets = old.Kind is PrizeKind.SiteUnlock or PrizeKind.AppUnlock && targetsIn is not null ? Targets(old.Kind) : old.Targets;
                list[i] = old with { Name = name, Cost = cost, Minutes = old.Kind == PrizeKind.RealWorld ? old.Minutes : Math.Max(1, minutes), DailyCap = cap, Enabled = enabled, Targets = targets };
            }
            else
            {
                // Arcade prizes stay on the PC (they need the game list); everything else can be made here.
                var kind = Enum.TryParse<PrizeKind>(p["kind"]?.GetValue<string>(), true, out var k) && k != PrizeKind.ArcadeUnlock ? k : PrizeKind.RealWorld;
                var targets = kind is PrizeKind.SiteUnlock or PrizeKind.AppUnlock ? Targets(kind) : new List<string>();
                list.Add(new Prize { Name = name, Cost = cost, Kind = kind, Minutes = kind == PrizeKind.RealWorld ? 0 : Math.Max(5, minutes), DailyCap = cap, Enabled = enabled, Targets = targets });
            }
            return c with { Prizes = list };
        });
    }

    /// <summary>"https://www.Duolingo.com/learn" → "duolingo.com".</summary>
    private static string SiteDomain(string s)
    {
        s = s.Trim().ToLowerInvariant();
        if (s.Contains("://")) s = s[(s.IndexOf("://", StringComparison.Ordinal) + 3)..];
        s = s.Split('/', '?', '#')[0].Split(':')[0];
        if (s.StartsWith("www.")) s = s[4..];
        if (s.Length < 3 || !s.Contains('.') || s.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '.' or '-'))) throw new ArgumentException($"“{s}” doesn't look like a website address");
        return s;
    }

    /// <summary>"Minecraft", "minecraft.exe" or a full path → "Minecraft.exe". Web browsers are refused (they'd get round the internet lock).</summary>
    private static string AppExe(string s)
    {
        s = Path.GetFileName(s.Trim().Trim('"'));
        if (!s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) s += ".exe";
        if (s.Length < 5 || s.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new ArgumentException($"“{s}” doesn't look like a program name");
        if (Allowlist.Browsers.Contains(s, StringComparer.OrdinalIgnoreCase)) throw new ArgumentException($"{s} is a web browser — those stay blocked so the internet lock holds. Add websites instead.");
        return s;
    }

    private object PhoneSetApps(Request req)
    {
        var add = req.Payload?["add"] is System.Text.Json.Nodes.JsonArray a ? a.Select(x => AppExe(x?.GetValue<string>() ?? "")).ToList() : new();
        var remove = req.Payload?["remove"]?.GetValue<string>();
        return PhoneEditChild(Str(req, "childId"), c =>
        {
            var apps = c.Allowlist.Apps.ToList();
            foreach (var x in add) if (!apps.Any(y => Path.GetFileName(y).Equals(x, StringComparison.OrdinalIgnoreCase))) apps.Add(x);
            if (remove is { Length: > 0 }) apps.RemoveAll(y => Path.GetFileName(y).Equals(remove, StringComparison.OrdinalIgnoreCase));
            return c with { Allowlist = c.Allowlist with { Apps = apps } };
        });
    }

    /// <summary>Start a prize's time right now, free (a parent's gift) — or add to it if it's already running.</summary>
    private object PhoneGrant(Request req, string actor)
    {
        var child = _store.Current.Children.FirstOrDefault(c => c.Id == Str(req, "childId")) ?? throw new ArgumentException("That child isn't on this PC");
        var prize = child.Prizes.FirstOrDefault(p => p.Id == Str(req, "prizeId")) ?? throw new ArgumentException("That prize isn't on this PC any more");
        if (prize.Kind == PrizeKind.RealWorld) throw new ArgumentException("Treats don't run on the PC");
        var minutes = Math.Clamp(req.Payload?["minutes"]?.GetValue<int>() ?? prize.Minutes, 1, 600);
        var unlock = _unlocks.Start(child, prize with { Minutes = minutes });
        _log.LogInformation("Phone ({Actor}) started {Prize} for {Child}: {Minutes} min, free", actor, prize.Name, child.DisplayName, minutes);
        AfterChange();
        return new { unlockId = unlock.Id };
    }

    private object PhoneSetSites(Request req)
    {
        var add = req.Payload?["add"]?.GetValue<string>();
        var remove = req.Payload?["remove"]?.GetValue<string>();
        return PhoneEditChild(Str(req, "childId"), c =>
        {
            var sites = c.Allowlist.Sites.ToList();
            if (add is { Length: > 0 }) { var d = SiteDomain(add); if (!sites.Contains(d)) sites.Add(d); }
            if (remove is { Length: > 0 }) sites.RemoveAll(x => x.Equals(remove, StringComparison.OrdinalIgnoreCase));
            return c with { Allowlist = c.Allowlist with { Sites = sites } };
        });
    }

    /// <summary>What the phone shows: each child's coins, today's coins in and out, time running, and requests waiting.</summary>
    private object PhoneState()
    {
        var h = _store.Current;
        var today = new DateTimeOffset(DateTimeOffset.Now.Date);
        return new
        {
            household = h.Name,
            version = Version,
            at = DateTimeOffset.UtcNow,
            atKeyboard = _session.Current?.Child.Id,
            children = h.Children.Select(c =>
            {
                var recent = _ledger.Recent(c.Id, 200, today);
                return new
                {
                    id = c.Id,
                    name = c.DisplayName,
                    balance = _ledger.Balance(c.Id),
                    earnedToday = recent.Where(e => e.Delta > 0).Sum(e => e.Delta),
                    spentToday = -recent.Where(e => e.Delta < 0).Sum(e => e.Delta),
                    unlocks = _unlocks.ActiveFor(c.Id).Select(u => new { id = u.Id, name = u.PrizeName, secondsLeft = u.SecondsLeft }).ToList(),
                    recent = recent.OrderByDescending(e => e.Seq).Take(12)
                        .Select(e => new { at = e.At, delta = e.Delta, what = e.Detail.Length > 0 ? e.Detail : e.Source }).ToList(),
                };
            }).ToList(),
            claims = _ledger.PendingClaims().Select(p => new
            {
                seq = p.LedgerSeq, childId = p.ChildId, child = h.Children.FirstOrDefault(c => c.Id == p.ChildId)?.DisplayName ?? "",
                coins = p.Coins, what = p.Detail.Length > 0 ? p.Detail : p.ModuleId, at = p.At,
            }).ToList(),
        };
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
