using System.Text;

namespace CoinQuest.Guardian.Rwt;

/// <summary>Reads InstallShield 3 archives (*.Z, *.1) — after unshieldv3 by Wolfgang Frisch (Apache-2.0).</summary>
public static class InstallShield3
{
    public sealed record Entry(string Path, int Offset, int CompressedSize, int Size, bool Uncompressed);

    public static List<Entry> List(byte[] a)
    {
        if (BitConverter.ToUInt32(a, 0) != 0x8C655D13) throw new InvalidDataException("not an InstallShield 3 archive");
        int toc = BitConverter.ToInt32(a, 41);
        int dirCount = BitConverter.ToUInt16(a, 49);
        int p = toc;
        var dirs = new List<(string Name, int Files)>();
        for (int i = 0; i < dirCount; i++)
        {
            int files = BitConverter.ToUInt16(a, p); int chunk = BitConverter.ToUInt16(a, p + 2);
            int nlen = BitConverter.ToUInt16(a, p + 4);
            dirs.Add((Encoding.Latin1.GetString(a, p + 6, nlen), files));
            p += chunk;
        }
        var list = new List<Entry>();
        foreach (var (dirName, files) in dirs)
            for (int i = 0; i < files; i++)
            {
                int start = p;
                int size = BitConverter.ToInt32(a, p + 3), csize = BitConverter.ToInt32(a, p + 7), offset = BitConverter.ToInt32(a, p + 11);
                int chunk = BitConverter.ToUInt16(a, p + 23);
                byte attrib = a[p + 25];
                int nlen = a[p + 29];
                var name = Encoding.Latin1.GetString(a, p + 30, nlen);
                p = start + chunk;
                var path = dirName.Length > 0 ? dirName + "\\" + name : name;
                if (path.Contains("..") || path.StartsWith('\\') || path.Contains(':')) throw new InvalidDataException("bad file name in archive");
                list.Add(new Entry(path, offset, csize, size, (attrib & 0x10) != 0));
            }
        return list;
    }

    public static byte[] Extract(byte[] a, Entry e)
    {
        var buf = a.AsSpan(e.Offset, e.CompressedSize).ToArray();
        return e.Uncompressed ? buf : Blast.Decompress(buf, e.Size);
    }
}
