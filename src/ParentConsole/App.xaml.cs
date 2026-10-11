using System.Windows;
using CoinQuest.Shell;

namespace CoinQuest.ParentConsole;

public partial class App : Application
{
    private void OnStartup(object sender, StartupEventArgs e)
    {
        MainWindow = new WebShellWindow("parent", kiosk: false);
        MainWindow.Show();
    }
}
