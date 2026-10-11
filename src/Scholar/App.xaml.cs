using System.Threading;
using System.Windows;
using CoinQuest.Shell;

namespace CoinQuest.Scholar;

public partial class App : Application
{
    private static Mutex? _single;

    private void OnStartup(object sender, StartupEventArgs e)
    {
        _single = new Mutex(true, @"Local\CoinQuest.Scholar", out var first);
        if (!first) { Shutdown(); return; }
        var kiosk = Environment.GetEnvironmentVariable("COINQUEST_DEV") != "1";
        MainWindow = new WebShellWindow("scholar", kiosk);
        MainWindow.Show();
    }
}
