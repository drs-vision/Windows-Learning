using CoinQuest.Shared.Books;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class ReadingQuestTests
{
    private static DateTimeOffset Clock = DateTimeOffset.Now;
    private static QuestLibrary.Passage P(string id, double grade, string topic = "animals", int words = 60) =>
        new(id, id, "facts", topic, "Text.", grade, words, new QuestLibrary.Source("Src", "https://example.gov", "Public domain"),
            new QuestLibrary.QuestQuestion("detail", "Q?", new() { "right", "b", "c", "d" }, 0, "Text", "Because."));

    private static (bool right, ReadingQuest.Answered a) Do(QuestState s, List<QuestLibrary.Passage> all, bool right, Random rng)
    {
        var shown = ReadingQuest.Next(s, all, rng, null, Clock)!;
        var p = all.First(x => x.Id == shown.Id);
        var pick = right ? shown.Choices.IndexOf("right") : (shown.Choices.IndexOf("right") + 1) % 4;
        Clock = Clock.AddSeconds(40);
        return (right, ReadingQuest.Answer(s, p, shown.Id, pick, 20000, 5, Clock));
    }

    [Fact]
    public void Rating_goes_up_on_right_and_down_on_wrong_and_paragraphs_follow_it()
    {
        var all = Enumerable.Range(0, 80).Select(i => P($"p{i}", i / 10.0)).ToList(); // grades 0.0 .. 7.9
        var s = new QuestState(); var rng = new Random(3);
        for (var i = 0; i < 12; i++) Do(s, all, true, rng);
        Assert.True(s.Rating > 3, $"rating {s.Rating}");
        var next = ReadingQuest.Next(s, all, rng)!;
        Assert.InRange(all.First(x => x.Id == next.Id).Grade, s.Rating - 1, s.Rating + 1.5);
        var before = s.Rating;
        s.Open = null;
        for (var i = 0; i < 4; i++) Do(s, all, false, rng);
        Assert.True(s.Rating < before);
    }

    [Fact]
    public void A_miss_on_an_easy_paragraph_costs_more_than_on_a_hard_one()
    {
        var easy = ReadingQuest.Expected(4, 2); var hard = ReadingQuest.Expected(4, 6);
        Assert.True(easy > 0.8 && hard < 0.2);
        Assert.True(ReadingQuest.K(20) * easy > ReadingQuest.K(20) * hard); // the drop on a miss is K * p
    }

    [Fact]
    public void Streak_steps_every_five_and_resets_on_a_miss_and_each_paragraph_is_once()
    {
        var all = Enumerable.Range(0, 30).Select(i => P($"p{i}", 1)).ToList();
        var s = new QuestState(); var rng = new Random(1);
        var ups = 0;
        for (var i = 0; i < 10; i++) if (Do(s, all, true, rng).a.StreakUp) ups++;
        Assert.Equal((10, 2), (s.Streak, ups));
        Do(s, all, false, rng);
        Assert.Equal((0, 10), (s.Streak, s.BestStreak));
        Assert.Equal(11, s.Done.Count);
        Assert.Equal(11, s.Done.Keys.Distinct().Count());
    }

    [Fact]
    public void An_open_paragraph_comes_back_the_same_and_pay_scales_with_length()
    {
        var all = Enumerable.Range(0, 10).Select(i => P($"p{i}", 1)).ToList();
        var s = new QuestState(); var rng = new Random(9);
        var a = ReadingQuest.Next(s, all, rng)!; var b = ReadingQuest.Next(s, all, rng)!;
        Assert.Equal((a.Id, string.Join("|", a.Choices)), (b.Id, string.Join("|", b.Choices)));
        Assert.Equal((1, 2, 2), (ReadingQuest.Pay(40, 1), ReadingQuest.Pay(120, 1), ReadingQuest.Pay(60, 2)));
    }

    [Fact]
    public void Two_misses_in_a_row_bring_an_easier_paragraph()
    {
        var all = Enumerable.Range(0, 80).Select(i => P($"p{i}", i / 10.0, "t" + i)).ToList();
        var s = new QuestState { Rating = 5, Answered = 30 }; var rng = new Random(2);
        Do(s, all, false, rng); Do(s, all, false, rng);
        var next = ReadingQuest.Next(s, all, rng)!;
        Assert.True(all.First(x => x.Id == next.Id).Grade < s.Rating - 0.4);
    }

    [Fact]
    public void Answers_wait_for_the_reading_time()
    {
        var all = new List<QuestLibrary.Passage> { P("a", 1, words: 100) };
        var s = new QuestState(); var t0 = DateTimeOffset.Now;
        var shown = ReadingQuest.Next(s, all, new Random(1), null, t0)!;
        Assert.Equal(25, shown.ReadSeconds);
        Assert.Throws<InvalidOperationException>(() => ReadingQuest.Answer(s, all[0], "a", 0, 0, 5, t0.AddSeconds(10)));
        Assert.Equal(15, ReadingQuest.Next(s, all, new Random(1), null, t0.AddSeconds(10))!.WaitLeft); // reopening doesn't restart it
        ReadingQuest.Answer(s, all[0], "a", 0, 0, 5, t0.AddSeconds(26));
    }

    [Fact]
    public void A_missed_paragraph_comes_back_later_without_pay_or_rating()
    {
        var all = Enumerable.Range(0, 20).Select(i => P($"p{i}", 1, "t" + i)).ToList();
        var s = new QuestState(); var rng = new Random(5);
        var (_, miss) = Do(s, all, false, rng);
        var missed = s.Done.Single().Key;
        var seen = new List<string>();
        for (var i = 0; i < ReadingQuest.RetryAfter; i++) { Do(s, all, true, rng); seen.Add(s.Done.Keys.Last()); }
        Assert.DoesNotContain(missed, seen);
        var back = ReadingQuest.Next(s, all, rng, null, Clock)!;
        Assert.True(back.Retry);
        Assert.Equal(missed, back.Id);
        var (rating, streak) = (s.Rating, s.Streak);
        Clock = Clock.AddSeconds(40);
        var r = ReadingQuest.Answer(s, all.First(x => x.Id == missed), missed, back.Choices.IndexOf("right"), 0, 5, Clock);
        Assert.True(r.Retry && r.Right);
        Assert.Equal((rating, streak), (s.Rating, s.Streak));
        Assert.True(s.Done[missed].Retried);
        Assert.Empty(s.Retry);
    }
}
