using System.Text.Json;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Models;

namespace CoinQuest.Guardian.Economy;

/// <summary>
/// Active prize unlocks (YouTube for 20 min, arcade for 30 min…). Persisted to unlocks.json so a reboot
/// doesn't reset the clock. Expiry is checked every second by the worker.
/// </summary>
public sealed class UnlockManager
{
    private readonly ILogger<UnlockManager> _log;
    private readonly object _gate = new();
    private List<Unlock> _unlocks = new();
    private readonly HashSet<string> _notified = new();

    public event Action<Unlock>? Started;
    public event Action<Unlock>? Expired;

    public UnlockManager(ILogger<UnlockManager> log)
    {
        _log = log;
        try
        {
            if (File.Exists(Paths.UnlocksFile))
                _unlocks = JsonSerializer.Deserialize<List<Unlock>>(File.ReadAllText(Paths.UnlocksFile), HouseholdStore.Json) ?? new();
            foreach (var u in _unlocks.Where(u => !u.IsActive)) _notified.Add(u.Id);
        }
        catch (Exception ex) { _log.LogWarning(ex, "unlocks.json unreadable; starting empty"); }
    }

    public IReadOnlyList<Unlock> ActiveFor(string childId)
    {
        lock (_gate) return _unlocks.Where(u => u.ChildId == childId && u.IsActive).ToList();
    }

    public IReadOnlyList<Unlock> All() { lock (_gate) return _unlocks.ToList(); }

    public Unlock Start(Child child, Prize prize)
    {
        var now = DateTimeOffset.UtcNow;
        Unlock u;
        lock (_gate)
        {
            // Buying the same kind again extends the running unlock instead of running two in parallel.
            var existing = _unlocks.FirstOrDefault(x => x.ChildId == child.Id && x.IsActive && x.Kind == prize.Kind && x.Targets.SequenceEqual(prize.Targets));
            if (existing is not null)
            {
                u = existing with { ExpiresAt = existing.ExpiresAt.AddMinutes(prize.Minutes) };
                _unlocks[_unlocks.IndexOf(existing)] = u;
            }
            else
            {
                u = new Unlock { ChildId = child.Id, Kind = prize.Kind, Targets = prize.Targets.ToList(), StartedAt = now, ExpiresAt = now.AddMinutes(prize.Minutes), PrizeName = prize.Name };
                _unlocks.Add(u);
            }
            Save();
        }
        _log.LogInformation("Unlock started: {Prize} for {Child} until {Until}", prize.Name, child.DisplayName, u.ExpiresAt.ToLocalTime());
        Started?.Invoke(u);
        return u;
    }

    public bool End(string unlockId)
    {
        Unlock? u;
        lock (_gate)
        {
            u = _unlocks.FirstOrDefault(x => x.Id == unlockId && x.IsActive);
            if (u is null) return false;
            _unlocks[_unlocks.IndexOf(u)] = u with { ExpiresAt = DateTimeOffset.UtcNow };
            _notified.Add(u.Id);
            Save();
        }
        Expired?.Invoke(u);
        return true;
    }

    /// <summary>Called every second. Fires Expired for anything that just ran out, prunes old entries.</summary>
    public void Tick()
    {
        List<Unlock> expired;
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            expired = _unlocks.Where(u => !u.IsActive && _notified.Add(u.Id)).ToList();
            var before = _unlocks.Count;
            _unlocks.RemoveAll(u => u.ExpiresAt < now.AddDays(-1));
            if (_unlocks.Count != before) Save();
            if (_notified.Count > 500) _notified.RemoveWhere(id => _unlocks.All(u => u.Id != id));
        }
        foreach (var u in expired) { _log.LogInformation("Unlock expired: {Prize}", u.PrizeName); Expired?.Invoke(u); }
    }

    private void Save()
    {
        try
        {
            SafeFile.WriteAllText(Paths.UnlocksFile, JsonSerializer.Serialize(_unlocks, HouseholdStore.Json));
        }
        catch (Exception ex) { _log.LogWarning(ex, "Could not save unlocks.json"); }
    }
}
