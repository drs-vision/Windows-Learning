using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using CoinQuest.Shared.Config;

namespace CoinQuest.Guardian.DiscGames;

/// <summary>
/// The family's own classic learning CDs (ClueFinders and other Learning Company titles, late 1990s), each imported
/// once from its disc image and kept in C:\ProgramData\CoinQuest\discgames\&lt;id&gt;:
///   cd\    every file from the disc (the game reads its pictures and sounds from here instead of a CD drive)
///   app\   the program folder the game's installer would have copied (its INI points at cd\; players' saves land here)
/// These are 32-bit Windows programs and run directly. Coins come from the players' save files: the game keeps
/// "playerName / playerLevel / playerScore" for each player, and a higher level or score means real progress.
/// </summary>
public sealed class DiscGameService
{
    private readonly ILogger<DiscGameService> _log;
    private readonly object _gate = new();
    private FileSystemWatcher? _watch;
    private Timer? _debounce;

    public static string Root => Path.Combine(Paths.DataRoot, "discgames");
    private static string StateFile => Path.Combine(Root, "coinquest-progress.json");

    public string Stage { get; private set; } = "idle"; // idle | importing | error
    public string? Message { get; private set; }

    /// <summary>Real progress was saved: (game title, player, what changed). The router pays, under its lock.</summary>
    public event Action<List<string>>? ProgressSaved;

    private static readonly EnumerationOptions Flat = new() { MatchCasing = MatchCasing.CaseInsensitive };
    private static readonly EnumerationOptions Deep = new() { MatchCasing = MatchCasing.CaseInsensitive, RecurseSubdirectories = true };

    public sealed record Game(string Id, string Title, string Exe, string Ini);

    /// <summary>Friendly names for titles we know; anything else uses the name in its own INI file.</summary>
    private static readonly Dictionary<string, string> KnownTitles = new(StringComparer.OrdinalIgnoreCase)
    {
        ["cfmath32"] = "ClueFinders Math Adventures (ages 9–12)",
        ["5thad32"] = "ClueFinders 5th Grade Adventures",
        ["6thad32"] = "ClueFinders 6th Grade Adventures",
        ["4thad32"] = "ClueFinders 4th Grade Adventures",
        ["3rdadv32"] = "ClueFinders 3rd Grade Adventures",
    };

    public DiscGameService(ILogger<DiscGameService> log)
    {
        _log = log;
        try
        {
            Directory.CreateDirectory(Root);
            foreach (var g in Games()) OpenUp(Path.Combine(Root, g.Id, "app"));
            StartWatching();
        }
        catch (Exception ex) { _log.LogWarning(ex, "Classic CD games: couldn't start"); }
    }

    public static List<Game> Games()
    {
        var list = new List<Game>();
        if (!Directory.Exists(Root)) return list;
        foreach (var dir in Directory.EnumerateDirectories(Root))
        {
            try
            {
                var f = Path.Combine(dir, "game.json");
                if (File.Exists(f) && JsonSerializer.Deserialize<Game>(File.ReadAllText(f)) is { } g && File.Exists(Path.Combine(dir, "app", g.Exe))) list.Add(g);
            }
            catch { }
        }
        return list.OrderBy(g => g.Title).ToList();
    }

    public static Game? Find(string id) => Games().FirstOrDefault(g => g.Id.Equals(id, StringComparison.OrdinalIgnoreCase));

    public object Status() => new
    {
        stage = Stage,
        message = Message,
        games = Games().Select(g => new
        {
            g.Id, g.Title,
            players = Players(g).Select(p => new { p.Name, p.Level, p.Score }),
        }),
        root = Root,
    };

    // ---- import -------------------------------------------------------------------------------------------------

    public void StartImport(string source)
    {
        lock (_gate)
        {
            if (Stage == "importing") throw new InvalidOperationException("already importing a disc — wait for it to finish");
            if (!File.Exists(source) && !Directory.Exists(source)) throw new FileNotFoundException("CoinQuest can't see that file. Put it somewhere like Downloads or Documents and try again.");
            Stage = "importing"; Message = "Starting…";
        }
        _ = Task.Run(() =>
        {
            try
            {
                var g = Install(source, m => Message = m);
                Stage = "idle"; Message = $"Imported {g.Title}. The disc image isn't needed any more.";
                _log.LogInformation("Classic CD game imported: {Title} ({Id})", g.Title, g.Id);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Classic CD game import failed");
                Stage = "error"; Message = ex.Message;
            }
        });
    }

