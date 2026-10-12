using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace CoinQuest.Guardian.Native;

/// <summary>Windows Terminal Services: which user is at the console, and launching into their session.</summary>
internal static class Wts
{
    private const int WTS_CURRENT_SERVER_HANDLE = 0;

    private enum WTS_INFO_CLASS { WTSUserName = 5, WTSDomainName = 7, WTSConnectState = 8 }

    [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQuerySessionInformation(IntPtr hServer, uint sessionId, WTS_INFO_CLASS info, out IntPtr buffer, out uint bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr p);
    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr h);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr env);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(IntPtr token, string? app, string cmdLine, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string? cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    private const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    private const uint CREATE_NEW_CONSOLE = 0x10;

    public static uint ActiveConsoleSessionId() => WTSGetActiveConsoleSessionId();

    /// <summary>"DOMAIN\\user" of the interactive user in a session, or null if nobody is logged in.</summary>
    public static string? SessionUser(uint sessionId)
    {
        if (sessionId == 0xFFFFFFFF) return null;
        var user = Query(sessionId, WTS_INFO_CLASS.WTSUserName);
        if (string.IsNullOrEmpty(user)) return null;
        var domain = Query(sessionId, WTS_INFO_CLASS.WTSDomainName);
        return string.IsNullOrEmpty(domain) ? user : $"{domain}\\{user}";
    }

    private static string? Query(uint sessionId, WTS_INFO_CLASS cls)
    {
        if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, cls, out var buf, out _)) return null;
        try { return Marshal.PtrToStringUni(buf); } finally { WTSFreeMemory(buf); }
    }

    /// <summary>
    /// The SID of the user logged into a session, read from their logon token. This is the reliable way to know
    /// who is at the keyboard — names can differ (Microsoft accounts, renamed accounts, "DESKTOP\\name" vs "name").
    /// </summary>
    public static string? SessionUserSid(uint sessionId)
    {
        if (sessionId == 0xFFFFFFFF || !WTSQueryUserToken(sessionId, out var token)) return null;
        try
        {
            using var id = new WindowsIdentity(token);
            return id.User?.Value;
        }
        catch { return null; }
        finally { CloseHandle(token); }
    }

    public static string? SidForAccount(string account)
    {
        try { return (new NTAccount(account).Translate(typeof(SecurityIdentifier)) as SecurityIdentifier)?.Value; }
        catch { return null; }
    }

    /// <summary>Start a process on the interactive desktop of the given session, as that session's user.</summary>
    public static int LaunchInSession(uint sessionId, string exePath, string args = "")
    {
        if (!WTSQueryUserToken(sessionId, out var token)) throw new Win32Exception();
        IntPtr env = IntPtr.Zero;
        try
        {
            if (!CreateEnvironmentBlock(out env, token, false)) throw new Win32Exception();
            var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), lpDesktop = @"winsta0\default" };
            var cmd = $"\"{exePath}\" {args}".TrimEnd();
            if (!CreateProcessAsUser(token, null, cmd, IntPtr.Zero, IntPtr.Zero, false,
                    CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE, env, Path.GetDirectoryName(exePath), ref si, out var pi))
                throw new Win32Exception();
            CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
            return pi.dwProcessId;
        }
        finally
        {
            if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
            CloseHandle(token);
        }
    }
}
