using System.IO.Compression;

namespace CoinQuest.Guardian.Rwt;

/// <summary>
/// Turns the family's own Read, Write &amp; Type! disc image (a .iso, a .zip containing one, or a copied CD folder) into
/// a permanent part of CoinQuest under C:\ProgramData\CoinQuest\rwt — no disc or image needed afterwards.
///   rwt\cd\        the CD's Windows files + the files its installer would have unpacked (SPD.PRS, TCEXTRA.PRS…)
///   rwt\SIGNIN\    the game's player/progress files (writable by the child)
///   rwt\RWTWINCD.INI
/// The game program is adjusted (a few small patches, original kept as RWTWINCD.ORG) so it runs on today's PCs.
/// Nothing from the game is ever uploaded anywhere.
/// </summary>
public static class RwtInstaller
{
    public sealed record Result(int Files, long Bytes, List<string> Patches, List<string> Notes);

    /// <summary>Bytes each patch expects at its spot in RWTWINCD.EXE (1995 Windows CD, 582 656 bytes), and what replaces them.</summary>
    public static readonly (string Name, int Offset, string Old, string New)[] Patches =
    {
        // "Your display must be set to 256 colors": today's screens have millions; let it run.
        ("display is 256 colours", 0x1d043, "75 07 81 7e f8 00 01 74 60", "90 90 81 7e f8 00 01 eb 60"),
        // "No Palette Support. Please change video drivers.": report a palette device.
        ("palette support", 0x60e5e, "25 00 01", "b8 00 01"),
        // The game clock only ran after Windows activated the (still hidden) window; let it run from the start.
        ("game clock runs from the start", 0x5de4c, "8b 46 06 f7 d8 1b c0 40", "b8 01 00 90 90 90 90 90"),
        // Palette set-up assumes a 256-colour screen's 20 reserved colours (GetDeviceCaps NUMCOLORS). On today's screens
        // that call returns a huge number and the loop runs off the end of its 256-entry table (otvdm: "Interrupt 0D #GP
        // … mov eax,es:[bx+4h]"). Use the 256-colour value: 10 reserved at each end.
        ("palette reserved colours 1", 0x634de, "99 2b c2 d1 f8", "b8 0a 00 90 90"),
        ("palette reserved colours 2", 0x638bf, "99 2b c2 d1 f8", "b8 0a 00 90 90"),
        ("palette reserved colours 3", 0x63c01, "8b 46 fe 99 2b c2 d1 f8", "b8 0a 00 90 90 90 90 90"),
        ("palette reserved colours 4", 0x64709, "8b c7 99 2b c2 d1 f8", "b8 0a 00 90 90 90 90"),
    };

