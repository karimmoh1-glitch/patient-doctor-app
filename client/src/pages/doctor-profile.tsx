import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import PageHeader from "@/components/page-header";
import QueryState from "@/components/query-state";
import { CheckGroup, Field } from "@/components/form-field";
import { Ltr } from "@/components/ltr";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDate } from "@/lib/format";
import { modalityLabel, specialtyLabel } from "@/lib/labels";
import { CLINICIAN_LANGUAGES, MODALITIES } from "@shared/languages";

interface Profile {
  id: string; name: string; specialty: string; state: string; bio: string | null; clinic: string | null; languages: string[]; modalities: string[];
  phone: string; licenseNumber: string | null; licensingBody: string | null; verifiedAt: string | null;
  credential: { status: "submitted" | "pending" | "verified" | "rejected" | "suspended" | "expired"; source: string | null; checkedAt: string | null; expiresAt: string | null } | null;
}

// The fields a doctor may change themselves. Licence, specialty and state are
// what a reviewer approved, so they are shown but can't be edited here.
export default function DoctorProfile() {
  const { t } = useI18n();
  const query = useQuery<Profile>({ queryKey: ["/api/doctors/me/profile"], staleTime: 0 });
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t("dprof.title")} description={t("dprof.intro")} />
      <QueryState query={query}>{(p) => <ProfileForm profile={p} />}</QueryState>
    </div>
  );
}

function ProfileForm({ profile }: { profile: Profile }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [bio, setBio] = useState(profile.bio ?? "");
  const [clinic, setClinic] = useState(profile.clinic ?? "");
  const [phone, setPhone] = useState(profile.phone);
  const [languages, setLanguages] = useState<string[]>(profile.languages);
  const [modalities, setModalities] = useState<string[]>(profile.modalities);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setBio(profile.bio ?? ""); setClinic(profile.clinic ?? ""); setPhone(profile.phone); setLanguages(profile.languages); setModalities(profile.modalities); }, [profile]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!languages.length || !modalities.length) return setError(t("dprof.needOne"));
    setSaving(true);
    try {
      await apiRequest("PATCH", "/api/doctors/me/profile", { bio: bio.trim(), clinic: clinic.trim(), phone: phone.trim(), languages, modalities });
      await queryClient.invalidateQueries({ queryKey: ["/api/doctors/me/profile"] });
      toast({ title: t("dprof.saved") });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="locked" className="space-y-3 rounded-2xl border border-border bg-card p-6 shadow-soft">
        <h2 id="locked" className="flex items-center gap-2 text-xl font-semibold">
          {profile.verifiedAt && <BadgeCheck className="h-5 w-5 text-primary" aria-hidden="true" />} {t("dprof.reviewed")}
        </h2>
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <div><dt className="text-base font-semibold text-muted-foreground">{t("onb.f.displayName")}</dt><dd className="text-lg">{profile.name}</dd></div>
          <div><dt className="text-base font-semibold text-muted-foreground">{t("onb.f.specialty")}</dt><dd className="text-lg">{specialtyLabel(t, profile.specialty)}</dd></div>
          <div><dt className="text-base font-semibold text-muted-foreground">{t("onb.f.state")}</dt><dd className="text-lg">{profile.state}</dd></div>
          <div><dt className="text-base font-semibold text-muted-foreground">{t("onb.f.license")}</dt><dd className="text-lg"><Ltr>{profile.licenseNumber ?? "—"}</Ltr></dd></div>
        </dl>
        {profile.credential && (
          <p role="status" className={`rounded-xl border-2 p-3 text-base ${profile.credential.status === "verified" ? "border-primary/40 bg-secondary" : "border-ochre bg-sand text-sand-foreground"}`}>
            {t(`dprof.cred.${profile.credential.status}` as MessageKey, { date: profile.credential.expiresAt ? formatDate(profile.credential.expiresAt) : "", how: profile.credential.source ? t(`admin.verify.source.${profile.credential.source}` as MessageKey) : "" })}
          </p>
        )}
        <p className="text-base text-muted-foreground">{t("dprof.lockedNote")}</p>
      </section>

      <form onSubmit={save} className="space-y-5" noValidate>
        <h2 className="font-display text-2xl font-semibold">{t("dprof.editable")}</h2>
        <CheckGroup legend={t("onb.f.languages")} options={CLINICIAN_LANGUAGES.map((l) => ({ value: l.code, label: l.native, lang: l.code }))} value={languages} onChange={setLanguages} />
        <CheckGroup legend={t("onb.f.modalities")} options={MODALITIES.map((m) => ({ value: m, label: modalityLabel(t, m) }))} value={modalities} onChange={setModalities} />
        <Field id="p-clinic" label={t("onb.f.clinic")} optional>{(a) => <Input {...a} value={clinic} onChange={(e) => setClinic(e.target.value)} />}</Field>
        <Field id="p-phone" label={t("onb.f.phone")} hint={t("onb.f.phoneHint")}>{(a) => <Input {...a} type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        <Field id="p-bio" label={t("onb.f.bio")} optional>{(a) => <Textarea {...a} rows={5} value={bio} onChange={(e) => setBio(e.target.value)} />}</Field>
        {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
        <Button type="submit" size="lg" disabled={saving}>{saving ? t("common.saving") : t("common.save")}</Button>
      </form>
    </div>
  );
}
