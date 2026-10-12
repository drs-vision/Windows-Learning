using System.Diagnostics;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Models;

namespace CoinQuest.Guardian.Economy;

/// <summary>
/// Fills the arcade with the curated classics as soon as Flashpoint is on the computer — no per-game clicking.
///  1. Installs CLIFp (Flashpoint's game starter) if it's missing.
///  2. Adds every curated pick that Flashpoint has (skipping ones marked "preview", and anything a parent removed).
///  3. Fetches box art, then downloads each game ahead of time (as the service), so the first play is instant and
///     never depends on the child account reaching the internet.
/// Runs in the background from the Guardian heartbeat; every step is safe to repeat.
/// </summary>
public sealed class ClassicsStocker
{
    private readonly FlashpointService _fp;
    private readonly HouseholdStore _store;
    private readonly ILogger<ClassicsStocker> _log;
    private Task _running = Task.CompletedTask;
    private DateTime _lastRun = DateTime.MinValue;
    private readonly HashSet<string> _prepared = new();
    private readonly HashSet<string> _failed = new();

    public sealed record StockStatus(string Stage, int Approved, int Downloaded, int Queued, string? Error);
    public StockStatus Status { get; private set; } = new("idle", 0, 0, 0, null);

    public ClassicsStocker(FlashpointService fp, HouseholdStore store, ILogger<ClassicsStocker> log) { _fp = fp; _store = store; _log = log; }

    /// <summary>Called every second; starts a pass at most every 2 minutes (or immediately when forced).</summary>
    public void Tick(bool force = false)
    {
        if (!_running.IsCompleted) return;
        if (!force && (DateTime.UtcNow - _lastRun).TotalMinutes < 2) return;
        _lastRun = DateTime.UtcNow;
        _running = Task.Run(Pass);
    }

    private async Task Pass()
    {
        try
        {
            var child = _store.Current.Children.FirstOrDefault();
            if (child is null) return;
            var root = _fp.Root(child.Arcade.FlashpointRoot);
            if (root is null) { Status = new("not-installed", 0, 0, 0, null); return; }

            if (!_fp.HasClifp(root))
            {
                Status = Status with { Stage = "installing-launcher" };
                await _fp.InstallClifp(root);
            }

            if (child.Arcade.AutoClassics) Stock(root);

            // Box art for everything approved (cheap; cached on disk).
            child = _store.Current.Children.First();
            foreach (var g in child.Arcade.Flashpoint) await _fp.Thumb(root, g.Id);

            await Prepare(root, child.Arcade.Flashpoint);
        }
        catch (Exception ex)
        {
            Status = Status with { Error = ex.Message };
            _log.LogWarning(ex, "Classics stocking pass failed");
        }
    }

    /// <summary>Match each curated pick to one specific catalog entry. Strict, so "Flight" never becomes some other game.</summary>
    public FlashpointService.FpGame? Match(string root, Classics.Pick p)
    {
        var hits = _fp.Search(root, p.Search, 8);
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

    private void Stock(string root)
    {
        var child = _store.Current.Children.First();
        var stocked = child.Arcade.StockedPicks.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var have = child.Arcade.Flashpoint.Select(f => f.Id).ToHashSet();
        var add = new List<FlashpointGame>();
        var newlyStocked = new List<string>();
        foreach (var p in Classics.List)
        {
            if (stocked.Contains(p.Search) || p.Note?.Contains("preview", StringComparison.OrdinalIgnoreCase) == true) continue;
            var hit = Match(root, p);
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

    /// <summary>Download approved games one at a time with CLIFp, as the service, so the child never waits or needs the internet.</summary>
    private async Task Prepare(string root, List<FlashpointGame> games)
    {
        var todo = games.Where(g => !_prepared.Contains(g.Id) && !_failed.Contains(g.Id)).ToList();
        var downloaded = games.Count - todo.Count;
        foreach (var g in todo.ToList())
            if (_fp.IsDownloaded(root, g.Id) == true) { _prepared.Add(g.Id); todo.Remove(g); downloaded++; }
        Status = new(todo.Count == 0 ? "ready" : "downloading", games.Count, downloaded, todo.Count, null);

        var left = todo.Count;
        foreach (var g in todo)
        {
            var ok = await RunClifp(root, "prepare", g.Id, TimeSpan.FromMinutes(4));
            if (ok || _fp.IsDownloaded(root, g.Id) == true) { _prepared.Add(g.Id); downloaded++; }
            else _failed.Add(g.Id); // retried after the Guardian restarts; it will still download on first play
            Status = new("downloading", games.Count, downloaded, --left, null);
        }
        Status = Status with { Stage = "ready", Queued = 0 };
    }

    private async Task<bool> RunClifp(string root, string verb, string id, TimeSpan timeout)
    {
        var psi = new ProcessStartInfo(Path.Combine(root, "CLIFp.exe")) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true };
        psi.ArgumentList.Add(verb); psi.ArgumentList.Add("-i"); psi.ArgumentList.Add(id); psi.ArgumentList.Add("-q");
        using var p = Process.Start(psi);
        if (p is null) return false;
        using var cts = new CancellationTokenSource(timeout);
        try { await p.WaitForExitAsync(cts.Token); return p.ExitCode == 0; }
        catch (OperationCanceledException)
        {
            try { p.Kill(true); } catch { }
            _log.LogInformation("CLIFp {Verb} {Id} timed out", verb, id);
            return false;
        }
    }
}
