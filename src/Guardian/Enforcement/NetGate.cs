using System.Net;
using System.Net.Sockets;
using System.Text;
using CoinQuest.Guardian.Economy;
using CoinQuest.Shared.Models;

namespace CoinQuest.Guardian.Enforcement;

/// <summary>
/// The gatekeeper. A managed child's account has no direct internet (see Shared/Native/Wfp.cs); the only way out is
/// this HTTP/HTTPS proxy on 127.0.0.1, run by the Guardian as SYSTEM. It reads the site name of every request
/// (CONNECT host for HTTPS, Host for HTTP) and only forwards allowed ones. Nothing is decrypted.
/// </summary>
public sealed class NetGate
{
    public const int Port = 47123;

    private readonly SessionMonitor _session;
    private readonly UnlockManager _unlocks;
    private readonly CoinQuest.Shared.Config.HouseholdStore _store;
    private readonly ILogger<NetGate> _log;
    private readonly Dictionary<string, DateTime> _recentDenied = new(StringComparer.OrdinalIgnoreCase);

    public NetGate(SessionMonitor session, UnlockManager unlocks, CoinQuest.Shared.Config.HouseholdStore store, ILogger<NetGate> log) { _session = session; _unlocks = unlocks; _store = store; _log = log; }

    /// <summary>Static assets only — fonts, script CDNs and sign-in pages that allowed sites need. None are browsable destinations.</summary>
    public static readonly string[] Infrastructure =
    {
        "fonts.googleapis.com", "fonts.gstatic.com", "ajax.googleapis.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com",
        "accounts.google.com", "ssl.gstatic.com", "www.gstatic.com", "login.microsoftonline.com", "login.live.com", "appleid.apple.com",
        "i.ytimg.com", // video thumbnails in CoinQuest's YouTube list (pictures only)
        "flashpointarchive.org", "unstable.life", // Flashpoint game downloads, if its launcher uses the proxy
    };

    /// <summary>What CoinQuest's in-app YouTube player needs — opened only while YouTube time is running.</summary>
    public static readonly string[] YouTubeHosts =
    {
        "youtube-nocookie.com", "youtube.com", "ytimg.com", "googlevideo.com", "ggpht.com", "gstatic.com", "googleapis.com", "youtubei.googleapis.com",
    };

    public sealed record Decision(bool Allowed, string Reason);

    public Decision Check(string host)
    {
        host = host.Trim().TrimEnd('.').ToLowerInvariant();
        if (host is "localhost" or "127.0.0.1" or "::1" or "coinquest.local") return new(true, "local");
        // Only managed child accounts are forced through this gate (the WFP rule), so whoever is connecting is a child.
        // Prefer the one at the keyboard; otherwise allow what any managed child is allowed (one child = exactly theirs).
        var children = _session.Current is { } cur ? new List<Child> { cur.Child } : _store.Current.Children;
        if (children.Count == 0) return new(false, "no managed child is set up");
        bool Match(string domain) { domain = domain.Trim().ToLowerInvariant().TrimStart('.'); if (domain.StartsWith("www.")) domain = domain[4..]; return host == domain || host.EndsWith("." + domain); }

        if (Infrastructure.Any(Match)) return new(true, "infrastructure");
        if (children.Any(c => c.Allowlist.Sites.Any(Match))) return new(true, "allowed site");
        var active = children.SelectMany(c => _unlocks.ActiveFor(c.Id)).ToList();
        if (active.Any(u => u.Kind == PrizeKind.SiteUnlock && u.Targets.Any(Match))) return new(true, "site unlock");
        if (active.Any(u => u.Kind == PrizeKind.YouTube) && YouTubeHosts.Any(Match)) return new(true, "YouTube time");
        // Web-hosted arcade games: their site opens only while time on that game (or a sampler pass) is running.
        foreach (var c in children)
            foreach (var w in c.Arcade.WebGames)
                if (Uri.TryCreate(w.Url, UriKind.Absolute, out var wu) && Match(wu.Host)
                    && _unlocks.ActiveFor(c.Id).Any(u => u.Kind == PrizeKind.ArcadeUnlock && (u.Targets.Contains(w.Id) || u.Targets.Contains("*"))))
                    return new(true, "arcade time");
        return new(false, "not on the list");
    }

    public async Task RunAsync(CancellationToken ct)
    {
        var listener = new TcpListener(IPAddress.Loopback, Port);
        var listener6 = new TcpListener(IPAddress.IPv6Loopback, Port);
        listener.Start();
        try { listener6.Start(); } catch { listener6 = null!; }
        _log.LogInformation("Gatekeeper listening on 127.0.0.1:{Port}", Port);
        var accept4 = AcceptLoop(listener, ct);
        var accept6 = listener6 is null ? Task.CompletedTask : AcceptLoop(listener6, ct);
        try { await Task.WhenAll(accept4, accept6); }
        finally { listener.Stop(); listener6?.Stop(); }
    }