    private Game Install(string source, Action<string> progress)
    {
        var work = Path.Combine(Root, ".import");
        if (Directory.Exists(work)) Directory.Delete(work, true);
        var cd = Path.Combine(work, "cd");
        var (files, bytes) = DiscImage.ExtractAll(source, cd, Path.Combine(work, "tmp"), progress);
        try { Directory.Delete(Path.Combine(work, "tmp"), true); } catch { }
        progress("Finding the program on the disc…");

        // Learning Company titles of this era ship their 32-bit program in a folder (e.g. 95INSTAL) beside an INI
        // that says where the CD is ("CDDrive="). That folder is what their installer copies to the hard disk.
        var candidates = Directory.EnumerateFiles(cd, "*.ini", Deep)
            .Where(i => !i.Contains(Path.DirectorySeparatorChar + "DEMOS" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                     && !i.Contains(Path.DirectorySeparatorChar + "INSTALL" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            .Select(i => (Ini: i, Text: SafeRead(i)))
            .Where(x => x.Text.Contains("CDDrive", StringComparison.OrdinalIgnoreCase))
            .Select(x => (x.Ini, x.Text, Exe: PickExe(Path.GetDirectoryName(x.Ini)!)))
            .Where(x => x.Exe is not null)
            .ToList();
        if (candidates.Count == 0)
        {
            var exes = Directory.EnumerateFiles(cd, "*.exe", Deep).Select(e => Path.GetRelativePath(cd, e)).Take(12);
            throw new InvalidOperationException("CoinQuest doesn't know how to run this disc yet (no Learning Company program folder found). Programs on it: " + string.Join(", ", exes));
        }
        var (ini, text, exe) = candidates.OrderByDescending(c => c.Exe!.Contains("32", StringComparison.OrdinalIgnoreCase)).First();
        var id = Path.GetFileNameWithoutExtension(exe!).ToLowerInvariant();
        var section = text.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.StartsWith('[') && l.EndsWith(']'))?.Trim('[', ']') ?? id;
        var title = KnownTitles.TryGetValue(id, out var t) ? t : section.Replace(" - CD", "").Trim();

        var dest = Path.Combine(Root, id);
        var app = Path.Combine(dest, "app");
        progress("Setting up " + title + "…");
        // Keep any players from an earlier import of the same game.
        var keep = new Dictionary<string, byte[]>();
        if (Directory.Exists(app))
            foreach (var f in Directory.EnumerateFiles(app, "*.dat", Flat)) keep[Path.GetFileName(f)] = File.ReadAllBytes(f);
        if (Directory.Exists(dest)) Directory.Delete(dest, true);
        Directory.CreateDirectory(dest);
        Directory.Move(cd, Path.Combine(dest, "cd"));
        var programDir = Path.Combine(dest, "cd", Path.GetRelativePath(cd, Path.GetDirectoryName(ini)!));
        CopyFolder(programDir, app);
        foreach (var (name, data) in keep) File.WriteAllBytes(Path.Combine(app, name), data);
        var iniName = Path.GetFileName(ini);
        PointIniAtDisc(Path.Combine(app, iniName), Path.Combine(dest, "cd"));
        var game = new Game(id, title, Path.GetFileName(exe!), iniName);
        File.WriteAllText(Path.Combine(dest, "game.json"), JsonSerializer.Serialize(game));
        OpenUp(app);
        try { Directory.Delete(work, true); } catch { }
        _log.LogInformation("Disc {Id}: {Files} files, {MB} MB; program {Exe}", id, files, bytes / 1048576, exe);
        return game;
    }

    private static string? PickExe(string dir)
    {
        var exes = Directory.EnumerateFiles(dir, "*.exe", Flat).Where(e => !Path.GetFileName(e).StartsWith("SETUP", StringComparison.OrdinalIgnoreCase)
                                                                && !Path.GetFileName(e).StartsWith("UNINST", StringComparison.OrdinalIgnoreCase)).ToList();
        return exes.OrderByDescending(e => Path.GetFileNameWithoutExtension(e).EndsWith("32", StringComparison.OrdinalIgnoreCase)).ThenByDescending(e => new FileInfo(e).Length).FirstOrDefault();
    }

    /// <summary>Set CDDrive= to CoinQuest's copy of the disc (a folder path works as well as a drive letter).</summary>
    private static void PointIniAtDisc(string iniPath, string cdDir)
    {
        var lines = File.ReadAllLines(iniPath).ToList();
        var value = "CDDrive=" + cdDir.TrimEnd('\\') + "\\";
        var i = lines.FindIndex(l => l.TrimStart().StartsWith("CDDrive", StringComparison.OrdinalIgnoreCase));
        if (i >= 0) lines[i] = value; else lines.Insert(Math.Min(1, lines.Count), value);
        File.WriteAllLines(iniPath, lines);
    }

    private static string SafeRead(string f) { try { return File.ReadAllText(f, Encoding.Latin1); } catch { return ""; } }

    private static void CopyFolder(string from, string to)
    {
        foreach (var file in Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories))
        {
            var dest = Path.Combine(to, Path.GetRelativePath(from, file));
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.Copy(file, dest, true);
            File.SetAttributes(dest, FileAttributes.Normal); // files off a CD are read-only
        }
    }

    private static void OpenUp(string dir)
    {
        Directory.CreateDirectory(dir);
        try
        {
            var di = new DirectoryInfo(dir);
            var sec = di.GetAccessControl();
            sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.Modify,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            di.SetAccessControl(sec);
        }
        catch { /* best effort */ }
    }

    // ---- progress -----------------------------------------------------------------------------------------------

    public sealed record Player(string Name, int Level, int Score);

    /// <summary>Players from the game's save file(s): text records "playerName\n…\nplayerLevel\n…\nplayerScore\n…\nPLAYER_END".</summary>
    public static List<Player> Players(Game g)
    {
        var list = new List<Player>();
        var app = Path.Combine(Root, g.Id, "app");
        if (!Directory.Exists(app)) return list;
        foreach (var f in Directory.EnumerateFiles(app, "*.dat", Flat))
        {
            string s;
            try { s = Encoding.Latin1.GetString(File.ReadAllBytes(f)); } catch { continue; }
            list.AddRange(ParsePlayers(s));
        }
        return list;
    }

    public static List<Player> ParsePlayers(string s)
    {
        var list = new List<Player>();
        int at = 0;
        while ((at = s.IndexOf("playerName\n", at, StringComparison.Ordinal)) >= 0)
        {
            at += "playerName\n".Length;
            var nl = s.IndexOf('\n', at); if (nl < 0) break;
            var name = s[at..nl].Trim();
            var end = s.IndexOf("PLAYER_END", nl, StringComparison.Ordinal); if (end < 0) end = s.Length;
            var block = s[nl..end];
            list.Add(new Player(name, Num(block, "playerLevel"), Num(block, "playerScore")));
            at = end;
        }
        return list.Where(p => p.Name.Length > 0).ToList();
    }

    private static int Num(string block, string key)
    {
        var i = block.IndexOf("\n" + key + "\n", StringComparison.Ordinal);
        if (i < 0) return 0;
        i += key.Length + 2;
        var j = block.IndexOf('\n', i);
        return int.TryParse(j > i ? block[i..j].Trim() : "", out var n) ? n : 0;
    }

    private void StartWatching()
    {
        _watch?.Dispose();
        _watch = new FileSystemWatcher(Root, "*.*") { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName };
        FileSystemEventHandler h = (_, e) => { if (IsSave(e.FullPath)) Debounce(); };
        _watch.Changed += h; _watch.Created += h;
        _watch.Renamed += (_, e) => { if (IsSave(e.FullPath)) Debounce(); };
        _watch.EnableRaisingEvents = true;
    }

    private static bool IsSave(string path) =>
        path.EndsWith(".dat", StringComparison.OrdinalIgnoreCase) && path.Contains(Path.DirectorySeparatorChar + "app" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private void Debounce()
    {
        lock (_gate) { _debounce?.Dispose(); _debounce = new Timer(_ => { try { CheckProgress(); } catch (Exception ex) { _log.LogWarning(ex, "Classic CD game progress check failed"); } }, null, 5000, Timeout.Infinite); }
    }

    private sealed class ProgressState { public Dictionary<string, int[]> Players { get; set; } = new(); public DateTimeOffset LastPaid { get; set; } }

    /// <summary>Pay when a known player's level or score went up (a finished puzzle or activity).</summary>
    public void CheckProgress()
    {
        lock (_gate)
        {
            ProgressState st;
            try { st = JsonSerializer.Deserialize<ProgressState>(File.ReadAllText(StateFile)) ?? new(); } catch { st = new(); }
            var changed = new List<string>();
            // Keep every saved version (small) so payouts can be tuned per activity once more saves are seen.
            foreach (var g in Games())
                foreach (var f in Directory.EnumerateFiles(Path.Combine(Root, g.Id, "app"), "*.dat", Flat))
                    try
                    {
                        var hist = Path.Combine(Root, g.Id, "history");
                        Directory.CreateDirectory(hist);
                        var stamp = File.GetLastWriteTime(f).ToString("yyyyMMdd-HHmmss");
                        var copy = Path.Combine(hist, $"{stamp}-{Path.GetFileName(f)}");
                        if (!File.Exists(copy)) File.Copy(f, copy);
                    }
                    catch { }
            foreach (var g in Games())
                foreach (var p in Players(g))
                {
                    var key = g.Id + "/" + p.Name;
                    var now = new[] { p.Level, p.Score };
                    if (st.Players.TryGetValue(key, out var was))
                    {
                        if (p.Level > was[0] || p.Score > was[1])
                        {
                            changed.Add($"{g.Title}: {p.Name}" + (p.Level > was[0] ? $" reached level {p.Level}" : $" score {was[1]} → {p.Score}"));
                            _log.LogInformation("Classic CD progress: {Game} {Player} level {L} score {S}", g.Id, p.Name, p.Level, p.Score);
                        }
                    }
                    else if (p.Level > 0 || p.Score > 0) changed.Add($"{g.Title}: {p.Name} score {p.Score}"); // first time we see real progress
                    st.Players[key] = new[] { Math.Max(p.Level, was?[0] ?? 0), Math.Max(p.Score, was?[1] ?? 0) };
                }
            if (changed.Count > 0 && DateTimeOffset.UtcNow - st.LastPaid > TimeSpan.FromMinutes(1))
            {
                st.LastPaid = DateTimeOffset.UtcNow;
                ProgressSaved?.Invoke(changed);
            }
            Directory.CreateDirectory(Root);
            File.WriteAllText(StateFile, JsonSerializer.Serialize(st));
        }
    }
}
