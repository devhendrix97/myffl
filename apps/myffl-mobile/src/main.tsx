import React, { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type {
  ApiEnvelope,
  AuthSessionResponse,
  MessageResponse,
  PhaseStatusResponse,
  RegistrationResponse,
  VerifyEmailResponse,
} from "@myffl/api-contracts";
import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Eye,
  EyeOff,
  Home,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  Mail,
  Radio,
  RefreshCw,
  Settings,
  ShieldCheck,
  Trophy,
  UserPlus,
  Users,
} from "lucide-react";
import "./styles.css";

const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ??
  (isLocalHost ? "http://localhost:8787" : "https://api.myfflapp.com");

class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function apiRequest<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; accessToken?: string } = {},
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "POST",
    credentials: "include",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.ok || !payload.data) {
    throw new ApiClientError(
      payload.error?.message ?? "The request could not be completed.",
      payload.error?.code ?? "request_failed",
      response.status,
    );
  }
  return payload.data;
}

function App() {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [booting, setBooting] = useState(true);
  const route = window.location.pathname;

  useEffect(() => {
    if (route === "/verify-email" || route === "/reset-password") {
      setBooting(false);
      return;
    }
    apiRequest<AuthSessionResponse>("/auth/refresh", { body: {} })
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setBooting(false));
  }, [route]);

  useEffect(() => {
    if (!session) return;
    const refreshIn = Math.max(
      5000,
      new Date(session.accessTokenExpiresAtUtc).getTime() - Date.now() - 60000,
    );
    const timer = window.setTimeout(() => {
      apiRequest<AuthSessionResponse>("/auth/refresh", { body: {} })
        .then(setSession)
        .catch(() => setSession(null));
    }, refreshIn);
    return () => window.clearTimeout(timer);
  }, [session]);

  if (route === "/verify-email") return <VerifyEmailPage />;
  if (route === "/reset-password") return <ResetPasswordPage />;
  if (booting) return <LoadingScreen label="Restoring your session" />;
  if (session) {
    return (
      <Dashboard
        session={session}
        onLogout={async () => {
          try {
            await apiRequest<MessageResponse>("/auth/logout", {
              body: {},
              accessToken: session.accessToken,
            });
          } finally {
            setSession(null);
          }
        }}
      />
    );
  }
  return <AuthScreen onAuthenticated={setSession} />;
}

type AuthView = "login" | "register" | "forgot";

function AuthScreen({ onAuthenticated }: { onAuthenticated: (session: AuthSessionResponse) => void }) {
  const [view, setView] = useState<AuthView>("login");
  const [pendingRegistration, setPendingRegistration] = useState<RegistrationResponse | null>(null);

  return (
    <main className="auth-page">
      <section className="auth-context" aria-label="myFFL league preview">
        <Brand />
        <div className="context-copy">
          <p className="eyebrow">League command center</p>
          <h1>Your league. Your rules.</h1>
          <p className="context-subtitle">Competition with commissioner control built in.</p>
        </div>
        <LeaguePulse />
        <div className="trust-row">
          <span><Trophy size={16} /> Compete</span>
          <span><ShieldCheck size={16} /> Trust</span>
          <span><Users size={16} /> Community</span>
        </div>
      </section>

      <section className="auth-panel">
        <div className="mobile-brand"><Brand /></div>
        {pendingRegistration ? (
          <RegistrationPending
            registration={pendingRegistration}
            onBack={() => {
              setPendingRegistration(null);
              setView("login");
            }}
          />
        ) : view === "forgot" ? (
          <ForgotPasswordForm onBack={() => setView("login")} />
        ) : (
          <>
            <div className="segmented" role="tablist" aria-label="Account access">
              <button
                type="button"
                role="tab"
                aria-selected={view === "login"}
                className={view === "login" ? "active" : ""}
                onClick={() => setView("login")}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "register"}
                className={view === "register" ? "active" : ""}
                onClick={() => setView("register")}
              >
                Create account
              </button>
            </div>
            {view === "login" ? (
              <LoginForm onAuthenticated={onAuthenticated} onForgot={() => setView("forgot")} />
            ) : (
              <RegisterForm onRegistered={setPendingRegistration} />
            )}
          </>
        )}
      </section>
    </main>
  );
}

