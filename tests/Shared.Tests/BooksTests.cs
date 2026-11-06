using CoinQuest.Shared.Books;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class BooksTests
{
    private static string BooksRoot()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d is not null && !Directory.Exists(Path.Combine(d.FullName, "content", "books"))) d = d.Parent;
        return Path.Combine(d!.FullName, "content", "books");
    }

    private static List<BookLibrary.Question> Bank(int n) => Enumerable.Range(1, n)
        .Select(i => new BookLibrary.Question($"b-01-{i:00}", "detail", $"Question {i}?", new() { "right", "w1", "w2", "w3" }, 0, "x")).ToList();

    private static List<int> RightAnswers(List<Quiz.ShownQuestion> shown) => shown.Select(s => s.Choices.IndexOf("right")).ToList();

    [Fact]
    public void Library_loads_books_sorted_by_grade()
    {
        var lib = new BookLibrary(BooksRoot());
        var books = lib.Books();
        Assert.Contains(books, b => b.Id == "peter-rabbit");
        Assert.True(books.Zip(books.Skip(1)).All(p => p.First.Grade.Min <= p.Second.Grade.Min));
        Assert.NotEmpty(lib.Questions("peter-rabbit", 1));
        Assert.All(lib.Parts("peter-rabbit", 1), p => Assert.DoesNotContain('\n', p));
    }

    [Theory]
    [InlineData(100, 4)] [InlineData(1000, 4)] [InlineData(2000, 8)] [InlineData(6000, 10)]
    public void Quiz_length_follows_chapter_length(int words, int size) => Assert.Equal(size, BookLibrary.QuizSize(words));

    [Fact]
    public void Shuffles_choices_and_never_sends_the_answer_index()
    {
        var p = new ChapterProgress();
        var shown = Quiz.Start(p, Bank(8), 6, new Random(3), DateTimeOffset.Now);
        Assert.Equal(6, shown.Count);
        Assert.Contains(shown, s => s.Choices[0] != "right"); // not always first
    }

    [Fact]
    public void Failing_waits_then_a_retake_prefers_new_questions()
    {
        var bank = Bank(8); var p = new ChapterProgress(); var now = DateTimeOffset.Now; var rng = new Random(1);
        var first = Quiz.Start(p, bank, 4, rng, now);
        var g = Quiz.Grade(p, bank, p.Quiz!.Id, first.Select(_ => -1).ToList(), new HashSet<string>(), TimeSpan.FromMinutes(10), now);
        Assert.False(g.Passed);
        Assert.Null(g.Review); // no answers on a fail
        Assert.Throws<InvalidOperationException>(() => Quiz.Start(p, bank, 4, rng, now.AddMinutes(5)));
        var second = Quiz.Start(p, bank, 4, rng, now.AddMinutes(10));
        Assert.Empty(second.Select(s => s.Id).Intersect(first.Select(s => s.Id))); // 4 unseen were left
    }

    [Fact]
    public void Seventy_percent_passes_and_bonus_questions_follow()
    {
        var bank = Bank(10); var p = new ChapterProgress(); var now = DateTimeOffset.Now; var rng = new Random(2);
        var shown = Quiz.Start(p, bank, 10, rng, now);
        var answers = RightAnswers(shown);
        for (var i = 0; i < 3; i++) answers[i] = (answers[i] + 1) % 4; // 7 of 10
        var g = Quiz.Grade(p, bank, p.Quiz!.Id, answers, new HashSet<string>(), TimeSpan.FromMinutes(10), now);
        Assert.True(g.Passed);
        Assert.Equal(7, g.Correct);
        Assert.Equal(0, Quiz.BonusLeft(p, bank)); // all 10 were in the quiz
    }

    [Fact]
    public void A_flagged_question_is_left_out_of_the_score()
    {
        var bank = Bank(6); var p = new ChapterProgress(); var now = DateTimeOffset.Now;
        var shown = Quiz.Start(p, bank, 4, new Random(5), now);
        var answers = RightAnswers(shown); answers[0] = (answers[0] + 1) % 4;
        var g = Quiz.Grade(p, bank, p.Quiz!.Id, answers, new HashSet<string> { shown[0].Id }, TimeSpan.FromMinutes(10), now);
        Assert.Equal(3, g.Total);
        Assert.Equal(3, g.Correct);
        Assert.Equal(2, Quiz.BonusLeft(p, bank));
        var b = Quiz.NextBonus(p, bank, new Random(1), now)!;
        var (right, pos) = Quiz.AnswerBonus(p, bank, b.Id, b.Choices.IndexOf("right"));
        Assert.True(right);
        Assert.Equal(b.Choices.IndexOf("right"), pos);
        Assert.Equal(1, Quiz.BonusLeft(p, bank));
    }
}
