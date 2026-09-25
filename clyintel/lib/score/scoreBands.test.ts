import { describe, it, expect } from "vitest";
import { latenessScore, bandFor, BAND_LABEL, WEIGHTS, PRIOR, PROVISIONAL_MIN_DATED } from "./scoreBands";

describe("latenessScore", () => {
  it.each([
    [-5, 100], [0, 100], [1, 90], [7, 90], [8, 80], [15, 80], [16, 65], [30, 65], [31, 50], [45, 50],
    [46, 35], [60, 35], [61, 25], [75, 25], [76, 15], [90, 15], [91, 10], [105, 10], [106, 5], [120, 5], [121, 0],
  ])("%i days → %i", (days, score) => {
    expect(latenessScore(days)).toBe(score);
  });
});

describe("bandFor", () => {
  it.each([
    [100, "low"], [85, "low"], [84, "medium"], [70, "medium"], [69, "high"], [55, "high"], [54, "critical"], [0, "critical"],
  ] as const)("%i → %s", (score, band) => {
    expect(bandFor(score)).toBe(band);
  });

  it("labels", () => {
    expect(BAND_LABEL).toEqual({ low: "Low risk", medium: "Moderate risk", high: "High risk", critical: "Severe risk" });
  });
});

describe("constants", () => {
  it("locked v1 values", () => {
    expect(WEIGHTS).toEqual({ paymentHistory: 0.55, currentDelinquency: 0.3, exposure: 0.15 });
    expect(PRIOR).toBe(70);
    expect(PROVISIONAL_MIN_DATED).toBe(3);
  });
});
