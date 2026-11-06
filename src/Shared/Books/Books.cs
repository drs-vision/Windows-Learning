using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace CoinQuest.Shared.Books;

/// <summary>
/// The Reading quest's books (content/books, format in content/books/README.md) and its quiz rules:
/// a quiz of <see cref="QuizSize"/> questions drawn from the chapter's bank (unseen ones first), answers shuffled every
/// time, 70% to pass, a wait before a retake, coins per correct answer on the passing attempt, then bonus questions.
/// The answers never leave this class: the child's screen only gets questions and shuffled choices.
/// </summary>
public sealed class BookLibrary
{
    public sealed record Grade(int Min, int Max, string Label);
    public sealed record ChapterInfo(int N, string Title, string Text, string Questions, int Words);
    public sealed record Book(string Id, string Title, string Author, int Published, Grade Grade, string Summary, List<ChapterInfo> Chapters);
    public sealed record Question(string Id, string Type, string Q, List<string> Choices, int Answer, string Evidence);

    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };
    private readonly string _root;
    private readonly object _gate = new();
    private Dictionary<string, Book>? _books;
    private readonly Dictionary<string, List<Question>> _questions = new();
    private readonly Dictionary<string, string> _texts = new();

    public BookLibrary(string root) => _root = root;

    public IReadOnlyList<Book> Books()
    {
        lock (_gate)
        {
            if (_books is null)
            {
                _books = new();
                if (Directory.Exists(_root))
                    foreach (var dir in Directory.EnumerateDirectories(_root))
                    {
                        var f = Path.Combine(dir, "book.json");
                        if (!File.Exists(f)) continue;
                        try
                        {
                            var b = JsonSerializer.Deserialize<Book>(File.ReadAllText(f), Json);
                            if (b is { Id.Length: > 0 }) _books[b.Id] = b;
                        }
                        catch { /* a broken book is left out; the validator reports it */ }
                    }
            }
            return _books.Values.OrderBy(b => b.Grade.Min).ThenBy(b => b.Grade.Max).ThenBy(b => b.Title).ToList();
        }
    }

    public Book? Find(string id) { Books(); lock (_gate) return _books!.GetValueOrDefault(id); }

    public ChapterInfo Chapter(string bookId, int n) =>
        Find(bookId)?.Chapters.FirstOrDefault(c => c.N == n) ?? throw new ArgumentException("That chapter isn't in this book");

    public string Text(string bookId, int n)
    {
        var ch = Chapter(bookId, n);
        var key = bookId + "/" + n;
        lock (_gate)
        {
            if (!_texts.TryGetValue(key, out var t)) _texts[key] = t = File.ReadAllText(Path.Combine(_root, bookId, ch.Text));
            return t;
        }
    }

    public List<Question> Questions(string bookId, int n)
    {
        var ch = Chapter(bookId, n);
        var key = bookId + "/" + n;
        lock (_gate)
        {
            if (_questions.TryGetValue(key, out var q)) return q;
            var f = Path.Combine(_root, bookId, ch.Questions);
            q = new();
            if (File.Exists(f))
            {
                try
                {
                    var node = JsonNode.Parse(File.ReadAllText(f));
                    q = node?["questions"]?.Deserialize<List<Question>>(Json)?.Where(x => x.Choices.Count == 4 && x.Answer is >= 0 and < 4).ToList() ?? new();
                }
                catch { q = new(); }
            }
            _questions[key] = q;
            return q;
        }
    }

    /// <summary>Questions in a quiz: about one per 250 words, 4 to 10 (4 so one miss still passes).</summary>
    public static int QuizSize(int words) => Math.Clamp((int)Math.Round(words / 250.0, MidpointRounding.AwayFromZero), 4, 10);

    /// <summary>
    /// The chapter in parts for typing mode: whole paragraphs, about 150 words each (a long paragraph is its own part).
    /// </summary>
    public List<string> Parts(string bookId, int n)
    {
        var paras = Regex.Split(Text(bookId, n).Replace("\r", "").Trim(), @"\n\s*\n").Select(p => Regex.Replace(p.Trim(), @"\s*\n\s*", " ")).Where(p => p.Length > 0);
        var parts = new List<string>();
        var cur = new List<string>();
        var words = 0;
        foreach (var p in paras)
        {
            var w = p.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
            if (cur.Count > 0 && words + w > 170) { parts.Add(string.Join(" ", cur)); cur.Clear(); words = 0; }
            cur.Add(p); words += w;
        }
        if (cur.Count > 0) parts.Add(string.Join(" ", cur));
        return parts;
    }
}

