using System.Net.WebSockets;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Phone;

namespace CoinQuest.Guardian.Phone;

/// <summary>
/// "Control from my phone": a parent scans a QR code on the PC (after entering the parent PIN) and from then on can
/// see and change coins, quests, the shop and allowed sites from their phone, anywhere — no account, no password.
///
/// Each linked phone has its own random key and two random topic names (phone → PC, PC → phone). The PC listens on
/// every linked phone's topic, unscrambles each request with that phone's key, runs it, and posts the scrambled answer
/// back on the relay the request came by. Removing a phone deletes its key: it can't talk to the PC again.
///
/// Relays: CoinQuest's own (Cloudflare, see relay/) when it's set up — listed in relay.json beside the phone app — and
/// the public ntfy.sh as a fallback. The PC listens on both, so a phone can use whichever it reaches. On CoinQuest's
/// relay the PC also leaves a scrambled snapshot (coins, requests) that phones show while the PC is off, and requests
/// wait there up to 7 days (12 hours on ntfy.sh) for the PC to come back.
/// </summary>
public sealed class PhoneLinkService : BackgroundService
{
    public const string Ntfy = "https://ntfy.sh";

    /// <summary>Where the phone app is served (GitHub Pages of this repository); relay.json sits beside it.</summary>
    public const string PhoneAppUrl = "https://drs-vision.github.io/Windows-Learning/";

    /// <summary>The relay a new QR code names (phones learn CoinQuest's own relay from relay.json, so this stays stable).</summary>
    public static string Relay => Environment.GetEnvironmentVariable("COINQUEST_RELAY") is { Length: > 0 } r ? r.TrimEnd('/') : Ntfy;

    public sealed record Link(string Id, string Name, string TopicIn, string TopicOut, string Key, DateTimeOffset Created, DateTimeOffset? LastSeen = null);

    private sealed class Store
    {
        public List<Link> Links { get; set; } = new();
        /// <summary>ntfy.sh's id of the last message handled — requests sent while the PC was off arrive (once) when it's back.</summary>
        public string? Since { get; set; }
        /// <summary>The same for CoinQuest's relay, per topic.</summary>
        public Dictionary<string, string> SinceCq { get; set; } = new();
        /// <summary>CoinQuest's own relay (from relay.json), remembered for when GitHub can't be reached.</summary>
        public string? CqRelay { get; set; }
    }

    private static string FilePath => Path.Combine(Paths.DataRoot, "phone-links.json");

    private readonly ILogger<PhoneLinkService> _log;
    private readonly HttpClient _http = new() { Timeout = Timeout.InfiniteTimeSpan };   // the long-lived ntfy stream
    private readonly HttpClient _post = new() { Timeout = TimeSpan.FromSeconds(20) };
    private readonly object _gate = new();
    private readonly PhoneWire.Assembler _assembler = new();
    private readonly Dictionary<string, DateTime> _seenRequests = new();
    private Store _store;
    private CancellationTokenSource? _listen;
    private DateTime _lastSnapshot = DateTime.MinValue;
    private int _snapshotQueued;
    private string _ntfyStatus = "starting", _cqStatus = "";

    /// <summary>Runs one phone request (as the parent) and returns its answer. Set by the request router.</summary>
    public Func<string, JsonObject, string, object?>? Handler { get; set; }

    public string Status => _store.Links.Count == 0 ? "no phones linked"
        : (_store.CqRelay is null ? "" : $"CoinQuest relay: {_cqStatus}; ") + $"ntfy.sh: {_ntfyStatus}";

    public PhoneLinkService(ILogger<PhoneLinkService> log)
    {
        _log = log;
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("CoinQuest");
        _post.DefaultRequestHeaders.UserAgent.ParseAdd("CoinQuest");
        _store = Load();
    }

    private static Store Load()
    {
        try { return JsonSerializer.Deserialize<Store>(File.ReadAllText(FilePath)) ?? new Store(); } catch { return new Store(); }
    }

