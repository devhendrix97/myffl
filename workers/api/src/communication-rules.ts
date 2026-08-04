import { ApiException } from "./http";

export function isAllowedAttachmentUrl(value: string, apiBaseUrl: string, leagueId: string): boolean {
  try {
    const url = new URL(value);
    const isLeagueAsset =
      url.origin === new URL(apiBaseUrl).origin &&
      url.pathname.startsWith(`/api/leagues/${leagueId}/chat/assets/`);
    const isGiphyAsset =
      url.protocol === "https:" && ["media.giphy.com", "i.giphy.com"].includes(url.hostname);
    return isLeagueAsset || isGiphyAsset;
  } catch {
    return false;
  }
}

export function requireWeek(value: unknown): number {
  const week = Number(value);
  if (!Number.isInteger(week) || week < 1 || week > 22) {
    throw new ApiException(400, "invalid_week", "Week must be between 1 and 22.");
  }
  return week;
}
