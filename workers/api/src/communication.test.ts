import { describe, expect, it } from "vitest";

import { isAllowedAttachmentUrl, requireWeek } from "./communication-rules";

describe("communication validation", () => {
  it("accepts only league-owned uploads and approved Giphy media", () => {
    expect(isAllowedAttachmentUrl("https://api.myfflapp.com/api/leagues/league-1/chat/assets/image-1", "https://api.myfflapp.com", "league-1")).toBe(true);
    expect(isAllowedAttachmentUrl("https://i.giphy.com/media/example/giphy.gif", "https://api.myfflapp.com", "league-1")).toBe(true);
    expect(isAllowedAttachmentUrl("https://api.myfflapp.com/api/leagues/league-2/chat/assets/image-1", "https://api.myfflapp.com", "league-1")).toBe(false);
    expect(isAllowedAttachmentUrl("https://example.com/tracker.gif", "https://api.myfflapp.com", "league-1")).toBe(false);
  });

  it("keeps weekly reports inside the NFL fantasy season range", () => {
    expect(requireWeek("1")).toBe(1);
    expect(requireWeek(22)).toBe(22);
    expect(() => requireWeek(0)).toThrow("Week must be between 1 and 22");
    expect(() => requireWeek(3.5)).toThrow("Week must be between 1 and 22");
  });
});
