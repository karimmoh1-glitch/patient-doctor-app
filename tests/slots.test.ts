import { describe, it, expect } from "vitest";
import { generateSlots, validateAvailabilityWindows } from "../server/services/schedulingService";

const TUESDAY = 2;
const hours = (h: number, m = 0) => h * 60 + m;
const iso = (d: Date) => d.toISOString();

describe("generateSlots", () => {
  it("offers 30-minute slots inside a window, expressed in the doctor's time zone", () => {
    // Tuesday 2026-10-27 09:00–11:00 Pacific (PDT, UTC-7) -> 16:00Z..
    const slots = generateSlots({
      rules: [{ weekday: TUESDAY, startMinute: hours(9), endMinute: hours(11) }],
      timezone: "America/Los_Angeles",
      now: new Date("2026-10-26T12:00:00Z"),
      days: 3,
      busy: [],
    });
    expect(slots.map(iso)).toEqual([
      "2026-10-27T16:00:00.000Z",
      "2026-10-27T16:30:00.000Z",
      "2026-10-27T17:00:00.000Z",
      "2026-10-27T17:30:00.000Z",
    ]);
  });

  it("keeps the doctor's wall-clock hours when daylight saving ends (the UTC time moves instead)", () => {
    // 2026-11-03 is a Tuesday after the US fall-back on 11-01: Pacific is now UTC-8.
    const slots = generateSlots({
      rules: [{ weekday: TUESDAY, startMinute: hours(9), endMinute: hours(9, 30) }],
      timezone: "America/Los_Angeles",
      now: new Date("2026-11-02T00:00:00Z"),
      days: 3,
      busy: [],
    });
    expect(slots.map(iso)).toEqual(["2026-11-03T17:00:00.000Z"]);
  });

  it("never offers a local time that does not exist on the spring-forward day", () => {
    // 2026-03-08 (Sunday): clocks jump 02:00 -> 03:00 in New York.
    const slots = generateSlots({
      rules: [{ weekday: 0, startMinute: hours(1, 30), endMinute: hours(3, 30) }],
      timezone: "America/New_York",
      now: new Date("2026-03-07T00:00:00Z"),
      days: 2,
      busy: [],
    });
    const local = slots.map((d) => d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }));
    expect(local).toEqual(["01:30", "03:00"]);
    expect(new Set(slots.map((d) => d.getTime())).size).toBe(slots.length);
  });

  it("offers each real instant once on the fall-back day", () => {
    const slots = generateSlots({
      rules: [{ weekday: 0, startMinute: hours(0), endMinute: hours(3) }],
      timezone: "America/New_York",
      now: new Date("2026-10-31T00:00:00Z"),
      days: 2,
      busy: [],
    });
    expect(new Set(slots.map((d) => d.getTime())).size).toBe(slots.length);
  });

  it("does not offer anything inside the minimum notice period", () => {
    const now = new Date("2026-10-27T15:00:00Z"); // 08:00 Pacific
    const slots = generateSlots({
      rules: [{ weekday: TUESDAY, startMinute: hours(8), endMinute: hours(12) }],
      timezone: "America/Los_Angeles",
      now,
      days: 0,
      busy: [],
      minNoticeMinutes: 120,
    });
    expect(slots[0].getTime()).toBeGreaterThanOrEqual(now.getTime() + 120 * 60_000);
    expect(slots.map(iso)).not.toContain("2026-10-27T15:00:00.000Z");
  });

  it("removes slots that overlap an existing appointment, including partial overlap", () => {
    const slots = generateSlots({
      rules: [{ weekday: TUESDAY, startMinute: hours(9), endMinute: hours(11) }],
      timezone: "America/Los_Angeles",
      now: new Date("2026-10-26T12:00:00Z"),
      days: 3,
      busy: [{ start: new Date("2026-10-27T16:15:00Z"), end: new Date("2026-10-27T16:45:00Z") }],
    });
    // 16:00–16:30 and 16:30–17:00 both overlap the 16:15–16:45 visit.
    expect(slots.map(iso)).toEqual(["2026-10-27T17:00:00.000Z", "2026-10-27T17:30:00.000Z"]);
  });

  it("offers nothing for a doctor with no published windows", () => {
    expect(generateSlots({ rules: [], timezone: "America/Chicago", now: new Date(), days: 14, busy: [] })).toEqual([]);
  });

  it("offers nothing for an unknown time zone instead of guessing", () => {
    expect(
      generateSlots({ rules: [{ weekday: 1, startMinute: 540, endMinute: 600 }], timezone: "Mars/Olympus", now: new Date(), days: 7, busy: [] }),
    ).toEqual([]);
  });
});

describe("validateAvailabilityWindows", () => {
  it("accepts a normal week", () => {
    expect(validateAvailabilityWindows([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 780, endMinute: 1020 }])).toBeNull();
  });
  it("rejects backwards, overlapping, off-grid and out-of-range windows", () => {
    expect(validateAvailabilityWindows([{ weekday: 1, startMinute: 600, endMinute: 540 }])).not.toBeNull();
    expect(validateAvailabilityWindows([{ weekday: 1, startMinute: 540, endMinute: 660 }, { weekday: 1, startMinute: 600, endMinute: 720 }])).not.toBeNull();
    expect(validateAvailabilityWindows([{ weekday: 1, startMinute: 541, endMinute: 660 }])).not.toBeNull();
    expect(validateAvailabilityWindows([{ weekday: 9, startMinute: 540, endMinute: 660 }])).not.toBeNull();
    expect(validateAvailabilityWindows([{ weekday: 1, startMinute: 540, endMinute: 1500 }])).not.toBeNull();
    expect(validateAvailabilityWindows([{ weekday: 1, startMinute: 540, endMinute: 555 }])).not.toBeNull();
  });
});
