import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { inQuietHours, nextRenewal, personalOccurrences, renewalOccurrences, type PersonalSchedule, type RenewalSchedule } from "../server/lib/personalSchedule";

const NY = "America/New_York";
const base = (over: Partial<PersonalSchedule> = {}): PersonalSchedule => ({ recurrence: "daily", times: ["08:00"], weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: NY, anchorDate: "2026-01-01", startDate: null, endDate: null, ...over });
const utc = (iso: string) => new Date(iso);
const local = (d: Date, zone: string) => DateTime.fromJSDate(d, { zone }).toFormat("yyyy-LL-dd HH:mm");
const dates = (list: Date[], zone: string) => list.map((d) => local(d, zone));

describe("one-time, daily and weekly reminders", () => {
  it("fires a one-time reminder once, on its day only", () => {
    const s = base({ recurrence: "once", anchorDate: "2026-06-10", times: ["09:00", "18:30"] });
    expect(dates(personalOccurrences(s, utc("2026-06-09T00:00:00Z"), utc("2026-06-12T00:00:00Z")), NY)).toEqual(["2026-06-10 09:00", "2026-06-10 18:30"]);
    expect(personalOccurrences(s, utc("2026-06-11T00:00:00Z"), utc("2026-06-30T00:00:00Z"))).toEqual([]);
  });

  it("fires every day at several times, and respects the start, the end and the selected weekdays", () => {
    const s = base({ times: ["08:00", "20:00"], weekdays: [1, 3, 5], startDate: "2026-03-02", endDate: "2026-03-13" });
    const got = dates(personalOccurrences(s, utc("2026-03-01T00:00:00Z"), utc("2026-03-31T00:00:00Z")), NY);
    expect(got).toEqual([
      "2026-03-02 08:00", "2026-03-02 20:00", "2026-03-04 08:00", "2026-03-04 20:00", "2026-03-06 08:00", "2026-03-06 20:00",
      "2026-03-09 08:00", "2026-03-09 20:00", "2026-03-11 08:00", "2026-03-11 20:00", "2026-03-13 08:00", "2026-03-13 20:00",
    ]);
  });

  it("treats the window as (from, to]: an instant exactly at 'from' is not repeated, one exactly at 'to' is included", () => {
    const s = base({ times: ["08:00"] });
    const at8 = utc("2026-05-04T12:00:00Z"); // 08:00 EDT
    expect(personalOccurrences(s, at8, utc("2026-05-04T13:00:00Z"))).toEqual([]);
    expect(personalOccurrences(s, utc("2026-05-04T11:59:00Z"), at8)).toEqual([at8]);
  });
});

