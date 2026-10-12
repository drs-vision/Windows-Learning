using System.IO;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;

namespace CoinQuest.Shell;

/// <summary>
/// Earns coins from real work on learning sites, automatically, by watching the site's own replies inside CoinQuest's
/// browser (nothing is changed or sent):
///  • Khan Academy talks to its servers through GraphQL calls named in the URL (/api/internal/graphql/&lt;operation&gt;).
///    A checked answer that comes back correct → "khan:correct"; a finished video → "khan:video"; a finished
///    exercise / quiz / unit test → "khan:done".
///  • Duolingo saves a finished lesson with PUT /&lt;date&gt;/sessions/&lt;id&gt; → "duolingo:lesson"; a finished story
///    with POST stories…/complete → "duolingo:story".
/// Every operation name seen is written once to shell.log so the matching can be tuned if a site renames things.
/// </summary>
public static class LearningObserver
{
    private static readonly HashSet<string> SeenOps = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Regex KhanOp = new(@"/api/internal/(?:_mt/)?graphql/([A-Za-z0-9_]+)", RegexOptions.Compiled);
    private static readonly Regex Correct = new(@"""correct""\s*:\s*true", RegexOptions.Compiled);
    private static readonly Regex VideoDone = new(@"""(?:isVideoComplete|completed|isComplete)""\s*:\s*true", RegexOptions.Compiled);
    // A practice task / quiz / unit test that the reply marks finished.
    private static readonly Regex TaskDone = new(@"""(?:taskComplete|isTaskComplete|taskCompleted|completedTask|isTaskCompleted|practiceTaskComplete)""\s*:\s*true|""(?:taskStatus|status)""\s*:\s*""(?:COMPLETE|COMPLETED|complete|completed)""", RegexOptions.Compiled);
    private static readonly Regex DuoSession = new(@"duolingo\.com/\d{4}-\d{2}-\d{2}/sessions/[A-Za-z0-9_-]+(?:\?|$)", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex DuoStory = new(@"duolingo\.com/api2/stories/[^/]+/complete", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly HashSet<string> Paid = new();

    public static void Attach(CoreWebView2 core, Action<string> raise)
    {
        core.WebResourceResponseReceived += async (_, e) =>
        {
            try
            {
                var uri = e.Request.Uri;
                if (uri.Contains("duolingo.com", StringComparison.OrdinalIgnoreCase)) { Duolingo(e, uri, raise); return; }
                var m = KhanOp.Match(uri);
                if (!m.Success) return;
                var op = m.Groups[1].Value;
                lock (SeenOps) if (SeenOps.Add(op)) WebShellWindow.Log($"khan op seen: {op}");
                var isAnswer = op.Contains("attempt", StringComparison.OrdinalIgnoreCase) || op.Contains("answer", StringComparison.OrdinalIgnoreCase);
                var isVideo = op.Contains("video", StringComparison.OrdinalIgnoreCase) && (op.Contains("progress", StringComparison.OrdinalIgnoreCase) || op.Contains("complete", StringComparison.OrdinalIgnoreCase));
                var isTaskOp = !isVideo && (op.Contains("complete", StringComparison.OrdinalIgnoreCase) || op.Contains("finish", StringComparison.OrdinalIgnoreCase)) && op.Contains("task", StringComparison.OrdinalIgnoreCase);
                if (!isAnswer && !isVideo && !isTaskOp) return;
                if (e.Response.StatusCode != 200) return;
                using var stream = await e.Response.GetContentAsync();
                if (stream is null) return;
                using var reader = new StreamReader(stream);
                var body = await reader.ReadToEndAsync();
                if (body.Contains("\"errors\"") && !body.Contains("\"data\"")) return;
                if (isAnswer)
                {
                    lock (SeenOps) if (SeenOps.Add("sample:" + op)) WebShellWindow.Log($"khan {op} reply sample: {Squash(body)}");
                    if (Correct.IsMatch(body)) { raise("khan:correct"); WebShellWindow.Log($"khan: correct answer ({op})"); }
                    if (TaskDone.IsMatch(body)) { raise("khan:done"); WebShellWindow.Log($"khan: task finished ({op})"); }
                }
                else if (isVideo && VideoDone.IsMatch(body)) { raise("khan:video"); WebShellWindow.Log($"khan: video finished ({op})"); }
                else if (isTaskOp) { raise("khan:done"); WebShellWindow.Log($"khan: task finished ({op})"); }
            }
            catch (Exception ex) { WebShellWindow.Log("learning observer: " + ex.Message); }
        };
    }

    private static void Duolingo(CoreWebView2WebResourceResponseReceivedEventArgs e, string uri, Action<string> raise)
    {
        var method = e.Request.Method;
        if (e.Response.StatusCode is < 200 or > 299) return;
        var path = uri.Split('?')[0];
        string? kind = null;
        if (method == "PUT" && DuoSession.IsMatch(uri)) kind = "duolingo:lesson";
        else if (method == "POST" && DuoStory.IsMatch(uri)) kind = "duolingo:story";
        if (kind is null) return;
        lock (Paid) if (!Paid.Add(path)) return; // the same lesson is only counted once
        raise(kind);
        WebShellWindow.Log($"duolingo: {kind} finished");
    }

    private static string Squash(string s) { s = Regex.Replace(s, @"\s+", " "); return s.Length > 600 ? s[..600] : s; }
}
