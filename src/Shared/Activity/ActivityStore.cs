using System.Text.Json;
using System.Text.Json.Nodes;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Ledgers;
using CoinQuest.Shared.Models;

namespace CoinQuest.Shared.Activity;

/// <summary>
/// What a child did each day, for the parent's Activity reports: minutes in each quest, website, YouTube channel,
/// game and app (sampled once a minute by the child's CoinQuest window, idle time not counted), typing totals, and
/// things finished (Khan Academy answers, Duolingo lessons, passages…). One small JSON file per child per day under
/// &lt;data&gt;\activity\&lt;child&gt;\yyyy-MM-dd.json, kept on the PC. Coins come from the ledger when a report is built.
/// </summary>
public sealed class ActivityStore
{
    public sealed class Use { public string Kind { get; set; } = ""; public string Label { get; set; } = ""; public int Seconds { get; set; } }
    public sealed class TypingTotals { public int Sessions { get; set; } public int Chars { get; set; } public long Ms { get; set; } public int BestWpm { get; set; } }
    public sealed class Day
    {
        public Dictionary<string, Use> Time { get; set; } = new();
        public TypingTotals Typing { get; set; } = new();
        public Dictionary<string, int> Done { get; set; } = new();
    }

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly string _root;
    private readonly object _gate = new();

    public ActivityStore(string? root = null) => _root = root ?? Path.Combine(Paths.DataRoot, "activity");

    private string FileFor(string childId, DateTime day) => Path.Combine(_root, Safe(childId), day.ToString("yyyy-MM-dd") + ".json");
    private static string Safe(string s) => string.Concat(s.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_'));

    public Day? Load(string childId, DateTime day)
    {
        var f = FileFor(childId, day);
        try { return File.Exists(f) ? JsonSerializer.Deserialize<Day>(File.ReadAllText(f), Json) : null; } catch { return null; }
    }

    /// <summary>Days with anything recorded, newest first.</summary>
    public List<DateTime> Days(string childId)
    {
        var dir = Path.Combine(_root, Safe(childId));
        if (!Directory.Exists(dir)) return new();
        return Directory.EnumerateFiles(dir, "*.json")
            .Select(f => DateTime.TryParseExact(Path.GetFileNameWithoutExtension(f), "yyyy-MM-dd", null, System.Globalization.DateTimeStyles.None, out var d) ? d : (DateTime?)null)
            .Where(d => d is not null).Select(d => d!.Value).OrderByDescending(d => d).ToList();
    }

    /// <summary>Change today's record. Returns true if this was the first thing recorded for the child today.</summary>
    private bool Edit(string childId, DateTime when, Action<Day> change)
    {
        lock (_gate)
        {
            var f = FileFor(childId, when.Date);
            var first = !File.Exists(f);
            var d = Load(childId, when.Date) ?? new Day();
            change(d);
            Directory.CreateDirectory(Path.GetDirectoryName(f)!);
            var tmp = f + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(d, Json));
            File.Move(tmp, f, true);
            return first;
        }
    }

    public bool AddTime(string childId, DateTime when, string kind, string key, string label, int seconds) => Edit(childId, when, d =>
    {
        kind = Clip(kind, 20); key = Clip(key, 120); label = Clip(label, 80);
        var k = kind + "|" + key.ToLowerInvariant();
        if (!d.Time.TryGetValue(k, out var u)) { if (d.Time.Count >= 300) return; d.Time[k] = u = new Use { Kind = kind, Label = label }; }
        if (label.Length > 0) u.Label = label;
        u.Seconds += Math.Clamp(seconds, 0, 600);
    });

    public void AddTyping(string childId, DateTime when, int chars, long ms) => Edit(childId, when, d =>
    {
        if (chars <= 0 || ms < 1000) return;
        d.Typing.Sessions++; d.Typing.Chars += chars; d.Typing.Ms += ms;
        var wpm = (int)Math.Round(chars / 5.0 / (ms / 60000.0));
        if (wpm <= 200) d.Typing.BestWpm = Math.Max(d.Typing.BestWpm, wpm);
    });

    public void Count(string childId, DateTime when, string what, int n = 1) => Edit(childId, when, d =>
    {
        if (n <= 0) return;
        d.Done[Clip(what, 80)] = d.Done.GetValueOrDefault(Clip(what, 80)) + n;
    });

    private static string Clip(string s, int n) => (s ?? "").Trim() is var t && t.Length > n ? t[..n] : (s ?? "").Trim();

    /// <summary>
    /// One day's report: time (top 40), typing, things finished, and coins earned/spent from the ledger. Additive, so
    /// a week is just the days added together (the phone and Parent Console do that).
    /// </summary>
    public JsonObject Report(Child child, Ledger ledger, DateTime day)
    {
        var d = Load(child.Id, day) ?? new Day();
        var start = new DateTimeOffset(day.Date);
        var entries = ledger.Recent(child.Id, 5000, start).Where(e => e.At < start.AddDays(1)).ToList();
        var earned = new JsonObject(); var spent = new JsonObject();
        foreach (var g in entries.Where(e => e.Delta > 0).GroupBy(e => e.Source)) earned[g.Key] = g.Sum(e => e.Delta);
        foreach (var g in entries.Where(e => e.Delta < 0).GroupBy(e => e.Kind == LedgerKind.Spend ? ShortName(e.Detail) : e.Source)) spent[g.Key] = -g.Sum(e => e.Delta);
        return new JsonObject
        {
            ["v"] = 1,
            ["day"] = day.ToString("yyyy-MM-dd"),
            ["kid"] = child.DisplayName,
            ["childId"] = child.Id,
            ["time"] = new JsonArray(d.Time.Values.OrderByDescending(u => u.Seconds).Take(40)
                .Select(u => (JsonNode)new JsonObject { ["kind"] = u.Kind, ["label"] = u.Label, ["sec"] = u.Seconds }).ToArray()),
            ["typing"] = new JsonObject { ["sessions"] = d.Typing.Sessions, ["chars"] = d.Typing.Chars, ["ms"] = d.Typing.Ms, ["best"] = d.Typing.BestWpm },
            ["done"] = new JsonObject(d.Done.Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)kv.Value))),
            ["earned"] = earned,
            ["spent"] = spent,
            // The day's coin history (newest last): time, change, what. Claims waiting for a parent show as 0.
            ["log"] = new JsonArray(entries.OrderBy(e => e.Seq).TakeLast(80).Select(e => (JsonNode)new JsonObject
            {
                ["t"] = e.At.ToLocalTime().ToString("HH:mm"), ["d"] = e.Delta, ["k"] = e.Kind.ToString(), ["s"] = e.Source, ["x"] = e.Detail,
            }).ToArray()),
        };
    }

    private static string ShortName(string detail) => detail.Length > 40 ? detail[..40] : detail;
}
