import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Pause, Play } from "lucide-react";
import PageHeader from "@/components/page-header";
import QueryState from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Badge } from "@/components/ui/badge";
import { Field, CheckGroup } from "@/components/form-field";
import ConfirmAction from "@/components/confirm-action";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDate, formatDateTime } from "@/lib/format";

type Kind = "medication" | "appointment" | "task" | "bill" | "subscription" | "other";
const KINDS: Kind[] = ["medication", "appointment", "task", "subscription", "bill", "other"];
const isRenewal = (k: Kind) => k === "bill" || k === "subscription";

interface Reminder {
  id: string; kind: Kind; title: string; notes: string | null; status: "active" | "paused" | "cancelled";
  recurrence: "once" | "daily" | "weekly" | "monthly" | "yearly" | null; times: string[]; weekdays: number[]; anchorDate: string | null; endDate: string | null; timezone: string;
  renewalDate: string | null; renewalInterval: string | null; offsetsDays: number[]; cancelByDate: string | null; amountMinor: number | null; currency: string | null;
  emailEnabled: boolean; showTitleInEmail: boolean; quietStart: string | null; quietEnd: string | null; healthEntryId: string | null;
  nextDueAt: string | null; nextOccurrence: { kind: "due" | "renewal" | "cancel_by"; offsetDays: number | null } | null; nextRenewal: string | null;
  recent: { dueAt: string; channel: "in_app" | "email"; status: "pending" | "sent" | "failed" | "suppressed"; attempts: number; occurrence: string }[];
}
interface Payload { reminders: Reminder[]; channels: { inApp: boolean; email: boolean; sms: boolean; push: boolean }; delivery: "active" | "stale" | "failing" | "not_configured" }

const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; } };
const today = () => new Date().toISOString().slice(0, 10);

function weekdayName(locale: string, d: number) {
  // 2023-01-01 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1 + d)));
}

// ---------------------------------------------------------------------------------------------- the form

interface FormState {
  kind: Kind; title: string; notes: string; recurrence: string; times: string[]; weekdays: number[]; anchorDate: string; endDate: string; timezone: string;
  renewalDate: string; renewalInterval: string; offsets: number[]; cancelByDate: string; time: string; amount: string; currency: string;
  emailEnabled: boolean; showTitleInEmail: boolean; quietStart: string; quietEnd: string; healthEntryId: string;
}
const blank = (kind: Kind): FormState => ({
  kind, title: "", notes: "", recurrence: isRenewal(kind) ? "once" : kind === "medication" ? "daily" : "once", times: ["09:00"], weekdays: [0, 1, 2, 3, 4, 5, 6], anchorDate: today(), endDate: "",
  timezone: browserZone(), renewalDate: today(), renewalInterval: "monthly", offsets: [3], cancelByDate: "", time: "09:00", amount: "", currency: "", emailEnabled: false, showTitleInEmail: false, quietStart: "", quietEnd: "", healthEntryId: "",
});
const fromReminder = (r: Reminder): FormState => ({
  ...blank(r.kind), kind: r.kind, title: r.title, notes: r.notes ?? "", recurrence: r.recurrence ?? "once", times: r.times, weekdays: r.weekdays, anchorDate: r.anchorDate ?? today(), endDate: r.endDate ?? "",
  timezone: r.timezone, renewalDate: r.renewalDate ?? today(), renewalInterval: r.renewalInterval ?? "", offsets: r.offsetsDays, cancelByDate: r.cancelByDate ?? "", time: r.times[0] ?? "09:00",
  amount: r.amountMinor != null ? String(r.amountMinor / 100) : "", currency: r.currency ?? "", emailEnabled: r.emailEnabled, showTitleInEmail: r.showTitleInEmail, quietStart: r.quietStart ?? "", quietEnd: r.quietEnd ?? "", healthEntryId: r.healthEntryId ?? "",
});

