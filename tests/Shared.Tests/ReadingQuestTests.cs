using CoinQuest.Shared.Books;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class ReadingQuestTests
{
    private static DateTimeOffset Clock = new(2026, 11, 6, 15, 0, 0, TimeSpan.Zero);

    private static QuestLibrary.QuestQuestion Q(string type = "detail") =>
        new(type, "Q?", new() { "right", "b", "c", "d" }, 0, "Text", "Because.");

    private static QuestLibrary.Passage P(string id, double grade, string topic = "animals", int words = 60, int questions = 1) =>
        new(id, id, "facts", topic, "Text.", grade, words, new QuestLibrary.Source("Src", "https://example.gov", "Public domain"),
            Enumerable.Range(0, questions).Select(i => Q()).ToList());

    /// <summary>Open the next paragraph and answer all its questions (right or wrong).</summary>
    private static List<ReadingQuest.Answered> Do(QuestState s, List<QuestLibrary.Passage> all, bool right, Random rng)
    {
        var shown = ReadingQuest.Next(s, all, rng, null, Clock)!;
        var p = all.First(x => x.Id == shown.Id);
        Clock = Clock.AddSeconds(40);
        return shown.Questions.Select(q =>
        {
            var pick = right ? q.Choices.IndexOf("right") : (q.Choices.IndexOf("right") + 1) % 4;
            return ReadingQuest.Answer(s, p, shown.Id, q.Index, pick, 20000, 5, Clock);
        }).ToList();
    }

    [Fact]
    public void Rating_goes_up_on_right_and_down_on_wrong_and_paragraphs_follow_it()
    {
        var all = Enumerable.Range(0, 80).Select(i => P($"p{i}", i / 10.0)).ToList(); // grades 0.0 .. 7.9
        var s = new QuestState(); var rng = new Random(3);
        for (var i = 0; i < 12; i++) Do(s, all, true, rng);
        Assert.True(s.Rating > 3, $"rating {s.Rating}");
        var next = ReadingQuest.Next(s, all, rng, null, Clock)!;
        Assert.InRange(all.First(x => x.Id == next.Id).Grade, s.Rating - 1, s.Rating + 1.5);
        var before = s.Rating;
        s.Open = null;
        for (var i = 0; i < 4; i++) Do(s, all, false, rng);
        Assert.True(s.Rating < before);
    }

    [Fact]
    public void Levels_are_one_scale_with_books()
    {
        // Books: the ATOS level's whole number. A child: the level they get about 3 in 4 right (one grade under the rating).
        Assert.Equal((1, 1, 4, 4), (ReadingLevels.FromGrade(0.4), ReadingLevels.FromGrade(1.9), ReadingLevels.FromGrade(4.2), ReadingLevels.FromGrade(4.99)));
        Assert.Equal((1, 1, 2, 4), (ReadingQuest.Level(1.0), ReadingQuest.Level(2.9), ReadingQuest.Level(3.2), ReadingQuest.Level(5.5)));
        Assert.InRange(ReadingQuest.Expected(5.2, 4.2), 0.7, 0.8); // Level 4 text for a Level 4 child: about 3 in 4
        Assert.InRange(ReadingQuest.LevelProgress(1.5), 0.49, 0.51);
        Assert.InRange(ReadingQuest.LevelProgress(4.25), 0.24, 0.26);
    }

    [Fact]
    public void A_miss_on_an_easy_paragraph_costs_more_than_on_a_hard_one()
    {
        var easy = ReadingQuest.Expected(4, 2); var hard = ReadingQuest.Expected(4, 6);
        Assert.True(easy > 0.8 && hard < 0.2);
        Assert.True(ReadingQuest.K(20) * easy > ReadingQuest.K(20) * hard); // the drop on a miss is K * p
    }

    [Fact]
    public void Streak_steps_every_five_and_resets_on_a_miss_and_each_question_is_once()
    {
        var all = Enumerable.Range(0, 30).Select(i => P($"p{i}", 1)).ToList();
        var s = new QuestState(); var rng = new Random(1);
        var ups = 0;
        for (var i = 0; i < 10; i++) if (Do(s, all, true, rng).Single().StreakUp) ups++;
        Assert.Equal((10, 2), (s.Streak, ups));
        Do(s, all, false, rng);
        Assert.Equal((0, 10), (s.Streak, s.BestStreak));
        Assert.Equal(11, s.Done.Count);
    }

    [Fact]
    public void An_open_paragraph_comes_back_the_same_and_pay_scales_with_length()
    {
        var all = Enumerable.Range(0, 10).Select(i => P($"p{i}", 1)).ToList();
        var s = new QuestState(); var rng = new Random(9);
        var a = ReadingQuest.Next(s, all, rng, null, Clock)!; var b = ReadingQuest.Next(s, all, rng, null, Clock)!;
        Assert.Equal((a.Id, string.Join("|", a.Questions[0].Choices)), (b.Id, string.Join("|", b.Questions[0].Choices)));
        // 1 coin per 100 words, shared by the paragraph's questions.
        Assert.Equal((1, 2, 2, 1, 1), (ReadingQuest.Pay(40, 1, 1), ReadingQuest.Pay(120, 1, 1), ReadingQuest.Pay(60, 1, 2), ReadingQuest.Pay(180, 2, 1), ReadingQuest.Pay(260, 3, 1)));
    }

    [Fact]
    public void Each_question_counts_the_moment_it_is_answered_in_any_order()
    {
        var all = new List<QuestLibrary.Passage> { P("long", 3, words: 180, questions: 2) };
        var s = new QuestState(); var rng = new Random(4);
        var shown = ReadingQuest.Next(s, all, rng, null, Clock)!;
        Assert.Equal(2, shown.Questions.Count);
        Clock = Clock.AddSeconds(40);
        var second = shown.Questions[1];
        var r = ReadingQuest.Answer(s, all[0], "long", 1, second.Choices.IndexOf("right"), 20000, 2, Clock);
        Assert.True(r.Right && !r.Finished && s.Streak == 1 && s.Answered == 1);
        Assert.Throws<InvalidOperationException>(() => ReadingQuest.Answer(s, all[0], "long", 1, 0, 21000, 2, Clock));
        // Leaving and coming back shows only the question that's left.
        var again = ReadingQuest.Next(s, all, rng, null, Clock)!;
        Assert.Equal(new[] { 0 }, again.Questions.Select(q => q.Index));
        var last = ReadingQuest.Answer(s, all[0], "long", 0, again.Questions[0].Choices.IndexOf("right"), 30000, 2, Clock);
        Assert.True(last.Finished && last.StreakUp);
        Assert.Null(s.Open);
        Assert.Equal(20000, s.Done["long#1"].Ms);
        Assert.Equal(10000, s.Done["long#0"].Ms); // each question's time counted once
    }

    [Fact]
    public void Answers_wait_for_the_reading_time()
    {
        var all = new List<QuestLibrary.Passage> { P("a", 1, words: 100) };
        var s = new QuestState(); var t0 = Clock;
        var shown = ReadingQuest.Next(s, all, new Random(1), null, t0)!;
        Assert.Equal(25, shown.ReadSeconds);
        Assert.Throws<InvalidOperationException>(() => ReadingQuest.Answer(s, all[0], "a", 0, 0, 0, 5, t0.AddSeconds(10)));
        Assert.Equal(15, ReadingQuest.Next(s, all, new Random(1), null, t0.AddSeconds(10))!.WaitLeft); // reopening doesn't restart it
        ReadingQuest.Answer(s, all[0], "a", 0, 0, 0, 5, t0.AddSeconds(26));
    }

    [Fact]
    public void A_missed_question_comes_back_alone_no_sooner_than_tomorrow_without_pay_or_rating()
    {
        var all = new List<QuestLibrary.Passage> { P("two", 2, words: 150, questions: 2) };
        all.AddRange(Enumerable.Range(0, 10).Select(i => P($"p{i}", 2, "t" + i)));
        var s = new QuestState(); var rng = new Random(5);
        s.Rating = 2; s.Answered = 30;
        // Open "two" directly: right on question 0, wrong on question 1.
        ReadingQuest.Upgrade(s, Clock);
        s.Open = new QuestOpen { Id = "two", OpenedAt = Clock, Qs = { new QuestOpenQ { Index = 0 }, new QuestOpenQ { Index = 1 } } };
        Clock = Clock.AddSeconds(40);
        ReadingQuest.Answer(s, all[0], "two", 0, 0, 20000, 5, Clock);
        ReadingQuest.Answer(s, all[0], "two", 1, 1, 30000, 5, Clock);
        // Not again today, however many paragraphs he reads.
        for (var i = 0; i < 8; i++) Assert.NotEqual("two", ReadingQuest.Next(s, all, rng, null, Clock)!.Id.Also(_ => s.Open = null));
        // Tomorrow it's back with only the missed question.
        var tomorrow = Clock.AddDays(1);
        var back = ReadingQuest.Next(s, all, rng, null, tomorrow)!;
        Assert.Equal("two", back.Id);
        Assert.Equal(new[] { 1 }, back.Questions.Select(q => q.Index));
        Assert.True(back.Questions[0].Retry);
        var (rating, streak) = (s.Rating, s.Streak);
        var r = ReadingQuest.Answer(s, all[0], "two", 1, back.Questions[0].Choices.IndexOf("right"), 20000, 5, tomorrow.AddSeconds(40));
        Assert.True(r.Retry && r.Right);
        Assert.Equal((rating, streak), (s.Rating, s.Streak));
        Assert.True(s.Done["two#1"].Retried);
        Assert.Empty(s.Later);
        // Nothing left to answer in it: it's never shown again.
        Assert.Empty(ReadingQuest.Eligible(s, all[0], "2099-01-01"));
    }

    [Fact]
    public void An_old_saved_state_moves_to_per_question_keys()
    {
        var s = new QuestState { Retry = new() { ["p1"] = 3 }, Open = new QuestOpen { Id = "p2", Order = new[] { 3, 2, 1, 0 }, IsRetry = false } };
        s.Done["p1"] = new QuestDone { Right = false };
        ReadingQuest.Upgrade(s, Clock);
        Assert.True(s.Done.ContainsKey("p1#0"));
        Assert.True(s.Later.ContainsKey("p1#0"));
        Assert.Null(s.Retry);
        Assert.Equal(new[] { 3, 2, 1, 0 }, s.Open!.Qs.Single().Order);
    }
}

internal static class TestExt
{
    public static T Also<T>(this T x, Action<T> f) { f(x); return x; }
}
