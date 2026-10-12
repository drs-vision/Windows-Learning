using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinQuest.Shared.Config;

namespace CoinQuest.Guardian.Economy;

/// <summary>
/// Classic Flash games without Flashpoint's launcher: the game's files come from the Flashpoint Archive (its public
/// catalog API and data packs), are unpacked into C:\ProgramData\CoinQuest\classics\&lt;id&gt;\, and play inside
/// CoinQuest's own Ruffle player — the same player as the bundled games, in the child's own window.
/// A local Flashpoint install, if present, is used as a cache (its downloaded data packs are reused).
/// </summary>
public sealed class ClassicLibrary
{
    private readonly ILogger<ClassicLibrary> _log;
    private readonly FlashpointService _fp;
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _one = new(2, 2);

    public const string Api = "https://db-api.unstable.life";
    public const string LegacyHtdocs = "https://infinity.flashpointarchive.org/Flashpoint/Legacy/htdocs/";
    public static string Dir => Path.Combine(Paths.DataRoot, "classics");

    public ClassicLibrary(FlashpointService fp, ILogger<ClassicLibrary> log)
    {
        _fp = fp; _log = log;
        _http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = true, AutomaticDecompression = DecompressionMethods.All }) { Timeout = TimeSpan.FromMinutes(4) };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("CoinQuest", "1.0"));
        Directory.CreateDirectory(Dir);
    }

    public sealed record Ready(string Url, string Base, string Prefix, string Platform);

    /// <summary>Search the online catalog. Adult ("Extreme") titles are filtered out by the API and again here.</summary>
    public async Task<List<FlashpointService.FpGame>> Search(string query, int limit = 20)
    {
        var url = $"{Api}/search?smartSearch={Uri.EscapeDataString(query)}&filter=true&limit={limit}&fields=id,title,developer,publisher,platform,tags,launchCommand,library,releaseDate,extreme";
        var json = JsonNode.Parse(await _http.GetStringAsync(url)) as JsonArray ?? new JsonArray();
        var list = new List<FlashpointService.FpGame>();
        foreach (var n in json)
        {
            if (n is null) continue;
            string S(string k) => n[k] switch { JsonValue v => v.ToString(), JsonArray a => string.Join("; ", a.Select(x => x?.ToString())), _ => "" };
            var tags = S("tags");
            if (S("extreme").Equals("true", StringComparison.OrdinalIgnoreCase) || tags.Contains("Extreme", StringComparison.OrdinalIgnoreCase)) continue;
            if (S("library") is { Length: > 0 } lib && lib != "arcade") continue;
            list.Add(new FlashpointService.FpGame(S("id"), S("title"), S("developer"), S("publisher"), S("platform"), tags, "", S("releaseDate"), ""));
        }
        return list;
    }

    private async Task<(string Launch, string Platform)> Lookup(string id)
    {
        var json = JsonNode.Parse(await _http.GetStringAsync($"{Api}/search?id={id}&fields=id,title,platform,launchCommand")) as JsonArray;
        var g = json?.FirstOrDefault() ?? throw new InvalidOperationException("That game isn't in the Flashpoint catalog.");
        return (g["launchCommand"]?.ToString() ?? "", g["platform"]?.ToString() ?? "");
    }

    /// <summary>Make sure the game's files are on disk and say where the player should load it from.</summary>
    public async Task<Ready> Prepare(string id)
    {
        if (!Guid.TryParse(id, out _)) throw new ArgumentException("bad game id");
        var dir = Path.Combine(Dir, id);
        var metaPath = Path.Combine(dir, "meta.json");
        await _one.WaitAsync();
        try
        {
            if (!File.Exists(metaPath))
            {
                var (launch, platform) = await Lookup(id);
                if (!platform.Equals("Flash", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"This one is a {platform} game — CoinQuest can only play Flash classics.");
                if (!Uri.TryCreate(launch, UriKind.Absolute, out var lu)) throw new InvalidOperationException("This game has no file to start.");
                var tmp = dir + ".partial";
                if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
                Directory.CreateDirectory(tmp);

                var packed = await FromLocalFlashpoint(id, tmp) || await FromDataPack(id, tmp);
                try { await EnsureEntry(); } catch { MarkUnavailable(id); throw new InvalidOperationException("This game's files aren't available from the archive right now."); }
                async Task EnsureEntry()
                {
                var entry = Path.Combine(tmp, "content", lu.Host, Uri.UnescapeDataString(lu.AbsolutePath).TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(entry))
                {
                    // Older ("legacy") games have no data pack: fetch the main file from Flashpoint's web server.
                    Directory.CreateDirectory(Path.GetDirectoryName(entry)!);
                    var bytes = await _http.GetByteArrayAsync(LegacyHtdocs + lu.Host + lu.AbsolutePath);
                    await File.WriteAllBytesAsync(entry, bytes);
                }
                }
                await File.WriteAllTextAsync(Path.Combine(tmp, "meta.json"), JsonSerializer.Serialize(new { launch, platform, packed }));
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
                Directory.Move(tmp, dir);
                _log.LogInformation("Classic {Id} ready ({Kind})", id, packed ? "data pack" : "legacy file");
            }
            var meta = JsonNode.Parse(await File.ReadAllTextAsync(metaPath))!;
            var u = new Uri(meta["launch"]!.ToString());
            var prefix = $"https://coinquest-classics.local/{id}/content/";
            var url = prefix + u.Host + u.AbsolutePath;
            return new Ready(url, url[..(url.LastIndexOf('/') + 1)], prefix, meta["platform"]?.ToString() ?? "Flash");
        }
        finally { _one.Release(); }
    }

    public bool IsReady(string id) => File.Exists(Path.Combine(Dir, id, "meta.json"));

    // Games whose files couldn't be fetched are kept out of the arcade (retried after a week).
    private static readonly string FailedFile = Path.Combine(Dir, "unavailable.json");
    private static Dictionary<string, DateTime>? _failed;
    private static Dictionary<string, DateTime> FailedMap()
    {
        if (_failed is not null) return _failed;
        try { _failed = JsonSerializer.Deserialize<Dictionary<string, DateTime>>(File.ReadAllText(FailedFile)) ?? new(); } catch { _failed = new(); }
        return _failed;
    }
    public static bool IsUnavailable(string id) { lock (FailedFile) return FailedMap().TryGetValue(id, out var at) && DateTime.UtcNow - at < TimeSpan.FromDays(7); }
    private static void MarkUnavailable(string id)
    {
        lock (FailedFile)
        {
            FailedMap()[id] = DateTime.UtcNow;
            try { File.WriteAllText(FailedFile, JsonSerializer.Serialize(_failed)); } catch { }
        }
    }

    private async Task<bool> FromDataPack(string id, string into)
    {
        using var resp = await _http.GetAsync($"{Api}/get?id={id}", HttpCompletionOption.ResponseHeadersRead);
        if (!resp.IsSuccessStatusCode) return false;
        var zipPath = Path.Combine(into, "pack.zip");
        await using (var fs = File.Create(zipPath)) await resp.Content.CopyToAsync(fs);
        try { Unpack(zipPath, into); return true; }
        catch (InvalidDataException) { return false; } // not a zip: the game has no data pack
        finally { try { File.Delete(zipPath); } catch { } }
    }

    private Task<bool> FromLocalFlashpoint(string id, string into)
    {
        try
        {
            var root = _fp.Root();
            var games = root is null ? null : Path.Combine(root, "Data", "Games");
            var zip = games is not null && Directory.Exists(games) ? Directory.EnumerateFiles(games, id + "-*.zip").FirstOrDefault() : null;
            if (zip is null) return Task.FromResult(false);
            Unpack(zip, into);
            return Task.FromResult(true);
        }
        catch { return Task.FromResult(false); }
    }

    /// <summary>Unpack only the game's content folder, never anything outside the target (zip-slip safe).</summary>
    private static void Unpack(string zipPath, string into)
    {
        using var z = ZipFile.OpenRead(zipPath);
        var rootFull = Path.GetFullPath(into) + Path.DirectorySeparatorChar;
        foreach (var e in z.Entries)
        {
            if (!e.FullName.StartsWith("content/", StringComparison.OrdinalIgnoreCase) || e.FullName.EndsWith('/')) continue;
            var dest = Path.GetFullPath(Path.Combine(into, e.FullName.Replace('/', Path.DirectorySeparatorChar)));
            if (!dest.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            e.ExtractToFile(dest, overwrite: true);
        }
    }
}
