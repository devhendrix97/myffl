import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer";

const apiBaseUrl = process.env.MYFFL_API_BASE_URL ?? "https://api.myfflapp.com";
const importToken = process.env.MYFFL_FANTASYPROS_CSV_IMPORT_TOKEN;
const seasonYear = Number(process.env.FANTASYPROS_SEASON_YEAR ?? new Date().getUTCFullYear());
const scoring = normalizeScoring(process.env.FANTASYPROS_SCORING ?? "PPR");
const fantasyProsUrl = process.env.FANTASYPROS_RANKINGS_URL ?? "https://www.fantasypros.com/nfl/rankings/qb-cheatsheets.php";
const scopes = (process.env.FANTASYPROS_CSV_SCOPES ?? "Overall")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);

if (!importToken) {
  throw new Error("MYFFL_FANTASYPROS_CSV_IMPORT_TOKEN is required.");
}

const downloadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "myffl-fantasypros-"));
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  await page.setViewport({ width: 1280, height: 900 });
  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadRoot });
  await page.goto(fantasyProsUrl, { waitUntil: "networkidle2", timeout: 60_000 });
  await dismissPopups(page);

  for (const scope of scopes) {
    const csv = await loadRankingsCsv(page, downloadRoot, scope);
    const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/internal/fantasypros/csv`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${importToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        csv,
        seasonYear,
        scoring,
        scope: scope.toUpperCase(),
        sourceUpdatedAt: new Date().toISOString(),
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${scope} import failed with ${response.status}: ${text}`);
    console.log(`${scope}: ${text}`);
  }
} finally {
  await browser.close();
  await fs.rm(downloadRoot, { recursive: true, force: true });
}

async function selectScope(page, scope) {
  const normalized = scope.toLowerCase();
  const clicked = await page.evaluate((target) => {
    const links = [...document.querySelectorAll("a,button")];
    const element = links.find((candidate) => candidate.textContent?.trim().toLowerCase() === target);
    if (!element) return false;
    element.click();
    return true;
  }, normalized);
  if (!clicked && normalized !== "overall") {
    throw new Error(`Could not find FantasyPros ranking tab "${scope}".`);
  }
  await page.waitForNetworkIdle({ idleTime: 750, timeout: 20_000 }).catch(() => undefined);
}

async function downloadCsv(page, downloadRoot, scope) {
  const before = new Set(await listCsvFiles(downloadRoot));
  const clicked = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("button,a")];
    const control = controls.find((item) => {
      const label = `${item.getAttribute("aria-label") ?? ""} ${item.getAttribute("title") ?? ""} ${item.textContent ?? ""}`.toLowerCase();
      return label.includes("download csv") || label.includes("csv");
    }) ?? [...document.querySelectorAll(".pills-wrap button")][0];
    if (!control) return false;
    control.click();
    return true;
  });
  if (!clicked) throw new Error(`Could not find the FantasyPros CSV download button for ${scope}.`);

  const file = await waitForNewCsv(downloadRoot, before);
  return fs.readFile(path.join(downloadRoot, file), "utf8");
}

async function loadRankingsCsv(page, downloadRoot, scope) {
  const exported = await fetchExportCsv(scope).catch((error) => {
    console.warn(`${scope}: direct export unavailable. ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  if (exported) return exported;

  try {
    await selectScope(page, scope);
    return await downloadCsv(page, downloadRoot, scope);
  } catch (error) {
    console.warn(`${scope}: CSV download unavailable, falling back to table extraction. ${error instanceof Error ? error.message : String(error)}`);
    return extractRankingsTableCsv(page, scope);
  }
}

async function fetchExportCsv(scope) {
  const url = exportUrlForScope(scope);
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.ms-excel,text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 myFFL rankings sync",
    },
  });
  if (!response.ok) throw new Error(`FantasyPros export returned ${response.status}.`);
  const body = await response.text();
  const csv = htmlTableToCsv(body);
  if (!csv) throw new Error("FantasyPros export did not include a rankings table.");
  return csv;
}

function exportUrlForScope(scope) {
  const normalizedScope = scope.toLowerCase();
  const path = normalizedScope === "overall"
    ? scoring === "PPR"
      ? "ppr-cheatsheets.php"
      : scoring === "HALF"
        ? "half-point-ppr-cheatsheets.php"
        : "consensus-cheatsheets.php"
    : `${normalizedScope === "dst" ? "dst" : normalizedScope}-cheatsheets.php`;
  const url = new URL(`https://www.fantasypros.com/nfl/rankings/${path}`);
  url.searchParams.set("export", "xls");
  return url.toString();
}

function htmlTableToCsv(html) {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => decodeHtml(stripTags(cell[1])).trim()))
    .filter((cells) => cells.some(Boolean));
  const headerIndex = rows.findIndex((cells) => cells.some((cell) => /player/i.test(cell)));
  if (headerIndex < 0) return undefined;
  const headers = rows[headerIndex].map(normalizeExportHeader);
  const records = rows.slice(headerIndex + 1).map((cells) => {
    const record = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
    const player = record.Player ?? "";
    const positionRank = record.Position ?? "";
    const parsed = parsePlayerCell(player);
    return {
      Rank: record.Rank,
      Player: parsed.name || player,
      Team: parsed.team || record.Team || "",
      Position: parsePosition(positionRank),
      Bye: record.Bye ?? "",
      Tier: /^tier\s+\d+/i.test(record.Rank ?? "") ? (record.Rank.match(/\d+/)?.[0] ?? "") : record.Tier ?? "",
    };
  }).filter((row) => Number.isFinite(Number(row.Rank)) && row.Player);
  return records.length ? toCsv(records) : undefined;
}

function normalizeExportHeader(value) {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized === "rk" || normalized === "rank" || normalized === "ecr") return "Rank";
  if (normalized.includes("player")) return "Player";
  if (normalized === "pos" || normalized === "position") return "Position";
  if (normalized.includes("bye")) return "Bye";
  if (normalized.includes("tier")) return "Tier";
  if (normalized === "team" || normalized === "tm") return "Team";
  return value;
}

