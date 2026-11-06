using System.Text.Json;
using System.Text.Json.Nodes;

namespace CoinQuest.Shared.Books;

/// <summary>
/// Reading Quest: a short paragraph, one question under it, one after another with no set length. The next paragraph is picked
/// near the child's rating, and the rating moves with each answer, Elo-style:
/// <code>
///   chance of a right answer  p = 1 / (1 + 10^((d - R) / 2))      d = the paragraph's readability grade, R = the rating
///   after an answer           R = R + K * (right ? 1 - p : -p)    K = 0.8 for the first 15 answers, then 0.4
/// </code>
/// Like game matchmaking (Brawl Stars trophies, chess Elo): a right answer on a hard paragraph moves the rating up a lot, on an easy one a little; a miss on an easy one
/// moves it down more than a miss on a hard one. Everything is on the US-grade scale of the readability formulas
/// (content/passages/README.md), which is what parents see; children see "Level" (see Level()).
/// </summary>
public sealed class QuestLibrary
{
    public sealed record Source(string Name, string Url, string License, string? Author = null);
    public sealed record QuestQuestion(string Type, string Q, List<string> Choices, int Answer, string Evidence, string Explain);
    public sealed record Passage(string Id, string Title, string Kind, string Topic, string Text, double Grade, int Words, Source Source, QuestQuestion Question);

    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };
    private readonly string _root;
    private List<Passage>? _all;
    private readonly object _gate = new();
    public QuestLibrary(string root) => _root = root;

    public IReadOnlyList<Passage> All()
    {
        lock (_gate)
        {
            if (_all is not null) return _all;
            _all = new();
            if (!Directory.Exists(_root)) return _all;
            foreach (var f in Directory.EnumerateFiles(_root, "*.json").OrderBy(f => f))
            {
                try
                {
                    var doc = JsonNode.Parse(File.ReadAllText(f));
                    foreach (var p in doc?["passages"]?.AsArray() ?? new JsonArray())
                    {
                        if (p is null) continue;
                        var q = p["question"]!.Deserialize<QuestQuestion>(Json)!;
                        if (q.Choices.Count != 4 || q.Answer is < 0 or > 3) continue;
                        var text = p["text"]!.GetValue<string>();
                        _all.Add(new Passage(p["id"]!.GetValue<string>(), p["title"]?.GetValue<string>() ?? "", p["kind"]?.GetValue<string>() ?? "facts",
                            p["topic"]?.GetValue<string>() ?? "", text, p["readability"]?["grade"]?.GetValue<double>() ?? 3,
                            text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length,
                            p["source"]!.Deserialize<Source>(Json)!, q));
                    }
                }
                catch { /* a broken file is left out; the validator reports it */ }
            }
            return _all;
        }
    }

    public Passage? Find(string id) => All().FirstOrDefault(p => p.Id == id);
}

/// <summary>A child's Reading Quest state (kept with the child's progress).</summary>
public sealed class QuestState
{
    public double Rating { get; set; } = ReadingQuest.StartRating;
    public int Answered { get; set; }
    public int Streak { get; set; }
    public int BestStreak { get; set; }
    /// <summary>Misses in a row: after 2, the next paragraph is an easy one (a confidence builder).</summary>
    public int Misses { get; set; }
    public Dictionary<string, QuestDone> Done { get; set; } = new();
    public QuestOpen? Open { get; set; }
    /// <summary>Paragraphs missed the first time, and the answer count after which each one comes back.</summary>
    public Dictionary<string, int> Retry { get; set; } = new();
    /// <summary>The rating at the end of each day (yyyy-MM-dd → rating), for the parents' trend.</summary>
    public Dictionary<string, double> History { get; set; } = new();
}

public sealed class QuestDone
{
    public bool Right { get; set; }
    public DateTimeOffset At { get; set; }
    public double Grade { get; set; }
    public string Type { get; set; } = "";
    public long Ms { get; set; }
    public int Words { get; set; }
    public double RatingBefore { get; set; }
    /// <summary>For a miss: null = not retried yet; true/false = the retry's result.</summary>
    public bool? Retried { get; set; }
}

public sealed class QuestOpen
{
    public string Id { get; set; } = "";
    public int[] Order { get; set; } = { 0, 1, 2, 3 };
    public DateTimeOffset OpenedAt { get; set; }
    public bool IsRetry { get; set; }
}

public static class ReadingQuest
{
    public const double StartRating = 1.0, Scale = 2.0, Stretch = 0.3;
    /// <summary>A missed paragraph comes back after this many other answers.</summary>
    public const int RetryAfter = 5;

    /// <summary>Seconds before an answer can be picked: about 4 words a second, 15 to 30 seconds.</summary>
    public static int ReadSeconds(int words) => Math.Clamp((int)Math.Round(words / 4.0), 15, 30);