    private void Save()
    {
        Directory.CreateDirectory(Paths.DataRoot);
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_store));
        // The keys are as good as the parent PIN: only Windows itself and administrators may read them (never a child).
        try
        {
            var fs = new FileSecurity();
            fs.SetAccessRuleProtection(true, false);
            fs.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
            fs.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
            new FileInfo(tmp).SetAccessControl(fs);
        }
        catch (Exception ex) { _log.LogWarning(ex, "Couldn't restrict phone-links.json"); }
        File.Move(tmp, FilePath, true);
    }

    // ---- parent console -------------------------------------------------------------------------------------------

    /// <summary>A new phone link: the address the QR code holds (the key is after '#', so it never reaches a web server).</summary>
    public object Create(string name, string household)
    {
        var link = new Link(Guid.NewGuid().ToString("N")[..12], string.IsNullOrWhiteSpace(name) ? "Phone" : name.Trim(),
            PhoneWire.NewTopic(), PhoneWire.NewTopic(), PhoneWire.B64Url(PhoneWire.NewKey()), DateTimeOffset.UtcNow);
        lock (_gate) { _store.Links.Add(link); Save(); }
        Restart();
        var payload = new JsonObject { ["v"] = 1, ["r"] = Relay, ["i"] = link.TopicIn, ["o"] = link.TopicOut, ["k"] = link.Key, ["n"] = household, ["p"] = link.Name };
        var url = PhoneAppUrl + "#" + PhoneWire.B64Url(Encoding.UTF8.GetBytes(payload.ToJsonString()));
        _log.LogInformation("Phone link {Id} created ({Name})", link.Id, link.Name);
        NoteChange();
        return new { id = link.Id, name = link.Name, url };
    }

    public object List()
    {
        lock (_gate) return new { relay = _store.CqRelay ?? Ntfy, status = Status, phones = _store.Links.Select(l => new { l.Id, l.Name, l.Created, l.LastSeen }).ToList() };
    }

    public object Remove(string id)
    {
        lock (_gate) { _store.Links.RemoveAll(l => l.Id == id); Save(); }
        Restart();
        _log.LogInformation("Phone link {Id} removed", id);
        return List();
    }

    /// <summary>Coins, requests or settings changed: refresh the snapshot phones see while the PC is offline.</summary>
    public void NoteChange()
    {
        if (Interlocked.Exchange(ref _snapshotQueued, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            // At most one snapshot every 15 seconds (a busy afternoon of lessons is still only a few dozen messages).
            var wait = _lastSnapshot + TimeSpan.FromSeconds(15) - DateTime.UtcNow;
            if (wait > TimeSpan.Zero) await Task.Delay(wait);
            Interlocked.Exchange(ref _snapshotQueued, 0);
            await PostSnapshots();
        });
    }

    // ---- relays -----------------------------------------------------------------------------------------------------

    private void Restart() { lock (_gate) _listen?.Cancel(); }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        _ = Task.Run(() => DiscoverLoop(stop), stop);
        while (!stop.IsCancellationRequested)
        {
            List<Link> links; CancellationTokenSource listen; string? cq;
            lock (_gate)
            {
                links = _store.Links.ToList(); cq = _store.CqRelay;
                _listen = listen = CancellationTokenSource.CreateLinkedTokenSource(stop);
            }
            if (links.Count == 0) { _ntfyStatus = "idle"; try { await Task.Delay(Timeout.Infinite, listen.Token); } catch (OperationCanceledException) { } continue; }
            var tasks = new List<Task> { ListenNtfy(links, listen.Token) };
            if (cq is not null) tasks.AddRange(links.Select(l => ListenCq(cq, l, listen.Token)));
            try { await Task.WhenAll(tasks); } catch { }
            if (stop.IsCancellationRequested) break;
        }
    }

    /// <summary>Learn CoinQuest's own relay from relay.json beside the phone app (checked at start, then every 6 hours).</summary>
    private async Task DiscoverLoop(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                string? cq;
                if (Environment.GetEnvironmentVariable("COINQUEST_CQ_RELAY") is { Length: > 0 } over) cq = over.TrimEnd('/');
                else
                {
                    var j = JsonNode.Parse(await _post.GetStringAsync(PhoneAppUrl + "relay.json?t=" + DateTime.UtcNow.Ticks, stop));
                    cq = j?["relays"]?.AsArray().Select(r => r?["url"]?.GetValue<string>()?.TrimEnd('/'))
                        .FirstOrDefault(u => u is { Length: > 0 } && !u.StartsWith(Ntfy, StringComparison.OrdinalIgnoreCase));
                }
                bool changed;
                lock (_gate) { changed = _store.CqRelay != cq; _store.CqRelay = cq; if (changed) Save(); }
                if (changed) { _log.LogInformation("Phone relay: {Relay}", cq ?? "ntfy.sh only"); Restart(); NoteChange(); }
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { _log.LogInformation("Couldn't check relay.json: {Msg}", ex.Message); }
            try { await Task.Delay(TimeSpan.FromHours(6), stop); } catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>ntfy.sh: one streaming connection for all linked phones' topics.</summary>
    private async Task ListenNtfy(List<Link> links, CancellationToken token)
    {
        var backoff = TimeSpan.FromSeconds(5);
        while (!token.IsCancellationRequested)
        {
            try
            {
                string? since; lock (_gate) since = _store.Since;
                var url = $"{Relay}/{string.Join(",", links.Select(l => l.TopicIn))}/json?since={(since is { Length: > 0 } ? Uri.EscapeDataString(since) : "1m")}";
                using var resp = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, token);
                if ((int)resp.StatusCode == 429) throw new HttpRequestException("busy (too many messages) — waiting");
                resp.EnsureSuccessStatusCode();
                _ntfyStatus = $"listening for {links.Count} phone{(links.Count == 1 ? "" : "s")}";
                backoff = TimeSpan.FromSeconds(5);
                using var reader = new StreamReader(await resp.Content.ReadAsStreamAsync(token));
                while (!token.IsCancellationRequested)
                {
                    // ntfy sends a keep-alive every ~45 s; a silent 100 s means the connection is dead.
                    var read = reader.ReadLineAsync(token).AsTask();
                    if (await Task.WhenAny(read, Task.Delay(TimeSpan.FromSeconds(100), token)) != read) break;
                    var line = await read;
                    if (line is null) break;
                    if (line.Length > 0) Received(line, links, "ntfy", Relay);
                }
                await Task.Delay(2000, token); // the relay closed the connection: reconnect, gently
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                _ntfyStatus = "can't reach it: " + ex.Message;
                _log.LogInformation("ntfy.sh: {Msg}; retrying in {S}s", ex.Message, (int)backoff.TotalSeconds);
                try { await Task.Delay(backoff, token); } catch (OperationCanceledException) { break; }
                backoff = TimeSpan.FromSeconds(Math.Min(600, backoff.TotalSeconds * 2));
            }
        }
    }

    /// <summary>CoinQuest's relay: a WebSocket per linked phone (the relay sleeps between messages, so it costs nothing idle).</summary>
    private async Task ListenCq(string relay, Link link, CancellationToken token)
    {
        var backoff = TimeSpan.FromSeconds(3);
        var wsBase = relay.Replace("https://", "wss://", StringComparison.OrdinalIgnoreCase).Replace("http://", "ws://", StringComparison.OrdinalIgnoreCase);
        while (!token.IsCancellationRequested)
        {
            using var ws = new ClientWebSocket();
            ws.Options.KeepAliveInterval = TimeSpan.Zero;
            try
            {
                string since; lock (_gate) since = _store.SinceCq.TryGetValue(link.TopicIn, out var s) ? s : "1m";
                await ws.ConnectAsync(new Uri($"{wsBase}/{link.TopicIn}/ws?since={Uri.EscapeDataString(since)}"), token);
                _cqStatus = "connected";
                backoff = TimeSpan.FromSeconds(3);
                using var ping = new CancellationTokenSource();
                var lastHeard = DateTime.UtcNow;
                // Our own keep-alive: Cloudflare answers "ping" with "pong" without waking the relay.
                var pinger = Task.Run(async () =>
                {
                    while (!ping.IsCancellationRequested && ws.State == WebSocketState.Open)
                    {
                        try { await Task.Delay(TimeSpan.FromSeconds(30), ping.Token); await ws.SendAsync("ping"u8.ToArray(), WebSocketMessageType.Text, true, ping.Token); }
                        catch { break; }
                        if (DateTime.UtcNow - lastHeard > TimeSpan.FromSeconds(100)) { try { ws.Abort(); } catch { } break; }
                    }
                });
                var buffer = new byte[16384];
                using var msg = new MemoryStream();
                while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                {
                    var r = await ws.ReceiveAsync(buffer, token);
                    if (r.MessageType == WebSocketMessageType.Close) break;
                    msg.Write(buffer, 0, r.Count);
                    if (!r.EndOfMessage) continue;
                    lastHeard = DateTime.UtcNow;
                    var text = Encoding.UTF8.GetString(msg.ToArray()); msg.SetLength(0);
                    if (text != "pong") Received(text, new List<Link> { link }, "cq", relay);
                }
                ping.Cancel();
                await Task.Delay(1000, token);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                _cqStatus = "can't reach it: " + ex.Message;
                _log.LogInformation("CoinQuest relay: {Msg}; retrying in {S}s", ex.Message, (int)backoff.TotalSeconds);
                try { await Task.Delay(backoff, token); } catch (OperationCanceledException) { break; }
                backoff = TimeSpan.FromSeconds(Math.Min(300, backoff.TotalSeconds * 2));
            }
        }
    }

    private void Received(string line, List<Link> links, string kind, string relay)
    {
        JsonNode? ev; try { ev = JsonNode.Parse(line); } catch { return; }
        if (ev?["event"]?.GetValue<string>() != "message") return;
        var msgId = ev["id"]?.GetValue<string>();
        var topic = ev["topic"]?.GetValue<string>() ?? "";
        var text = ev["message"]?.GetValue<string>() ?? "";
        lock (_gate)
        {
            if (msgId is not null) { if (kind == "ntfy") _store.Since = msgId; else _store.SinceCq[topic] = msgId; }
            try { Save(); } catch { }
        }
        var link = links.FirstOrDefault(l => l.TopicIn == topic);
        if (link is null) return;
        var whole = _assembler.Add(text);
        if (whole is null) return;
        _ = Task.Run(() => Handle(link, whole, relay));
    }

    private async Task Handle(Link link, string sealedText, string relay)
    {
        var key = PhoneWire.FromB64Url(link.Key);
        var req = PhoneWire.Open(key, sealedText);
        if (req is not JsonObject r) { _log.LogInformation("Phone {Id}: message it couldn't read (old key?)", link.Id); return; }
        var id = r["id"]?.GetValue<string>() ?? "";
        // A phone that couldn't reach one relay may have sent the same request by the other: do it once.
        lock (_seenRequests)
        {
            foreach (var k in _seenRequests.Where(p => DateTime.UtcNow - p.Value > TimeSpan.FromHours(14)).Select(p => p.Key).ToList()) _seenRequests.Remove(k);
            if (id.Length > 0 && !_seenRequests.TryAdd(link.Id + "/" + id, DateTime.UtcNow)) return;
        }
        var op = r["op"]?.GetValue<string>() ?? "";
        var ts = r["ts"]?.GetValue<long>() ?? 0;
        JsonObject reply;
        if (DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(ts) > TimeSpan.FromDays(8))
            reply = new JsonObject { ["re"] = id, ["ok"] = false, ["e"] = "That request is too old." };
        else
            try
            {
                var result = Handler?.Invoke(op, r["a"] as JsonObject ?? new JsonObject(), "phone:" + link.Name) ?? throw new InvalidOperationException("not ready");
                reply = new JsonObject { ["re"] = id, ["ok"] = true, ["d"] = JsonSerializer.SerializeToNode(result, Json) };
            }
            catch (Exception ex) { reply = new JsonObject { ["re"] = id, ["ok"] = false, ["e"] = ex.Message }; }
        lock (_gate)
        {
            var i = _store.Links.FindIndex(l => l.Id == link.Id);
            if (i < 0) return; // removed meanwhile
            _store.Links[i] = _store.Links[i] with { LastSeen = DateTimeOffset.UtcNow };
        }
        await PostAll(relay, link.TopicOut, PhoneWire.Seal(key, reply), link.Id);
        if (op != "state" && op != "config" && op != "history") NoteChange();
    }

    private async Task PostAll(string relay, string topic, string sealedText, string who)
    {
        try
        {
            foreach (var part in PhoneWire.Split(sealedText))
                using (var resp = await _post.PostAsync($"{relay}/{topic}", new StringContent(part, Encoding.UTF8, "text/plain")))
                    resp.EnsureSuccessStatusCode();
        }
        catch (Exception ex) { _log.LogInformation("Phone {Id}: couldn't send by {Relay}: {Msg}", who, relay, ex.Message); }
    }

    /// <summary>Leave each phone a scrambled snapshot (coins, requests) on CoinQuest's relay, for when the PC is off.</summary>
    private async Task PostSnapshots()
    {
        string? cq; List<Link> links;
        lock (_gate) { cq = _store.CqRelay; links = _store.Links.ToList(); }
        if (cq is null || links.Count == 0 || Handler is null) return;
        _lastSnapshot = DateTime.UtcNow;
        object? state;
        try { state = Handler("state", new JsonObject(), "snapshot"); } catch { return; }
        var node = JsonSerializer.SerializeToNode(state, Json);
        foreach (var l in links)
        {
            var snap = new JsonObject { ["snap"] = true, ["d"] = node?.DeepClone() };
            // One message, so the relay's "latest" is the whole snapshot (it accepts up to 8 KB).
            var body = "cq1:snap:1/1:" + PhoneWire.Seal(PhoneWire.FromB64Url(l.Key), snap);
            if (body.Length > 8000) { _log.LogInformation("Snapshot too large for the relay ({N} chars)", body.Length); continue; }
            try { using var resp = await _post.PostAsync($"{cq}/{l.TopicOut}-snap", new StringContent(body, Encoding.UTF8, "text/plain")); }
            catch (Exception ex) { _log.LogInformation("Snapshot: {Msg}", ex.Message); }
        }
    }

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
}
