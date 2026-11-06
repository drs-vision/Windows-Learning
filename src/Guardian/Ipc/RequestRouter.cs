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
using CoinQuest.Shared.Locks;
using CoinQuest.Shared.Models;
using CoinQuest.Shared.Scoring;

namespace CoinQuest.Guardian.Ipc;

/// <summary>Turns requests into ledger entries, unlocks and household changes. All the rules live here.</summary>
public sealed class RequestRouter
{
    private readonly HouseholdStore _store;
    private readonly CoinQuest.Shared.Activity.ActivityStore _activity = new();
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
        Ops.ArcadePrepare, Ops.ArcadeClassicFile, Ops.YouTubeLibrary, Ops.YouTubeCheck, Ops.YouTubeChannel, Ops.ParentYouTubeResolve, Ops.ParentCheckUpdate, Ops.ParentInstalledApps, Ops.SetupAccounts, Ops.SetupCreateAccount, Ops.ParentAccounts, Ops.ParentCreateAccount, Ops.ParentAddChild, Ops.ParentRemoveChild,
        Ops.ParentFpStatus, Ops.ParentFpSearch, Ops.ParentFpSuggest, Ops.ParentFpInstallClifp, Ops.ParentFpDownloadInstaller, Ops.ParentFpThumbs, Ops.ParentFpStockNow, Ops.ParentBlocked, Ops.ParentDiagnostics, Ops.ParentRwtImport, Ops.RwtLaunch, Ops.ParentDiscImport, Ops.ParentDiscSetupBegin, Ops.ParentDiscSetupFinish, Ops.DiscLaunch, Ops.ParentDiscRemove,
    };
    private readonly object _sync = new();
    private static readonly HashSet<string> WhileLocked = new() { Ops.Hello, Ops.State, Ops.LockAsk, Ops.ActivityTick, Ops.AdsState };

    public Task<Response> Handle(Request req, PipeServer.Client client)
    {
        if (Slow.Contains(req.Op)) return HandleCore(req, client);
        lock (_sync) return HandleCore(req, client);
    }

    private Task<Response> HandleCore(Request req, PipeServer.Client client)
    {
        var child = _store.FindChildByAccount(client.Account);
        // A locked profile can only show its lock screen, ask to be opened, and let a parent in.
        if (child is not null && ProfileLockRules.Now(child.Lock, DateTimeOffset.Now).Locked && !WhileLocked.Contains(req.Op) && !req.Op.StartsWith("parent.") && !req.Op.StartsWith("setup."))
            return Task.FromResult(Response.Fail(req.Id, "locked"));
        return Task.FromResult(req.Op switch
        {
            Ops.LockAsk => child is null ? Response.Fail(req.Id, "only a child account can ask") : Response.Success(req.Id, LockAsk(child, client.Account)),
            Ops.ParentLock => Parent(req, client, child, () => ParentLock(req)),
            Ops.Hello => Response.Success(req.Id, new { version = Version, account = client.Account, isAdmin = client.IsAdmin, childId = child?.Id, setupNeeded = !_store.HasPin }),

            // ---- child ----
            Ops.State => child is null ? Response.Fail(req.Id, "not a managed account") : Response.Success(req.Id, ChildState(child)),
            Ops.Submit => child is null ? Response.Fail(req.Id, "not a managed account") : Submit(req, child, client.Account),
            Ops.BooksList or Ops.BooksChapter or Ops.BooksRead or Ops.BooksQuiz or Ops.BooksGrade or Ops.BooksBonus or Ops.BooksBonusAnswer or Ops.BooksTyped
                => child is null ? Response.Fail(req.Id, "not a managed account") : Response.Success(req.Id, Books(req, child, client.Account)),
            Ops.ActivityTick => child is null ? Response.Success(req.Id, new { ok = false }) : ActivityTick(req, child),
            Ops.AdsState => child is null ? Response.Success(req.Id, new { allowed = Array.Empty<string>(), pending = Array.Empty<string>() }) : Response.Success(req.Id, AdsState(child)),
            Ops.AdsRequest => child is null ? Response.Fail(req.Id, "only a child account can ask") : Response.Success(req.Id, AdsRequest(req, child, client.Account)),
            // Only CoinQuest's own kid app (checked by its program file, which the child can't change) may open a page's parts.
            Ops.PageParts => client.IsKidApp
                ? Response.Success(req.Id, new { allowed = _gate.AllowPageParts(Str(req, "site"), (req.Payload?["hosts"] as JsonArray)?.Select(h => h?.GetValue<string>() ?? "") ?? Enumerable.Empty<string>()) })
                : Response.Fail(req.Id, "only CoinQuest's own window can ask for that"),
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
            Ops.ParentArcadeCatalog => Parent(req, client, child, () => ChildFor(req) is { } c ? new { games = Arcade.Catalog(c), settings = c.Arcade } : new { games = new List<Arcade.Game>(), settings = new ArcadeSettings() }),
            Ops.ParentArcadeUpload => Parent(req, client, child, () => Arcade.Upload(ChildFor(req) ?? throw new InvalidOperationException("set up a child first"),
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
            Ops.ParentBooks => Parent(req, client, child, () => ParentBooks(req)),
            Ops.ParentBooksReset => Parent(req, client, child, () => ResetBook(req)),
            Ops.ParentReading => Parent(req, client, child, () => ReadingAnalysis(req)),
            Ops.ParentQuest => Parent(req, client, child, () => QuestReport(req)),
            Ops.QuestState or Ops.QuestNext or Ops.QuestAnswer
                => child is null ? Response.Fail(req.Id, "not a managed account") : Response.Success(req.Id, Quest(req, child, client.Account)),
            Ops.ParentActivity => Parent(req, client, child, () => ActivityDays(Str(req, "childId"), Str(req, "from"), Str(req, "to"))),
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
            Ops.SetupCreateAccount => Setup(req, client, () => CreateAccount(req)),
            Ops.ParentAccounts => Parent(req, client, child, () => LocalAccounts.List().Select(a => new { a.Name, a.FullName, a.IsAdmin, a.Disabled, a.Sid,
                usedBy = _store.Current.Children.FirstOrDefault(c => c.WindowsSid == a.Sid || string.Equals(Bare(c.WindowsAccount), a.Name, StringComparison.OrdinalIgnoreCase))?.DisplayName })),
            Ops.ParentCreateAccount => Parent(req, client, child, () => CreateAccount(req)),
            Ops.ParentAddChild => Parent(req, client, child, () => AddChild(req)),
            Ops.ParentRemoveChild => Parent(req, client, child, () => RemoveChild(req)),

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
            locked = LockInfo(child),
        };
    }

    // ---- full profile lock: nothing opens (apps, quests, arcade, websites) while it's on ------------------------------

    private const string LockModule = "open-profile";

    private object? LockInfo(Child c)
    {
        var st = ProfileLockRules.Now(c.Lock, DateTimeOffset.Now);
        return st.Locked ? new { until = st.Until, scheduled = st.Scheduled, asked = _ledger.PendingClaims(c.Id).Any(p => p.ModuleId == LockModule) } : null;
    }

    /// <summary>What a parent's screens show: locked now (and until), and the schedule.</summary>
    private object LockSummary(Child c)
    {
        var st = ProfileLockRules.Now(c.Lock, DateTimeOffset.Now);
        return new { locked = st.Locked, until = st.Until, scheduled = st.Scheduled, schedule = c.Lock.Schedule };
    }

    private object LockAsk(Child child, string account)
    {
        if (!ProfileLockRules.Now(child.Lock, DateTimeOffset.Now).Locked) return new { ok = true, already = "open" };
        if (_ledger.PendingClaims(child.Id).Any(p => p.ModuleId == LockModule)) return new { ok = true, already = "asked" };
        _ledger.FileClaim(child.Id, LockModule, 0, $"Open {child.DisplayName}'s computer", account);
        ApprovalsChanged?.Invoke();
        AfterChange();
        return new { ok = true };
    }

    /// <summary>Lock now (for some minutes, or until opened), open now, or set the schedule. Parent Console (PIN) and phones.</summary>
    private object ParentLock(Request req)
    {
        var id = Str(req, "childId");
        if (_store.Current.Children.All(c => c.Id != id)) throw new ArgumentException("That child isn't on this PC");
        var now = DateTimeOffset.Now;
        var action = OptStr(req, "action");
        int? minutes = req.Payload?["minutes"] is JsonValue mv && mv.TryGetValue<int>(out var m) && m > 0 ? m : null;
        List<LockTime>? schedule = null;
        if (req.Payload?["schedule"] is JsonArray arr)
            schedule = arr.Select(n => n is null ? null : new LockTime
            {
                Days = (n["days"] as JsonArray)?.Select(d => d?.GetValue<int>() ?? -1).Where(d => d is >= 0 and <= 6).Distinct().OrderBy(d => d).ToList() ?? new(),
                From = n["from"]?.GetValue<string>() ?? "",
                To = n["to"]?.GetValue<string>() ?? "",
            }).Where(t => t is not null && t.Days.Count > 0 && ProfileLockRules.TryTime(t.From, out var f) && ProfileLockRules.TryTime(t.To, out var to) && f != to).Select(t => t!).Take(20).ToList();
        EditChild(id, c =>
        {
            var l = c.Lock;
            if (schedule is not null) l = l with { Schedule = schedule };
            if (action == "lock") l = ProfileLockRules.LockFor(l, now, minutes);
            else if (action == "open") l = ProfileLockRules.Open(l, now);
            // An open that has run out is just clutter.
            if (l.OpenUntil is { } o && o <= now) l = l with { OpenUntil = null };
            if (l.Until is { } u && u <= now) l = l with { Until = null };
            return c with { Lock = l };
        });
        if (action == "open") ResolveLockAsks(id, true);
        if (action == "lock") _log.LogInformation("Profile locked for {Child} ({Minutes})", id, minutes?.ToString() ?? "until opened");
        var kid = _store.FindChild(id)!;
        return LockSummary(kid);
    }

    /// <summary>Opening the profile answers the kid's "please open it" request too.</summary>
    private void ResolveLockAsks(string childId, bool approve)
    {
        foreach (var p in _ledger.PendingClaims(childId).Where(p => p.ModuleId == LockModule).ToList())
            try { _ledger.ResolveClaim(p.LedgerSeq, approve, "parent", 0); } catch { }
        ApprovalsChanged?.Invoke();
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

        // "Each passage pays N times a day" (or only the first time ever): after that it still counts as practice, without coins.
        var repeatLimited = false;
        var repeats = settings.Options.GetValueOrDefault("repeatsPerDay", "");
        if (outcome.RepeatKey is { Length: > 0 } rk && outcome.Coins > 0)
        {
            if (repeats == "ever" && _ledger.TimesEver(child.Id, moduleId, rk + " ·") > 0)
            {
                repeatLimited = true;
                outcome = outcome with { Coins = 0, Detail = $"{outcome.Detail} · already earned (practice)" };
            }
            else if (int.TryParse(repeats, out var perDay) && perDay > 0 && _ledger.TimesToday(child.Id, moduleId, rk + " ·") >= perDay)
            {
                repeatLimited = true;
                outcome = outcome with { Coins = 0, Detail = $"{outcome.Detail} · already earned {(perDay == 1 ? "once" : perDay == 2 ? "twice" : perDay + " times")} today" };
            }
        }
        // Lessons and drills pay only the first time: redoing one (to practise, or to pass it) earns nothing. Checked
        // against the ledger, so it holds for everything done before this rule too and can't be reset from the kid's side.
        if (!repeatLimited && outcome.OnceKey is { Length: > 0 } ok && outcome.Coins > 0 && _ledger.TimesEver(child.Id, moduleId, ok + " ·") > 0)
        {
            repeatLimited = true;
            outcome = outcome with { Coins = 0, Detail = $"{outcome.Detail} · already earned (practice)" };
        }

        // Scripture and the family's own passages are one quest to a parent: one daily limit for both.
        var earnedToday = moduleId is "bible-typing" or "my-passages"
            ? _ledger.EarnedToday(child.Id, "bible-typing") + _ledger.EarnedToday(child.Id, "my-passages")
            : _ledger.EarnedToday(child.Id, moduleId);
        var room = settings.DailyCap > 0 ? Math.Max(0, settings.DailyCap - earnedToday) : int.MaxValue;
        // The daily limit caps earning; a negative amount (a parent's negative rate) is charged in full.
        var coins = outcome.Coins < 0 ? outcome.Coins : Math.Min(outcome.Coins, room);
        var capped = coins < outcome.Coins;

        object result;
        if ((outcome.NeedsApproval || settings.RequireApproval) && !repeatLimited)
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
        if (child.ActivityReports) NoteDone(child, moduleId, req.Payload?["result"], outcome);
        AfterChange();
        return Response.Success(req.Id, result);
    }

    // ---- reading (books) ------------------------------------------------------------------------------------------

    private readonly CoinQuest.Shared.Books.BookLibrary _library = new(Path.Combine(Paths.ContentRoot, "books"));
    private readonly Random _rng = new();
    private static readonly JsonSerializerOptions ProgressJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static ModuleSettings BookSettings(Child c) => c.Modules.GetValueOrDefault("books") ?? ModuleSettings.Defaults()["books"];

    /// <summary>null = every book; otherwise the ids a parent ticked.</summary>
    private static HashSet<string>? AllowedBooks(ModuleSettings s)
    {
        var a = s.Options.GetValueOrDefault("allowed", "*");
        if (a == "*") return null;
        try { return JsonSerializer.Deserialize<List<string>>(a)?.ToHashSet() ?? new(); } catch { return new(); }
    }

    /// <summary>The whole library for choosing books, with how far this child has got in each.</summary>
    private object ParentBooks(Request req)
    {
        var childId = req.Payload?["childId"]?.GetValue<string>();
        var all = childId is null ? null : ProgressStore.Load(childId, "books") as JsonObject;
        int Passed(string book) => all is null ? 0 : all.Count(kv => kv.Key.StartsWith(book + "/") && kv.Value?["passed"]?.GetValue<bool>() == true);
        bool Started(string book) => all is not null && all.Any(kv => kv.Key.StartsWith(book + "/"));
        return new
        {
            books = _library.Books().Select(b => new
            {
                id = b.Id, title = b.Title, author = b.Author, published = b.Published, level = b.Level,
                grade = new { min = b.Grade.Min, max = b.Grade.Max, label = b.Grade.Label },
                summary = b.Summary, edited = b.Edited, chapters = b.Chapters.Count, words = b.Chapters.Sum(c => c.Words),
                measures = b.Measures, formulaGrade = b.Readability?.Grade,
                ready = b.Chapters.Count(c => _library.Questions(b.Id, c.N).Count >= Math.Ceiling(CoinQuest.Shared.Books.BookLibrary.QuizSize(c.Words) * 1.5)),
                done = Passed(b.Id), started = Started(b.Id),
            }).ToList(),
            flagged = FlaggedQuestions().Count,
        };
    }

    /// <summary>A parent's "Start over" on a book: the child's progress on it is cleared, so its chapters pay again.</summary>
    private object ResetBook(Request req)
    {
        var childId = Str(req, "childId");
        var book = Str(req, "bookId");
        if (_store.Current.Children.All(c => c.Id != childId)) throw new ArgumentException("That child isn't on this PC");
        var all = ProgressStore.Load(childId, "books") as JsonObject ?? new JsonObject();
        foreach (var k in all.Select(kv => kv.Key).Where(k => k.StartsWith(book + "/")).ToList()) all.Remove(k);
        ProgressStore.Save(childId, "books", all);
        _log.LogInformation("Reading progress reset for {Child}: {Book}", childId, book);
        AfterChange();
        return new { ok = true };
    }

    /// <summary>A child's chapters with a quiz taken, for the reading analysis (see ReadingReport).</summary>
    private List<CoinQuest.Shared.Books.ReadingReport.Entry> ReadingEntries(string childId)
    {
        var all = ProgressStore.Load(childId, "books") as JsonObject ?? new JsonObject();
        var progress = new List<KeyValuePair<string, CoinQuest.Shared.Books.ChapterProgress>>();
        foreach (var (key, node) in all)
        {
            try { if (node?.Deserialize<CoinQuest.Shared.Books.ChapterProgress>(ProgressJson) is { } p) progress.Add(new(key, p)); } catch { }
        }
        return CoinQuest.Shared.Books.ReadingReport.Entries(_library, progress);
    }

    /// <summary>The parents' Reading analysis (Today → Reading).</summary>
    private object ReadingAnalysis(Request req)
    {
        var child = _store.Current.Children.FirstOrDefault(c => c.Id == Str(req, "childId")) ?? throw new ArgumentException("That child isn't on this PC");
        var r = CoinQuest.Shared.Books.ReadingReport.Build(ReadingEntries(child.Id), DateTimeOffset.Now);
        r["kid"] = child.DisplayName;
        return r;
    }

    /// <summary>
    /// The all-time reading summary that rides on the newest daily report (the phone's and Today's "Reading level"
    /// tile): chapters passed, first-try %, reading speed, the level being read now, and the comfortable level.
    /// </summary>
    private System.Text.Json.Nodes.JsonObject ReadingSummary(Child child)
    {
        var r = CoinQuest.Shared.Books.ReadingReport.Build(ReadingEntries(child.Id), DateTimeOffset.Now);
        var quest = QuestState(child.Id);
        return new System.Text.Json.Nodes.JsonObject
        {
            ["chapters"] = r["chaptersRead"]?.GetValue<int>() ?? 0,
            ["passed"] = r["chaptersPassed"]?.GetValue<int>() ?? 0,
            ["firstTry"] = r["firstTryAll"]?.DeepClone(),
            ["wpm"] = r["wpm"]?.DeepClone(),
            ["level"] = r["current"]?.DeepClone(),
            ["verified"] = r["comfortable"]?.GetValue<int>() ?? 0,
            // Reading Quest's level is on the same scale (ReadingLevels): the tile shows it until books verify one.
            ["questLevel"] = quest.Answered > 0 ? CoinQuest.Shared.Books.ReadingQuest.Level(quest.Rating) : (int?)null,
        };
    }

    private static string FlagFile => Path.Combine(Paths.DataRoot, "books-flagged.json");
    private static List<JsonObject> FlaggedQuestions()
    {
        try { return File.Exists(FlagFile) ? JsonSerializer.Deserialize<List<JsonObject>>(File.ReadAllText(FlagFile)) ?? new() : new(); } catch { return new(); }
    }

    /// <summary>Pay coins for a quest within its daily limit (or ask the parent first when the quest says so).</summary>
    private (int coins, bool pending) PayQuest(Child child, string moduleId, ModuleSettings s, int want, string detail, string account)
    {
        if (want == 0) return (0, false);
        var room = s.DailyCap > 0 ? Math.Max(0, s.DailyCap - _ledger.EarnedToday(child.Id, moduleId)) : int.MaxValue;
        var coins = want < 0 ? want : Math.Min(want, room);
        if (s.RequireApproval) { _ledger.FileClaim(child.Id, moduleId, coins, detail, account); ApprovalsChanged?.Invoke(); return (coins, true); }
        if (coins != 0) _ledger.Append(child.Id, LedgerKind.Earn, coins, moduleId, detail, account);
        return (coins, false);
    }

    // ---- Reading Quest: one paragraph, one question, adaptive (ReadingQuest.cs) -------------------------------------

    private readonly CoinQuest.Shared.Books.QuestLibrary _quest = new(Path.Combine(Paths.ContentRoot, "passages"));
    private readonly Dictionary<string, string> _questLastTopic = new();

    private static CoinQuest.Shared.Books.QuestState QuestState(string childId) =>
        ProgressStore.Load(childId, "reading-quest")?.Deserialize<CoinQuest.Shared.Books.QuestState>(ProgressJson) ?? new();
    private static void SaveQuest(string childId, CoinQuest.Shared.Books.QuestState st) =>
        ProgressStore.Save(childId, "reading-quest", JsonSerializer.SerializeToNode(st, ProgressJson)!);

    private object Quest(Request req, Child child, string account)
    {
        var s = child.Modules.GetValueOrDefault("reading-quest") ?? ModuleSettings.Defaults()["reading-quest"];
        if (!s.Enabled) throw new InvalidOperationException("Reading Quest isn't turned on");
        var st = QuestState(child.Id);
        var all = _quest.All();
        var streakEvery = Math.Clamp(int.TryParse(s.Options.GetValueOrDefault("streakEvery"), out var se) ? se : 2, 2, 50);
        object Me() => new
        {
            level = CoinQuest.Shared.Books.ReadingQuest.Level(st.Rating), progress = Math.Round(CoinQuest.Shared.Books.ReadingQuest.LevelProgress(st.Rating), 2),
            streak = st.Streak, bestStreak = st.BestStreak, streakEvery, answered = st.Answered,
            earnedToday = _ledger.EarnedToday(child.Id, "reading-quest"), dailyCap = s.DailyCap, left = CoinQuest.Shared.Books.ReadingQuest.Left(st, all),
        };
        switch (req.Op)
        {
            case Ops.QuestState: return Me();
            case Ops.QuestNext:
            {
                var shown = CoinQuest.Shared.Books.ReadingQuest.Next(st, all, _rng, _questLastTopic.GetValueOrDefault(child.Id), DateTimeOffset.Now);
                SaveQuest(child.Id, st);
                return new { passage = shown, me = Me() };
            }
            case Ops.QuestAnswer:
            {
                var id = Str(req, "id");
                var p = _quest.Find(id) ?? throw new InvalidOperationException("That paragraph isn't here any more");
                var index = req.Payload?["q"]?.GetValue<int>() ?? 0;
                var picked = req.Payload?["pick"]?.GetValue<int>() ?? -1;
                var ms = (long)(req.Payload?["readMs"]?.GetValue<double>() ?? 0);
                // Each question is marked (and paid) the moment it's clicked, in any order.
                var a = CoinQuest.Shared.Books.ReadingQuest.Answer(st, p, id, index, picked, ms, streakEvery, DateTimeOffset.Now);
                SaveQuest(child.Id, st);
                _questLastTopic[child.Id] = p.Topic;
                var (coins, pending) = (0, false);
                var (bonus, bonusPending) = (0, false);
                if (a.Right && !a.Retry) (coins, pending) = PayQuest(child, "reading-quest", s, CoinQuest.Shared.Books.ReadingQuest.Pay(p.Words, p.Questions.Count, s.CoinsPerActivity), $"Reading Quest: {p.Title}", account);
                // A full streak ring (every N right in a row) pays its number: 1, then 2, then 3 at most.
                if (a.StreakUp) (bonus, bonusPending) = PayQuest(child, "reading-quest", s, Math.Min(3, a.Streak / streakEvery), $"Reading Quest streak: {a.Streak} in a row", account);
                if (child.ActivityReports && !a.Retry)
                {
                    _activity.Count(child.Id, DateTime.Now, "reading-quest:answered");
                    if (a.Right) _activity.Count(child.Id, DateTime.Now, "reading-quest:correct");
                }
                AfterChange();
                // A miss that will come back later reveals nothing (no right answer, no highlight), so the second look is a real
                // second try. The answer is shown only when the question is finished for good (right, or a second-look miss).
                var reveal = a.Right || a.Retry;
                return new { a.Index, a.Finished, a.Right, rightChoice = reveal ? a.RightChoice : -1, evidence = reveal ? a.Evidence : "", a.Streak, a.StreakUp, a.Retry, coins, bonus, pending = pending || bonusPending, levelBefore = CoinQuest.Shared.Books.ReadingQuest.Level(a.Before), me = Me(), balance = _ledger.Balance(child.Id) };
            }
            default: throw new ArgumentException("Unknown Reading Quest request");
        }
    }

    /// <summary>The phone's reading dashboard: the same numbers as the Parent Console's (books and Reading Quest).</summary>
    private object PhoneReading(string childId)
    {
        var child = _store.Current.Children.FirstOrDefault(c => c.Id == childId) ?? throw new ArgumentException("That child isn't on this PC");
        var books = CoinQuest.Shared.Books.ReadingReport.Build(ReadingEntries(child.Id), DateTimeOffset.Now);
        books["kid"] = child.DisplayName;
        return new { childId = child.Id, kid = child.DisplayName, at = DateTimeOffset.Now, books, quest = CoinQuest.Shared.Books.ReadingQuest.Report(QuestState(child.Id), _quest, DateTimeOffset.Now) };
    }

    /// <summary>The parents' Reading Quest numbers (Today → Reading).</summary>
    private object QuestReport(Request req)
    {
        var child = _store.Current.Children.FirstOrDefault(c => c.Id == Str(req, "childId")) ?? throw new ArgumentException("That child isn't on this PC");
        return CoinQuest.Shared.Books.ReadingQuest.Report(QuestState(child.Id), _quest, DateTimeOffset.Now);
    }

    private object Books(Request req, Child child, string account)
    {
        var s = BookSettings(child);
        if (!s.Enabled) throw new InvalidOperationException("Reading isn't turned on");
        var allowed = AllowedBooks(s);
        var all = ProgressStore.Load(child.Id, "books") as JsonObject ?? new JsonObject();
        CoinQuest.Shared.Books.ChapterProgress State(string book, int n) =>
            all[$"{book}/{n}"]?.Deserialize<CoinQuest.Shared.Books.ChapterProgress>(ProgressJson) ?? new();
        void Save(string book, int n, CoinQuest.Shared.Books.ChapterProgress p) { all[$"{book}/{n}"] = JsonSerializer.SerializeToNode(p, ProgressJson); ProgressStore.Save(child.Id, "books", all); }
        object Status(string book, CoinQuest.Shared.Books.BookLibrary.ChapterInfo c)
        {
            var p = State(book, c.N);
            var bank = _library.Questions(book, c.N);
            return new
            {
                n = c.N, title = c.Title, words = c.Words, quizSize = Math.Min(bank.Count, CoinQuest.Shared.Books.BookLibrary.QuizSize(c.Words)), hasQuiz = bank.Count > 0,
                passed = p.Passed, correct = p.Correct, total = p.Total, attempts = p.Attempts,
                read = p.ReadAt is not null || p.Passed, opened = p.OpenedAt is not null || p.ReadAt is not null || p.Passed || p.Attempts > 0,
                retakeAt = p.RetakeAt is { } t && t > DateTimeOffset.Now ? t : (DateTimeOffset?)null,
                bonusLeft = CoinQuest.Shared.Books.Quiz.BonusLeft(p, bank, CoinQuest.Shared.Books.BookLibrary.QuizSize(c.Words)), typed = p.TypedParts.Count,
            };
        }
        if (req.Op == Ops.BooksList)
            return new
            {
                perCorrect = s.CoinsPerActivity, wordsPer = int.TryParse(s.Options.GetValueOrDefault("wordsPer"), out var wp) && wp > 0 ? wp : 20,
                books = _library.Books().Where(b => allowed is null || allowed.Contains(b.Id)).Select(b => new
                {
                    id = b.Id, title = b.Title, author = b.Author, level = b.Level, summary = b.Summary,
                    chapters = b.Chapters.Select(c => Status(b.Id, c)).ToList(),
                }).ToList(),
            };

        var bookId = Str(req, "bookId");
        var n = req.Payload?["n"]?.GetValue<int>() ?? throw new ArgumentException("n required");
        if (allowed is not null && !allowed.Contains(bookId)) throw new InvalidOperationException("That book isn't on your shelf");
        var book = _library.Find(bookId) ?? throw new ArgumentException("That book isn't here");
        var ch = _library.Chapter(bookId, n);
        var bank = _library.Questions(bookId, n);
        var state = State(bookId, n);
        var now = DateTimeOffset.Now;
        var label = book.Chapters.Count == 1 ? book.Title : $"{book.Title}, chapter {n}";
        var size = CoinQuest.Shared.Books.BookLibrary.QuizSize(ch.Words);
        // Reading time (the chapter on screen, window in use) until it's first read to the end: for the parents' reading
        // speed. Reaching the end after a believable time marks it read (progress bar, chapters read), quiz or not.
        void AddReading()
        {
            if (state.ReadAt is null && state.Attempts == 0 && req.Payload?["readMs"] is JsonValue rv && rv.TryGetValue<double>(out var readMs))
                state.ReadMs = Math.Min(state.ReadMs + (long)Math.Clamp(readMs, 0, 3 * 3600_000), 6 * 3600_000);
            // A chapter quizzed before reading was tracked: it was read (its time isn't a clean first read, so no speed).
            if (state.ReadAt is null && state.Attempts > 0) { state.ReadAt = now; return; }
            if (state.ReadAt is null && CoinQuest.Shared.Books.BookLibrary.ReadEnough(ch.Words, state.ReadMs))
            {
                state.ReadAt = now;
                if (child.ActivityReports)
                {
                    _activity.Count(child.Id, DateTime.Now, "books:chaptersRead");
                    if (ch.Words / (state.ReadMs / 60000.0) is >= 40 and <= 600)
                    {
                        _activity.Count(child.Id, DateTime.Now, "books:readWords", ch.Words);
                        _activity.Count(child.Id, DateTime.Now, "books:readSec", (int)(state.ReadMs / 1000));
                    }
                }
            }
        }
        switch (req.Op)
        {
            case Ops.BooksRead:
            {
                AddReading();
                state.OpenedAt ??= now;
                Save(bookId, n, state);
                return new { read = state.ReadAt is not null || state.Passed, status = Status(bookId, ch) };
            }
            case Ops.BooksChapter:
                if (state.OpenedAt is null) { state.OpenedAt = now; Save(bookId, n, state); }
                return new { book = book.Title, text = _library.Text(bookId, n), parts = _library.Parts(bookId, n), status = Status(bookId, ch),
                    quiz = CoinQuest.Shared.Books.Quiz.Current(state, bank) is { } open ? new { id = state.Quiz!.Id, questions = open } : null };
            case Ops.BooksQuiz:
            {
                AddReading();
                var shown = CoinQuest.Shared.Books.Quiz.Start(state, bank, CoinQuest.Shared.Books.BookLibrary.QuizSize(ch.Words), _rng, now);
                Save(bookId, n, state);
                return new { id = state.Quiz!.Id, questions = shown };
            }
            case Ops.BooksGrade:
            {
                var answers = (req.Payload?["answers"] as JsonArray)?.Select(a => a?.GetValue<int>() ?? -1).ToList() ?? new();
                var wait = TimeSpan.FromMinutes(Math.Clamp(int.TryParse(s.Options.GetValueOrDefault("waitMinutes"), out var w) ? w : 5, 0, 240));
                // Every question counts: nothing a child sends can leave a question out of the score.
                var g = CoinQuest.Shared.Books.Quiz.Grade(state, bank, Str(req, "quizId"), answers, new HashSet<string>(), wait, now);
                Save(bookId, n, state);
                var (coins, pending) = (0, false);
                if (child.ActivityReports)
                {
                    _activity.Count(child.Id, DateTime.Now, "books:answered", g.Total);
                    _activity.Count(child.Id, DateTime.Now, "books:correct", g.Correct);
                }
                if (g.Passed)
                {
                    (coins, pending) = PayQuest(child, "books", s, g.Correct * s.CoinsPerActivity, $"{label}: {g.Correct}/{g.Total} on the quiz", account);
                    if (child.ActivityReports) _activity.Count(child.Id, DateTime.Now, "books:chapters");
                }
                AfterChange();
                return new { g.Passed, g.Correct, g.Total, g.Percent, g.RetakeAt, g.Review, coins, pending, bonusLeft = CoinQuest.Shared.Books.Quiz.BonusLeft(state, bank, size), balance = _ledger.Balance(child.Id) };
            }
            case Ops.BooksBonus:
            {
                var q = CoinQuest.Shared.Books.Quiz.NextBonus(state, bank, size, _rng, now);
                Save(bookId, n, state);
                return new { question = q, left = CoinQuest.Shared.Books.Quiz.BonusLeft(state, bank, size) };
            }
            case Ops.BooksBonusAnswer:
            {
                var (right, pos) = CoinQuest.Shared.Books.Quiz.AnswerBonus(state, bank, Str(req, "qid"), req.Payload?["choice"]?.GetValue<int>() ?? -1);
                Save(bookId, n, state);
                var (coins, pending) = right ? PayQuest(child, "books", s, s.CoinsPerActivity, $"{label}: bonus question", account) : (0, false);
                if (child.ActivityReports) { _activity.Count(child.Id, DateTime.Now, "books:answered"); if (right) _activity.Count(child.Id, DateTime.Now, "books:correct"); }
                AfterChange();
                return new { right, rightChoice = pos, coins, pending, left = CoinQuest.Shared.Books.Quiz.BonusLeft(state, bank, size), balance = _ledger.Balance(child.Id) };
            }
            case Ops.BooksTyped:
            {
                var parts = _library.Parts(bookId, n);
                var i = req.Payload?["part"]?.GetValue<int>() ?? -1;
                if (i < 0 || i >= parts.Count) throw new ArgumentException("That part isn't in this chapter");
                var typed = Str(req, "typed");
                var ms = (req.Payload?["finishedAt"]?.GetValue<double>() ?? 0) - (req.Payload?["startedAt"]?.GetValue<double>() ?? 0);
                var words = parts[i].Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
                if (typed != parts[i]) throw new InvalidOperationException("That doesn't match this part of the chapter");
                if (ms < 1000 || parts[i].Length / 5.0 / (ms / 60000.0) > 180) throw new InvalidOperationException("That was too fast to be real typing");
                var first = !state.TypedParts.Contains(i);
                if (first) state.TypedParts.Add(i);
                // Typing every part of a chapter reads it too.
                if (state.ReadAt is null && parts.Count > 0 && Enumerable.Range(0, parts.Count).All(state.TypedParts.Contains))
                {
                    state.ReadAt = now;
                    if (child.ActivityReports) _activity.Count(child.Id, DateTime.Now, "books:chaptersRead");
                }
                state.OpenedAt ??= now;
                Save(bookId, n, state);
                if (child.ActivityReports) _activity.AddTyping(child.Id, DateTime.Now, typed.Length, (long)ms);
                var per = int.TryParse(s.Options.GetValueOrDefault("wordsPer"), out var wpr) && wpr > 0 ? wpr : 20;
                var (coins, pending) = first ? PayQuest(child, "books", s, (int)Math.Floor(words / (double)per + 0.5), $"{label}: typed part {i + 1} ({words} words)", account) : (0, false);
                AfterChange();
                return new { coins, pending, again = !first, typed = state.TypedParts.Count, balance = _ledger.Balance(child.Id) };
            }
        }
        throw new ArgumentException("unknown books request");
    }

    // ---- activity reports ---------------------------------------------------------------------------------------

    private static readonly HashSet<string> TickKinds = new() { "quest", "youtube", "site", "arcade", "app", "coinquest" };

    /// <summary>A minute of what the child is doing, from their CoinQuest window. The first of the day sends the
    /// parent's phones the reports for the days since the last ones were sent.</summary>
    private Response ActivityTick(Request req, Child child)
    {
        if (!child.ActivityReports) return Response.Success(req.Id, new { ok = false });
        var kind = Str(req, "kind");
        if (!TickKinds.Contains(kind)) return Response.Fail(req.Id, "unknown activity");
        var seconds = Math.Clamp(req.Payload?["seconds"]?.GetValue<int>() ?? 60, 0, 120);
        var first = _activity.AddTime(child.Id, DateTime.Now, kind, Str(req, "key"), req.Payload?["label"]?.GetValue<string>() ?? "", seconds);
        if (first) SendReports(child);
        return Response.Success(req.Id, new { ok = true });
    }

    /// <summary>Typing totals and things finished (Khan answers, Duolingo lessons, passages…) for the reports.</summary>
    private void NoteDone(Child child, string moduleId, JsonNode? result, ScoreOutcome outcome)
    {
        try
        {
            var now = DateTime.Now;
            int N(string k) => result?["data"]?[k] is JsonValue v && v.TryGetValue<int>(out var i) ? Math.Max(0, i) : 0;
            switch (moduleId)
            {
                case "khan-academy":
                    _activity.Count(child.Id, now, "khan-academy:correct", N("correct"));
                    _activity.Count(child.Id, now, "khan-academy:videos", N("video") + N("videos"));
                    _activity.Count(child.Id, now, "khan-academy:exercises", N("done"));
                    break;
                case "duolingo":
                    _activity.Count(child.Id, now, "duolingo:lessons", N("lesson") + N("story"));
                    break;
                default:
                    if (result?["data"]?["typed"] is JsonValue t && t.TryGetValue<string>(out var typed))
                    {
                        var ms = (result["finishedAt"]?.GetValue<double>() ?? 0) - (result["startedAt"]?.GetValue<double>() ?? 0);
                        _activity.AddTyping(child.Id, now, typed.Length, (long)ms);
                    }
                    if (outcome.ProgressDelta is not null || outcome.Coins != 0) _activity.Count(child.Id, now, moduleId + ":finished");
                    break;
            }
        }
        catch (Exception ex) { _log.LogInformation("Activity note failed: {Msg}", ex.Message); }
    }

    /// <summary>Daily reports for a range (yyyy-MM-dd, inclusive, at most ~2 months). Today's is live.</summary>
    private object ActivityDays(string childId, string from, string to)
    {
        var child = _store.Current.Children.FirstOrDefault(c => c.Id == childId) ?? throw new ArgumentException("That child isn't on this PC");
        var end = DateTime.TryParse(to, out var t) ? t.Date : DateTime.Today;
        var start = DateTime.TryParse(from, out var f) ? f.Date : end;
        if (end > DateTime.Today) end = DateTime.Today;
        if ((end - start).TotalDays > 62) start = end.AddDays(-62);
        var have = _activity.Days(child.Id).ToHashSet();
        var days = new List<System.Text.Json.Nodes.JsonObject>();
        for (var d = start; d <= end; d = d.AddDays(1))
            if (have.Contains(d) || _ledger.Recent(child.Id, 1, new DateTimeOffset(d)).Any(e => e.At < new DateTimeOffset(d.AddDays(1))))
                days.Add(_activity.Report(child, _ledger, d));
        // The reading summary is all-time, so it rides on the newest report — today's, even on a quiet day.
        if (end == DateTime.Today && (days.Count == 0 || days[^1]["day"]?.GetValue<string>() != DateTime.Today.ToString("yyyy-MM-dd")))
            days.Add(_activity.Report(child, _ledger, DateTime.Today));
        if (days.Count > 0) days[^1]["reading"] = ReadingSummary(child);
        return new { childId = child.Id, kid = child.DisplayName, enabled = child.ActivityReports, days };
    }

    /// <summary>Leave the parent's phones the daily reports since the last ones sent (up to 60 days), once a day.</summary>
    private void SendReports(Child child)
    {
        var marker = System.IO.Path.Combine(CoinQuest.Shared.Config.Paths.DataRoot, "activity", child.Id + ".sent");
        DateTime? last = null;
        try { if (File.Exists(marker) && DateTime.TryParse(File.ReadAllText(marker).Trim(), out var l)) last = l.Date; } catch { }
        var yesterday = DateTime.Today.AddDays(-1);
        if (last >= yesterday) return;
        var reports = _activity.Days(child.Id)
            .Where(d => d < DateTime.Today && d >= DateTime.Today.AddDays(-60) && (last is null || d > last))
            .OrderBy(d => d).Select(d => _activity.Report(child, _ledger, d)).ToList();
        if (reports.Count > 0) reports[^1]["reading"] = ReadingSummary(child);
        try { Directory.CreateDirectory(System.IO.Path.GetDirectoryName(marker)!); File.WriteAllText(marker, yesterday.ToString("yyyy-MM-dd")); } catch { }
        if (reports.Count > 0) _ = Task.Run(() => _phones.PostReports(reports));
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
            if (child.ActivityReports) _activity.Count(child.Id, DateTime.Now, "discgames:finished", what.Count);
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
            if (child.ActivityReports) _activity.Count(child.Id, DateTime.Now, "rwt:finished");
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
    /// <summary>The child a parent request is about ("childId"), else the first one (older Parent Consoles send none).</summary>
    private Child? ChildFor(Request req) => OptStr(req, "childId") is { } id ? _store.Current.Children.FirstOrDefault(c => c.Id == id) ?? FirstChild() : FirstChild();

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
                "lock" => ParentLock(req),
                "setColor" => PhoneEditChild(Str(req, "childId"), c => System.Text.RegularExpressions.Regex.IsMatch(Str(req, "color"), "^#[0-9a-fA-F]{6}$") ? c with { Color = Str(req, "color") } : c),
                "setAds" => PhoneEditChild(Str(req, "childId"), c =>
                {
                    var site = SiteDomain(Str(req, "site"));
                    var list = c.Allowlist.AdsAllowed.Where(x => !x.Equals(site, StringComparison.OrdinalIgnoreCase)).ToList();
                    if (req.Payload?["allow"]?.GetValue<bool>() == true) list.Add(site);
                    return c with { Allowlist = c.Allowlist with { AdsAllowed = list } };
                }),
                "activity" => ActivityDays(Str(req, "childId"), Str(req, "from"), Str(req, "to")),
                // The reading dashboard (books + Reading Quest), asked for when a parent opens it on the phone.
                "reading" => PhoneReading(Str(req, "childId")),
                "setReports" => PhoneEditChild(Str(req, "childId"), c => c with { ActivityReports = req.Payload?["on"]?.GetValue<bool>() ?? true }),
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
            color = ColorOf(c),
            activityReports = c.ActivityReports,
            modules = c.Modules.Select(kv => new { id = kv.Key, enabled = kv.Value.Enabled, coinsPerActivity = kv.Value.CoinsPerActivity, dailyCap = kv.Value.DailyCap, requireApproval = kv.Value.RequireApproval, options = kv.Value.Options, earnedToday = _ledger.EarnedToday(c.Id, kv.Key) }).ToList(),
            prizes = c.Prizes.Select(p => new { id = p.Id, name = p.Name, cost = p.Cost, kind = p.Kind.ToString(), minutes = p.Minutes, dailyCap = p.DailyCap, enabled = p.Enabled, targets = p.Targets }).ToList(),
            sites = c.Allowlist.Sites,
            adsAllowed = c.Allowlist.AdsAllowed,
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
                    color = ColorOf(c),
                    lockState = LockSummary(c),
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
                coins = p.Coins, what = p.Detail.Length > 0 ? p.Detail : p.ModuleId, at = p.At, kind = p.ModuleId,
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
            locks = h.Children.ToDictionary(c => c.Id, c => LockSummary(c)),
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
            // The Parent Console's "Getting started" list: what's done, checked live on this PC.
            gettingStarted = new
            {
                phones = _phones.UsedPhones,
                used = h.Children.ToDictionary(c => c.Id, c => _activity.Days(c.Id).Count > 0 || _ledger.Recent(c.Id, 1, DateTimeOffset.MinValue).Count > 0),
                // Other accounts (parents', older siblings') with no password: a child could sign in there and skip the rules.
                openAccounts = OpenAccounts(),
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
            // The lock only changes through parent.lock (a settings screen open for a while mustn't undo a phone's "open it").
            var fixedUp = incoming with { WindowsSid = sid, Lock = i >= 0 ? list[i].Lock : incoming.Lock };
            if (i >= 0) list[i] = fixedUp; else list.Add(fixedUp);
            return h with { Children = list };
        });
        _policy.Invalidate();
        AfterChange();
        _log.LogInformation("Settings saved for {Child}: {Sites} sites, {Apps} apps, {Channels} channels, {Classics} classics",
            incoming.DisplayName, incoming.Allowlist.Sites.Count, incoming.Allowlist.Apps.Count, incoming.YouTubeChannels.Count, incoming.Arcade.Flashpoint.Count);
        return new { ok = true };
    }

    // ---- ads: blocked in the site window everywhere except sites a parent allowed ------------------------------------

    private const string AdsModule = "allow-ads";
    private static string AdsDetail(string site) => $"Allow ads on {site}";
    private static string? AdsSiteOf(string? detail) => detail is not null && System.Text.RegularExpressions.Regex.Match(detail, @"^Allow ads on (\S+)$") is { Success: true } m ? m.Groups[1].Value : null;

    private object AdsState(Child child) => new
    {
        allowed = child.Allowlist.AdsAllowed,
        pending = _ledger.PendingClaims(child.Id).Where(c => c.ModuleId == AdsModule).Select(c => AdsSiteOf(c.Detail)).Where(x => x is not null).ToList(),
    };

    /// <summary>The child asks to see ads on a site (when one won't work with ads blocked). Only a parent can say yes.</summary>
    private object AdsRequest(Request req, Child child, string account)
    {
        var site = SiteDomain(Str(req, "site"));
        if (!child.Allowlist.Sites.Any(s => site == SiteDomain(s) || site.EndsWith("." + SiteDomain(s))) && !_unlocks.ActiveFor(child.Id).Any(u => u.Targets.Any(t => site.EndsWith(SiteDomain(t)))))
            throw new InvalidOperationException("That site isn't on your list");
        if (child.Allowlist.AdsAllowed.Contains(site, StringComparer.OrdinalIgnoreCase)) return new { ok = true, already = "allowed" };
        if (_ledger.PendingClaims(child.Id).Any(c => c.ModuleId == AdsModule && AdsSiteOf(c.Detail) == site)) return new { ok = true, already = "asked" };
        _ledger.FileClaim(child.Id, AdsModule, 0, AdsDetail(site), account);
        ApprovalsChanged?.Invoke();
        AfterChange();
        return new { ok = true };
    }

    private void EditChild(string childId, Func<Child, Child> edit)
    {
        _store.Update(h => h with { Children = h.Children.Select(c => c.Id == childId ? edit(c) : c).ToList() });
        _policy.Invalidate();
        AfterChange();
    }

    private object ResolveClaim(Request req, string actor)
    {
        var seq = req.Payload?["seq"]?.GetValue<long>() ?? throw new ArgumentException("seq required");
        var approve = req.Payload?["approve"]?.GetValue<bool>() ?? false;
        int? coins = req.Payload?["coins"]?.GetValue<int>();
        var entry = _ledger.ResolveClaim(seq, approve, actor, coins);
        // An approved "allow ads on <site>" request turns ads on for that site (from the Parent Console or a phone).
        if (approve && entry is { Source: AdsModule } && AdsSiteOf(entry.Detail) is { } adsSite)
            EditChild(entry.ChildId, c => c.Allowlist.AdsAllowed.Contains(adsSite, StringComparer.OrdinalIgnoreCase) ? c : c with { Allowlist = c.Allowlist with { AdsAllowed = c.Allowlist.AdsAllowed.Append(adsSite).ToList() } });
        // An approved "please open it" opens the kid's locked profile until the current lock would have ended.
        if (approve && entry is { Source: LockModule })
            EditChild(entry.ChildId, c => c with { Lock = ProfileLockRules.Open(c.Lock, DateTimeOffset.Now) });
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

    private (List<string> List, DateTime At) _openAccounts = (new(), DateTime.MinValue);
    private List<string> OpenAccounts()
    {
        if (DateTime.UtcNow - _openAccounts.At < TimeSpan.FromMinutes(1)) return _openAccounts.List;
        try
        {
            var kids = _store.Current.Children.Select(c => c.WindowsSid).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var list = LocalAccounts.List().Where(a => !a.Disabled && !kids.Contains(a.Sid) && LocalAccounts.HasBlankPassword(a.Name) == true)
                .Select(a => string.IsNullOrWhiteSpace(a.FullName) ? a.Name : a.FullName).ToList();
            _openAccounts = (list, DateTime.UtcNow);
            return list;
        }
        catch (Exception ex) { _log.LogDebug(ex, "password check failed"); return new(); }
    }

    /// <summary>A kid's color: their own, else the palette color for their place in the list.</summary>
    private string ColorOf(Child c) => System.Text.RegularExpressions.Regex.IsMatch(c.Color ?? "", "^#[0-9a-fA-F]{6}$") ? c.Color
        : Child.Palette[Math.Max(0, _store.Current.Children.FindIndex(x => x.Id == c.Id)) % Child.Palette.Length];

    private static string Bare(string account) => account.Contains('\\') ? account[(account.IndexOf('\\') + 1)..] : account;

    private object CreateAccount(Request req)
    {
        var full = OptStr(req, "fullName") ?? Str(req, "userName");
        var name = LocalAccounts.CreateStandardUser(Str(req, "userName"), full, OptStr(req, "password"));
        _log.LogInformation("Created Windows account {Account} for a child", name);
        return new { account = name };
    }

    /// <summary>Another child on this PC: their own Windows account (made Standard), coins, quests, limits and reports.</summary>
    private object AddChild(Request req)
    {
        var account = Str(req, "windowsAccount");
        var displayName = OptStr(req, "displayName") is { Length: > 0 } d ? d.Trim() : Bare(account);
        var sid = Wts.SidForAccount(account) ?? throw new ArgumentException($"Windows account '{account}' not found");
        if (_store.Current.Children.Any(c => c.WindowsSid == sid)) throw new InvalidOperationException("That Windows account already belongs to one of your kids");
        // Never demote an administrator from here (it could be a parent's own account): pick a kid's account or create one.
        if (LocalAccounts.IsLocalAdmin(account)) throw new InvalidOperationException("That's an administrator account (a parent's?). Pick your child's account, or create a new one for them.");
        LocalAccounts.EnsureStandardUser(account);
        var color = OptStr(req, "color") is { } col && System.Text.RegularExpressions.Regex.IsMatch(col, "^#[0-9a-fA-F]{6}$") ? col
            : Child.Palette.FirstOrDefault(p => _store.Current.Children.All(x => !string.Equals(x.Color, p, StringComparison.OrdinalIgnoreCase))) ?? Child.Palette[0];
        var c = new Child { DisplayName = displayName, Color = color, WindowsAccount = account, WindowsSid = sid, Allowlist = Allowlist.SchoolBasics() };
        _store.Update(h => h with { Children = h.Children.Append(c).ToList() });
        _policy.Invalidate();
        AfterChange();
        _log.LogInformation("Added child {Child} ({Account})", displayName, account);
        return new { ok = true, childId = c.Id };
    }

    /// <summary>
    /// Take a kid off CoinQuest: their internet lock and browser rules are lifted (their Windows account becomes an
    /// ordinary one again), and their progress, history and reports are deleted. The coin ledger is a tamper-evident
    /// chain, so its old entries stay but no longer show anywhere. Optionally deletes their Windows account too (never an
    /// administrator, never while they're signed in). The last kid can't be removed: CoinQuest needs someone to look after.
    /// </summary>
    private object RemoveChild(Request req)
    {
        var id = Str(req, "childId");
        var kid = _store.Current.Children.FirstOrDefault(c => c.Id == id) ?? throw new ArgumentException("No such kid");
        if (_store.Current.Children.Count <= 1)
            throw new InvalidOperationException($"{kid.DisplayName} is the only kid on this PC. Add another kid first, or uninstall CoinQuest to remove it entirely.");
        var deleteAccount = req.Payload?["deleteAccount"]?.GetValue<bool>() == true;
        if (deleteAccount && _session.Current?.Child.Id == id)
            throw new InvalidOperationException($"{kid.DisplayName} is signed in right now. Sign them out first, then remove them with their account.");

        _store.Update(h => h with { Children = h.Children.Where(c => c.Id != id).ToList() });
        if (!string.IsNullOrEmpty(kid.WindowsSid))
        {
            NetLock.RemoveAll(new[] { kid.WindowsSid });
            try { _policy.Clear(kid.WindowsSid); } catch (Exception ex) { _log.LogWarning(ex, "Couldn't clear browser rules for {Sid}", kid.WindowsSid); }
        }
        _policy.Invalidate();
        _netLock.Ensure(force: true);
        ProgressStore.DeleteAll(id);
        _activity.Forget(id);

        string? accountError = null;
        if (deleteAccount && !string.IsNullOrEmpty(kid.WindowsAccount))
        {
            try { LocalAccounts.DeleteUser(kid.WindowsAccount); }
            catch (Exception ex) { accountError = ex.Message; }
        }
        AfterChange();
        _log.LogInformation("Removed child {Child} ({Account}); account deleted: {Deleted}", kid.DisplayName, kid.WindowsAccount, deleteAccount && accountError is null);
        return new { ok = true, accountDeleted = deleteAccount && accountError is null, accountError };
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

        var color = req.Payload?["child"]?["color"]?.GetValue<string>() is { } col && System.Text.RegularExpressions.Regex.IsMatch(col, "^#[0-9a-fA-F]{6}$") ? col : Child.Palette[0];
        var child = new Child { DisplayName = displayName, Color = color, WindowsAccount = account, WindowsSid = sid, Allowlist = Allowlist.SchoolBasics() };
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
