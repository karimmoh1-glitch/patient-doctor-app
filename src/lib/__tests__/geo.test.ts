import { describe, it, expect } from "vitest";
import { distanceMiles } from "../geo";

describe("distanceMiles", () => {
  it("returns ~0 for the same point", () => {
    expect(distanceMiles(40.7128, -74.006, 40.7128, -74.006)).toBeCloseTo(0, 5);
  });

  it("computes a known distance (NYC to Boston, ~190 miles)", () => {
    const d = distanceMiles(40.7128, -74.006, 42.3601, -71.0589);
    expect(d).toBeGreaterThan(180);
    expect(d).toBeLessThan(200);
  });

  it("is symmetric", () => {
    const a = distanceMiles(40.7128, -74.006, 42.3601, -71.0589);
    const b = distanceMiles(42.3601, -71.0589, 40.7128, -74.006);
    expect(a).toBeCloseTo(b, 5);
  });
});
