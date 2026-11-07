using System.Text.Json;
using System.Text.Json.Nodes;

namespace CoinQuest.Shared.Books;

/// <summary>
/// Reading Quest: a paragraph with its question(s) right under it, one after another with no set length. Longer
/// paragraphs (higher levels) have a question per ~100 words. The next paragraph is picked near the child's rating, and
/// the rating moves with every answered question, Elo-style:
/// <code>
///   chance of a right answer  p = 1 / (1 + 10^((d - R) / 2))      d = the paragraph's readability grade, R = the rating
///   after an answer           R = R + K * (right ? 1 - p : -p)    K = 0.8 for the first 15 answers, then 0.4
/// </code>
/// Like game matchmaking (Brawl Stars trophies, chess Elo): a right answer on a hard paragraph moves the rating up a lot, on an easy one a little; a miss on an easy one
/// moves it down more than a miss on a hard one. Everything is on the US-grade scale of the readability formulas
/// (content/passages/README.md), which is what parents see; children see "Level" (see ReadingLevels).
/// </summary>
public sealed class QuestLibrary
{
    public sealed record Source(string Name, string Url, string License, string? Author = null);
    public sealed record QuestQuestion(string Type, string Q, List<string> Choices, int Answer, string Evidence, string Explain);
    public sealed record Passage(string Id, string Title, string Kind, string Topic, string Text, double Grade, int Words, Source Source, List<QuestQuestion> Questions);

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
                        // One question ("question") or several ("questions", for longer paragraphs).
                        var qs = p["questions"] is JsonArray many
                            ? many.Select(q => q!.Deserialize<QuestQuestion>(Json)!).ToList()
                            : new List<QuestQuestion> { p["question"]!.Deserialize<QuestQuestion>(Json)! };
                        if (qs.Count == 0 || qs.Any(q => q.Choices.Count != 4 || q.Answer is < 0 or > 3)) continue;
                        var text = p["text"]!.GetValue<string>();
                        _all.Add(new Passage(p["id"]!.GetValue<string>(), p["title"]?.GetValue<string>() ?? "", p["kind"]?.GetValue<string>() ?? "facts",
                            p["topic"]?.GetValue<string>() ?? "", text, p["readability"]?["grade"]?.GetValue<double>() ?? 3,
                            text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length,
                            p["source"]!.Deserialize<Source>(Json)!, qs));
                    }
                }
                catch { /* a broken file is left out; the validator reports it */ }
            }
            return _all;
        }
    }

    public Passage? Find(string id) => All().FirstOrDefault(p => p.Id == id);
}

/// <summary>A child's Reading Quest state (kept with the child's progress). Questions are keyed "paragraphId#n".</summary>
public sealed class QuestState
{
    public double Rating { get; set; } = ReadingQuest.StartRating;
    public int Answered { get; set; }
    public int Streak { get; set; }
    public int BestStreak { get; set; }
    /// <summary>Misses in a row: after 2, the next paragraph is an easier one (a confidence builder).</summary>
    public int Misses { get; set; }
    public Dictionary<string, QuestDone> Done { get; set; } = new();
    public QuestOpen? Open { get; set; }
    /// <summary>Missed questions and the first day (yyyy-MM-dd) each may come back: never sooner than the next day.</summary>
    public Dictionary<string, string> Later { get; set; } = new();
    /// <summary>Was the last paragraph a second look? (Second looks take turns with new paragraphs.)</summary>
    public bool LastWasRetry { get; set; }
    /// <summary>Old format (before questions were kept one by one): paragraph id → answer count. Moved into Later.</summary>
    public Dictionary<string, int>? Retry { get; set; }
    /// <summary>The rating at the end of each day (yyyy-MM-dd → rating), for the parents' trend.</summary>
    public Dictionary<string, double> History { get; set; } = new();
}