    public sealed record Shown(string Id, string Title, string Text, string Q, List<string> Choices, string SourceName, string SourceUrl, string License, string? Author, bool Retry, int ReadSeconds, int WaitLeft);
    public sealed record Answered(bool Right, int RightChoice, string Evidence, string Explain, double Before, double After, int Streak, bool StreakUp, bool Retry);

    public static double Expected(double rating, double grade) => 1 / (1 + Math.Pow(10, (grade - rating) / Scale));
    public static double K(int answered) => answered < 15 ? 0.8 : 0.4;
    /// <summary>What a child sees: Level 1 below a rating of 2, then the rating's whole number (new players start at Level 1).</summary>
    public static int Level(double rating) => Math.Max(1, (int)Math.Floor(rating));
    /// <summary>The bar towards the next level (0-1).</summary>
    public static double LevelProgress(double rating) => rating < 1 ? Math.Max(0, rating) / 2 : rating < 2 ? 0.5 + (rating - 1) / 2 : rating - Math.Floor(rating);

    /// <summary>The next paragraph: the open one if there is one, else one not read yet near the rating (a little above;
    /// about a grade below after two misses in a row).</summary>
    public static Shown? Next(QuestState s, IReadOnlyList<QuestLibrary.Passage> all, Random rng, string? lastTopic = null, DateTimeOffset? at = null)
    {
        var now = at ?? DateTimeOffset.Now;
        if (s.Open is { } o && all.FirstOrDefault(p => p.Id == o.Id) is { } open) return Show(open, o, now);
        // A missed paragraph whose turn has come, for a second look (it doesn't pay or move the rating).
        var due = s.Retry.Where(kv => kv.Value <= s.Answered).OrderBy(kv => kv.Value).Select(kv => all.FirstOrDefault(p => p.Id == kv.Key)).FirstOrDefault(p => p is not null);
        if (due is not null) return Show(due, s.Open = new QuestOpen { Id = due.Id, Order = Shuffle(rng), OpenedAt = now, IsRetry = true }, now);
        var target = s.Misses >= 2 ? s.Rating - 1 : s.Rating + Stretch;
        var fresh = all.Where(p => !s.Done.ContainsKey(p.Id)).ToList();
        if (fresh.Count == 0) return null;
        // The closest few, then a random one of them (mixing topics), so it isn't the same kind of paragraph each time.
        var near = fresh.OrderBy(p => Math.Abs(p.Grade - target)).Take(6).ToList();
        var pool = near.Where(p => p.Topic != lastTopic).ToList();
        var pick = (pool.Count > 0 ? pool : near)[rng.Next((pool.Count > 0 ? pool : near).Count)];
        s.Open = new QuestOpen { Id = pick.Id, Order = Shuffle(rng), OpenedAt = now };
        return Show(pick, s.Open, now);
    }

    private static int[] Shuffle(Random rng)
    {
        var order = new[] { 0, 1, 2, 3 };
        for (var i = 3; i > 0; i--) { var j = rng.Next(i + 1); (order[i], order[j]) = (order[j], order[i]); }
        return order;
    }

    private static Shown Show(QuestLibrary.Passage p, QuestOpen o, DateTimeOffset now)
    {
        var secs = ReadSeconds(p.Words);
        var left = Math.Max(0, (int)Math.Ceiling(secs - (now - o.OpenedAt).TotalSeconds));
        return new(p.Id, p.Title, p.Text, p.Question.Q, o.Order.Select(i => p.Question.Choices[i]).ToList(), p.Source.Name, p.Source.Url, p.Source.License, p.Source.Author, o.IsRetry, secs, left);
    }

