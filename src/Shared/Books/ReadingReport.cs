using System.Text.Json.Nodes;

namespace CoinQuest.Shared.Books;

/// <summary>
/// The parents' reading analysis, from a child's chapter progress. Simple, fixed rules (no AI, nothing learned), so
/// the same history always gives the same numbers and a parent can check them by hand:
/// <list type="bullet">
/// <item><b>Chapters read</b>: every chapter read to the end after a believable time (BookLibrary.ReadEnough), quiz or
/// not (quizzes are optional), broken down by level. Ability numbers below use only chapters with a quiz.</item>
/// <item>Only the <b>first try</b> at a chapter's quiz counts toward ability. Retakes complete a chapter (and pay) but
/// don't change the picture; failures aren't shown on the main screen.</item>
/// <item><b>Comfortable level</b>: the highest level with at least <see cref="StrongNeeded"/> chapters scoring
/// <see cref="StrongPercent"/>% or better on the first try, over the last <see cref="WindowDays"/> days (all time if
/// there's too little recent reading). One great chapter at a hard level doesn't set it; a miss at a hard level or a
/// perfect score at an easy one doesn't move it.</item>
/// <item><b>Stretch</b>: chapters above the comfortable level, with their first-try score.</item>
/// <item>Each chapter's result: 80%+ "comfortable", 60-79% "good challenge", under 60% "hard for now".</item>
/// <item><b>Reading speed</b> (an estimate): chapter words ÷ the minutes the chapter was on screen and in use until it
/// was first read to the end (time with the window in the background or no mouse/keyboard for a while isn't counted).
/// The median over the last 30 days (all time if none), so one distracted or skimmed chapter doesn't skew it; speeds
/// under 40 or over 600 words a minute are left out. Its middle half (25th-75th percentile) is shown as the range.</item>
/// </list>
/// Book difficulty comes from published measures (ATOS book level, Lexile) and readability formulas on the text,
/// all stored in each book.json; they are context for parents and never change how a child is paid.
/// </summary>
public static class ReadingReport
{
    public const int StrongPercent = 80, StrongNeeded = 3, WindowDays = 90;

    public sealed record Entry(string BookId, string Book, int Chapter, string ChapterTitle, bool OneStory, int Level, int Words,
        double? Formula, double? Atos, int? Lexile, int Correct, int Total, int Attempts, bool Passed, DateTimeOffset At, int? Wpm, long ReadMs, bool Read = true)
    {
        public bool Quizzed => Total > 0;
        public int Percent => Total == 0 ? 0 : (int)Math.Round(100.0 * Correct / Total);
        public string Status => Percent >= StrongPercent ? "comfortable" : Percent >= 60 ? "challenge" : "hard";
    }

    /// <summary>The chapters a child has read or taken a quiz on, from their progress ("bookId/n" → progress).</summary>
    public static List<Entry> Entries(BookLibrary lib, IEnumerable<KeyValuePair<string, ChapterProgress>> progress)
    {
        var list = new List<Entry>();
        foreach (var (key, p) in progress)
        {
            var slash = key.LastIndexOf('/');
            var read = p.ReadAt is not null || p.Passed;
            if (slash < 0 || (p.FirstTotal <= 0 && !read) || !int.TryParse(key[(slash + 1)..], out var n)) continue;
            var book = lib.Find(key[..slash]);
            var ch = book?.Chapters.FirstOrDefault(c => c.N == n);
            if (book is null || ch is null) continue;
            var at = p.ReadAt ?? p.FirstAt ?? p.PassedAt;
            if (at is null) continue;
            int? wpm = null;
            if (p.ReadMs > 0 && (p.ReadAt is not null || p.Attempts > 0)) { var w = ch.Words / (p.ReadMs / 60000.0); if (w is >= 40 and <= 600) wpm = (int)Math.Round(w); }
            list.Add(new Entry(book.Id, book.Title, n, ch.Title, book.Chapters.Count == 1, book.Level, ch.Words,
                ch.Readability?.Grade, book.Measures?.Atos?.Level, book.Measures?.Lexile?.Value,
                p.FirstCorrect, p.FirstTotal, p.Attempts, p.Passed, at.Value, wpm, p.ReadMs, read));
        }
        return list.OrderByDescending(e => e.At).ToList();
    }

    /// <summary>Highest level with enough strong first tries (0 = not yet), from the given entries.</summary>
    public static int ComfortableLevel(IEnumerable<Entry> entries) =>
        entries.Where(e => e.Quizzed && e.Percent >= StrongPercent).GroupBy(e => e.Level).Where(g => g.Count() >= StrongNeeded).Select(g => g.Key).DefaultIfEmpty(0).Max();

    private static int? Median(IEnumerable<int> xs) { var l = xs.OrderBy(x => x).ToList(); return l.Count == 0 ? null : l[l.Count / 2]; }
    private static int? Quantile(IEnumerable<int> xs, double q) { var l = xs.OrderBy(x => x).ToList(); return l.Count == 0 ? null : l[(int)Math.Floor((l.Count - 1) * q)]; }
    private static double? MedianD(IEnumerable<double> xs) { var l = xs.OrderBy(x => x).ToList(); return l.Count == 0 ? null : l[l.Count / 2]; }
    private static int? Pct(IEnumerable<Entry> es) { var t = es.Sum(e => e.Total); return t == 0 ? null : (int)Math.Round(100.0 * es.Sum(e => e.Correct) / t); }