function parsePlayerCell(value) {
  const match = value.match(/^(.*?)\s+\(([A-Z]{2,3})\)/);
  return match ? { name: match[1].trim(), team: match[2] } : { name: value.trim(), team: "" };
}

function parsePosition(value) {
  const match = String(value ?? "").match(/[A-Z]+/);
  return match?.[0] ?? "";
}

function stripTags(value) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function extractRankingsTableCsv(page, scope) {
  const rows = await page.evaluate((fallbackScope) => {
    const visibleTables = [...document.querySelectorAll("table")]
      .filter((table) => table.getClientRects().length > 0 && table.textContent?.toLowerCase().includes("player"));
    const table = visibleTables[0];
    if (!table) return [];
    const headers = [...table.querySelectorAll("thead th")].map((cell) => cell.textContent?.trim() ?? "");
    const bodyRows = [...table.querySelectorAll("tbody tr")];
    return bodyRows.map((row, rowIndex) => {
      const cells = [...row.querySelectorAll("th,td")].map((cell) => cell.textContent?.replace(/\s+/g, " ").trim() ?? "");
      const record = Object.fromEntries(headers.map((header, index) => [header || `Column ${index + 1}`, cells[index] ?? ""]));
      const playerCell = cells.find((cell) => /[A-Za-z]/.test(cell) && !/^(QB|RB|WR|TE|K|DST|DEF|ARI|ATL|BAL|BUF|CAR|CHI|CIN|CLE|DAL|DEN|DET|GB|HOU|IND|JAX|KC|LV|LAC|LAR|MIA|MIN|NE|NO|NYG|NYJ|PHI|PIT|SEA|SF|TB|TEN|WAS)$/i.test(cell));
      return {
        Rank: record.RK ?? record.Rank ?? record.ECR ?? cells[0] ?? String(rowIndex + 1),
        Player: record.PLAYER ?? record.Player ?? playerCell ?? "",
        Team: record.TEAM ?? record.Team ?? record.TM ?? record.Tm ?? "",
        Position: record.POS ?? record.Position ?? fallbackScope,
        Bye: record.BYE ?? record.Bye ?? record["Bye Week"] ?? "",
        Tier: record.TIERS ?? record.Tier ?? "",
      };
    }).filter((row) => row.Player && Number.isFinite(Number(String(row.Rank).replace(/[^0-9.]/g, ""))));
  }, scope.toUpperCase());

  if (!rows.length) throw new Error(`Could not extract FantasyPros rankings table for ${scope}.`);
  return toCsv(rows);
}

async function waitForNewCsv(downloadRoot, before) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const files = await listCsvFiles(downloadRoot);
    const next = files.find((file) => !before.has(file) && !file.endsWith(".crdownload"));
    if (next) return next;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("FantasyPros CSV download did not finish in time.");
}

async function listCsvFiles(downloadRoot) {
  const entries = await fs.readdir(downloadRoot).catch(() => []);
  return entries.filter((entry) => entry.toLowerCase().endsWith(".csv"));
}

async function dismissPopups(page) {
  await page.evaluate(() => {
    for (const text of ["Accept", "I Accept", "Continue", "No Thanks", "Close"]) {
      const button = [...document.querySelectorAll("button,a")].find((item) => item.textContent?.trim() === text);
      if (button) button.click();
    }
  }).catch(() => undefined);
}

function normalizeScoring(value) {
  const scoringValue = value.toUpperCase();
  if (!["STD", "HALF", "PPR"].includes(scoringValue)) throw new Error("FANTASYPROS_SCORING must be STD, HALF, or PPR.");
  return scoringValue;
}

function toCsv(rows) {
  const headers = ["Rank", "Player", "Team", "Position", "Bye", "Tier"];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}
