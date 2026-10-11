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
    private readonly string _source;

    public ScoreEngine(string? scorersJsPath = null)
    {
        var path = scorersJsPath ?? Path.Combine(Paths.WebRoot, "scorers.js");
        _source = File.ReadAllText(path);
    }

    public static ScoreEngine FromSource(string js) => new(js, true);
    private ScoreEngine(string js, bool _) { _source = js; }

    public ScoreOutcome Score(string moduleId, JsonNode? activity, JsonNode? result, JsonNode? settings)
    {
        // Fresh engine per call: no state leaks between submissions, and a runaway script is bounded.
        var engine = new Engine(o => o
            .LimitRecursion(64)
            .TimeoutInterval(TimeSpan.FromSeconds(2))
            .MaxStatements(2_000_000)
            .Strict());
        engine.Execute(_source);
        engine.SetValue("__moduleId", moduleId);
        engine.SetValue("__activity", JsValue.FromObject(engine, ToPlain(activity)));
        engine.SetValue("__result", JsValue.FromObject(engine, ToPlain(result)));
        engine.SetValue("__settings", JsValue.FromObject(engine, ToPlain(settings)));
        var json = engine.Evaluate("JSON.stringify(globalThis.CoinQuestScorers.score(__moduleId, __activity, __result, __settings))").AsString();
        var node = JsonNode.Parse(json)!;
        return new ScoreOutcome(
            Coins: node["coins"]?.GetValue<int>() ?? 0,
            NeedsApproval: node["needsApproval"]?.GetValue<bool>() ?? false,
            Detail: node["detail"]?.GetValue<string>() ?? "",
            ProgressDelta: node["progressDelta"],
            Valid: node["valid"]?.GetValue<bool>() ?? true,
            Reason: node["reason"]?.GetValue<string>());
    }

    // Jint interops cleanly with plain CLR dictionaries/lists; JsonNode is not a plain object.
    private static object? ToPlain(JsonNode? n) => n switch
    {
        null => null,
        JsonObject o => o.ToDictionary(kv => kv.Key, kv => ToPlain(kv.Value)),
        JsonArray a => a.Select(ToPlain).ToList(),
        JsonValue v => v.TryGetValue<bool>(out var b) ? b
                      : v.TryGetValue<long>(out var l) ? (l is >= int.MinValue and <= int.MaxValue ? (object)(int)l : l)
                      : v.TryGetValue<double>(out var d) ? d
                      : v.TryGetValue<string>(out var s) ? s
                      : v.ToJsonString(),
        _ => JsonSerializer.Deserialize<object>(n.ToJsonString())
    };
}
