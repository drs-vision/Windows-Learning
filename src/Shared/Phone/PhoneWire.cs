using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace CoinQuest.Shared.Phone;

/// <summary>
/// How a parent's phone and the PC talk through the relay. The relay (an ntfy server) only ever sees scrambled text
/// on two random topic names; the key lives in the QR code the parent scanned and on the PC.
///
/// A message is: JSON → deflate → AES-256-GCM (12-byte nonce, 16-byte tag) → base64url, as nonce‖ciphertext‖tag.
/// Long messages are split into parts "cq1:{msgId}:{part}/{total}:{data}" (the relay caps a message at 4 KB).
/// The phone app (src/phone/app.js) implements the same format with WebCrypto.
/// </summary>
public static class PhoneWire
{
    public const int PartSize = 3600;

    public static byte[] NewKey() => RandomNumberGenerator.GetBytes(32);

    /// <summary>A random topic name nobody can guess (the relay is public; the name is half the secret).</summary>
    public static string NewTopic() => "cq" + B64Url(RandomNumberGenerator.GetBytes(18));

    public static string Seal(byte[] key, JsonNode payload)
    {
        byte[] plain;
        using (var ms = new MemoryStream())
        {
            using (var z = new DeflateStream(ms, CompressionLevel.SmallestSize, leaveOpen: true))
                z.Write(Encoding.UTF8.GetBytes(payload.ToJsonString()));
            plain = ms.ToArray();
        }
        var nonce = RandomNumberGenerator.GetBytes(12);
        var cipher = new byte[plain.Length];
        var tag = new byte[16];
        using (var aes = new AesGcm(key, 16)) aes.Encrypt(nonce, plain, cipher, tag);
        return B64Url(nonce.Concat(cipher).Concat(tag).ToArray());
    }

    /// <summary>Unscramble a message; null if it wasn't sealed with this key (or was tampered with).</summary>
    public static JsonNode? Open(byte[] key, string sealedText)
    {
        try
        {
            var all = FromB64Url(sealedText);
            if (all.Length < 12 + 16) return null;
            var nonce = all[..12]; var tag = all[^16..]; var cipher = all[12..^16];
            var plain = new byte[cipher.Length];
            using (var aes = new AesGcm(key, 16)) aes.Decrypt(nonce, cipher, tag, plain);
            using var z = new DeflateStream(new MemoryStream(plain), CompressionMode.Decompress);
            using var r = new StreamReader(z, Encoding.UTF8);
            return JsonNode.Parse(r.ReadToEnd());
        }
        catch { return null; }
    }

    public static List<string> Split(string sealedText)
    {
        var id = B64Url(RandomNumberGenerator.GetBytes(6));
        var n = Math.Max(1, (sealedText.Length + PartSize - 1) / PartSize);
        var parts = new List<string>(n);
        for (int i = 0; i < n; i++)
            parts.Add($"cq1:{id}:{i + 1}/{n}:{sealedText.Substring(i * PartSize, Math.Min(PartSize, sealedText.Length - i * PartSize))}");
        return parts;
    }

    /// <summary>Collects message parts per sender; returns the whole sealed text once every part has arrived.</summary>
    public sealed class Assembler
    {
        private readonly Dictionary<string, (DateTime At, string?[] Parts)> _pending = new();

        public string? Add(string message)
        {
            var bits = message.Split(':', 4);
            if (bits.Length != 4 || bits[0] != "cq1") return null;
            var nm = bits[2].Split('/');
            if (nm.Length != 2 || !int.TryParse(nm[0], out var i) || !int.TryParse(nm[1], out var n) || n < 1 || n > 64 || i < 1 || i > n) return null;
            if (n == 1) return bits[3];
            lock (_pending)
            {
                foreach (var k in _pending.Where(p => DateTime.UtcNow - p.Value.At > TimeSpan.FromMinutes(10)).Select(p => p.Key).ToList()) _pending.Remove(k);
                if (!_pending.TryGetValue(bits[1], out var e) || e.Parts.Length != n) e = (DateTime.UtcNow, new string?[n]);
                e.Parts[i - 1] = bits[3];
                _pending[bits[1]] = e;
                if (e.Parts.Any(p => p is null)) return null;
                _pending.Remove(bits[1]);
                return string.Concat(e.Parts);
            }
        }
    }

    public static string B64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] FromB64Url(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s + new string('=', (4 - s.Length % 4) % 4));
    }
}
