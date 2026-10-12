using CoinQuest.Guardian.Native;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Models;

namespace CoinQuest.Guardian;

/// <summary>
/// Knows who is sitting at the computer right now and whether that account is a managed child.
/// Everything else in the Guardian keys off <see cref="Current"/>: when it's null, the Guardian does nothing.
/// </summary>
public sealed class SessionMonitor
{
    private readonly HouseholdStore _store;
    private readonly ILogger<SessionMonitor> _log;

    public SessionMonitor(HouseholdStore store, ILogger<SessionMonitor> log) { _store = store; _log = log; }

    public sealed record ActiveSession(uint SessionId, string Account, Child Child);

    /// <summary>The managed child currently at the console, or null (nobody / a parent / lock screen).</summary>
    public ActiveSession? Current { get; private set; }
    public uint ConsoleSessionId { get; private set; }
    public string? ConsoleAccount { get; private set; }
    public string? ConsoleSid { get; private set; }

    public event Action<ActiveSession?>? Changed;

    /// <summary>Called every second by the worker. Cheap.</summary>
    public void Poll()
    {
        var sid = Wts.ActiveConsoleSessionId();
        var account = sid == 0xFFFFFFFF ? null : Wts.SessionUser(sid);
        ConsoleSessionId = sid;
        ConsoleAccount = account;

        // Match by SID first (always correct), then by name (older setups without a SID).
        var userSid = account is null ? null : Wts.SessionUserSid(sid);
        ConsoleSid = userSid;
        var child = (userSid is null ? null : _store.Current.Children.FirstOrDefault(c => string.Equals(c.WindowsSid, userSid, StringComparison.OrdinalIgnoreCase)))
                    ?? (account is null ? null : _store.FindChildByAccount(account));
        var next = child is null ? null : new ActiveSession(sid, account!, child);

        if (next?.SessionId != Current?.SessionId || next?.Child.Id != Current?.Child.Id)
        {
            _log.LogInformation("Console session {Sid} user {User} ({UserSid}) managed={Managed}. Children: {Children}", sid, account ?? "(none)", ConsoleSid ?? "?", next is not null,
                string.Join("; ", _store.Current.Children.Select(c => $"{c.DisplayName}={c.WindowsAccount}/{c.WindowsSid}")));
            Current = next;
            Changed?.Invoke(next);
        }
        else if (next is not null && !ReferenceEquals(next.Child, Current!.Child))
        {
            Current = next; // same child, refreshed settings
        }
    }
}
