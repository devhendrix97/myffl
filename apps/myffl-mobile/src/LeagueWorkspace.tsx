import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  AuthSessionResponse,
  CreateLeagueRequest,
  CreateLeagueResponse,
  CursorPage,
  DraftPlayerView,
  DraftRoomResponse,
  DraftSetupRequest,
  JoinLeagueResponse,
  LeagueDetail,
  LeagueFormat,
  LeagueInvitationResponse,
  LeaguePrivacy,
  LeagueScheduleInput,
  LeagueSummary,
  RosterPositionLimitInput,
  RosterSlotInput,
  ScoringCalculationType,
  ScoringCatalogResponse,
  ScoringConfiguration,
  ScoringEffectiveScope,
  ScoringPreviewResponse,
  ScoringRule,
  ScoringVersionSummary,
  UpdateLeagueSettingsRequest,
} from "@myffl/api-contracts";
import {
  Archive,
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Calculator,
  Check,
  ChevronRight,
  Clipboard,
  Copy,
  Gauge,
  History,
  Home,
  KeyRound,
  ListChecks,
  ListPlus,
  LoaderCircle,
  Lock,
  LogOut,
  Menu,
  Plus,
  Play,
  Pause,
  RefreshCw,
  Radio,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SkipForward,
  Trophy,
  Undo2,
  UserPlus,
  Users,
  X,
} from "lucide-react";

const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ??
  (isLocalHost ? "http://localhost:8787" : "https://api.myfflapp.com");

type WorkspaceView = "home" | "create" | "join" | "league" | "game";
type LeagueTab = "overview" | "members" | "draft" | "scoring" | "settings";

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface SimulationGame {
  eventId: string; status: string; statusDetail: string; period: number; clock: string;
  homeScore: number; awayScore: number; homeTeam: string; awayTeam: string;
}
interface SimulationPlay {
  playId: string; sequenceNumber: number; driveId: string; period: number; clock: string;
  playType: string; playText: string; statYardage: number; homeScore: number; awayScore: number;
  scoringPlay: number; turnover: number;
}
interface ScoreBreakdown { displayName: string; rawValue: number | number[]; points: number; explanation: string }
interface SimulationPlayer {
  eventId: string; playerId: string; displayName: string; position: string; team?: string;
  stats: Record<string, string>; fantasyPoints?: number; scoreRevision?: number; scoringBreakdown: ScoreBreakdown[];
}
interface GameFeed {
  games: SimulationGame[]; players: SimulationPlayer[]; plays: SimulationPlay[]; currentPlay: SimulationPlay | null;
  scoring: { leagueId: string; leagueName: string; versionNumber: number } | null;
}

class LeagueApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
  }
}

async function leagueRequest<T>(
  path: string,
  accessToken: string,
  options: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.ok || !payload.data) {
    throw new LeagueApiError(
      payload.error?.message ?? "The request could not be completed.",
      payload.error?.code ?? "request_failed",
      response.status,
    );
  }
  return payload.data;
}

