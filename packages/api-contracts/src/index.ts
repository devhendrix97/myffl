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
  phase: "phase-1";
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
