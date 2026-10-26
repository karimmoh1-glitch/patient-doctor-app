import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, CircleDashed, Clock, SkipForward } from "lucide-react";
import PageHeader from "@/components/page-header";
import QueryState from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/form-field";
import ConfirmAction from "@/components/confirm-action";
import { Ltr } from "@/components/ltr";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDate } from "@/lib/format";
import { EntryList, EntryForm, ENTRY_KIND_ORDER, type Entry } from "@/components/health-entries";

type SectionId = "basic" | "allergies" | "medications" | "history" | "preferences" | "review";
type SectionState = "not_started" | "in_progress" | "complete" | "skipped";
const SECTIONS: SectionId[] = ["basic", "allergies", "medications", "history", "preferences", "review"];
const MEDICAL: SectionId[] = ["allergies", "medications", "history"];

interface Overview {
  sections: Record<SectionId, SectionState>;
  allergy: { picture: "not_collected" | "has_known" | "none_known" | "unknown"; statedBy: "patient" | "doctor" | null; statedAt: string | null; clinicianReviewedAt: string | null; clinicianVerified: boolean };
  counts: Record<string, number>;
  unverified: number;
  consent: { given: boolean; version?: string; grantedAt?: string; current?: boolean };
  grants: { id: string; doctorName: string; expiresAt: string }[];
}

const STATE_ICON: Record<SectionState, typeof Check> = { not_started: CircleDashed, in_progress: Clock, complete: Check, skipped: SkipForward };

function useOverview() {
  return useQuery<Overview>({ queryKey: ["/api/health-profile"], staleTime: 0 });
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/health-profile") });
}

// ---------------------------------------------------------------------------------------------- consent