function LoginForm({
  onAuthenticated,
  onForgot,
}: {
  onAuthenticated: (session: AuthSessionResponse) => void;
  onForgot: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [notice, setNotice] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      onAuthenticated(
        await apiRequest<AuthSessionResponse>("/auth/login", {
          body: { email, password, clientType: "browser" },
        }),
      );
    } catch (requestError) {
      setError(asApiError(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiRequest<MessageResponse>("/auth/resend-verification", {
        body: { email },
      });
      setNotice(result.message);
    } catch (requestError) {
      setError(asApiError(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <header>
        <p className="eyebrow">Welcome back</p>
        <h2>Sign in to myFFL</h2>
      </header>
      <FormNotice error={error} notice={notice} />
      <TextField
        label="Email address"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
      />
      <PasswordField
        label="Password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />
      <button className="text-action" type="button" onClick={onForgot}>Forgot password?</button>
      <button className="primary-button" type="submit" disabled={busy}>
        {busy ? <LoaderCircle className="spin" size={18} /> : <LogIn size={18} />}
        Sign in
      </button>
      {error?.code === "email_not_verified" && (
        <button className="outline-button" type="button" disabled={busy} onClick={resendVerification}>
          <Mail size={18} /> Send another verification email
        </button>
      )}
    </form>
  );
}

function RegisterForm({ onRegistered }: { onRegistered: (result: RegistrationResponse) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onRegistered(
        await apiRequest<RegistrationResponse>("/auth/register", {
          body: { displayName, email, password, passwordConfirmation },
        }),
      );
    } catch (requestError) {
      setError(asApiError(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <header>
        <p className="eyebrow">Join the league</p>
        <h2>Create your account</h2>
      </header>
      <FormNotice error={error} />
      <TextField label="Display name" value={displayName} onChange={setDisplayName} autoComplete="name" />
      <TextField label="Email address" type="email" value={email} onChange={setEmail} autoComplete="email" />
      <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="new-password" />
      <PasswordField
        label="Confirm password"
        value={passwordConfirmation}
        onChange={setPasswordConfirmation}
        autoComplete="new-password"
      />
      <p className="field-hint">12+ characters with uppercase, lowercase, and a number.</p>
      <button className="primary-button" type="submit" disabled={busy}>
        {busy ? <LoaderCircle className="spin" size={18} /> : <UserPlus size={18} />}
        Create account
      </button>
    </form>
  );
}

function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [notice, setNotice] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiRequest<MessageResponse>("/auth/forgot-password", { body: { email } });
      setNotice(result.message);
    } catch (requestError) {
      setError(asApiError(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <button className="back-button" type="button" onClick={onBack} aria-label="Back to sign in">
        <ArrowLeft size={20} />
      </button>
      <header>
        <p className="eyebrow">Account recovery</p>
        <h2>Reset your password</h2>
        <p>We’ll send a secure reset link to your account email.</p>
      </header>
      <FormNotice error={error} notice={notice} />
      <TextField label="Email address" type="email" value={email} onChange={setEmail} autoComplete="email" />
      <button className="primary-button" type="submit" disabled={busy}>
        {busy ? <LoaderCircle className="spin" size={18} /> : <Mail size={18} />}
        Send reset link
      </button>
    </form>
  );
}

function RegistrationPending({
  registration,
  onBack,
}: {
  registration: RegistrationResponse;
  onBack: () => void;
}) {
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function resend() {
    setBusy(true);
    try {
      const result = await apiRequest<MessageResponse>("/auth/resend-verification", {
        body: { email: registration.email },
      });
      setNotice(result.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="result-view">
      <div className="result-icon"><Mail size={28} /></div>
      <p className="eyebrow">Check your inbox</p>
      <h2>Verify your email</h2>
      <p>
        We sent an account link to <strong>{registration.email}</strong>. Click the link to verify
        your account! Make sure to check your spam folder!
      </p>
      {registration.emailDeliveryStatus === "deferred" && (
        <FormNotice notice="Cloudflare accepted your account, but the first email was delayed. Try resend below." />
      )}
      {notice && <FormNotice notice={notice} />}
      <button className="primary-button" type="button" onClick={onBack}><LogIn size={18} /> Back to sign in</button>
      <button className="outline-button" type="button" disabled={busy} onClick={resend}>
        {busy ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={18} />} Resend email
      </button>
    </div>
  );
}

function VerifyEmailPage() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [state, setState] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Verifying your email address...");

  useEffect(() => {
    if (!token) {
      setState("error");
      setMessage("This verification link is incomplete.");
      return;
    }
    apiRequest<VerifyEmailResponse>("/auth/verify-email", { body: { token } })
      .then(() => {
        setState("success");
        setMessage("Your email is verified. You can sign in now.");
      })
      .catch((error: unknown) => {
        setState("error");
        setMessage(asApiError(error).message);
      });
  }, [token]);

  return <AccountResultPage state={state} title="Email verification" message={message} />;
}

function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [complete, setComplete] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiRequest<MessageResponse>("/auth/reset-password", {
        body: { token, password, passwordConfirmation },
      });
      setComplete(true);
    } catch (requestError) {
      setError(asApiError(requestError));
    } finally {
      setBusy(false);
    }
  }

  if (complete) {
    return (
      <AccountResultPage
        state="success"
        title="Password updated"
        message="Your sessions were closed. Sign in again with your new password."
      />
    );
  }

  return (
    <main className="account-action-page">
      <section className="account-action-panel">
        <Brand />
        <form className="auth-form" onSubmit={submit}>
          <header>
            <p className="eyebrow">Account recovery</p>
            <h1>Choose a new password</h1>
          </header>
          {!token && <FormNotice error={new ApiClientError("This reset link is incomplete.", "invalid_token", 400)} />}
          <FormNotice error={error} />
          <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" />
          <PasswordField
            label="Confirm new password"
            value={passwordConfirmation}
            onChange={setPasswordConfirmation}
            autoComplete="new-password"
          />
          <p className="field-hint">12+ characters with uppercase, lowercase, and a number.</p>
          <button className="primary-button" type="submit" disabled={busy || !token}>
            {busy ? <LoaderCircle className="spin" size={18} /> : <LockKeyhole size={18} />} Update password
          </button>
        </form>
      </section>
    </main>
  );
}

function AccountResultPage({
  state,
  title,
  message,
}: {
  state: "loading" | "success" | "error";
  title: string;
  message: string;
}) {
  return (
    <main className="account-action-page">
      <section className="account-action-panel result-view">
        <Brand />
        <div className={`result-icon ${state}`}>
          {state === "loading" ? <LoaderCircle className="spin" size={30} /> : state === "success" ? <CheckCircle2 size={30} /> : <AlertCircle size={30} />}
        </div>
        <h1>{title}</h1>
        <p>{message}</p>
        {state !== "loading" && (
          <a className="primary-button" href="/"><LogIn size={18} /> Continue to sign in</a>
        )}
      </section>
    </main>
  );
}

function Dashboard({ session, onLogout }: { session: AuthSessionResponse; onLogout: () => Promise<void> }) {
  const [phaseStatus, setPhaseStatus] = useState<PhaseStatusResponse | null>(null);
  useEffect(() => {
    apiRequest<PhaseStatusResponse>("/phase-status", { method: "GET" })
      .then(setPhaseStatus)
      .catch(() => setPhaseStatus(null));
  }, []);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Primary">
          <a className="active" href="/"><Home size={19} /> Home</a>
          <a href="#leagues"><Trophy size={19} /> Leagues</a>
          <a href="#team"><Users size={19} /> My team</a>
          <a href="#schedule"><CalendarDays size={19} /> Schedule</a>
          <a href="#live"><Radio size={19} /> Live scoring</a>
        </nav>
        <button className="sidebar-action" type="button" onClick={onLogout}><LogOut size={19} /> Sign out</button>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">Home</p>
            <h1>Welcome, {session.displayName}</h1>
          </div>
          <div className="user-avatar" aria-label={`Signed in as ${session.displayName}`}>
            {session.displayName.slice(0, 2).toUpperCase()}
          </div>
        </header>

        <section className="league-empty" id="leagues">
          <div className="field-lines" aria-hidden="true" />
          <div>
            <p className="eyebrow">2026 season</p>
            <h2>Build your first league</h2>
            <p>League creation and commissioner controls arrive in Phase 2.</p>
            <button className="primary-button" type="button" disabled><Trophy size={18} /> Create league</button>
          </div>
        </section>

        <section className="status-section">
          <div className="section-heading">
            <div><p className="eyebrow">Platform</p><h2>Foundation status</h2></div>
            <Settings size={22} />
          </div>
          <div className="status-grid">
            {(phaseStatus?.items ?? []).map((item) => (
              <article className="status-card" key={item.key}>
                <span className={`status-dot ${item.status}`} />
                <h3>{item.label}</h3>
                <p>{item.summary}</p>
              </article>
            ))}
          </div>
        </section>
      </section>

      <nav className="mobile-nav" aria-label="Primary mobile navigation">
        <a className="active" href="/" aria-label="Home"><Home size={21} /></a>
        <a href="#leagues" aria-label="Leagues"><Trophy size={21} /></a>
        <a href="#team" aria-label="My team"><Users size={21} /></a>
        <a href="#live" aria-label="Live scoring"><Radio size={21} /></a>
      </nav>
    </main>
  );
}

function LeaguePulse() {
  return (
    <div className="league-pulse">
      <div className="pulse-heading"><span>Sunday pulse</span><span className="live-indicator">Live</span></div>
      <div className="matchup-row">
        <span className="team-badge blue">GG</span>
        <span className="team-name">Gridiron Gang<small>6-2</small></span>
        <strong>127.6</strong>
      </div>
      <div className="matchup-row">
        <span className="team-badge red">RZ</span>
        <span className="team-name">Red Zone<small>5-3</small></span>
        <strong>118.2</strong>
      </div>
      <div className="win-meter"><span /><span /></div>
      <div className="pulse-footer"><span>Q4 · 2:15</span><span>78% win chance</span></div>
    </div>
  );
}

function Brand() {
  return <div className="brand-mark" aria-label="myFFL"><span className="brand-my">my</span><span className="brand-f">F</span><span className="brand-fl">FL</span></div>;
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete: string;
}) {
  return (
    <label className="field-label">
      <span>{label}</span>
      <input required type={type} value={value} autoComplete={autoComplete} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field-label">
      <span>{label}</span>
      <span className="password-wrap">
        <input
          required
          type={visible ? "text" : "password"}
          value={value}
          autoComplete={autoComplete}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? "Hide password" : "Show password"}>
          {visible ? <EyeOff size={19} /> : <Eye size={19} />}
        </button>
      </span>
    </label>
  );
}

function FormNotice({ error, notice }: { error?: ApiClientError | null; notice?: string }) {
  if (!error && !notice) return null;
  return (
    <div className={`form-notice ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>
      {error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
      <span>{error?.message ?? notice}</span>
    </div>
  );
}

function LoadingScreen({ label }: { label: string }) {
  return (
    <main className="loading-screen">
      <Brand />
      <LoaderCircle className="spin" size={26} />
      <span>{label}</span>
    </main>
  );
}

function asApiError(error: unknown): ApiClientError {
  return error instanceof ApiClientError
    ? error
    : new ApiClientError(error instanceof Error ? error.message : "The request failed.", "request_failed", 500);
}

createRoot(document.getElementById("root")!).render(<App />);
