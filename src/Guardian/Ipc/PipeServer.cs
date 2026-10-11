using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using CoinQuest.Shared.Config;
using CoinQuest.Guardian.Setup;
using CoinQuest.Shared.Ipc;

namespace CoinQuest.Guardian.Ipc;

/// <summary>
/// Named-pipe server. Each client connection is identified by the Windows account on the other end
/// (pipe impersonation) — that's the only identity we trust. Events are broadcast to every client.
/// </summary>
public sealed class PipeServer
{
    private readonly RequestRouter _router;
    private readonly ILogger<PipeServer> _log;
    private readonly List<Client> _clients = new();

    public sealed class Client
    {
        public required NamedPipeServerStream Pipe { get; init; }
        public required StreamWriter Writer { get; init; }
        public required string Account { get; init; }
        public required bool IsAdmin { get; init; }
        public uint SessionId { get; init; }
        public readonly SemaphoreSlim WriteLock = new(1, 1);
    }

    public PipeServer(RequestRouter router, ILogger<PipeServer> log) { _router = router; _log = log; }

    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            NamedPipeServerStream pipe;
            try
            {
                var security = new PipeSecurity();
                security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
                security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
                pipe = NamedPipeServerStreamAcl.Create(Paths.PipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, security);
                await pipe.WaitForConnectionAsync(ct);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { _log.LogError(ex, "Pipe accept failed"); await Task.Delay(1000, ct); continue; }

            _ = Task.Run(() => Serve(pipe, ct), ct);
        }
    }

    private async Task Serve(NamedPipeServerStream pipe, CancellationToken ct)
    {
        Client? client = null;
        try
        {
            using var reader = new StreamReader(pipe, Encoding.UTF8);
            while (!ct.IsCancellationRequested && pipe.IsConnected)
            {
                var line = await reader.ReadLineAsync(ct);
                if (line is null) break;

                // Windows only allows impersonating a pipe client AFTER the server has read from the pipe
                // (ImpersonateNamedPipeClient → ERROR_CANNOT_IMPERSONATE otherwise), so identify on the first request.
                if (client is null)
                {
                    string account = "?"; bool isAdmin = false;
                    try
                    {
                        pipe.RunAsClient(() =>
                        {
                            using var id = WindowsIdentity.GetCurrent();
                            account = id.Name;
                            isAdmin = id.Groups?.Any(g => g.Value == "S-1-5-32-544") == true;
                        });
                        // A non-elevated admin's token carries Administrators as deny-only, which .NET's Groups omits —
                        // so ask the local group directly. The service is SYSTEM; this is cheap and cached.
                        if (!isAdmin) isAdmin = LocalAccounts.IsLocalAdmin(account);
                    }
                    catch (Exception ex)
                    {
                        _log.LogWarning(ex, "Could not identify pipe client");
                    }
                    client = new Client { Pipe = pipe, Writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true }, Account = account, IsAdmin = isAdmin };
                    lock (_clients) _clients.Add(client);
                    _log.LogInformation("Client connected: {Account} admin={Admin}", account, isAdmin);
                }

                Response resp;
                Request? req = null;
                try
                {
                    req = JsonSerializer.Deserialize<Request>(line, Wire.Json);
                    resp = req is null ? Response.Fail("", "bad request") : await _router.Handle(req, client);
                }
                catch (Exception ex)
                {
                    _log.LogWarning(ex, "Request {Op} failed", req?.Op);
                    resp = Response.Fail(req?.Id ?? "", ex.Message);
                }
                await Send(client, JsonSerializer.Serialize(resp, Wire.Json));
            }
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
        catch (Exception ex) { _log.LogWarning(ex, "Client loop ended"); }
        finally
        {
            if (client is not null) lock (_clients) _clients.Remove(client);
            try { pipe.Dispose(); } catch { }
        }
    }

    private static async Task Send(Client c, string line)
    {
        await c.WriteLock.WaitAsync();
        try { await c.Writer.WriteLineAsync(line); }
        catch (IOException) { }
        finally { c.WriteLock.Release(); }
    }

    /// <summary>Broadcast an event to every connected client (optionally only a given account).</summary>
    public void Broadcast(string name, object? payload, string? onlyAccount = null)
    {
        var ev = JsonSerializer.Serialize(new Event { Name = name, Payload = payload is null ? null : JsonSerializer.SerializeToNode(payload, Wire.Json) }, Wire.Json);
        List<Client> targets;
        lock (_clients) targets = _clients.Where(c => onlyAccount is null || string.Equals(c.Account, onlyAccount, StringComparison.OrdinalIgnoreCase)).ToList();
        foreach (var c in targets) _ = Send(c, ev);
    }
}
