using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;

namespace MyFFL.Desktop;

public partial class MainWindow : Window
{
    private static readonly HttpClient Http = new()
    {
        BaseAddress = new Uri("https://api.myfflapp.com"),
        Timeout = TimeSpan.FromSeconds(8),
    };

    public MainWindow()
    {
        InitializeComponent();
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            using var response = await Http.GetAsync("/health");
            response.EnsureSuccessStatusCode();
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var payload = await JsonDocument.ParseAsync(stream);
            var version = payload.RootElement.GetProperty("data").GetProperty("version").GetString();
            ApiStatusText.Text = $"Connected - API {version}";
            ApiStatusText.Foreground = new SolidColorBrush(Color.FromRgb(34, 197, 94));
        }
        catch
        {
            ApiStatusText.Text = "Connection unavailable";
            ApiStatusText.Foreground = new SolidColorBrush(Color.FromRgb(248, 113, 113));
        }
    }

    private void CreateLeague_Click(object sender, RoutedEventArgs e) =>
        OpenUrl("https://app.myfflapp.com");

    private void JoinLeague_Click(object sender, RoutedEventArgs e) =>
        OpenUrl("https://app.myfflapp.com/?join=");

    private void OpenLeagues_Click(object sender, RoutedEventArgs e) =>
        OpenUrl("https://app.myfflapp.com");

    private void OpenDraft_Click(object sender, RoutedEventArgs e) =>
        OpenUrl("https://app.myfflapp.com");

    private static void OpenUrl(string url)
    {
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
