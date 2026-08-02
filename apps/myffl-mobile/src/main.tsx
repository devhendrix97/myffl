import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ApiEnvelope, PhaseStatusResponse } from "@myffl/api-contracts";
import "./styles.css";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";

function App() {
  const [phaseStatus, setPhaseStatus] = useState<PhaseStatusResponse | null>(null);
  const [apiState, setApiState] = useState("Checking API...");

  useEffect(() => {
    fetch(`${apiBaseUrl}/phase-status`)
      .then((response) => response.json() as Promise<ApiEnvelope<PhaseStatusResponse>>)
      .then((body) => {
        if (!body.ok || !body.data) throw new Error(body.error?.message ?? "API error");
        setPhaseStatus(body.data);
        setApiState("API connected");
      })
      .catch((error: unknown) => {
        setApiState(error instanceof Error ? error.message : "API unavailable");
      });
  }, []);

  return (
    <main className="shell">
      <section className="topbar">
        <div className="brand-mark">my<span>FFL</span></div>
        <div className="status-pill">{apiState}</div>
      </section>

      <section className="scoreboard">
        <p className="eyebrow">Phase 1</p>
        <h1>Fantasy football control center</h1>
        <p>
          Mobile PWA foundation is live. Authentication, leagues, scoring, draft,
          and gameday modules will land in sequence.
        </p>
      </section>

      <section className="quick-grid">
        {(phaseStatus?.items ?? fallbackItems).map((item) => (
          <article key={item.key} className="feature-card">
            <span className={`dot ${item.status}`} />
            <h2>{item.label}</h2>
            <p>{item.summary}</p>
          </article>
        ))}
      </section>

      <nav className="tabbar" aria-label="Primary">
        <a className="active">Home</a>
        <a>Leagues</a>
        <a>Team</a>
        <a>Scores</a>
      </nav>
    </main>
  );
}

const fallbackItems: PhaseStatusResponse["items"] = [
  {
    key: "api",
    label: "API",
    status: "planned",
    summary: "Start the local Worker API to see live phase status.",
  },
];

createRoot(document.getElementById("root")!).render(<App />);

