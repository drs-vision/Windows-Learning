using CoinQuest.Shared.Books;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class ReadingReportTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 6, 18, 0, 0, TimeSpan.Zero);
    private static int _n;

    private static ReadingReport.Entry E(int level, int correct, int total, int daysAgo = 1, int tries = 1, int? wpm = null) =>
        new("b" + level, "Book " + level, ++_n, "Ch", false, level, 2000, 6.0, null, null, correct, total, tries, correct * 10 >= total * 7, Now.AddDays(-daysAgo), wpm, wpm is null ? 0 : 2000 * 60000L / wpm.Value);

    [Fact]
    public void Comfortable_level_needs_three_strong_first_tries()
    {
        var list = new List<ReadingReport.Entry> { E(3, 8, 8), E(3, 7, 8), E(3, 8, 10), E(4, 8, 8), E(4, 8, 8) };
        Assert.Equal(3, ReadingReport.ComfortableLevel(list)); // two strong at 4 isn't enough
        list.Add(E(4, 9, 10));
        Assert.Equal(4, ReadingReport.ComfortableLevel(list));
    }

    [Fact]
    public void A_hard_miss_or_an_easy_perfect_score_does_not_move_it()
    {
        var list = new List<ReadingReport.Entry> { E(4, 8, 8), E(4, 9, 10), E(4, 8, 10) };
        list.Add(E(5, 3, 10)); // a miss at a harder level
        list.Add(E(1, 4, 4));  // a perfect easy story
        Assert.Equal(4, ReadingReport.ComfortableLevel(list));
        var r = ReadingReport.Build(list, Now);
        Assert.Equal(1, r["stretch"]!["chapters"]!.GetValue<int>());
        Assert.Equal(30, r["stretch"]!["firstTry"]!.GetValue<int>());
    }

    [Fact]
    public void Only_the_first_try_counts_and_speed_is_the_median()
    {
        // Passed on a retake: complete, but the 50% first try is what shows.
        var list = new List<ReadingReport.Entry> { E(3, 5, 10, tries: 2, wpm: 120), E(3, 8, 8, wpm: 150), E(3, 9, 10, wpm: 400) };
        var r = ReadingReport.Build(list, Now);
        Assert.Equal(79, r["firstTry30"]!.GetValue<int>()); // (5+8+9)/(10+8+10)
        Assert.Equal(150, r["wpm"]!.GetValue<int>());
        Assert.Equal(0, r["comfortable"]!.GetValue<int>()); // only 2 strong at level 3
        Assert.Equal("hard", r["recent"]!.AsArray().First(x => x!["tries"]!.GetValue<int>() == 2)!["status"]!.GetValue<string>());
    }

    [Fact]
    public void Old_reading_still_counts_when_there_is_little_recent()
    {
        var list = new List<ReadingReport.Entry> { E(2, 8, 8, 200), E(2, 8, 8, 200), E(2, 8, 8, 200), E(3, 4, 8, 2) };
        Assert.Equal(2, ReadingReport.Build(list, Now)["comfortable"]!.GetValue<int>());
    }
}
