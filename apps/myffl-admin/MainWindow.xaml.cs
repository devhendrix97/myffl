using System.Globalization;
using System.Data;
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
    private int? _correctionExpectedRevision;

    public MainWindow()
    {
        InitializeComponent();
        _playTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        _playTimer.Tick += async (_, _) => await StepAndRefreshAsync();
    }

    private async void SignIn_Click(object sender, RoutedEventArgs e) => await RunUiAction(async () =>
    {
        var result = await SendAsync(HttpMethod.Post, "/auth/login", new { email = EmailTextBox.Text.Trim(), password = PasswordInput.Password, clientType = "native" }, false);
        _accessToken = result.GetProperty("accessToken").GetString();
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _accessToken);
        ConnectionIndicator.Fill = Brush("#22C55E");
        ConnectionText.Text = result.GetProperty("displayName").GetString() ?? "Administrator";
        ProviderControls.IsEnabled = SimulationControls.IsEnabled = AdminTabs.IsEnabled = true;
        await RefreshEverythingAsync();
    });

    private async Task RefreshEverythingAsync()
    {
        await RefreshDashboardAsync();
        await SearchUsersAsync();
        await SearchLeaguesAsync();
        await SearchPlayersAsync();
        await LoadEventsAsync();
        await RefreshMonitoringAsync();
        await RefreshProviderAsync();
        await RefreshSimulationAsync();
        await RefreshFantasyProsAsync();
    }

    private async Task RefreshDashboardAsync()
    {
        var data = await SendAsync(HttpMethod.Get, "/api/admin/dashboard");
        var counts = data.GetProperty("counts");
        ActiveUsersCount.Text = Value(counts, "activeUsers");
        ActiveLeaguesCount.Text = Value(counts, "activeLeagues");
        LiveGamesCount.Text = Value(counts, "liveGames");
        FailedRequestsCount.Text = Value(counts, "failedRequests");
        DashboardProviderGrid.ItemsSource = Rows(data, "provider");
        DashboardActivityGrid.ItemsSource = Rows(data, "recentActions");
    }

    private async void SearchUsers_Click(object sender, RoutedEventArgs e) => await RunUiAction(SearchUsersAsync);
    private async Task SearchUsersAsync() { var data = await SendAsync(HttpMethod.Get, $"/api/admin/users?q={Uri.EscapeDataString(UserSearchText.Text.Trim())}"); UsersGrid.ItemsSource = Rows(data, "items"); }
    private async void UsersGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        var id = Selected(UsersGrid, "userId"); if (id is null) return;
        await RunUiAction(async () =>
        {
            var data = await SendAsync(HttpMethod.Get, $"/api/admin/users/{Uri.EscapeDataString(id)}");
            UserDetailText.Text = Pretty(data.GetProperty("user"));
            UserLeaguesGrid.ItemsSource = Rows(data, "leagues"); LoginHistoryGrid.ItemsSource = Rows(data, "loginHistory"); UserDevicesGrid.ItemsSource = Rows(data, "notificationDevices");
        });
    }
    private async void UserAction_Click(object sender, RoutedEventArgs e)
    {
        var id = Selected(UsersGrid, "userId"); if (id is null) return;
        var status = (sender as Button)?.Tag?.ToString();
        await RunUiAction(async () => { await SendAsync(HttpMethod.Post, $"/api/admin/users/{id}/status", new { status, reason = UserReasonText.Text }); await SearchUsersAsync(); });
    }
    private async void RevokeSessions_Click(object sender, RoutedEventArgs e) { var id = Selected(UsersGrid, "userId"); if (id is null) return; await RunUiAction(async () => { await SendAsync(HttpMethod.Post, $"/api/admin/users/{id}/sessions", new { }); }); }
    private async void SetRole_Click(object sender, RoutedEventArgs e)
    {
        var id = Selected(UsersGrid, "userId"); if (id is null) return;
        var role = ((ComboBoxItem)AdminRoleCombo.SelectedItem).Tag?.ToString();
        await RunUiAction(async () => { await SendAsync(HttpMethod.Post, $"/api/admin/users/{id}/role", new { role = string.IsNullOrEmpty(role) ? null : role, reason = UserReasonText.Text }); await SearchUsersAsync(); });
    }

    private async void SearchLeagues_Click(object sender, RoutedEventArgs e) => await RunUiAction(SearchLeaguesAsync);
    private async Task SearchLeaguesAsync() { var data = await SendAsync(HttpMethod.Get, $"/api/admin/leagues?q={Uri.EscapeDataString(LeagueSearchText.Text.Trim())}"); LeaguesGrid.ItemsSource = Rows(data, "items"); }
    private async void LeaguesGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        var id = Selected(LeaguesGrid, "leagueId"); if (id is null) return;
        ScoreLeagueIdText.Text = id;
        await RunUiAction(async () =>
        {
            var data = await SendAsync(HttpMethod.Get, $"/api/admin/leagues/{id}");
            LeagueSettingsGrid.ItemsSource = Rows(data, "settings"); LeagueMembersGrid.ItemsSource = Rows(data, "members"); LeagueTeamsGrid.ItemsSource = Rows(data, "teams"); LeagueScoringGrid.ItemsSource = Rows(data, "scoringVersions"); LeagueTransactionsGrid.ItemsSource = Rows(data, "transactions"); LeagueMatchupsGrid.ItemsSource = Rows(data, "matchups"); LeagueAuditGrid.ItemsSource = Rows(data, "commissionerActions");
            if (data.TryGetProperty("league", out var league) && league.TryGetProperty("league_season_id", out var season)) ScoreSeasonIdText.Text = season.GetString() ?? "";
        });
    }
    private async void LeagueAction_Click(object sender, RoutedEventArgs e) { var id = Selected(LeaguesGrid, "leagueId"); if (id is null) return; var action = (sender as Button)?.Tag?.ToString(); await RunUiAction(async () => { await SendAsync(HttpMethod.Post, $"/api/admin/leagues/{id}/{action}", new { reason = LeagueReasonText.Text }); await SearchLeaguesAsync(); }); }
    private async void RecalculateLeague_Click(object sender, RoutedEventArgs e)
    {
        var id = Selected(LeaguesGrid, "leagueId"); if (id is null) return;
        var weeks = RecalculateWeeksText.Text.Split(',', StringSplitOptions.RemoveEmptyEntries).Select(value => int.Parse(value.Trim(), CultureInfo.InvariantCulture)).ToArray();
        await RunUiAction(async () => { var result = await SendAsync(HttpMethod.Post, $"/api/admin/leagues/{id}/recalculate", new { weeks, reason = LeagueReasonText.Text }); StatusText.Text = $"Recalculation queued: {Value(result, "jobId")}"; });
    }

    private async void SearchPlayers_Click(object sender, RoutedEventArgs e) => await RunUiAction(SearchPlayersAsync);
    private async Task SearchPlayersAsync() { var data = await SendAsync(HttpMethod.Get, $"/api/admin/players?q={Uri.EscapeDataString(PlayerSearchText.Text.Trim())}&limit=1000"); AdminPlayersGrid.ItemsSource = Rows(data, "items"); }
    private async void AdminPlayersGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        var id = Selected(AdminPlayersGrid, "playerId"); if (id is null) return; ScorePlayerIdText.Text = id;
        await RunUiAction(async () => { var data = await SendAsync(HttpMethod.Get, $"/api/admin/players/{id}"); PlayerDetailText.Text = Pretty(data.GetProperty("player")); PlayerMappingsGrid.ItemsSource = Rows(data, "mappings"); PlayerAliasesGrid.ItemsSource = Rows(data, "aliases"); PlayerInjuriesGrid.ItemsSource = Rows(data, "injuries"); PlayerStatsGrid.ItemsSource = Rows(data, "normalizedStats"); });
    }
    private async void SavePlayerMapping_Click(object sender, RoutedEventArgs e)
    {
        var id = Selected(AdminPlayersGrid, "playerId"); if (id is null) return;
        await RunUiAction(async () => { await SendAsync(new HttpMethod("PATCH"), $"/api/admin/players/{id}/mapping", new { position = EmptyNull(PlayerPositionText.Text), teamId = EmptyNull(PlayerTeamText.Text), provider = string.IsNullOrWhiteSpace(PlayerProviderIdText.Text) ? null : "espn", providerPlayerId = EmptyNull(PlayerProviderIdText.Text), alias = EmptyNull(PlayerAliasText.Text), reason = PlayerReasonText.Text }); await SearchPlayersAsync(); });
    }
    private async void MergePlayer_Click(object sender, RoutedEventArgs e) { var id = Selected(AdminPlayersGrid, "playerId"); if (id is null) return; await RunUiAction(async () => { await SendAsync(HttpMethod.Post, $"/api/admin/players/{id}/merge", new { targetPlayerId = MergeTargetText.Text.Trim(), reason = PlayerReasonText.Text }); await SearchPlayersAsync(); }); }

    private async void LoadEvents_Click(object sender, RoutedEventArgs e) => await RunUiAction(LoadEventsAsync);
    private async Task LoadEventsAsync() { var week = int.TryParse(EventWeekText.Text, out var value) ? value : 0; var data = await SendAsync(HttpMethod.Get, $"/api/admin/events?week={week}"); EventsGrid.ItemsSource = Rows(data, "items"); }
    private async void EventsGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        var id = Selected(EventsGrid, "eventId"); if (id is null) return; ScoreEventIdText.Text = id;
        await RunUiAction(async () => { var data = await SendAsync(HttpMethod.Get, $"/api/admin/events/{id}"); EventDetailText.Text = Pretty(data.GetProperty("event")); EventPlayersGrid.ItemsSource = Rows(data, "players"); EventPlaysGrid.ItemsSource = Rows(data, "plays"); EventArchivesGrid.ItemsSource = Rows(data, "rawArchives"); EventActionsGrid.ItemsSource = Rows(data, "adminActions"); });
    }
    private async void EventAction_Click(object sender, RoutedEventArgs e) { var id = Selected(EventsGrid, "eventId"); if (id is null) return; var action = (sender as Button)?.Tag?.ToString(); await RunUiAction(async () => { await SendAsync(HttpMethod.Post, $"/api/admin/events/{id}/action/command", new { action, reason = EventReasonText.Text }); await LoadEventsAsync(); }); }

    private string InvestigationQuery() => $"leagueId={Uri.EscapeDataString(ScoreLeagueIdText.Text.Trim())}&seasonId={Uri.EscapeDataString(ScoreSeasonIdText.Text.Trim())}&eventId={Uri.EscapeDataString(ScoreEventIdText.Text.Trim())}&playerId={Uri.EscapeDataString(ScorePlayerIdText.Text.Trim())}&dataScope={Uri.EscapeDataString(ScoreScopeText.Text.Trim())}";
    private object CorrectionBody(bool includeRevision = true) => new { leagueId = ScoreLeagueIdText.Text.Trim(), seasonId = ScoreSeasonIdText.Text.Trim(), eventId = ScoreEventIdText.Text.Trim(), playerId = ScorePlayerIdText.Text.Trim(), dataScope = ScoreScopeText.Text.Trim(), correctedPoints = decimal.Parse(CorrectedPointsText.Text, CultureInfo.InvariantCulture), expectedRevision = includeRevision ? _correctionExpectedRevision : null, reason = CorrectionReasonText.Text };
    private async void InvestigateScore_Click(object sender, RoutedEventArgs e) => await RunUiAction(async () => { var data = await SendAsync(HttpMethod.Get, $"/api/admin/scoring/investigation?{InvestigationQuery()}"); ApplyInvestigation(data); });
    private async void PreviewCorrection_Click(object sender, RoutedEventArgs e) => await RunUiAction(async () => { var data = await SendAsync(HttpMethod.Post, "/api/admin/corrections/preview", CorrectionBody(false)); ApplyInvestigation(data); var preview = data.GetProperty("preview"); _correctionExpectedRevision = preview.GetProperty("expectedRevision").GetInt32(); CorrectionPreviewText.Text = Pretty(preview); });
    private async void ApplyCorrection_Click(object sender, RoutedEventArgs e) => await RunUiAction(async () => { if (_correctionExpectedRevision is null) throw new InvalidOperationException("Preview the correction first."); var data = await SendAsync(HttpMethod.Post, "/api/admin/corrections/apply", CorrectionBody()); CorrectionIdText.Text = Value(data, "correctionId"); _correctionExpectedRevision = null; CorrectionPreviewText.Text = Pretty(data); });
    private async void RevertCorrection_Click(object sender, RoutedEventArgs e) => await RunUiAction(async () => { var id = CorrectionIdText.Text.Trim(); if (id.Length == 0) throw new InvalidOperationException("Enter a correction ID."); var data = await SendAsync(HttpMethod.Post, $"/api/admin/corrections/{id}/revert", new { reason = CorrectionReasonText.Text }); CorrectionPreviewText.Text = Pretty(data); });
    private void ApplyInvestigation(JsonElement data) { ScoreRawText.Text = Pretty(data.GetProperty("normalizedStats")); ScoreSummaryText.Text = Pretty(data.GetProperty("score")); ScoreComponentsGrid.ItemsSource = Rows(data, "components"); ScoreRevisionsGrid.ItemsSource = Rows(data, "revisionHistory"); }

    private async void RefreshMonitoring_Click(object sender, RoutedEventArgs e) => await RunUiAction(RefreshMonitoringAsync);
    private async Task RefreshMonitoringAsync()
    {
        var data = await SendAsync(HttpMethod.Get, "/api/admin/monitoring"); ResourcesGrid.ItemsSource = Rows(data, "resources"); ShardsGrid.ItemsSource = Rows(data, "shards"); JobsGrid.ItemsSource = Rows(data, "jobs"); ReceiptsGrid.ItemsSource = Rows(data, "scoringReceipts");
        var audit = await SendAsync(HttpMethod.Get, "/api/admin/audit"); GlobalAuditGrid.ItemsSource = Rows(audit, "items");
    }

    private async void Sync_Click(object sender, RoutedEventArgs e) { var resource = (sender as Button)?.Tag?.ToString() ?? "scoreboard"; await RunUiAction(async () => { await SendAsync(HttpMethod.Post, "/api/admin/provider/sync", new { resource }); await Task.Delay(800); await RefreshProviderAsync(); }); }
    private async void RefreshFantasyPros_Click(object sender, RoutedEventArgs e) => await RunUiAction(RefreshFantasyProsAsync);
    private async void SaveFantasyProsCredential_Click(object sender, RoutedEventArgs e) => await RunUiAction(async () =>
    {
        var key = string.IsNullOrWhiteSpace(FantasyProsApiKeyInput.Password) ? null : FantasyProsApiKeyInput.Password.Trim();
        await SendAsync(HttpMethod.Put, "/api/admin/providers/fantasypros/credential", new { apiKey = key, enabled = FantasyProsEnabledToggle.IsChecked == true, reason = FantasyProsReasonText.Text.Trim() });
        FantasyProsApiKeyInput.Password = string.Empty;
        FantasyProsReasonText.Text = string.Empty;
        await RefreshFantasyProsAsync();
    });
    private async void SyncFantasyPros_Click(object sender, RoutedEventArgs e) => await RunUiAction(async () =>
    {
        await SendAsync(HttpMethod.Post, "/api/admin/providers/fantasypros/sync", new { });
        StatusText.Text = "FantasyPros ranking refresh accepted";
        await Task.Delay(1200);
        await RefreshFantasyProsAsync();
    });
    private async void ImportFantasyProsCsv_Click(object sender, RoutedEventArgs e) => await RunUiAction(async () =>
    {
        var scoring = (FantasyProsCsvScoringCombo.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "PPR";
        var result = await SendAsync(HttpMethod.Post, "/api/admin/providers/fantasypros/csv", new
        {
            csv = FantasyProsCsvText.Text,
            seasonYear = int.Parse(FantasyProsCsvSeasonText.Text.Trim(), CultureInfo.InvariantCulture),
            scoring,
            scope = FantasyProsCsvScopeText.Text.Trim(),
            reason = FantasyProsCsvReasonText.Text.Trim()
        });
        FantasyProsCsvResultText.Text = $"Imported {Value(result, "imported")} rows; mapped {Value(result, "mapped")} players for {Value(result, "seasonYear")} {Value(result, "scoring")} {Value(result, "scope")}.";
        FantasyProsCsvReasonText.Text = string.Empty;
        await RefreshFantasyProsAsync();
    });
    private void ClearFantasyProsCsv_Click(object sender, RoutedEventArgs e)
    {
        FantasyProsCsvText.Text = string.Empty;
        FantasyProsCsvResultText.Text = "CSV cleared.";
    }
    private async Task RefreshFantasyProsAsync()
    {
        var data = await SendAsync(HttpMethod.Get, "/api/admin/providers/fantasypros/credential");
        var credential = data.GetProperty("credential");
        var usage = data.GetProperty("usage");
        var configured = credential.TryGetProperty("configured", out var configuredValue) && configuredValue.GetBoolean();
        var enabled = credential.TryGetProperty("enabled", out var enabledValue) && enabledValue.GetBoolean();
        FantasyProsConfiguredText.Text = configured ? enabled ? "Enabled" : "Disabled" : "Not configured";
        FantasyProsConfiguredText.Foreground = Brush(enabled ? "#72D49A" : configured ? "#F2C76B" : "#F87171");
        FantasyProsMaskedKeyText.Text = credential.TryGetProperty("maskedKey", out var masked) ? masked.GetString() ?? "-" : "-";
        FantasyProsValidatedText.Text = credential.TryGetProperty("validatedAtUtc", out var validated) ? validated.GetString() ?? "-" : "-";
        FantasyProsStorageText.Text = $"Storage: {Value(credential, "storage")}";
        FantasyProsUsageText.Text = $"{Value(usage, "requestsUsed")} / {Value(usage, "requestLimit")}";
        FantasyProsEnabledToggle.IsChecked = enabled;
        FantasyProsRunsGrid.ItemsSource = Rows(data, "recentRuns");
    }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await RunUiAction(RefreshEverythingAsync);
    private async void CreateSimulation_Click(object sender, RoutedEventArgs e) => await RunUiAction(async () => { var speed = int.Parse(((ComboBoxItem)SpeedCombo.SelectedItem).Tag.ToString()!); var result = await SendAsync(HttpMethod.Post, "/api/admin/simulations", new { speedMultiplier = speed }); _runId = result.GetProperty("runId").GetString(); await SetProviderModeAsync("replay"); await RefreshSimulationAsync(); });
    private async void SimulationAction_Click(object sender, RoutedEventArgs e) { if (_runId is null) { StatusText.Text = "Start a test run first."; return; } var action = (sender as Button)?.Tag?.ToString() ?? "pause"; await RunUiAction(async () => { await SendAsync(HttpMethod.Post, $"/api/admin/simulations/{_runId}/{action}", new { }); if (action == "play") _playTimer.Start(); if (action is "pause" or "stop" or "reset") _playTimer.Stop(); await RefreshSimulationAsync(); }); }
    private async Task StepAndRefreshAsync() { if (_runId is null) return; try { var result = await SendAsync(HttpMethod.Post, $"/api/admin/simulations/{_runId}/step", new { }); if (result.GetProperty("status").GetString() == "completed") _playTimer.Stop(); await RefreshSimulationAsync(); } catch (Exception ex) { _playTimer.Stop(); StatusText.Text = ex.Message; } }
    private async void ReplayMode_Checked(object sender, RoutedEventArgs e) { if (_loadingRuntime) return; await RunUiAction(async () => { if (_runId is null) { _loadingRuntime = true; ReplayModeToggle.IsChecked = false; _loadingRuntime = false; throw new InvalidOperationException("Start a test run before enabling replay data."); } await SetProviderModeAsync("replay"); }); }
    private async void ReplayMode_Unchecked(object sender, RoutedEventArgs e) { if (_loadingRuntime || _accessToken is null) return; await RunUiAction(async () => await SetProviderModeAsync("live")); }
    private async Task SetProviderModeAsync(string mode) { var runtime = await SendAsync(HttpMethod.Post, "/api/admin/provider/runtime", new { mode, runId = mode == "replay" ? _runId : null }); ApplyRuntime(runtime); }
    private void ApplyRuntime(JsonElement runtime) { var mode = runtime.TryGetProperty("mode", out var value) ? value.GetString() : "live"; if (runtime.TryGetProperty("runId", out var run) && run.ValueKind == JsonValueKind.String) _runId = run.GetString(); _loadingRuntime = true; ReplayModeToggle.IsChecked = mode == "replay"; _loadingRuntime = false; ProviderModeText.Text = mode == "replay" ? "Replay data active" : "Live ESPN data active"; ProviderModeText.Foreground = Brush(mode == "replay" ? "#F2C76B" : "#72D49A"); }
    private async Task RefreshProviderAsync() { var data = await SendAsync(HttpMethod.Get, "/api/admin/provider/dashboard"); var counts = data.GetProperty("counts"); TeamsCount.Text = Value(counts, "teams"); PlayersCount.Text = Value(counts, "players"); EventsCount.Text = Value(counts, "events"); ArchivesCount.Text = Value(counts, "archives"); ActivityText.Text = Pretty(data.GetProperty("recentRuns")); if (data.TryGetProperty("runtime", out var runtime)) ApplyRuntime(runtime); }
    private async Task RefreshSimulationAsync()
    {
        var data = await SendAsync(HttpMethod.Get, "/api/admin/simulations"); var runs = data.TryGetProperty("runs", out var rows) ? rows : default; if (runs.ValueKind != JsonValueKind.Array) return; if (_runId is null && runs.GetArrayLength() > 0) _runId = runs[0].GetProperty("runId").GetString(); var active = data.TryGetProperty("active", out var current) ? current : default; SimulationStatusText.Text = active.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined ? "No test run loaded." : Pretty(active); GamesGrid.ItemsSource = Rows(data, "games"); PlayersGrid.ItemsSource = Rows(data, "players"); PlaysGrid.ItemsSource = Rows(data, "plays"); var frameCount = data.GetProperty("scenario").GetProperty("frameCount").GetInt32(); var frame = active.ValueKind == JsonValueKind.Object && active.TryGetProperty("currentFrame", out var frameValue) ? frameValue.GetInt32() : -1; SimulationProgress.Maximum = Math.Max(1, frameCount); SimulationProgress.Value = Math.Max(0, frame + 1); CurrentPlayText.Text = data.TryGetProperty("currentPlay", out var play) && play.ValueKind == JsonValueKind.Object && play.TryGetProperty("playText", out var text) ? text.GetString() ?? "Waiting." : "Waiting for kickoff.";
    }

    private async Task<JsonElement> SendAsync(HttpMethod method, string path, object? body = null, bool authenticated = true)
    {
        using var request = new HttpRequestMessage(method, ApiUrlTextBox.Text.Trim().TrimEnd('/') + path); if (body is not null) request.Content = JsonContent.Create(body); if (authenticated && _accessToken is null) throw new InvalidOperationException("Sign in first."); using var response = await _http.SendAsync(request); var content = await response.Content.ReadAsStringAsync(); using var document = JsonDocument.Parse(content); var root = document.RootElement; if (!response.IsSuccessStatusCode) { var message = root.TryGetProperty("error", out var error) && error.TryGetProperty("message", out var text) ? text.GetString() : response.ReasonPhrase; throw new InvalidOperationException(message ?? "The request failed."); } return root.GetProperty("data").Clone();
    }
    private async Task RunUiAction(Func<Task> action) { try { StatusText.Text = "Working..."; await action(); StatusText.Text = "Ready"; } catch (Exception ex) { StatusText.Text = ex.Message; MessageBox.Show(ex.Message, "myFFL Admin", MessageBoxButton.OK, MessageBoxImage.Warning); } }
    private static DataView Rows(JsonElement parent, string property) => parent.TryGetProperty(property, out var array) && array.ValueKind == JsonValueKind.Array ? JsonRows(array) : EmptyRows();
    private static DataView JsonRows(JsonElement array)
    {
        var table = new DataTable();
        var rows = array.EnumerateArray().ToList();
        var columns = rows
            .Where(item => item.ValueKind == JsonValueKind.Object)
            .SelectMany(item => item.EnumerateObject().Select(property => property.Name))
            .Distinct()
            .ToList();
        if (columns.Count == 0) columns.Add("value");
        foreach (var column in columns) table.Columns.Add(column);
        foreach (var item in rows)
        {
            var row = table.NewRow();
            if (item.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in item.EnumerateObject())
                    row[property.Name] = property.Value.ValueKind is JsonValueKind.Object or JsonValueKind.Array ? property.Value.GetRawText() : property.Value.ToString();
            }
            else
            {
                row["value"] = item.ToString();
            }
            table.Rows.Add(row);
        }
        return table.DefaultView;
    }
    private static DataView EmptyRows() => new DataTable().DefaultView;
    private static string? Selected(DataGrid grid, string key) => grid.SelectedItem is DataRowView row && row.Row.Table.Columns.Contains(key) ? row[key]?.ToString() : null;
    private static string Value(JsonElement element, string name) => element.TryGetProperty(name, out var value) ? value.ToString() : "0";
    private static string Pretty(JsonElement element) => JsonSerializer.Serialize(element, new JsonSerializerOptions { WriteIndented = true });
    private static string? EmptyNull(string value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    private static SolidColorBrush Brush(string hex) => (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!;
}
