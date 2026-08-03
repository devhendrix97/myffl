import { describe, expect, it } from "vitest";
import { providerDataScope } from "./game-feed";

describe("game feed provider routing", () => {
  it("uses production data in live mode regardless of a stale run id", () => {
    expect(providerDataScope("live", "old-run")).toBe("production");
    expect(providerDataScope("live", null)).toBe("production");
  });

  it("selects only the explicitly active replay scope in replay mode", () => {
    expect(providerDataScope("replay", "run-123")).toBe("simulation:run-123");
    expect(providerDataScope("replay", null)).toBe("production");
  });
});
