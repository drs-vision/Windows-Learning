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
/// see balances, give or take coins and answer requests from their phone, anywhere — no account, no password.
///
/// Each linked phone has its own random key and two random topic names on the relay (phone → PC, PC → phone). The PC
/// keeps one streaming connection to the relay listening on every linked phone's topic, unscrambles each request with
/// that phone's key, runs it, and posts the scrambled answer back. Removing a phone deletes its key: it can't talk to
/// the PC again. The relay sees only random topic names and scrambled text.
/// </summary>
public sealed class PhoneLinkService : BackgroundService
{
    /// <summary>The relay: the public ntfy server. Any ntfy server works (it's open source), so the family's own can replace it.</summary>
    public static string Relay => Environment.GetEnvironmentVariable("COINQUEST_RELAY") is { Length: > 0 } r ? r.TrimEnd('/') : "https://ntfy.sh";

    /// <summary>Where the phone app is served (GitHub Pages of this repository).</summary>
    public const string PhoneAppUrl = "https://drs-vision.github.io/Windows-Learning/";

    public sealed record Link(string Id, string Name, string TopicIn, string TopicOut, string Key, DateTimeOffset Created, DateTimeOffset? LastSeen = null);

    private sealed class Store
    {
        public List<Link> Links { get; set; } = new();
        /// <summary>The relay's id of the last message handled — so requests sent while the PC was off arrive (once) when it's back.</summary>
        public string? Since { get; set; }
    }

    private static string FilePath => Path.Combine(Paths.DataRoot, "phone-links.json");

    private readonly ILogger<PhoneLinkService> _log;
    private readonly HttpClient _http = new() { Timeout = Timeout.InfiniteTimeSpan };   // the long-lived listening connection
    private readonly HttpClient _post = new() { Timeout = TimeSpan.FromSeconds(20) };
    private readonly object _gate = new();
    private readonly PhoneWire.Assembler _assembler = new();
    private Store _store;
    private CancellationTokenSource? _listen;

    /// <summary>Runs one phone request (as the parent) and returns its answer. Set by the request router.</summary>
    public Func<string, JsonObject, string, object?>? Handler { get; set; }

    public string Status { get; private set; } = "not started";

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
        return new { id = link.Id, name = link.Name, url };
    }

    public object List()
    {
        lock (_gate) return new { relay = Relay, status = Status, phones = _store.Links.Select(l => new { l.Id, l.Name, l.Created, l.LastSeen }).ToList() };
    }

    public object Remove(string id)
    {
        lock (_gate) { _store.Links.RemoveAll(l => l.Id == id); Save(); }
        Restart();
        _log.LogInformation("Phone link {Id} removed", id);
        return List();
    }

    // ---- relay ------------------------------------------------------------------------------------------------------

    private void Restart() { lock (_gate) _listen?.Cancel(); }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var backoff = TimeSpan.FromSeconds(5);
        while (!stop.IsCancellationRequested)
        {
            List<Link> links; string? since;
            CancellationTokenSource listen;
            lock (_gate)
            {
                links = _store.Links.ToList(); since = _store.Since;
                _listen = listen = CancellationTokenSource.CreateLinkedTokenSource(stop);
            }
            if (links.Count == 0)
            {
                Status = "no phones linked";
                try { await Task.Delay(Timeout.Infinite, listen.Token); } catch (OperationCanceledException) { }
                continue;
            }
            try
            {
                var topics = string.Join(",", links.Select(l => l.TopicIn));
                // Requests sent while the PC was off are kept by the relay for 12 hours.
                var url = $"{Relay}/{topics}/json?since={(since is { Length: > 0 } ? Uri.EscapeDataString(since) : "1m")}";
                using var resp = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, listen.Token);
                resp.EnsureSuccessStatusCode();
                Status = $"listening for {links.Count} phone{(links.Count == 1 ? "" : "s")}";
                backoff = TimeSpan.FromSeconds(5);
                using var reader = new StreamReader(await resp.Content.ReadAsStreamAsync(listen.Token));
                while (!listen.IsCancellationRequested)
                {
                    // The relay sends a keep-alive every ~45 s; a silent minute means the connection is dead.
                    var read = reader.ReadLineAsync(listen.Token).AsTask();
                    if (await Task.WhenAny(read, Task.Delay(TimeSpan.FromSeconds(100), listen.Token)) != read) break;
                    var line = await read;
                    if (line is null) break;
                    if (line.Length == 0) continue;
                    JsonNode? ev; try { ev = JsonNode.Parse(line); } catch { continue; }
                    if (ev?["event"]?.GetValue<string>() != "message") continue;
                    var msgId = ev["id"]?.GetValue<string>();
                    var topic = ev["topic"]?.GetValue<string>() ?? "";
                    var text = ev["message"]?.GetValue<string>() ?? "";
                    lock (_gate) { if (msgId is not null) { _store.Since = msgId; } }
                    var link = links.FirstOrDefault(l => l.TopicIn == topic);
                    if (link is null) continue;
                    var whole = _assembler.Add(text);
                    if (whole is null) continue;
                    _ = Task.Run(() => Handle(link, whole), stop);
                    lock (_gate) try { Save(); } catch { }
                }
                await Task.Delay(2000, listen.Token); // the relay closed the connection: reconnect, gently
            }
            catch (OperationCanceledException) when (!stop.IsCancellationRequested) { /* links changed: reconnect */ continue; }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                Status = "can't reach the relay: " + ex.Message;
                _log.LogInformation("Phone relay: {Msg}; retrying in {S}s", ex.Message, (int)backoff.TotalSeconds);
                try { await Task.Delay(backoff, listen.Token); } catch (OperationCanceledException) { if (stop.IsCancellationRequested) break; }
                backoff = TimeSpan.FromSeconds(Math.Min(300, backoff.TotalSeconds * 2));
            }
        }
    }

    private async Task Handle(Link link, string sealedText)
    {
        var key = PhoneWire.FromB64Url(link.Key);
        var req = PhoneWire.Open(key, sealedText);
        if (req is not JsonObject r) { _log.LogInformation("Phone {Id}: message it couldn't read (old key?)", link.Id); return; }
        var id = r["id"]?.GetValue<string>() ?? "";
        var op = r["op"]?.GetValue<string>() ?? "";
        var ts = r["ts"]?.GetValue<long>() ?? 0;
        JsonObject reply;
        if (DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(ts) > TimeSpan.FromHours(13))
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
        try
        {
            foreach (var part in PhoneWire.Split(PhoneWire.Seal(key, reply)))
                using (var resp = await _post.PostAsync($"{Relay}/{link.TopicOut}", new StringContent(part, Encoding.UTF8, "text/plain")))
                    resp.EnsureSuccessStatusCode();
        }
        catch (Exception ex) { _log.LogInformation("Phone {Id}: couldn't send the answer: {Msg}", link.Id, ex.Message); }
    }

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
}