function ConsentCard({ overview }: { overview: Overview }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const refresh = useRefresh();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  async function give() {
    setBusy(true);
    try {
      const need = await apiRequest("GET", "/api/health-profile/consent").then((r) => r.json());
      await apiRequest("POST", "/api/health-profile/consent", { version: need.requiredVersion });
      toast({ title: t("hp.consent.saved") });
      refresh();
    } catch (err: any) {
      toast({ title: t("hp.saveFailed"), description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="hp-consent" className="space-y-3 rounded-2xl border-2 border-input bg-card p-5">
      <h2 id="hp-consent" className="font-display text-2xl">{t("hp.consent.title")}</h2>
      {overview.consent.given ? (
        <>
          <p className="text-lg">{t("hp.consent.given", { date: formatDate(overview.consent.grantedAt!) })}</p>
          <ConfirmAction
            trigger={<Button variant="outline">{t("hp.consent.revoke")}</Button>}
            title={t("hp.consent.revoke.title")} description={t("hp.consent.revoke.body")} confirmLabel={t("hp.consent.revoke.yes")} cancelLabel={t("common.cancel")} destructive
            onConfirm={async () => { await apiRequest("DELETE", "/api/health-profile/consent"); toast({ title: t("hp.consent.revoked") }); refresh(); }}
          />
        </>
      ) : (
        <>
          <p className="text-lg">{t("hp.consent.body1")}</p>
          <ul className="list-disc space-y-1 ps-6 text-lg">
            <li>{t("hp.consent.point1")}</li><li>{t("hp.consent.point2")}</li><li>{t("hp.consent.point3")}</li><li>{t("hp.consent.point4")}</li>
          </ul>
          <p className="text-base text-muted-foreground">{t("hp.consent.notLegal")}</p>
          <label className="flex min-h-12 cursor-pointer items-center gap-3 text-lg">
            <input type="checkbox" className="h-6 w-6 shrink-0 accent-[#0E5A4F]" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            {t("hp.consent.agree")}
          </label>
          <Button size="lg" disabled={!agreed || busy} onClick={give}>{t("hp.consent.save")}</Button>
          <p className="text-base text-muted-foreground">{t("hp.consent.laterOk")}</p>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- overview

function SectionCard({ id, state }: { id: SectionId; state: SectionState }) {
  const { t } = useI18n();
  const Icon = STATE_ICON[state];
  return (
    <li>
      <Link href={`/health-profile/${id}`} className="flex min-h-16 items-center justify-between gap-3 rounded-2xl border-2 border-input bg-card p-4 hover:border-primary focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2">
        <span>
          <span className="block text-xl font-semibold">{t(`hp.sec.${id}` as MessageKey)}</span>
          <span className="block text-base text-muted-foreground">{t(`hp.sec.${id}.why` as MessageKey)}</span>
        </span>
        <Badge variant={state === "complete" ? "default" : "secondary"} className="shrink-0 gap-1.5 text-base">
          <Icon className="h-4 w-4" aria-hidden="true" />{t(`hp.state.${state}` as MessageKey)}
        </Badge>
      </Link>
    </li>
  );
}

function Home() {
  const { t } = useI18n();
  const query = useOverview();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t("hp.title")} description={t("hp.intro")} />
      <QueryState query={query} loadingLabel={t("hp.loading")}>
        {(o) => {
          const open = SECTIONS.filter((s) => o.sections[s] === "not_started" || o.sections[s] === "in_progress");
          return (
            <>
              <p role="status" className="rounded-xl border-2 border-input bg-card p-4 text-lg">
                {open.length === 0 ? t("hp.summary.allDone") : t("hp.summary.open", { count: open.length, list: open.map((s) => t(`hp.sec.${s}` as MessageKey)).join(", ") })}
              </p>
              <ul className="space-y-3">{SECTIONS.map((s) => <SectionCard key={s} id={s} state={o.sections[s]} />)}</ul>
              <p className="text-base text-muted-foreground">{t("hp.nothingRequired")}</p>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- section chrome

function SectionFrame({ id, overview, children }: { id: SectionId; overview: Overview; children: React.ReactNode }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const refresh = useRefresh();
  const [, go] = useLocation();
  const needsConsent = MEDICAL.includes(id) && !overview.consent.given;
  async function mark(status: "complete" | "skipped") {
    try {
      await apiRequest("PUT", `/api/health-profile/sections/${id}`, { status });
      toast({ title: t(status === "complete" ? "hp.marked.complete" : "hp.marked.skipped") });
      refresh();
      go("/health-profile");
    } catch (err: any) {
      toast({ title: t("hp.saveFailed"), description: err.message, variant: "destructive" });
    }
  }
  const state = overview.sections[id];
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button asChild variant="outline"><Link href="/health-profile"><ArrowLeft aria-hidden="true" className="flip-rtl" /> {t("hp.back")}</Link></Button>
      <PageHeader title={t(`hp.sec.${id}` as MessageKey)} description={t(`hp.sec.${id}.why` as MessageKey)} />
      {needsConsent ? <ConsentCard overview={overview} /> : children}
      {id !== "review" && (
        <div className="flex flex-wrap gap-3 border-t border-border pt-4">
          <Button size="lg" onClick={() => mark("complete")} disabled={needsConsent}>{t("hp.markDone")}</Button>
          <Button size="lg" variant="outline" onClick={() => mark("skipped")}>{t("hp.skipForNow")}</Button>
          {state === "skipped" && <p className="self-center text-base text-muted-foreground">{t("hp.skipped.note")}</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- basic

interface Basic { name: string; preferredName: string | null; dateOfBirth: string | null; country: "EG" | "US" | null; timezone: string | null; language: string; contactMethod: string | null; phone: string | null; accessibilityNotes: string | null }

function BasicSection() {
  const { t } = useI18n();
  const { toast } = useToast();
  const refresh = useRefresh();
  const query = useQuery<Basic>({ queryKey: ["/api/health-profile/basic"], staleTime: 0 });
  const [f, setF] = useState({ preferredName: "", dateOfBirth: "", country: "", timezone: "", contactMethod: "", phone: "", accessibilityNotes: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const d = query.data;
    if (d) setF({ preferredName: d.preferredName ?? "", dateOfBirth: d.dateOfBirth ?? "", country: d.country ?? "", timezone: d.timezone ?? "", contactMethod: d.contactMethod ?? "", phone: d.phone ?? "", accessibilityNotes: d.accessibilityNotes ?? "" });
  }, [query.data]);
  const zones = (() => {
    try {
      const all = (Intl as any).supportedValuesOf ? ((Intl as any).supportedValuesOf("timeZone") as string[]) : [];
      return all.length ? all : ["Africa/Cairo", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];
    } catch {
      return ["Africa/Cairo", "America/New_York"];
    }
  })();
  const browserZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ""; } })();
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiRequest("PUT", "/api/health-profile/basic", {
        preferredName: f.preferredName || null, dateOfBirth: f.dateOfBirth || null, country: f.country || null, timezone: f.timezone || null,
        contactMethod: f.contactMethod || null, phone: f.phone || null, accessibilityNotes: f.accessibilityNotes || null,
      });
      toast({ title: t("hp.saved") });
      refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <QueryState query={query} loadingLabel={t("hp.loading")}>
      {() => (
        <form onSubmit={save} className="space-y-5" noValidate>
          <Field id="b-name" label={t("hp.basic.preferredName")} hint={t("hp.basic.preferredName.hint")} optional>{(a) => <Input {...a} value={f.preferredName} onChange={set("preferredName")} />}</Field>
          <Field id="b-dob" label={t("hp.basic.dob")} hint={t("hp.basic.dob.hint")} optional>{(a) => <Input {...a} type="date" value={f.dateOfBirth} onChange={set("dateOfBirth")} max={new Date().toISOString().slice(0, 10)} />}</Field>
          <Field id="b-country" label={t("hp.basic.country")} hint={t("hp.basic.country.hint")} optional>
            {(a) => (
              <NativeSelect {...a} value={f.country} onChange={set("country")}>
                <option value="">{t("hp.basic.country.choose")}</option>
                <option value="EG">{t("hp.country.EG")}</option>
                <option value="US">{t("hp.country.US")}</option>
              </NativeSelect>
            )}
          </Field>
          <Field id="b-tz" label={t("hp.basic.timezone")} hint={t("hp.basic.timezone.hint")} optional>
            {(a) => (
              <div className="space-y-2">
                <NativeSelect {...a} value={f.timezone} onChange={set("timezone")}>
                  <option value="">{t("hp.basic.timezone.choose")}</option>
                  {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                </NativeSelect>
                {browserZone && f.timezone !== browserZone && <Button type="button" variant="outline" onClick={() => setF((p) => ({ ...p, timezone: browserZone }))}>{t("hp.basic.timezone.use", { zone: browserZone })}</Button>}
              </div>
            )}
          </Field>
          <p className="text-base text-muted-foreground">{t("hp.basic.language.note")}</p>
          <Field id="b-method" label={t("hp.basic.contactMethod")} optional>
            {(a) => (
              <NativeSelect {...a} value={f.contactMethod} onChange={set("contactMethod")}>
                <option value="">{t("hp.basic.country.choose")}</option>
                <option value="email">{t("hp.contact.email")}</option>
                <option value="phone">{t("hp.contact.phone")}</option>
                <option value="in_app">{t("hp.contact.in_app")}</option>
              </NativeSelect>
            )}
          </Field>
          <Field id="b-phone" label={t("hp.basic.phone")} optional>{(a) => <Input {...a} type="tel" dir="ltr" className="rtl:text-end" value={f.phone} onChange={set("phone")} />}</Field>
          <Field id="b-access" label={t("hp.basic.access")} hint={t("hp.basic.access.hint")} optional>{(a) => <Textarea {...a} rows={3} value={f.accessibilityNotes} onChange={set("accessibilityNotes")} />}</Field>
          {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
          <Button type="submit" size="lg" disabled={saving}>{saving ? t("common.saving") : t("common.save")}</Button>
        </form>
      )}
    </QueryState>
  );
}

// ---------------------------------------------------------------------------------------------- allergies

function AllergySection({ overview }: { overview: Overview }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const refresh = useRefresh();
  const a = overview.allergy;
  async function statement(state: "none_known" | "unknown") {
    try {
      await apiRequest("PUT", "/api/health-profile/allergies/statement", { state });
      toast({ title: t("hp.saved") });
      refresh();
    } catch (err: any) {
      toast({ title: t("hp.saveFailed"), description: err.message, variant: "destructive" });
    }
  }
  async function clear() {
    await apiRequest("DELETE", "/api/health-profile/allergies/statement");
    refresh();
  }
  return (
    <div className="space-y-6">
      <div role="status" className="space-y-1 rounded-xl border-2 border-input bg-card p-4">
        <p className="text-xl font-semibold">{t(`hp.allergy.picture.${a.picture}` as MessageKey)}</p>
        {a.picture !== "not_collected" && a.picture !== "has_known" && a.statedAt && (
          <p className="text-base text-muted-foreground">{t(a.statedBy === "doctor" ? "hp.allergy.statedByDoctor" : "hp.allergy.statedByYou", { date: formatDate(a.statedAt) })}</p>
        )}
        {a.clinicianReviewedAt && <p className="text-base text-muted-foreground">{t("hp.allergy.reviewed", { date: formatDate(a.clinicianReviewedAt) })}</p>}
        {!a.clinicianReviewedAt && a.picture !== "not_collected" && <p className="text-base text-muted-foreground">{t("hp.allergy.notReviewed")}</p>}
      </div>
      <p className="text-base text-muted-foreground">{t("hp.allergy.emptyIsNotNone")}</p>
      <EntryList kind="allergy" mode="patient" onChanged={refresh} />
      <EntryForm kind="allergy" mode="patient" onSaved={refresh} />
      {a.picture !== "has_known" && (
        <fieldset className="space-y-3 rounded-2xl border-2 border-input bg-card p-4">
          <legend className="px-2 text-xl font-semibold">{t("hp.allergy.noneTitle")}</legend>
          <p className="text-base text-muted-foreground">{t("hp.allergy.noneHelp")}</p>
          <div className="flex flex-wrap gap-3">
            <Button variant={a.picture === "none_known" ? "default" : "outline"} aria-pressed={a.picture === "none_known"} onClick={() => statement("none_known")}>{t("hp.allergy.noneKnown")}</Button>
            <Button variant={a.picture === "unknown" ? "default" : "outline"} aria-pressed={a.picture === "unknown"} onClick={() => statement("unknown")}>{t("hp.allergy.unknown")}</Button>
            {a.picture !== "not_collected" && <Button variant="ghost" onClick={clear}>{t("hp.allergy.clear")}</Button>}
          </div>
        </fieldset>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- medications and history

function MedicationSection() {
  const { t } = useI18n();
  const refresh = useRefresh();
  return (
    <div className="space-y-6">
      <p className="rounded-xl border-2 border-input bg-card p-4 text-lg">{t("hp.med.notRx")}</p>
      <EntryList kind="medication" mode="patient" onChanged={refresh} />
      <EntryForm kind="medication" mode="patient" onSaved={refresh} />
      <p className="text-base text-muted-foreground">
        {t("hp.med.reminders")} <Link href="/medications" className="font-medium text-primary underline underline-offset-4">{t("hp.med.remindersLink")}</Link>
      </p>
    </div>
  );
}

function HistorySection() {
  const { t } = useI18n();
  const refresh = useRefresh();
  return (
    <div className="space-y-8">
      <p className="text-base text-muted-foreground">{t("hp.history.note")}</p>
      {ENTRY_KIND_ORDER.filter((k) => k !== "allergy" && k !== "medication").map((k) => (
        <section key={k} aria-labelledby={`h-${k}`} className="space-y-3">
          <h2 id={`h-${k}`} className="font-display text-2xl">{t(`hp.kind.${k}.plural` as MessageKey)}</h2>
          <EntryList kind={k} mode="patient" onChanged={refresh} />
          <EntryForm kind={k} mode="patient" onSaved={refresh} />
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- preferences

function PreferencesSection() {
  const { t } = useI18n();
  const { toast } = useToast();
  const refresh = useRefresh();
  const query = useQuery<Record<string, string | null>>({ queryKey: ["/api/health-profile/preferences"], staleTime: 0 });
  const [f, setF] = useState({ emergencyContactName: "", emergencyContactPhone: "", emergencyContactRelationship: "", preferredClinic: "", appointmentFormat: "any", caregiverNote: "" });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const d = query.data;
    if (d) setF({ emergencyContactName: d.emergencyContactName ?? "", emergencyContactPhone: d.emergencyContactPhone ?? "", emergencyContactRelationship: d.emergencyContactRelationship ?? "", preferredClinic: d.preferredClinic ?? "", appointmentFormat: d.appointmentFormat ?? "any", caregiverNote: d.caregiverNote ?? "" });
  }, [query.data]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiRequest("PUT", "/api/health-profile/preferences", { ...f, emergencyContactName: f.emergencyContactName || null, emergencyContactPhone: f.emergencyContactPhone || null, emergencyContactRelationship: f.emergencyContactRelationship || null });
      toast({ title: t("hp.saved") });
      refresh();
    } catch (err: any) {
      setError(err.message);
    }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <QueryState query={query} loadingLabel={t("hp.loading")}>
      {() => (
        <form onSubmit={save} className="space-y-5" noValidate>
          <p className="rounded-xl border-2 border-input bg-card p-4 text-base">{t("hp.pref.emergencyNote")}</p>
          <Field id="p-ecn" label={t("hp.pref.ecName")} optional>{(a) => <Input {...a} value={f.emergencyContactName} onChange={set("emergencyContactName")} />}</Field>
          <Field id="p-ecr" label={t("hp.pref.ecRelationship")} optional>{(a) => <Input {...a} value={f.emergencyContactRelationship} onChange={set("emergencyContactRelationship")} />}</Field>
          <Field id="p-ecp" label={t("hp.pref.ecPhone")} optional>{(a) => <Input {...a} type="tel" dir="ltr" className="rtl:text-end" value={f.emergencyContactPhone} onChange={set("emergencyContactPhone")} />}</Field>
          <Field id="p-clinic" label={t("hp.pref.clinic")} optional>{(a) => <Input {...a} value={f.preferredClinic} onChange={set("preferredClinic")} />}</Field>
          <Field id="p-format" label={t("hp.pref.format")}>
            {(a) => (
              <NativeSelect {...a} value={f.appointmentFormat} onChange={set("appointmentFormat")}>
                <option value="any">{t("hp.format.any")}</option><option value="phone">{t("hp.format.phone")}</option>
                <option value="in_person">{t("hp.format.in_person")}</option><option value="messaging">{t("hp.format.messaging")}</option>
              </NativeSelect>
            )}
          </Field>
          <Field id="p-care" label={t("hp.pref.caregiver")} hint={t("hp.pref.caregiver.hint")} optional>{(a) => <Textarea {...a} rows={3} value={f.caregiverNote} onChange={set("caregiverNote")} />}</Field>
          {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
          <Button type="submit" size="lg">{t("common.save")}</Button>
          <p className="text-base text-muted-foreground">{t("hp.pref.careCircle")} <Link href="/care-circle" className="font-medium text-primary underline underline-offset-4">{t("hp.pref.careCircleLink")}</Link></p>
        </form>
      )}
    </QueryState>
  );
}

// ---------------------------------------------------------------------------------------------- review

interface Grant { id: string; doctorProfileId: string; doctorName: string; expiresAt: string; state: "active" | "expired" | "revoked" }
interface Pairing { id: string; status: string; doctorProfileId: string; doctor?: { id: string; name: string } | null }

function AssistCard() {
  const { t } = useI18n();
  const { toast } = useToast();
  const refresh = useRefresh();
  const grants = useQuery<Grant[]>({ queryKey: ["/api/health-profile/assist"], staleTime: 0 });
  const pairings = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });
  const [doctor, setDoctor] = useState("");
  const [days, setDays] = useState("14");
  const connected = (pairings.data ?? []).filter((p) => p.status === "accepted");
  async function grant() {
    try {
      await apiRequest("POST", "/api/health-profile/assist", { doctorProfileId: doctor, days: Number(days) });
      toast({ title: t("hp.assist.granted") });
      refresh();
    } catch (err: any) {
      toast({ title: t("hp.saveFailed"), description: err.message, variant: "destructive" });
    }
  }
  return (
    <section aria-labelledby="hp-assist" className="space-y-3 rounded-2xl border-2 border-input bg-card p-5">
      <h2 id="hp-assist" className="font-display text-2xl">{t("hp.assist.title")}</h2>
      <p className="text-lg">{t("hp.assist.body")}</p>
      {connected.length === 0 ? <p className="text-base text-muted-foreground">{t("hp.assist.noDoctor")}</p> : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="as-doc" label={t("hp.assist.which")}>
            {(a) => (
              <NativeSelect {...a} value={doctor} onChange={(e) => setDoctor(e.target.value)}>
                <option value="">{t("hp.assist.choose")}</option>
                {connected.map((p) => <option key={p.id} value={p.doctor?.id ?? p.doctorProfileId}>{p.doctor?.name ?? p.doctorProfileId}</option>)}
              </NativeSelect>
            )}
          </Field>
          <Field id="as-days" label={t("hp.assist.howLong")}>
            {(a) => (
              <NativeSelect {...a} value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="1">{t("hp.assist.days" as MessageKey, { count: 1 } as never)}</option><option value="7">{t("hp.assist.days" as MessageKey, { count: 7 } as never)}</option>
                <option value="14">{t("hp.assist.days" as MessageKey, { count: 14 } as never)}</option><option value="30">{t("hp.assist.days" as MessageKey, { count: 30 } as never)}</option>
              </NativeSelect>
            )}
          </Field>
          <div className="flex items-end"><Button size="lg" disabled={!doctor} onClick={grant}>{t("hp.assist.grant")}</Button></div>
        </div>
      )}
      <QueryState query={grants} loadingLabel={t("hp.loading")}>
        {(rows) => (rows.length === 0 ? null : (
          <ul className="space-y-2">
            {rows.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/40 p-3 text-lg">
                <span>{g.doctorName} · {t(`hp.assist.state.${g.state}` as MessageKey)}{g.state === "active" ? ` · ${t("hp.assist.until", { date: formatDate(g.expiresAt) })}` : ""}</span>
                {g.state === "active" && (
                  <ConfirmAction
                    trigger={<Button variant="outline">{t("hp.assist.revoke")}<span className="sr-only">: {g.doctorName}</span></Button>}
                    title={t("hp.assist.revoke.title", { name: g.doctorName })} description={t("hp.assist.revoke.body")} confirmLabel={t("hp.assist.revoke.yes")} cancelLabel={t("common.cancel")}
                    onConfirm={async () => { await apiRequest("DELETE", `/api/health-profile/assist/${g.id}`); refresh(); }}
                  />
                )}
              </li>
            ))}
          </ul>
        ))}
      </QueryState>
    </section>
  );
}

function ReviewSection({ overview }: { overview: Overview }) {
  const { t } = useI18n();
  const entries = useQuery<Entry[]>({ queryKey: ["/api/health-profile/entries"], staleTime: 0 });
  return (
    <div className="space-y-6">
      <section aria-labelledby="hp-sum" className="space-y-3 rounded-2xl border-2 border-input bg-card p-5">
        <h2 id="hp-sum" className="font-display text-2xl">{t("hp.review.stored")}</h2>
        <p className="text-lg">{t("hp.review.usedFor")}</p>
        <dl className="grid gap-x-8 gap-y-2 text-lg sm:grid-cols-2">
          {ENTRY_KIND_ORDER.map((k) => <div key={k}><dt className="font-semibold text-muted-foreground">{t(`hp.kind.${k}.plural` as MessageKey)}</dt><dd>{overview.counts[k] ?? 0}</dd></div>)}
          <div><dt className="font-semibold text-muted-foreground">{t("hp.review.unverified")}</dt><dd>{overview.unverified}</dd></div>
        </dl>
        <p className="text-base text-muted-foreground">{t("hp.review.correct")}</p>
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline"><a href="/api/me/export" download>{t("hp.review.download")}</a></Button>
        </div>
        <QueryState query={entries} loadingLabel={t("hp.loading")}>{(rows) => <p className="text-base text-muted-foreground">{t("hp.review.entries", { count: rows.length })}</p>}</QueryState>
      </section>
      <ConsentCard overview={overview} />
      {overview.consent.given && <AssistCard />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- page

export default function HealthProfile({ section }: { section?: string }) {
  const { t } = useI18n();
  const query = useOverview();
  if (!section) return <Home />;
  if (!SECTIONS.includes(section as SectionId)) return <Home />;
  const id = section as SectionId;
  return (
    <QueryState query={query} loadingLabel={t("hp.loading")}>
      {(overview) => (
        <SectionFrame id={id} overview={overview}>
          {id === "basic" && <BasicSection />}
          {id === "allergies" && <AllergySection overview={overview} />}
          {id === "medications" && <MedicationSection />}
          {id === "history" && <HistorySection />}
          {id === "preferences" && <PreferencesSection />}
          {id === "review" && <ReviewSection overview={overview} />}
        </SectionFrame>
      )}
    </QueryState>
  );
}

void Ltr;
