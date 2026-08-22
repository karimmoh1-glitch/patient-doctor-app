import { describe, it, expect } from "vitest";
import { suggestSpecialty } from "../specialty";

describe("suggestSpecialty", () => {
  it("matches chest pain to Cardiology", () => {
    expect(suggestSpecialty("I have chest pain and my heart is racing")).toBe("Cardiology");
  });

  it("matches headache to Neurology", () => {
    expect(suggestSpecialty("sharp headache and dizziness since this morning")).toBe("Neurology");
  });

  it("matches skin rash to Dermatology", () => {
    expect(suggestSpecialty("itchy rash on my arm")).toBe("Dermatology");
  });

  it("is case-insensitive", () => {
    expect(suggestSpecialty("SEVERE HEADACHE")).toBe("Neurology");
  });

  it("falls back to General Practice when nothing matches", () => {
    expect(suggestSpecialty("I feel a bit off today")).toBe("General Practice");
  });

  it("falls back to General Practice for empty input", () => {
    expect(suggestSpecialty("")).toBe("General Practice");
  });
});
