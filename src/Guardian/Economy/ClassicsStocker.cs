using CoinQuest.Shared.Config;
using CoinQuest.Shared.Models;

namespace CoinQuest.Guardian.Economy;

/// <summary>
/// Fills the arcade with the curated classics — no install and no per-game clicking.
///  1. Matches every curated pick against the Flashpoint Archive catalog (online; a local Flashpoint install is used
///     instead when present), Flash games only, skipping ones marked "preview" and anything a parent removed.
///  2. Fetches box art, then downloads the first games ahead of time (as the service) so they start instantly;
///     the rest download the first time they're played. Games play in CoinQuest's own Ruffle player.
/// Runs in the background from the Guardian heartbeat; every step is safe to repeat.
/// </summary>
public sealed class ClassicsStocker
{
    private readonly FlashpointService _fp;
    private readonly ClassicLibrary _lib;
    private const int PreloadCount = 15;
    private readonly HouseholdStore _store;
    private readonly ILogger<ClassicsStocker> _log;
    private Task _running = Task.CompletedTask;
    private DateTime _lastRun = DateTime.MinValue;
    private DateTime _lastOnlineStock = DateTime.MinValue;
    private bool _forceStock;
    private readonly HashSet<string> _failed = new();

    public sealed record StockStatus(string Stage, int Approved, int Downloaded, int Queued, string? Error);
    public StockStatus Status { get; private set; } = new("idle", 0, 0, 0, null);

    public ClassicsStocker(FlashpointService fp, ClassicLibrary lib, HouseholdStore store, ILogger<ClassicsStocker> log) { _fp = fp; _lib = lib; _store = store; _log = log; }

    /// <summary>Called every second; starts a pass at most every 2 minutes (or immediately when forced).</summary>
    public void Tick(bool force = false)
    {
        if (!_running.IsCompleted) return;
        if (!force && (DateTime.UtcNow - _lastRun).TotalMinutes < 2) return;
        _lastRun = DateTime.UtcNow;
        if (force) _forceStock = true;
        _running = Task.Run(Pass);
    }

    private async Task Pass()
    {
        try
        {
            var child = _store.Current.Children.FirstOrDefault();
            if (child is null) return;
            var root = _fp.Root(child.Arcade.FlashpointRoot); // optional: a local install is just a faster catalog/cache

            // Online lookups are polite: at most every 6 hours (a local catalog can be checked every pass).
            if (child.Arcade.AutoClassics && (root is not null || DateTime.UtcNow - _lastOnlineStock > TimeSpan.FromHours(6) || _forceStock))
            {
                _forceStock = false;
                if (root is null) _lastOnlineStock = DateTime.UtcNow;
                Status = Status with { Stage = "finding" };
                await Stock(root);
            }

            child = _store.Current.Children.First();
            foreach (var g in child.Arcade.Flashpoint) await _fp.Thumb(root, g.Id);
            await Preload(child.Arcade.Flashpoint);
        }
        catch (Exception ex)
        {
            Status = Status with { Error = ex.Message };
            _log.LogWarning(ex, "Classics stocking pass failed");
        }
    }

    /// <summary>Match each curated pick to one specific catalog entry. Strict, so "Flight" never becomes some other game.</summary>
    public FlashpointService.FpGame? Match(string? root, Classics.Pick p)
    {
        var hits = (root is not null ? _fp.Search(root, p.Search, 8) : _lib.Search(p.Search, 8).GetAwaiter().GetResult())
            .Where(g => g.Platform.Equals("Flash", StringComparison.OrdinalIgnoreCase)).ToList();
        return hits.FirstOrDefault(g => g.Title.Equals(p.Search, StringComparison.OrdinalIgnoreCase))
            ?? hits.FirstOrDefault(g => Close(g.Title, p.Search, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>"The Fancy Pants Adventures" ≈ "Fancy Pants Adventures", but "Bloons 2" is not "Bloons".</summary>
    private static bool Close(string title, string search, StringComparison cmp)
    {
        var at = title.IndexOf(search, cmp);
        if (at < 0 || at > 4 || title.Length > search.Length + 14) return false;
        var after = title[(at + search.Length)..].TrimStart(' ', ':', '-');
        return after.Length == 0 || !char.IsDigit(after[0]);
    }

    private async Task Stock(string? root)
    {
        await Task.Yield();
        var child = _store.Current.Children.First();
        var stocked = child.Arcade.StockedPicks.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var have = child.Arcade.Flashpoint.Select(f => f.Id).ToHashSet();
        var add = new List<FlashpointGame>();
        var newlyStocked = new List<string>();
        foreach (var p in Classics.List)
        {
            if (stocked.Contains(p.Search) || p.Note?.Contains("preview", StringComparison.OrdinalIgnoreCase) == true) continue;
            FlashpointService.FpGame? hit;
            try { hit = Match(root, p); } catch (Exception ex) { _log.LogInformation("Catalog lookup for {Pick} failed: {Msg}", p.Search, ex.Message); continue; }
            if (hit is null) continue; // maybe a later Flashpoint catalog has it; try again next pass
            newlyStocked.Add(p.Search);
            if (have.Add(hit.Id)) add.Add(new FlashpointGame { Id = hit.Id, Title = hit.Title, Developer = hit.Developer, Genre = p.Genre, Strategy = p.Strategy });
        }
        if (newlyStocked.Count == 0) return;
        _store.Update(h => h with
        {
            Children = h.Children.Select(c => c with
            {
                Arcade = c.Arcade with
                {
                    Flashpoint = c.Arcade.Flashpoint.Concat(add.Where(a => c.Arcade.Flashpoint.All(f => f.Id != a.Id))).ToList(),
                    StockedPicks = c.Arcade.StockedPicks.Concat(newlyStocked).Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
                },
            }).ToList(),
        });
        _log.LogInformation("Added {N} classic games to the arcade automatically", add.Count);
    }

    /// <summary>Download the first approved games ahead of time; the rest download when first played.</summary>
    private async Task Preload(List<FlashpointGame> games)
    {
        var ready = games.Count(g => _lib.IsReady(g.Id));
        var todo = games.Where(g => !_lib.IsReady(g.Id) && !_failed.Contains(g.Id)).Take(Math.Max(0, PreloadCount - ready)).ToList();
        Status = new(todo.Count == 0 ? "ready" : "downloading", games.Count, ready, todo.Count, null);
        var left = todo.Count;
        foreach (var g in todo)
        {
            try { await _lib.Prepare(g.Id); ready++; }
            catch (Exception ex) { _failed.Add(g.Id); _log.LogInformation("Couldn't pre-download {Title}: {Msg}", g.Title, ex.Message); }
            Status = new("downloading", games.Count, ready, --left, null);
        }
        Status = Status with { Stage = "ready", Queued = 0 };
    }
}
