using System.Text;

namespace CoinQuest.Guardian.Rwt;

/// <summary>Minimal ISO 9660 reader: enough to copy the Windows files off a CD image (no mounting, no drivers).</summary>
public sealed class Iso9660 : IDisposable
{
    private readonly Stream _s;
    public sealed record Entry(string Path, long Lba, long Size, bool IsDir);

    public Iso9660(Stream s) { _s = s; }
    public void Dispose() => _s.Dispose();

    private byte[] Read(long lba, int len)
    {
        var b = new byte[len];
        _s.Position = lba * 2048;
        int got = 0;
        while (got < len) { int n = _s.Read(b, got, len - got); if (n <= 0) break; got += n; }
        return b;
    }

    public List<Entry> Files()
    {
        // Primary volume descriptor at sector 16 (descriptors run until type 255).
        byte[]? pvd = null;
        for (long sec = 16; sec < 64; sec++)
        {
            var d = Read(sec, 2048);
            if (Encoding.ASCII.GetString(d, 1, 5) != "CD001") throw new InvalidDataException("not an ISO 9660 CD image");
            if (d[0] == 1) { pvd = d; break; }
            if (d[0] == 255) break;
        }
        if (pvd is null) throw new InvalidDataException("CD image has no primary volume descriptor");
        var root = pvd.AsSpan(156, 34);
        var list = new List<Entry>();
        Walk(BitConverter.ToUInt32(root[2..6]), BitConverter.ToUInt32(root[10..14]), "", list, 0);
        return list;
    }

    private void Walk(long lba, long size, string prefix, List<Entry> list, int depth)
    {
        if (depth > 8) return;
        var data = Read(lba, (int)Math.Min(size, 1 << 20));
        int p = 0;
        while (p < data.Length)
        {
            int len = data[p];
            if (len == 0) { p = (p / 2048 + 1) * 2048; continue; } // records don't cross sectors
            long elba = BitConverter.ToUInt32(data, p + 2), esize = BitConverter.ToUInt32(data, p + 10);
            bool dir = (data[p + 25] & 2) != 0;
            int nlen = data[p + 32];
            var name = Encoding.ASCII.GetString(data, p + 33, nlen);
            p += len;
            if (nlen == 1 && (name[0] == '\0' || name[0] == '\u0001')) continue; // . and ..
            int semi = name.IndexOf(';'); if (semi >= 0) name = name[..semi];
            name = name.TrimEnd('.');
            if (name.Length == 0 || name.Contains("..") || name.IndexOfAny(new[] { '/', '\\', ':' }) >= 0) continue;
            var path = prefix.Length > 0 ? prefix + "\\" + name : name;
            list.Add(new Entry(path, elba, esize, dir));
            if (dir) Walk(elba, esize, path, list, depth + 1);
        }
    }

    public void CopyTo(Entry e, string dest)
    {
        using var o = File.Create(dest);
        _s.Position = e.Lba * 2048;
        var buf = new byte[1 << 20];
        long left = e.Size;
        while (left > 0)
        {
            int n = _s.Read(buf, 0, (int)Math.Min(buf.Length, left));
            if (n <= 0) throw new EndOfStreamException("CD image ended early");
            o.Write(buf, 0, n); left -= n;
        }
    }
}
