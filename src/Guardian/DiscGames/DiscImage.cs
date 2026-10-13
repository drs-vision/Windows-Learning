using System.IO.Compression;
using System.Text;
using CoinQuest.Guardian.Rwt;

namespace CoinQuest.Guardian.DiscGames;

/// <summary>
/// Opens a CD image the way it usually arrives: a plain .iso, a raw CloneCD/BIN image (.img/.bin with 2352-byte
/// sectors, as in "cfma_cd1.img" + .cue), or a .zip holding either. The result reads as ordinary 2048-byte sectors.
/// </summary>
public static class DiscImage
{
    private static readonly string[] ImageExts = { ".iso", ".img", ".bin" };

    /// <summary>Unpack every file of the disc into <paramref name="dest"/>; returns the number of files and bytes.</summary>
    /// <param name="isoOut">Also save the disc as a plain .iso there (Windows can open that as a virtual CD drive).</param>
    public static (int Files, long Bytes) ExtractAll(string source, string dest, string tmpDir, Action<string>? progress = null, string? isoOut = null)
    {
        Directory.CreateDirectory(dest);
        if (Directory.Exists(source)) return CopyFolder(source, dest);

        string? temp = null;
        try
        {
            var image = source;
            if (source.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            {
                using var zip = ZipFile.OpenRead(source);
                var entry = zip.Entries.Where(e => ImageExts.Contains(Path.GetExtension(e.Name).ToLowerInvariant())).OrderByDescending(e => e.Length).FirstOrDefault()
                    ?? throw new InvalidDataException("That .zip has no disc image (.iso, .img or .bin) inside.");
                progress?.Invoke($"Unzipping {entry.Name}…");
                Directory.CreateDirectory(tmpDir);
                temp = Path.Combine(tmpDir, "disc" + Path.GetExtension(entry.Name));
                entry.ExtractToFile(temp, true);
                image = temp;
            }
            if (isoOut is not null)
            {
                progress?.Invoke("Saving the disc image…");
                Directory.CreateDirectory(Path.GetDirectoryName(isoOut)!);
                using (var sectors = OpenSectors(image))
                using (var o = File.Create(isoOut))
                    sectors.CopyTo(o, 1 << 20);
                Neutralize(isoOut, progress);
            }
            progress?.Invoke("Copying the disc…");
            using var iso = new Iso9660(OpenSectors(image));
            int files = 0; long bytes = 0;
            foreach (var e in iso.Files())
            {
                var path = Path.Combine(dest, e.Path.Replace('\\', Path.DirectorySeparatorChar));
                if (e.IsDir) { Directory.CreateDirectory(path); continue; }
                if (IsUnwanted(e.Path)) continue; // see Neutralize
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                iso.CopyTo(e, path);
                files++; bytes += e.Size;
                if (files % 50 == 0) progress?.Invoke($"Copying the disc… {files} files, {bytes / 1048576} MB");
            }
            return (files, bytes);
        }
        finally { if (temp is not null) try { File.Delete(temp); } catch { } }
    }

    /// <summary>
    /// "Broadcast DSSAgent" (INSTALL\BRODCAST\DSSAGENT.EXE on Learning Company / Mattel discs of 1999–2002) reports
    /// usage home; Windows Defender calls it spyware and then refuses to open the whole disc image as a drive.
    /// The games never need it.
    /// </summary>
    public static bool IsUnwanted(string discPath) =>
        Path.GetFileName(discPath).StartsWith("DSSAGENT", StringComparison.OrdinalIgnoreCase)
        || discPath.Contains("BRODCAST\\", StringComparison.OrdinalIgnoreCase);

    /// <summary>Blank out unwanted files inside a saved .iso (same size, all zeros), so the image stays clean.</summary>
    public static int Neutralize(string iso, Action<string>? progress = null)
    {
        List<Iso9660.Entry> bad;
        using (var r = new Iso9660(new FileStream(iso, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)))
            bad = r.Files().Where(e => !e.IsDir && IsUnwanted(e.Path)).ToList();
        if (bad.Count == 0) return 0;
        progress?.Invoke("Removing the old usage-reporting program from the disc image…");
        using var f = new FileStream(iso, FileMode.Open, FileAccess.Write, FileShare.Read);
        var zeros = new byte[1 << 16];
        foreach (var e in bad)
        {
            f.Position = e.Lba * 2048;
            for (long left = e.Size; left > 0; left -= zeros.Length) f.Write(zeros, 0, (int)Math.Min(zeros.Length, left));
        }
        return bad.Count;
    }

    /// <summary>A stream of 2048-byte data sectors, whatever the image's sector layout.</summary>
    public static Stream OpenSectors(string image)
    {
        var f = new FileStream(image, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16);
        foreach (var (size, offset) in new[] { (2048, 0), (2352, 16), (2352, 24), (2336, 8) })
        {
            long at = 16L * size + offset + 1;
            if (f.Length < at + 5) continue;
            f.Position = at;
            var b = new byte[5]; f.ReadExactly(b);
            if (Encoding.ASCII.GetString(b) == "CD001")
            {
                f.Position = 0;
                return size == 2048 ? f : new SectorStream(f, size, offset);
            }
        }
        f.Dispose();
        throw new InvalidDataException("That doesn't look like a CD image CoinQuest can read.");
    }

    private static (int, long) CopyFolder(string from, string to)
    {
        int n = 0; long bytes = 0;
        foreach (var file in Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories))
        {
            var dest = Path.Combine(to, Path.GetRelativePath(from, file));
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.Copy(file, dest, true);
            n++; bytes += new FileInfo(file).Length;
        }
        return (n, bytes);
    }

    /// <summary>Presents the 2048 data bytes of each raw sector (2352 bytes: sync + header [+ subheader] + data + ECC).</summary>
    private sealed class SectorStream : Stream
    {
        private readonly Stream _raw; private readonly int _size, _offset; private long _pos;
        public SectorStream(Stream raw, int size, int offset) { _raw = raw; _size = size; _offset = offset; }
        public override bool CanRead => true; public override bool CanSeek => true; public override bool CanWrite => false;
        public override long Length => _raw.Length / _size * 2048;
        public override long Position { get => _pos; set => _pos = value; }
        public override int Read(byte[] buffer, int offset, int count)
        {
            int total = 0;
            while (count > 0 && _pos < Length)
            {
                long sector = _pos / 2048; int within = (int)(_pos % 2048);
                int n = Math.Min(count, 2048 - within);
                _raw.Position = sector * _size + _offset + within;
                int got = _raw.Read(buffer, offset, n);
                if (got <= 0) break;
                _pos += got; offset += got; count -= got; total += got;
            }
            return total;
        }
        public override long Seek(long offset, SeekOrigin origin) => _pos = origin switch { SeekOrigin.Begin => offset, SeekOrigin.Current => _pos + offset, _ => Length + offset };
        public override void Flush() { }
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) _raw.Dispose(); base.Dispose(disposing); }
    }
}
