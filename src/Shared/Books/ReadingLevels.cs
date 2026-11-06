namespace CoinQuest.Shared.Books;

/// <summary>
/// One reading-level scale for Books and Reading Quest, so "Level 4" means the same thing in both places.
/// A level is a band of grade-equivalent difficulty: Level 1 below grade 2, then Level N = grade N to N+1.
/// <list type="bullet">
/// <item>Books: the published ATOS book level (Renaissance; see content/books/README.md). A few books without one are
/// placed by hand next to similar books.</item>
/// <item>Reading Quest paragraphs: their readability grade (content/passages/README.md).</item>
/// <item>A child's Reading Quest level: the level of text they get about 3 in 4 right. Their rating is the difficulty
/// they get right half the time (ReadingQuest.Expected = 0.5); one grade easier they get 76% (p = 1/(1+10^-0.5)), close
/// to the books' 70% quiz pass mark. So a child at Quest Level 4 is ready for Level 4 books.</item>
/// </list>
/// Children only ever see the number; parents see the grades behind it (Reading analysis).
/// </summary>
public static class ReadingLevels
{
    /// <summary>The level of a text from its grade-equivalent difficulty.</summary>
    public static int FromGrade(double grade) => Math.Max(1, (int)Math.Floor(grade));

    /// <summary>A child's level from their Reading Quest rating (the text they get about 3 in 4 right).</summary>
    public static int FromRating(double rating) => FromGrade(rating - 1);

    /// <summary>How far through their level a child's rating is (0-1), for the bar.</summary>
    public static double RatingProgress(double rating) =>
        rating < 3 ? Math.Clamp(rating / 3, 0, 1) : (rating - 1) - Math.Floor(rating - 1);
}