public sealed class QuestDone
{
    public bool Right { get; set; }
    public DateTimeOffset At { get; set; }
    public double Grade { get; set; }
    public string Type { get; set; } = "";
    /// <summary>Time since the paragraph opened (first question) or since the previous answer (later questions).</summary>
    public long Ms { get; set; }
    /// <summary>The paragraph's words, on the first question answered in a sitting only (for reading speed).</summary>
    public int Words { get; set; }
    public double RatingBefore { get; set; }
    /// <summary>For a miss: null = not retried yet; true/false = the second look's result.</summary>
    public bool? Retried { get; set; }
}

public sealed class QuestOpen
{
    public string Id { get; set; } = "";
    public DateTimeOffset OpenedAt { get; set; }
    public List<QuestOpenQ> Qs { get; set; } = new();
    /// <summary>The reading time sent with the last answer, so each question's time is counted once.</summary>
    public long LastMs { get; set; }
    // Old format (one question per paragraph), moved into Qs on load.
    public int[]? Order { get; set; }
    public bool IsRetry { get; set; }
}

public sealed class QuestOpenQ
{
    public int Index { get; set; }
    public int[] Order { get; set; } = { 0, 1, 2, 3 };
    public bool IsRetry { get; set; }
    public bool Done { get; set; }
}

public static class ReadingQuest
{
    public const double StartRating = 1.0, Scale = 2.0, Stretch = 0.3;

    /// <summary>Seconds before an answer can be picked: about 4 words a second, 15 to 30 seconds.</summary>
    public static int ReadSeconds(int words) => Math.Clamp((int)Math.Round(words / 4.0), 15, 30);

    public sealed record ShownQ(int Index, string Q, List<string> Choices, bool Retry);
    public sealed record Shown(string Id, string Title, string Text, List<ShownQ> Questions, string SourceName, string SourceUrl, string License, string? Author, int ReadSeconds, int WaitLeft);
    public sealed record Answered(int Index, bool Right, int RightChoice, string Evidence, double Before, double After, int Streak, bool StreakUp, bool Retry, bool Finished);

    public static string Key(string id, int q) => $"{id}#{q}";
    public static string PassageOf(string key) => key.Split('#')[0];
    private static string Day(DateTimeOffset t) => t.LocalDateTime.ToString("yyyy-MM-dd");

    public static double Expected(double rating, double grade) => 1 / (1 + Math.Pow(10, (grade - rating) / Scale));
    public static double K(int answered) => answered < 15 ? 0.8 : 0.4;
    /// <summary>What a child sees: the shared reading level (ReadingLevels) of the text they get about 3 in 4 right.</summary>
    public static int Level(double rating) => ReadingLevels.FromRating(rating);
    /// <summary>The bar towards the next level (0-1).</summary>
    public static double LevelProgress(double rating) => ReadingLevels.RatingProgress(rating);
    /// <summary>Higher ratings lean towards longer paragraphs (with more questions).</summary>
    public static double TargetWords(double rating) => Math.Clamp(60 + 35 * (rating - 2), 60, 230);

    /// <summary>Move an older saved state to the per-question format.</summary>
    public static void Upgrade(QuestState s, DateTimeOffset now)
    {
        foreach (var k in s.Done.Keys.Where(k => !k.Contains('#')).ToList()) { s.Done[Key(k, 0)] = s.Done[k]; s.Done.Remove(k); }
        if (s.Retry is { Count: > 0 }) foreach (var k in s.Retry.Keys) s.Later[Key(k, 0)] = Day(now);
        s.Retry = null;
        if (s.Open is { Qs.Count: 0 } o) { o.Qs.Add(new QuestOpenQ { Index = 0, Order = o.Order ?? new[] { 0, 1, 2, 3 }, IsRetry = o.IsRetry }); o.Order = null; }
    }

