using System.IO.Compression;
using System.Net.Http.Headers;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Models;

namespace CoinQuest.Guardian.Rwt;

/// <summary>
/// Read, Write &amp; Type! (The Learning Company, 1995) — the family's own copy, imported once from its disc image and kept
/// in C:\ProgramData\CoinQuest\rwt. It is a 16-bit Windows 3.1 program, so it runs through otvdm (winevdm, the open-source
/// 16-bit layer for 64-bit Windows), downloaded from its GitHub releases. Coins come from the game's own progress files.
/// </summary>
public sealed class RwtService
{
    private readonly ILogger<RwtService> _log;
    private readonly HttpClient _http;
    private FileSystemWatcher? _watch;
    private readonly object _gate = new();
    public static string Root => Path.Combine(Paths.DataRoot, "rwt");
    public static string OtvdmDir => Path.Combine(Paths.DataRoot, "otvdm");
    public static string SigninDir => Path.Combine(Root, "SIGNIN");
    private static string StateFile => Path.Combine(Root, "coinquest-progress.json");

    public string Stage { get; private set; } = "idle"; // idle | importing | ready | error
    public string? Message { get; private set; }
    public List<string> LastPatches { get; private set; } = new();

    /// <summary>A player's progress file was saved with new content (player names). The router pays, under its lock.</summary>
    public event Action<List<string>>? ProgressSaved;

