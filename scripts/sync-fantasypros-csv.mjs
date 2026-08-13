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
const scopes = (process.env.FANTASYPROS_CSV_SCOPES ?? "Overall,QB,RB,WR,TE,K,DST")
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
    await selectScope(page, scope);
    const csv = await downloadCsv(page, downloadRoot, scope);
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