export function LeagueWorkspace({
  session,
  onLogout,
}: {
  session: AuthSessionResponse;
  onLogout: () => Promise<void>;
}) {
  const [view, setView] = useState<WorkspaceView>(() =>
    new URLSearchParams(window.location.search).has("join") ? "join" : "home",
  );
  const [leagues, setLeagues] = useState<LeagueSummary[]>([]);
  const [selectedLeague, setSelectedLeague] = useState<LeagueDetail | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    loadLeagues();
  }, [session.accessToken]);

  async function loadLeagues() {
    setBusy(true);
    setError("");
    try {
      const page = await leagueRequest<CursorPage<LeagueSummary>>(
        "/api/leagues?limit=50",
        session.accessToken,
      );
      setLeagues(page.items);
    } catch (requestError) {
      handleError(requestError);
    } finally {
      setBusy(false);
    }
  }

  function handleError(requestError: unknown) {
    if (requestError instanceof LeagueApiError && requestError.status === 401) {
      void onLogout();
      return;
    }
    setError(requestError instanceof Error ? requestError.message : "The request could not be completed.");
  }

  async function openLeague(leagueId: string) {
    setBusy(true);
    setError("");
    try {
      setSelectedLeague(
        await leagueRequest<LeagueDetail>(`/api/leagues/${leagueId}`, session.accessToken),
      );
      setView("league");
      setSidebarOpen(false);
    } catch (requestError) {
      handleError(requestError);
    } finally {
      setBusy(false);
    }
  }

  function acceptLeague(league: LeagueDetail) {
    setSelectedLeague(league);
    setLeagues((current) => [detailToSummary(league), ...current.filter((item) => item.leagueId !== league.leagueId)]);
    setView("league");
  }

  return (
    <main className="league-app-shell">
      <aside className={`league-sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="league-brand-row">
          <BrandMark />
          <button className="icon-button sidebar-close" type="button" onClick={() => setSidebarOpen(false)} aria-label="Close navigation">
            <X size={20} />
          </button>
        </div>
        <nav aria-label="Primary">
          <button className={view === "home" ? "active" : ""} type="button" onClick={() => { setView("home"); setSidebarOpen(false); }}>
            <Home size={19} /> Home
          </button>
          <button className={view === "create" ? "active" : ""} type="button" onClick={() => { setView("create"); setSidebarOpen(false); }}>
            <Plus size={19} /> Create league
          </button>
          <button className={view === "join" ? "active" : ""} type="button" onClick={() => { setView("join"); setSidebarOpen(false); }}>
            <UserPlus size={19} /> Join league
          </button>
          <button className={view === "game" ? "active" : ""} type="button" onClick={() => { setView("game"); setSidebarOpen(false); }}>
            <Radio size={19} /> Game center
          </button>
        </nav>
        {leagues.length > 0 && (
          <div className="sidebar-leagues">
            <p>My leagues</p>
            {leagues.slice(0, 8).map((league) => (
              <button key={league.leagueId} type="button" onClick={() => void openLeague(league.leagueId)}>
                <span className="league-monogram">{monogram(league.leagueName)}</span>
                <span>{league.leagueName}<small>{league.seasonYear}</small></span>
              </button>
            ))}
          </div>
        )}
        <button className="sidebar-signout" type="button" onClick={() => void onLogout()}>
          <LogOut size={19} /> Sign out
        </button>
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" type="button" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" />}

      <section className="league-workspace">
        <header className="league-topbar">
          <button className="icon-button mobile-menu" type="button" onClick={() => setSidebarOpen(true)} aria-label="Open navigation">
            <Menu size={21} />
          </button>
          <div>
            <p className="eyebrow">{view === "league" && selectedLeague ? selectedLeague.leagueName : "League command center"}</p>
            <strong>{session.displayName}</strong>
          </div>
          <div className="user-avatar" aria-label={`Signed in as ${session.displayName}`}>
            {session.displayName.slice(0, 2).toUpperCase()}
          </div>
        </header>

        {error && <InlineAlert message={error} onClose={() => setError("")} />}
        {busy && view !== "create" && view !== "join" && view !== "game" ? (
          <div className="workspace-loading"><LoaderCircle className="spin" size={28} /><span>Loading leagues</span></div>
        ) : view === "create" ? (
          <CreateLeagueWizard
            accessToken={session.accessToken}
            onCancel={() => setView("home")}
            onCreated={(response) => acceptLeague(response.league)}
          />
        ) : view === "join" ? (
          <JoinLeague
            accessToken={session.accessToken}
            initialCode={new URLSearchParams(window.location.search).get("join") ?? ""}
            onCancel={() => setView("home")}
            onJoined={(response) => acceptLeague(response.league)}
          />
        ) : view === "league" && selectedLeague ? (
          <LeagueDetailView
            league={selectedLeague}
            accessToken={session.accessToken}
            onBack={() => setView("home")}
            onChanged={acceptLeague}
          />
        ) : view === "game" ? (
          <GameCenterView accessToken={session.accessToken} leagues={leagues} />
        ) : (
          <LeagueHome
            session={session}
            leagues={leagues}
            onCreate={() => setView("create")}
            onJoin={() => setView("join")}
            onOpen={(leagueId) => void openLeague(leagueId)}
          />
        )}
      </section>
    </main>
  );
}

function GameCenterView({ accessToken, leagues }: { accessToken: string; leagues: LeagueSummary[] }) {
  const [dashboard, setDashboard] = useState<GameFeed | null>(null);
  const [error, setError] = useState("");
  const [leagueId, setLeagueId] = useState(leagues[0]?.leagueId ?? "");

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const query = leagueId ? `?leagueId=${encodeURIComponent(leagueId)}` : "";
        const next = await leagueRequest<GameFeed>(`/api/games/current${query}`, accessToken);
        if (active) { setDashboard(next); setError(""); }
      } catch (requestError) {
        if (active) setError(requestError instanceof Error ? requestError.message : "Unable to load Game Center.");
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [accessToken, leagueId]);

  const game = dashboard?.games[0];
  return (
    <div className="league-page live-test-page">
      <header className="page-heading"><div><p className="eyebrow">NFL live data</p><h1>Game center</h1></div><div className="game-center-controls">{leagues.length > 0 && <label><span>Scoring for</span><select value={leagueId} onChange={(event) => setLeagueId(event.target.value)}>{leagues.map((league) => <option key={league.leagueId} value={league.leagueId}>{league.leagueName}</option>)}</select></label>}{game && <span className={`test-run-state ${game.status}`}>{game.status === "post" ? "final" : game.statusDetail}</span>}</div></header>
      {error && <InlineAlert message={error} onClose={() => setError("")} />}
      {!game ? (
        <section className="test-empty"><Activity size={32}/><h2>No active game data</h2><p>Scheduled and live NFL games will appear here.</p></section>
      ) : <>
        <section className="test-scoreboard">
          <div><span className="test-team-mark away">{game.awayTeam}</span><strong>{game.awayScore}</strong></div>
          <section><span>{game.status === "post" ? "FINAL" : game.statusDetail}</span><b>{game.clock}</b><small>{game.status === "pre" ? "Scheduled" : "Game in progress"}</small></section>
          <div><strong>{game.homeScore}</strong><span className="test-team-mark home">{game.homeTeam}</span></div>
        </section>
        {dashboard.currentPlay && <section className={`current-play ${dashboard.currentPlay.scoringPlay ? "score" : ""}`}><p>Q{dashboard.currentPlay.period} {dashboard.currentPlay.clock} · {dashboard.currentPlay.playType}</p><strong>{dashboard.currentPlay.playText}</strong><span>{dashboard.currentPlay.awayScore} - {dashboard.currentPlay.homeScore}</span></section>}
        <div className="test-game-grid">
          <section className="test-data-section"><div className="section-heading"><div><p className="eyebrow">{dashboard.scoring ? `${dashboard.scoring.leagueName} - scoring v${dashboard.scoring.versionNumber}` : "Provider box score"}</p><h2>Player statistics</h2></div><RefreshCw size={18}/></div><div className="test-player-list">{dashboard.players.map((player) => <div key={`${player.eventId}-${player.playerId}`}><span><b>{player.displayName}</b><small>{player.team} {player.position}</small></span><code>{formatProviderStats(player.stats)}</code>{player.fantasyPoints !== undefined && <strong className="fantasy-points">{formatFantasyPoints(player.fantasyPoints)} pts</strong>}{player.scoringBreakdown.length > 0 && <details><summary>Point breakdown</summary><div>{player.scoringBreakdown.map((item) => <p key={item.displayName}><span>{item.displayName}</span><small>{formatRawValue(item.rawValue)}</small><b className={item.points < 0 ? "negative" : ""}>{item.points > 0 ? "+" : ""}{formatFantasyPoints(item.points)}</b></p>)}</div></details>}</div>)}</div></section>
          <section className="test-data-section"><div className="section-heading"><div><p className="eyebrow">Game feed</p><h2>Play by play</h2></div><Radio size={18}/></div><div className="test-play-list">{dashboard.plays.map((play) => <div className={play.scoringPlay ? "score" : play.turnover ? "turnover" : ""} key={play.playId}><time>Q{play.period} {play.clock}</time><p>{play.playText}</p><strong>{play.awayScore}-{play.homeScore}</strong></div>)}</div></section>
        </div>
      </>}
    </div>
  );
}

function formatProviderStats(stats: Record<string, string>): string {
  return Object.entries(stats).filter(([, value]) => value !== "0").map(([key, value]) => `${key.split(":")[1]} ${value}`).join("  ·  ") || "No recorded stats";
}

function formatFantasyPoints(value: number): string {
  return value.toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatRawValue(value: number | number[]): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function LeagueHome({
  session,
  leagues,
  onCreate,
  onJoin,
  onOpen,
}: {
  session: AuthSessionResponse;
  leagues: LeagueSummary[];
  onCreate: () => void;
  onJoin: () => void;
  onOpen: (leagueId: string) => void;
}) {
  return (
    <div className="league-page home-page">
      <header className="page-heading">
        <div><p className="eyebrow">Home</p><h1>Welcome, {session.displayName}</h1></div>
        <div className="heading-actions">
          <button className="outline-button compact" type="button" onClick={onJoin}><UserPlus size={17} /> Join</button>
          <button className="primary-button compact" type="button" onClick={onCreate}><Plus size={17} /> Create league</button>
        </div>
      </header>

      {leagues.length === 0 ? (
        <section className="league-zero-state">
          <div className="field-lines" aria-hidden="true" />
          <div>
            <p className="eyebrow">2026 season</p>
            <h2>Build your first league</h2>
            <p>Set the format, roster, schedule, and invitation access from one guided setup.</p>
            <div className="zero-actions">
              <button className="primary-button" type="button" onClick={onCreate}><Trophy size={18} /> Create league</button>
              <button className="outline-button" type="button" onClick={onJoin}><KeyRound size={18} /> Enter invitation</button>
            </div>
          </div>
        </section>
      ) : (
        <section className="league-list-section">
          <div className="section-heading"><div><p className="eyebrow">Current season</p><h2>My leagues</h2></div><span>{leagues.length} total</span></div>
          <div className="league-grid">
            {leagues.map((league) => (
              <button className="league-card" key={league.leagueId} type="button" onClick={() => onOpen(league.leagueId)}>
                <div className="league-card-top">
                  <span className="league-crest">{monogram(league.leagueName)}</span>
                  <span className={`league-state ${league.status}`}>{league.status}</span>
                </div>
                <h3>{league.leagueName}</h3>
                <p>{formatRole(league.role)} - {league.seasonYear}</p>
                <div className="league-card-stats">
                  <span><Users size={16} /> {league.teamCount}/{league.maxTeams}</span>
                  <span>{league.privacy === "private" ? <Lock size={15} /> : <ShieldCheck size={15} />} {league.privacy}</span>
                </div>
                <span className="open-label">Open league <ChevronRight size={17} /></span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const initialRosterSlots: RosterSlotInput[] = [
  { slotType: "QB", displayName: "Quarterback", count: 1, eligiblePositions: ["QB"], contributesPoints: true },
  { slotType: "RB", displayName: "Running Back", count: 2, eligiblePositions: ["RB"], contributesPoints: true },
  { slotType: "WR", displayName: "Wide Receiver", count: 2, eligiblePositions: ["WR"], contributesPoints: true },
  { slotType: "TE", displayName: "Tight End", count: 1, eligiblePositions: ["TE"], contributesPoints: true },
  { slotType: "FLEX", displayName: "Flex", count: 1, eligiblePositions: ["RB", "WR", "TE"], contributesPoints: true },
  { slotType: "SUPERFLEX", displayName: "Superflex", count: 0, eligiblePositions: ["QB", "RB", "WR", "TE"], contributesPoints: true },
  { slotType: "K", displayName: "Kicker", count: 1, eligiblePositions: ["K"], contributesPoints: true },
  { slotType: "DST", displayName: "Defense", count: 1, eligiblePositions: ["DST"], contributesPoints: true },
  { slotType: "DL", displayName: "Defensive Line", count: 0, eligiblePositions: ["DL"], contributesPoints: true },
  { slotType: "LB", displayName: "Linebacker", count: 0, eligiblePositions: ["LB"], contributesPoints: true },
  { slotType: "DB", displayName: "Defensive Back", count: 0, eligiblePositions: ["DB"], contributesPoints: true },
  { slotType: "IDP_FLEX", displayName: "IDP Flex", count: 0, eligiblePositions: ["DL", "LB", "DB"], contributesPoints: true },
  { slotType: "BENCH", displayName: "Bench", count: 6, eligiblePositions: ["QB", "RB", "WR", "TE", "K", "DST"], contributesPoints: false },
  { slotType: "IR", displayName: "Injured Reserve", count: 2, eligiblePositions: ["QB", "RB", "WR", "TE", "K", "DST"], contributesPoints: false },
  { slotType: "PUP", displayName: "PUP", count: 0, eligiblePositions: ["QB", "RB", "WR", "TE", "K", "DST"], contributesPoints: false },
  { slotType: "TAXI", displayName: "Taxi Squad", count: 0, eligiblePositions: ["QB", "RB", "WR", "TE"], contributesPoints: false },
];

const initialRosterPositionLimits: RosterPositionLimitInput[] = [
  { position: "QB", displayName: "Quarterback", minimum: 1, maximum: 3 },
  { position: "RB", displayName: "Running Back", minimum: 2, maximum: 8 },
  { position: "WR", displayName: "Wide Receiver", minimum: 2, maximum: 8 },
  { position: "TE", displayName: "Tight End", minimum: 1, maximum: 4 },
  { position: "K", displayName: "Kicker", minimum: 1, maximum: 3 },
  { position: "DST", displayName: "Team Defense", minimum: 1, maximum: 3 },
  { position: "DL", displayName: "Defensive Line", minimum: 0, maximum: 8 },
  { position: "LB", displayName: "Linebacker", minimum: 0, maximum: 8 },
  { position: "DB", displayName: "Defensive Back", minimum: 0, maximum: 8 },
];

const initialSchedule: LeagueScheduleInput = {
  regularSeasonStartWeek: 1,
  regularSeasonEndWeek: 14,
  scheduleMethod: "round-robin",
  playoffTeamCount: 6,
  playoffStartWeek: 15,
  playoffRoundLength: 1,
  reseed: true,
  consolationBracket: true,
  thirdPlaceMatchup: true,
};

function defaultLeagueDraft(): CreateLeagueRequest {
  return {
    requestId: crypto.randomUUID(),
    leagueName: "",
    description: "",
    privacy: "private",
    teamCount: 12,
    seasonYear: new Date().getFullYear(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago",
    format: "redraft",
    scoringPreset: "full-ppr",
    commissionerTeamName: "",
    rosterSlots: initialRosterSlots.map((slot) => ({ ...slot, eligiblePositions: [...slot.eligiblePositions] })),
    rosterPositionLimits: initialRosterPositionLimits.map((limit) => ({ ...limit })),
    schedule: { ...initialSchedule },
  };
}

function CreateLeagueWizard({
  accessToken,
  onCancel,
  onCreated,
}: {
  accessToken: string;
  onCancel: () => void;
  onCreated: (response: CreateLeagueResponse) => void;
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(defaultLeagueDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreateLeagueResponse | null>(null);
  const steps = ["Basics", "Format", "Rosters", "Schedule", "Review"];

  function update<K extends keyof CreateLeagueRequest>(key: K, value: CreateLeagueRequest[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function next() {
    const issue = validateWizardStep(step, draft);
    if (issue) { setError(issue); return; }
    setError("");
    setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      setCreated(await leagueRequest<CreateLeagueResponse>("/api/leagues", accessToken, { method: "POST", body: draft }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "League creation failed.");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="league-page wizard-page creation-complete">
        <div className="success-seal"><Check size={34} /></div>
        <p className="eyebrow">League created</p>
        <h1>{created.league.leagueName}</h1>
        <p>Your league is ready. Share this invitation with the managers you want to bring in.</p>
        <InvitationCode code={created.invitationCode} link={created.invitationLink} />
        <button className="primary-button" type="button" onClick={() => onCreated(created)}>
          Open league <ArrowRight size={18} />
        </button>
      </div>
    );
  }

  return (
    <div className="league-page wizard-page">
      <header className="page-heading">
        <div><p className="eyebrow">Guided setup</p><h1>Create a league</h1></div>
        <button className="icon-button" type="button" onClick={onCancel} aria-label="Close league setup"><X size={21} /></button>
      </header>
      <ol className="wizard-progress" aria-label="League creation progress">
        {steps.map((label, index) => (
          <li className={index === step ? "active" : index < step ? "complete" : ""} key={label}>
            <span>{index < step ? <Check size={14} /> : index + 1}</span><small>{label}</small>
          </li>
        ))}
      </ol>
      {error && <InlineAlert message={error} onClose={() => setError("")} />}
      <section className="wizard-content">
        {step === 0 && <BasicsStep draft={draft} update={update} />}
        {step === 1 && <FormatStep draft={draft} update={update} />}
        {step === 2 && <RosterStep slots={draft.rosterSlots} limits={draft.rosterPositionLimits} onSlotsChange={(rosterSlots) => update("rosterSlots", rosterSlots)} onLimitsChange={(rosterPositionLimits) => update("rosterPositionLimits", rosterPositionLimits)} />}
        {step === 3 && <ScheduleStep schedule={draft.schedule} teamCount={draft.teamCount} onChange={(schedule) => update("schedule", schedule)} />}
        {step === 4 && <ReviewStep draft={draft} />}
      </section>
      <footer className="wizard-actions">
        <button className="outline-button" type="button" onClick={step === 0 ? onCancel : () => setStep((current) => current - 1)}>
          <ArrowLeft size={18} /> {step === 0 ? "Cancel" : "Back"}
        </button>
        {step < steps.length - 1 ? (
          <button className="primary-button" type="button" onClick={next}>Continue <ArrowRight size={18} /></button>
        ) : (
          <button className="primary-button" type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? <LoaderCircle className="spin" size={18} /> : <Trophy size={18} />} Create league
          </button>
        )}
      </footer>
    </div>
  );
}

function BasicsStep({
  draft,
  update,
}: {
  draft: CreateLeagueRequest;
  update: <K extends keyof CreateLeagueRequest>(key: K, value: CreateLeagueRequest[K]) => void;
}) {
  return (
    <div className="wizard-step">
      <StepHeading icon={<Trophy size={22} />} title="League basics" subtitle="Name the competition and choose who can discover it." />
      <div className="form-grid">
        <Field label="League name" wide><input value={draft.leagueName} maxLength={60} onChange={(event) => update("leagueName", event.target.value)} placeholder="Sunday Night Legends" /></Field>
        <Field label="Your team name" wide><input value={draft.commissionerTeamName} maxLength={40} onChange={(event) => update("commissionerTeamName", event.target.value)} placeholder="Gridiron Gang" /></Field>
        <Field label="Description" wide><textarea value={draft.description} maxLength={500} onChange={(event) => update("description", event.target.value)} placeholder="What makes this league yours?" /></Field>
        <Field label="League access">
          <select value={draft.privacy} onChange={(event) => update("privacy", event.target.value as LeaguePrivacy)}><option value="private">Private</option><option value="public">Public</option></select>
        </Field>
        <Field label="Teams"><input type="number" min={4} max={32} value={draft.teamCount} onChange={(event) => update("teamCount", Number(event.target.value))} /></Field>
        <Field label="Season"><input type="number" min={new Date().getFullYear() - 1} max={new Date().getFullYear() + 2} value={draft.seasonYear} onChange={(event) => update("seasonYear", Number(event.target.value))} /></Field>
        <Field label="Time zone">
          <select value={draft.timeZone} onChange={(event) => update("timeZone", event.target.value)}>
            {timeZones.map((zone) => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}
          </select>
        </Field>
      </div>
    </div>
  );
}

function FormatStep({
  draft,
  update,
}: {
  draft: CreateLeagueRequest;
  update: <K extends keyof CreateLeagueRequest>(key: K, value: CreateLeagueRequest[K]) => void;
}) {
  const formats: Array<{ value: LeagueFormat; label: string; description: string }> = [
    { value: "single-season", label: "Single Season", description: "A one-year league for an office pool, event, or group that does not need to renew." },
    { value: "redraft", label: "Redraft", description: "A continuing league with a fresh player draft every season." },
    { value: "keeper", label: "Keeper", description: "Carry selected players into next year." },
    { value: "dynasty", label: "Dynasty", description: "Retain full rosters across seasons." },
    { value: "best-ball", label: "Best Ball", description: "Optimal lineups are selected automatically." },
  ];
  const scoring = [
    { value: "standard", label: "Standard", description: "Receptions earn no points. Scoring comes from yards, touchdowns, kicking, and defense." },
    { value: "half-ppr", label: "Half PPR", description: "Each catch earns 0.5 points, balancing receivers with runners and touchdown scorers." },
    { value: "full-ppr", label: "Full PPR", description: "Each catch earns 1 point, rewarding high-volume receivers and pass-catching backs." },
    { value: "superflex", label: "Superflex", description: "Full PPR with a flex spot that can start a quarterback, making quarterbacks more valuable." },
    { value: "te-premium", label: "TE Premium", description: "Full PPR plus an extra 0.5 points for every reception made by a tight end." },
    { value: "idp", label: "IDP", description: "Full PPR offense plus individual defenders scoring tackles, sacks, and interceptions." },
  ] as const;
  return (
    <div className="wizard-step">
      <StepHeading icon={<Gauge size={22} />} title="Format and scoring" subtitle="Choose a starting structure. Commissioners can customize every scoring rule after setup." />
      <h3 className="control-heading">League format</h3>
      <div className="choice-grid">
        {formats.map((format) => (
          <button className={draft.format === format.value ? "selected" : ""} type="button" key={format.value} onClick={() => update("format", format.value)}>
            <strong>{format.label}</strong><span>{format.description}</span>{draft.format === format.value && <Check size={18} />}
          </button>
        ))}
      </div>
      <h3 className="control-heading">Scoring starting point</h3>
      <div className="choice-grid scoring-options">
        {scoring.map(({ value, label, description }) => (
          <button className={draft.scoringPreset === value ? "selected" : ""} type="button" key={value} onClick={() => update("scoringPreset", value)}>
            <strong>{label}</strong><span>{description}</span>{draft.scoringPreset === value && <Check size={18} />}
          </button>
        ))}
      </div>
    </div>
  );
}

function RosterStep({
  slots,
  limits,
  onSlotsChange,
  onLimitsChange,
}: {
  slots: RosterSlotInput[];
  limits: RosterPositionLimitInput[];
  onSlotsChange: (slots: RosterSlotInput[]) => void;
  onLimitsChange: (limits: RosterPositionLimitInput[]) => void;
}) {
  const supplementalTypes = new Set(["IR", "PUP", "TAXI"]);
  const lineupSize = slots.filter((slot) => slot.contributesPoints).reduce((sum, slot) => sum + slot.count, 0);
  const activeRosterSize = slots.filter((slot) => !supplementalTypes.has(slot.slotType)).reduce((sum, slot) => sum + slot.count, 0);
  const supplementalSize = slots.filter((slot) => supplementalTypes.has(slot.slotType)).reduce((sum, slot) => sum + slot.count, 0);
  const benchSize = activeRosterSize - lineupSize;
  function setCount(index: number, count: number) {
    const previous = slots[index];
    const nextCount = Math.max(0, Math.min(20, count));
    onSlotsChange(slots.map((slot, slotIndex) => slotIndex === index ? { ...slot, count: nextCount } : slot));
    if (previous.contributesPoints && previous.eligiblePositions.length === 1) {
      const position = previous.eligiblePositions[0];
      onLimitsChange(limits.map((limit) => limit.position === position && limit.minimum === previous.count
        ? { ...limit, minimum: nextCount, maximum: Math.max(limit.maximum, nextCount) }
        : limit));
    }
  }
  function updateSlot(index: number, update: Partial<RosterSlotInput>) {
    onSlotsChange(slots.map((slot, slotIndex) => slotIndex === index ? { ...slot, ...update } : slot));
  }
  function updateLimit(index: number, update: Partial<RosterPositionLimitInput>) {
    onLimitsChange(limits.map((limit, limitIndex) => limitIndex === index ? { ...limit, ...update } : limit));
  }
  function addCustomSlot() {
    const number = slots.filter((slot) => slot.slotType.startsWith("CUSTOM_")).length + 1;
    onSlotsChange([...slots, {
      slotType: `CUSTOM_${number}`,
      displayName: `Custom Slot ${number}`,
      count: 1,
      eligiblePositions: ["RB", "WR", "TE"],
      contributesPoints: true,
    }]);
  }
  return (
    <div className="wizard-step">
      <StepHeading icon={<ListChecks size={22} />} title="Roster and lineup" subtitle="Set required starters, active-roster capacity, supplemental reserves, and position limits." />
      <div className="roster-metrics">
        <div><strong>{lineupSize}</strong><span>Starting lineup</span></div>
        <div><strong>{benchSize}</strong><span>Bench spots</span></div>
        <div><strong>{activeRosterSize}</strong><span>Active roster</span></div>
        <div><strong>{supplementalSize}</strong><span>IR / PUP / taxi</span></div>
        <div><strong>{activeRosterSize + supplementalSize}</strong><span>Total capacity</span></div>
      </div>
      <div className="roster-control-heading"><div><h3>Lineup and reserve slots</h3><p>Starting slots must be filled for a complete lineup. Bench spots count toward the active roster; IR, PUP, and taxi spots do not.</p></div><button className="outline-button compact" type="button" onClick={addCustomSlot}><Plus size={16} /> Custom slot</button></div>
      <div className="roster-table" role="table" aria-label="Roster slot configuration">
        <div className="roster-row roster-header" role="row"><span>Slot</span><span>Eligible positions</span><span>Count</span></div>
        {slots.map((slot, index) => (
          <div className="roster-row" role="row" key={slot.slotType}>
            <span>{slot.slotType.startsWith("CUSTOM_") ? <input className="custom-slot-name" aria-label={`${slot.displayName} name`} value={slot.displayName} onChange={(event) => updateSlot(index, { displayName: event.target.value })} /> : <strong>{slot.displayName}</strong>}<small>{slot.contributesPoints ? "Required starter" : supplementalTypes.has(slot.slotType) ? "Supplemental reserve" : "Active reserve"}</small></span>
            <details className="slot-position-control"><summary>{slot.eligiblePositions.join(" / ") || "Choose positions"}</summary><div>{rosterPositions.map((position) => <label key={position}><input type="checkbox" checked={slot.eligiblePositions.includes(position)} onChange={(event) => updateSlot(index, { eligiblePositions: event.target.checked ? [...slot.eligiblePositions, position] : slot.eligiblePositions.filter((item) => item !== position) })} />{position}</label>)}</div></details>
            <input aria-label={`${slot.displayName} count`} type="number" min={0} max={20} value={slot.count} onChange={(event) => setCount(index, Number(event.target.value))} />
            {slot.slotType.startsWith("CUSTOM_") && <div className="custom-slot-controls"><Toggle label="Counts in the starting lineup" checked={slot.contributesPoints} onChange={(contributesPoints) => updateSlot(index, { contributesPoints })} /><button className="icon-button" type="button" onClick={() => onSlotsChange(slots.filter((_, slotIndex) => slotIndex !== index))} aria-label={`Remove ${slot.displayName}`}><X size={16} /></button></div>}
          </div>
        ))}
      </div>
      <div className="roster-control-heading position-limit-heading"><div><h3>Active-roster position limits</h3><p>The minimum is how many players at that position each team must carry. The maximum caps drafting, adds, waivers, and trades.</p></div></div>
      <div className="position-limit-table" role="table" aria-label="Active roster position limits">
        <div className="position-limit-row position-limit-header" role="row"><span>Position</span><span>Required starters</span><span>Minimum</span><span>Maximum</span></div>
        {limits.map((limit, index) => {
          const required = slots.filter((slot) => slot.contributesPoints && slot.eligiblePositions.length === 1 && slot.eligiblePositions[0] === limit.position).reduce((sum, slot) => sum + slot.count, 0);
          return <div className="position-limit-row" role="row" key={limit.position}><span><strong>{limit.position}</strong><small>{limit.displayName}</small></span><span>{required}</span><input aria-label={`${limit.displayName} minimum`} type="number" min={required} max={activeRosterSize} value={limit.minimum} onChange={(event) => updateLimit(index, { minimum: Number(event.target.value), maximum: Math.max(limit.maximum, Number(event.target.value)) })} /><input aria-label={`${limit.displayName} maximum`} type="number" min={limit.minimum} max={activeRosterSize} value={limit.maximum} onChange={(event) => updateLimit(index, { maximum: Number(event.target.value) })} /></div>;
        })}
      </div>
    </div>
  );
}

function ScheduleStep({ schedule, teamCount, onChange }: { schedule: LeagueScheduleInput; teamCount: number; onChange: (schedule: LeagueScheduleInput) => void }) {
  function update<K extends keyof LeagueScheduleInput>(key: K, value: LeagueScheduleInput[K]) {
    onChange({ ...schedule, [key]: value });
  }
  return (
    <div className="wizard-step">
      <StepHeading icon={<CalendarDays size={22} />} title="Schedule and playoffs" subtitle="Set the season boundaries now; individual matchups are generated after teams join." />
      <div className="form-grid">
        <Field label="Regular season starts"><input type="number" min={1} max={18} value={schedule.regularSeasonStartWeek} onChange={(event) => update("regularSeasonStartWeek", Number(event.target.value))} /></Field>
        <Field label="Regular season ends"><input type="number" min={1} max={18} value={schedule.regularSeasonEndWeek} onChange={(event) => update("regularSeasonEndWeek", Number(event.target.value))} /></Field>
        <Field label="Schedule method"><select value={schedule.scheduleMethod} onChange={(event) => update("scheduleMethod", event.target.value as LeagueScheduleInput["scheduleMethod"])}><option value="round-robin">Round robin</option><option value="random">Randomized</option></select></Field>
        <Field label="Playoff teams"><input type="number" min={2} max={teamCount} value={schedule.playoffTeamCount} onChange={(event) => update("playoffTeamCount", Number(event.target.value))} /></Field>
        <Field label="Playoffs start"><input type="number" min={2} max={18} value={schedule.playoffStartWeek} onChange={(event) => update("playoffStartWeek", Number(event.target.value))} /></Field>
        <Field label="Weeks per round"><input type="number" min={1} max={2} value={schedule.playoffRoundLength} onChange={(event) => update("playoffRoundLength", Number(event.target.value))} /></Field>
      </div>
      <div className="toggle-list">
        <Toggle label="Reseed after each round" checked={schedule.reseed} onChange={(value) => update("reseed", value)} />
        <Toggle label="Run a consolation bracket" checked={schedule.consolationBracket} onChange={(value) => update("consolationBracket", value)} />
        <Toggle label="Include a third-place matchup" checked={schedule.thirdPlaceMatchup} onChange={(value) => update("thirdPlaceMatchup", value)} />
      </div>
    </div>
  );
}

function ReviewStep({ draft }: { draft: CreateLeagueRequest }) {
  const supplemental = new Set(["IR", "PUP", "TAXI"]);
  const activeRosterSize = draft.rosterSlots.filter((slot) => !supplemental.has(slot.slotType)).reduce((sum, slot) => sum + slot.count, 0);
  const lineupSize = draft.rosterSlots.filter((slot) => slot.contributesPoints).reduce((sum, slot) => sum + slot.count, 0);
  return (
    <div className="wizard-step">
      <StepHeading icon={<Clipboard size={22} />} title="Review league" subtitle="These settings can be revised later by a commissioner." />
      <div className="review-list">
        <ReviewRow label="League" value={draft.leagueName} detail={`${draft.privacy} - ${draft.teamCount} teams - ${draft.seasonYear}`} />
        <ReviewRow label="Format" value={formatLabel(draft.format)} detail={presetLabel(draft.scoringPreset)} />
        <ReviewRow label="Your team" value={draft.commissionerTeamName} detail="Commissioner" />
        <ReviewRow label="Roster" value={`${lineupSize} starters / ${activeRosterSize} active`} detail={draft.rosterSlots.filter((slot) => slot.count > 0).map((slot) => `${slot.count} ${slot.slotType}`).join(" - ")} />
        <ReviewRow label="Schedule" value={`Weeks ${draft.schedule.regularSeasonStartWeek}-${draft.schedule.regularSeasonEndWeek}`} detail={`${draft.schedule.playoffTeamCount}-team playoffs begin Week ${draft.schedule.playoffStartWeek}`} />
      </div>
    </div>
  );
}

function JoinLeague({
  accessToken,
  initialCode,
  onCancel,
  onJoined,
}: {
  accessToken: string;
  initialCode: string;
  onCancel: () => void;
  onJoined: (response: JoinLeagueResponse) => void;
}) {
  const [invitationCode, setInvitationCode] = useState(initialCode);
  const [teamName, setTeamName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onJoined(await leagueRequest<JoinLeagueResponse>("/api/leagues/join", accessToken, {
        method: "POST",
        body: { invitationCode, teamName },
      }));
      window.history.replaceState({}, "", "/");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to join this league.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="league-page join-page">
      <button className="back-button" type="button" onClick={onCancel}><ArrowLeft size={19} /> Back</button>
      <div className="join-panel">
        <div className="join-icon"><KeyRound size={28} /></div>
        <p className="eyebrow">League invitation</p>
        <h1>Join your league</h1>
        <p>Enter the commissioner's invitation code and choose the team name shown around the league.</p>
        {error && <InlineAlert message={error} onClose={() => setError("")} />}
        <form onSubmit={submit}>
          <Field label="Invitation code"><input className="code-input" value={invitationCode} maxLength={11} onChange={(event) => setInvitationCode(formatInvitationInput(event.target.value))} placeholder="ABCDE-F2345" autoComplete="off" /></Field>
          <Field label="Team name"><input value={teamName} maxLength={40} onChange={(event) => setTeamName(event.target.value)} placeholder="Red Zone" /></Field>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={18} /> : <UserPlus size={18} />} Join league
          </button>
        </form>
      </div>
    </div>
  );
}

function LeagueDetailView({
  league,
  accessToken,
  onBack,
  onChanged,
}: {
  league: LeagueDetail;
  accessToken: string;
  onBack: () => void;
  onChanged: (league: LeagueDetail) => void;
}) {
  const [tab, setTab] = useState<LeagueTab>("overview");
  const [invite, setInvite] = useState<LeagueInvitationResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canManage = league.role === "commissioner" || league.role === "co-commissioner";

  async function rotateInvitation() {
    setBusy(true);
    setError("");
    try {
      setInvite(await leagueRequest<LeagueInvitationResponse>(`/api/leagues/${league.leagueId}/invitations`, accessToken, { method: "POST", body: {} }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create an invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function setArchived(archived: boolean) {
    setBusy(true);
    setError("");
    try {
      onChanged(await leagueRequest<LeagueDetail>(`/api/leagues/${league.leagueId}/${archived ? "archive" : "restore"}`, accessToken, {
        method: "POST",
        body: { revisionNumber: league.revisionNumber },
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update league status.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="league-page detail-page">
      <button className="back-button" type="button" onClick={onBack}><ArrowLeft size={19} /> All leagues</button>
      <header className="league-detail-header">
        <span className="detail-crest">{monogram(league.leagueName)}</span>
        <div><p className="eyebrow">{league.seasonYear} - {formatLabel(league.format)}</p><h1>{league.leagueName}</h1><p>{league.description || "No league description yet."}</p></div>
        <span className={`league-state ${league.status}`}>{league.status}</span>
      </header>
      <div className="league-tabs" role="tablist">
        {(["overview", "members", "draft", "scoring", "settings"] as LeagueTab[]).map((item) => (
          <button role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} type="button" key={item} onClick={() => setTab(item)}>{item}</button>
        ))}
      </div>
      {error && <InlineAlert message={error} onClose={() => setError("")} />}
      {tab === "overview" && (
        <div className="detail-content">
          <section className="metric-strip">
            <div><Users size={19} /><span><strong>{league.teamCount}/{league.maxTeams}</strong> teams</span></div>
            <div><Gauge size={19} /><span><strong>{presetLabel(league.scoringPreset)}</strong> scoring</span></div>
            <div><CalendarDays size={19} /><span><strong>Week {league.schedule.playoffStartWeek}</strong> playoffs</span></div>
            <div><ShieldCheck size={19} /><span><strong>{formatRole(league.role)}</strong> role</span></div>
          </section>
          <div className="overview-columns">
            <section className="plain-section">
              <div className="section-heading"><div><p className="eyebrow">League activity</p><h2>Recent moves</h2></div><RefreshCw size={20} /></div>
              <div className="activity-list">
                {league.recentActivity.length ? league.recentActivity.map((activity) => (
                  <div key={activity.activityId}><span className="activity-mark" /><p>{activity.message}<small>{formatDate(activity.createdAtUtc)}</small></p></div>
                )) : <p className="muted-empty">League activity will appear here.</p>}
              </div>
            </section>
            <section className="plain-section invitation-section">
              <div className="section-heading"><div><p className="eyebrow">Managers</p><h2>Invite the league</h2></div><KeyRound size={20} /></div>
              {canManage ? (
                <>
                  <p>Create a fresh 30-day invitation code. Generating one revokes the previous code.</p>
                  {invite && <InvitationCode code={invite.invitationCode} link={invite.invitationLink} />}
                  <button className="outline-button" type="button" disabled={busy} onClick={() => void rotateInvitation()}>
                    {busy ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={18} />} {invite ? "Rotate code" : "Create invitation"}
                  </button>
                </>
              ) : <p>Ask a commissioner for the current invitation code.</p>}
            </section>
          </div>
        </div>
      )}
      {tab === "members" && <MembersView league={league} />}
      {tab === "draft" && <DraftView league={league} accessToken={accessToken} />}
      {tab === "scoring" && <ScoringView league={league} accessToken={accessToken} canManage={canManage} />}
      {tab === "settings" && (
        <SettingsView
          league={league}
          accessToken={accessToken}
          canManage={canManage}
          busy={busy}
          onBusy={setBusy}
          onError={setError}
          onChanged={onChanged}
          onArchive={() => void setArchived(league.status !== "archived")}
        />
      )}
    </div>
  );
}

function DraftView({ league, accessToken }: { league: LeagueDetail; accessToken: string }) {
  const [room, setRoom] = useState<DraftRoomResponse | null>(null);
  const [players, setPlayers] = useState<DraftPlayerView[]>([]);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [clockNow, setClockNow] = useState(Date.now());
  const [setup, setSetup] = useState<Omit<DraftSetupRequest, "revisionNumber"> | null>(null);

  async function loadRoom(silent = false) {
    if (!silent) setBusy(true);
    try {
      const next = await leagueRequest<DraftRoomResponse>(`/api/leagues/${league.leagueId}/draft`, accessToken);
      setRoom(next);
      setSetup((current) => current ?? {
        draftType: next.draftType,
        scheduledAtUtc: next.scheduledAtUtc,
        rounds: next.rounds,
        pickSeconds: next.pickSeconds,
        autopickEnabled: next.autopickEnabled,
        teamOrder: next.teams.map((team) => team.fantasyTeamId),
      });
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load the draft room.");
    } finally {
      if (!silent) setBusy(false);
    }
  }

  useEffect(() => {
    void loadRoom();
    const refresh = window.setInterval(() => void loadRoom(true), 1500);
    const timer = window.setInterval(() => setClockNow(Date.now()), 250);
    return () => { window.clearInterval(refresh); window.clearInterval(timer); };
  }, [accessToken, league.leagueId]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ limit: "120" });
        if (query.trim()) params.set("query", query.trim());
        if (position) params.set("position", position);
        const next = await leagueRequest<DraftPlayerView[]>(`/api/leagues/${league.leagueId}/draft/players?${params}`, accessToken);
        if (active) setPlayers(next);
      } catch (requestError) {
        if (active) setError(requestError instanceof Error ? requestError.message : "Unable to load players.");
      }
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [accessToken, league.leagueId, query, position, room?.revisionNumber]);

  async function command(action: string, body: Record<string, unknown> = {}) {
    if (!room) return;
    setBusy(true);
    try {
      setRoom(await leagueRequest<DraftRoomResponse>(`/api/leagues/${league.leagueId}/draft/${action}`, accessToken, {
        method: "POST", body: { revisionNumber: room.revisionNumber, ...body },
      }));
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Draft command failed.");
      await loadRoom(true);
    } finally { setBusy(false); }
  }

  async function makePick(playerId: string) {
    if (!room || (!room.canPick && !room.canManage)) return;
    setBusy(true);
    try {
      setRoom(await leagueRequest<DraftRoomResponse>(`/api/leagues/${league.leagueId}/draft/pick`, accessToken, {
        method: "POST",
        body: { playerId, expectedOverallPick: room.currentOverallPick, revisionNumber: room.revisionNumber },
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to make that pick.");
      await loadRoom(true);
    } finally { setBusy(false); }
  }

  async function saveQueue(playerIds: string[]) {
    if (!room) return;
    try {
      setRoom(await leagueRequest<DraftRoomResponse>(`/api/leagues/${league.leagueId}/draft/queue`, accessToken, {
        method: "PUT", body: { playerIds, autopickEnabled: room.autopickEnabled },
      }));
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Unable to update your queue."); }
  }

  async function saveSetup() {
    if (!room || !setup) return;
    setBusy(true);
    try {
      const next = await leagueRequest<DraftRoomResponse>(`/api/leagues/${league.leagueId}/draft/setup`, accessToken, {
        method: "PUT", body: { ...setup, revisionNumber: room.revisionNumber },
      });
      setRoom(next);
      setSetup({ ...setup, teamOrder: next.teams.map((team) => team.fantasyTeamId) });
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Unable to save draft setup."); }
    finally { setBusy(false); }
  }

  function moveTeam(index: number, direction: -1 | 1) {
    if (!setup) return;
    const target = index + direction;
    if (target < 0 || target >= setup.teamOrder.length) return;
    const order = [...setup.teamOrder];
    [order[index], order[target]] = [order[target], order[index]];
    setSetup({ ...setup, teamOrder: order });
  }

  if (busy && !room) return <div className="workspace-loading"><LoaderCircle className="spin" size={28}/><span>Loading draft room</span></div>;
  if (!room) return <section className="draft-empty">{error || "Draft room unavailable."}</section>;
  const seconds = room.pickDeadlineUtc ? Math.max(0, Math.ceil((Date.parse(room.pickDeadlineUtc) - clockNow) / 1000)) : room.pickSeconds;
  const queueIds = room.queue.map((player) => player.playerId);
  const editableSetup = room.canManage && ["setup", "scheduled"].includes(room.status);
  const orderedTeams = setup ? setup.teamOrder.map((id) => room.teams.find((team) => team.fantasyTeamId === id)).filter(Boolean) as DraftRoomResponse["teams"] : room.teams;

  return (
    <div className="draft-room">
      {error && <InlineAlert message={error} onClose={() => setError("")}/>}
      <header className="draft-command-bar">
        <div><p className="eyebrow">Live draft</p><h2>{room.status === "active" ? `${room.currentTeamName} is on the clock` : `Draft ${room.status}`}</h2><span>Round {room.currentRound} - Pick {room.currentOverallPick} of {room.totalPicks}</span></div>
        <div className={`draft-clock ${seconds <= 10 && room.status === "active" ? "urgent" : ""}`}><small>Pick clock</small><strong>{formatDraftClock(seconds)}</strong></div>
        {room.canManage && <div className="draft-controls">
          {room.status === "active" ? <button className="icon-button" title="Pause draft" aria-label="Pause draft" onClick={() => void command("pause")}><Pause size={18}/></button> : <button className="icon-button" title={room.status === "paused" ? "Resume draft" : "Start draft"} aria-label={room.status === "paused" ? "Resume draft" : "Start draft"} disabled={room.status === "completed"} onClick={() => void command(room.status === "paused" ? "resume" : "start")}><Play size={18}/></button>}
          <button className="icon-button" title="Undo last pick" aria-label="Undo last pick" onClick={() => void command("undo")}><Undo2 size={18}/></button>
          <button className="icon-button" title="Skip current pick" aria-label="Skip current pick" disabled={room.status !== "active"} onClick={() => void command("skip")}><SkipForward size={18}/></button>
          <button className="draft-time-button" disabled={room.status !== "active"} onClick={() => void command("time", { seconds: 30 })}>+30s</button>
        </div>}
      </header>

      {editableSetup && setup && <section className="draft-setup-band">
        <div><label>Format<select value={setup.draftType} onChange={(event) => setSetup({ ...setup, draftType: event.target.value as DraftSetupRequest["draftType"] })}><option value="snake">Snake</option><option value="linear">Linear</option><option value="third-round-reversal">Third-round reversal</option><option value="offline">Offline entry</option></select></label><label>Rounds<input type="number" min="1" max="60" value={setup.rounds} onChange={(event) => setSetup({ ...setup, rounds: Number(event.target.value) })}/></label><label>Pick timer<input type="number" min="15" max="600" step="15" value={setup.pickSeconds} onChange={(event) => setSetup({ ...setup, pickSeconds: Number(event.target.value) })}/></label><label>Draft time<input type="datetime-local" value={setup.scheduledAtUtc ? localDateTime(setup.scheduledAtUtc) : ""} onChange={(event) => setSetup({ ...setup, scheduledAtUtc: event.target.value ? new Date(event.target.value).toISOString() : undefined })}/></label></div>
        <div className="draft-order"><span>Draft order</span>{orderedTeams.map((team, index) => <p key={team.fantasyTeamId}><b>{index + 1}</b><span>{team.teamName}</span><button className="icon-button" aria-label={`Move ${team.teamName} up`} disabled={index === 0} onClick={() => moveTeam(index, -1)}><ArrowUp size={15}/></button><button className="icon-button" aria-label={`Move ${team.teamName} down`} disabled={index === orderedTeams.length - 1} onClick={() => moveTeam(index, 1)}><ArrowDown size={15}/></button></p>)}</div>
        <button className="primary-button compact" disabled={busy} onClick={() => void saveSetup()}><Save size={16}/> Save setup</button>
      </section>}

      <section className="draft-board-wrap"><div className="draft-board" style={{ "--draft-teams": Math.max(1, room.teams.length) } as React.CSSProperties}>
        {room.teams.map((team) => <div className="draft-team-heading" key={team.fantasyTeamId}><b>{team.slotNumber}</b><span>{team.teamName}</span></div>)}
        {Array.from({ length: room.rounds }, (_, roundIndex) => room.teams.map((team) => {
          const overall = overallPickForSlot(room.draftType, roundIndex + 1, team.slotNumber, room.teams.length);
          const pick = room.picks.find((item) => item.overallPick === overall);
          return <div className={`draft-board-cell ${overall === room.currentOverallPick && room.status === "active" ? "on-clock" : ""}`} key={`${roundIndex}-${team.fantasyTeamId}`}><small>{overall}</small>{pick?.playerName ? <><strong>{pick.playerName}</strong><span>{pick.position} {pick.nflTeam}</span></> : pick?.status === "skipped" ? <em>Skipped</em> : <span>Round {roundIndex + 1}</span>}</div>;
        }))}
      </div></section>

      <div className="draft-workspace-grid">
        <section className="draft-player-pool"><div className="section-heading"><div><p className="eyebrow">Available players</p><h2>Player board</h2></div><span>{players.filter((player) => !player.drafted).length} shown</span></div><div className="draft-filters"><label><Search size={16}/><input placeholder="Search players" value={query} onChange={(event) => setQuery(event.target.value)}/></label><select aria-label="Filter position" value={position} onChange={(event) => setPosition(event.target.value)}><option value="">All positions</option>{["QB","RB","WR","TE","K","DST","DL","LB","DB"].map((item) => <option key={item}>{item}</option>)}</select></div><div className="draft-player-list">{players.map((player) => <div className={player.drafted ? "drafted" : ""} key={player.playerId}><b>{player.rank}</b><span><strong>{player.displayName}</strong><small>{player.position} - {player.nflTeam ?? "FA"}</small></span><button className="icon-button" title={player.queued ? "Remove from queue" : "Add to queue"} aria-label={player.queued ? `Remove ${player.displayName} from queue` : `Add ${player.displayName} to queue`} disabled={player.drafted} onClick={() => void saveQueue(player.queued ? queueIds.filter((id) => id !== player.playerId) : [...queueIds, player.playerId])}>{player.queued ? <X size={16}/> : <ListPlus size={16}/>}</button><button className="draft-player-button" disabled={player.drafted || (!room.canPick && !room.canManage) || room.status !== "active"} onClick={() => void makePick(player.playerId)}>Draft</button></div>)}</div></section>
        <aside className="draft-side-panel"><div className="section-heading"><div><p className="eyebrow">Autopick priority</p><h2>My queue</h2></div><ListChecks size={18}/></div>{room.queue.length ? <div className="draft-queue-list">{room.queue.map((player, index) => <div key={player.playerId}><b>{index + 1}</b><span>{player.displayName}<small>{player.position} {player.nflTeam}</small></span><button className="icon-button" aria-label={`Remove ${player.displayName}`} onClick={() => void saveQueue(queueIds.filter((id) => id !== player.playerId))}><X size={15}/></button></div>)}</div> : <p className="muted-empty">Add players from the board. The first legal, available player is selected on autopick.</p>}<div className="draft-roster-summary"><p className="eyebrow">Current rosters</p>{room.teams.map((team) => <div key={team.fantasyTeamId}><span>{team.teamName}</span><b>{room.picks.filter((pick) => pick.fantasyTeamId === team.fantasyTeamId && pick.status === "active").length}/{room.rounds}</b></div>)}</div></aside>
      </div>
    </div>
  );
}

function formatDraftClock(seconds: number): string { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function localDateTime(value: string): string { const date = new Date(value); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }
function overallPickForSlot(type: DraftSetupRequest["draftType"], round: number, slot: number, teams: number): number { const reversed = type === "snake" ? round % 2 === 0 : type === "third-round-reversal" ? round === 2 || (round >= 3 && round % 2 === 1) : false; const index = reversed ? teams - slot : slot - 1; return (round - 1) * teams + index + 1; }

function MembersView({ league }: { league: LeagueDetail }) {
  return (
    <section className="members-section">
      <div className="section-heading"><div><p className="eyebrow">Membership</p><h2>League teams</h2></div><span>{league.teamCount} of {league.maxTeams}</span></div>
      <div className="members-table" role="table" aria-label="League members">
        <div className="member-row member-header" role="row"><span>Manager</span><span>Team</span><span>Role</span><span>Joined</span></div>
        {league.members.map((member) => (
          <div className="member-row" role="row" key={member.userId}>
            <span><span className="member-avatar">{member.displayName.slice(0, 2).toUpperCase()}</span>{member.displayName}</span>
            <span>{member.teamName ?? "Unassigned"}</span>
            <span>{formatRole(member.role)}</span>
            <span>{formatDate(member.joinedAtUtc)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ScoringView({
  league,
  accessToken,
  canManage,
}: {
  league: LeagueDetail;
  accessToken: string;
  canManage: boolean;
}) {
  const [configuration, setConfiguration] = useState<ScoringConfiguration | null>(null);
  const [catalog, setCatalog] = useState<ScoringCatalogResponse | null>(null);
  const [versions, setVersions] = useState<ScoringVersionSummary[]>([]);
  const [rules, setRules] = useState<ScoringRule[]>([]);
  const [preview, setPreview] = useState<ScoringPreviewResponse | null>(null);
  const [effectiveScope, setEffectiveScope] = useState<ScoringEffectiveScope>("next-week");
  const [fromWeek, setFromWeek] = useState(1);
  const [toWeek, setToWeek] = useState(18);
  const [changeReason, setChangeReason] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const isDraft = configuration?.status === "draft";

  useEffect(() => {
    let active = true;
    async function load() {
      setBusy(true);
      setError("");
      try {
        const [nextConfiguration, nextCatalog, nextVersions] = await Promise.all([
          leagueRequest<ScoringConfiguration>(`/api/leagues/${league.leagueId}/scoring`, accessToken),
          leagueRequest<ScoringCatalogResponse>(`/api/leagues/${league.leagueId}/scoring/catalog`, accessToken),
          leagueRequest<ScoringVersionSummary[]>(`/api/leagues/${league.leagueId}/scoring/versions`, accessToken),
        ]);
        if (!active) return;
        setConfiguration(nextConfiguration);
        setRules(nextConfiguration.rules);
        setCatalog(nextCatalog);
        setVersions(nextVersions);
      } catch (requestError) {
        if (active) setError(requestError instanceof Error ? requestError.message : "Unable to load scoring.");
      } finally {
        if (active) setBusy(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [accessToken, league.leagueId]);

  function acceptConfiguration(next: ScoringConfiguration) {
    setConfiguration(next);
    setRules(next.rules);
    setPreview(null);
  }

  async function startDraft(source: "current" | "preset", presetKey?: string) {
    setBusy(true);
    setError("");
    try {
      acceptConfiguration(await leagueRequest<ScoringConfiguration>(
        `/api/leagues/${league.leagueId}/scoring/draft`,
        accessToken,
        { method: "POST", body: { source, presetKey } },
      ));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create a scoring draft.");
    } finally {
      setBusy(false);
    }
  }

  function updateRule(index: number, update: Partial<ScoringRule>) {
    setRules((current) => current.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...update } : rule));
    setPreview(null);
  }

  async function saveDraft(): Promise<ScoringConfiguration> {
    if (!configuration || configuration.status !== "draft") throw new Error("Create a draft before saving changes.");
    const saved = await leagueRequest<ScoringConfiguration>(
      `/api/leagues/${league.leagueId}/scoring/rules`,
      accessToken,
      { method: "POST", body: { revisionNumber: configuration.revisionNumber, rules } },
    );
    acceptConfiguration(saved);
    return saved;
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      await saveDraft();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to save scoring rules.");
    } finally {
      setBusy(false);
    }
  }

  function scopeBody(revisionNumber: number) {
    const includeFrom = effectiveScope === "next-week" || effectiveScope === "unstarted-weeks" || effectiveScope === "selected-future-weeks";
    return {
      revisionNumber,
      effectiveScope,
      ...(includeFrom ? { effectiveFromWeek: fromWeek } : {}),
      ...(effectiveScope === "selected-future-weeks" ? { effectiveToWeek: toWeek } : {}),
    };
  }

  async function saveAndPreview() {
    setBusy(true);
    setError("");
    try {
      const saved = await saveDraft();
      setPreview(await leagueRequest<ScoringPreviewResponse>(
        `/api/leagues/${league.leagueId}/scoring/preview`,
        accessToken,
        { method: "POST", body: scopeBody(saved.revisionNumber) },
      ));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to preview scoring changes.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!configuration || !preview) return;
    setBusy(true);
    setError("");
    try {
      const applied = await leagueRequest<ScoringConfiguration>(
        `/api/leagues/${league.leagueId}/scoring/apply`,
        accessToken,
        { method: "POST", body: { ...scopeBody(configuration.revisionNumber), changeReason } },
      );
      acceptConfiguration(applied);
      setChangeReason("");
      setVersions(await leagueRequest<ScoringVersionSummary[]>(`/api/leagues/${league.leagueId}/scoring/versions`, accessToken));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to apply scoring changes.");
    } finally {
      setBusy(false);
    }
  }

  if (busy && !configuration) {
    return <div className="workspace-loading scoring-loading"><LoaderCircle className="spin" size={26} /><span>Loading scoring rules</span></div>;
  }

  return (
    <section className="scoring-view">
      <div className="section-heading scoring-heading">
        <div><p className="eyebrow">Commissioner scoring</p><h2>Scoring rules</h2><p>Every value is stored as an exact decimal and versioned for this league season.</p></div>
        <span className={`scoring-status ${configuration?.status ?? "active"}`}>{configuration?.status ?? "active"} v{configuration?.versionNumber ?? 1}</span>
      </div>
      {error && <InlineAlert message={error} onClose={() => setError("")} />}

      {canManage && catalog && (
        <section className="scoring-presets">
          <div className="scoring-subheading"><div><h3>Starting presets</h3><p>Selecting a preset creates a new draft. Nothing changes for the league until you review and apply it.</p></div></div>
          <div className="preset-list">
            {catalog.presets.map((preset) => (
              <button type="button" key={preset.presetKey} disabled={busy} onClick={() => void startDraft("preset", preset.presetKey)}>
                <strong>{preset.displayName}</strong><span>{preset.description}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="scoring-toolbar">
        <div>
          <strong>{isDraft ? "Draft rules" : "Official rules"}</strong>
          <span>{rules.filter((rule) => rule.enabled).length} of {rules.length} statistics enabled</span>
        </div>
        {canManage && !isDraft && (
          <button className="primary-button compact" type="button" disabled={busy} onClick={() => void startDraft("current")}>
            <SlidersHorizontal size={17} /> Customize scoring
          </button>
        )}
        {canManage && isDraft && (
          <button className="outline-button compact" type="button" disabled={busy} onClick={() => void save()}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />} Save draft
          </button>
        )}
      </div>

      <div className="scoring-rule-list">
        {groupRules(rules).map(([category, categoryRules]) => (
          <section className="scoring-category" key={category}>
            <h3>{category}</h3>
            <div className="scoring-rule-header" aria-hidden="true"><span>On</span><span>Statistic</span><span>Calculation</span><span>Points</span></div>
            {categoryRules.map(({ rule, index }) => {
              const definition = catalog?.statistics.find((item) => item.statisticKey === rule.statisticKey);
              const advanced = ["points-per-unit", "one-time-threshold", "repeating-threshold", "tiered", "range-based", "position-specific", "maximum-award"].includes(rule.calculationType);
              return (
                <div className={`scoring-rule ${rule.enabled ? "enabled" : ""}`} key={rule.statisticKey}>
                  <label className="rule-toggle" title={rule.enabled ? "Disable rule" : "Enable rule"}>
                    <input type="checkbox" checked={rule.enabled} disabled={!canManage || !isDraft} onChange={(event) => updateRule(index, { enabled: event.target.checked })} />
                    <i aria-hidden="true" />
                  </label>
                  <div className="rule-identity"><strong>{rule.displayName}</strong><span>{rule.description}</span></div>
                  <select aria-label={`${rule.displayName} calculation`} value={rule.calculationType} disabled={!canManage || !isDraft} onChange={(event) => updateRule(index, { calculationType: event.target.value as ScoringCalculationType })}>
                    {(definition?.allowedCalculationTypes ?? [rule.calculationType]).map((type) => <option value={type} key={type}>{calculationLabel(type)}</option>)}
                  </select>
                  <label className="points-input"><input aria-label={`${rule.displayName} points`} inputMode="decimal" value={rule.pointValue} disabled={!canManage || !isDraft} onChange={(event) => updateRule(index, { pointValue: event.target.value })} /><span>pts</span></label>
                  {advanced && rule.enabled && (
                    <div className="rule-advanced">
                      {rule.calculationType === "points-per-unit" && <CompactInput label="Per units" value={rule.incrementValue ?? "1"} disabled={!canManage || !isDraft} onChange={(value) => updateRule(index, { incrementValue: value })} />}
                      {["one-time-threshold", "repeating-threshold", "minimum-requirement"].includes(rule.calculationType) && <CompactInput label="Threshold" value={rule.thresholdValue ?? ""} disabled={!canManage || !isDraft} onChange={(value) => updateRule(index, { thresholdValue: value })} />}
                      {["repeating-threshold", "maximum-award"].includes(rule.calculationType) && <CompactInput label="Max awards" type="number" value={String(rule.maxAwards ?? 1)} disabled={!canManage || !isDraft} onChange={(value) => updateRule(index, { maxAwards: Number(value) })} />}
                      {rule.calculationType === "position-specific" && definition && (
                        <div className="position-options"><span>Positions</span>{definition.allowedPositions.map((position) => <label key={position}><input type="checkbox" disabled={!canManage || !isDraft} checked={rule.positions.includes(position)} onChange={(event) => updateRule(index, { positions: event.target.checked ? [...rule.positions, position] : rule.positions.filter((item) => item !== position) })} />{position}</label>)}</div>
                      )}
                      {["tiered", "range-based"].includes(rule.calculationType) && (
                        <TierEditor rule={rule} disabled={!canManage || !isDraft} onChange={(tiers) => updateRule(index, { tiers })} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>

      {canManage && isDraft && configuration && (
        <section className="scoring-apply">
          <div className="scoring-subheading"><div><p className="eyebrow">Change control</p><h3>Preview and apply</h3><p>Choose when this version takes effect. Retroactive scopes queue affected weeks for recalculation.</p></div><Calculator size={20} /></div>
          <div className="apply-controls">
            <Field label="Effective scope"><select value={effectiveScope} onChange={(event) => { setEffectiveScope(event.target.value as ScoringEffectiveScope); setPreview(null); }}>{effectiveScopeOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
            {(effectiveScope === "next-week" || effectiveScope === "unstarted-weeks" || effectiveScope === "selected-future-weeks") && <Field label="Starts in week"><input type="number" min={1} max={18} value={fromWeek} onChange={(event) => { setFromWeek(Number(event.target.value)); setPreview(null); }} /></Field>}
            {effectiveScope === "selected-future-weeks" && <Field label="Ends after week"><input type="number" min={fromWeek} max={18} value={toWeek} onChange={(event) => { setToWeek(Number(event.target.value)); setPreview(null); }} /></Field>}
            <button className="outline-button preview-button" type="button" disabled={busy} onClick={() => void saveAndPreview()}><Calculator size={17} /> Save and preview</button>
          </div>
          {preview && (
            <div className="scoring-preview">
              <div className="preview-summary"><strong>{preview.changedRuleCount} rule{preview.changedRuleCount === 1 ? "" : "s"} changed</strong><span>{preview.affectedWeeks.length ? `Weeks ${preview.affectedWeeks.join(", ")}` : "Begins next season"}</span></div>
              {preview.recalculationRequired && <p className="recalculation-note">Existing results in the selected weeks will be queued for recalculation.</p>}
              <p className="preview-data-note">{preview.sampleStatus}</p>
              <div className="difference-list">{preview.differences.length ? preview.differences.map((difference) => <div key={difference.statisticKey}><strong>{difference.displayName}</strong><span>{difference.currentValue ?? "Not configured"}</span><ArrowRight size={14} /><span>{difference.proposedValue ?? "Removed"}</span></div>) : <p>No rule values differ from the official version.</p>}</div>
              <Field label="Reason for change" wide><textarea maxLength={300} value={changeReason} onChange={(event) => setChangeReason(event.target.value)} placeholder="Explain this change for the league audit log." /></Field>
              <button className="primary-button apply-button" type="button" disabled={busy || changeReason.trim().length < 3} onClick={() => void apply()}><Check size={17} /> Apply scoring version</button>
            </div>
          )}
        </section>
      )}

      <section className="scoring-history">
        <div className="scoring-subheading"><div><h3>Version history</h3><p>Applied configurations remain available as an audit trail.</p></div><History size={20} /></div>
        <div>{versions.map((version) => <p key={version.scoringVersionId}><strong>Version {version.versionNumber}</strong><span>{version.status}</span><small>{version.changeReason ?? presetLabel(version.sourcePresetKey ?? "custom")}</small><time>{formatDate(version.appliedAtUtc ?? version.createdAtUtc)}</time></p>)}</div>
      </section>
    </section>
  );
}

function CompactInput({ label, value, type = "text", disabled, onChange }: { label: string; value: string; type?: "text" | "number"; disabled: boolean; onChange: (value: string) => void }) {
  return <label className="compact-input"><span>{label}</span><input type={type} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>;
}

function TierEditor({ rule, disabled, onChange }: { rule: ScoringRule; disabled: boolean; onChange: (tiers: ScoringRule["tiers"]) => void }) {
  const tiers = rule.tiers.length ? rule.tiers : [{ minimum: "", maximum: "", points: rule.pointValue }];
  function update(index: number, values: Partial<ScoringRule["tiers"][number]>) {
    onChange(tiers.map((tier, tierIndex) => tierIndex === index ? { ...tier, ...values } : tier));
  }
  return (
    <div className="tier-editor">
      <span>Scoring tiers</span>
      {tiers.map((tier, index) => <div key={index}><input aria-label={`Tier ${index + 1} minimum`} placeholder="Min" value={tier.minimum} disabled={disabled} onChange={(event) => update(index, { minimum: event.target.value })} /><input aria-label={`Tier ${index + 1} maximum`} placeholder="Max" value={tier.maximum ?? ""} disabled={disabled} onChange={(event) => update(index, { maximum: event.target.value || undefined })} /><input aria-label={`Tier ${index + 1} points`} placeholder="Points" value={tier.points} disabled={disabled} onChange={(event) => update(index, { points: event.target.value })} />{!disabled && <button className="icon-button" type="button" onClick={() => onChange(tiers.filter((_, tierIndex) => tierIndex !== index))} aria-label={`Remove tier ${index + 1}`}><X size={15} /></button>}</div>)}
      {!disabled && <button className="tier-add" type="button" onClick={() => onChange([...tiers, { minimum: "", maximum: "", points: "0" }])}><Plus size={14} /> Add tier</button>}
    </div>
  );
}

function groupRules(rules: ScoringRule[]): Array<[string, Array<{ rule: ScoringRule; index: number }>]> {
  const groups = new Map<string, Array<{ rule: ScoringRule; index: number }>>();
  rules.forEach((rule, index) => groups.set(rule.category, [...(groups.get(rule.category) ?? []), { rule, index }]));
  return [...groups.entries()];
}

function calculationLabel(value: ScoringCalculationType): string {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

const effectiveScopeOptions: Array<[ScoringEffectiveScope, string]> = [
  ["next-week", "Next selected week"],
  ["unstarted-weeks", "Selected week and all later weeks"],
  ["selected-future-weeks", "Selected future week range"],
  ["retroactive-current-season", "Entire current season, including completed weeks"],
  ["entire-season", "Entire season"],
  ["next-season", "Next season"],
];

function SettingsView({
  league,
  accessToken,
  canManage,
  busy,
  onBusy,
  onError,
  onChanged,
  onArchive,
}: {
  league: LeagueDetail;
  accessToken: string;
  canManage: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (error: string) => void;
  onChanged: (league: LeagueDetail) => void;
  onArchive: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<UpdateLeagueSettingsRequest>(() => detailToSettings(league));

  useEffect(() => setForm(detailToSettings(league)), [league]);

  async function save(event: FormEvent) {
    event.preventDefault();
    onBusy(true);
    onError("");
    try {
      const updated = await leagueRequest<LeagueDetail>(`/api/leagues/${league.leagueId}/settings`, accessToken, { method: "PATCH", body: form });
      onChanged(updated);
      setEditing(false);
    } catch (requestError) {
      onError(requestError instanceof Error ? requestError.message : "Unable to save league settings.");
    } finally {
      onBusy(false);
    }
  }

  if (editing) {
    return (
      <form className="settings-editor" onSubmit={save}>
        <div className="section-heading"><div><p className="eyebrow">Commissioner controls</p><h2>Edit league settings</h2></div><button className="icon-button" type="button" onClick={() => setEditing(false)} aria-label="Close settings editor"><X size={20} /></button></div>
        <div className="form-grid">
          <Field label="League name" wide><input value={form.leagueName} onChange={(event) => setForm({ ...form, leagueName: event.target.value })} /></Field>
          <Field label="Description" wide><textarea value={form.description ?? ""} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
          <Field label="Privacy"><select value={form.privacy} onChange={(event) => setForm({ ...form, privacy: event.target.value as LeaguePrivacy })}><option value="private">Private</option><option value="public">Public</option></select></Field>
          <Field label="Teams"><input type="number" min={league.teamCount} max={32} value={form.teamCount} onChange={(event) => setForm({ ...form, teamCount: Number(event.target.value) })} /></Field>
          <Field label="Time zone"><select value={form.timeZone} onChange={(event) => setForm({ ...form, timeZone: event.target.value })}>{timeZones.map((zone) => <option key={zone}>{zone}</option>)}</select></Field>
        </div>
        <h3 className="control-heading">Roster slots</h3>
        <RosterStep slots={form.rosterSlots} limits={form.rosterPositionLimits} onSlotsChange={(rosterSlots) => setForm({ ...form, rosterSlots })} onLimitsChange={(rosterPositionLimits) => setForm({ ...form, rosterPositionLimits })} />
        <h3 className="control-heading">Schedule</h3>
        <ScheduleStep schedule={form.schedule} teamCount={form.teamCount} onChange={(schedule) => setForm({ ...form, schedule })} />
        <div className="settings-actions"><button className="outline-button" type="button" onClick={() => setEditing(false)}>Cancel</button><button className="primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <Save size={18} />} Save changes</button></div>
      </form>
    );
  }

  return (
    <div className="settings-view">
      <section className="plain-section">
        <div className="section-heading"><div><p className="eyebrow">General</p><h2>League settings</h2></div>{canManage && <button className="outline-button compact" type="button" onClick={() => setEditing(true)}><Settings size={17} /> Edit</button>}</div>
        <dl className="settings-list">
          <div><dt>Format</dt><dd>{formatLabel(league.format)}</dd></div>
          <div><dt>Privacy</dt><dd>{league.privacy}</dd></div>
          <div><dt>Time zone</dt><dd>{league.timeZone.replaceAll("_", " ")}</dd></div>
          <div><dt>Scoring</dt><dd>{presetLabel(league.scoringPreset)}</dd></div>
          <div><dt>Regular season</dt><dd>Weeks {league.schedule.regularSeasonStartWeek}-{league.schedule.regularSeasonEndWeek}</dd></div>
          <div><dt>Playoffs</dt><dd>{league.schedule.playoffTeamCount} teams - Week {league.schedule.playoffStartWeek}</dd></div>
          <div><dt>Starting lineup</dt><dd>{league.rosterSlots.filter((slot) => slot.contributesPoints).reduce((sum, slot) => sum + slot.count, 0)} players</dd></div>
          <div><dt>Active roster</dt><dd>{league.rosterSlots.filter((slot) => !["IR", "PUP", "TAXI"].includes(slot.slotType)).reduce((sum, slot) => sum + slot.count, 0)} players</dd></div>
          <div><dt>Revision</dt><dd>{league.revisionNumber}</dd></div>
        </dl>
      </section>
      {league.role === "commissioner" && (
        <section className="danger-section">
          <div><p className="eyebrow">League status</p><h2>{league.status === "archived" ? "Restore league" : "Archive league"}</h2><p>{league.status === "archived" ? "Return this league to active use." : "Archive hides active workflows while preserving every record."}</p></div>
          <button className={league.status === "archived" ? "outline-button" : "danger-button"} type="button" disabled={busy} onClick={onArchive}>
            {league.status === "archived" ? <RotateCcw size={18} /> : <Archive size={18} />} {league.status === "archived" ? "Restore" : "Archive"}
          </button>
        </section>
      )}
    </div>
  );
}

function InvitationCode({ code, link }: { code: string; link: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }
  return (
    <div className="invitation-code">
      <span><small>Invitation code</small><strong>{code}</strong></span>
      <button className="icon-button" type="button" onClick={() => void copy()} aria-label="Copy invitation link" title="Copy invitation link">
        {copied ? <Check size={19} /> : <Copy size={19} />}
      </button>
    </div>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <label className={wide ? "field wide" : "field"}><span>{label}</span>{children}</label>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="toggle-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" /></label>;
}

function StepHeading({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
  return <header className="step-heading"><span>{icon}</span><div><h2>{title}</h2><p>{subtitle}</p></div></header>;
}

function ReviewRow({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div><span>{label}</span><p><strong>{value}</strong><small>{detail}</small></p></div>;
}

function InlineAlert({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="inline-alert" role="alert"><span>{message}</span><button type="button" onClick={onClose} aria-label="Dismiss message"><X size={17} /></button></div>;
}

function BrandMark() {
  return <div className="brand league-brand"><span>my</span><strong>F</strong><em>FL</em></div>;
}

function validateWizardStep(step: number, draft: CreateLeagueRequest): string {
  if (step === 0) {
    if (draft.leagueName.trim().length < 3) return "Enter a league name with at least three characters.";
    if (draft.commissionerTeamName.trim().length < 2) return "Enter your fantasy team name.";
    if (draft.teamCount < 4 || draft.teamCount > 32) return "League size must be between 4 and 32 teams.";
  }
  if (step === 2) {
    const size = draft.rosterSlots.reduce((sum, slot) => sum + slot.count, 0);
    if (size < 5 || size > 60) return "Total roster size must be between 5 and 60 players.";
    if (!draft.rosterSlots.some((slot) => slot.count > 0 && slot.contributesPoints)) return "Add at least one starting lineup slot.";
    if (draft.rosterSlots.some((slot) => slot.count > 0 && slot.eligiblePositions.length === 0)) return "Choose eligible positions for every enabled roster slot.";
    const activeSize = draft.rosterSlots.filter((slot) => !["IR", "PUP", "TAXI"].includes(slot.slotType)).reduce((sum, slot) => sum + slot.count, 0);
    if (draft.rosterPositionLimits.some((limit) => limit.minimum < 0 || limit.maximum < limit.minimum || limit.maximum > activeSize)) return "Position minimums and maximums must fit within the active roster.";
  }
  if (step === 3) {
    if (draft.schedule.playoffStartWeek <= draft.schedule.regularSeasonEndWeek) return "Playoffs must begin after the regular season ends.";
    if (draft.schedule.playoffTeamCount > draft.teamCount) return "Playoff teams cannot exceed league teams.";
  }
  return "";
}

function detailToSummary(league: LeagueDetail): LeagueSummary {
  return {
    leagueId: league.leagueId,
    leagueName: league.leagueName,
    seasonId: league.seasonId,
    seasonYear: league.seasonYear,
    privacy: league.privacy,
    role: league.role,
    status: league.status,
    teamCount: league.teamCount,
    maxTeams: league.maxTeams,
    fantasyTeamId: league.fantasyTeamId,
    joinedAtUtc: league.joinedAtUtc,
    revisionNumber: league.revisionNumber,
  };
}

function detailToSettings(league: LeagueDetail): UpdateLeagueSettingsRequest {
  const configuredSlots = new Map(league.rosterSlots.map((slot) => [slot.slotType, slot]));
  const rosterSlots = [
    ...initialRosterSlots.map((defaultSlot) => configuredSlots.get(defaultSlot.slotType) ?? defaultSlot),
    ...league.rosterSlots.filter((slot) => !initialRosterSlots.some((defaultSlot) => defaultSlot.slotType === slot.slotType)),
  ];
  return {
    revisionNumber: league.revisionNumber,
    leagueName: league.leagueName,
    description: league.description,
    privacy: league.privacy,
    timeZone: league.timeZone,
    teamCount: league.maxTeams,
    rosterSlots: rosterSlots.map((slot) => ({ ...slot, eligiblePositions: [...slot.eligiblePositions] })),
    rosterPositionLimits: league.rosterPositionLimits.map((limit) => ({ ...limit })),
    schedule: { ...league.schedule },
  };
}

function monogram(name: string): string {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  return (words.length > 1 ? words.slice(0, 2).map((word) => word[0]).join("") : (words[0] ?? "L").slice(0, 2)).toUpperCase();
}

function formatRole(role: string): string {
  return role.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function formatLabel(format: LeagueFormat): string {
  const labels: Record<LeagueFormat, string> = {
    "single-season": "Single Season",
    redraft: "Redraft",
    keeper: "Keeper",
    dynasty: "Dynasty",
    "best-ball": "Best Ball",
  };
  return labels[format];
}

function presetLabel(preset: string): string {
  const labels: Record<string, string> = { standard: "Standard", "half-ppr": "Half PPR", "full-ppr": "Full PPR", superflex: "Superflex", "te-premium": "TE Premium", idp: "IDP" };
  return labels[preset] ?? preset;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function formatInvitationInput(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return normalized.length > 5 ? `${normalized.slice(0, 5)}-${normalized.slice(5)}` : normalized;
}

const rosterPositions = ["QB", "RB", "WR", "TE", "K", "DST", "DL", "LB", "DB"];

const timeZones = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
];