describe("months and years are calendar months and years", () => {
  it("monthly on the 31st lands on the last day of every shorter month, and returns to the 31st", () => {
    const s = base({ recurrence: "monthly", anchorDate: "2026-01-31" });
    const got = dates(personalOccurrences(s, utc("2026-01-01T00:00:00Z"), utc("2026-12-31T23:59:00Z")), NY).map((x) => x.slice(0, 10));
    expect(got).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31"]);
  });

  it("monthly on the 29th, 30th: February in a leap year and a common year", () => {
    const s = base({ recurrence: "monthly", anchorDate: "2027-12-29" });
    const feb = (year: number) => dates(personalOccurrences(s, utc(`${year}-02-01T05:00:00Z`), utc(`${year}-03-01T04:00:00Z`)), NY).map((x) => x.slice(0, 10));
    expect(feb(2028)).toEqual(["2028-02-29"]);
    expect(feb(2029)).toEqual(["2029-02-28"]);
  });

  it("yearly on Feb 29 is Feb 29 in leap years and Feb 28 otherwise", () => {
    const s = base({ recurrence: "yearly", anchorDate: "2024-02-29" });
    // Windows are short by design (at most about a year); walk the years one at a time.
    const all = [2024, 2025, 2026, 2027, 2028].flatMap((y) => dates(personalOccurrences(s, utc(`${y}-01-01T00:00:00Z`), utc(`${y + 1}-01-01T00:00:00Z`)), NY).map((x) => x.slice(0, 10)));
    expect(all).toEqual(["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
  });

  it("never fires a monthly reminder before its first day", () => {
    const s = base({ recurrence: "monthly", anchorDate: "2026-05-15" });
    expect(personalOccurrences(s, utc("2026-01-01T00:00:00Z"), utc("2026-05-14T23:00:00Z"))).toEqual([]);
  });
});

describe("daylight saving and time zones", () => {
  it("keeps 08:00 on the person's clock across the spring-forward change (the UTC time moves)", () => {
    const s = base({ times: ["08:00"] });
    const got = personalOccurrences(s, utc("2026-03-06T00:00:00Z"), utc("2026-03-11T00:00:00Z"));
    expect(dates(got, NY).every((x) => x.endsWith("08:00"))).toBe(true);
    const byDay = Object.fromEntries(got.map((d) => [local(d, NY).slice(0, 10), d.toISOString().slice(11, 16)]));
    expect(byDay["2026-03-07"]).toBe("13:00"); // EST, UTC-5
    expect(byDay["2026-03-09"]).toBe("12:00"); // EDT, UTC-4
  });

  it("a time that does not exist (02:30 on the spring-forward day) fires once, at the next valid minute", () => {
    const s = base({ recurrence: "once", anchorDate: "2026-03-08", times: ["02:30"] });
    const got = personalOccurrences(s, utc("2026-03-08T00:00:00Z"), utc("2026-03-09T00:00:00Z"));
    expect(got).toHaveLength(1);
    expect(local(got[0], NY)).toBe("2026-03-08 03:30");
  });

  it("a time that happens twice (01:30 on the fall-back day) fires once", () => {
    const s = base({ recurrence: "once", anchorDate: "2026-11-01", times: ["01:30"] });
    const got = personalOccurrences(s, utc("2026-11-01T00:00:00Z"), utc("2026-11-02T00:00:00Z"));
    expect(got).toHaveLength(1);
    expect(got[0].toISOString()).toBe("2026-11-01T05:30:00.000Z"); // the first one, EDT
  });

  it("the same schedule in Cairo and New York is due at different instants, each at 08:00 locally", () => {
    const ny = personalOccurrences(base({ recurrence: "once", anchorDate: "2026-07-01" }), utc("2026-06-30T00:00:00Z"), utc("2026-07-02T00:00:00Z"));
    const cairo = personalOccurrences(base({ recurrence: "once", anchorDate: "2026-07-01", timezone: "Africa/Cairo" }), utc("2026-06-30T00:00:00Z"), utc("2026-07-02T00:00:00Z"));
    expect(local(ny[0], NY)).toBe("2026-07-01 08:00");
    expect(local(cairo[0], "Africa/Cairo")).toBe("2026-07-01 08:00");
    expect(ny[0].getTime()).not.toBe(cairo[0].getTime());
  });

  it("moving the reminder to another zone moves its instants, not its wall-clock time", () => {
    const a = personalOccurrences(base({ timezone: "America/Los_Angeles" }), utc("2026-08-01T00:00:00Z"), utc("2026-08-02T23:59:00Z"));
    const b = personalOccurrences(base({ timezone: "Africa/Cairo" }), utc("2026-08-01T00:00:00Z"), utc("2026-08-02T23:59:00Z"));
    expect(dates(a, "America/Los_Angeles").every((x) => x.endsWith("08:00"))).toBe(true);
    expect(dates(b, "Africa/Cairo").every((x) => x.endsWith("08:00"))).toBe(true);
  });
});

const renewal = (over: Partial<RenewalSchedule> = {}): RenewalSchedule => ({ renewalDate: "2026-01-31", interval: "monthly", offsetsDays: [3], cancelByDate: null, time: "09:00", timezone: NY, endDate: null, ...over });
const days = (list: { instant: Date }[], zone = NY) => list.map((o) => local(o.instant, zone).slice(0, 10));

describe("subscription and bill reminders", () => {
  it("reminds N days before each monthly renewal, with the renewal clamped to short months and never drifting", () => {
    const got = renewalOccurrences(renewal(), utc("2026-01-01T00:00:00Z"), utc("2026-06-30T00:00:00Z"));
    // Renewals: Jan 31, Feb 28, Mar 31, Apr 30, May 31, Jun 30 -> three days earlier.
    expect(days(got)).toEqual(["2026-01-28", "2026-02-25", "2026-03-28", "2026-04-27", "2026-05-28", "2026-06-27"]);
    expect(got.every((o) => o.kind === "renewal")).toBe(true);
    expect(got.map((o) => o.target)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]);
  });

  it("handles several offsets, including on the day itself", () => {
    const got = renewalOccurrences(renewal({ renewalDate: "2026-03-15", interval: "yearly", offsetsDays: [7, 1, 0] }), utc("2026-03-01T00:00:00Z"), utc("2026-03-31T00:00:00Z"));
    expect(days(got)).toEqual(["2026-03-08", "2026-03-14", "2026-03-15"]);
    expect(got.map((o) => o.offsetDays)).toEqual([7, 1, 0]);
  });

  it("annual renewals on Feb 29 are Feb 28 in common years and Feb 29 in leap years, counted from the original date", () => {
    const got = renewalOccurrences(renewal({ renewalDate: "2024-02-29", interval: "yearly", offsetsDays: [0] }), utc("2024-01-01T00:00:00Z"), utc("2029-01-01T00:00:00Z"));
    expect(got.map((o) => o.target)).toEqual(["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
  });

  it("a renewal early in the window whose reminder day is before it is not missed", () => {
    // Renewal on Mar 2, reminder 7 days earlier is Feb 23: it belongs to a window that covers Feb 23.
    const got = renewalOccurrences(renewal({ renewalDate: "2026-03-02", interval: "monthly", offsetsDays: [7] }), utc("2026-02-20T00:00:00Z"), utc("2026-02-28T00:00:00Z"));
    expect(days(got)).toEqual(["2026-02-23"]);
  });

  it("reminds about a cancellation deadline separately, with its own label", () => {
    const got = renewalOccurrences(renewal({ renewalDate: "2026-06-20", interval: "yearly", offsetsDays: [2], cancelByDate: "2026-06-10" }), utc("2026-06-01T00:00:00Z"), utc("2026-06-30T00:00:00Z"));
    expect(got.map((o) => [local(o.instant, NY).slice(0, 10), o.kind])).toEqual([["2026-06-08", "cancel_by"], ["2026-06-18", "renewal"]]);
  });

  it("a one-off bill (no interval) is reminded once", () => {
    const s = renewal({ renewalDate: "2026-09-01", interval: null, offsetsDays: [5, 0] });
    expect(days(renewalOccurrences(s, utc("2026-01-01T00:00:00Z"), utc("2027-01-01T00:00:00Z")))).toEqual(["2026-08-27", "2026-09-01"]);
  });

  it("stops after the end date", () => {
    const got = renewalOccurrences(renewal({ renewalDate: "2026-01-15", interval: "monthly", offsetsDays: [0], endDate: "2026-03-20" }), utc("2026-01-01T00:00:00Z"), utc("2026-12-31T00:00:00Z"));
    expect(got.map((o) => o.target)).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
  });

  it("finds the next renewal on or after today", () => {
    const s = { renewalDate: "2026-01-31", interval: "monthly" as const, timezone: NY };
    expect(nextRenewal(s, utc("2026-02-10T12:00:00Z"))).toBe("2026-02-28");
    expect(nextRenewal(s, utc("2026-02-28T12:00:00Z"))).toBe("2026-02-28");
    expect(nextRenewal({ ...s, interval: null }, utc("2026-05-01T12:00:00Z"))).toBeNull();
  });
});

describe("quiet hours", () => {
  it("knows a window within a day and one that crosses midnight, on the person's clock", () => {
    // 03:00 UTC is 23:00 in New York in summer.
    expect(inQuietHours(utc("2026-07-01T03:00:00Z"), NY, "22:00", "07:00")).toBe(true);
    expect(inQuietHours(utc("2026-07-01T14:00:00Z"), NY, "22:00", "07:00")).toBe(false);
    expect(inQuietHours(utc("2026-07-01T14:00:00Z"), NY, "09:00", "17:00")).toBe(true);
    expect(inQuietHours(utc("2026-07-01T14:00:00Z"), NY, null, null)).toBe(false);
    expect(inQuietHours(utc("2026-07-01T14:00:00Z"), NY, "10:00", "10:00")).toBe(false);
  });
});