/// <summary>A child's progress on one chapter (kept with the child's other progress).</summary>
public sealed class ChapterProgress
{
    public bool Passed { get; set; }
    public int Correct { get; set; }
    public int Total { get; set; }
    public int Attempts { get; set; }
    public DateTimeOffset? RetakeAt { get; set; }
    public List<string> Seen { get; set; } = new();
    public List<string> BonusDone { get; set; } = new();
    public List<int> TypedParts { get; set; } = new();
    public OpenQuiz? Quiz { get; set; }
    public OpenQuiz? Bonus { get; set; }
}

/// <summary>A quiz (or bonus question) on the child's screen: which questions, and the order their choices were shown in.</summary>
public sealed class OpenQuiz
{
    public string Id { get; set; } = "";
    public List<string> Qids { get; set; } = new();
    /// <summary>For each question, the original choice index shown in each position.</summary>
    public List<int[]> Orders { get; set; } = new();
    public DateTimeOffset Issued { get; set; }
}

public static class Quiz
{
    public const double PassMark = 0.7;

    public sealed record ShownQuestion(string Id, string Q, List<string> Choices);
    public sealed record Graded(bool Passed, int Correct, int Total, int Percent, DateTimeOffset? RetakeAt, List<Review>? Review);
    /// <summary>After a pass: each question, the child's choice and the right one (positions as shown).</summary>
    public sealed record Review(string Q, List<string> Choices, int Picked, int Right);

    private static ShownQuestion Show(BookLibrary.Question q, int[] order) => new(q.Id, q.Q, order.Select(i => q.Choices[i]).ToList());

    private static int[] Shuffled(Random rng)
    {
        var o = new[] { 0, 1, 2, 3 };
        for (var i = 3; i > 0; i--) { var j = rng.Next(i + 1); (o[i], o[j]) = (o[j], o[i]); }
        return o;
    }

    /// <summary>Start a quiz: questions not seen before first, then a few seen ones; each with its choices shuffled.</summary>
    public static List<ShownQuestion> Start(ChapterProgress p, List<BookLibrary.Question> bank, int size, Random rng, DateTimeOffset now)
    {
        if (bank.Count == 0) throw new InvalidOperationException("This chapter's questions aren't ready yet");
        if (p.Passed) throw new InvalidOperationException("You've already passed this chapter");
        if (p.RetakeAt is { } t && t > now) throw new InvalidOperationException($"You can try again in {Math.Max(1, (int)Math.Ceiling((t - now).TotalMinutes))} minute(s). Read the chapter again while you wait!");
        size = Math.Min(size, bank.Count);
        var unseen = bank.Where(q => !p.Seen.Contains(q.Id)).OrderBy(_ => rng.Next()).ToList();
        var seen = bank.Where(q => p.Seen.Contains(q.Id)).OrderBy(_ => rng.Next()).ToList();
        var pick = unseen.Concat(seen).Take(size).OrderBy(_ => rng.Next()).ToList();
        var quiz = new OpenQuiz { Id = Guid.NewGuid().ToString("N")[..12], Qids = pick.Select(q => q.Id).ToList(), Orders = pick.Select(_ => Shuffled(rng)).ToList(), Issued = now };
        p.Quiz = quiz;
        return pick.Select((q, i) => Show(q, quiz.Orders[i])).ToList();
    }

    /// <summary>The quiz that's open (to show it again after the screen was closed), or null.</summary>
    public static List<ShownQuestion>? Current(ChapterProgress p, List<BookLibrary.Question> bank)
    {
        if (p.Quiz is not { } q) return null;
        var byId = bank.ToDictionary(x => x.Id);
        if (q.Qids.Any(id => !byId.ContainsKey(id))) return null;
        return q.Qids.Select((id, i) => Show(byId[id], q.Orders[i])).ToList();
    }