    public static JsonObject Build(List<Entry> entries, DateTimeOffset now)
    {
        var everything = entries.OrderByDescending(e => e.At).ToList(); // newest first
        var readList = everything.Where(e => e.Read).ToList();
        var all = everything.Where(e => e.Quizzed).ToList(); // ability: chapters with a quiz
        var recent = all.Where(e => e.At >= now.AddDays(-WindowDays)).ToList();
        var basis = recent.Count(e => e.Percent >= StrongPercent) >= StrongNeeded ? recent : all;
        var level = ComfortableLevel(basis);
        var strongAtLevel = basis.Where(e => e.Level == level && e.Percent >= StrongPercent).ToList();
        var stretch = basis.Where(e => e.Level > level).ToList();
        var quizMonth = all.Where(e => e.At >= now.AddDays(-30)).ToList();

        var monday = now.Date.AddDays(-(((int)now.DayOfWeek + 6) % 7));
        var weeks = new JsonArray();
        for (var i = 11; i >= 0; i--)
        {
            var start = monday.AddDays(-7 * i); var end = start.AddDays(7);
            var w = everything.Where(e => e.At.LocalDateTime >= start && e.At.LocalDateTime < end).ToList();
            weeks.Add(new JsonObject { ["start"] = start.ToString("yyyy-MM-dd"), ["chapters"] = w.Count(e => e.Read), ["firstTry"] = Pct(w.Where(e => e.Quizzed)), ["wpm"] = Median(w.Where(e => e.Wpm is not null).Select(e => e.Wpm!.Value)) });
        }

        var levels = new JsonArray();
        // Every level he has read at: chapters read, words, how many had a quiz, first-try score, typical speed.
        foreach (var g in everything.GroupBy(e => e.Level).OrderBy(g => g.Key))
            levels.Add(new JsonObject
            {
                ["level"] = g.Key, ["read"] = g.Count(e => e.Read), ["words"] = g.Where(e => e.Read).Sum(e => e.Words),
                ["chapters"] = g.Count(e => e.Quizzed), ["strong"] = g.Count(e => e.Quizzed && e.Percent >= StrongPercent), ["firstTry"] = Pct(g.Where(e => e.Quizzed)),
                ["wpm"] = Median(g.Where(e => e.Wpm is not null).Select(e => e.Wpm!.Value)),
            });

        JsonObject Row(Entry e) => new()
        {
            ["at"] = e.At.LocalDateTime.ToString("yyyy-MM-dd"), ["book"] = e.Book, ["chapter"] = e.OneStory ? null : e.Chapter, ["title"] = e.ChapterTitle,
            ["level"] = e.Level, ["formula"] = e.Formula, ["atos"] = e.Atos, ["lexile"] = e.Lexile,
            ["read"] = e.Read, ["quizzed"] = e.Quizzed,
            ["firstTry"] = e.Quizzed ? e.Percent : null, ["correct"] = e.Correct, ["total"] = e.Total, ["tries"] = e.Attempts, ["passed"] = e.Passed, ["wpm"] = e.Wpm, ["status"] = e.Quizzed ? e.Status : "read",
        };
        var month = everything.Where(e => e.At >= now.AddDays(-30)).ToList();
        var speedBasis = (month.Any(e => e.Wpm is not null) ? month : everything).Where(e => e.Wpm is not null).Select(e => e.Wpm!.Value).ToList();

        return new JsonObject
        {
            ["comfortable"] = level,
            ["comfortableAtos"] = MedianD(strongAtLevel.Where(e => e.Atos is not null).Select(e => e.Atos!.Value)),
            ["comfortableLexile"] = Median(strongAtLevel.Where(e => e.Lexile is not null).Select(e => e.Lexile!.Value)),
            ["comfortableFormula"] = MedianD(strongAtLevel.Where(e => e.Formula is not null).Select(e => e.Formula!.Value)),
            ["current"] = readList.FirstOrDefault()?.Level ?? all.FirstOrDefault()?.Level,
            ["stretch"] = new JsonObject { ["chapters"] = stretch.Count, ["firstTry"] = Pct(stretch), ["level"] = stretch.Select(e => e.Level).DefaultIfEmpty(0).Max() },
            ["firstTry30"] = Pct(quizMonth),
            ["firstTryAll"] = Pct(all),
            ["chapters30"] = quizMonth.Count,
            ["chaptersRead"] = readList.Count,
            ["chaptersRead30"] = month.Count(e => e.Read),
            ["chaptersQuizzed"] = all.Count,
            ["wpm"] = Median(speedBasis),
            ["wpmLow"] = Quantile(speedBasis, 0.25), ["wpmHigh"] = Quantile(speedBasis, 0.75), ["wpmChapters"] = speedBasis.Count,
            ["chaptersPassed"] = all.Count(e => e.Passed),
            ["wordsRead"] = readList.Sum(e => e.Words),
            ["minutesReading"] = (int)Math.Round(everything.Sum(e => e.ReadMs) / 60000.0),
            ["windowDays"] = WindowDays, ["strongPercent"] = StrongPercent, ["strongNeeded"] = StrongNeeded,
            ["levels"] = levels,
            ["weeks"] = weeks,
            ["recent"] = new JsonArray(everything.Take(15).Select(e => (JsonNode)Row(e)).ToArray()),
        };
    }
}
