using CoinQuest.Shared.Config;
using CoinQuest.Shared.Native;

namespace CoinQuest.Guardian.Enforcement;

/// <summary>Keeps the per-account internet lock (WFP) in place for every managed child.</summary>
public sealed class NetLock
{
    private readonly HouseholdStore _store;
    private readonly ILogger<NetLock> _log;
    private string _applied = "";

    public sealed record LockStatus(bool Applied, DateTimeOffset? At, string? Error);
    public LockStatus Status { get; private set; } = new(false, null, null);

    public NetLock(HouseholdStore store, ILogger<NetLock> log) { _store = store; _log = log; }

    /// <summary>Idempotent; re-applies when the set of children changes (and once at startup, in case a rule was removed).</summary>
    public void Ensure(bool force = false)
    {
        var sids = _store.Current.Children.Select(c => c.WindowsSid).Where(s => !string.IsNullOrEmpty(s)).Distinct().OrderBy(s => s).ToList();
        var sig = string.Join(",", sids);
        if (!force && sig == _applied) return;
        try
        {
            foreach (var sid in sids) Wfp.BlockAccount(sid);
            _applied = sig;
            Status = new(sids.Count > 0, DateTimeOffset.UtcNow, null);
            _log.LogInformation("Internet lock in place for {N} child account(s)", sids.Count);
        }
        catch (Exception ex)
        {
            Status = new(false, DateTimeOffset.UtcNow, ex.Message);
            _log.LogError(ex, "Could not apply the internet lock");
        }
    }

    public static void RemoveAll(IEnumerable<string> sids) { foreach (var s in sids) try { Wfp.Unblock(s); } catch { } }
}
