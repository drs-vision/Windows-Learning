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
                catch (Exception ex) when ((ex is UnauthorizedAccessException or IOException) && attempt < 10)
                {
                    Thread.Sleep(60 * (attempt + 1)); // ~3.3 s worst case
                }
                catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
                {
                    break; // fall through to in-place write
                }
            }
            // Next: overwrite in place (not atomic, but the data gets saved). Opened without truncating-create,
            // which Windows refuses on hidden/system files; then repair the file's permissions once and try again.
            Exception? last = null;
            for (var attempt = 0; attempt < 12; attempt++)
            {
                try { WriteInPlace(path, content); return; }
                catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
                {
                    last = ex;
                    if (attempt == 5) RepairAccess(path);
                    Thread.Sleep(250);
                }
            }
            throw new UnauthorizedAccessException($"Could not save {path} ({Describe(path)}): {last?.Message}", last);
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

    private const FileAttributes Blocking = FileAttributes.ReadOnly | FileAttributes.Hidden | FileAttributes.System;

    /// <summary>Read-only, hidden and system attributes all make Windows refuse a replace/overwrite with "access denied".</summary>
    private static void ClearReadOnly(string path)
    {
        try
        {
            if (File.Exists(path) && (File.GetAttributes(path) & Blocking) != 0)
                File.SetAttributes(path, File.GetAttributes(path) & ~Blocking);
        }
        catch { }
    }

    private static void WriteInPlace(string path, string content)
    {
        using var fs = new FileStream(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        var bytes = new System.Text.UTF8Encoding(false).GetBytes(content);
        fs.Write(bytes, 0, bytes.Length);
        fs.SetLength(bytes.Length);
    }

    /// <summary>
    /// A file whose permissions were changed by hand or by another tool can deny even SYSTEM. Put it back to
    /// "inherit from the folder" (CoinQuest's folder grants SYSTEM and Administrators full control).
    /// </summary>
    private static void RepairAccess(string path)
    {
        if (!OperatingSystem.IsWindows() || !File.Exists(path)) return;
        try
        {
            ClearReadOnly(path);
            var info = new FileInfo(path);
            var sec = info.GetAccessControl();
            sec.SetAccessRuleProtection(isProtected: false, preserveInheritance: false);
            foreach (System.Security.AccessControl.FileSystemAccessRule r in sec.GetAccessRules(true, false, typeof(System.Security.Principal.SecurityIdentifier)))
                if (r.AccessControlType == System.Security.AccessControl.AccessControlType.Deny) sec.RemoveAccessRuleSpecific(r);
            info.SetAccessControl(sec);
        }
        catch { /* best effort */ }
    }

    private static string Describe(string path)
    {
        try { return File.Exists(path) ? "attributes " + File.GetAttributes(path) : "missing"; } catch (Exception ex) { return ex.Message; }
    }
}
