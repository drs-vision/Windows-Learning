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
    private sealed record Snapshot(HashSet<string> Links, HashSet<string> Uninstall, HashSet<string> Dirs, DateTime TakenUtc);
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

    /// <summary>Coins for each bit of progress in this game (null: the Classic CD games setting).</summary>
    public object SetCoins(string id, int? coins)
    {
        var g = Find(id) ?? throw new InvalidOperationException("That game isn't imported");
        Save(g with { Coins = coins is null ? null : Math.Clamp(coins.Value, -1000, 1000) });
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

    /// <summary>
    /// Learning Company / Mattel installers of 1999–2002 slip in "Broadcast DSSAgent", a background program that reports
    /// usage home (Windows Defender flags it as Spyware:Win32/BrodcastDSSAGENT). The games don't need it: remove its
    /// start-up entries and files after every install (and at start, in case an earlier install left it).
    /// </summary>
    public static void RemoveDssAgent(ILogger<DiscGameService> log)
    {
        static bool IsDss(object? v) => v is string s && (s.Contains("dssagent", StringComparison.OrdinalIgnoreCase) || s.Contains(@"\Brodcast\", StringComparison.OrdinalIgnoreCase));
        void CleanRun(RegistryKey? root, string path)
        {
            try
            {
                using var k = root?.OpenSubKey(path, writable: true);
                if (k is null) return;
                foreach (var n in k.GetValueNames())
                    if (n.Contains("DSSAgent", StringComparison.OrdinalIgnoreCase) || IsDss(k.GetValue(n))) { k.DeleteValue(n, false); log.LogInformation("Removed start-up entry {Name} (Broadcast DSSAgent)", n); }
            }
            catch { }
        }
        foreach (var path in new[] { @"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run" })
        {
            CleanRun(Registry.LocalMachine, path);
            try { foreach (var sid in Registry.Users.GetSubKeyNames()) { using var u = Registry.Users.OpenSubKey(sid); CleanRun(Registry.Users, sid + "\\" + path); } } catch { }
        }
        foreach (var p in Process.GetProcessesByName("DSSAgent")) { try { p.Kill(); } catch { } finally { p.Dispose(); } }
        foreach (var common in new[] { Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles) })
        {
            var dir = Path.Combine(common, "Mattel", "Brodcast");
            if (Directory.Exists(dir)) try { DeleteDir(dir); log.LogInformation("Removed {Dir} (Broadcast DSSAgent)", dir); } catch { }
        }
    }

    // ---- virtual CD drive ---------------------------------------------------------------------------------------

    /// <summary>Open the disc image as a CD drive (if it isn't already); returns e.g. "E:".</summary>
    public static string Mount(string iso)
    {
        try { DiscImage.Neutralize(iso); } catch { } // discs imported before this check may still carry DSSAgent
        TurnOffAutoPlay();
        var letter = Ps($"$i = Get-DiskImage -ImagePath '{iso.Replace("'", "''")}'; if (-not $i.Attached) {{ $i = Mount-DiskImage -ImagePath '{iso.Replace("'", "''")}' -PassThru }}; " +
                        "Start-Sleep -Milliseconds 500; ($i | Get-Volume).DriveLetter").Trim();
        if (letter.Length != 1 || !char.IsLetter(letter[0])) throw new InvalidOperationException("Windows couldn't open the disc image as a CD drive" + (letter.Length > 0 ? ": " + letter : ""));
        return letter + ":";
    }

    /// <summary>
    /// A mounted disc would otherwise open File Explorer or start the disc's own menu (which offers to install again) —
    /// on the child's screen, outside CoinQuest. Off for every drive, for every account; the uninstaller turns it back on.
    /// </summary>
    /// <summary>
    /// Installed games remember the CD's drive letter from when they were installed ("CDDrive=F:\data\" in their INI,
    /// a path in the registry). The virtual drive can come back as another letter, and the game then says "insert the
    /// CD" — so point those at the drive the disc is in now.
    /// </summary>
    public void PointAtDrive(Game g, string drive)
    {
        var letter = char.ToUpperInvariant(drive[0]);
        bool IsOldCd(char c) => char.ToUpperInvariant(c) != letter && (!Directory.Exists(c + ":\\") || new DriveInfo(c + ":").DriveType == DriveType.CDRom);
        int changed = 0;

        // INI files: the game's own folder, its Application Data folder, and Windows (older titles write there).
        var inis = new List<string>(); var shared = new List<string>();
        if (g.InstallDir is { } dir && Directory.Exists(dir))
            inis.AddRange(Directory.EnumerateFiles(dir, "*.ini", new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 3, MatchCasing = MatchCasing.CaseInsensitive }));
        foreach (var d in SaveDirs(g)) if (Directory.Exists(d)) try { inis.AddRange(Directory.EnumerateFiles(d, "*.ini")); } catch { }
        // A game run without administrator rights writes "C:\Windows\x.ini" to each account's VirtualStore instead.
        try
        {
            var users = Path.GetDirectoryName(Environment.GetFolderPath(Environment.SpecialFolder.CommonDocuments)) ?? @"C:\Users";
            foreach (var home in Directory.EnumerateDirectories(users))
            {
                var vs = Path.Combine(home, @"AppData\Local\VirtualStore");
                if (!Directory.Exists(vs)) continue;
                try { shared.AddRange(Directory.EnumerateFiles(Path.Combine(vs, "Windows"), "*.ini")); } catch { }
                if (g.InstallDir is { Length: > 3 } idir)
                    try { inis.AddRange(Directory.EnumerateFiles(Path.Combine(vs, idir[3..]), "*.ini", SearchOption.AllDirectories)); } catch { }
            }
        }
        catch { }
        // Windows' own folder is shared by everything: only touch INIs there that name a CD drive.
        var exeName = Path.GetFileNameWithoutExtension(g.ExePath ?? g.Exe);
        foreach (var ini in shared.Concat(SafeList(() => Directory.EnumerateFiles(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "*.ini"))))
            if (SafeRead(ini) is var t && t.Contains("CDDrive", StringComparison.OrdinalIgnoreCase)
                || Path.GetFileNameWithoutExtension(ini).Equals(exeName, StringComparison.OrdinalIgnoreCase))
                inis.Add(ini);
        var line = new Regex(@"^(\s*[^=;\r\n]*(?:cd|source|disc|disk)[^=\r\n]*=\s*""?)([A-Za-z])(:)", RegexOptions.IgnoreCase | RegexOptions.Multiline);
        foreach (var ini in inis.Distinct(StringComparer.OrdinalIgnoreCase))
            try
            {
                var text = File.ReadAllText(ini, Encoding.Latin1);
                var fixedText = line.Replace(text, m => IsOldCd(m.Groups[2].Value[0]) ? m.Groups[1].Value + letter + m.Groups[3].Value : m.Value);
                if (fixedText != text) { File.SetAttributes(ini, FileAttributes.Normal); File.WriteAllText(ini, fixedText, Encoding.Latin1); changed++; }
            }
            catch { }

        // Registry: the publishers' keys (32-bit programs write under WOW6432Node).
        foreach (var vendor in new[] { "The Learning Company", "TLC", "Learning Company", "Mattel", "Mattel Interactive", "DK Multimedia", "Dorling Kindersley", "Broderbund", "SoftKey", "Humongous Entertainment" })
            foreach (var root in new[] { @"SOFTWARE\WOW6432Node\", @"SOFTWARE\" })
                try { using var k = Registry.LocalMachine.OpenSubKey(root + vendor, true); if (k is not null) changed += FixKey(k, letter, IsOldCd); } catch { }
        if (changed > 0) _log.LogInformation("{Id}: pointed {N} CD settings at {Drive}", g.Id, changed, drive);
    }

    private static IEnumerable<string> SafeList(Func<IEnumerable<string>> f) { try { return f().ToList(); } catch { return Array.Empty<string>(); } }

    private static int FixKey(RegistryKey k, char letter, Func<char, bool> isOldCd, int depth = 0)
    {
        int n = 0;
        foreach (var name in k.GetValueNames())
            if (k.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) is string v && v.Length >= 3 && char.IsLetter(v[0]) && v[1] == ':' && v[2] == '\\'
                && Regex.IsMatch(name, "cd|source|disc|disk|drive", RegexOptions.IgnoreCase) && isOldCd(v[0]))
            {
                try { k.SetValue(name, letter + v[1..]); n++; } catch { }
            }
        if (depth < 4)
            foreach (var sub in k.GetSubKeyNames())
                try { using var s = k.OpenSubKey(sub, true); if (s is not null) n += FixKey(s, letter, isOldCd, depth + 1); } catch { }
        return n;
    }

    public static void TurnOffAutoPlay()
    {
        try
        {
            using var k = Registry.LocalMachine.CreateSubKey(AutoPlayKey);
            if (k.GetValue("NoDriveTypeAutoRun") is not int v || v != 0xFF) k.SetValue("NoDriveTypeAutoRun", 0xFF, RegistryValueKind.DWord);
            if (k.GetValue("NoAutorun") is not int a || a != 1) k.SetValue("NoAutorun", 1, RegistryValueKind.DWord);
        }
        catch { }
    }

    public static void RestoreAutoPlay()
    {
        try { using var k = Registry.LocalMachine.OpenSubKey(AutoPlayKey, true); k?.DeleteValue("NoDriveTypeAutoRun", false); k?.DeleteValue("NoAutorun", false); } catch { }
    }

    private const string AutoPlayKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer";

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
        _ = Task.Run(() => FinishWhenInstallerCloses(g.Id, drive));
        return new { id = g.Id, title = g.Title, drive, installer, kind = ExeKind(installer) };
    }

    /// <summary>
    /// Finish by itself once the installer has closed: nothing is running from the disc and no installer-looking
    /// program is running, for 15 seconds, and the PC has a new program to start. ("Done installing" still works.)
    /// </summary>
    private async Task FinishWhenInstallerCloses(string id, string drive)
    {
        var started = DateTime.UtcNow; int quiet = 0;
        var root = drive.TrimEnd('\\') + "\\";
        while (DateTime.UtcNow - started < TimeSpan.FromHours(3))
        {
            await Task.Delay(5000);
            lock (_snapshots) if (!_snapshots.ContainsKey(id)) return; // finished by hand, or cancelled
            if (DateTime.UtcNow - started < TimeSpan.FromSeconds(20)) continue; // give the installer time to start
            bool busy = false;
            foreach (var p in Process.GetProcesses())
                using (p)
                {
                    string name = "", file = "";
                    try { name = p.ProcessName; } catch { }
                    try { file = p.MainModule?.FileName ?? ""; } catch { }
                    if (InstallerProcess.IsMatch(name) || file.StartsWith(root, StringComparison.OrdinalIgnoreCase)) { busy = true; break; }
                }
            quiet = busy ? 0 : quiet + 1;
            if (quiet < 3) continue;
            try
            {
                FinishSetup(id);
                _log.LogInformation("Setup for {Id} finished by itself after the installer closed", id);
                return;
            }
            catch { quiet = 0; } // nothing installed yet (the disc's menu may not have been used) — keep waiting
        }
    }

    private static readonly Regex InstallerProcess = new(@"^(setup|install|_ins|_isdel|isetup|ikernel|_setup|setup32|inst32|instmsi|isscript|consent)", RegexOptions.IgnoreCase);

    /// <summary>The installer is done: find what it added and remember how to start the game.</summary>
    /// <param name="folder">Where the parent says it installed — for when CoinQuest can't tell on its own.</param>
    /// <param name="program">The game's program, chosen by the parent — used as is.</param>
    public object FinishSetup(string id, string? folder = null, string? program = null)
    {
        if (program is not null)
        {
            var pg = Find(id) ?? throw new InvalidOperationException("That game isn't imported");
            if (!File.Exists(program) || ExeKind(program) is not ("pe" or "ne")) throw new InvalidOperationException("That isn't a Windows program — choose the game's .exe");
            if (new DriveInfo(program).DriveType == DriveType.CDRom) throw new InvalidOperationException("That's on the disc — choose the program in the folder the game installed to");
            var dir = Path.GetDirectoryName(program)!;
            // The install folder is the game's top folder (e.g. "…\The Learning Company\The ClueFinders 6th Grade Adventures").
            var top = dir;
            foreach (var root in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) })
                if (root.Length > 0 && dir.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase))
                {
                    var parts = Path.GetRelativePath(root, dir).Split('\\');
                    top = Path.Combine(root, string.Join("\\", parts.Take(Math.Min(parts.Length, 2))));
                }
            OpenUp(top);
            var chosen = pg with { Mode = "installed", ExePath = program, InstallDir = top, Cwd = dir, Args = null, Exe = Path.GetFileName(program) };
            Save(chosen);
            lock (_snapshots) _snapshots.Remove(pg.Id);
            _dirsCache = (DateTime.MinValue, new());
            _log.LogInformation("Parent chose {Exe} for {Id}", program, pg.Id);
            return new { id = pg.Id, title = pg.Title, exe = program, installDir = top };
        }
        var g = Find(id) ?? throw new InvalidOperationException("That game isn't imported");
        Snapshot? before;
        lock (_snapshots) _snapshots.TryGetValue(g.Id, out before);
        if (before is null && folder is null) throw new InvalidOperationException("Start the setup first (CoinQuest notes what's on the computer before the installer runs)");
        var after = TakeSnapshot();
        before ??= after with { Links = new(StringComparer.OrdinalIgnoreCase), TakenUtc = DateTime.MaxValue };
        List<string> newDirs; var iconExes = new List<string>();
        if (folder is not null)
        {
            if (!Directory.Exists(folder)) throw new InvalidOperationException("That folder doesn't exist");
            newDirs = new() { folder.TrimEnd('\\') };
        }
        else
        {
            newDirs = after.Dirs.Except(before.Dirs, StringComparer.OrdinalIgnoreCase).ToList();
            foreach (var key in after.Uninstall.Except(before.Uninstall, StringComparer.OrdinalIgnoreCase))
            {
                if (UninstallLocation(key) is { } loc && Directory.Exists(loc)) newDirs.Add(loc);
                if (UninstallIcon(key) is { } ico) { iconExes.Add(ico); newDirs.Add(Path.GetDirectoryName(ico)!); }
            }
        }

        // The new Start-menu shortcut says what to start (and where, with what arguments). Installing over an earlier
        // try leaves the same shortcuts and folders, so ones the installer rewrote count as new too.
        var cutoff = before.TakenUtc.AddSeconds(-5);
        var changed = after.Links.Where(l => !before.Links.Contains(l) || Touched(l, cutoff)).ToList();
        if (folder is null && newDirs.Count == 0)
        {
            // Nothing new: the game may have gone into a folder that was there before — find it by the shortcut, or by name.
            foreach (var l in changed) if (ReadShortcut(l) is { } i && File.Exists(i.Target)) newDirs.Add(Path.GetDirectoryName(i.Target)!);
            var words = TitleWords(g.Title);
            if (words.Length > 0)
                newDirs.AddRange(after.Dirs.Where(d => words.All(w => Path.GetFileName(d).Contains(w, StringComparison.OrdinalIgnoreCase))));
        }
        var links = (folder is null ? changed : after.Links.ToList())
            .Select(l => (Link: l, Info: ReadShortcut(l)))
            .Where(x => x.Info is { } i && i.Target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(i.Target) && !IsHelper(i.Target))
            .Select(x => x.Info!)
            .Where(i => folder is null || i.Target.StartsWith(folder.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
            .ToList();
        var pick = links.OrderByDescending(i => newDirs.Any(d => i.Target.StartsWith(d, StringComparison.OrdinalIgnoreCase)))
                        .ThenByDescending(i => new FileInfo(i.Target).Length).FirstOrDefault();
        string exe; string? cwd = null, args = null;
        // Learning Company titles: the real program sits beside an INI that names the CD; their shortcuts can point at a
        // launcher that offers to (re)install instead of starting the game.
        var tlc = newDirs.Where(Directory.Exists)
            .SelectMany(d => Directory.EnumerateFiles(d, "*.ini", new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 3, MatchCasing = MatchCasing.CaseInsensitive }))
            .Where(i => SafeRead(i) is var t && (t.Contains("CDDrive", StringComparison.OrdinalIgnoreCase) || t.Contains(" - CD]", StringComparison.OrdinalIgnoreCase)))
            .Select(i => PickExe(Path.GetDirectoryName(i)!)).Where(e => e is not null && !IsHelper(e)).FirstOrDefault();
        // 1. A recipe: titles CoinQuest has already worked out. 2. A Learning Company program beside its INI.
        // 3. The program Windows shows as the game's icon in Apps (the uninstall entry). 4. The new shortcut. 5. The biggest program.
        var recipe = RecipeExe(g.Title, newDirs);
        var icon = iconExes.FirstOrDefault(e => File.Exists(e) && !IsHelper(e) && !Launcher.IsMatch(Path.GetFileNameWithoutExtension(e)) && ExeKind(e) is "pe" or "ne");
        if (recipe is not null) { exe = recipe; cwd = Path.GetDirectoryName(recipe); }
        else if (tlc is not null) { exe = tlc; cwd = Path.GetDirectoryName(tlc); }
        else if (icon is not null) { exe = icon; cwd = Path.GetDirectoryName(icon); }
        else if (pick is not null) { exe = pick.Target; cwd = pick.WorkDir; args = pick.Args; }
        else
        {
            exe = newDirs.Where(Directory.Exists)
                .SelectMany(d => Directory.EnumerateFiles(d, "*.exe", new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 3, MatchCasing = MatchCasing.CaseInsensitive }))
                .Where(e => !IsHelper(e)).OrderByDescending(e => new FileInfo(e).Length).FirstOrDefault()
                ?? throw new InvalidOperationException(folder is not null ? "No game program in that folder — choose the folder the game itself is in"
                    : "Couldn't tell where the installer put the game. If it finished, press \"Choose its folder…\" and pick the folder it installed to.");
        }
        // A disc launcher ("PLAY.EXE", AUTORUN, …) checks for the CD and offers to install; start the game itself if it's there.
        if (Launcher.IsMatch(Path.GetFileNameWithoutExtension(exe)) && args is { Length: > 0 })
            foreach (var tok in Regex.Matches(args, "\"([^\"]+\\.exe)\"|(\\S+\\.exe)", RegexOptions.IgnoreCase).Select(m => m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value))
            {
                var full = Path.IsPathRooted(tok) ? tok : Path.Combine(cwd is { Length: > 0 } && Directory.Exists(cwd) ? cwd : Path.GetDirectoryName(exe)!, tok);
                if (File.Exists(full) && !Launcher.IsMatch(Path.GetFileNameWithoutExtension(full))) { exe = full; cwd = Path.GetDirectoryName(full); args = null; break; }
            }
        if (Launcher.IsMatch(Path.GetFileNameWithoutExtension(exe)))
        {
            var dir = newDirs.Where(d => exe.StartsWith(d.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)).OrderBy(d => d.Length).FirstOrDefault()
                      ?? newDirs.FirstOrDefault(d => Directory.Exists(d) && new DriveInfo(d).DriveType != DriveType.CDRom);
            var real = dir is null ? null : Directory.EnumerateFiles(dir, "*.exe", new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 3, MatchCasing = MatchCasing.CaseInsensitive })
                .Where(e => !IsHelper(e) && !Launcher.IsMatch(Path.GetFileNameWithoutExtension(e)) && ExeKind(e) == "pe")
                .OrderByDescending(e => Path.GetFileNameWithoutExtension(e).EndsWith("32", StringComparison.OrdinalIgnoreCase))
                .ThenByDescending(e => new FileInfo(e).Length).FirstOrDefault();
            if (real is not null) { exe = real; cwd = Path.GetDirectoryName(real); args = null; }
        }
        var installDir = newDirs.Where(d => exe.StartsWith(d.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)).OrderBy(d => d.Length).FirstOrDefault()
                         ?? Path.GetDirectoryName(exe)!;
        OpenUp(installDir); // the game saves players beside itself; the child's account must be able to write there
        RemoveDssAgent(_log);
        var done = g with { Mode = "installed", ExePath = exe, InstallDir = installDir, Cwd = cwd, Args = args, Exe = Path.GetFileName(exe) };
        Save(done);
        lock (_snapshots) _snapshots.Remove(g.Id);
        _log.LogInformation("Installed {Id}: {Exe} in {Dir}", g.Id, exe, installDir);
        return new { id = g.Id, title = g.Title, exe, installDir };
    }

    private static bool Touched(string file, DateTime sinceUtc)
    {
        try { return File.GetLastWriteTimeUtc(file) >= sinceUtc || File.GetCreationTimeUtc(file) >= sinceUtc; } catch { return false; }
    }

    /// <summary>The distinctive words of a title ("The ClueFinders 6th Grade Adventures" → ClueFinders, 6th, Grade).</summary>
    private static string[] TitleWords(string title) =>
        Regex.Split(title, @"[^A-Za-z0-9]+").Where(w => w.Length >= 3 || w.Any(char.IsDigit))
            .Where(w => !new[] { "the", "and", "adventures", "adventure", "deluxe", "edition" }.Contains(w.ToLowerInvariant())).ToArray();

    private static readonly Regex Launcher = new(@"^(autorun|launch|launcher|menu|tlcrun|tlclaunch)\d*$", RegexOptions.IgnoreCase);
    private static readonly Regex Helper = new(@"unins|uninst|setup|instal|readme|help|regist|ereg|acro|aol|web|update|config|dxsetup|directx|quicktime|qtinst|assess|demo|tour|preview", RegexOptions.IgnoreCase);
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
        return new Snapshot(links, un, dirs, DateTime.UtcNow);
    }

    private static readonly string[] UninstallRoots =
    {
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    };

    /// <summary>The program Windows uses as the app's icon ("C:\\…\\GAME.EXE,0") — usually the game itself.</summary>
    private static string? UninstallIcon(string key)
    {
        try
        {
            using var k = Registry.LocalMachine.OpenSubKey(key);
            var v = (k?.GetValue("DisplayIcon") as string)?.Trim();
            if (string.IsNullOrEmpty(v)) return null;
            var m = Regex.Match(v, "^\"?([^\",]+\\.exe)", RegexOptions.IgnoreCase);
            return m.Success && File.Exists(m.Groups[1].Value) ? m.Groups[1].Value : null;
        }
        catch { return null; }
    }

    /// <summary>
    /// Titles CoinQuest has already worked out: which program in the installed folder is the game. Matched on the
    /// title, or on the folder the installer made (a regional edition may be named differently).
    /// </summary>
    private static readonly (Regex Match, string[] Exes)[] Recipes =
    {
        (new(@"ClueFinders.*6th\s*Grade", RegexOptions.IgnoreCase), new[] { "CF6.EXE" }),
        (new(@"ClueFinders.*(3rd\s*Grade|Years\s*3)", RegexOptions.IgnoreCase), new[] { "PLAY.EXE" }),
        (new(@"ClueFinders.*(Reading|Missing\s*Amulet)", RegexOptions.IgnoreCase), new[] { "PLAY.EXE" }),
    };

    private static string? RecipeExe(string title, IEnumerable<string> dirs)
    {
        var list = dirs.Where(Directory.Exists).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        foreach (var (match, exes) in Recipes)
        {
            var hit = match.IsMatch(title) ? list : list.Where(d => match.IsMatch(d)).ToList();
            foreach (var d in hit)
                foreach (var name in exes)
                    if (Directory.EnumerateFiles(d, name, new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 3, MatchCasing = MatchCasing.CaseInsensitive }).FirstOrDefault() is { } f)
                        return f;
        }
        return null;
    }

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
