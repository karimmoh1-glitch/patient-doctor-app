import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { getIntlLocale, useI18n } from "@/lib/i18n";
import { formatClock, formatRelativeDay } from "@/lib/format";

export interface ReminderState {
  times: string[];
  weekdays: number[];
  enabled: boolean;
  emailEnabled: boolean;
  showMedicationName: boolean;
  timezone: string;
  endDate: string | null;
  nextDueAt: string | null;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function weekdayName(day: number): string {
  // 2024-01-07 was a Sunday; add `day` to get each weekday in the viewer's language.
  return new Intl.DateTimeFormat(getIntlLocale(), { weekday: "long" }).format(new Date(2024, 0, 7 + day));
}

/**
 * One medicine's reminder: the times the patient chose, which days, whether it
 * is on, and where it is delivered. A reminder only nudges. It never changes a
 * dose, never records that anything was taken or missed, and it never replaces
 * what the doctor wrote.
 */
export default function ReminderEditor({
  medicationId, medicationName, suggestedTimes, reminder, emailAvailable,
}: {
  medicationId: string;
  medicationName: string;
  suggestedTimes: string[];
  reminder: ReminderState | null;
  emailAvailable: boolean;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [times, setTimes] = useState<string[]>(reminder?.times ?? suggestedTimes);
  const [weekdays, setWeekdays] = useState<number[]>(reminder?.weekdays ?? ALL_DAYS);
  const [enabled, setEnabled] = useState(reminder?.enabled ?? true);
  const [emailEnabled, setEmailEnabled] = useState(reminder?.emailEnabled ?? false);
  const [showName, setShowName] = useState(reminder?.showMedicationName ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setTimes(reminder?.times ?? suggestedTimes);
      setWeekdays(reminder?.weekdays ?? ALL_DAYS);
      setEnabled(reminder?.enabled ?? true);
      setEmailEnabled(reminder?.emailEnabled ?? false);
      setShowName(reminder?.showMedicationName ?? false);
    }
  }, [reminder, suggestedTimes, editing]);

  async function save(over?: { enabled: boolean }) {
    setSaving(true);
    setError(null);
    try {
      await apiRequest("PUT", `/api/reminders/${medicationId}`, {
        times, weekdays, enabled: over?.enabled ?? enabled, emailEnabled, showMedicationName: showName,
        endDate: reminder?.endDate ?? null,
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/reminders"] });
      setEditing(false);
      toast({ title: t("rem.saved") });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await apiRequest("DELETE", `/api/reminders/${medicationId}`);
      await queryClient.invalidateQueries({ queryKey: ["/api/reminders"] });
      toast({ title: t("rem.removed") });
    } catch (err: any) {
      toast({ title: t("rem.failed"), description: err.message, variant: "destructive" });
    }
  }

  const sorted = (xs: string[]) => [...xs].sort();

  if (!editing) {
    return (
      <div className="space-y-3 rounded-xl bg-muted p-4">
        <p className="flex items-center gap-2 text-lg font-semibold">
          {reminder?.enabled ? <Bell className="h-5 w-5 text-primary" aria-hidden="true" /> : <BellOff className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
          {!reminder ? t("rem.none") : reminder.enabled ? t("rem.on") : t("rem.paused")}
        </p>
        {reminder && (
          <p className="text-base text-muted-foreground">
            {t("rem.at", { times: sorted(reminder.times).map(formatClock).join(", ") })}
            {reminder.enabled && reminder.nextDueAt && <> · {t("rem.next", { when: formatRelativeDay(reminder.nextDueAt) })}</>}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => setEditing(true)}>
            {reminder ? t("rem.change") : t("rem.set")}<span className="sr-only">: {medicationName}</span>
          </Button>
          {reminder && (
            <Button variant="outline" onClick={() => save({ enabled: !reminder.enabled })} disabled={saving}>
              {reminder.enabled ? t("rem.pause") : t("rem.resume")}<span className="sr-only">: {medicationName}</span>
            </Button>
          )}
          {reminder && <Button variant="ghost" onClick={remove}>{t("rem.remove")}<span className="sr-only">: {medicationName}</span></Button>}
        </div>
      </div>
    );
  }

  const idBase = `rem-${medicationId}`;
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); save(); }}
      className="space-y-5 rounded-xl border-2 border-input bg-card p-4"
      aria-label={t("rem.formFor", { name: medicationName })}
    >
      <p className="text-base text-muted-foreground">{t("rem.sourceOfTruth")}</p>
      <fieldset className="space-y-2">
        <legend className="text-base font-semibold">{t("rem.times")}</legend>
        <ul className="space-y-2">
          {times.map((time, i) => (
            <li key={i} className="flex items-center gap-2">
              <Input
                type="time" dir="ltr" value={time} aria-label={t("rem.timeN", { n: i + 1 })} className="max-w-40"
                onChange={(e) => setTimes((ts) => ts.map((x, j) => (j === i ? e.target.value : x)))} required
              />
              {times.length > 1 && (
                <Button type="button" variant="outline" size="icon" aria-label={t("rem.removeTimeN", { n: i + 1 })} onClick={() => setTimes((ts) => ts.filter((_, j) => j !== i))}>
                  <X aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
        {times.length < 6 && (
          <Button type="button" variant="outline" size="sm" onClick={() => setTimes((ts) => [...ts, "12:00"])}>
            <Plus aria-hidden="true" /> {t("rem.addTime")}
          </Button>
        )}
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="text-base font-semibold">{t("rem.days")}</legend>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {ALL_DAYS.map((d) => (
            <label key={d} className="flex min-h-11 cursor-pointer items-center gap-3 text-base">
              <input type="checkbox" className="h-6 w-6 shrink-0 accent-[#0E5A4F]" checked={weekdays.includes(d)}
                onChange={(e) => setWeekdays((ws) => (e.target.checked ? [...ws, d] : ws.filter((x) => x !== d)))} />
              {weekdayName(d)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="text-base font-semibold">{t("rem.how")}</legend>
        <p className="min-h-11 text-base">{t("rem.inApp")}</p>
        {emailAvailable && (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base">
            <input type="checkbox" className="h-6 w-6 shrink-0 accent-[#0E5A4F]" checked={emailEnabled} onChange={(e) => setEmailEnabled(e.target.checked)} />
            {t("rem.email")}
          </label>
        )}
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base" htmlFor={`${idBase}-name`}>
          <input id={`${idBase}-name`} type="checkbox" className="h-6 w-6 shrink-0 accent-[#0E5A4F]" checked={showName} onChange={(e) => setShowName(e.target.checked)} />
          {t("rem.showName")}
        </label>
        <p className="text-base text-muted-foreground">{t("rem.showNameWhy")}</p>
      </fieldset>

      <div className="flex items-center gap-3">
        <input id={`${idBase}-enabled`} type="checkbox" className="h-6 w-6 shrink-0 accent-[#0E5A4F]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <Label htmlFor={`${idBase}-enabled`} className="text-base">{t("rem.turnOn")}</Label>
      </div>

      {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={saving || times.length === 0 || weekdays.length === 0}>{saving ? t("common.saving") : t("common.save")}</Button>
        <Button type="button" variant="outline" onClick={() => { setEditing(false); setError(null); }}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
}
