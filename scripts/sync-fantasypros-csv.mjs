import process from "node:process";

const apiBaseUrl = process.env.MYFFL_API_BASE_URL ?? "https://api.myfflapp.com";
const importToken = process.env.MYFFL_FANTASYPROS_CSV_IMPORT_TOKEN;
const seasonYear = Number(process.env.FANTASYPROS_SEASON_YEAR ?? new Date().getUTCFullYear());
const scoring = normalizeScoring(process.env.FANTASYPROS_SCORING ?? "PPR");
const scope = process.env.FANTASYPROS_CSV_SCOPE ?? "OVERALL";

if (!importToken) {
  throw new Error("MYFFL_FANTASYPROS_CSV_IMPORT_TOKEN is required.");
}

const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/internal/fantasypros/csv-sync`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${importToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    seasonYear,
    scoring,
    scope,
    sourceUpdatedAt: new Date().toISOString(),
  }),
});

const text = await response.text();
if (!response.ok) throw new Error(`FantasyPros CSV sync failed with ${response.status}: ${text}`);
console.log(text);

function normalizeScoring(value) {
  const scoringValue = value.toUpperCase();
  if (!["STD", "HALF", "PPR"].includes(scoringValue)) throw new Error("FANTASYPROS_SCORING must be STD, HALF, or PPR.");
  return scoringValue;
}
