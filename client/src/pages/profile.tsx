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
import type { AuthUser } from "@/hooks/use-auth";

interface EmergencyProfile {
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  allergiesText: string | null;
  emergencyNotes: string | null;
}

function EmergencyInfoForm() {
  const { toast } = useToast();
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
      toast({ title: "Saved" });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="text-2xl">Emergency information</CardTitle>
        <CardDescription className="text-base">Shown on your Emergency page, so you can read it out or show it to someone helping you. Doctors and helpers do not see it unless you tell them.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ec-name" className="text-base">Who should be called in an emergency?</Label>
            <Input id="ec-name" value={form.emergencyContactName ?? ""} onChange={(e) => setForm((f) => ({ ...f, emergencyContactName: e.target.value }))} placeholder="For example: Sarah (my daughter)" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-phone" className="text-base">Their phone number</Label>
            <Input id="ec-phone" type="tel" value={form.emergencyContactPhone ?? ""} onChange={(e) => setForm((f) => ({ ...f, emergencyContactPhone: e.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-allergies" className="text-base">Allergies</Label>
            <Textarea id="ec-allergies" rows={2} value={form.allergiesText ?? ""} onChange={(e) => setForm((f) => ({ ...f, allergiesText: e.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ec-notes" className="text-base">Anything else a helper should know</Label>
            <Textarea id="ec-notes" rows={3} value={form.emergencyNotes ?? ""} onChange={(e) => setForm((f) => ({ ...f, emergencyNotes: e.target.value }))} />
          </div>
          {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
          <Button type="submit" size="lg" disabled={saving}>{saving ? "Saving…" : "Save emergency information"}</Button>
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
const GRANTS: { field: GrantField; label: string; detail: string }[] = [
  { field: "shareMedications", label: "My current medicines", detail: "The names, instructions and times of the medicines you are tracking." },
  { field: "shareDocuments", label: "My saved documents", detail: "The list of papers you saved here, and the files themselves." },
  { field: "shareAppointments", label: "When my other visits are", detail: "The date, kind and speciality of visits with your other doctors. Never what they were about or what was written." },
  { field: "shareFullHistory", label: "Everything above, plus my other prescriptions", detail: "All of the above, and the names of medicines prescribed by your other doctors." },
];

function DoctorSharing({ row }: { row: AccessRow }) {
  const { toast } = useToast();
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
      toast({ title: value ? "Now shared" : "No longer shared" });
    } catch (err: any) {
      toast({ title: "We couldn't change that", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3" className="text-xl">{row.doctorName}</CardTitle>
        <CardDescription className="text-base">{row.relationshipLabel} · connected {row.connectedSince ? formatDate(row.connectedSince) : "recently"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-lg">This doctor can always read your messages with them and what you wrote when you asked for help. You can stop all sharing from <Link href="/care-team" className="font-medium text-primary underline underline-offset-4">My doctors</Link>.</p>
        <ul className="space-y-3">
          {GRANTS.map(({ field, label, detail }) => {
            const on = row.grant?.[field] ?? false;
            const id = `${row.doctorProfileId}-${field}`;
            return (
              <li key={field} className="flex items-start justify-between gap-4 rounded-xl border-2 border-input p-4">
                <div>
                  <Label htmlFor={id} className="text-lg font-semibold">{label}</Label>
                  <p className="text-muted-foreground">{detail}</p>
                </div>
                {field === "shareFullHistory" && !on ? (
                  <ConfirmAction
                    trigger={<Switch id={id} checked={on} disabled={saving} aria-label={`${label}: ${row.doctorName}`} />}
                    title={`Share more with ${row.doctorName}?`}
                    description="This lets them see your current medicines, your documents, when your other visits are, and the names of medicines your other doctors prescribed. You can turn it off again at any time."
                    confirmLabel="Yes, share it"
                    cancelLabel="No, don't"
                    onConfirm={() => update(field, true)}
                  />
                ) : (
                  <Switch id={id} checked={on} disabled={saving} onCheckedChange={(v) => update(field, v)} aria-label={`${label}: ${row.doctorName}`} />
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
  const query = useQuery<AccessEntry[]>({ queryKey: ["/api/audit-log"] });
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="text-2xl">Who has looked at my information</CardTitle>
        <CardDescription className="text-base">A record kept by Avela, newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState query={query} isEmpty={(e) => e.length === 0} empty={<EmptyBlock title="Nothing has been recorded yet" />}>
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
                  <h3 id="who-looked" className="mb-1 text-xl font-semibold">People who looked</h3>
                  {list(access, "No doctor or helper has looked at your information yet.")}
                </section>
                <section aria-labelledby="what-changed">
                  <h3 id="what-changed" className="mb-1 text-xl font-semibold">Sharing changes</h3>
                  {list(changes, "No changes yet.")}
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
  const sharingQuery = useQuery<AccessRow[]>({ queryKey: ["/api/sharing"] });

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-semibold">Profile &amp; privacy</h1>
        <p className="text-lg text-muted-foreground">Your details, and exactly who can see what.</p>
      </div>

      <Card>
        <CardHeader><CardTitle as="h2" className="text-2xl">My details</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <dl className="space-y-3 text-lg">
            <div><dt className="font-semibold">Name</dt><dd>{user.name}</dd></div>
            <div><dt className="font-semibold">Email</dt><dd>{user.email}</dd></div>
            {user.state && <div><dt className="font-semibold">State</dt><dd>{user.state}</dd></div>}
          </dl>
          <Button asChild variant="outline"><Link href="/forgot-password">Change my password</Link></Button>
        </CardContent>
      </Card>

      <section aria-labelledby="sharing-heading" className="space-y-4">
        <div>
          <h2 id="sharing-heading" className="text-2xl font-semibold">What each doctor can see</h2>
          <p className="text-lg text-muted-foreground">Everything below is off until you turn it on. Turning a switch off takes effect straight away.</p>
        </div>
        <QueryState
          query={sharingQuery}
          isEmpty={(rows) => rows.length === 0}
          empty={<EmptyBlock title="You aren't connected with a doctor yet">Nobody can see anything about you.</EmptyBlock>}
        >
          {(rows) => <div className="space-y-4">{rows.map((row) => <DoctorSharing key={row.doctorProfileId} row={row} />)}</div>}
        </QueryState>
        <p className="text-lg">
          People you have invited to help are managed in <Link href="/care-circle" className="font-medium text-primary underline underline-offset-4">Family and helpers</Link>.
        </p>
      </section>

      <ActivityLog />
      <EmergencyInfoForm />
    </div>
  );
}
