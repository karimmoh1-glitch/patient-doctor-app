import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import QueryState from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { getIntlLocale, useI18n, type MessageKey } from "@/lib/i18n";

interface Window {
  weekday: number;
  startMinute: number;
  endMinute: number;
}
interface Availability {
  timezone: string;
  windows: Window[];
}

// Weekday 0 is Sunday. 4 Jan 2026 is a Sunday, so day N of that week names weekday N in any language.
const weekdayName = (weekday: number) =>
  new Intl.DateTimeFormat(getIntlLocale(), { weekday: "long" }).format(new Date(2026, 0, 4 + weekday));
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const ZONES: [string, MessageKey][] = [
  ["America/New_York", "avail.zone.eastern"],
  ["America/Chicago", "avail.zone.central"],
  ["America/Denver", "avail.zone.mountain"],
  ["America/Phoenix", "avail.zone.arizona"],
  ["America/Los_Angeles", "avail.zone.pacific"],
  ["America/Anchorage", "avail.zone.alaska"],
  ["Pacific/Honolulu", "avail.zone.hawaii"],
];

const toTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const toMinutes = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};

function Editor({ initial }: { initial: Availability }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [timezone, setTimezone] = useState(initial.timezone);
  const [windows, setWindows] = useState<Window[]>(initial.windows);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTimezone(initial.timezone);
    setWindows(initial.windows);
  }, [initial]);

  const zoneOptions: [string, string][] = ZONES.map(([z, key]) => [z, t(key)]);
  if (!ZONES.some(([z]) => z === timezone)) zoneOptions.push([timezone, timezone]);

  function update(index: number, patch: Partial<Window>) {
    setWindows((w) => w.map((x, i) => (i === index ? { ...x, ...patch } : x)));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiRequest("PUT", "/api/doctors/me/availability", { timezone, windows });
      queryClient.invalidateQueries({ queryKey: ["/api/doctors/me/availability"] });
      toast({ title: t("avail.saved.title"), description: t("avail.saved.desc") });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {windows.length === 0 && (
        <p role="status" className="rounded-xl border-2 border-input p-4">
          {t("avail.empty")}
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="tz" className="text-base">{t("avail.tz")}</Label>
        <select
          id="tz"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="h-12 w-full max-w-sm rounded-md border border-input bg-white px-3 text-base"
        >
          {zoneOptions.map(([z, label]) => <option key={z} value={z}>{label}</option>)}
        </select>
        <p className="text-sm text-muted-foreground">{t("avail.tz.help")}</p>
      </div>

      <div className="space-y-4">
        {DAYS.map((weekday) => {
          const day = weekdayName(weekday);
          const entries = windows.map((w, index) => ({ w, index })).filter(({ w }) => w.weekday === weekday);
          return (
            <Card key={weekday}>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
                <CardTitle className="text-lg">{day}</CardTitle>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t("avail.addHoursOn", { day })}
                  onClick={() => setWindows((w) => [...w, { weekday, startMinute: 9 * 60, endMinute: 12 * 60 }])}
                >
                  <Plus aria-hidden="true" /> {t("avail.addHours")}
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                {entries.length === 0 && <p className="text-muted-foreground">{t("avail.notAvailable")}</p>}
                {entries.map(({ w, index }) => (
                  <div key={index} className="flex flex-wrap items-end gap-3">
                    <div className="space-y-1">
                      <Label htmlFor={`start-${index}`}>{t("avail.from")}</Label>
                      <input id={`start-${index}`} type="time" step={900} value={toTime(w.startMinute)}
                        onChange={(e) => update(index, { startMinute: toMinutes(e.target.value) })}
                        dir="ltr" className="h-12 rounded-md border border-input bg-white px-3 text-base" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`end-${index}`}>{t("avail.until")}</Label>
                      <input id={`end-${index}`} type="time" step={900} value={toTime(w.endMinute)}
                        onChange={(e) => update(index, { endMinute: toMinutes(e.target.value) })}
                        dir="ltr" className="h-12 rounded-md border border-input bg-white px-3 text-base" />
                    </div>
                    <Button type="button" variant="outline" aria-label={t("avail.removeOn", { day })} onClick={() => setWindows((all) => all.filter((_, i) => i !== index))}>
                      <Trash2 aria-hidden="true" /> {t("avail.remove")}
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
      <Button size="lg" onClick={save} disabled={saving}>{saving ? t("common.saving") : t("avail.save")}</Button>
    </div>
  );
}

export default function DoctorAvailability() {
  const { t } = useI18n();
  const query = useQuery<Availability>({ queryKey: ["/api/doctors/me/availability"] });
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">{t("nav.d.hours")}</h1>
        <p className="text-muted-foreground">{t("avail.subtitle")}</p>
      </div>
      <QueryState query={query}>{(data) => <Editor initial={data} />}</QueryState>
    </div>
  );
}
