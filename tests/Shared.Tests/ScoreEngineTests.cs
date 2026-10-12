using Jint;
using System.Text.Json.Nodes;
using CoinQuest.Shared.Scoring;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class ScoreEngineTests
{
    private static string? BundlePath()
    {
        var local = Path.Combine(AppContext.BaseDirectory, "scorers.js");
        return File.Exists(local) ? local : null;
    }

    [Fact]
    public void Runs_the_shipped_scorers_bundle()
    {
        var path = BundlePath();
        if (path is null) return; // web not built in this environment; CI builds it first
        var engine = new ScoreEngine(path);
        var activity = JsonNode.Parse("""{"moduleId":"khan-academy","kind":"claim","data":{},"issuedAt":0}""");
        var result = JsonNode.Parse("""{"startedAt":0,"finishedAt":1000,"data":{"topic":"Fractions","kind":"quiz"}}""");
        var settings = JsonNode.Parse("""{"enabled":true,"coinsPerActivity":35,"dailyCap":140,"requireApproval":true}""");
        var out_ = engine.Score("khan-academy", activity, result, settings);
        Assert.True(out_.Valid);
        Assert.Equal(53, out_.Coins);
        Assert.True(out_.NeedsApproval);
        Assert.Contains("Fractions", out_.Detail);
    }

    /// <summary>Every Letter Rescue lesson, played perfectly, must be accepted and pay coins — through the real bundle in Jint.</summary>
    [Fact]
    public void Every_sound_keys_lesson_scores_end_to_end()
    {
        var path = BundlePath();
        if (path is null) return;
        var js = new Jint.Engine();
        js.Execute(File.ReadAllText(path));
        var count = (int)js.Evaluate("CoinQuestScorers.soundKeysLessonCount()").AsNumber();
        Assert.True(count >= 30);
        var engine = new ScoreEngine(path);
        var settings = JsonNode.Parse("""{"enabled":true,"coinsPerActivity":12,"dailyCap":100,"requireApproval":false}""");
        for (var id = 1; id <= count; id++)
        {
            var items = JsonNode.Parse(js.Evaluate($"JSON.stringify(CoinQuestScorers.soundKeysItems({id}, 0))").AsString())!.AsArray();
            Assert.NotEmpty(items);
            var typed = new JsonArray(items.Select(n => (JsonNode?)JsonValue.Create(n!.GetValue<string>())).ToArray());
            var firstTry = new JsonArray(items.Select(_ => (JsonNode?)JsonValue.Create(true)).ToArray());
            var activity = new JsonObject { ["moduleId"] = "sound-keys", ["kind"] = "lesson", ["issuedAt"] = 0,
                ["data"] = new JsonObject { ["lessonId"] = id, ["current"] = id, ["seed"] = 0, ["done"] = new JsonArray() } };
            var result = new JsonObject { ["startedAt"] = 0, ["finishedAt"] = 600_000, ["data"] = new JsonObject { ["typed"] = typed, ["firstTry"] = firstTry } };
            var o = engine.Score("sound-keys", activity, result, settings);
            Assert.True(o.Valid, $"lesson {id}: {o.Reason}");
            Assert.True(o.Coins > 0, $"lesson {id} paid nothing");
            Assert.Equal(id == count ? count : id + 1, o.ProgressDelta?["lesson"]?.GetValue<int>());
        }
    }

    [Fact]
    public void Unknown_module_is_invalid()
    {
        var engine = ScoreEngine.FromSource("globalThis.CoinQuestScorers={score:function(m){return {valid:false,reason:'unknown '+m,coins:0,needsApproval:false,detail:''}}};");
        var o = engine.Score("nope", null, null, null);
        Assert.False(o.Valid);
        Assert.Equal(0, o.Coins);
    }

    [Fact]
    public void Runaway_script_is_cut_off()
    {
        var engine = ScoreEngine.FromSource("globalThis.CoinQuestScorers={score:function(){while(true){}}};");
        Assert.ThrowsAny<Exception>(() => engine.Score("x", null, null, null));
    }
}
