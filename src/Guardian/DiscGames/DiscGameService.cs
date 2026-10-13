using System.IO.Compression;
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

    /// <summary>
    /// Import from a disc image (.zip/.iso/.img/.bin), a folder copied from a disc, a folder (or .zip) holding several
    /// disc images, or a share link to one (a Dropbox file or folder link is downloaded first). Runs in the background.
    /// </summary>
    public void StartImport(string source)
    {
        source = source.Trim().Trim('"');
        var isLink = source.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || source.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
        lock (_gate)
        {
            if (Stage == "importing") throw new InvalidOperationException("already importing — wait for it to finish");
            if (!isLink && !File.Exists(source) && !Directory.Exists(source)) throw new FileNotFoundException("CoinQuest can't see that file or folder. Put it somewhere like Downloads or Documents and try again.");
            Stage = "importing"; Message = "Starting…";
        }
        _ = Task.Run(async () =>
        {
            var temp = Path.Combine(Root, ".incoming");
            try
            {
                if (Directory.Exists(temp)) Directory.Delete(temp, true);
                var local = isLink ? await Download(source, temp) : source;
                var discs = FindDiscs(local, temp);
                var done = new List<string>(); var failed = new List<string>();
                for (int i = 0; i < discs.Count; i++)
                {
                    var name = Path.GetFileNameWithoutExtension(discs[i]);
                    var prefix = discs.Count > 1 ? $"[{i + 1}/{discs.Count}] {name}: " : "";
                    try { done.Add(Install(discs[i], m => Message = prefix + m).Title); }
                    catch (Exception ex) { failed.Add($"{name} ({ex.Message})"); _log.LogWarning(ex, "Classic CD game import failed: {Disc}", discs[i]); }
                }
                Message = (done.Count > 0 ? $"Imported {string.Join(", ", done)}. " : "") + (failed.Count > 0 ? $"Couldn't import: {string.Join("; ", failed)}" : "The disc images aren't needed any more.");
                Stage = done.Count == 0 ? "error" : "idle";
                _log.LogInformation("Classic CD import: {Done} done, {Failed} failed", done.Count, failed.Count);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Classic CD game import failed");
                Stage = "error"; Message = ex.Message;
            }
            finally { try { if (Directory.Exists(temp)) Directory.Delete(temp, true); } catch { } }
        });
    }

    private static readonly string[] DiscExts = { ".zip", ".iso", ".img", ".bin" };

    /// <summary>The disc images to import from what the parent picked.</summary>
    private List<string> FindDiscs(string source, string temp)
    {
        if (Directory.Exists(source))
        {
            var images = Directory.EnumerateFiles(source, "*", new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 2 })
                .Where(f => DiscExts.Contains(Path.GetExtension(f).ToLowerInvariant())).OrderBy(f => f).ToList();
            var looksLikeDisc = Directory.EnumerateFiles(source, "*.ini", Deep).Any(i => SafeRead(i).Contains("CDDrive", StringComparison.OrdinalIgnoreCase));
            return looksLikeDisc || images.Count == 0 ? new List<string> { source } : images;
        }
        if (source.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            // A .zip of several discs (what a Dropbox folder link downloads as): unpack the inner archives/images.
            using var zip = ZipFile.OpenRead(source);
            var inner = zip.Entries.Where(e => DiscExts.Contains(Path.GetExtension(e.Name).ToLowerInvariant())).ToList();
            var innerZips = inner.Where(e => e.Name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)).ToList();
            if (innerZips.Count > 0)
            {
                Directory.CreateDirectory(temp);
                var list = new List<string>();
                foreach (var e in innerZips)
                {
                    Message = $"Unpacking {e.Name}…";
                    var dest = Path.Combine(temp, Path.GetFileName(e.Name));
                    e.ExtractToFile(dest, true);
                    list.Add(dest);
                }
                return list;
            }
        }
        return new List<string> { source };
    }

    private async Task<string> Download(string url, string temp)
    {
        var u = url;
        if (u.Contains("dropbox.com", StringComparison.OrdinalIgnoreCase))
        {
            u = System.Text.RegularExpressions.Regex.Replace(u, @"([?&])dl=0", "$1dl=1");
            if (!u.Contains("dl=1")) u += (u.Contains('?') ? "&" : "?") + "dl=1";
        }
        else if (u.Contains("drive.google.com", StringComparison.OrdinalIgnoreCase) || u.Contains("onedrive", StringComparison.OrdinalIgnoreCase) || u.Contains("1drv.ms", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Links from that service can't be downloaded directly — download the file(s) first, then import the file or folder. (Dropbox links work.)");
        Directory.CreateDirectory(temp);
        var dest = Path.Combine(temp, "download.zip");
        using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("CoinQuest/1.0");
        using var resp = await http.GetAsync(u, HttpCompletionOption.ResponseHeadersRead);
        if (!resp.IsSuccessStatusCode) throw new InvalidOperationException($"The link didn't download (HTTP {(int)resp.StatusCode}). Check that it's shared as \"anyone with the link\".");
        var name = resp.Content.Headers.ContentDisposition?.FileNameStar ?? resp.Content.Headers.ContentDisposition?.FileName;
        if (name is not null) { name = Path.GetFileName(name.Trim('"')); if (DiscExts.Contains(Path.GetExtension(name).ToLowerInvariant())) dest = Path.Combine(temp, name); }
        var total = resp.Content.Headers.ContentLength;
        await using (var src = await resp.Content.ReadAsStreamAsync())
        await using (var f = File.Create(dest))
        {
            var buf = new byte[1 << 20]; long got = 0; int n; var last = DateTime.MinValue;
            while ((n = await src.ReadAsync(buf)) > 0)
            {
                await f.WriteAsync(buf.AsMemory(0, n)); got += n;
                if (DateTime.UtcNow - last > TimeSpan.FromSeconds(1)) { last = DateTime.UtcNow; Message = total > 0 ? $"Downloading… {got / 1048576} of {total / 1048576} MB" : $"Downloading… {got / 1048576} MB"; }
            }
        }
        _log.LogInformation("Downloaded {MB} MB from the share link", new FileInfo(dest).Length / 1048576);
        return dest;
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
