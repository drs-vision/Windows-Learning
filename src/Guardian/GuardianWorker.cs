using System.Diagnostics;
using CoinQuest.Guardian.Economy;
using CoinQuest.Guardian.Enforcement;
using CoinQuest.Guardian.Ipc;
using CoinQuest.Guardian.Native;
using CoinQuest.Guardian.Updates;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Ipc;
using CoinQuest.Shared.Models;

namespace CoinQuest.Guardian;

/// <summary>The one-second heartbeat that ties everything together.</summary>
public sealed class GuardianWorker : BackgroundService
{
    private readonly SessionMonitor _session;
    private readonly ProcessEnforcer _enforcer;
    private readonly BrowserPolicy _policy;
    private readonly UnlockManager _unlocks;
    private readonly PipeServer _pipe;
    private readonly RequestRouter _router;
    private readonly UpdateChecker _updates;
    private readonly HouseholdStore _store;
    private readonly FlashpointService _fp;
    private readonly ClassicsStocker _stocker;
    private readonly NetGate _gate;
    private readonly NetLock _netLock;
    private readonly ILogger<GuardianWorker> _log;
    private DateTime _lastScholarLaunch = DateTime.MinValue;
    private readonly List<(DateTime closeAt, uint session, List<string> keywords)> _graceCloses = new();

    public GuardianWorker(SessionMonitor session, ProcessEnforcer enforcer, BrowserPolicy policy, UnlockManager unlocks, PipeServer pipe,
        RequestRouter router, UpdateChecker updates, HouseholdStore store, FlashpointService fp, ClassicsStocker stocker, NetGate gate, NetLock netLock, ILogger<GuardianWorker> log)
    {
        _fp = fp; _stocker = stocker; _gate = gate; _netLock = netLock;
        _session = session; _enforcer = enforcer; _policy = policy; _unlocks = unlocks; _pipe = pipe; _router = router; _updates = updates; _store = store; _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        await Task.Yield(); // let StartAsync return immediately; a stop during startup must not fail the host
        _log.LogInformation("CoinQuest Guardian {Version} starting. Data: {Data}", RequestRouter.Version, Paths.DataRoot);

        _router.StateChanged += () => PushState();
        _router.ApprovalsChanged += () => _pipe.Broadcast(Ops.EvApprovals, null);
        _enforcer.Blocked += exe => { if (_session.Current is { } s) _pipe.Broadcast(Ops.EvBlocked, new { exe }, s.Account); };
        _unlocks.Started += _ => { if (_session.Current is { } s) _policy.Apply(s.Child); PushState(); };
        _unlocks.Expired += u =>
        {
            if (_session.Current is { } s)
            {
                _policy.Apply(s.Child);
                _pipe.Broadcast(Ops.EvUnlockEnded, new { unlockId = u.Id, prizeName = u.PrizeName }, s.Account);
                if (u.Kind == PrizeKind.ArcadeUnlock && u.Targets.Any(t => t.StartsWith("fp-") || t == "*")
                    && !_unlocks.ActiveFor(s.Child.Id).Any(x => x.Kind == PrizeKind.ArcadeUnlock && x.Targets.Any(t => t.StartsWith("fp-") || t == "*"))
                    && _fp.Root(s.Child.Arcade.FlashpointRoot) is { } root)
                    _enforcer.KillUnder(s.SessionId, root);
                if (u.Kind == PrizeKind.SiteUnlock)
                    lock (_graceCloses) _graceCloses.Add((DateTime.UtcNow.AddSeconds(30), s.SessionId, KeywordsFor(u.Targets)));
            }
            PushState();
        };
        _store.Changed += _ => { _policy.Invalidate(); PushState(); };
        _session.Changed += s =>
        {
            if (s is null) _updates.ApplyIfStaged();
            else { _policy.Invalidate(); _policy.Apply(s.Child); }
        };

        // The gatekeeper must be listening before the lock goes on, so allowed sites keep working.
        var gateTask = _gate.RunAsync(ct);
        Step("internet lock", () => _netLock.Ensure(force: true));
        _store.Changed += _ => Step("internet lock", () => _netLock.Ensure());
        var pipeTask = _pipe.RunAsync(ct);
        var updateTask = _updates.RunAsync(ct);

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (!ct.IsCancellationRequested)
        {
            try { if (!await timer.WaitForNextTickAsync(ct)) break; } catch (OperationCanceledException) { break; }
            // Each duty is isolated: a failure in one (e.g. a registry error) must never stop the others.
            Step("session", _session.Poll);
            Step("unlocks", _unlocks.Tick);
            if (_session.Current is { } s)
            {
                Step("browser policy", () => _policy.Apply(s.Child)); // belt and braces; real browsers are also closed outright
                Step("apps", _enforcer.Sweep);
                Step("scholar", () => EnsureScholarRunning(s));
            }
            Step("grace", RunGraceCloses);
            Step("classics", () => _stocker.Tick());
            if ((DateTime.UtcNow - _lastHeartbeatLog).TotalMinutes >= 5)
            {
                _lastHeartbeatLog = DateTime.UtcNow;
                _log.LogInformation("Heartbeat: console={Account} managedChild={Child} internetLock={Net} browserLock={Lock}",
                    _session.ConsoleAccount ?? "(none)", _session.Current?.Child.DisplayName ?? "no", _netLock.Status, _policy.Status);
                Step("internet lock", () => _netLock.Ensure(force: true)); // re-assert every 5 minutes
            }
        }

        try { await Task.WhenAll(pipeTask, updateTask, gateTask); } catch (OperationCanceledException) { }
    }

