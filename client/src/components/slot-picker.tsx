import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Pick one of the times a doctor has genuinely published. Two steps with big
 * buttons — a day, then a time — instead of a free-form date/time field that
 * lets someone request a time nobody offered. Each group is a radio group so
 * a screen-reader or keyboard user hears "Tuesday October 27, selected".
 */
export default function SlotPicker({
  slots,
  value,
  onChange,
  doctorTimezone,
  doctorName,
}: {
  slots: string[];
  value: string | null;
  onChange: (iso: string) => void;
  doctorTimezone: string | null;
  doctorName: string;
}) {
  const byDay = useMemo(() => {
    const map = new Map<string, { date: Date; slots: string[] }>();
    for (const iso of slots) {
      const d = new Date(iso);
      const k = dayKey(d);
      const entry = map.get(k) ?? { date: d, slots: [] };
      entry.slots.push(iso);
      map.set(k, entry);
    }
    return Array.from(map.entries());
  }, [slots]);

  const selectedDay = value ? dayKey(new Date(value)) : null;
  const [openDay, setOpenDay] = useState<string | null>(selectedDay ?? byDay[0]?.[0] ?? null);
  const active = byDay.find(([k]) => k === openDay)?.[1];

  const myZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zoneDiffers = doctorTimezone && doctorTimezone !== myZone;
  const zoneName = (tz: string) =>
    new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: "long" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? tz;

  if (byDay.length === 0) return null;

  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="Choose a day" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {byDay.map(([k, { date, slots: daySlots }]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={openDay === k}
            aria-label={`${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}, ${daySlots.length} time${daySlots.length === 1 ? "" : "s"} available`}
            onClick={() => setOpenDay(k)}
            className={cn(
              "min-h-16 rounded-xl border-2 px-3 py-2 text-left transition-colors",
              openDay === k ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-secondary",
            )}
          >
            <span className="block font-semibold">{date.toLocaleDateString(undefined, { weekday: "long" })}</span>
            <span className="block text-sm">
              {date.toLocaleDateString(undefined, { month: "long", day: "numeric" })} · {daySlots.length} time{daySlots.length === 1 ? "" : "s"}
            </span>
          </button>
        ))}
      </div>

      {active && (
        <div>
          <p className="mb-2 font-semibold" id="slot-times-label">
            Times on {active.date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </p>
          <div role="radiogroup" aria-labelledby="slot-times-label" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {active.slots.map((iso) => (
              <button
                key={iso}
                type="button"
                role="radio"
                aria-checked={value === iso}
                aria-label={new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                onClick={() => onChange(iso)}
                className={cn(
                  "min-h-14 rounded-xl border-2 px-3 text-lg font-semibold transition-colors",
                  value === iso ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-secondary",
                )}
              >
                {new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Times are shown in your time zone ({zoneName(myZone)}).
        {zoneDiffers && ` ${doctorName} works in ${zoneName(doctorTimezone!)}.`}
      </p>
    </div>
  );
}