    /// <summary>The questions of a paragraph the child may answer today: new ones, and missed ones whose day has come.
    /// A right question is done for good; a question missed twice is retired.</summary>
    public static List<(int Index, bool Retry)> Eligible(QuestState s, QuestLibrary.Passage p, string today)
    {
        var list = new List<(int, bool)>();
        for (var i = 0; i < p.Questions.Count; i++)
        {
            var k = Key(p.Id, i);
            if (!s.Done.TryGetValue(k, out var d)) { list.Add((i, false)); continue; }
            if (d.Right || d.Retried is not null) continue;
            if (!s.Later.TryGetValue(k, out var due) || string.CompareOrdinal(due, today) <= 0) list.Add((i, true));
        }
        return list;
    }

    /// <summary>The next paragraph: the open one while it has questions left, else (taking turns) a paragraph with a
    /// missed question whose day has come, or a new one near the rating (a little above; about a grade below after two
    /// misses in a row). Only paragraphs with a question the child may answer are shown, and only those questions.</summary>
    public static Shown? Next(QuestState s, IReadOnlyList<QuestLibrary.Passage> all, Random rng, string? lastTopic = null, DateTimeOffset? at = null)
    {
        var now = at ?? DateTimeOffset.Now;
        Upgrade(s, now);
        if (s.Open is { } o && all.FirstOrDefault(p => p.Id == o.Id) is { } open && o.Qs.Any(q => !q.Done)) return Show(open, o, now);
        s.Open = null;
        var today = Day(now);
        var ready = all.Select(p => (P: p, Q: Eligible(s, p, today))).Where(x => x.Q.Count > 0).ToList();
        if (ready.Count == 0) return null;
        var retries = ready.Where(x => x.Q.Any(q => q.Retry)).ToList();
        var fresh = ready.Where(x => x.Q.Any(q => !q.Retry)).ToList();
        (QuestLibrary.Passage P, List<(int Index, bool Retry)> Q) pick;
        if (retries.Count > 0 && (!s.LastWasRetry || fresh.Count == 0))
        {
            pick = retries.OrderBy(x => x.Q.Where(q => q.Retry).Min(q => s.Later.GetValueOrDefault(Key(x.P.Id, q.Index)) ?? "")).First();
            s.LastWasRetry = true;
        }
        else
        {
            if (fresh.Count == 0) return null;
            var r = s.Misses >= 2 ? s.Rating - 1 : s.Rating;
            var target = s.Misses >= 2 ? r : r + Stretch;
            var words = TargetWords(r);
            // The closest few (difficulty, and length for the level), then a random one of them, mixing topics.
            var near = fresh.OrderBy(x => Math.Abs(x.P.Grade - target) + Math.Abs(x.P.Words - words) / 120.0).Take(6).ToList();
            var pool = near.Where(x => x.P.Topic != lastTopic).ToList();
            if (pool.Count == 0) pool = near;
            pick = pool[rng.Next(pool.Count)];
            s.LastWasRetry = false;
        }
        s.Open = new QuestOpen { Id = pick.P.Id, OpenedAt = now, Qs = pick.Q.Select(q => new QuestOpenQ { Index = q.Index, Order = Shuffle(rng), IsRetry = q.Retry }).ToList() };
        return Show(pick.P, s.Open, now);
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
        var qs = o.Qs.Where(q => !q.Done).Select(q => new ShownQ(q.Index, p.Questions[q.Index].Q, q.Order.Select(i => p.Questions[q.Index].Choices[i]).ToList(), q.IsRetry)).ToList();
        return new(p.Id, p.Title, p.Text, qs, p.Source.Name, p.Source.Url, p.Source.License, p.Source.Author, secs, left);
    }

