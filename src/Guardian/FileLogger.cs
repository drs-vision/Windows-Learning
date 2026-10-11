namespace CoinQuest.Guardian;

/// <summary>Tiny rolling file logger: one file, rolled at 5 MB, keeps 3. No dependencies.</summary>
public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly string _path;
    private readonly object _gate = new();
    public FileLoggerProvider(string path) { _path = path; Directory.CreateDirectory(Path.GetDirectoryName(path)!); }

    public ILogger CreateLogger(string categoryName) => new FileLogger(this, categoryName);
    public void Dispose() { }

    internal void Write(string line)
    {
        lock (_gate)
        {
            try
            {
                if (File.Exists(_path) && new FileInfo(_path).Length > 5_000_000)
                {
                    for (var i = 2; i >= 1; i--)
                    {
                        var from = $"{_path}.{i}"; var to = $"{_path}.{i + 1}";
                        if (File.Exists(from)) File.Move(from, to, true);
                    }
                    File.Move(_path, _path + ".1", true);
                }
                File.AppendAllText(_path, line + Environment.NewLine);
            }
            catch { /* logging must never take the service down */ }
        }
    }

    private sealed class FileLogger : ILogger
    {
        private readonly FileLoggerProvider _p; private readonly string _cat;
        public FileLogger(FileLoggerProvider p, string cat) { _p = p; _cat = cat.Contains('.') ? cat[(cat.LastIndexOf('.') + 1)..] : cat; }
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Information;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? ex, Func<TState, Exception?, string> fmt)
        {
            if (!IsEnabled(level)) return;
            var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} [{level.ToString()[..4].ToUpper()}] {_cat}: {fmt(state, ex)}";
            if (ex is not null) line += Environment.NewLine + ex;
            _p.Write(line);
        }
    }
}
