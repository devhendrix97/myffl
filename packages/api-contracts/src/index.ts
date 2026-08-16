export type ApiEnvironment = "local" | "staging" | "production";

export type ImplementationStatus =
  | "available"
  | "in_progress"
  | "planned"
  | "blocked";

export interface ApiEnvelope<T> {
  ok: boolean;
  correlationId: string;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface HealthResponse {
  service: "myffl-api";
  environment: ApiEnvironment;
  status: "healthy";
  version: string;
  utc: string;
}

export interface PhaseStatusItem {
  key: string;
  label: string;
  status: ImplementationStatus;
  summary: string;
}

export interface PhaseStatusResponse {
  phase: "phase-1" | "phase-2" | "phase-3" | "phase-4" | "phase-5" | "phase-6" | "phase-7" | "phase-8" | "phase-9" | "phase-10" | "phase-11" | "release-1";
  title: string;
  items: PhaseStatusItem[];
}

export interface RegisterRequest {
  displayName: string;
  email: string;
  password: string;
  passwordConfirmation: string;
}

export type AuthClientType = "browser" | "native";

export interface LoginRequest {
  email: string;
  password: string;
  clientType?: AuthClientType;
}

export interface RegistrationResponse {
  userId: string;
  email: string;
  verificationRequired: true;
  emailDeliveryStatus: "sent" | "deferred";
}

export interface EmailAddressRequest {
  email: string;
}

export interface TokenRequest {
  token: string;
}

export interface RefreshSessionRequest {
  refreshToken?: string;
  clientType?: AuthClientType;
}

export interface LogoutRequest {
  refreshToken?: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
  passwordConfirmation: string;
}

export interface AuthUser {
  userId: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
}

export interface AuthSessionResponse extends AuthUser {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAtUtc: string;
}

export interface MessageResponse {
  message: string;
}

export interface VerifyEmailResponse extends AuthUser {
  verified: true;
}

export type LeaguePrivacy = "private" | "public";
export type LeagueFormat = "single-season" | "redraft" | "keeper" | "dynasty" | "best-ball";
export type ScoringPresetKey = "standard" | "half-ppr" | "full-ppr" | "superflex" | "te-premium" | "idp";
export type ScoringCalculationType =
  | "points-per-unit"
  | "flat-per-event"
  | "one-time-threshold"
  | "repeating-threshold"
  | "range-based"
  | "tiered"
  | "position-specific"
  | "minimum-requirement"
  | "maximum-award";
export type ScoringEffectiveScope =
  | "next-week"
  | "unstarted-weeks"
  | "selected-future-weeks"
  | "retroactive-current-season"
  | "entire-season"
  | "next-season";
export type LeagueRole = "commissioner" | "co-commissioner" | "manager";
export type LeagueStatus = "active" | "archived" | "maintenance";

export interface RosterSlotInput {
  slotType: string;
  displayName: string;
  count: number;
  eligiblePositions: string[];
  contributesPoints: boolean;
}

export interface RosterPositionLimitInput {
  position: string;
  displayName: string;
  minimum: number;
  maximum: number;
}

export interface LeagueScheduleInput {
  regularSeasonStartWeek: number;
  regularSeasonEndWeek: number;
  scheduleMethod: "round-robin" | "random";
  playoffTeamCount: number;
  playoffStartWeek: number;
  playoffRoundLength: number;
  reseed: boolean;
  consolationBracket: boolean;
  thirdPlaceMatchup: boolean;
}

export interface CreateLeagueRequest {
  requestId: string;
  leagueName: string;
  description?: string;
  privacy: LeaguePrivacy;
  teamCount: number;
  seasonYear: number;
  timeZone: string;
  format: LeagueFormat;
  scoringPreset: ScoringPresetKey;
  commissionerTeamName: string;
  rosterSlots: RosterSlotInput[];
  rosterPositionLimits: RosterPositionLimitInput[];
  schedule: LeagueScheduleInput;
}

export interface LeagueSummary {
  leagueId: string;
  leagueName: string;
  seasonId: string;
  seasonYear: number;
  privacy: LeaguePrivacy;
  role: LeagueRole;
  status: LeagueStatus;
  teamCount: number;
  maxTeams: number;
  fantasyTeamId?: string;
  joinedAtUtc: string;
  revisionNumber: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface LeagueMemberView {
  userId: string;
  displayName: string;
  role: LeagueRole;
  teamId?: string;
  teamName?: string;
  joinedAtUtc: string;
}

export interface LeagueDetail extends LeagueSummary {
  description: string;
  format: LeagueFormat;
  timeZone: string;
  commissionerUserId: string;
  maintenanceMode: boolean;
  scoringPreset: string;
  rosterSlots: RosterSlotInput[];
  rosterPositionLimits: RosterPositionLimitInput[];
  schedule: LeagueScheduleInput;
  members: LeagueMemberView[];
  recentActivity: Array<{ activityId: string; message: string; createdAtUtc: string }>;
}

export type LeagueMessageType = "text" | "image" | "gif" | "poll" | "announcement";
export interface LeagueMessageReaction { reaction: string; count: number; reactedByMe: boolean; }
export interface LeaguePollOption { pollOptionId: string; displayText: string; voteCount: number; votedByMe: boolean; }
export interface LeaguePoll { pollId: string; question: string; allowsMultiple: boolean; closesAtUtc?: string; totalVotes: number; options: LeaguePollOption[]; }
export interface LeagueMessageView {
  messageId: string;
  channel: "league" | "draft";
  messageType: LeagueMessageType;
  authorUserId: string;
  authorDisplayName: string;
  body: string;
  attachmentUrl?: string;
  replyTo?: { messageId: string; authorDisplayName: string; body: string };
  reactions: LeagueMessageReaction[];
  poll?: LeaguePoll;
  pinned: boolean;
  edited: boolean;
  deleted: boolean;
  readByCount: number;
  createdAtUtc: string;
  revisionNumber: number;
  canEdit: boolean;
  canModerate: boolean;
}
export interface LeagueChatResponse {
  messages: LeagueMessageView[];
  nextCursor?: string;
  unreadCount: number;
  pinnedMessages: LeagueMessageView[];
}
export interface CreateLeagueMessageRequest {
  channel: "league" | "draft";
  messageType: LeagueMessageType;
  body?: string;
  attachmentUrl?: string;
  attachmentKey?: string;
  replyToMessageId?: string;
  mentionedUserIds?: string[];
  poll?: { question: string; options: string[]; allowsMultiple?: boolean; closesAtUtc?: string };
}
export interface LeagueActivityView {
  activityId: string;
  activityType: string;
  message: string;
  actorUserId?: string;
  actorDisplayName?: string;
  metadata: Record<string, unknown>;
  createdAtUtc: string;
}
export interface WeeklyReportMetric { label: string; value: string; detail?: string; teamId?: string; playerId?: string; }
export interface WeeklyReportResponse {
  reportId: string;
  weekNumber: number;
  generatedAtUtc: string;
  metrics: WeeklyReportMetric[];
  powerRankings: Array<{ rank: number; teamId: string; teamName: string; score: number }>;
}
export interface NotificationView {
  notificationId: string;
  leagueId?: string;
  notificationType: string;
  title: string;
  body: string;
  actionUrl?: string;
  createdAtUtc: string;
  readAtUtc?: string;
}
export interface NotificationCenterResponse { notifications: NotificationView[]; unreadCount: number; nextCursor?: string; }
export interface NotificationPreferenceView {
  leagueId: string;
  notificationType: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  desktopEnabled: boolean;
  browserPushEnabled: boolean;
}

export interface CreateLeagueResponse {
  league: LeagueDetail;
  invitationCode: string;
  invitationLink: string;
}

export interface JoinLeagueRequest {
  invitationCode: string;
  teamName: string;
}

export interface JoinLeagueResponse {
  league: LeagueDetail;
}

export interface UpdateLeagueSettingsRequest {
  revisionNumber: number;
  leagueName: string;
  description?: string;
  privacy: LeaguePrivacy;
  timeZone: string;
  teamCount: number;
  rosterSlots: RosterSlotInput[];
  rosterPositionLimits: RosterPositionLimitInput[];
  schedule: LeagueScheduleInput;
}

export interface ResetLeagueSeasonResponse {
  leagueId: string;
  seasonId: string;
  resetAtUtc: string;
  teamCount: number;
  draftStatus: "setup";
  scheduleRegenerated: boolean;
}

export interface LeagueInvitationResponse {
  invitationCode: string;
  invitationLink: string;
  expiresAtUtc?: string;
}

export type DraftType = "snake" | "linear" | "third-round-reversal" | "offline";
export type DraftStatus = "setup" | "scheduled" | "active" | "paused" | "completed";

export interface DraftSetupRequest {
  revisionNumber: number;
  draftType: DraftType;
  scheduledAtUtc?: string;
  rounds: number;
  pickSeconds: number;
  autopickEnabled: boolean;
  teamOrder: string[];
}

export interface DraftTeamView {
  fantasyTeamId: string;
  teamName: string;
  managerUserId: string;
  slotNumber: number;
}

export interface DraftPickView {
  draftPickId: string;
  overallPick: number;
  roundNumber: number;
  slotNumber: number;
  fantasyTeamId: string;
  teamName: string;
  playerId?: string;
  playerName?: string;
  position?: string;
  nflTeam?: string;
  selectionSource: "manager" | "autopick" | "commissioner" | "offline" | "skip";
  status: "active" | "skipped";
  madeAtUtc: string;
}

export interface DraftPlayerView {
  playerId: string;
  displayName: string;
  position: string;
  nflTeam?: string;
  headshotUrl?: string;
  nflTeamLogoUrl?: string;
  rank: number;
  queued: boolean;
  drafted: boolean;
  expertConsensusRank?: number;
  positionRank?: string;
  tier?: number;
  byeWeek?: number;
  rankingUpdatedAt?: string;
  projectedPoints?: number;
  averageProjectedPointsPerGame?: number;
}

export interface DraftRoomResponse {
  draftId: string;
  leagueId: string;
  seasonId: string;
  draftType: DraftType;
  status: DraftStatus;
  scheduledAtUtc?: string;
  rounds: number;
  pickSeconds: number;
  autopickEnabled: boolean;
  currentOverallPick: number;
  totalPicks: number;
  currentRound: number;
  currentSlotNumber: number;
  currentTeamId?: string;
  currentTeamName?: string;
  pickDeadlineUtc?: string;
  revisionNumber: number;
  canManage: boolean;
  canPick: boolean;
  teams: DraftTeamView[];
  picks: DraftPickView[];
  queue: DraftPlayerView[];
}

export interface MakeDraftPickRequest {
  playerId: string;
  expectedOverallPick: number;
  revisionNumber: number;
}

export interface DraftQueueUpdateRequest {
  playerIds: string[];
  autopickEnabled: boolean;
  revisionNumber?: number;
}

export interface TeamPlayerView {
  rosterPlayerId: string;
  playerId: string;
  displayName: string;
  position: string;
  nflTeam?: string;
  headshotUrl?: string;
  nflTeamLogoUrl?: string;
  injuryStatus?: string;
  slotType: string;
  slotIndex: number;
  eligibleSlots: string[];
  locked: boolean;
  locksAtUtc?: string;
  fantasyPoints?: number;
  projectedPoints?: number;
}

export interface TeamLineupResponse {
  leagueId: string;
  seasonId: string;
  fantasyTeamId: string;
  teamName: string;
  weekNumber: number;
  revisionNumber: number;
  players: TeamPlayerView[];
  emptySlots: Array<{ slotType: string; slotIndex: number; displayName: string }>;
}

export interface SaveLineupRequest {
  weekNumber: number;
  revisionNumber: number;
  assignments: Array<{ rosterPlayerId: string; slotType: string; slotIndex: number }>;
}

export interface LineupOptimizationResponse {
  weekNumber: number;
  revisionNumber: number;
  assignments: SaveLineupRequest["assignments"];
  changes: Array<{ rosterPlayerId: string; displayName: string; fromSlot: string; toSlot: string }>;
}

export interface PlayerProfileResponse {
  playerId: string;
  displayName: string;
  position: string;
  nflTeam?: string;
  headshotUrl?: string;
  nflTeamLogoUrl?: string;
  injuryStatus?: string;
  rosteredByTeamId?: string;
  rosteredByTeamName?: string;
  watched: boolean;
  availableActions: Array<"add" | "claim" | "trade-for" | "trade-away" | "draft-queue" | "watch">;
  yearlyStats: Array<{ seasonYear: number; games: number; stats: Record<string, unknown> }>;
  recentGames: Array<{ eventId: string; stats: Record<string, unknown>; fantasyPoints?: number }>;
}

export interface LeaguePlayerSearchItem {
  playerId: string;
  displayName: string;
  position: string;
  nflTeam?: string;
  headshotUrl?: string;
  nflTeamLogoUrl?: string;
  injuryStatus?: string;
  rosteredByTeamId?: string;
  rosteredByTeamName?: string;
  watched: boolean;
  expertConsensusRank?: number;
  positionRank?: string;
  tier?: number;
  byeWeek?: number;
  rankingUpdatedAt?: string;
  projectedPoints?: number;
  remainingAverageProjectedPoints?: number;
}

export interface FantasyProsRankingsResponse {
  seasonYear: number;
  scoring: "STD" | "HALF" | "PPR";
  sourceName: "FantasyPros Expert Consensus Rankings";
  sourceUrl: string;
  fetchedAtUtc?: string;
  players: Array<{
    playerId: string;
    displayName: string;
    nflTeam?: string;
    position: string;
    overallRank: number;
    positionRank?: string;
    tier?: number;
    byeWeek?: number;
    sourceUpdatedAt?: string;
    fetchedAtUtc: string;
  }>;
}

export type AcquisitionMode = "free-agent" | "waivers" | "faab";
export type TradeReviewMode = "none" | "commissioner" | "league-vote";

export interface TransactionSettingsResponse {
  acquisitionMode: AcquisitionMode;
  faabBudget: number;
  minimumBid: number;
  waiverPeriodHours: number;
  waiverTiebreaker: "rolling-priority" | "reverse-standings" | "submission-time";
  tradeDeadlineWeek: number;
  tradeReviewMode: TradeReviewMode;
  tradeReviewHours: number;
  vetoThreshold: number;
  draftPickTradingEnabled: boolean;
  faabTradingEnabled: boolean;
  revisionNumber: number;
}

export interface TransactionActivityView {
  transactionId: string;
  transactionType: string;
  status: string;
  teamName?: string;
  summary: string;
  failureReason?: string;
  createdAtUtc: string;
  processedAtUtc?: string;
}

export interface WaiverClaimView {
  waiverClaimId: string;
  playerId: string;
  playerName: string;
  position: string;
  nflTeam?: string;
  dropRosterPlayerId?: string;
  dropPlayerName?: string;
  bid: number;
  claimOrder: number;
  status: string;
  failureReason?: string;
  processesAtUtc: string;
  revisionNumber: number;
}

export interface TradeAssetInput {
  fromFantasyTeamId: string;
  toFantasyTeamId: string;
  assetType: "player" | "draft-pick" | "faab";
  assetId?: string;
  amount?: number;
  draftSeasonYear?: number;
  roundNumber?: number;
  originalFantasyTeamId?: string;
}

export interface TradeView {
  tradeId: string;
  parentTradeId?: string;
  status: string;
  message?: string;
  expiresAtUtc: string;
  reviewEndsAtUtc?: string;
  revisionNumber: number;
  proposedByTeamId: string;
  canRespond: boolean;
  canCancel: boolean;
  canReview: boolean;
  canVote: boolean;
  teams: Array<{ fantasyTeamId: string; teamName: string; responseStatus: string }>;
  assets: Array<TradeAssetInput & { displayName: string }>;
  votes: Array<{ fantasyTeamId: string; vote: "approve" | "veto" }>;
}

export interface TransactionsDashboardResponse {
  seasonId: string;
  teamId: string;
  settings: TransactionSettingsResponse;
  faabRemaining: number;
  waiverPriority: number;
  claimGroupRevisionNumber?: number;
  waiverPeriod?: { waiverPeriodId: string; processesAtUtc: string; status: string };
  claims: WaiverClaimView[];
  trades: TradeView[];
  activity: TransactionActivityView[];
}

export interface AddDropRequest {
  addPlayerId: string;
  dropRosterPlayerId?: string;
}

export interface SubmitWaiverClaimRequest extends AddDropRequest {
  bid: number;
}

export interface ProposeTradeRequest {
  recipientTeamIds: string[];
  assets: TradeAssetInput[];
  message?: string;
  expiresAtUtc: string;
  parentTradeId?: string;
}

export interface MatchupPlayerView {
  rosterPlayerId: string;
  playerId: string;
  displayName: string;
  position: string;
  nflTeam?: string;
  headshotUrl?: string;
  nflTeamLogoUrl?: string;
  slotType: string;
  starter: boolean;
  points: number;
  projectedPoints: number;
  gameStatus: string;
  remaining: boolean;
  scoringBreakdown: Array<{ displayName: string; points: number; explanation: string }>;
}

export interface MatchupTeamView {
  fantasyTeamId: string;
  teamName: string;
  side: "home" | "away" | "bye";
  score: number;
  benchPoints: number;
  projectedScore: number;
  winProbability: number;
  remainingPlayers: number;
  result?: "win" | "loss" | "tie";
  players?: MatchupPlayerView[];
}

export interface MatchupView {
  matchupId: string;
  weekNumber: number;
  matchupNumber: number;
  status: "scheduled" | "live" | "final" | "corrected";
  revisionNumber: number;
  updatedAtUtc: string;
  teams: MatchupTeamView[];
}

export interface LeagueScoreboardResponse {
  leagueId: string;
  seasonId: string;
  weekNumber: number;
  serverUtc: string;
  dataScope: string;
  realtimeChannel: string;
  matchups: MatchupView[];
}

export interface StandingView {
  rank: number;
  fantasyTeamId: string;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  winningPercentage: number;
  pointsFor: number;
  pointsAgainst: number;
  divisionRecord: string;
  allPlayRecord: string;
  benchPoints: number;
  streak: string;
  waiverPriority: number;
  playoffStatus: "alive" | "clinched" | "eliminated" | "champion";
}

export interface LeagueScheduleResponse {
  seasonId: string;
  weeks: Array<{ weekNumber: number; matchups: Array<{ matchupId: string; matchupNumber: number; teams: Array<{ fantasyTeamId: string; teamName: string; side: string }> }> }>;
}

export interface PlayoffBracketResponse {
  bracketId: string;
  bracketType: "championship" | "consolation";
  status: string;
  rounds: Array<{ roundId: string; roundNumber: number; displayName: string; startWeek: number; weekCount: number; matchups: Array<{ playoffMatchupId: string; matchupNumber: number; higherSeed?: number; lowerSeed?: number; higherTeamName?: string; lowerTeamName?: string; higherScore: number; lowerScore: number; winnerTeamName?: string }> }>;
}

export interface ScoringPresetSummary {
  presetKey: ScoringPresetKey;
  displayName: string;
  description: string;
}

export interface ScoringStatisticDefinition {
  statisticKey: string;
  displayName: string;
  description: string;
  category: string;
  unitLabel: string;
  defaultCalculationType: ScoringCalculationType;
  allowedCalculationTypes: ScoringCalculationType[];
  allowedPositions: string[];
  displayOrder: number;
}

export interface ScoringRule {
  scoringRuleId: string;
  statisticKey: string;
  displayName: string;
  description: string;
  category: string;
  enabled: boolean;
  calculationType: ScoringCalculationType;
  pointValue: string;
  incrementValue?: string;
  thresholdValue?: string;
  positions: string[];
  maxAwards?: number;
  tiers: Array<{ minimum: string; maximum?: string; points: string }>;
  displayOrder: number;
}

export interface ScoringVersionSummary {
  scoringVersionId: string;
  versionNumber: number;
  status: "draft" | "active" | "superseded" | "abandoned";
  sourcePresetKey?: ScoringPresetKey;
  revisionNumber: number;
  effectiveScope?: ScoringEffectiveScope;
  effectiveFromWeek?: number;
  effectiveToWeek?: number;
  changeReason?: string;
  createdByUserId: string;
  createdAtUtc: string;
  appliedAtUtc?: string;
}

export interface ScoringConfiguration extends ScoringVersionSummary {
  leagueId: string;
  seasonId: string;
  seasonYear: number;
  rules: ScoringRule[];
}

export interface ScoringCatalogResponse {
  presets: ScoringPresetSummary[];
  statistics: ScoringStatisticDefinition[];
}

export interface StartScoringDraftRequest {
  source: "current" | "preset";
  presetKey?: ScoringPresetKey;
}

export interface SaveScoringRulesRequest {
  revisionNumber: number;
  rules: ScoringRule[];
}

export interface ScoringPreviewRequest {
  revisionNumber: number;
  effectiveScope: ScoringEffectiveScope;
  effectiveFromWeek?: number;
  effectiveToWeek?: number;
}

export interface ScoringRuleDifference {
  statisticKey: string;
  displayName: string;
  change: "added" | "removed" | "changed";
  currentValue?: string;
  proposedValue?: string;
}

export interface ScoringPreviewResponse {
  currentVersionNumber?: number;
  proposedVersionNumber: number;
  effectiveScope: ScoringEffectiveScope;
  affectedWeeks: number[];
  changedRuleCount: number;
  differences: ScoringRuleDifference[];
  recalculationRequired: boolean;
  sampleStatus: string;
}

export interface ApplyScoringDraftRequest extends ScoringPreviewRequest {
  changeReason: string;
}
