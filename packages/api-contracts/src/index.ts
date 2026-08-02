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

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthSessionResponse {
  userId: string;
  displayName: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAtUtc: string;
}

