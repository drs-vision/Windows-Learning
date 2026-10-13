using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using CoinQuest.Shared.Models;

namespace CoinQuest.Guardian.Economy;

/// <summary>
/// Channel allowlist for the in-app YouTube player. No API key: channels are resolved from their public
/// page, and recent uploads come from YouTube's public RSS feed. Runs in the service (the child's
/// WebView can't fetch these cross-origin, and shouldn't decide what's allowed anyway).
/// </summary>
public sealed partial class YouTubeService
{
    private readonly HttpClient _http;
    private readonly ILogger<YouTubeService> _log;
    private readonly Dictionary<string, (DateTimeOffset at, List<Video> videos)> _cache = new();

    public sealed record Video(string Id, string Title, string ChannelId, string ChannelTitle, DateTimeOffset Published, string Thumbnail);

    public YouTubeService(ILogger<YouTubeService> log)
    {
        _log = log;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(25) };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Mozilla", "5.0"));
        _http.DefaultRequestHeaders.AcceptLanguage.ParseAdd("en-US,en;q=0.8");
    }

    /// <summary>Accepts a channel URL (@handle, /channel/UC…, /c/name, /user/name), a bare @handle, or a UC… id.</summary>
    public async Task<YouTubeChannel> Resolve(string input)
    {
        var s = input.Trim();
        if (UcId().IsMatch(s) && !s.Contains('/')) return await WithTitle(new YouTubeChannel { Id = s, Url = $"https://www.youtube.com/channel/{s}" });
        if (s.StartsWith('@')) s = "https://www.youtube.com/" + s;
        if (!s.StartsWith("http")) s = "https://" + s;
        var uri = new Uri(s);
        if (!uri.Host.EndsWith("youtube.com") && uri.Host != "youtu.be") throw new ArgumentException("That isn't a YouTube channel link.");

        string html;
        try { html = await _http.GetStringAsync(uri); }
        catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        { throw new ArgumentException("YouTube says that channel doesn't exist. Open the channel in a browser and copy the address bar."); }
        var direct = Regex.Match(uri.AbsolutePath, @"/channel/(UC[\w-]{22})");
        var m = direct.Success ? direct : Regex.Match(html, @"""(?:externalId|channelId|browseId)""\s*:\s*""(UC[\w-]{22})""");
        if (!m.Success) m = Regex.Match(html, @"youtube\.com/channel/(UC[\w-]{22})");
        if (!m.Success) throw new ArgumentException("Couldn't find that channel. Paste the link from the channel's page (it starts with youtube.com/@).");
        var title = Regex.Match(html, @"<meta property=""og:title"" content=""([^""]+)""").Groups[1].Value;
        if (string.IsNullOrEmpty(title)) title = Regex.Match(html, @"<title>([^<]+?)(?: - YouTube)?</title>").Groups[1].Value;
        return new YouTubeChannel { Id = m.Groups[1].Value, Url = s, Title = System.Net.WebUtility.HtmlDecode(string.IsNullOrWhiteSpace(title) ? m.Groups[1].Value : title) };
    }

    private async Task<YouTubeChannel> WithTitle(YouTubeChannel c)
    {
        try
        {
            var html = await _http.GetStringAsync($"https://www.youtube.com/channel/{c.Id}");
            var title = Regex.Match(html, @"<meta property=""og:title"" content=""([^""]+)""").Groups[1].Value;
            return c with { Title = string.IsNullOrEmpty(title) ? c.Id : System.Net.WebUtility.HtmlDecode(title) };
        }
        catch { return c with { Title = c.Id }; }
    }

    /// <summary>Recent uploads for a channel (YouTube's feed returns the latest 15). Cached for 30 minutes.</summary>
    public async Task<List<Video>> Feed(string channelId, bool force = false)
    {
        lock (_cache)
            if (!force && _cache.TryGetValue(channelId, out var hit) && DateTimeOffset.UtcNow - hit.at < TimeSpan.FromMinutes(30)) return hit.videos;

        List<Video> videos;
        try { videos = await FromRss(channelId); }
        catch (Exception ex)
        {
            _log.LogInformation("RSS for {Channel} failed ({Msg}); asking YouTube's own app API instead", channelId, ex.Message);
            try { videos = (await Browse(channelId, null)).Videos; if (videos.Count == 0) throw new InvalidOperationException("no videos"); }
            catch (Exception exB)
            {
            _log.LogInformation("Browse for {Channel} failed ({Msg}); reading the channel page instead", channelId, exB.Message);
            try { videos = await FromChannelPage(channelId); }
            catch (Exception ex2)
            {
                _log.LogWarning(ex2, "Channel page for {Channel} failed too; using the last saved list", channelId);
                videos = LoadSaved(channelId);
                if (videos.Count == 0) throw;
            }
            }
        }
        if (videos.Count > 0) Save(channelId, videos);
        Remember(videos);
        lock (_cache) _cache[channelId] = (DateTimeOffset.UtcNow, videos);
        return videos;
    }

    // ---- every video of a channel, page by page (YouTube's own web-app API, the same call its Videos tab makes) ----

    /// <summary>Video ids we've listed from an approved channel → that channel. Only these can be played.</summary>
    private readonly ConcurrentDictionary<string, string> _known = new();
    private void Remember(IEnumerable<Video> videos) { foreach (var v in videos) _known[v.Id] = v.ChannelId; }

    private string? CachedTitle(string channelId) { lock (_cache) return _cache.TryGetValue(channelId, out var c) ? c.videos.FirstOrDefault()?.ChannelTitle : null; }

    public sealed record Page(List<Video> Videos, string? Next);
    private const string VideosTab = "EgZ2aWRlb3PyBgQKAjoA";

    /// <summary>One page of a channel's uploads (about 30), newest first. Pass the previous page's <c>Next</c> for more.</summary>
    public async Task<Page> Browse(string channelId, string? continuation)
    {
        var client = new JsonObject { ["clientName"] = "WEB", ["clientVersion"] = "2.20250312.04.00", ["hl"] = "en", ["gl"] = "US" };
        var body = new JsonObject { ["context"] = new JsonObject { ["client"] = client } };
        if (continuation is null) { body["browseId"] = channelId; body["params"] = VideosTab; }
        else body["continuation"] = continuation;
        using var req = new HttpRequestMessage(HttpMethod.Post, "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false")
        { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };
        req.Headers.Add("X-YouTube-Client-Name", "1");
        req.Headers.Add("X-YouTube-Client-Version", "2.20250312.04.00");
        req.Headers.Add("Origin", "https://www.youtube.com");
        using var resp = await _http.SendAsync(req);
        resp.EnsureSuccessStatusCode();
        var root = JsonNode.Parse(await resp.Content.ReadAsStringAsync());
        var title = root?["metadata"]?["channelMetadataRenderer"]?["title"]?.GetValue<string>()
                    ?? CachedTitle(channelId) ?? "";
        var list = new List<Video>(); var seen = new HashSet<string>(); string? next = null;
        void Add(string? id, string? t)
        {
            if (id is null || id.Length != 11 || !seen.Add(id)) return;
            list.Add(new Video(id, t ?? "Video", channelId, title, DateTimeOffset.UtcNow.AddMinutes(-list.Count), $"https://i.ytimg.com/vi/{id}/mqdefault.jpg"));
        }
        void Walk(JsonNode? n, bool inGrid)
        {
            switch (n)
            {
                case JsonObject o:
                    if (o["reelItemRenderer"] is not null || o["shortsLockupViewModel"] is not null) return; // Shorts aren't what a parent approved
                    if (o["videoRenderer"] is JsonObject vr)
                    {
                        var runs = vr["title"]?["runs"] as JsonArray;
                        Add(vr["videoId"]?.GetValue<string>(), runs?.FirstOrDefault()?["text"]?.GetValue<string>() ?? vr["title"]?["simpleText"]?.GetValue<string>());
                        return;
                    }
                    if (o["lockupViewModel"] is JsonObject lv && (lv["contentType"]?.GetValue<string>() ?? "").Contains("VIDEO"))
                    {
                        Add(lv["contentId"]?.GetValue<string>(), lv["metadata"]?["lockupMetadataViewModel"]?["title"]?["content"]?.GetValue<string>());
                        return;
                    }
                    // The "load more" token lives in the grid's continuationItemRenderer (sort chips carry tokens too — ignore those).
                    if (o["continuationItemRenderer"] is JsonObject ci)
                    {
                        var tok = ci["continuationEndpoint"]?["continuationCommand"]?["token"] ?? Find(ci, "token");
                        if (tok is JsonValue tv && inGrid) next = tv.GetValue<string>();
                        return;
                    }
                    foreach (var kv in o)
                    {
                        if (kv.Key is "header" or "engagementPanels" or "topbar" or "frameworkUpdates" or "microformat" or "metadata") continue;
                        Walk(kv.Value, inGrid || kv.Key is "richGridRenderer" or "appendContinuationItemsAction" or "reloadContinuationItemsCommand" or "gridRenderer");
                    }
                    break;
                case JsonArray a: foreach (var x in a) Walk(x, inGrid); break;
            }
        }
        Walk(root, false);
        Remember(list);
        _log.LogInformation("YouTube browse {Channel} ({Kind}): {Count} videos, {More}", channelId, continuation is null ? "first page" : "more", list.Count, next is null ? "no more pages" : "more pages available");
        if (list.Count == 0) next = null;
        return new Page(list, next);
    }

    private static JsonNode? Find(JsonNode? n, string key) => n switch
    {
        JsonObject o => o[key] ?? o.Select(kv => Find(kv.Value, key)).FirstOrDefault(x => x is not null),
        JsonArray a => a.Select(x => Find(x, key)).FirstOrDefault(x => x is not null),
        _ => null,
    };

    /// <summary>For the child app: a page of one approved channel, or the first page if Browse isn't working.</summary>
    public async Task<object> ChannelPage(Child child, string channelId, string? continuation)
    {
        if (!child.YouTubeChannels.Any(c => c.Id == channelId)) throw new InvalidOperationException("that channel isn't approved");
        try
        {
            var p = await Browse(channelId, continuation);
            var title = child.YouTubeChannels.First(c => c.Id == channelId).Title;
            return new { videos = p.Videos.Select(v => v with { ChannelTitle = title }), next = p.Next };
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Browse failed for {Channel}", channelId);
            if (continuation is not null) throw new InvalidOperationException("couldn't load more videos right now");
            return new { videos = await Feed(channelId), next = (string?)null };
        }
    }

    private async Task<List<Video>> FromRss(string channelId)
    {
        var xml = await _http.GetStringAsync($"https://www.youtube.com/feeds/videos.xml?channel_id={channelId}");
        XNamespace atom = "http://www.w3.org/2005/Atom", yt = "http://www.youtube.com/xml/schemas/2015", media = "http://search.yahoo.com/mrss/";
        var doc = XDocument.Parse(xml);
        var channelTitle = doc.Root?.Element(atom + "title")?.Value ?? "";
        var videos = doc.Root?.Elements(atom + "entry").Select(e =>
        {
            var id = e.Element(yt + "videoId")?.Value ?? "";
            return new Video(id, e.Element(atom + "title")?.Value ?? "", channelId, channelTitle,
                DateTimeOffset.TryParse(e.Element(atom + "published")?.Value, out var p) ? p : DateTimeOffset.MinValue,
                $"https://i.ytimg.com/vi/{id}/mqdefault.jpg");
        })
        // Shorts are vertical, endless and not what a parent approved a channel for; the feed marks them by URL.
        .Where(v => v.Id.Length == 11)
        .ToList() ?? new();
        return videos;
    }

    /// <summary>YouTube's RSS endpoint has frequent 404 outages (2026). The Videos tab carries the same list in its page data.</summary>
    private async Task<List<Video>> FromChannelPage(string channelId)
    {
        var html = await _http.GetStringAsync($"https://www.youtube.com/channel/{channelId}/videos");
        var channelTitle = System.Net.WebUtility.HtmlDecode(Regex.Match(html, @"<meta property=""og:title"" content=""([^""]+)""").Groups[1].Value);
        var list = new List<Video>();
        var seen = new HashSet<string>();
        foreach (Match m in Regex.Matches(html, @"""videoId"":""([\w-]{11})""(.{0,1500}?)""(?:title|headline)"":\{""(?:runs"":\[\{""text|simpleText|content)"":""((?:[^""\\]|\\.)+)"""))
        {
            var id = m.Groups[1].Value;
            if (!seen.Add(id)) continue;
            var title = Regex.Unescape(m.Groups[3].Value);
            list.Add(new Video(id, title, channelId, channelTitle, DateTimeOffset.UtcNow.AddMinutes(-list.Count), $"https://i.ytimg.com/vi/{id}/mqdefault.jpg"));
            if (list.Count >= 30) break;
        }
        if (list.Count == 0)
            foreach (Match m in Regex.Matches(html, @"""videoId"":""([\w-]{11})"""))
                if (seen.Add(m.Groups[1].Value) && list.Count < 30)
                    list.Add(new Video(m.Groups[1].Value, "Video", channelId, channelTitle, DateTimeOffset.UtcNow.AddMinutes(-list.Count), $"https://i.ytimg.com/vi/{m.Groups[1].Value}/mqdefault.jpg"));
        if (list.Count == 0) throw new InvalidOperationException("no videos found on the channel page");
        return list;
    }

    private static string SavedPath(string channelId) => Path.Combine(CoinQuest.Shared.Config.Paths.DataRoot, "youtube", channelId + ".json");
    private static void Save(string channelId, List<Video> v)
    {
        try { CoinQuest.Shared.Config.SafeFile.WriteAllText(SavedPath(channelId), System.Text.Json.JsonSerializer.Serialize(v)); } catch { }
    }
    private static List<Video> LoadSaved(string channelId)
    {
        try { return System.Text.Json.JsonSerializer.Deserialize<List<Video>>(File.ReadAllText(SavedPath(channelId))) ?? new(); } catch { return new(); }
    }

    /// <summary>All approved channels' recent videos, newest first. Channels that fail are skipped, not fatal.</summary>
    public async Task<object> Library(Child child)
    {
        var all = new List<Video>();
        var errors = new List<string>();
        foreach (var c in child.YouTubeChannels)
        {
            try { all.AddRange(await Feed(c.Id)); }
            catch (Exception ex) { errors.Add($"{c.Title} ({ex.Message})"); _log.LogWarning(ex, "Feed failed for {Channel}", c.Title); }
        }
        return new
        {
            channels = child.YouTubeChannels.Select(c => new { c.Id, c.Title }),
            videos = all.OrderByDescending(v => v.Published),
            errors,
        };
    }

    /// <summary>Is this video from an approved channel? (Checked before the player is allowed to load it.)</summary>
    public async Task<bool> IsAllowed(Child child, string videoId)
    {
        if (_known.TryGetValue(videoId, out var ch) && child.YouTubeChannels.Any(c => c.Id == ch)) return true;
        foreach (var c in child.YouTubeChannels)
        {
            try { if ((await Feed(c.Id)).Any(v => v.Id == videoId)) return true; } catch { }
        }
        return false;
    }

    [GeneratedRegex(@"^UC[\w-]{22}$")] private static partial Regex UcId();
}
