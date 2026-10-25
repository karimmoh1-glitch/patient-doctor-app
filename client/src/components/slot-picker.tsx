import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useI18n, getIntlLocale } from "@/lib/i18n";
import { formatTime } from "@/lib/format";

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
  const { t } = useI18n();
  const intl = getIntlLocale();
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
    new Intl.DateTimeFormat(intl, { timeZone: tz, timeZoneName: "long" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? tz;

  if (byDay.length === 0) return null;

  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label={t("pt.slot.chooseDay")} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {byDay.map(([k, { date, slots: daySlots }]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={openDay === k}
            aria-label={t("pt.slot.dayAria", { date: date.toLocaleDateString(intl, { weekday: "long", month: "long", day: "numeric" }), times: t("pt.slot.times", { count: daySlots.length }) })}
            onClick={() => setOpenDay(k)}
            className={cn(
              "min-h-16 rounded-xl border-2 px-3 py-2 text-start transition-colors",
              openDay === k ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-secondary",
            )}
          >
            <span className="block font-semibold">{date.toLocaleDateString(intl, { weekday: "long" })}</span>
            <span className="block text-sm">
              {date.toLocaleDateString(intl, { month: "long", day: "numeric" })} · {t("pt.slot.times", { count: daySlots.length })}
            </span>
          </button>
        ))}
      </div>

      {active && (
        <div>
          <p className="mb-2 font-semibold" id="slot-times-label">
            {t("pt.slot.timesOn", { date: active.date.toLocaleDateString(intl, { weekday: "long", month: "long", day: "numeric" }) })}
          </p>
          <div role="radiogroup" aria-labelledby="slot-times-label" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {active.slots.map((iso) => (
              <button
                key={iso}
                type="button"
                role="radio"
                aria-checked={value === iso}
                aria-label={formatTime(iso)}
                onClick={() => onChange(iso)}
                className={cn(
                  "min-h-14 rounded-xl border-2 px-3 text-lg font-semibold transition-colors",
                  value === iso ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-secondary",
                )}
              >
                {formatTime(iso)}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        {t("pt.slot.zone", { zone: zoneName(myZone) })}
        {zoneDiffers && ` ${t("pt.slot.doctorZone", { name: doctorName, zone: zoneName(doctorTimezone!) })}`}
      </p>
    </div>
  );
}
