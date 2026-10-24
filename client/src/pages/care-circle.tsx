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
const PERMISSION_FIELDS = [
  ["permissionMedicationStatus", "Whether my medicines have been marked as taken", "They see today's medicines and what I have marked. Never the doctor's notes."],
  ["permissionAppointments", "My upcoming visits", "The date, kind of visit and doctor's name."],
  ["permissionDeliveryStatus", "Pharmacy orders", "The status of any pharmacy order (example orders only in a demonstration)."],
  ["permissionDocuments", "The names of my saved documents", "The title and kind of each document, not the file."],
] as const;

type PermissionField = (typeof PERMISSION_FIELDS)[number][0];

interface InviteResult { emailSent: boolean; inviteLink: string; name: string }

function InviteDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
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
    if (!name.trim() || !email.trim() || !relationship.trim()) return setError("Please fill in all three boxes.");
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
      setError("Your device wouldn't copy it. Please select the link and copy it yourself.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl">Invitation ready</DialogTitle>
              <DialogDescription className="text-base">
                {result.emailSent
                  ? `We emailed ${result.name}. You can also send them this link yourself.`
                  : `We could not send an email, so please give ${result.name} this link yourself, by text message or in person.`}{" "}
                It works for 7 days and only once.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <Label htmlFor="invite-link" className="text-base">Invitation link</Label>
              <Input id="invite-link" readOnly value={result.inviteLink} onFocus={(e) => e.currentTarget.select()} />
              <div className="flex flex-wrap gap-3">
                <Button size="lg" onClick={copy}>{copied ? <><Check aria-hidden="true" /> Copied</> : <><Copy aria-hidden="true" /> Copy the link</>}</Button>
                <Button size="lg" variant="outline" onClick={() => close(false)}>Done</Button>
              </div>
              {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl">Invite someone to help</DialogTitle>
              <DialogDescription className="text-base">They will only see what you tick below, and they can't change anything. You can remove them at any time.</DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="inv-name" className="text-base">Their name</Label>
                <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inv-rel" className="text-base">Who are they to you?</Label>
                <Input id="inv-rel" value={relationship} onChange={(e) => setRelationship(e.target.value)} placeholder="For example: my daughter" autoComplete="off" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inv-email" className="text-base">Their email address</Label>
                <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              </div>
              <fieldset className="space-y-3">
                <legend className="mb-1 text-base font-semibold">What can they see?</legend>
                {PERMISSION_FIELDS.map(([field, label, detail]) => (
                  <label key={field} className="flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border-2 border-input p-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-6 w-6"
                      checked={permissions[field]}
                      onChange={(e) => setPermissions((p) => ({ ...p, [field]: e.target.checked }))}
                    />
                    <span><span className="block text-lg font-semibold">{label}</span><span className="block text-muted-foreground">{detail}</span></span>
                  </label>
                ))}
              </fieldset>
              {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
              <Button type="submit" size="lg" className="w-full" disabled={submitting}>{submitting ? "Creating…" : "Create the invitation"}</Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function CareCircle() {
  const { toast } = useToast();
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
      toast({ title: "We couldn't change that", description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(member: CareCircleMember) {
    try {
      await apiRequest("DELETE", `/api/care-circle/${member.id}`);
      toast({ title: `${member.name} can no longer see your information` });
      refresh();
    } catch (err: any) {
      toast({ title: "We couldn't remove them", description: err.message, variant: "destructive" });
      throw err;
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Family and helpers</h1>
          <p className="text-lg text-muted-foreground">Trusted people who can look at the parts of your care you choose. They cannot change anything or speak for you.</p>
        </div>
        <Button size="lg" onClick={() => setInviteOpen(true)}><UserPlus aria-hidden="true" /> Invite someone</Button>
      </div>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} onDone={refresh} />

      <QueryState
        query={query}
        isEmpty={(all) => all.filter((m) => m.status !== "revoked").length === 0}
        empty={<EmptyBlock title="No one can see your information yet">When you invite someone, they will appear here.</EmptyBlock>}
      >
        {(all) => (
          <ul className="space-y-4">
            {all.filter((m) => m.status !== "revoked").map((m) => (
              <li key={m.id}>
                <Card>
                  <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                    <div>
                      <CardTitle as="h2" className="text-2xl">{m.name}</CardTitle>
                      <CardDescription className="text-base">
                        {m.relationshipLabel} · {m.status === "active" && m.respondedAt ? `joined ${formatDate(m.respondedAt)}` : `invited ${formatDate(m.invitedAt)}, hasn't joined yet`}
                      </CardDescription>
                    </div>
                    <Badge variant={m.status === "active" ? "default" : "secondary"}>{m.status === "active" ? "Can see" : "Waiting"}</Badge>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <ul className="space-y-3">
                      {PERMISSION_FIELDS.map(([field, label]) => {
                        const id = `${m.id}-${field}`;
                        return (
                          <li key={field} className="flex items-center justify-between gap-4">
                            <Label htmlFor={id} className="text-lg">{label}</Label>
                            <Switch id={id} checked={m[field]} disabled={busyId === m.id} onCheckedChange={(v) => toggle(m, field, v)} />
                          </li>
                        );
                      })}
                    </ul>
                    <ConfirmAction
                      trigger={<Button variant="outline">Remove {m.name}<span className="sr-only"> from my helpers</span></Button>}
                      title={`Remove ${m.name}?`}
                      description={`${m.name} will immediately lose all access and will not be told what you shared. If you change your mind later, you can invite them again.`}
                      confirmLabel="Yes, remove them"
                      cancelLabel="No, keep them"
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
