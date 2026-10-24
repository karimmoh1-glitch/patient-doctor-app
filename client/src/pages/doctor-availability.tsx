import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import QueryState from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface Window {
  weekday: number;
  startMinute: number;
  endMinute: number;
}
interface Availability {
  timezone: string;
  windows: Window[];
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ZONES: [string, string][] = [
  ["America/New_York", "Eastern"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona (no daylight saving)"],
  ["America/Los_Angeles", "Pacific"],
  ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"],
];

const toTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const toMinutes = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};

function Editor({ initial }: { initial: Availability }) {
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

  const zoneOptions = ZONES.some(([z]) => z === timezone) ? ZONES : [...ZONES, [timezone, timezone] as [string, string]];

  function update(index: number, patch: Partial<Window>) {
    setWindows((w) => w.map((x, i) => (i === index ? { ...x, ...patch } : x)));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiRequest("PUT", "/api/doctors/me/availability", { timezone, windows });
      queryClient.invalidateQueries({ queryKey: ["/api/doctors/me/availability"] });
      toast({ title: "Your hours are saved", description: "Connected patients can now book these times." });
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
          You haven't added any hours yet, so patients can't book a visit with you. Add the times you are usually free.
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="tz" className="text-base">Your time zone</Label>
        <select
          id="tz"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="h-12 w-full max-w-sm rounded-md border border-input bg-white px-3 text-base"
        >
          {zoneOptions.map(([z, label]) => <option key={z} value={z}>{label}</option>)}
        </select>
        <p className="text-sm text-muted-foreground">Hours below are in this time zone. Patients see them converted to their own.</p>
      </div>

      <div className="space-y-4">
        {DAYS.map((day, weekday) => {
          const entries = windows.map((w, index) => ({ w, index })).filter(({ w }) => w.weekday === weekday);
          return (
            <Card key={day}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-lg">{day}</CardTitle>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setWindows((w) => [...w, { weekday, startMinute: 9 * 60, endMinute: 12 * 60 }])}
                >
                  <Plus aria-hidden="true" /> Add hours<span className="sr-only"> on {day}</span>
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                {entries.length === 0 && <p className="text-muted-foreground">Not available</p>}
                {entries.map(({ w, index }) => (
                  <div key={index} className="flex flex-wrap items-end gap-3">
                    <div className="space-y-1">
                      <Label htmlFor={`start-${index}`}>From</Label>
                      <input id={`start-${index}`} type="time" step={900} value={toTime(w.startMinute)}
                        onChange={(e) => update(index, { startMinute: toMinutes(e.target.value) })}
                        className="h-12 rounded-md border border-input bg-white px-3 text-base" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`end-${index}`}>Until</Label>
                      <input id={`end-${index}`} type="time" step={900} value={toTime(w.endMinute)}
                        onChange={(e) => update(index, { endMinute: toMinutes(e.target.value) })}
                        className="h-12 rounded-md border border-input bg-white px-3 text-base" />
                    </div>
                    <Button type="button" variant="outline" onClick={() => setWindows((all) => all.filter((_, i) => i !== index))}>
                      <Trash2 aria-hidden="true" /> Remove<span className="sr-only"> these hours on {day}</span>
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
      <Button size="lg" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save my hours"}</Button>
    </div>
  );
}

export default function DoctorAvailability() {
  const query = useQuery<Availability>({ queryKey: ["/api/doctors/me/availability"] });
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">My hours</h1>
        <p className="text-muted-foreground">Patients you are connected with can book visits only inside these times, in 30-minute slots, with at least two hours' notice.</p>
      </div>
      <QueryState query={query}>{(data) => <Editor initial={data} />}</QueryState>
    </div>
  );
}
