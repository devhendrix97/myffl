using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace MyFFL.Admin;

public partial class MainWindow : Window
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly DispatcherTimer _playTimer;
    private string? _accessToken;
    private string? _runId;
    private bool _loadingRuntime;

    public MainWindow()
    {
        InitializeComponent();
        _playTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        _playTimer.Tick += async (_, _) => await StepAndRefreshAsync();
    }

    private async void SignIn_Click(object sender, RoutedEventArgs e)
    {
        await RunUiAction(async () =>
        {
            var result = await SendAsync(HttpMethod.Post, "/auth/login", new
            {
                email = EmailTextBox.Text.Trim(), password = PasswordInput.Password, clientType = "native"
            }, authenticated: false);
            _accessToken = result.GetProperty("accessToken").GetString();
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _accessToken);
            ConnectionIndicator.Fill = new SolidColorBrush(Color.FromRgb(34, 197, 94));
            ConnectionText.Text = result.GetProperty("displayName").GetString() ?? "Administrator";
            ProviderControls.IsEnabled = SimulationControls.IsEnabled = true;
            await RefreshAllAsync();
        });
    }

    private async void Sync_Click(object sender, RoutedEventArgs e)
    {
        var resource = (sender as Button)?.Tag?.ToString() ?? "scoreboard";
        await RunUiAction(async () =>
        {
            await SendAsync(HttpMethod.Post, "/api/admin/provider/sync", new { resource });
            StatusText.Text = $"{resource} sync accepted.";
            await Task.Delay(1500);
            await RefreshProviderAsync();
        });
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await RunUiAction(RefreshAllAsync);

    private async void CreateSimulation_Click(object sender, RoutedEventArgs e)
    {
        await RunUiAction(async () =>
        {
            var speed = int.Parse(((ComboBoxItem)SpeedCombo.SelectedItem).Tag.ToString()!);
            var result = await SendAsync(HttpMethod.Post, "/api/admin/simulations", new { speedMultiplier = speed });
            _runId = result.GetProperty("runId").GetString();
            await SetProviderModeAsync("replay");
            await RefreshSimulationAsync();
        });
    }

    private async void SimulationAction_Click(object sender, RoutedEventArgs e)
    {
        if (_runId is null) { StatusText.Text = "Start a test run first."; return; }
        var action = (sender as Button)?.Tag?.ToString() ?? "pause";
        await RunUiAction(async () =>
        {
            await SendAsync(HttpMethod.Post, $"/api/admin/simulations/{_runId}/{action}", new { });
            if (action == "play") _playTimer.Start();
            if (action is "pause" or "stop" or "reset") _playTimer.Stop();
            await RefreshSimulationAsync();
        });
    }

    private async Task StepAndRefreshAsync()
    {
        if (_runId is null) return;
        try
        {
            var result = await SendAsync(HttpMethod.Post, $"/api/admin/simulations/{_runId}/step", new { });
            if (result.GetProperty("status").GetString() == "completed") _playTimer.Stop();
            await RefreshSimulationAsync();
        }
        catch (Exception ex) { _playTimer.Stop(); StatusText.Text = ex.Message; }
    }

    private async Task RefreshAllAsync() { await RefreshProviderAsync(); await RefreshSimulationAsync(); }

    private async Task RefreshProviderAsync()
    {
        var data = await SendAsync(HttpMethod.Get, "/api/admin/provider/dashboard");
        var counts = data.GetProperty("counts");
        TeamsCount.Text = GetCount(counts, "teams"); PlayersCount.Text = GetCount(counts, "players");
        EventsCount.Text = GetCount(counts, "events"); ArchivesCount.Text = GetCount(counts, "archives");
        ActivityText.Text = JsonSerializer.Serialize(data.GetProperty("recentRuns"), new JsonSerializerOptions { WriteIndented = true });
        if (data.TryGetProperty("runtime", out var runtime)) ApplyRuntime(runtime);
    }

    private async void ReplayMode_Checked(object sender, RoutedEventArgs e)
    {
        if (_loadingRuntime) return;
        await RunUiAction(async () =>
        {
            if (_runId is null)
            {
                _loadingRuntime = true;
                ReplayModeToggle.IsChecked = false;
                _loadingRuntime = false;
                throw new InvalidOperationException("Start a test run before enabling replay data.");
            }
            await SetProviderModeAsync("replay");
        });
    }

    private async void ReplayMode_Unchecked(object sender, RoutedEventArgs e)
    {
        if (_loadingRuntime || _accessToken is null) return;
        await RunUiAction(async () => await SetProviderModeAsync("live"));
    }

    private async Task SetProviderModeAsync(string mode)
    {
        var runtime = await SendAsync(HttpMethod.Post, "/api/admin/provider/runtime", new { mode, runId = mode == "replay" ? _runId : null });
        ApplyRuntime(runtime);
    }

    private void ApplyRuntime(JsonElement runtime)
    {
        var mode = runtime.TryGetProperty("mode", out var modeValue) ? modeValue.GetString() : "live";
        if (runtime.TryGetProperty("runId", out var runValue) && runValue.ValueKind == JsonValueKind.String) _runId = runValue.GetString();
        _loadingRuntime = true;
        ReplayModeToggle.IsChecked = mode == "replay";
        _loadingRuntime = false;
        ProviderModeText.Text = mode == "replay" ? "Replay data active" : "Live ESPN data active";
        ProviderModeText.Foreground = new SolidColorBrush(mode == "replay" ? Color.FromRgb(242, 199, 107) : Color.FromRgb(114, 212, 154));
    }

    private async Task RefreshSimulationAsync()
    {
        var data = await SendAsync(HttpMethod.Get, "/api/admin/simulations");
        var runs = data.TryGetProperty("runs", out var runRows) ? runRows : default;
        if (runs.ValueKind != JsonValueKind.Array)
        {
            SimulationStatusText.Text = "No test run loaded.";
            GamesGrid.ItemsSource = null;
            PlayersGrid.ItemsSource = null;
            PlaysGrid.ItemsSource = null;
            return;
        }
        if (_runId is null && runs.GetArrayLength() > 0) _runId = runs[0].GetProperty("runId").GetString();
        var active = data.TryGetProperty("active", out var activeRun) ? activeRun : default;
        SimulationStatusText.Text = active.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined
            ? "No test run loaded."
            : JsonSerializer.Serialize(active, new JsonSerializerOptions { WriteIndented = true });
        GamesGrid.ItemsSource = data.TryGetProperty("games", out var games) && games.ValueKind == JsonValueKind.Array
            ? JsonRows(games)
            : null;
        PlayersGrid.ItemsSource = data.TryGetProperty("players", out var players) && players.ValueKind == JsonValueKind.Array
            ? JsonRows(players)
            : null;
        PlaysGrid.ItemsSource = data.TryGetProperty("plays", out var plays) && plays.ValueKind == JsonValueKind.Array
            ? JsonRows(plays)
            : null;
        var frameCount = data.TryGetProperty("scenario", out var scenario) && scenario.TryGetProperty("frameCount", out var total)
            ? total.GetInt32() : 1;
        var currentFrame = active.ValueKind == JsonValueKind.Object && active.TryGetProperty("currentFrame", out var frame)
            ? frame.GetInt32() : -1;
        SimulationProgress.Maximum = Math.Max(1, frameCount);
        SimulationProgress.Value = Math.Max(0, currentFrame + 1);
        CurrentPlayText.Text = data.TryGetProperty("currentPlay", out var currentPlay) && currentPlay.ValueKind == JsonValueKind.Object && currentPlay.TryGetProperty("playText", out var playText)
            ? playText.GetString() ?? "Waiting for the next play."
            : "Waiting for kickoff.";
    }

    private async Task<JsonElement> SendAsync(HttpMethod method, string path, object? body = null, bool authenticated = true)
    {
        var baseUrl = ApiUrlTextBox.Text.Trim().TrimEnd('/');
        using var request = new HttpRequestMessage(method, baseUrl + path);
        if (body is not null) request.Content = JsonContent.Create(body);
        if (authenticated && _accessToken is null) throw new InvalidOperationException("Sign in first.");
        using var response = await _http.SendAsync(request);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = document.RootElement;
        if (!response.IsSuccessStatusCode)
        {
            var message = root.TryGetProperty("error", out var error) && error.TryGetProperty("message", out var text)
                ? text.GetString() : response.ReasonPhrase;
            throw new InvalidOperationException(message ?? "The request failed.");
        }
        return root.GetProperty("data").Clone();
    }

    private async Task RunUiAction(Func<Task> action)
    {
        try { StatusText.Text = "Working..."; await action(); StatusText.Text = "Ready"; }
        catch (Exception ex) { StatusText.Text = ex.Message; MessageBox.Show(ex.Message, "myFFL Admin", MessageBoxButton.OK, MessageBoxImage.Warning); }
    }

    private static string GetCount(JsonElement counts, string name) => counts.TryGetProperty(name, out var value) ? value.ToString() : "0";
    private static List<Dictionary<string, string>> JsonRows(JsonElement array) => array.EnumerateArray()
        .Select(item => item.EnumerateObject().ToDictionary(property => property.Name, property => property.Value.ToString())).ToList();
}
