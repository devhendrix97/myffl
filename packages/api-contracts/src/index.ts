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
  phase: "phase-1" | "phase-2";
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
export type LeagueFormat = "redraft" | "keeper" | "dynasty" | "best-ball";
export type LeagueRole = "commissioner" | "co-commissioner" | "manager";
export type LeagueStatus = "active" | "archived" | "maintenance";

export interface RosterSlotInput {
  slotType: string;
  displayName: string;
  count: number;
  eligiblePositions: string[];
  contributesPoints: boolean;
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
  scoringPreset: "standard" | "half-ppr" | "full-ppr" | "superflex" | "te-premium" | "idp";
  commissionerTeamName: string;
  rosterSlots: RosterSlotInput[];
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
  schedule: LeagueScheduleInput;
}

export interface LeagueInvitationResponse {
  invitationCode: string;
  invitationLink: string;
  expiresAtUtc?: string;
}