    /// <summary>Mark the open paragraph's answer (the position the child picked) and move the rating.</summary>
    public static Answered Answer(QuestState s, QuestLibrary.Passage p, string id, int picked, long readMs, int streakEvery, DateTimeOffset now)
    {
        if (s.Open is not { } o || o.Id != id) throw new InvalidOperationException("That paragraph isn't open any more");
        // Read first: answers before the reading time (less a little slack) aren't accepted.
        if ((now - o.OpenedAt).TotalSeconds < ReadSeconds(p.Words) - 2) throw new InvalidOperationException("Read the paragraph first — the answers open in a few seconds");
        var rightPos = Array.IndexOf(o.Order, p.Question.Answer);
        var right = picked == rightPos;
        if (o.IsRetry)
        {
            // A second look: the result is kept for parents, but it pays nothing and moves neither rating nor streak.
            if (s.Done.TryGetValue(id, out var first)) first.Retried = right;
            s.Retry.Remove(id);
            s.Open = null;
            return new Answered(right, rightPos, p.Question.Evidence, p.Question.Explain, s.Rating, s.Rating, s.Streak, false, true);
        }
        var before = s.Rating;
        var e = Expected(before, p.Grade);
        s.Rating = Math.Clamp(before + K(s.Answered) * ((right ? 1 : 0) - e), 0, 13);
        s.Answered++;
        var up = false;
        if (right)
        {
            s.Streak++;
            s.BestStreak = Math.Max(s.BestStreak, s.Streak);
            up = streakEvery > 0 && s.Streak % streakEvery == 0;
            s.Misses = 0;
        }
        else { s.Streak = 0; s.Misses++; }
        s.Done[id] = new QuestDone { Right = right, At = now, Grade = p.Grade, Type = p.Question.Type, Ms = Math.Clamp(readMs, 0, 30 * 60_000), Words = p.Words, RatingBefore = before };
        s.Open = null;
        if (!right) s.Retry[id] = s.Answered + RetryAfter;
        s.History[now.LocalDateTime.ToString("yyyy-MM-dd")] = Math.Round(s.Rating, 2);
        if (s.History.Count > 400) foreach (var k in s.History.Keys.OrderBy(k => k).Take(s.History.Count - 400).ToList()) s.History.Remove(k);
        return new Answered(right, rightPos, p.Question.Evidence, p.Question.Explain, before, s.Rating, s.Streak, up, false);
    }

    /// <summary>Coins for a right answer: 1 per 100 words (rounded up), times the parent's setting.</summary>
    public static int Pay(int words, int perUnit) => Math.Max(1, (int)Math.Ceiling(words / 100.0)) * perUnit;

    /// <summary>The parents' view: rating and its trend, accuracy by question type and by difficulty, recent paragraphs.</summary>
    public static JsonObject Report(QuestState s, QuestLibrary lib, DateTimeOffset now)
    {
        var done = s.Done.Select(kv => (Id: kv.Key, D: kv.Value)).OrderByDescending(x => x.D.At).ToList();
        int? Pct(IEnumerable<QuestDone> xs) { var l = xs.ToList(); return l.Count == 0 ? null : (int)Math.Round(100.0 * l.Count(x => x.Right) / l.Count); }
        var month = done.Where(x => x.D.At >= now.AddDays(-30)).Select(x => x.D).ToList();
        var types = new JsonArray();
        foreach (var t in new[] { "detail", "main-idea", "vocabulary", "inference", "sequence", "cause-effect" })
        {
            var l = done.Where(x => x.D.Type == t).Select(x => x.D).ToList();
            if (l.Count > 0) types.Add(new JsonObject { ["type"] = t, ["answered"] = l.Count, ["right"] = l.Count(x => x.Right), ["percent"] = Pct(l) });
        }
        var bands = new JsonArray();
        foreach (var g in done.GroupBy(x => (int)Math.Floor(x.D.Grade)).OrderBy(g => g.Key))
            bands.Add(new JsonObject { ["grade"] = g.Key, ["answered"] = g.Count(), ["percent"] = Pct(g.Select(x => x.D)) });
        var speeds = done.Where(x => x.D.Ms > 3000).Select(x => x.D.Words / (x.D.Ms / 60000.0)).Where(w => w is >= 20 and <= 600).OrderBy(w => w).ToList();
        return new JsonObject
        {
            ["rating"] = Math.Round(s.Rating, 1),
            ["level"] = Level(s.Rating),
            ["answered"] = s.Answered,
            ["percent30"] = Pct(month), ["answered30"] = month.Count,
            ["percentAll"] = Pct(done.Select(x => x.D)),
            ["streak"] = s.Streak, ["bestStreak"] = s.BestStreak,
            ["wpm"] = speeds.Count > 0 ? (int)Math.Round(speeds[speeds.Count / 2]) : null,
            ["minutes"] = (int)Math.Round(done.Sum(x => x.D.Ms) / 60000.0),
            ["history"] = new JsonArray(s.History.OrderBy(kv => kv.Key).TakeLast(90).Select(kv => (JsonNode)new JsonObject { ["day"] = kv.Key, ["rating"] = kv.Value }).ToArray()),
            ["types"] = types,
            ["bands"] = bands,
            ["recent"] = new JsonArray(done.Take(15).Select(x =>
            {
                var p = lib.Find(x.Id);
                return (JsonNode)new JsonObject
                {
                    ["at"] = x.D.At.ToString("yyyy-MM-dd"), ["title"] = p?.Title ?? x.Id, ["grade"] = Math.Round(x.D.Grade, 1), ["type"] = x.D.Type, ["right"] = x.D.Right,
                    ["source"] = p?.Source.Name, ["url"] = p?.Source.Url,
                };
            }).ToArray()),
            ["pool"] = lib.All().Count, ["left"] = lib.All().Count(p => !s.Done.ContainsKey(p.Id)),
        };
    }
}
