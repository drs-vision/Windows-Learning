using System.Net.Http.Headers;
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
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
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

        var direct = Regex.Match(uri.AbsolutePath, @"/channel/(UC[\w-]{22})");
        if (direct.Success) return await WithTitle(new YouTubeChannel { Id = direct.Groups[1].Value, Url = s });

        var html = await _http.GetStringAsync(uri);
        var m = Regex.Match(html, @"""(?:externalId|channelId|browseId)""\s*:\s*""(UC[\w-]{22})""");
        if (!m.Success) m = Regex.Match(html, @"youtube\.com/channel/(UC[\w-]{22})");
        if (!m.Success) throw new ArgumentException("Couldn't find that channel. Paste the link from the channel's page (it starts with youtube.com/@).");
        return await WithTitle(new YouTubeChannel { Id = m.Groups[1].Value, Url = s });
    }

    private async Task<YouTubeChannel> WithTitle(YouTubeChannel c)
    {
        var feed = await Feed(c.Id, force: true);
        var title = feed.FirstOrDefault()?.ChannelTitle;
        return c with { Title = string.IsNullOrEmpty(title) ? c.Id : title };
    }

    /// <summary>Recent uploads for a channel (YouTube's feed returns the latest 15). Cached for 30 minutes.</summary>
    public async Task<List<Video>> Feed(string channelId, bool force = false)
    {
        lock (_cache)
            if (!force && _cache.TryGetValue(channelId, out var hit) && DateTimeOffset.UtcNow - hit.at < TimeSpan.FromMinutes(30)) return hit.videos;

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
        lock (_cache) _cache[channelId] = (DateTimeOffset.UtcNow, videos);
        return videos;
    }

    /// <summary>All approved channels' recent videos, newest first. Channels that fail are skipped, not fatal.</summary>
    public async Task<object> Library(Child child)
    {
        var all = new List<Video>();
        var errors = new List<string>();
        foreach (var c in child.YouTubeChannels)
        {
            try { all.AddRange(await Feed(c.Id)); }
            catch (Exception ex) { errors.Add(c.Title); _log.LogWarning(ex, "Feed failed for {Channel}", c.Title); }
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
        foreach (var c in child.YouTubeChannels)
        {
            try { if ((await Feed(c.Id)).Any(v => v.Id == videoId)) return true; } catch { }
        }
        return false;
    }

    [GeneratedRegex(@"^UC[\w-]{22}$")] private static partial Regex UcId();
}