    public static Result Install(string source, string root, Action<string>? progress = null)
    {
        var cd = Path.Combine(root, "cd");
        var tmp = root + ".importing";
        if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
        var tcd = Path.Combine(tmp, "cd");
        Directory.CreateDirectory(tcd);
        int files = 0; long bytes = 0;
        var notes = new List<string>();

        void FromIso(Stream s)
        {
            using var iso = new Iso9660(s);
            var all = iso.Files();
            // The Windows part of the hybrid disc: the folder holding RWTWINCD.EXE (usually the root).
            var exe = all.FirstOrDefault(e => !e.IsDir && Path.GetFileName(e.Path).Equals("RWTWINCD.EXE", StringComparison.OrdinalIgnoreCase))
                      ?? throw new InvalidDataException("This disc image doesn't contain Read, Write & Type! for Windows (RWTWINCD.EXE not found).");
            var baseDir = Path.GetDirectoryName(exe.Path) ?? "";
            foreach (var e in all.Where(e => !e.IsDir))
            {
                var dir = Path.GetDirectoryName(e.Path) ?? "";
                if (!dir.Equals(baseDir, StringComparison.OrdinalIgnoreCase) && !dir.StartsWith(baseDir.Length > 0 ? baseDir + "\\" : "", StringComparison.OrdinalIgnoreCase)) continue;
                var rel = baseDir.Length > 0 ? e.Path[(baseDir.Length + 1)..] : e.Path;
                var dest = Path.Combine(tcd, rel.Replace('\\', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                iso.CopyTo(e, dest);
                files++; bytes += e.Size;
                if (files % 10 == 0) progress?.Invoke($"Copying the game… {bytes / 1048576} MB");
            }
        }

        if (Directory.Exists(source))
        {
            var exe = Directory.EnumerateFiles(source, "RWTWINCD.EXE", SearchOption.AllDirectories).FirstOrDefault()
                      ?? throw new InvalidDataException("That folder doesn't contain Read, Write & Type! (RWTWINCD.EXE not found).");
            var baseDir = Path.GetDirectoryName(exe)!;
            foreach (var f in Directory.EnumerateFiles(baseDir, "*", SearchOption.AllDirectories))
            {
                var dest = Path.Combine(tcd, Path.GetRelativePath(baseDir, f));
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                File.Copy(f, dest, true); files++; bytes += new FileInfo(f).Length;
            }
        }
        else if (source.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            using var zip = ZipFile.OpenRead(source);
            var isoEntry = zip.Entries.FirstOrDefault(e => e.FullName.EndsWith(".iso", StringComparison.OrdinalIgnoreCase));
            if (isoEntry is null) throw new InvalidDataException("That .zip doesn't contain a disc image (.iso).");
            // Zip streams can't seek; unpack the image next to the destination first.
            var isoTmp = Path.Combine(tmp, "disc.iso");
            progress?.Invoke("Unpacking the disc image…");
            isoEntry.ExtractToFile(isoTmp, true);
            using (var s = File.OpenRead(isoTmp)) FromIso(s);
            File.Delete(isoTmp);
        }
        else
        {
            using var s = File.OpenRead(source);
            FromIso(s);
        }

        // What the 1995 installer would have unpacked from the disc (game files, not Windows system files).
        var tlc = Directory.EnumerateFiles(tcd).FirstOrDefault(f => Path.GetFileName(f).Equals("TLC.1", StringComparison.OrdinalIgnoreCase) || Path.GetFileName(f).Equals("TLC.Z", StringComparison.OrdinalIgnoreCase));
        if (tlc is not null)
        {
            var a = File.ReadAllBytes(tlc);
            foreach (var e in InstallShield3.List(a))
            {
                var name = Path.GetFileName(e.Path);
                if (name.EndsWith(".EXE", StringComparison.OrdinalIgnoreCase) && !name.Equals("RWTWINCD.EXE", StringComparison.OrdinalIgnoreCase)) continue; // profwing: setup's display test
                File.WriteAllBytes(Path.Combine(tcd, name), InstallShield3.Extract(a, e));
                notes.Add("unpacked " + name);
            }
        }
        else notes.Add("TLC.1 not found — the speed drill and typing challenge extras may be missing");

        var patches = PatchExe(Path.Combine(tcd, "RWTWINCD.EXE"));

        // Swap in the finished copy; keep any existing player files.
        var signin = Path.Combine(root, "SIGNIN");
        Directory.CreateDirectory(root);
        if (Directory.Exists(cd)) Directory.Delete(cd, true);
        Directory.Move(tcd, cd);
        try { Directory.Delete(tmp, true); } catch { }
        Directory.CreateDirectory(signin);
        File.WriteAllText(Path.Combine(root, "RWTWINCD.INI"),
            "[Read, Write and Type! CD]\r\nWin31UseWinG=TRUE\r\nCheckDisplay=FALSE\r\nCheckSound=TRUE\r\n[Startup]\r\nShowResDlg=FALSE\r\n");
        return new Result(files, bytes, patches, notes);
    }

    public static List<string> PatchExe(string exe)
    {
        var applied = new List<string>();
        var orig = Path.ChangeExtension(exe, ".ORG");
        if (!File.Exists(orig)) File.Copy(exe, orig);
        var d = File.ReadAllBytes(orig);
        foreach (var (name, off, oldHex, newHex) in Patches)
        {
            var oldB = Convert.FromHexString(oldHex.Replace(" ", "")); var newB = Convert.FromHexString(newHex.Replace(" ", ""));
            if (off + oldB.Length <= d.Length && d.AsSpan(off, oldB.Length).SequenceEqual(oldB)) { newB.CopyTo(d, off); applied.Add(name); }
            else if (off + newB.Length <= d.Length && d.AsSpan(off, newB.Length).SequenceEqual(newB)) applied.Add(name + " (already)");
            else applied.Add(name + ": NOT APPLIED (different version of the game)");
        }
        File.WriteAllBytes(exe, d);
        return applied;
    }
}