function toBody(f: FormState) {
  const common = { title: f.title.trim(), notes: f.notes.trim() || null, timezone: f.timezone, emailEnabled: f.emailEnabled, showTitleInEmail: f.emailEnabled && f.showTitleInEmail, quietStart: f.quietStart || null, quietEnd: f.quietEnd || null };
  if (isRenewal(f.kind)) {
    const cents = f.amount.trim() ? Math.round(Number(f.amount) * 100) : null;
    return {
      ...common, kind: f.kind, renewalDate: f.renewalDate, renewalInterval: f.renewalInterval || null, offsetsDays: f.offsets, cancelByDate: f.cancelByDate || null, time: f.time, endDate: f.endDate || null,
      amountMinor: cents, currency: cents != null ? f.currency.trim().toUpperCase() || null : null,
    };
  }
  return { ...common, kind: f.kind, recurrence: f.recurrence, times: f.times, weekdays: f.weekdays, anchorDate: f.anchorDate, endDate: f.endDate || null, healthEntryId: f.kind === "medication" && f.healthEntryId ? f.healthEntryId : null };
}

function ReminderForm({ initial, id, channels, onDone, onCancel }: { initial: FormState; id?: string; channels: Payload["channels"]; onDone: () => void; onCancel: () => void }) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [f, setF] = useState<FormState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const meds = useQuery<{ id: string; data: { name: string } }[]>({ queryKey: ["/api/health-profile/entries?kind=medication"], enabled: f.kind === "medication", retry: false });
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const renewing = isRenewal(f.kind);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiRequest(id ? "PUT" : "POST", id ? `/api/personal-reminders/${id}` : "/api/personal-reminders", toBody(f));
      toast({ title: t("rem.saved") });
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const zones = (() => { try { return ((Intl as any).supportedValuesOf?.("timeZone") as string[]) ?? []; } catch { return []; } })();

  return (
    <form onSubmit={save} noValidate className="space-y-5 rounded-2xl border-2 border-primary bg-card p-5" aria-label={id ? t("rem.edit") : t("rem.add")}>
      <h2 className="font-display text-2xl">{id ? t("rem.edit") : t("rem.add")}</h2>
      {!id && (
        <Field id="r-kind" label={t("rem.kind")}>
          {(a) => (
            <NativeSelect {...a} value={f.kind} onChange={(e) => setF(blank(e.target.value as Kind))}>
              {KINDS.map((k) => <option key={k} value={k}>{t(`rem.kind.${k}` as MessageKey)}</option>)}
            </NativeSelect>
          )}
        </Field>
      )}
      {f.kind === "medication" && <p className="rounded-xl bg-secondary p-3 text-base">{t("rem.med.note")}</p>}
      {renewing && <p className="rounded-xl bg-secondary p-3 text-base">{t("rem.renew.note")}</p>}
      <Field id="r-title" label={t("rem.field.title")}>{(a) => <Input {...a} value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={120} />}</Field>
      {f.kind === "medication" && meds.data && meds.data.length > 0 && (
        <Field id="r-med" label={t("rem.med.link")} hint={t("rem.med.link.hint")} optional>
          {(a) => (
            <NativeSelect {...a} value={f.healthEntryId} onChange={(e) => { set("healthEntryId", e.target.value); const m = meds.data!.find((x) => x.id === e.target.value); if (m && !f.title) set("title", m.data.name); }}>
              <option value="">{t("rem.med.none")}</option>
              {meds.data.map((m) => <option key={m.id} value={m.id}>{m.data.name}</option>)}
            </NativeSelect>
          )}
        </Field>
      )}

      {!renewing ? (
        <>
          <Field id="r-rec" label={t("rem.repeat")}>
            {(a) => (
              <NativeSelect {...a} value={f.recurrence} onChange={(e) => set("recurrence", e.target.value)}>
                {["once", "daily", "weekly", "monthly", "yearly"].map((r) => <option key={r} value={r}>{t(`rem.repeat.${r}` as MessageKey)}</option>)}
              </NativeSelect>
            )}
          </Field>
          <Field id="r-date" label={t(f.recurrence === "once" ? "rem.date.once" : "rem.date.start")} hint={f.recurrence === "monthly" ? t("rem.date.monthlyHint") : f.recurrence === "yearly" ? t("rem.date.yearlyHint") : undefined}>
            {(a) => <Input {...a} type="date" value={f.anchorDate} onChange={(e) => set("anchorDate", e.target.value)} />}
          </Field>
          {(f.recurrence === "daily" || f.recurrence === "weekly") && (
            <CheckGroup legend={t("rem.weekdays")} options={[0, 1, 2, 3, 4, 5, 6].map((d) => ({ value: String(d), label: weekdayName(locale, d) }))} value={f.weekdays.map(String)} onChange={(v) => set("weekdays", v.map(Number).sort())} />
          )}
          <fieldset className="space-y-2">
            <legend className="text-base font-semibold">{t("rem.times")}</legend>
            {f.times.map((time, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input aria-label={t("rem.time.n", { n: i + 1 })} type="time" value={time} onChange={(e) => set("times", f.times.map((x, j) => (j === i ? e.target.value : x)))} className="max-w-40" />
                {f.times.length > 1 && <Button type="button" variant="outline" onClick={() => set("times", f.times.filter((_, j) => j !== i))}>{t("rem.time.remove", { n: i + 1 })}</Button>}
              </div>
            ))}
            {f.times.length < 6 && <Button type="button" variant="outline" onClick={() => set("times", [...f.times, "12:00"])}>{t("rem.time.add")}</Button>}
          </fieldset>
        </>
      ) : (
        <>
          <Field id="r-rdate" label={t("rem.renew.date")} hint={t("rem.renew.date.hint")}>{(a) => <Input {...a} type="date" value={f.renewalDate} onChange={(e) => set("renewalDate", e.target.value)} />}</Field>
          <Field id="r-int" label={t("rem.renew.interval")}>
            {(a) => (
              <NativeSelect {...a} value={f.renewalInterval} onChange={(e) => set("renewalInterval", e.target.value)}>
                <option value="">{t("rem.renew.interval.none")}</option>
                {["weekly", "monthly", "quarterly", "yearly"].map((r) => <option key={r} value={r}>{t(`rem.renew.interval.${r}` as MessageKey)}</option>)}
              </NativeSelect>
            )}
          </Field>
          <CheckGroup legend={t("rem.renew.offsets")} hint={t("rem.renew.offsets.hint")} options={[30, 14, 7, 3, 1, 0].map((d) => ({ value: String(d), label: d === 0 ? t("rem.renew.offset.day") : t("rem.renew.offset.n", { count: d } as never) }))} value={f.offsets.map(String)} onChange={(v) => set("offsets", v.map(Number).sort((a, b) => b - a))} />
          <Field id="r-time" label={t("rem.renew.time")}>{(a) => <Input {...a} type="time" value={f.time} onChange={(e) => set("time", e.target.value)} className="max-w-40" />}</Field>
          <Field id="r-cancel" label={t("rem.renew.cancelBy")} hint={t("rem.renew.cancelBy.hint")} optional>{(a) => <Input {...a} type="date" value={f.cancelByDate} onChange={(e) => set("cancelByDate", e.target.value)} />}</Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="r-amount" label={t("rem.renew.amount")} optional>{(a) => <Input {...a} inputMode="decimal" dir="ltr" value={f.amount} onChange={(e) => set("amount", e.target.value)} />}</Field>
            <Field id="r-cur" label={t("rem.renew.currency")} hint={t("rem.renew.currency.hint")} optional>{(a) => <Input {...a} dir="ltr" maxLength={3} value={f.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} />}</Field>
          </div>
        </>
      )}

      <Field id="r-end" label={t("rem.end")} optional>{(a) => <Input {...a} type="date" value={f.endDate} onChange={(e) => set("endDate", e.target.value)} />}</Field>
      <Field id="r-tz" label={t("rem.zone")} hint={t("rem.zone.hint")}>
        {(a) => (
          <NativeSelect {...a} value={f.timezone} onChange={(e) => set("timezone", e.target.value)}>
            {Array.from(new Set([f.timezone, ...zones])).map((z) => <option key={z} value={z}>{z}</option>)}
          </NativeSelect>
        )}
      </Field>
      <Field id="r-notes" label={t("rem.notes")} optional>{(a) => <Textarea {...a} rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} maxLength={500} />}</Field>

      <fieldset className="space-y-3 rounded-xl border border-border p-4">
        <legend className="px-2 text-base font-semibold">{t("rem.how")}</legend>
        <p className="text-base">{t("rem.how.inApp")}</p>
        <label className={`flex min-h-12 items-center gap-3 text-base ${channels.email ? "cursor-pointer" : "opacity-70"}`}>
          <input type="checkbox" className="h-6 w-6 shrink-0 accent-[#0E5A4F]" disabled={!channels.email} checked={f.emailEnabled} onChange={(e) => set("emailEnabled", e.target.checked)} />
          <span>{t("rem.how.email")}{!channels.email && <span className="block text-muted-foreground">{t("rem.how.email.off")}</span>}</span>
        </label>
        {f.emailEnabled && (
          <>
            <label className="flex min-h-12 cursor-pointer items-center gap-3 text-base">
              <input type="checkbox" className="h-6 w-6 shrink-0 accent-[#0E5A4F]" checked={f.showTitleInEmail} onChange={(e) => set("showTitleInEmail", e.target.checked)} />
              <span>{t("rem.how.showTitle")}<span className="block text-muted-foreground">{t("rem.how.showTitle.hint")}</span></span>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="r-qs" label={t("rem.quiet.start")} optional>{(a) => <Input {...a} type="time" value={f.quietStart} onChange={(e) => set("quietStart", e.target.value)} />}</Field>
              <Field id="r-qe" label={t("rem.quiet.end")} optional>{(a) => <Input {...a} type="time" value={f.quietEnd} onChange={(e) => set("quietEnd", e.target.value)} />}</Field>
            </div>
            <p className="text-base text-muted-foreground">{t("rem.quiet.hint")}</p>
          </>
        )}
        <p className="text-base text-muted-foreground">{t("rem.how.others")}</p>
      </fieldset>

      {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="lg" disabled={busy}>{busy ? t("common.saving") : t("common.save")}</Button>
        <Button type="button" size="lg" variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------- one reminder

function describe(t: ReturnType<typeof useI18n>["t"], r: Reminder): string {
  if (isRenewal(r.kind)) {
    const every = r.renewalInterval ? t(`rem.renew.interval.${r.renewalInterval}` as MessageKey) : t("rem.renew.interval.none");
    return t("rem.sum.renew", { every, date: r.renewalDate ? formatDate(r.renewalDate) : "" });
  }
  return t("rem.sum.repeat", { repeat: t(`rem.repeat.${r.recurrence ?? "once"}` as MessageKey), times: r.times.join(", ") });
}

function Row({ r, onChanged, onEdit }: { r: Reminder; onChanged: () => void; onEdit: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [minutes, setMinutes] = useState("10");
  async function act(path: string, body?: unknown, done?: MessageKey) {
    try {
      await apiRequest("POST", `/api/personal-reminders/${r.id}/${path}`, body);
      if (done) toast({ title: t(done) });
      onChanged();
    } catch (err: any) {
      toast({ title: t("hp.saveFailed"), description: err.message, variant: "destructive" });
    }
  }
  const last = r.recent[0];
  return (
    <li className="space-y-2 rounded-2xl border-2 border-input bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-xl font-semibold">{r.title}</h3>
        <span className="flex flex-wrap gap-2">
          <Badge variant="secondary">{t(`rem.kind.${r.kind}` as MessageKey)}</Badge>
          <Badge variant={r.status === "active" ? "default" : "outline"}>{t(`rem.status.${r.status}` as MessageKey)}</Badge>
        </span>
      </div>
      <p className="text-lg">{describe(t, r)}</p>
      {r.status === "active" && (
        <p className="text-lg">
          {r.nextDueAt
            ? t(r.nextOccurrence?.kind === "cancel_by" ? "rem.next.cancelBy" : r.nextOccurrence?.kind === "renewal" ? "rem.next.renewal" : "rem.next.due", { when: formatDateTime(r.nextDueAt), days: r.nextOccurrence?.offsetDays ?? 0 })
            : t("rem.next.none")}
        </p>
      )}
      {r.amountMinor != null && r.currency && <p className="text-base text-muted-foreground">{t("rem.amount", { amount: (r.amountMinor / 100).toLocaleString(undefined, { minimumFractionDigits: 2 }), currency: r.currency })}</p>}
      {last && (
        <p className="text-base text-muted-foreground">
          {t(`rem.last.${last.channel}.${last.status}` as MessageKey, { when: formatDateTime(last.dueAt) })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {r.status === "active" && <Button variant="outline" onClick={() => act("pause", undefined, "rem.paused")}><Pause aria-hidden="true" /> {t("rem.pause")}<span className="sr-only">: {r.title}</span></Button>}
        {r.status === "paused" && <Button onClick={() => act("resume", undefined, "rem.resumed")}><Play aria-hidden="true" /> {t("rem.resume")}<span className="sr-only">: {r.title}</span></Button>}
        {r.status !== "cancelled" && <Button variant="outline" onClick={onEdit}>{t("rem.edit")}<span className="sr-only">: {r.title}</span></Button>}
        {r.status === "active" && (
          <span className="flex items-center gap-2">
            <NativeSelect aria-label={t("rem.snooze.for", { title: r.title })} value={minutes} onChange={(e) => setMinutes(e.target.value)} className="w-auto">
              {[5, 10, 30, 60, 120].map((m) => <option key={m} value={m}>{t("rem.snooze.min", { count: m } as never)}</option>)}
            </NativeSelect>
            <Button variant="outline" onClick={() => act("snooze", { minutes: Number(minutes) }, "rem.snoozed")}>{t("rem.snooze")}<span className="sr-only">: {r.title}</span></Button>
          </span>
        )}
        <ConfirmAction
          trigger={<Button variant="outline">{t("rem.remove")}<span className="sr-only">: {r.title}</span></Button>}
          title={t("rem.remove.title")} description={t("rem.remove.body")} confirmLabel={t("rem.remove.yes")} cancelLabel={t("common.cancel")} destructive
          onConfirm={async () => { await apiRequest("DELETE", `/api/personal-reminders/${r.id}`); onChanged(); }}
        />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------- page

export default function MyReminders() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery<Payload>({ queryKey: ["/api/personal-reminders"], staleTime: 0 });
  const [editing, setEditing] = useState<{ id?: string; initial: FormState } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/personal-reminders"] });
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t("rem.title")} description={t("rem.intro")} />
      <QueryState query={query} loadingLabel={t("hp.loading")}>
        {(data) => (
          <>
            {data.delivery !== "active" && (
              <p role="status" className="rounded-xl border-2 border-ochre bg-sand p-4 text-lg text-sand-foreground">{t(`rem.delivery.${data.delivery}` as MessageKey)}</p>
            )}
            <section aria-labelledby="rem-channels" className="space-y-2 rounded-2xl border-2 border-input bg-card p-4">
              <h2 id="rem-channels" className="text-xl font-semibold">{t("rem.channels")}</h2>
              <ul className="space-y-1 text-lg">
                <li>{t("rem.channel.inApp")}</li>
                <li>{data.channels.email ? t("rem.channel.email.on") : t("rem.channel.email.off")}</li>
                <li>{t("rem.channel.sms")}</li>
                <li>{t("rem.channel.push")}</li>
              </ul>
            </section>
            {editing ? (
              <ReminderForm initial={editing.initial} id={editing.id} channels={data.channels} onDone={() => { setEditing(null); refresh(); }} onCancel={() => setEditing(null)} />
            ) : (
              <Button size="lg" onClick={() => setEditing({ initial: blank("medication") })}><BellRing aria-hidden="true" /> {t("rem.add")}</Button>
            )}
            {data.reminders.length === 0 && !editing ? (
              <p className="rounded-xl border-2 border-dashed border-input p-4 text-lg text-muted-foreground">{t("rem.empty")}</p>
            ) : (
              <ul className="space-y-3">{data.reminders.map((r) => <Row key={r.id} r={r} onChanged={refresh} onEdit={() => setEditing({ id: r.id, initial: fromReminder(r) })} />)}</ul>
            )}
            <p className="text-base text-muted-foreground">
              {t("rem.prescribed")} <Link href="/medications" className="font-medium text-primary underline underline-offset-4">{t("rem.prescribed.link")}</Link>
            </p>
          </>
        )}
      </QueryState>
    </div>
  );
}
