using System.Text.Json.Nodes;
using CoinQuest.Shared.Config;

namespace CoinQuest.Guardian.Setup;

/// <summary>Games available to the arcade: the bundled manifest plus any .swf a parent dropped in the arcade folder.</summary>
public static class Arcade
{
    public static object List()
    {
        var games = new List<object>();
        var manifest = Path.Combine(Paths.ContentRoot, "games", "MANIFEST.json");
        if (File.Exists(manifest))
        {
            try
            {
                var node = JsonNode.Parse(File.ReadAllText(manifest));
                if (node?["games"] is JsonArray arr)
                    foreach (var g in arr)
                    {
                        if (g is null) continue;
                        var kind = g["kind"]?.GetValue<string>() ?? "swf";
                        var path = g["path"]?.GetValue<string>() ?? "";
                        var exists = File.Exists(Path.Combine(Paths.ContentRoot, "games", path.Replace('/', Path.DirectorySeparatorChar)));
                        games.Add(new
                        {
                            id = g["id"]?.GetValue<string>(), title = g["title"]?.GetValue<string>(), author = g["author"]?.GetValue<string>(),
                            kind, license = g["license"]?.GetValue<string>(), url = $"https://coinquest.local/content/games/{path}",
                            genre = g["genre"]?.GetValue<string>(), available = exists,
                        });
                    }
            }
            catch { }
        }
        if (Directory.Exists(Paths.ArcadeDropFolder))
            foreach (var f in Directory.EnumerateFiles(Paths.ArcadeDropFolder, "*.swf"))
                games.Add(new { id = "drop-" + Path.GetFileNameWithoutExtension(f), title = Path.GetFileNameWithoutExtension(f), author = "", kind = "swf", license = "yours", url = $"https://coinquest-arcade.local/{Path.GetFileName(f)}", genre = "", available = true });
        return new { games };
    }
}
