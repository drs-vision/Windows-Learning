using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinQuest.Shared.Config;

namespace CoinQuest.Shared.Ipc;

/// <summary>Client side of the Guardian pipe, used by Scholar and Parent Console.</summary>
public sealed class PipeClient : IAsyncDisposable
{
    private NamedPipeClientStream? _pipe;
    private StreamWriter? _writer;
    private readonly Dictionary<string, TaskCompletionSource<Response>> _pending = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private CancellationTokenSource? _cts;
    private readonly string _pipeName;

    public PipeClient(string? pipeName = null) { _pipeName = pipeName ?? Paths.PipeName; }

    public event Action<Event>? OnEvent;
    public event Action? Disconnected;
    public bool IsConnected => _pipe?.IsConnected == true;

    public async Task ConnectAsync(int timeoutMs = 5000)
    {
        _pipe = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await _pipe.ConnectAsync(timeoutMs);
        _writer = new StreamWriter(_pipe, new UTF8Encoding(false)) { AutoFlush = true };
        _cts = new CancellationTokenSource();
        _ = Task.Run(() => ReadLoop(_cts.Token));
    }

    private async Task ReadLoop(CancellationToken ct)
    {
        try
        {
            using var reader = new StreamReader(_pipe!, Encoding.UTF8);
            while (!ct.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(ct);
                if (line is null) break;
                JsonNode? node;
                try { node = JsonNode.Parse(line); } catch (JsonException) { continue; }
                if (node is null) continue;
                if (node["id"] is not null)
                {
                    var resp = node.Deserialize<Response>(Wire.Json)!;
                    TaskCompletionSource<Response>? tcs;
                    lock (_pending) _pending.Remove(resp.Id, out tcs);
                    tcs?.TrySetResult(resp);
                }
                else if (node["name"] is not null)
                {
                    OnEvent?.Invoke(node.Deserialize<Event>(Wire.Json)!);
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
        finally
        {
            lock (_pending)
            {
                foreach (var p in _pending.Values) p.TrySetException(new IOException("Guardian disconnected"));
                _pending.Clear();
            }
            Disconnected?.Invoke();
        }
    }

    public async Task<Response> SendAsync(string op, object? payload = null, string? token = null, int timeoutMs = 15000)
    {
        if (_writer is null) throw new InvalidOperationException("Not connected");
        var req = new Request { Op = op, Token = token, Payload = payload is null ? null : JsonSerializer.SerializeToNode(payload, Wire.Json) };
        var tcs = new TaskCompletionSource<Response>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_pending) _pending[req.Id] = tcs;
        await _writeLock.WaitAsync();
        try { await _writer.WriteLineAsync(JsonSerializer.Serialize(req, Wire.Json)); }
        finally { _writeLock.Release(); }
        using var cts = new CancellationTokenSource(timeoutMs);
        await using var _ = cts.Token.Register(() => tcs.TrySetException(new TimeoutException(op)));
        return await tcs.Task;
    }

    /// <summary>Forward a raw request line from WebView2 JS and return the raw response line.</summary>
    public async Task<string> ForwardRawAsync(string requestJson)
    {
        if (_writer is null || !IsConnected) throw new InvalidOperationException("the CoinQuest Guardian service is not running");
        var req = JsonSerializer.Deserialize<Request>(requestJson, Wire.Json) ?? new Request { Op = "" };
        var tcs = new TaskCompletionSource<Response>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_pending) _pending[req.Id] = tcs;
        await _writeLock.WaitAsync();
        try { await _writer!.WriteLineAsync(JsonSerializer.Serialize(req, Wire.Json)); }
        finally { _writeLock.Release(); }
        using var cts = new CancellationTokenSource(45000);
        await using var _ = cts.Token.Register(() => tcs.TrySetException(new TimeoutException(req.Op)));
        Response resp;
        try { resp = await tcs.Task; }
        catch (TimeoutException) { lock (_pending) _pending.Remove(req.Id); resp = Response.Fail(req.Id, "CoinQuest is taking too long to answer — try again"); }
        return JsonSerializer.Serialize(resp, Wire.Json);
    }

    public async ValueTask DisposeAsync()
    {
        _cts?.Cancel();
        if (_pipe is not null) await _pipe.DisposeAsync();
    }
}