    private DateTime _lastHeartbeatLog = DateTime.MinValue;
    private readonly Dictionary<string, DateTime> _lastStepError = new();

    private void Step(string name, Action a)
    {
        try { a(); }
        catch (Exception ex)
        {
            // Log each failing duty at most once a minute so the log stays readable.
            if (!_lastStepError.TryGetValue(name, out var t) || (DateTime.UtcNow - t).TotalMinutes >= 1)
            {
                _lastStepError[name] = DateTime.UtcNow;
                _log.LogError(ex, "Heartbeat step '{Step}' failed", name);
            }
        }
    }

    private void PushState()
    {
        if (_session.Current is not { } s) return;
        _pipe.Broadcast(Ops.EvState, null, s.Account);
    }

    /// <summary>Scholar is the child's desktop. If it isn't running in the child's session, start it (at most once every 15 s).</summary>
    private void EnsureScholarRunning(SessionMonitor.ActiveSession s)
    {
        if ((DateTime.UtcNow - _lastScholarLaunch).TotalSeconds < 15) return;
        var running = Process.GetProcessesByName("CoinQuest.Scholar").Any(p => { try { return p.SessionId == s.SessionId; } catch { return false; } finally { p.Dispose(); } });
        if (running) return;
        var exe = Path.Combine(Paths.InstallRoot, "CoinQuest.Scholar.exe");
        if (!File.Exists(exe)) return;
        try
        {
            Wts.LaunchInSession(s.SessionId, exe);
            _lastScholarLaunch = DateTime.UtcNow;
            _log.LogInformation("Launched Scholar in session {Sid}", s.SessionId);
        }
        catch (Exception ex) { _log.LogWarning(ex, "Could not launch Scholar"); _lastScholarLaunch = DateTime.UtcNow; }
    }

    private void RunGraceCloses()
    {
        List<(DateTime, uint, List<string>)> due;
        lock (_graceCloses)
        {
            due = _graceCloses.Where(g => g.closeAt <= DateTime.UtcNow).ToList();
            _graceCloses.RemoveAll(g => g.closeAt <= DateTime.UtcNow);
        }
        foreach (var (_, session, keywords) in due) _enforcer.CloseBrowserWindowsFor(session, keywords);
    }

    private static List<string> KeywordsFor(IEnumerable<string> targets)
    {
        // "youtube.com" -> "YouTube"-ish keyword for window-title matching: take the registrable label.
        var list = new List<string>();
        foreach (var t in targets)
        {
            var host = t.Split('/')[0];
            var parts = host.Split('.');
            if (parts.Length >= 2) list.Add(parts[^2]);
        }
        return list.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }
}
