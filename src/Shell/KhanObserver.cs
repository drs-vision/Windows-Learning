using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;

namespace CoinQuest.Shell;

/// <summary>
/// Earns coins from real Khan Academy work, automatically. Khan's site talks to its servers through GraphQL calls
/// named in the URL (/api/internal/graphql/&lt;operation&gt;). Inside CoinQuest's own browser we can see those replies,
/// so a checked answer that comes back correct, or a finished video, becomes a coin event. Nothing is changed or sent.
/// Every operation name seen is written once to shell.log, so the matching can be tuned if Khan renames things.
/// </summary>
public static class KhanObserver
{
    private static readonly HashSet<string> SeenOps = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Regex OpName = new(@"/api/internal/(?:_mt/)?graphql/([A-Za-z0-9_]+)", RegexOptions.Compiled);
    private static readonly Regex Correct = new(@"""correct""\s*:\s*true", RegexOptions.Compiled);
    private static readonly Regex VideoDone = new(@"""(?:isVideoComplete|completed|isComplete)""\s*:\s*true", RegexOptions.Compiled);

    public static void Attach(CoreWebView2 core, Action<string> raise)
    {
        core.WebResourceResponseReceived += async (_, e) =>
        {
            try
            {
                var m = OpName.Match(e.Request.Uri);
                if (!m.Success) return;
                var op = m.Groups[1].Value;
                lock (SeenOps) if (SeenOps.Add(op)) WebShellWindow.Log($"khan op seen: {op}");
                var isAnswer = op.Contains("attempt", StringComparison.OrdinalIgnoreCase) || op.Contains("answer", StringComparison.OrdinalIgnoreCase);
                var isVideo = op.Contains("video", StringComparison.OrdinalIgnoreCase) && (op.Contains("progress", StringComparison.OrdinalIgnoreCase) || op.Contains("complete", StringComparison.OrdinalIgnoreCase));
                if (!isAnswer && !isVideo) return;
                if (e.Response.StatusCode != 200) return;
                using var stream = await e.Response.GetContentAsync();
                if (stream is null) return;
                using var reader = new StreamReader(stream);
                var body = await reader.ReadToEndAsync();
                if (isAnswer && Correct.IsMatch(body)) { raise("correct"); WebShellWindow.Log($"khan: correct answer ({op})"); }
                else if (isVideo && VideoDone.IsMatch(body)) { raise("video"); WebShellWindow.Log($"khan: video finished ({op})"); }
            }
            catch (Exception ex) { WebShellWindow.Log("khan observer: " + ex.Message); }
        };
    }
}
