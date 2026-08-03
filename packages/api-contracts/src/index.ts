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
  phase: "phase-1" | "phase-2" | "phase-3" | "phase-4" | "phase-5" | "phase-6";
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
  rank: number;
  queued: boolean;
  drafted: boolean;
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
  injuryStatus?: string;
  slotType: string;
  slotIndex: number;
  eligibleSlots: string[];
  locked: boolean;
  locksAtUtc?: string;
  fantasyPoints?: number;
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
  injuryStatus?: string;
  rosteredByTeamId?: string;
  rosteredByTeamName?: string;
  watched: boolean;
  recentGames: Array<{ eventId: string; stats: Record<string, unknown>; fantasyPoints?: number }>;
}

export interface LeaguePlayerSearchItem {
  playerId: string;
  displayName: string;
  position: string;
  nflTeam?: string;
  injuryStatus?: string;
  rosteredByTeamId?: string;
  rosteredByTeamName?: string;
  watched: boolean;
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
