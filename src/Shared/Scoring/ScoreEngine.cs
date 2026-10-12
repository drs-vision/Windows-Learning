using System.Text.Json;
using System.Text.Json.Nodes;
using CoinQuest.Shared.Config;
using Jint;
using Jint.Native;

namespace CoinQuest.Shared.Scoring;

public sealed record ScoreOutcome(int Coins, bool NeedsApproval, string Detail, JsonNode? ProgressDelta, bool Valid, string? Reason);

/// <summary>
/// Runs the SAME scoring code the child's UI runs (web/dist/scorers.js, built by Vite in library mode)
/// inside the Guardian, so the number of coins minted is decided by the service, not by the UI.
/// The scorers are pure functions: (moduleId, activity, result, settings) -> outcome.
/// </summary>
public sealed class ScoreEngine
{
    private readonly string? _path;
    private string? _source;

    public ScoreEngine(string? scorersJsPath = null) { _path = scorersJsPath ?? Path.Combine(Paths.WebRoot, "scorers.js"); }

    public static ScoreEngine FromSource(string js) => new(js, true);
    private ScoreEngine(string js, bool _) { _source = js; }

    /// <summary>Loaded lazily so a missing bundle surfaces as a rejected submission, not a service that won't start.</summary>
    private string Source => _source ??= File.ReadAllText(_path!);

    public ScoreOutcome Score(string moduleId, JsonNode? activity, JsonNode? result, JsonNode? settings)
    {
        // Fresh engine per call: no state leaks between submissions, and a runaway script is bounded.
        var engine = new Engine(o => o
            .LimitRecursion(64)
            .TimeoutInterval(TimeSpan.FromSeconds(2))
            .MaxStatements(2_000_000)
            .Strict());
        engine.Execute(Source);
        // Hand the data over as JSON text and parse it INSIDE the engine, so arrays are real JS arrays
        // (CLR lists passed through interop fail Array.isArray, which made every list-based scorer reject results).
        engine.SetValue("__moduleId", moduleId);
        engine.SetValue("__activityJson", activity?.ToJsonString() ?? "null");
        engine.SetValue("__resultJson", result?.ToJsonString() ?? "null");
        engine.SetValue("__settingsJson", settings?.ToJsonString() ?? "null");
        var json = engine.Evaluate("JSON.stringify(globalThis.CoinQuestScorers.score(__moduleId, JSON.parse(__activityJson), JSON.parse(__resultJson), JSON.parse(__settingsJson)))").AsString();
        var node = JsonNode.Parse(json)!;
        return new ScoreOutcome(
            Coins: node["coins"]?.GetValue<int>() ?? 0,
            NeedsApproval: node["needsApproval"]?.GetValue<bool>() ?? false,
            Detail: node["detail"]?.GetValue<string>() ?? "",
            ProgressDelta: node["progressDelta"],
            Valid: node["valid"]?.GetValue<bool>() ?? true,
            Reason: node["reason"]?.GetValue<string>());
    }
}
