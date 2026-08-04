import { describe, expect, it } from "vitest";

import { pointsMilli, requiredReason } from "./admin-rules";

describe("administrator correction rules", () => {
  it("stores positive, negative, and decimal scores exactly in thousandths", () => {
    expect(pointsMilli(15.25)).toBe(15250);
    expect(pointsMilli(-2.125)).toBe(-2125);
    expect(pointsMilli(0)).toBe(0);
  });

  it("rejects excessive precision and unsafe score ranges", () => {
    expect(() => pointsMilli(1.2345)).toThrow("three decimal places");
    expect(() => pointsMilli(1001)).toThrow("between -1000 and 1000");
  });

  it("requires a meaningful audit reason", () => {
    expect(requiredReason("  provider correction  ")).toBe("provider correction");
    expect(() => requiredReason("no")).toThrow("between 4 and 500");
  });
});
