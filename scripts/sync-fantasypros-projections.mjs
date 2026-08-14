import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const positions = normalizePositions(process.env.FANTASYPROS_PROJECTION_POSITIONS ?? "QB,RB,WR,TE,K,DST");
const projectionType = normalizeProjectionType(process.env.FANTASYPROS_PROJECTION_TYPE ?? "weekly");
const seasonYear = Number(process.env.FANTASYPROS_SEASON_YEAR ?? new Date().getUTCFullYear());
const weekNumber = process.env.FANTASYPROS_WEEK ? Number(process.env.FANTASYPROS_WEEK) : undefined;
const apiBaseUrl = process.env.MYFFL_API_BASE_URL ?? "https://api.myfflapp.com";
const importToken = process.env.MYFFL_FANTASYPROS_CSV_IMPORT_TOKEN;
const inputDirectory = process.env.FANTASYPROS_PROJECTION_INPUT_DIR;

if (!importToken) throw new Error("MYFFL_FANTASYPROS_CSV_IMPORT_TOKEN is required.");
if (!Number.isInteger(seasonYear) || seasonYear < 2020) throw new Error("FANTASYPROS_SEASON_YEAR must be a valid NFL season.");
if (weekNumber !== undefined && (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 22)) {
  throw new Error("FANTASYPROS_WEEK must be 1-22 when provided.");
}

const csvFiles = inputDirectory
  ? await csvFilesFromDirectory(inputDirectory, positions)
  : await downloadProjectionCsvs(positions, projectionType);

for (const item of csvFiles) {
  const csv = await readFile(item.file, "utf8");
  const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/internal/fantasypros/projections/csv`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${importToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      csv,
      seasonYear,
      projectionType,
      ...(weekNumber === undefined ? {} : { weekNumber }),
      position: item.position,
      sourceUpdatedAt: new Date().toISOString(),
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`FantasyPros ${item.position} projection import failed with ${response.status}: ${text}`);
  console.log(text);
}

async function downloadProjectionCsvs(positionList, type) {
  const { launch } = await import("puppeteer");
  const downloadDir = path.resolve(".tmp", "fantasypros-projections", `${Date.now()}`);
  await mkdir(downloadDir, { recursive: true });
  const browser = await launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    const client = await page.createCDPSession();
    await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
    const files = [];
    for (const position of positionList) {
      const url = `https://www.fantasypros.com/nfl/projections/${position.toLowerCase()}.php${type === "season" ? "?week=draft" : ""}`;
      const before = await existingCsvs(downloadDir);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForSelector("a.export", { timeout: 20_000 });
      const directFile = await downloadExportHref(page, downloadDir, position);
      if (directFile) {
        files.push({ position, file: directFile });
        continue;
      }
      await page.click("a.export");
      const file = await waitForNewCsv(downloadDir, before);
      files.push({ position, file });
    }
    return files;
  } finally {
    await browser.close();
    if (!process.env.FANTASYPROS_KEEP_DOWNLOADS) {
      process.on("exit", () => void rm(downloadDir, { recursive: true, force: true }));
    }
  }
}

async function downloadExportHref(page, downloadDir, position) {
  const href = await page.$eval("a.export", (anchor) => anchor.href).catch(() => "");
  if (!href || href.startsWith("javascript:")) return undefined;
  const cookies = await page.cookies();
  const cookie = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
  const response = await fetch(href, {
    headers: {
      accept: "text/csv,application/vnd.ms-excel,text/plain,*/*",
      cookie,
      "user-agent": await page.evaluate(() => navigator.userAgent),
    },
  });
  if (!response.ok) throw new Error(`FantasyPros ${position} export returned ${response.status}.`);
  const text = await response.text();
  if (!text.includes("Player") || !text.includes("Team")) return undefined;
  const file = path.join(downloadDir, `fantasypros-projections-${position.toLowerCase()}.csv`);
  await writeFile(file, text, "utf8");
  return file;
}

async function csvFilesFromDirectory(directory, positionList) {
  const entries = await readdir(directory);
  return positionList.map((position) => {
    const match = entries.find((entry) => entry.toLowerCase().includes(`_${position.toLowerCase()}.csv`))
      ?? entries.find((entry) => entry.toLowerCase().includes(`projections_${position.toLowerCase()}`));
    if (!match) throw new Error(`No FantasyPros ${position} projection CSV found in ${directory}.`);
    return { position, file: path.join(directory, match) };
  });
}

async function existingCsvs(directory) {
  try {
    return new Set((await readdir(directory)).filter((file) => /\.(csv|xls)$/i.test(file)));
  } catch {
    return new Set();
  }
}

async function waitForNewCsv(directory, before) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await existingCsvs(directory);
    for (const file of current) {
      if (!before.has(file) && !file.endsWith(".crdownload")) return path.join(directory, file);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for FantasyPros CSV download.");
}

function normalizeProjectionType(value) {
  const type = String(value).toLowerCase();
  if (type !== "season" && type !== "weekly") throw new Error("FANTASYPROS_PROJECTION_TYPE must be season or weekly.");
  return type;
}

function normalizePositions(value) {
  const positions = String(value).split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
  for (const position of positions) {
    if (!["QB", "RB", "WR", "TE", "K", "DST"].includes(position)) throw new Error(`Unsupported projection position: ${position}`);
  }
  return positions;
}
