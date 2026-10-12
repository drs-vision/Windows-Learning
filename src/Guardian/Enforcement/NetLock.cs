using CoinQuest.Shared.Config;
using CoinQuest.Shared.Native;
using CoinQuest.Guardian.Economy;

namespace CoinQuest.Guardian.Enforcement;

/// <summary>Keeps the per-account internet lock (WFP) in place for every managed child.</summary>
public sealed class NetLock
{
    private readonly HouseholdStore _store;
    private readonly ILogger<NetLock> _log;
    private readonly FlashpointService _fp;
    private string _applied = "";

    public sealed record LockStatus(bool Applied, DateTimeOffset? At, string? Error);
    public LockStatus Status { get; private set; } = new(false, null, null);

    public NetLock(HouseholdStore store, FlashpointService fp, ILogger<NetLock> log) { _store = store; _fp = fp; _log = log; }

    /// <summary>Flashpoint's downloader and game server may reach the internet (only once a parent has approved Flashpoint games).</summary>
    private IReadOnlyList<string> Permits()
    {
        var c = _store.Current.Children.FirstOrDefault();
        if (c is null || c.Arcade.Flashpoint.Count == 0) return Array.Empty<string>();
        try { return _fp.Root(c.Arcade.FlashpointRoot) is { } root ? _fp.NetworkHelpers(root) : Array.Empty<string>(); }
        catch { return Array.Empty<string>(); }
    }

    /// <summary>Idempotent; re-applies when the set of children changes (and once at startup, in case a rule was removed).</summary>
    public void Ensure(bool force = false)
    {
        if (Paths.E2ETestMode) { Status = new(false, DateTimeOffset.UtcNow, "test machine: internet lock off"); return; } // the CI runner itself plays the child
        var sids = _store.Current.Children.Select(c => c.WindowsSid).Where(s => !string.IsNullOrEmpty(s)).Distinct().OrderBy(s => s).ToList();
        var permits = Permits();
        var sig = string.Join(",", sids) + "|" + string.Join(",", permits);
        if (!force && sig == _applied) return;
        try
        {
            foreach (var sid in sids) Wfp.BlockAccount(sid, permits);
            _applied = sig;
            Status = new(sids.Count > 0, DateTimeOffset.UtcNow, null);
            _log.LogInformation("Internet lock in place for {N} child account(s); programs allowed through: {Permits}", sids.Count, permits.Count == 0 ? "none" : string.Join(", ", permits.Select(Path.GetFileName)));
        }
        catch (Exception ex)
        {
            Status = new(false, DateTimeOffset.UtcNow, ex.Message);
            _log.LogError(ex, "Could not apply the internet lock");
        }
    }

    public static void RemoveAll(IEnumerable<string> sids) { foreach (var s in sids) try { Wfp.Unblock(s); } catch { } }
}