    public RwtService(ILogger<RwtService> log)
    {
        _log = log;
        _http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromMinutes(5) };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("CoinQuest", "1.0"));
        if (Installed)
        {
            Stage = "ready";
            // New fixes ship with updates: re-apply the current set to the original program (kept as RWTWINCD.ORG).
            try { LastPatches = RwtInstaller.PatchExe(Path.Combine(Root, "cd", "RWTWINCD.EXE")); _log.LogInformation("RWT fixes: {P}", string.Join(", ", LastPatches)); }
            catch (Exception ex) { _log.LogWarning(ex, "Couldn't refresh Read, Write & Type fixes"); }
            OpenUp(SigninDir); // the game (running as the child) writes each player's progress here
            StartWatching();
        }
    }

    public static bool Installed => File.Exists(Path.Combine(Root, "cd", "RWTWINCD.EXE"));
    public static string? Otvdm => new[] { "otvdmw.exe", "otvdm.exe" }.Select(n => Directory.Exists(OtvdmDir) ? Directory.EnumerateFiles(OtvdmDir, n, SearchOption.AllDirectories).FirstOrDefault() : null).FirstOrDefault(p => p is not null);

    public object Status() => new
    {
        installed = Installed,
        otvdm = Otvdm is not null,
        stage = Stage,
        message = Message,
        patches = LastPatches,
        players = Players().Select(p => p.Level > 0 ? $"{p.Name} (level {p.Level})" : p.Name).ToList(),
        root = Root,
    };

    /// <summary>Import from a .iso, a .zip holding one, or a folder copied from the CD. Runs in the background.</summary>
    public void StartImport(string source)
    {
        lock (_gate)
        {
            if (Stage == "importing") throw new InvalidOperationException("already importing");
            if (!File.Exists(source) && !Directory.Exists(source)) throw new FileNotFoundException("CoinQuest can't see that file. Put it somewhere like Downloads or Documents and try again.");
            Stage = "importing"; Message = "Starting…";
        }
        _ = Task.Run(async () =>
        {
            try
            {
                var mb = await ImportNow(source, m => Message = m);
                Stage = "ready"; Message = $"Imported ({mb} MB). The disc image isn't needed any more.";
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Read, Write & Type import failed");
                Stage = Installed ? "ready" : "error"; Message = ex.Message;
            }
        });
    }

    /// <summary>
    /// Set the game up from a disc image or a folder copied off the disc (also used when the disc turns up in a
    /// Classic CD games import). Players' progress (SIGNIN) is kept. Returns the size in MB.
    /// </summary>
    public async Task<long> ImportNow(string source, Action<string> progress)
    {
        var r = RwtInstaller.Install(source, Root, progress);
        LastPatches = r.Patches;
        OpenUp(SigninDir);
        _log.LogInformation("Read, Write & Type imported: {Files} files, {MB} MB; patches: {P}", r.Files, r.Bytes / 1048576, string.Join(", ", r.Patches));
        progress("Getting the 16-bit Windows helper (otvdm)…");
        await EnsureOtvdm();
        StartWatching();
        if (Stage != "importing") { Stage = "ready"; Message = $"Imported ({r.Bytes / 1048576} MB)."; }
        return r.Bytes / 1048576;
    }

    /// <summary>otvdm (github.com/otya128/winevdm, GPL-2.0): runs 16-bit Windows programs on 64-bit Windows.</summary>
    public async Task EnsureOtvdm(bool force = false)
    {
        if (Otvdm is not null && !force) return;
        var rel = JsonNode.Parse(await _http.GetStringAsync("https://api.github.com/repos/otya128/winevdm/releases/latest"))!;
        var asset = rel["assets"]!.AsArray().Select(a => a!).FirstOrDefault(a => a["name"]!.ToString().EndsWith(".zip", StringComparison.OrdinalIgnoreCase) && a["name"]!.ToString().StartsWith("otvdm", StringComparison.OrdinalIgnoreCase))
                    ?? throw new InvalidOperationException("couldn't find the otvdm download");
        var zip = Path.Combine(Paths.DataRoot, "otvdm.zip");
        await using (var f = File.Create(zip)) await (await _http.GetStreamAsync(asset["browser_download_url"]!.ToString())).CopyToAsync(f);
        var tmp = OtvdmDir + ".new";
        if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
        ZipFile.ExtractToDirectory(zip, tmp);
        if (Directory.Exists(OtvdmDir)) Directory.Delete(OtvdmDir, true);
        Directory.Move(tmp, OtvdmDir);
        File.Delete(zip);
        OpenUp(OtvdmDir, write: true); // otvdm keeps its settings beside itself
        _log.LogInformation("otvdm {Tag} installed", rel["tag_name"]);
    }

    private static void OpenUp(string dir, bool write = true)
    {
        Directory.CreateDirectory(dir);
        try
        {
            var di = new DirectoryInfo(dir);
            var sec = di.GetAccessControl();
            var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
            sec.AddAccessRule(new FileSystemAccessRule(users, write ? FileSystemRights.Modify : FileSystemRights.ReadAndExecute,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            di.SetAccessControl(sec);
        }
        catch { /* best effort */ }
    }

    // ---- coins from progress ------------------------------------------------------------------------------------

    private void StartWatching()
    {
        try
        {
            Directory.CreateDirectory(SigninDir);
            _watch?.Dispose();
            _watch = new FileSystemWatcher(SigninDir, "*.*") { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName };
            _watch.Changed += (_, _) => Debounce();
            _watch.Created += (_, _) => Debounce();
            _watch.Renamed += (_, _) => Debounce();
            _watch.EnableRaisingEvents = true;
        }
        catch (Exception ex) { _log.LogWarning(ex, "Can't watch Read, Write & Type progress"); }
    }

    private Timer? _debounce;
    private void Debounce()
    {
        lock (_gate) { _debounce?.Dispose(); _debounce = new Timer(_ => { try { CheckProgress(); } catch (Exception ex) { _log.LogWarning(ex, "RWT progress check failed"); } }, null, 8000, Timeout.Infinite); }
    }

    private sealed class ProgressState { public Dictionary<string, string> Hashes { get; set; } = new(); public DateTimeOffset LastPaid { get; set; } }

    /// <summary>
    /// The game saves a player's file when real work is done (lessons, levels). Each new save pays the RWT rate
    /// (at most once every few minutes, within the daily cap). Every saved version is kept under rwt\history so the
    /// payout can be made level-by-level once the file format is decoded from real saves.
    /// </summary>
    public void CheckProgress()
    {
        lock (_gate)
        {
            ProgressState st;
            try { st = JsonSerializer.Deserialize<ProgressState>(File.ReadAllText(StateFile)) ?? new(); } catch { st = new(); }
            var changed = new List<string>();
            foreach (var f in Directory.EnumerateFiles(SigninDir, "*.dat", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(SigninDir, f);
                // SIGNIN\RWTWINCD.DAT is only the sign-in list; each player's progress is SIGNIN\<name><n>\RWTWINCD.DAT,
                // which the game rewrites after every finished activity.
                if (!rel.Contains(Path.DirectorySeparatorChar)) continue;
                byte[] bytes;
                try { bytes = File.ReadAllBytes(f); } catch { continue; } // still being written; the next change will catch it
                var h = Convert.ToHexString(SHA256.HashData(bytes));
                if (st.Hashes.TryGetValue(rel, out var old) && old == h) continue;
                var isNew = !st.Hashes.ContainsKey(rel);
                st.Hashes[rel] = h;
                try
                {
                    var hist = Path.Combine(Root, "history", DateTime.Now.ToString("yyyyMMdd-HHmmss"));
                    Directory.CreateDirectory(hist);
                    File.WriteAllBytes(Path.Combine(hist, rel.Replace(Path.DirectorySeparatorChar, '_')), bytes);
                }
                catch { }
                var who = PlayerName(Path.GetDirectoryName(rel)!);
                var lvl = LevelOf(bytes);
                _log.LogInformation("RWT progress saved for {Player} (level {Level})", who, lvl);
                // A player's file first appears when they finish their first activity (signing in alone writes nothing
                // there), so a brand-new file counts too, unless it is old (found when tracking first started).
                var fresh = DateTime.Now - File.GetLastWriteTime(f) < TimeSpan.FromMinutes(30);
                if (!isNew || fresh) changed.Add(lvl > 0 ? $"{who}, level {lvl}" : who);
            }
            if (changed.Count > 0 && DateTimeOffset.UtcNow - st.LastPaid > TimeSpan.FromMinutes(2))
            {
                st.LastPaid = DateTimeOffset.UtcNow;
                ProgressSaved?.Invoke(changed);
            }
            File.WriteAllText(StateFile, JsonSerializer.Serialize(st));
        }
    }

    public sealed record Player(string Name, int Level);

    /// <summary>Signed-in players: one folder per player (name, first 6 letters, plus a number), each with its progress file.</summary>
    public static List<Player> Players()
    {
        var list = new List<Player>();
        if (!Directory.Exists(SigninDir)) return list;
        foreach (var dir in Directory.EnumerateDirectories(SigninDir))
        {
            var f = Path.Combine(dir, "RWTWINCD.DAT");
            int lvl = 0;
            try { if (File.Exists(f)) lvl = LevelOf(File.ReadAllBytes(f)); } catch { }
            list.Add(new Player(PlayerName(Path.GetFileName(dir)), lvl));
        }
        return list;
    }

    private static string PlayerName(string dir) => dir.TrimEnd('0', '1', '2', '3', '4', '5', '6', '7', '8', '9').Replace('_', ' ');

    /// <summary>
    /// A player's file starts with a 0x16C-byte header: format version (0x102+), the lesson stage (0–39) and the step
    /// within it (3 = stage finished). The game shows "Level n" as stage/4 + 1 — ten levels.
    /// </summary>
    public static int LevelOf(byte[] b)
    {
        if (b.Length < 0x16C || BitConverter.ToUInt16(b, 0) < 0x102) return 0;
        int stage = BitConverter.ToUInt16(b, 2), step = BitConverter.ToUInt16(b, 4);
        if (step == 3) stage++;
        return Math.Min(stage, 39) / 4 + 1;
    }
}
