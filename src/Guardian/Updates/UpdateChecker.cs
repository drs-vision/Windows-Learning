using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Models;
using CoinQuest.Guardian.Economy;

namespace CoinQuest.Guardian.Updates;

/// <summary>
/// Checks GitHub Releases for a newer build every 6 hours, downloads it, verifies the SHA-256 the
/// release workflow published next to it, and hands off to CoinQuest.Updater.exe to swap files and
/// restart the service. Applies right away when no managed child is at the keyboard; otherwise waits.
/// </summary>
public sealed class UpdateChecker
{
    private readonly SessionMonitor _session;
    private readonly UnlockManager _unlocks;
    private DateTimeOffset? _stagedAt;
    private readonly ILogger<UpdateChecker> _log;
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private string? _stagedVersion;
    private string? _stagedDir;

    public const string AssetName = "CoinQuest-win-x64.zip";
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(30);
    /// <summary>An update waiting this long installs even in the middle of paid game/YouTube time (the time itself is kept).</summary>
    public static readonly TimeSpan MaxWait = TimeSpan.FromHours(2);

    public sealed record UpdateStatus(string Current, string? Latest, string State, string? Message, DateTimeOffset? LastChecked);
    public UpdateStatus Status { get; private set; }

    public UpdateChecker(SessionMonitor session, UnlockManager unlocks, ILogger<UpdateChecker> log)
    {
        _session = session; _unlocks = unlocks; _log = log;
        _http = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("CoinQuest", Current));
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        Status = new UpdateStatus(Current, null, "idle", null, null);
    }

    public static string Current => typeof(UpdateChecker).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    public async Task RunAsync(CancellationToken ct)
    {
        await Task.Delay(TimeSpan.FromMinutes(2), ct); // let the machine settle after boot
        if (CoinQuest.Shared.Config.Paths.E2ETestMode) { _log.LogInformation("Test machine: self-update off"); return; }
        while (!ct.IsCancellationRequested)
        {
            try { await CheckNow(ct); } catch (Exception ex) { _log.LogWarning(ex, "Update check failed"); }
            await Task.Delay(Interval, ct);
        }
    }

    /// <summary>Check, download if newer, apply if it's a good moment. Safe to call from the Parent Console.</summary>
    public async Task<UpdateStatus> CheckNow(CancellationToken ct = default, bool applyEvenIfChildActive = false)
    {
        if (!await _gate.WaitAsync(0, ct)) return Status;
        try
        {
            Status = Status with { State = "checking", LastChecked = DateTimeOffset.UtcNow };
            var rel = await _http.GetStringAsync($"https://api.github.com/repos/{Paths.GitHubOwner}/{Paths.GitHubRepo}/releases/latest", ct);
            var node = JsonNode.Parse(rel)!;
            var tag = node["tag_name"]?.GetValue<string>() ?? "";
            var latest = tag.TrimStart('v');
            if (!Version.TryParse(latest, out var latestV) || !Version.TryParse(Current, out var currentV))
            {
                Status = new UpdateStatus(Current, latest, "error", $"unparseable version '{tag}'", DateTimeOffset.UtcNow);
                return Status;
            }
            if (latestV <= currentV)
            {
                Status = new UpdateStatus(Current, latest, "upToDate", null, DateTimeOffset.UtcNow);
                return Status;
            }

            if (_stagedVersion != latest)
            {
                string? zipUrl = null, shaUrl = null;
                foreach (var a in node["assets"]?.AsArray() ?? new JsonArray())
                {
                    var name = a?["name"]?.GetValue<string>();
                    if (name == AssetName) zipUrl = a?["browser_download_url"]?.GetValue<string>();
                    if (name == AssetName + ".sha256") shaUrl = a?["browser_download_url"]?.GetValue<string>();
                }
                if (zipUrl is null || shaUrl is null)
                {
                    Status = new UpdateStatus(Current, latest, "error", "release is missing the zip or its checksum", DateTimeOffset.UtcNow);
                    return Status;
                }

                Status = Status with { State = "downloading", Latest = latest };
                Directory.CreateDirectory(Paths.UpdateStaging);
                var zipPath = Path.Combine(Paths.UpdateStaging, AssetName);
                await using (var fs = File.Create(zipPath))
                await using (var s = await _http.GetStreamAsync(zipUrl, ct)) await s.CopyToAsync(fs, ct);

                var expected = (await _http.GetStringAsync(shaUrl, ct)).Trim().Split(' ')[0].ToLowerInvariant();
                string actual;
                await using (var fs = File.OpenRead(zipPath)) actual = Convert.ToHexString(await SHA256.HashDataAsync(fs, ct)).ToLowerInvariant();
                if (actual != expected)
                {
                    File.Delete(zipPath);
                    Status = new UpdateStatus(Current, latest, "error", "checksum mismatch — download discarded", DateTimeOffset.UtcNow);
                    _log.LogError("Update {Latest} checksum mismatch: expected {E} got {A}", latest, expected, actual);
                    return Status;
                }

                var extractDir = Path.Combine(Paths.UpdateStaging, "v" + latest);
                if (Directory.Exists(extractDir)) Directory.Delete(extractDir, true);
                ZipFile.ExtractToDirectory(zipPath, extractDir);
                _stagedVersion = latest; _stagedDir = extractDir; _stagedAt = DateTimeOffset.UtcNow;
                _log.LogInformation("Update {Latest} staged at {Dir}", latest, extractDir);
            }

            Status = new UpdateStatus(Current, latest, "readyToApply", null, DateTimeOffset.UtcNow);
            if (applyEvenIfChildActive || GoodMoment()) Apply();
            return Status;
        }
        catch (Exception ex)
        {
            Status = new UpdateStatus(Current, Status.Latest, "error", ex.Message, DateTimeOffset.UtcNow);
            throw;
        }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// Install now unless the child is in the middle of paid game or YouTube time (then wait — at most two hours).
    /// A lesson in progress just restarts the app for a few seconds; progress and coins are kept by the service.
    /// </summary>
    private bool GoodMoment()
    {
        if (_session.Current is not { } s) return true;
        if (_stagedAt is { } at && DateTimeOffset.UtcNow - at > MaxWait) return true;
        return !_unlocks.ActiveFor(s.Child.Id).Any(u => u.Kind is PrizeKind.ArcadeUnlock or PrizeKind.YouTube);
    }

    /// <summary>Called by the worker when a child logs off and an update is waiting.</summary>
    public void ApplyIfStaged() { if (_stagedDir is not null) Apply(); }

    private DateTimeOffset? _applyStarted;

    private void Apply()
    {
        if (_stagedDir is null) return;
        // An earlier attempt is still running (or hung): give it 3 minutes, then report what its log says and retry.
        if (_applyStarted is { } started)
        {
            if (DateTimeOffset.UtcNow - started < TimeSpan.FromMinutes(3)) { Status = Status with { State = "applying" }; return; }
            foreach (var p in Process.GetProcessesByName("CoinQuest.Updater")) { try { p.Kill(true); } catch { } }
        }
        var updater = Path.Combine(_stagedDir, "CoinQuest.Updater.exe");
        if (!File.Exists(updater)) updater = Path.Combine(Paths.InstallRoot, "CoinQuest.Updater.exe");
        // Run the updater from a copy outside the install dir so it can overwrite everything, including itself.
        // A fresh folder each time, so a stuck earlier copy can never block the next attempt.
        foreach (var old in Directory.EnumerateDirectories(Paths.UpdateStaging, "updater-run*"))
            try { Directory.Delete(old, true); } catch { }
        var runFrom = Path.Combine(Paths.UpdateStaging, "updater-run-" + DateTime.UtcNow.Ticks);
        Directory.CreateDirectory(runFrom);
        foreach (var f in Directory.EnumerateFiles(Path.GetDirectoryName(updater)!, "CoinQuest.Updater.*"))
            File.Copy(f, Path.Combine(runFrom, Path.GetFileName(f)), overwrite: true);
        var exe = Path.Combine(runFrom, "CoinQuest.Updater.exe");
        var log = Path.Combine(Paths.LogDir, "updater.log");
        _log.LogInformation("Applying update {Version}: launching {Exe}", _stagedVersion, exe);
        _applyStarted = DateTimeOffset.UtcNow;
        Status = Status with { State = "applying", Message = null };
        var proc = Process.Start(new ProcessStartInfo(exe)
        {
            ArgumentList = { "--source", _stagedDir, "--target", Paths.InstallRoot, "--service", Paths.ServiceName, "--log", log },
            UseShellExecute = false, CreateNoWindow = true,
        });
        // If we're still alive when the updater exits, the update didn't take: say why instead of "applying" forever.
        if (proc is not null)
        {
            proc.EnableRaisingEvents = true;
            proc.Exited += (_, _) =>
            {
                string tail = "";
                try { tail = string.Join(" | ", File.ReadLines(log).TakeLast(3)); } catch { }
                _applyStarted = null;
                Status = Status with { State = "error", Message = $"the updater stopped (exit {SafeExit(proc)}) without installing {_stagedVersion}. {tail}".Trim() };
                _log.LogWarning("Updater exited without restarting us: {Msg}", Status.Message);
            };
        }
    }

    private static string SafeExit(Process p) { try { return p.ExitCode.ToString(); } catch { return "?"; } }
}