    /// <summary>Mark one question of the open paragraph the moment it's answered (any order) and move the rating.</summary>
    public static Answered Answer(QuestState s, QuestLibrary.Passage p, string id, int index, int picked, long readMs, int streakEvery, DateTimeOffset now)
    {
        Upgrade(s, now);
        if (s.Open is not { } o || o.Id != id) throw new InvalidOperationException("That paragraph isn't open any more");
        var oq = o.Qs.FirstOrDefault(q => q.Index == index) ?? throw new InvalidOperationException("That question isn't open");
        if (oq.Done) throw new InvalidOperationException("That question is already answered");
        // Read first: answers before the reading time (less a little slack) aren't accepted.
        if ((now - o.OpenedAt).TotalSeconds < ReadSeconds(p.Words) - 2) throw new InvalidOperationException("Read the paragraph first — the answers open in a few seconds");
        var q = p.Questions[index];
        var rightPos = Array.IndexOf(oq.Order, q.Answer);
        var right = picked == rightPos;
        var first = o.Qs.All(x => !x.Done);
        var ms = Math.Clamp(readMs - o.LastMs, 0, 30 * 60_000);
        o.LastMs = Math.Max(o.LastMs, readMs);
        oq.Done = true;
        var finished = o.Qs.All(x => x.Done);
        if (finished) s.Open = null;
        var k = Key(id, index);
        if (oq.IsRetry)
        {
            // A second look: the result is kept for parents, but it pays nothing and moves neither rating nor streak.
            if (s.Done.TryGetValue(k, out var d)) d.Retried = right;
            s.Later.Remove(k);
            return new Answered(index, right, rightPos, q.Evidence, s.Rating, s.Rating, s.Streak, false, true, finished);
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
        s.Done[k] = new QuestDone { Right = right, At = now, Grade = p.Grade, Type = q.Type, Ms = ms, Words = first ? p.Words : 0, RatingBefore = before };
        // A missed question comes back no sooner than tomorrow (by itself; the right ones never come back).
        if (!right) s.Later[k] = Day(now.AddDays(1));
        s.History[Day(now)] = Math.Round(s.Rating, 2);
        if (s.History.Count > 400) foreach (var h in s.History.Keys.OrderBy(h => h).Take(s.History.Count - 400).ToList()) s.History.Remove(h);
        return new Answered(index, right, rightPos, q.Evidence, before, s.Rating, s.Streak, up, false, finished);
    }

    /// <summary>Coins for a right answer: 1 per 100 words of the paragraph, shared between its questions (rounded up,
    /// at least 1), times the parent's setting.</summary>
    public static int Pay(int words, int questions, int perUnit) => Math.Max(1, (int)Math.Ceiling(words / (double)Math.Max(1, questions) / 100.0)) * perUnit;

    /// <summary>Questions never answered yet (the parents' "left").</summary>
    public static int Left(QuestState s, IReadOnlyList<QuestLibrary.Passage> all) => all.Sum(p => Enumerable.Range(0, p.Questions.Count).Count(i => !s.Done.ContainsKey(Key(p.Id, i))));

    /// <summary>The parents' view: rating and its trend, accuracy by question type and by difficulty, recent paragraphs.</summary>
    public static JsonObject Report(QuestState s, QuestLibrary lib, DateTimeOffset now)
    {
        Upgrade(s, now);
        var done = s.Done.Select(kv => (Id: PassageOf(kv.Key), D: kv.Value)).OrderByDescending(x => x.D.At).ToList();
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
        var speeds = done.Where(x => x.D.Ms > 3000 && x.D.Words > 0).Select(x => x.D.Words / (x.D.Ms / 60000.0)).Where(w => w is >= 20 and <= 600).OrderBy(w => w).ToList();
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
                    ["at"] = x.D.At.LocalDateTime.ToString("yyyy-MM-dd"), ["title"] = p?.Title ?? x.Id, ["grade"] = Math.Round(x.D.Grade, 1), ["type"] = x.D.Type, ["right"] = x.D.Right,
                    ["source"] = p?.Source.Name, ["url"] = p?.Source.Url,
                };
            }).ToArray()),
            ["pool"] = lib.All().Sum(p => p.Questions.Count), ["left"] = Left(s, lib.All()),
        };
    }
}