    private async Task AcceptLoop(TcpListener l, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient c;
            try { c = await l.AcceptTcpClientAsync(ct); } catch (OperationCanceledException) { break; } catch { continue; }
            _ = Task.Run(() => Handle(c, ct), ct);
        }
    }

    private async Task Handle(TcpClient client, CancellationToken ct)
    {
        using var _ = client;
        client.NoDelay = true;
        var cs = client.GetStream();
        try
        {
            var head = await ReadHead(cs, ct);
            if (head is null) return;
            var firstLineEnd = head.IndexOf("\r\n", StringComparison.Ordinal);
            var first = firstLineEnd < 0 ? head : head[..firstLineEnd];
            var parts = first.Split(' ');
            if (parts.Length < 3) return;
            var method = parts[0];

            string host; int port; byte[]? forward = null;
            if (method.Equals("CONNECT", StringComparison.OrdinalIgnoreCase))
            {
                (host, port) = SplitHostPort(parts[1], 443);
            }
            else
            {
                // Plain HTTP via proxy: "GET http://host/path HTTP/1.1" → rewrite to origin form.
                if (!Uri.TryCreate(parts[1], UriKind.Absolute, out var uri)) { await Deny(cs, "bad request", ct); return; }
                host = uri.Host; port = uri.Port;
                var rest = firstLineEnd < 0 ? "\r\n\r\n" : head[firstLineEnd..];
                rest = string.Join("\r\n", rest.Split("\r\n").Where(l => !l.StartsWith("Proxy-", StringComparison.OrdinalIgnoreCase)));
                forward = Encoding.ASCII.GetBytes($"{method} {uri.PathAndQuery} {parts[2]}{rest}");
            }

            var d = Check(host);
            if (!d.Allowed)
            {
                lock (_recentDenied)
                    if (!_recentDenied.TryGetValue(host, out var t) || (DateTime.UtcNow - t).TotalMinutes > 10)
                    {
                        _recentDenied[host] = DateTime.UtcNow;
                        _log.LogInformation("Gatekeeper blocked {Host} ({Reason})", host, d.Reason);
                        if (_recentDenied.Count > 2000) _recentDenied.Clear();
                    }
                await Deny(cs, $"{host} is not allowed", ct);
                return;
            }

            using var upstream = new TcpClient { NoDelay = true };
            await upstream.ConnectAsync(host, port, ct);
            var us = upstream.GetStream();
            if (forward is null) await cs.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 Connection Established\r\n\r\n"), ct);
            else await us.WriteAsync(forward, ct);

            using var pipeCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var a = cs.CopyToAsync(us, pipeCts.Token);
            var b = us.CopyToAsync(cs, pipeCts.Token);
            await Task.WhenAny(a, b);
            pipeCts.Cancel();
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
        catch (SocketException) { try { await Deny(cs, "could not reach the site", ct); } catch { } }
        catch (Exception ex) { _log.LogDebug(ex, "Gatekeeper connection error"); }
    }

    private static async Task<string?> ReadHead(NetworkStream s, CancellationToken ct)
    {
        var buf = new byte[16384];
        var len = 0;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        while (len < buf.Length)
        {
            var n = await s.ReadAsync(buf.AsMemory(len), timeout.Token);
            if (n == 0) return null;
            len += n;
            var text = Encoding.ASCII.GetString(buf, 0, len);
            var end = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
            if (end >= 0) return text; // includes any body bytes already read (small POST bodies)
        }
        return null;
    }

    private static (string, int) SplitHostPort(string s, int dflt)
    {
        if (s.StartsWith('[')) { var close = s.IndexOf(']'); var h = s[1..close]; return (h, s.Length > close + 2 && int.TryParse(s[(close + 2)..], out var p6) ? p6 : dflt); }
        var i = s.LastIndexOf(':');
        return i > 0 && int.TryParse(s[(i + 1)..], out var p) ? (s[..i], p) : (s, dflt);
    }

    private static async Task Deny(NetworkStream s, string why, CancellationToken ct)
    {
        var body = $"<html><body style=\"font-family:Segoe UI,sans-serif;background:#0b1026;color:#fff;text-align:center;padding:60px\"><h1>🚫 Not allowed</h1><p>{WebUtility.HtmlEncode(why)}.</p><p>Ask a parent to add it in CoinQuest.</p></body></html>";
        var bytes = Encoding.UTF8.GetBytes(body);
        var resp = $"HTTP/1.1 403 Forbidden\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n";
        await s.WriteAsync(Encoding.ASCII.GetBytes(resp), ct);
        await s.WriteAsync(bytes, ct);
    }
}
