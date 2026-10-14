using System.Diagnostics;

namespace CoinQuest.Guardian.Rwt;

/// <summary>
/// otvdm (the 16-bit helper behind Read, Write &amp; Type! and other 16-bit discs) is built with Microsoft Visual C++
/// and needs its runtime ("vcruntime140.dll was not found" otherwise). Most PCs have it from other programs; a fresh
/// Windows may not. Installed silently from Microsoft when missing — both the 32-bit and 64-bit parts, since otvdm
/// ships both kinds of programs.
/// </summary>
public static class VcRuntime
{
    private static readonly SemaphoreSlim Gate = new(1, 1);

    private static bool Has(string dir, params string[] dlls) => dlls.All(d => File.Exists(Path.Combine(dir, d)));

    public static bool X86Present => Has(Environment.GetFolderPath(Environment.SpecialFolder.SystemX86), "vcruntime140.dll", "msvcp140.dll");
    public static bool X64Present => !Environment.Is64BitOperatingSystem || Has(Environment.SystemDirectory, "vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll");
    public static bool Present => X86Present && X64Present;

    /// <summary>Install whatever is missing (a minute or so, once). Throws with a plain message if it can't.</summary>
    public static async Task EnsureAsync(HttpClient http, ILogger log)
    {
        if (Present) return;
        await Gate.WaitAsync();
        try
        {
            foreach (var (arch, present) in new[] { ("x86", X86Present), ("x64", X64Present) })
            {
                if (present) continue;
                var file = Path.Combine(Path.GetTempPath(), $"vc_redist.{arch}.exe");
                log.LogInformation("Installing the Microsoft Visual C++ runtime ({Arch}) for the 16-bit helper", arch);
                await using (var f = File.Create(file))
                    await (await http.GetStreamAsync($"https://aka.ms/vs/17/release/vc_redist.{arch}.exe")).CopyToAsync(f);
                using var p = Process.Start(new ProcessStartInfo(file, "/install /quiet /norestart") { UseShellExecute = false, CreateNoWindow = true })!;
                if (!p.WaitForExit(TimeSpan.FromMinutes(5))) { try { p.Kill(); } catch { } throw new TimeoutException("the Microsoft Visual C++ runtime took too long to install"); }
                // 0 = installed, 1638 = a newer version is already there, 3010 = installed, restart suggested.
                if (p.ExitCode is not (0 or 1638 or 3010)) throw new InvalidOperationException($"the Microsoft Visual C++ runtime didn't install (code {p.ExitCode})");
                try { File.Delete(file); } catch { }
            }
            if (!Present) throw new InvalidOperationException("the Microsoft Visual C++ runtime still isn't there — restart the computer and try again");
        }
        finally { Gate.Release(); }
    }
}
