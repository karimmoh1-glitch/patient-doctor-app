import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Copy, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import ConfirmAction from "@/components/confirm-action";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format";
import { useI18n, type MessageKey } from "@/lib/i18n";

interface CareCircleMember {
  id: string;
  name: string;
  relationshipLabel: string;
  status: string;
  permissionMedicationStatus: boolean;
  permissionAppointments: boolean;
  permissionDeliveryStatus: boolean;
  permissionDocuments: boolean;
  permissionFullRecords: boolean;
  invitedAt: string;
  respondedAt: string | null;
}

// Only the permissions a helper can actually use today. (A broader "entire
// health history" switch existed before; the server never honoured it, so it
// is not offered rather than promised.)
const PERMISSION_FIELDS: readonly (readonly [
  "permissionMedicationStatus" | "permissionAppointments" | "permissionDeliveryStatus" | "permissionDocuments",
  MessageKey,
  MessageKey,
])[] = [
  ["permissionMedicationStatus", "circle.perm.meds.label", "circle.perm.meds.detail"],
  ["permissionAppointments", "circle.perm.appts.label", "circle.perm.appts.detail"],
  ["permissionDeliveryStatus", "circle.perm.delivery.label", "circle.perm.delivery.detail"],
  ["permissionDocuments", "circle.perm.docs.label", "circle.perm.docs.detail"],
];

type PermissionField = (typeof PERMISSION_FIELDS)[number][0];

interface InviteResult { emailSent: boolean; inviteLink: string; name: string }

function InviteDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [relationship, setRelationship] = useState("");
  const [permissions, setPermissions] = useState<Record<PermissionField, boolean>>({
    permissionMedicationStatus: true,
    permissionAppointments: true,
    permissionDeliveryStatus: false,
    permissionDocuments: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);

  function close(v: boolean) {
    onOpenChange(v);
    if (!v) {
      setResult(null);
      setName(""); setEmail(""); setRelationship(""); setError(null); setCopied(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !email.trim() || !relationship.trim()) return setError(t("circle.invite.fillAll"));
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/care-circle", {
        name: name.trim(), inviteEmail: email.trim(), relationshipLabel: relationship.trim(), ...permissions, permissionFullRecords: false,
      });
      const data = await res.json();
      setResult({ emailSent: data.emailSent, inviteLink: data.inviteLink, name: name.trim() });
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.inviteLink);
      setCopied(true);
    } catch {
      setError(t("circle.invite.copyFailed"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl">{t("circle.invite.ready")}</DialogTitle>
              <DialogDescription className="text-base">
                {result.emailSent ? t("circle.invite.emailed", { name: result.name }) : t("circle.invite.notEmailed", { name: result.name })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <Label htmlFor="invite-link" className="text-base">{t("circle.invite.linkLabel")}</Label>
              <Input id="invite-link" readOnly dir="ltr" className="rtl:text-end" value={result.inviteLink} onFocus={(e) => e.currentTarget.select()} />
              <div className="flex flex-wrap gap-3">
                <Button size="lg" onClick={copy}>{copied ? <><Check aria-hidden="true" /> {t("circle.invite.copied")}</> : <><Copy aria-hidden="true" /> {t("circle.invite.copy")}</>}</Button>
                <Button size="lg" variant="outline" onClick={() => close(false)}>{t("circle.invite.done")}</Button>
              </div>
              {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl">{t("circle.invite.title")}</DialogTitle>
              <DialogDescription className="text-base">{t("circle.invite.intro")}</DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="inv-name" className="text-base">{t("circle.invite.nameLabel")}</Label>
                <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inv-rel" className="text-base">{t("circle.invite.relLabel")}</Label>
                <Input id="inv-rel" value={relationship} onChange={(e) => setRelationship(e.target.value)} placeholder={t("circle.invite.relPlaceholder")} autoComplete="off" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inv-email" className="text-base">{t("circle.invite.emailLabel")}</Label>
                <Input id="inv-email" type="email" dir="ltr" className="rtl:text-end" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              </div>
              <fieldset className="space-y-3">
                <legend className="mb-1 text-base font-semibold">{t("circle.invite.seeLegend")}</legend>
                {PERMISSION_FIELDS.map(([field, labelKey, detailKey]) => (
                  <label key={field} className="flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border-2 border-input p-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-6 w-6"
                      checked={permissions[field]}
                      onChange={(e) => setPermissions((p) => ({ ...p, [field]: e.target.checked }))}
                    />
                    <span><span className="block text-lg font-semibold">{t(labelKey)}</span><span className="block text-muted-foreground">{t(detailKey)}</span></span>
                  </label>
                ))}
              </fieldset>
              {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
              <Button type="submit" size="lg" className="w-full" disabled={submitting}>{submitting ? t("circle.invite.creating") : t("circle.invite.create")}</Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function CareCircle() {
  const { toast } = useToast();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const query = useQuery<CareCircleMember[]>({ queryKey: ["/api/care-circle"] });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/care-circle"] });
    queryClient.invalidateQueries({ queryKey: ["/api/audit-log"] });
  };

  async function toggle(member: CareCircleMember, field: PermissionField, value: boolean) {
    setBusyId(member.id);
    try {
      await apiRequest("PATCH", `/api/care-circle/${member.id}/permissions`, {
        permissionMedicationStatus: member.permissionMedicationStatus,
        permissionAppointments: member.permissionAppointments,
        permissionDeliveryStatus: member.permissionDeliveryStatus,
        permissionDocuments: member.permissionDocuments,
        permissionFullRecords: false,
        [field]: value,
      });
      refresh();
    } catch (err: any) {
      toast({ title: t("privacy.toast.failed"), description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(member: CareCircleMember) {
    try {
      await apiRequest("DELETE", `/api/care-circle/${member.id}`);
      toast({ title: t("circle.toast.removed", { name: member.name }) });
      refresh();
    } catch (err: any) {
      toast({ title: t("circle.toast.removeFailed"), description: err.message, variant: "destructive" });
      throw err;
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">{t("circle.title")}</h1>
          <p className="text-lg text-muted-foreground">{t("circle.intro")}</p>
        </div>
        <Button size="lg" onClick={() => setInviteOpen(true)}><UserPlus aria-hidden="true" /> {t("circle.invite.button")}</Button>
      </div>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} onDone={refresh} />

      <QueryState
        query={query}
        isEmpty={(all) => all.filter((m) => m.status !== "revoked").length === 0}
        empty={<EmptyBlock title={t("circle.empty")}>{t("circle.emptyBody")}</EmptyBlock>}
      >
        {(all) => (
          <ul className="space-y-4">
            {all.filter((m) => m.status !== "revoked").map((m) => (
              <li key={m.id}>
                <Card>
                  <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                    <div className="min-w-0">
                      <CardTitle as="h2" className="text-2xl">{m.name}</CardTitle>
                      <CardDescription className="text-base">
                        {m.status === "active" && m.respondedAt
                          ? t("circle.member.joined", { relationship: m.relationshipLabel, date: formatDate(m.respondedAt) })
                          : t("circle.member.invited", { relationship: m.relationshipLabel, date: formatDate(m.invitedAt) })}
                      </CardDescription>
                    </div>
                    <Badge variant={m.status === "active" ? "default" : "secondary"}>{m.status === "active" ? t("circle.badge.active") : t("circle.badge.waiting")}</Badge>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <ul className="space-y-3">
                      {PERMISSION_FIELDS.map(([field, labelKey]) => {
                        const id = `${m.id}-${field}`;
                        return (
                          <li key={field} className="flex items-center justify-between gap-4">
                            <Label htmlFor={id} className="text-lg">{t(labelKey)}</Label>
                            <Switch id={id} checked={m[field]} disabled={busyId === m.id} onCheckedChange={(v) => toggle(m, field, v)} />
                          </li>
                        );
                      })}
                    </ul>
                    <ConfirmAction
                      trigger={<Button variant="outline" aria-label={t("circle.removeAria", { name: m.name })}>{t("circle.remove", { name: m.name })}</Button>}
                      title={t("circle.remove.title", { name: m.name })}
                      description={t("circle.remove.body", { name: m.name })}
                      confirmLabel={t("circle.remove.yes")}
                      cancelLabel={t("circle.remove.no")}
                      destructive
                      onConfirm={() => remove(m)}
                    />
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}