    /// <summary>
    /// Mark a quiz. <paramref name="answers"/> are the positions the child picked (−1 = skipped); a question the child
    /// flagged as wrong is left out of the score. 70% passes; otherwise a retake waits <paramref name="wait"/>.
    /// </summary>
    public static Graded Grade(ChapterProgress p, List<BookLibrary.Question> bank, string quizId, IReadOnlyList<int> answers, ISet<string> flagged, TimeSpan wait, DateTimeOffset now)
    {
        if (p.Quiz is not { } q || q.Id != quizId) throw new InvalidOperationException("That quiz has already been marked — start it again");
        var byId = bank.ToDictionary(x => x.Id);
        int correct = 0, total = 0;
        var review = new List<Review>();
        for (var i = 0; i < q.Qids.Count; i++)
        {
            if (!byId.TryGetValue(q.Qids[i], out var question)) continue;
            var order = q.Orders[i];
            var right = Array.IndexOf(order, question.Answer);
            var picked = i < answers.Count ? answers[i] : -1;
            if (!p.Seen.Contains(question.Id)) p.Seen.Add(question.Id);
            review.Add(new Review(question.Q, order.Select(k => question.Choices[k]).ToList(), picked, right));
            if (flagged.Contains(question.Id)) continue;
            total++;
            if (picked == right) correct++;
        }
        p.Quiz = null;
        p.Attempts++;
        var pct = total == 0 ? 100 : (int)Math.Round(100.0 * correct / total);
        if (total == 0 || correct >= Math.Ceiling(PassMark * total - 1e-9))
        {
            p.Passed = true; p.Correct = correct; p.Total = total; p.RetakeAt = null;
            return new Graded(true, correct, total, pct, null, review);
        }
        p.RetakeAt = now + wait;
        // No answers on a fail: the retake shares some questions.
        return new Graded(false, correct, total, pct, p.RetakeAt, null);
    }

    /// <summary>After passing: questions the child hasn't seen yet, one at a time.</summary>
    public static int BonusLeft(ChapterProgress p, List<BookLibrary.Question> bank) =>
        p.Passed ? bank.Count(q => !p.Seen.Contains(q.Id) && !p.BonusDone.Contains(q.Id)) : 0;

    public static ShownQuestion? NextBonus(ChapterProgress p, List<BookLibrary.Question> bank, Random rng, DateTimeOffset now)
    {
        if (!p.Passed) throw new InvalidOperationException("Pass the chapter quiz first");
        if (p.Bonus is { Qids.Count: 1 } open && bank.FirstOrDefault(x => x.Id == open.Qids[0]) is { } same) return Show(same, open.Orders[0]);
        var q = bank.Where(x => !p.Seen.Contains(x.Id) && !p.BonusDone.Contains(x.Id)).OrderBy(_ => rng.Next()).FirstOrDefault();
        if (q is null) return null;
        p.Bonus = new OpenQuiz { Id = Guid.NewGuid().ToString("N")[..12], Qids = { q.Id }, Orders = { Shuffled(rng) }, Issued = now };
        return Show(q, p.Bonus.Orders[0]);
    }

    /// <summary>Answer the open bonus question: whether it was right, and where the right answer was.</summary>
    public static (bool Right, int RightPosition) AnswerBonus(ChapterProgress p, List<BookLibrary.Question> bank, string qid, int picked)
    {
        if (p.Bonus is not { } b || b.Qids.Count != 1 || b.Qids[0] != qid) throw new InvalidOperationException("That question isn't open any more");
        var q = bank.FirstOrDefault(x => x.Id == qid) ?? throw new InvalidOperationException("That question isn't in this chapter any more");
        var right = Array.IndexOf(b.Orders[0], q.Answer);
        p.Bonus = null;
        if (!p.BonusDone.Contains(qid)) p.BonusDone.Add(qid);
        if (!p.Seen.Contains(qid)) p.Seen.Add(qid);
        return (picked == right, right);
    }
}
