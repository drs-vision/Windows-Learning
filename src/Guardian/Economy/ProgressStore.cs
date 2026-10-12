using System.Text.Json;
using System.Text.Json.Nodes;
using CoinQuest.Shared.Config;

namespace CoinQuest.Guardian.Economy;

/// <summary>Per-child, per-module progress blobs. Opaque JSON owned by each module. Not coin-bearing.</summary>
public static class ProgressStore
{
    private static readonly object Gate = new();

    private static string Dir(string childId) => Path.Combine(Paths.DataRoot, "progress", childId);
    private static string File_(string childId, string moduleId) => Path.Combine(Dir(childId), SafeName(moduleId) + ".json");

    public static Dictionary<string, JsonNode?> LoadAll(string childId)
    {
        var result = new Dictionary<string, JsonNode?>();
        lock (Gate)
        {
            if (!Directory.Exists(Dir(childId))) return result;
            foreach (var f in Directory.EnumerateFiles(Dir(childId), "*.json"))
            {
                try { result[Path.GetFileNameWithoutExtension(f)] = JsonNode.Parse(File.ReadAllText(f)); }
                catch { }
            }
        }
        return result;
    }

    public static JsonNode? Load(string childId, string moduleId)
    {
        lock (Gate)
        {
            var f = File_(childId, moduleId);
            if (!File.Exists(f)) return null;
            try { return JsonNode.Parse(File.ReadAllText(f)); } catch { return null; }
        }
    }

    public static void Save(string childId, string moduleId, JsonNode progress)
    {
        lock (Gate)
        {
            Directory.CreateDirectory(Dir(childId));
            var f = File_(childId, moduleId);
            SafeFile.WriteAllText(f, progress.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
    }

    /// <summary>Shallow-merge a delta object into the stored progress (top-level keys replaced).</summary>
    public static void Merge(string childId, string moduleId, JsonNode delta)
    {
        if (delta is not JsonObject d) return;
        lock (Gate)
        {
            var current = Load(childId, moduleId) as JsonObject ?? new JsonObject();
            foreach (var kv in d) current[kv.Key] = kv.Value?.DeepClone();
            Save(childId, moduleId, current);
        }
    }

    private static string SafeName(string s) => string.Concat(s.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_'));
}
