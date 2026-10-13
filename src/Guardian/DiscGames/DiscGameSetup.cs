using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace CoinQuest.Guardian.DiscGames;

/// <summary>
/// Any disc, the way an old PC did it: CoinQuest keeps the disc image, opens it as a virtual CD drive (Windows'
/// own Mount-DiskImage), and a parent runs the disc's installer once. CoinQuest notes what the installer added
/// (Start-menu shortcut, uninstall entry, new folder) to learn where the game is; Play then "puts the disc in the
/// drive" and starts it. 16-bit programs run through otvdm (as Read, Write &amp; Type! does).
/// </summary>
public sealed partial class DiscGameService
{
    private sealed record Snapshot(HashSet<string> Links, HashSet<string> Uninstall, HashSet<string> Dirs);
    private readonly Dictionary<string, Snapshot> _snapshots = new();

    /// <summary>Not a layout CoinQuest knows: keep the disc image for its own installer.</summary>
    private Game KeepForSetup(string source, string work, string iso, Action<string> progress, string? knownTitle = null)
    {
        var name = knownTitle ?? Path.GetFileNameWithoutExtension(source.TrimEnd('\\', '/'));
        var title = Regex.Replace(name.Replace('_', ' '), @"\b(Win|Win95|Mac|ROM|ISO|EN|CD\d?|\(\d{4}\)|\d{4})\b", "", RegexOptions.IgnoreCase);
        title = Regex.Replace(title, @"\s+", " ").Trim(' ', '-');
        if (title.Length == 0) title = "Classic CD game";
        var id = Regex.Replace(title.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
        if (id.Length > 40) id = id[..40].Trim('-');
        var dest = Path.Combine(Root, id);
        progress("Keeping the disc for its installer…");
        // Re-importing a disc that was already installed keeps its installation.
        Game? before = null;
        try { before = JsonSerializer.Deserialize<Game>(File.ReadAllText(Path.Combine(dest, "game.json"))); } catch { }
        Directory.CreateDirectory(dest);
        var keepIso = Path.Combine(dest, "disc.iso");
        if (File.Exists(keepIso)) { Unmount(keepIso); File.Delete(keepIso); }
        File.Move(iso, keepIso);
        try { DeleteDir(work); } catch { }
        var game = before is { Mode: "installed" } ? before with { Iso = keepIso } : new Game(id, title, "", "", Mode: "pending", Iso: keepIso);
        File.WriteAllText(Path.Combine(dest, "game.json"), JsonSerializer.Serialize(game));
        _log.LogInformation("Disc {Id} kept for its installer ({Mode})", id, game.Mode);
        return game;
    }

    private static void Save(Game g) => File.WriteAllText(Path.Combine(Root, g.Id, "game.json"), JsonSerializer.Serialize(g));

    /// <summary>Show or hide a game on the child's screen (it stays imported).</summary>
    public object SetHidden(string id, bool hidden)
    {
        var g = Find(id) ?? throw new InvalidOperationException("That game isn't imported");
        Save(g with { Hidden = hidden });
        _log.LogInformation("{Title} {State} for the child", g.Title, hidden ? "hidden" : "shown");
        return Status();
    }

    /// <summary>Remove a game from CoinQuest: its copy, its disc image and its CoinQuest settings. A game installed by its
    /// own installer stays in its folder (uninstall it from Windows Settings → Apps if you want it gone completely).</summary>
    public object Remove(string id)
    {
        var g = Find(id) ?? throw new InvalidOperationException("That game isn't imported");
        if (g.Iso is { } iso) Unmount(iso);
        var dir = Path.Combine(Root, g.Id);
        for (int i = 0; i < 5; i++)
        {
            try { if (Directory.Exists(dir)) DeleteDir(dir); break; }
            catch (IOException) when (i < 4) { Thread.Sleep(1000); } // the virtual drive takes a moment to let go
        }
        _dirsCache = (DateTime.MinValue, new());
        _log.LogInformation("Removed {Title} from CoinQuest", g.Title);
        return Status();
    }

    // ---- virtual CD drive ---------------------------------------------------------------------------------------

    /// <summary>Open the disc image as a CD drive (if it isn't already); returns e.g. "E:".</summary>
    public static string Mount(string iso)
    {
        var letter = Ps($"$i = Get-DiskImage -ImagePath '{iso.Replace("'", "''")}'; if (-not $i.Attached) {{ $i = Mount-DiskImage -ImagePath '{iso.Replace("'", "''")}' -PassThru }}; " +
                        "Start-Sleep -Milliseconds 500; ($i | Get-Volume).DriveLetter").Trim();
        if (letter.Length != 1 || !char.IsLetter(letter[0])) throw new InvalidOperationException("Windows couldn't open the disc image as a CD drive" + (letter.Length > 0 ? ": " + letter : ""));
        return letter + ":";
    }

    public static void Unmount(string iso)
    {
        try { Ps($"Dismount-DiskImage -ImagePath '{iso.Replace("'", "''")}' | Out-Null"); } catch { }
    }

    private static string Ps(string script)
    {
        var psi = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var a in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script }) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        var outp = p.StandardOutput.ReadToEndAsync(); var err = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(60_000)) { try { p.Kill(); } catch { } throw new TimeoutException("Windows took too long to open the disc image"); }
        var o = outp.Result.Trim();
        return o.Length > 0 ? o : err.Result.Trim();
    }

    // ---- install with the disc's own installer -----------------------------------------------------------------

    /// <summary>Put the disc in the virtual drive, note what's on the PC now, and say which installer to run.</summary>
    public object BeginSetup(string id)
    {
        var g = Find(id) ?? throw new InvalidOperationException("That game isn't imported");
        if (g.Iso is null || !File.Exists(g.Iso)) throw new InvalidOperationException("The disc image for this game is missing — import it again");
        var drive = Mount(g.Iso);
        var installer = FindInstaller(drive + "\\") ?? throw new InvalidOperationException($"Couldn't find an installer on the disc (drive {drive}). Open the drive in File Explorer to look.");
        lock (_snapshots) _snapshots[g.Id] = TakeSnapshot();
        _log.LogInformation("Setup for {Id}: disc in {Drive}, installer {Installer}", g.Id, drive, installer);
        return new { id = g.Id, title = g.Title, drive, installer, kind = ExeKind(installer) };
    }

    /// <summary>The installer is done: find what it added and remember how to start the game.</summary>
    public object FinishSetup(string id)
    {
        var g = Find(id) ?? throw new InvalidOperationException("That game isn't imported");
        Snapshot? before;
        lock (_snapshots) _snapshots.TryGetValue(g.Id, out before);
        if (before is null) throw new InvalidOperationException("Start the setup first (CoinQuest notes what's on the computer before the installer runs)");
        var after = TakeSnapshot();
        var newDirs = after.Dirs.Except(before.Dirs, StringComparer.OrdinalIgnoreCase).ToList();
        foreach (var key in after.Uninstall.Except(before.Uninstall, StringComparer.OrdinalIgnoreCase))
            if (UninstallLocation(key) is { } loc && Directory.Exists(loc)) newDirs.Add(loc);

        // The new Start-menu shortcut says what to start (and where, with what arguments).
        var links = after.Links.Except(before.Links, StringComparer.OrdinalIgnoreCase)
            .Select(l => (Link: l, Info: ReadShortcut(l)))
            .Where(x => x.Info is { } i && i.Target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(i.Target) && !IsHelper(i.Target))
            .Select(x => x.Info!)
            .ToList();
        var pick = links.OrderByDescending(i => newDirs.Any(d => i.Target.StartsWith(d, StringComparison.OrdinalIgnoreCase)))
                        .ThenByDescending(i => new FileInfo(i.Target).Length).FirstOrDefault();
        string exe; string? cwd = null, args = null;
        if (pick is not null) { exe = pick.Target; cwd = pick.WorkDir; args = pick.Args; }
        else
        {
            exe = newDirs.Where(Directory.Exists)
                .SelectMany(d => Directory.EnumerateFiles(d, "*.exe", new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 3, MatchCasing = MatchCasing.CaseInsensitive }))
                .Where(e => !IsHelper(e)).OrderByDescending(e => new FileInfo(e).Length).FirstOrDefault()
                ?? throw new InvalidOperationException("Couldn't tell where the installer put the game. Did it finish? If it did, tell the person who set up CoinQuest which folder it installed to.");
        }
        var installDir = newDirs.Where(d => exe.StartsWith(d.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)).OrderBy(d => d.Length).FirstOrDefault()
                         ?? Path.GetDirectoryName(exe)!;
        OpenUp(installDir); // the game saves players beside itself; the child's account must be able to write there
        var done = g with { Mode = "installed", ExePath = exe, InstallDir = installDir, Cwd = cwd, Args = args, Exe = Path.GetFileName(exe) };
        Save(done);
        lock (_snapshots) _snapshots.Remove(g.Id);
        _log.LogInformation("Installed {Id}: {Exe} in {Dir}", g.Id, exe, installDir);
        return new { id = g.Id, title = g.Title, exe, installDir };
    }

    private static readonly Regex Helper = new(@"unins|uninst|setup|instal|readme|help|regist|ereg|acro|aol|web|update|config|dxsetup|directx|quicktime|qtinst", RegexOptions.IgnoreCase);
    private static bool IsHelper(string exe) => Helper.IsMatch(Path.GetFileNameWithoutExtension(exe));

    /// <summary>The disc's installer: what AUTORUN.INF opens, else a 32-bit SETUP (the 16-bit ones don't run on 64-bit Windows).</summary>
    private static string? FindInstaller(string root)
    {
        var list = new List<string>();
        var autorun = Path.Combine(root, "AUTORUN.INF");
        if (File.Exists(autorun))
            foreach (var line in File.ReadAllLines(autorun))
            {
                var m = Regex.Match(line, @"^\s*open\s*=\s*(.+?)\s*$", RegexOptions.IgnoreCase);
                if (m.Success) list.Add(Path.Combine(root, m.Groups[1].Value.Split(' ')[0].Trim('"')));
            }
        foreach (var rel in new[] { "SETUP32.EXE", @"INSTALL\SETUP32.EXE", "SETUP.EXE", @"INSTALL\SETUP.EXE", @"INSTALL\_SETUP.EXE", "INSTALL.EXE" })
            list.Add(Path.Combine(root, rel));
        return list.Where(File.Exists).OrderByDescending(f => ExeKind(f) == "pe").FirstOrDefault();
    }

    /// <summary>"pe" (32/64-bit Windows), "ne" (16-bit Windows 3.x), "dos", or "" if not a program.</summary>
    public static string ExeKind(string path)
    {
        try
        {
            using var f = File.OpenRead(path);
            var h = new byte[64]; if (f.Read(h, 0, 64) < 64 || h[0] != 'M' || h[1] != 'Z') return "";
            var at = BitConverter.ToInt32(h, 0x3C);
            if (at <= 0 || at > f.Length - 4) return "dos";
            f.Position = at; var sig = new byte[4]; f.ReadExactly(sig);
            return sig[0] == 'P' && sig[1] == 'E' ? "pe" : sig[0] == 'N' && sig[1] == 'E' ? "ne" : "dos";
        }
        catch { return ""; }
    }

    private static Snapshot TakeSnapshot()
    {
        var links = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var dir in StartMenus())
            try { foreach (var l in Directory.EnumerateFiles(dir, "*.lnk", SearchOption.AllDirectories)) links.Add(l); } catch { }
        var un = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in UninstallRoots)
            try { using var k = Registry.LocalMachine.OpenSubKey(path); if (k is not null) foreach (var n in k.GetSubKeyNames()) un.Add(path + "\\" + n); } catch { }
        var dirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var top in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Path.GetPathRoot(Environment.SystemDirectory)! })
            try
            {
                foreach (var d in Directory.EnumerateDirectories(top))
                {
                    dirs.Add(d);
                    try { foreach (var d2 in Directory.EnumerateDirectories(d)) dirs.Add(d2); } catch { } // e.g. "The Learning Company\ClueFinders 3rd"
                }
            }
            catch { }
        return new Snapshot(links, un, dirs);
    }

    private static readonly string[] UninstallRoots =
    {
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    };

    private static string? UninstallLocation(string key)
    {
        try { using var k = Registry.LocalMachine.OpenSubKey(key); return (k?.GetValue("InstallLocation") as string)?.Trim().Trim('"').TrimEnd('\\') is { Length: > 0 } s ? s : null; }
        catch { return null; }
    }

    private static IEnumerable<string> StartMenus()
    {
        yield return Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu);
        yield return Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);
        var users = Path.GetDirectoryName(Environment.GetFolderPath(Environment.SpecialFolder.CommonDocuments)) ?? @"C:\Users";
        IEnumerable<string> homes;
        try { homes = Directory.EnumerateDirectories(users).ToList(); } catch { homes = Array.Empty<string>(); }
        foreach (var home in homes)
        {
            yield return Path.Combine(home, @"AppData\Roaming\Microsoft\Windows\Start Menu");
            yield return Path.Combine(home, "Desktop");
        }
    }

    public sealed record Shortcut(string Target, string? WorkDir, string? Args);

    /// <summary>Target, working folder and arguments of a .lnk file (Shell Link binary format, MS-SHLLINK).</summary>
    public static Shortcut? ReadShortcut(string lnk)
    {
        try
        {
            var b = File.ReadAllBytes(lnk);
            if (b.Length < 0x4C || BitConverter.ToUInt32(b, 0) != 0x4C) return null;
            var flags = BitConverter.ToUInt32(b, 0x14);
            int p = 0x4C;
            if ((flags & 0x01) != 0) p += 2 + BitConverter.ToUInt16(b, p);            // LinkTargetIDList
            string? target = null;
            if ((flags & 0x02) != 0)                                                  // LinkInfo
            {
                var infoSize = BitConverter.ToInt32(b, p);
                var localOff = BitConverter.ToInt32(b, p + 16);
                if (localOff > 0) target = ReadAnsi(b, p + localOff);
                p += infoSize;
            }
            bool unicode = (flags & 0x80) != 0;
            string? Next(uint bit)
            {
                if ((flags & bit) == 0) return null;
                int n = BitConverter.ToUInt16(b, p); p += 2;
                var s = unicode ? Encoding.Unicode.GetString(b, p, n * 2) : Encoding.Latin1.GetString(b, p, n);
                p += unicode ? n * 2 : n;
                return s;
            }
            Next(0x04); var rel = Next(0x08); var wd = Next(0x10); var args = Next(0x20);
            if (target is null && rel is not null) target = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(lnk)!, rel));
            return target is null ? null : new Shortcut(target, wd, args);
        }
        catch { return null; }
    }

    private static string ReadAnsi(byte[] b, int at) { int e = at; while (e < b.Length && b[e] != 0) e++; return Encoding.Latin1.GetString(b, at, e - at); }

    // ---- what the enforcer lets the child run ------------------------------------------------------------------

    private static (DateTime At, List<string> Dirs) _dirsCache = (DateTime.MinValue, new());

    /// <summary>Folders holding installed disc games (cached for a minute).</summary>
    public static List<string> InstalledDirs()
    {
        if (DateTime.UtcNow - _dirsCache.At < TimeSpan.FromMinutes(1)) return _dirsCache.Dirs;
        var list = Games().Where(g => g.Mode == "installed" && g.InstallDir is not null).Select(g => g.InstallDir!.TrimEnd('\\') + "\\").ToList();
        _dirsCache = (DateTime.UtcNow, list);
        return list;
    }
}
