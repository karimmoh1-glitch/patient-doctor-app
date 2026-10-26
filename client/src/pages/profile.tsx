import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import ConfirmAction from "@/components/confirm-action";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDate, formatDateTime } from "@/lib/format";
import { Ltr } from "@/components/ltr";
import { useI18n, type MessageKey } from "@/lib/i18n";
import type { AuthUser } from "@/hooks/use-auth";

/** Puts a link where a translation has a {link} marker, so the sentence order can differ per language. */
function withLink(template: string, link: React.ReactNode) {
  const [before, after = ""] = template.split("{link}");
  return <>{before}{link}{after}</>;
}

interface EmergencyProfile {
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  allergiesText: string | null;
  emergencyNotes: string | null;
}

function EmergencyInfoForm() {
  const { toast } = useToast();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data } = useQuery<EmergencyProfile>({ queryKey: ["/api/emergency-profile"] });
  const [form, setForm] = useState<EmergencyProfile>({ emergencyContactName: "", emergencyContactPhone: "", allergiesText: "", emergencyNotes: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiRequest("PUT", "/api/emergency-profile", form);
      queryClient.invalidateQueries({ queryKey: ["/api/emergency-profile"] });
      toast({ title: t("profile.emergency.saved") });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="text-2xl">{t("profile.emergency.title")}</CardTitle>
        <CardDescription className="text-base">{t("profile.emergency.intro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ec-name" className="text-base">{t("profile.emergency.nameLabel")}</Label>
            <Input id="ec-name" value={form.emergencyContactName ?? ""} onChange={(e) => setForm((f) => ({ ...f, emergencyContactName: e.target.value }))} placeholder={t("profile.emergency.namePlaceholder")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-phone" className="text-base">{t("profile.emergency.phoneLabel")}</Label>
            <Input id="ec-phone" type="tel" dir="ltr" className="rtl:text-end" value={form.emergencyContactPhone ?? ""} onChange={(e) => setForm((f) => ({ ...f, emergencyContactPhone: e.target.value }))} />
          </div>
          <p className="text-base text-muted-foreground">{t("hp.profile.allergiesMoved")} <Link href="/health-profile/allergies" className="font-medium text-primary underline underline-offset-4">{t("hp.profile.allergiesLink")}</Link></p>
          <div className="space-y-2">
            <Label htmlFor="ec-notes" className="text-base">{t("profile.emergency.notes")}</Label>
            <Textarea id="ec-notes" rows={3} value={form.emergencyNotes ?? ""} onChange={(e) => setForm((f) => ({ ...f, emergencyNotes: e.target.value }))} />
          </div>
          {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
          <Button type="submit" size="lg" disabled={saving}>{saving ? t("common.saving") : t("profile.emergency.save")}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

interface AccessRow {
  doctorProfileId: string;
  doctorName: string;
  specialty: string;
  relationshipLabel: string;
  connectedSince: string | null;
  grant: { shareMedications: boolean; shareDocuments: boolean; shareAppointments: boolean; shareFullHistory: boolean; grantedAt: string } | null;
}

type GrantField = "shareMedications" | "shareDocuments" | "shareAppointments" | "shareFullHistory";

// Each switch says exactly what it releases. These are enforced by the server
// (see /api/pairings/:id/shared-records) and end the moment the connection ends.
const GRANTS: { field: GrantField; labelKey: MessageKey; detailKey: MessageKey }[] = [
  { field: "shareMedications", labelKey: "privacy.grant.meds.label", detailKey: "privacy.grant.meds.detail" },
  { field: "shareDocuments", labelKey: "privacy.grant.docs.label", detailKey: "privacy.grant.docs.detail" },
  { field: "shareAppointments", labelKey: "privacy.grant.appts.label", detailKey: "privacy.grant.appts.detail" },
  { field: "shareFullHistory", labelKey: "privacy.grant.full.label", detailKey: "privacy.grant.full.detail" },
];

function DoctorSharing({ row }: { row: AccessRow }) {
  const { toast } = useToast();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  async function update(field: GrantField, value: boolean) {
    setSaving(true);
    try {
      await apiRequest("PUT", `/api/sharing/${row.doctorProfileId}`, {
        shareMedications: row.grant?.shareMedications ?? false,
        shareDocuments: row.grant?.shareDocuments ?? false,
        shareAppointments: row.grant?.shareAppointments ?? false,
        shareFullHistory: row.grant?.shareFullHistory ?? false,
        [field]: value,
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/sharing"] });
      queryClient.invalidateQueries({ queryKey: ["/api/audit-log"] });
      toast({ title: value ? t("privacy.toast.shared") : t("privacy.toast.unshared") });
    } catch (err: any) {
      toast({ title: t("privacy.toast.failed"), description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3" className="text-xl">{row.doctorName}</CardTitle>
        <CardDescription className="text-base">{row.connectedSince
            ? t("privacy.connected", { relationship: row.relationshipLabel, date: formatDate(row.connectedSince) })
            : t("privacy.connectedRecently", { relationship: row.relationshipLabel })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-lg">{withLink(t("privacy.always"), <Link href="/care-team" className="font-medium text-primary underline underline-offset-4">{t("privacy.myDoctors")}</Link>)}</p>
        <ul className="space-y-3">
          {GRANTS.map(({ field, labelKey, detailKey }) => {
            const label = t(labelKey);
            const on = row.grant?.[field] ?? false;
            const id = `${row.doctorProfileId}-${field}`;
            return (
              <li key={field} className="flex items-start justify-between gap-4 rounded-xl border-2 border-input p-4">
                <div className="min-w-0">
                  <Label htmlFor={id} className="text-lg font-semibold">{label}</Label>
                  <p className="text-muted-foreground">{t(detailKey)}</p>
                </div>
                {field === "shareFullHistory" && !on ? (
                  <ConfirmAction
                    trigger={<Switch id={id} checked={on} disabled={saving} aria-label={t("privacy.switchAria", { label, name: row.doctorName })} />}
                    title={t("privacy.confirm.title", { name: row.doctorName })}
                    description={t("privacy.confirm.body")}
                    confirmLabel={t("privacy.confirm.yes")}
                    cancelLabel={t("privacy.confirm.no")}
                    onConfirm={() => update(field, true)}
                  />
                ) : (
                  <Switch id={id} checked={on} disabled={saving} onCheckedChange={(v) => update(field, v)} aria-label={t("privacy.switchAria", { label, name: row.doctorName })} />
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

interface AccessEntry { id: string; kind: "access" | "change"; text: string; createdAt: string }

function ActivityLog() {
  const { t } = useI18n();
  const query = useQuery<AccessEntry[]>({ queryKey: ["/api/audit-log"] });
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="text-2xl">{t("privacy.log.title")}</CardTitle>
        <CardDescription className="text-base">{t("privacy.log.intro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState query={query} isEmpty={(e) => e.length === 0} empty={<EmptyBlock title={t("privacy.log.empty")} />}>
          {(entries) => {
            const access = entries.filter((e) => e.kind === "access");
            const changes = entries.filter((e) => e.kind === "change");
            const list = (items: AccessEntry[], empty: string) =>
              items.length === 0 ? (
                <p className="text-lg text-muted-foreground">{empty}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {items.slice(0, 20).map((e) => (
                    <li key={e.id} className="py-3">
                      <p className="text-lg">{e.text}</p>
                      <p className="text-muted-foreground">{formatDateTime(e.createdAt)}</p>
                    </li>
                  ))}
                </ul>
              );
            return (
              <div className="space-y-6">
                <section aria-labelledby="who-looked">
                  <h3 id="who-looked" className="mb-1 text-xl font-semibold">{t("privacy.log.peopleHeading")}</h3>
                  {list(access, t("privacy.log.noAccess"))}
                </section>
                <section aria-labelledby="what-changed">
                  <h3 id="what-changed" className="mb-1 text-xl font-semibold">{t("privacy.log.changesHeading")}</h3>
                  {list(changes, t("privacy.log.noChanges"))}
                </section>
              </div>
            );
          }}
        </QueryState>
      </CardContent>
    </Card>
  );
}

export default function Profile({ user }: { user: AuthUser }) {
  const { t } = useI18n();
  const sharingQuery = useQuery<AccessRow[]>({ queryKey: ["/api/sharing"] });

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-semibold">{t("profile.title")}</h1>
        <p className="text-lg text-muted-foreground">{t("profile.intro")}</p>
      </div>

      <Card>
        <CardHeader><CardTitle as="h2" className="text-2xl">{t("profile.details.title")}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <dl className="space-y-3 text-lg">
            <div><dt className="font-semibold">{t("profile.field.name")}</dt><dd>{user.name}</dd></div>
            <div><dt className="font-semibold">{t("profile.field.email")}</dt><dd><Ltr>{user.email}</Ltr></dd></div>
            {user.state && <div><dt className="font-semibold">{t("profile.field.state")}</dt><dd>{user.state}</dd></div>}
          </dl>
          <Button asChild variant="outline"><Link href="/forgot-password">{t("profile.changePassword")}</Link></Button>
        </CardContent>
      </Card>

      <section aria-labelledby="sharing-heading" className="space-y-4">
        <div>
          <h2 id="sharing-heading" className="text-2xl font-semibold">{t("privacy.sharing.heading")}</h2>
          <p className="text-lg text-muted-foreground">{t("privacy.sharing.intro")}</p>
        </div>
        <QueryState
          query={sharingQuery}
          isEmpty={(rows) => rows.length === 0}
          empty={<EmptyBlock title={t("privacy.sharing.empty")}>{t("privacy.sharing.emptyBody")}</EmptyBlock>}
        >
          {(rows) => <div className="space-y-4">{rows.map((row) => <DoctorSharing key={row.doctorProfileId} row={row} />)}</div>}
        </QueryState>
        <p className="text-lg">
          {withLink(t("privacy.helpers"), <Link href="/care-circle" className="font-medium text-primary underline underline-offset-4">{t("circle.title")}</Link>)}
        </p>
      </section>

      <ActivityLog />
      <EmergencyInfoForm />
    </div>
  );
}
