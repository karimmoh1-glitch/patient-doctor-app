import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Redirect } from "wouter";
import { AlertTriangle, CheckCircle2, Clock, ShieldAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import PageHeader from "@/components/page-header";
import StepProgress from "@/components/step-progress";
import QueryState from "@/components/query-state";
import { CheckGroup, Field } from "@/components/form-field";
import { Ltr } from "@/components/ltr";
import { apiRequest } from "@/lib/queryClient";
import { getIntlLocale, useI18n } from "@/lib/i18n";
import { languageName, modalityLabel, roleLabel, specialtyLabel } from "@/lib/labels";
import { SPECIALTIES, US_STATES } from "@shared/specialties";
import { CLINICIAN_LANGUAGES, MODALITIES, PROFESSIONAL_ROLES, type DoctorStatus } from "@shared/languages";
import type { AuthUser } from "@/hooks/use-auth";

interface Application {
  id: string;
  status: DoctorStatus;
  name: string;
  displayName: string | null;
  professionalRole: string | null;
  specialty: string | null;
  licenseNumber: string | null;
  licensingBody: string | null;
  state: string | null;
  npiNumber: string | null;
  qualifications: string | null;
  languages: string[];
  yearsExperience: number | null;
  clinic: string | null;
  modalities: string[];
  phone: string | null;
  bio: string | null;
  infoRequest: string | null;
  decisionNote: string | null;
}
interface Response { status: DoctorStatus; application: Application | null }

type Form = {
  displayName: string; professionalRole: string; specialty: string; state: string; licenseNumber: string; licensingBody: string;
  npiNumber: string; qualifications: string; yearsExperience: string;
  languages: string[]; modalities: string[]; clinic: string; phone: string; bio: string;
};

function toForm(a: Application): Form {
  return {
    displayName: a.displayName ?? a.name, professionalRole: a.professionalRole ?? "", specialty: a.specialty ?? "", state: a.state ?? "",
    licenseNumber: a.licenseNumber ?? "", licensingBody: a.licensingBody ?? "", npiNumber: a.npiNumber ?? "", qualifications: a.qualifications ?? "",
    yearsExperience: a.yearsExperience?.toString() ?? "", languages: a.languages ?? [], modalities: a.modalities?.length ? a.modalities : ["phone"],
    clinic: a.clinic ?? "", phone: a.phone ?? "", bio: a.bio ?? "",
  };
}

// "English, Arabic" / "الإنجليزية، العربية": the separator follows the language.
const list = (items: string[]) => new Intl.ListFormat(getIntlLocale(), { style: "narrow", type: "unit" }).format(items);

const PROFESSIONAL_FIELDS = ["professionalRole", "specialty", "state", "licenseNumber", "licensingBody"] as const;
const PROFILE_FIELDS = ["languages", "modalities", "phone"] as const;

function StatusPanel({ icon: Icon, tone, title, children }: { icon: typeof Clock; tone: string; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <PageHeader title={title} />
      <div role="status" className={`flex gap-4 rounded-2xl border-2 p-6 ${tone}`}>
        <Icon className="mt-1 h-7 w-7 shrink-0" aria-hidden="true" />
        <div className="space-y-3 text-lg">{children}</div>
      </div>
    </div>
  );
}

export default function DoctorApplication({ user, onApproved }: { user: AuthUser; onApproved?: () => void }) {
  const { t } = useI18n();
  const query = useQuery<Response>({ queryKey: ["/api/doctors/me/application"], staleTime: 0 });
  // Pending reviews can end while this page is open, so look again every minute.
  useEffect(() => {
    if (user.doctorStatus === "pending" || user.doctorStatus === "needs_info") {
      const id = setInterval(() => query.refetch(), 60_000);
      return () => clearInterval(id);
    }
  }, [user.doctorStatus, query]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <QueryState query={query} loadingLabel={t("onb.loading")}>
        {(data) => <ApplicationBody data={data} user={user} onApproved={onApproved} />}
      </QueryState>
    </div>
  );
}

function ApplicationBody({ data, user, onApproved }: { data: Response; user: AuthUser; onApproved?: () => void }) {
  const { t } = useI18n();
  const status = data.status;

  useEffect(() => {
    if (status === "approved" && user.doctorStatus !== "approved") onApproved?.();
  }, [status, user.doctorStatus, onApproved]);

  if (status === "approved") return <Redirect to="/doctor" />;

  if (status === "pending") {
    return (
      <StatusPanel icon={Clock} tone="border-primary/30 bg-secondary" title={t("onb.pending.title")}>
        <p>{t("onb.pending.body")}</p>
        <p className="text-base text-muted-foreground">{t("onb.pending.note")}</p>
      </StatusPanel>
    );
  }
  if (status === "rejected") {
    return (
      <StatusPanel icon={XCircle} tone="border-destructive/40 bg-card" title={t("onb.rejected.title")}>
        <p>{t("onb.rejected.body")}</p>
        {data.application?.decisionNote && <p className="rounded-lg bg-muted p-3"><strong>{t("onb.reason")}:</strong> {data.application.decisionNote}</p>}
      </StatusPanel>
    );
  }
  if (status === "suspended") {
    return (
      <StatusPanel icon={ShieldAlert} tone="border-destructive/40 bg-card" title={t("onb.suspended.title")}>
        <p>{t("onb.suspended.body")}</p>
        {data.application?.decisionNote && <p className="rounded-lg bg-muted p-3"><strong>{t("onb.reason")}:</strong> {data.application.decisionNote}</p>}
      </StatusPanel>
    );
  }
  if (!data.application) return <StatusPanel icon={AlertTriangle} tone="border-input bg-card" title={t("onb.missing.title")}><p>{t("onb.missing.body")}</p></StatusPanel>;
  return <Wizard application={data.application} />;
}

function Wizard({ application }: { application: Application }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>(() => toForm(application));
  const needsInfo = application.status === "needs_info";
  const initialStep = () => {
    if (PROFESSIONAL_FIELDS.some((f) => !(application as any)[f === "state" ? "state" : f])) return 1;
    if (!application.phone || !application.languages?.length) return 2;
    return 3;
  };
  const [step, setStep] = useState(initialStep);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const steps = [t("onb.step.account"), t("onb.step.professional"), t("onb.step.profile"), t("onb.step.review")];
  const required = t("onb.required");

  function validate(which: number): Record<string, string> {
    const e: Record<string, string> = {};
    if (which === 1) {
      if (!form.professionalRole) e.professionalRole = required;
      if (!form.specialty) e.specialty = required;
      if (!form.state) e.state = required;
      if (!form.licenseNumber.trim()) e.licenseNumber = required;
      if (!form.licensingBody.trim()) e.licensingBody = required;
    }
    if (which === 2) {
      if (!form.languages.length) e.languages = t("onb.err.languages");
      if (!form.modalities.length) e.modalities = t("onb.err.modalities");
      if (!/^[+()\d\s.-]{7,25}$/.test(form.phone.trim())) e.phone = t("onb.err.phone");
    }
    return e;
  }

  function payload(which: number) {
    if (which === 1) {
      return {
        displayName: form.displayName.trim() || undefined, professionalRole: form.professionalRole, specialty: form.specialty, state: form.state,
        licenseNumber: form.licenseNumber.trim(), licensingBody: form.licensingBody.trim(), npiNumber: form.npiNumber.trim() || undefined,
        qualifications: form.qualifications.trim() || undefined,
        yearsExperience: form.yearsExperience === "" ? null : Number(form.yearsExperience),
      };
    }
    return { languages: form.languages, modalities: form.modalities, clinic: form.clinic.trim() || undefined, phone: form.phone.trim(), bio: form.bio.trim() || undefined };
  }

  async function next() {
    const e = validate(step);
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      await apiRequest("PUT", "/api/doctors/me/application", payload(step));
      setStep(step + 1);
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    setSaving(true);
    setFormError(null);
    try {
      await apiRequest("POST", "/api/doctors/me/application/submit");
      await queryClient.invalidateQueries({ queryKey: ["/api/doctors/me/application"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      window.dispatchEvent(new Event("avela:doctor-status"));
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader title={t("onb.app.title")} description={t("onb.app.intro")} />
      {needsInfo && (
        <div role="alert" className="flex gap-4 rounded-2xl border-2 border-ochre bg-sand p-5 text-sand-foreground">
          <AlertTriangle className="mt-1 h-6 w-6 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">{t("onb.needsInfo.title")}</p>
            <p className="whitespace-pre-wrap">{application.infoRequest}</p>
          </div>
        </div>
      )}
      <StepProgress steps={steps} current={step} />

      {step === 1 && (
        <form onSubmit={(e) => { e.preventDefault(); next(); }} className="space-y-5" noValidate>
          <h2 className="font-display text-2xl font-semibold">{t("onb.step.professional")}</h2>
          <p className="text-lg text-muted-foreground">{t("onb.prof.intro")}</p>
          <Field id="a-display" label={t("onb.f.displayName")} hint={t("onb.f.displayNameHint")} optional>{(a) => <Input {...a} value={form.displayName} onChange={(e) => set("displayName", e.target.value)} />}</Field>
          <Field id="a-role" label={t("onb.f.role")} error={errors.professionalRole}>
            {(a) => (
              <NativeSelect {...a} value={form.professionalRole} onChange={(e) => set("professionalRole", e.target.value)}>
                <option value="">{t("onb.choose")}</option>
                {PROFESSIONAL_ROLES.map((r) => <option key={r} value={r}>{roleLabel(t, r)}</option>)}
              </NativeSelect>
            )}
          </Field>
          <Field id="a-specialty" label={t("onb.f.specialty")} error={errors.specialty}>
            {(a) => (
              <NativeSelect {...a} value={form.specialty} onChange={(e) => set("specialty", e.target.value)}>
                <option value="">{t("onb.choose")}</option>
                {SPECIALTIES.map((s) => <option key={s} value={s}>{specialtyLabel(t, s)}</option>)}
              </NativeSelect>
            )}
          </Field>
          <Field id="a-state" label={t("onb.f.state")} hint={t("onb.f.stateHint")} error={errors.state}>
            {(a) => (
              <NativeSelect {...a} value={form.state} onChange={(e) => set("state", e.target.value)}>
                <option value="">{t("onb.choose")}</option>
                {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </NativeSelect>
            )}
          </Field>
          <Field id="a-license" label={t("onb.f.license")} error={errors.licenseNumber}>{(a) => <Input {...a} dir="ltr" value={form.licenseNumber} onChange={(e) => set("licenseNumber", e.target.value)} />}</Field>
          <Field id="a-body" label={t("onb.f.body")} hint={t("onb.f.bodyHint")} error={errors.licensingBody}>{(a) => <Input {...a} value={form.licensingBody} onChange={(e) => set("licensingBody", e.target.value)} />}</Field>
          <Field id="a-npi" label={t("onb.f.npi")} optional>{(a) => <Input {...a} dir="ltr" value={form.npiNumber} onChange={(e) => set("npiNumber", e.target.value)} />}</Field>
          <Field id="a-qual" label={t("onb.f.qualifications")} hint={t("onb.f.qualificationsHint")} optional>{(a) => <Textarea {...a} rows={3} value={form.qualifications} onChange={(e) => set("qualifications", e.target.value)} />}</Field>
          <Field id="a-years" label={t("onb.f.years")} optional>{(a) => <Input {...a} type="number" min={0} max={70} inputMode="numeric" value={form.yearsExperience} onChange={(e) => set("yearsExperience", e.target.value)} className="max-w-32" />}</Field>
          {formError && <p role="alert" className="font-medium text-destructive">{formError}</p>}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" size="lg" disabled={saving}>{saving ? t("common.saving") : t("common.next")}</Button>
          </div>
        </form>
      )}

      {step === 2 && (
        <form onSubmit={(e) => { e.preventDefault(); next(); }} className="space-y-5" noValidate>
          <h2 className="font-display text-2xl font-semibold">{t("onb.step.profile")}</h2>
          <p className="text-lg text-muted-foreground">{t("onb.profile.intro")}</p>
          <CheckGroup
            legend={t("onb.f.languages")} hint={t("onb.f.languagesHint")} error={errors.languages}
            options={CLINICIAN_LANGUAGES.map((l) => ({ value: l.code, label: l.native, lang: l.code }))}
            value={form.languages} onChange={(v) => set("languages", v)}
          />
          <CheckGroup
            legend={t("onb.f.modalities")} hint={t("onb.f.modalitiesHint")} error={errors.modalities}
            options={MODALITIES.map((m) => ({ value: m, label: modalityLabel(t, m) }))}
            value={form.modalities} onChange={(v) => set("modalities", v)}
          />
          <Field id="a-clinic" label={t("onb.f.clinic")} optional>{(a) => <Input {...a} value={form.clinic} onChange={(e) => set("clinic", e.target.value)} />}</Field>
          <Field id="a-phone" label={t("onb.f.phone")} hint={t("onb.f.phoneHint")} error={errors.phone}>{(a) => <Input {...a} type="tel" dir="ltr" autoComplete="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} />}</Field>
          <Field id="a-bio" label={t("onb.f.bio")} hint={t("onb.f.bioHint")} optional>{(a) => <Textarea {...a} rows={4} value={form.bio} onChange={(e) => set("bio", e.target.value)} />}</Field>
          {formError && <p role="alert" className="font-medium text-destructive">{formError}</p>}
          <div className="flex flex-wrap gap-3">
            <Button type="button" size="lg" variant="outline" onClick={() => setStep(1)}>{t("common.back")}</Button>
            <Button type="submit" size="lg" disabled={saving}>{saving ? t("common.saving") : t("common.next")}</Button>
          </div>
        </form>
      )}

      {step === 3 && (
        <div className="space-y-6">
          <h2 className="font-display text-2xl font-semibold">{t("onb.step.review")}</h2>
          <p className="text-lg text-muted-foreground">{t("onb.review.intro")}</p>
          <dl className="grid gap-x-8 gap-y-4 rounded-2xl border border-border bg-card p-6 shadow-soft sm:grid-cols-2">
            {([
              [t("onb.f.displayName"), form.displayName],
              [t("onb.f.role"), form.professionalRole ? roleLabel(t, form.professionalRole) : ""],
              [t("onb.f.specialty"), form.specialty ? specialtyLabel(t, form.specialty) : ""],
              [t("onb.f.state"), form.state],
              [t("onb.f.license"), <Ltr key="l">{form.licenseNumber}</Ltr>],
              [t("onb.f.body"), form.licensingBody],
              [t("onb.f.languages"), list(form.languages.map((c) => languageName(c)))],
              [t("onb.f.modalities"), list(form.modalities.map((m) => modalityLabel(t, m)))],
              [t("onb.f.phone"), <Ltr key="p">{form.phone}</Ltr>],
              [t("onb.f.clinic"), form.clinic || t("common.none")],
            ] as [string, React.ReactNode][]).map(([label, value]) => (
              <div key={label}><dt className="text-base font-semibold text-muted-foreground">{label}</dt><dd className="text-lg">{value || t("common.none")}</dd></div>
            ))}
          </dl>
          <p className="rounded-2xl bg-sand p-5 text-lg text-sand-foreground">{t("onb.review.honest")}</p>
          {formError && <p role="alert" className="font-medium text-destructive">{formError}</p>}
          <div className="flex flex-wrap gap-3">
            <Button type="button" size="lg" variant="outline" onClick={() => setStep(2)}>{t("common.back")}</Button>
            <Button type="button" size="lg" onClick={submit} disabled={saving}><CheckCircle2 aria-hidden="true" /> {saving ? t("onb.review.sending") : t("onb.review.send")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
