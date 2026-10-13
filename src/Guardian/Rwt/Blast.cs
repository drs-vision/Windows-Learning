namespace CoinQuest.Guardian.Rwt;

/// <summary>
/// PKWARE Data Compression Library "implode" decoder (what InstallShield 3 uses).
/// A C# port of Mark Adler's blast.c (zlib licence, contrib/blast in zlib).
/// </summary>
public static class Blast
{
    private const int MaxBits = 13;

    private sealed class Huffman { public short[] Count = new short[MaxBits + 1]; public short[] Symbol; public Huffman(int n) { Symbol = new short[n]; } }

    private static readonly Huffman LitCode = Build(new byte[] {
        11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
        9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
        7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
        8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
        44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45,
        44, 173 }, 256);
    private static readonly Huffman LenCode = Build(new byte[] { 2, 35, 36, 53, 38, 23 }, 16);
    private static readonly Huffman DistCode = Build(new byte[] { 2, 20, 53, 230, 247, 151, 248 }, 64);
    private static readonly short[] Base = { 3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264 };
    private static readonly byte[] Extra = { 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8 };

    private static Huffman Build(byte[] rep, int maxSymbols)
    {
        var h = new Huffman(maxSymbols);
        var length = new short[256];
        int symbol = 0;
        foreach (var r in rep)
        {
            int left = (r >> 4) + 1, len = r & 15;
            while (left-- > 0) length[symbol++] = (short)len;
        }
        int n = symbol;
        for (int i = 0; i < n; i++) h.Count[length[i]]++;
        var offs = new short[MaxBits + 1];
        for (int len = 1; len < MaxBits; len++) offs[len + 1] = (short)(offs[len] + h.Count[len]);
        for (int s = 0; s < n; s++) if (length[s] != 0) h.Symbol[offs[length[s]]++] = (short)s;
        return h;
    }

    private sealed class State
    {
        public byte[] In = null!; public int Pos; public int BitBuf; public int BitCnt;
        public int Bits(int need)
        {
            int val = BitBuf;
            while (BitCnt < need)
            {
                if (Pos >= In.Length) throw new InvalidDataException("compressed data ended early");
                val |= In[Pos++] << BitCnt;
                BitCnt += 8;
            }
            BitBuf = val >> need;
            BitCnt -= need;
            return val & ((1 << need) - 1);
        }
        public int Decode(Huffman h)
        {
            int bitbuf = BitBuf, left = BitCnt, code = 0, first = 0, index = 0, len = 1, next = 1;
            while (true)
            {
                while (left-- > 0)
                {
                    code |= (bitbuf & 1) ^ 1;
                    bitbuf >>= 1;
                    int count = h.Count[next++];
                    if (code < first + count) { BitBuf = bitbuf; BitCnt = (BitCnt - len) & 7; return h.Symbol[index + (code - first)]; }
                    index += count; first += count; first <<= 1; code <<= 1; len++;
                }
                left = (MaxBits + 1) - len;
                if (left == 0) break;
                if (Pos >= In.Length) throw new InvalidDataException("compressed data ended early");
                bitbuf = In[Pos++];
                if (left > 8) left = 8;
            }
            throw new InvalidDataException("bad compressed code");
        }
    }

    public static byte[] Decompress(byte[] input, int expectedSize = 0)
    {
        var s = new State { In = input };
        var output = new List<byte>(expectedSize > 0 ? expectedSize : input.Length * 3);
        int lit = s.Bits(8);
        if (lit > 1) throw new InvalidDataException("not imploded data");
        int dict = s.Bits(8);
        if (dict < 4 || dict > 6) throw new InvalidDataException("bad dictionary size");
        while (true)
        {
            if (s.Bits(1) != 0)
            {
                int symbol = s.Decode(LenCode);
                int len = Base[symbol] + s.Bits(Extra[symbol]);
                if (len == 519) break;
                symbol = len == 2 ? 2 : dict;
                int dist = (s.Decode(DistCode) << symbol) + s.Bits(symbol) + 1;
                if (dist > output.Count) throw new InvalidDataException("distance too far back");
                int from = output.Count - dist;
                for (int i = 0; i < len; i++) output.Add(output[from + i]);
            }
            else output.Add((byte)(lit != 0 ? s.Decode(LitCode) : s.Bits(8)));
        }
        return output.ToArray();
    }
}
