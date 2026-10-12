namespace CoinQuest.Shared.Config;

/// <summary>
/// Crash-safe file writes that survive Windows reality: antivirus and the search indexer briefly open freshly
/// written files, which makes a rename-over-existing fail with "Access to the path … is denied".
/// Write to a temp file, then swap it in, retrying briefly; if the swap keeps failing, write in place.
/// </summary>
public static class SafeFile
{
    public static void WriteAllText(string path, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + "." + Environment.ProcessId + "." + Guid.NewGuid().ToString("N")[..8] + ".tmp";
        try
        {
            ClearReadOnly(path);
            File.WriteAllText(tmp, content);
            for (var attempt = 0; ; attempt++)
            {
                try { File.Move(tmp, path, overwrite: true); return; }
                catch (Exception ex) when ((ex is UnauthorizedAccessException or IOException) && attempt < 8)
                {
                    Thread.Sleep(50 * (attempt + 1)); // 50 ms … 400 ms; ~1.8 s worst case
                }
                catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
                {
                    break; // fall through to in-place write
                }
            }
            // Last resort: overwrite in place (not atomic, but the data gets saved).
            for (var attempt = 0; ; attempt++)
            {
                try { File.WriteAllText(path, content); return; }
                catch (Exception ex) when ((ex is UnauthorizedAccessException or IOException) && attempt < 5) { Thread.Sleep(200); }
            }
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
        }
    }

    /// <summary>Remove stray temp files left by older versions or crashes.</summary>
    public static void CleanTemps(string dir)
    {
        try { foreach (var f in Directory.EnumerateFiles(dir, "*.tmp")) { try { ClearReadOnly(f); File.Delete(f); } catch { } } } catch { }
    }

    private static void ClearReadOnly(string path)
    {
        try
        {
            if (File.Exists(path) && File.GetAttributes(path).HasFlag(FileAttributes.ReadOnly))
                File.SetAttributes(path, File.GetAttributes(path) & ~FileAttributes.ReadOnly);
        }
        catch { }
    }
}
