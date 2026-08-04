using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;

namespace MyFFL.Desktop;

public partial class MainWindow : Window
{
    private const string AppUrl = "https://app.myfflapp.com/";
    private static readonly HttpClient Http = new() { BaseAddress = new Uri("https://api.myfflapp.com"), Timeout = TimeSpan.FromSeconds(8) };
    private bool dockOpen;

    public MainWindow() => InitializeComponent();

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        await InitializeBrowserAsync();
        await CheckHealthAsync();
    }

    private async Task InitializeBrowserAsync()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync();
            await MainWebView.EnsureCoreWebView2Async(environment);
            await MatchupWebView.EnsureCoreWebView2Async(environment);
            ConfigureBrowser(MainWebView);
            ConfigureBrowser(MatchupWebView);
            MainWebView.Source = new Uri(AppUrl);
            MatchupWebView.Source = BuildUri("gameday");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            StatusText.Text = "Microsoft Edge WebView2 Runtime is required. Install it, then restart myFFL.";
            ApiStatusText.Text = "WebView2 runtime missing";
            ApiStatusText.Foreground = Brushes.IndianRed;
        }
        catch (Exception exception)
        {
            StatusText.Text = $"Unable to start the workspace: {exception.Message}";
        }
    }

    private void ConfigureBrowser(Microsoft.Web.WebView2.Wpf.WebView2 browser)
    {
        browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
        browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
        browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
        browser.NavigationStarting += (_, _) => StatusText.Text = "Loading...";
        browser.NavigationCompleted += (_, args) =>
        {
            StatusText.Text = args.IsSuccess ? "Ready" : $"Offline or unavailable ({args.WebErrorStatus}). Last-known data may still be shown.";
            if (browser == MainWebView && browser.Source is not null) PageTitle.Text = PageName(browser.Source);
        };
        browser.CoreWebView2.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            Process.Start(new ProcessStartInfo(args.Uri) { UseShellExecute = true });
        };
    }

    private async Task CheckHealthAsync()
    {
        try
        {
            using var response = await Http.GetAsync("/health");
            response.EnsureSuccessStatusCode();
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var payload = await JsonDocument.ParseAsync(stream);
            var version = payload.RootElement.GetProperty("data").GetProperty("version").GetString();
            ApiStatusText.Text = $"Online - API {version}";
            ApiStatusText.Foreground = new SolidColorBrush(Color.FromRgb(83, 213, 138));
        }
        catch
        {
            ApiStatusText.Text = "Offline - read-only cache";
            ApiStatusText.Foreground = Brushes.IndianRed;
        }
    }

    private static Uri BuildUri(string destination) => destination switch
    {
        "home" => new Uri(AppUrl),
        "game" => new Uri($"{AppUrl}?view=game"),
        _ => new Uri($"{AppUrl}?tab={Uri.EscapeDataString(destination)}"),
    };

    private void Navigate(string destination)
    {
        if (MainWebView.CoreWebView2 is null) return;
        MainWebView.Source = BuildUri(destination);
    }

    private void Navigate_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string destination }) Navigate(destination);
    }

    private void Back_Click(object sender, RoutedEventArgs e) { if (MainWebView.CanGoBack) MainWebView.GoBack(); }
    private void Forward_Click(object sender, RoutedEventArgs e) { if (MainWebView.CanGoForward) MainWebView.GoForward(); }
    private void Refresh_Click(object sender, RoutedEventArgs e) { MainWebView.CoreWebView2?.Reload(); _ = CheckHealthAsync(); }
    private void Print_Click(object sender, RoutedEventArgs e) => _ = MainWebView.ExecuteScriptAsync("window.print()");
    private void OpenExternal_Click(object sender, RoutedEventArgs e) => Process.Start(new ProcessStartInfo(MainWebView.Source?.AbsoluteUri ?? AppUrl) { UseShellExecute = true });

    private void ToggleDock_Click(object sender, RoutedEventArgs e)
    {
        dockOpen = !dockOpen;
        DockColumn.Width = dockOpen ? new GridLength(410) : new GridLength(0);
        DockPanel.Visibility = dockOpen ? Visibility.Visible : Visibility.Collapsed;
        DockSplitter.Visibility = dockOpen ? Visibility.Visible : Visibility.Collapsed;
        if (dockOpen) MatchupWebView.CoreWebView2?.Reload();
    }

    private void Window_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.D1) { Navigate("home"); e.Handled = true; }
        else if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.D2) { Navigate("team"); e.Handled = true; }
        else if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.D3) { Navigate("gameday"); e.Handled = true; }
        else if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.D) { Navigate("draft"); e.Handled = true; }
        else if (Keyboard.Modifiers == (ModifierKeys.Control | ModifierKeys.Shift) && e.Key == Key.M) { ToggleDock_Click(this, e); e.Handled = true; }
        else if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.P) { Print_Click(this, e); e.Handled = true; }
        else if (Keyboard.Modifiers == ModifierKeys.Alt && e.Key == Key.Left) { Back_Click(this, e); e.Handled = true; }
        else if (Keyboard.Modifiers == ModifierKeys.Alt && e.Key == Key.Right) { Forward_Click(this, e); e.Handled = true; }
        else if (e.Key == Key.F5) { Refresh_Click(this, e); e.Handled = true; }
    }

    private static string PageName(Uri uri)
    {
        var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
        var tab = query["tab"];
        if (!string.IsNullOrWhiteSpace(tab)) return $"League - {char.ToUpperInvariant(tab[0])}{tab[1..]}";
        return query["view"] == "game" ? "Game center" : "League command center";
    }
}
