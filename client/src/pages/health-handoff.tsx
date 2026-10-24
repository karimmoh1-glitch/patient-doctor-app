import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { HeartHandshake, Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDate, formatRelativeDay } from "@/lib/format";

interface Medication { id: string; name: string; instructions: string; active: boolean }
interface Appointment { id: string; type: string; scheduledAt: string; status: string; doctor: { name: string } | null }
interface Prescription { id: string; medicationName: string; instructions: string; status: string }
interface Document { id: string; title: string; category: string; createdAt: string }
interface Pairing { id: string; status: string; doctor: { name: string } | null }
interface CareCircleMember { id: string; name: string; status: string }

const CATEGORIES = [
  { key: "medications", label: "Current medications" },
  { key: "appointments", label: "Recent & upcoming appointments" },
  { key: "prescriptions", label: "Prescriptions" },
  { key: "documents", label: "Documents" },
] as const;

type CategoryKey = (typeof CATEGORIES)[number]["key"];

export default function HealthHandoff() {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Record<CategoryKey, boolean>>({
    medications: true, appointments: true, prescriptions: true, documents: false,
  });
  const [recipient, setRecipient] = useState<string>("");
  const [sharing, setSharing] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const { data: medications } = useQuery<Medication[]>({ queryKey: ["/api/medications"] });
  const { data: appointments } = useQuery<Appointment[]>({ queryKey: ["/api/appointments"] });
  const { data: prescriptions } = useQuery<Prescription[]>({ queryKey: ["/api/prescriptions"] });
  const { data: documents } = useQuery<Document[]>({ queryKey: ["/api/documents"] });
  const { data: pairings } = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });
  const { data: careCircle } = useQuery<CareCircleMember[]>({ queryKey: ["/api/care-circle"] });

  const recipients = [
    ...(pairings || []).filter((p) => p.status === "accepted").map((p) => ({ id: `doctor:${p.id}`, label: p.doctor?.name || "Doctor" })),
    ...(careCircle || []).filter((m) => m.status === "active").map((m) => ({ id: `caregiver:${m.id}`, label: m.name })),
  ];

  async function share() {
    if (!recipient) {
      toast({ title: "Choose who to share with", variant: "destructive" });
      return;
    }
    const categories = CATEGORIES.filter((c) => selected[c.key]).map((c) => c.label);
    if (categories.length === 0) {
      toast({ title: "Select at least one category", variant: "destructive" });
      return;
    }
    setSharing(true);
    try {
      const recipientLabel = recipients.find((r) => r.id === recipient)?.label || "recipient";
      const res = await apiRequest("POST", "/api/health-summary/share", { recipientLabel, categories });
      const data = await res.json();
      toast({ title: "Summary shared", description: data.message });
    } catch (err: any) {
      toast({ title: "Couldn't share summary", description: err.message, variant: "destructive" });
    } finally {
      setSharing(false);
    }
  }

  if (reviewing) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold"><HeartHandshake className="h-5 w-5 text-primary" /> Health Summary</h1>
          <p className="text-sm text-muted-foreground">Review before sharing. This summary only includes what you selected.</p>
        </div>

        <Card>
          <CardContent className="space-y-5 p-6">
            {selected.medications && (
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Current medications</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {(medications || []).filter((m) => m.active).map((m) => <li key={m.id}>{m.name} — {m.instructions}</li>)}
                  {(medications || []).filter((m) => m.active).length === 0 && <li className="text-muted-foreground">None active</li>}
                </ul>
              </div>
            )}
            {selected.appointments && (
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Appointments</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {(appointments || []).slice(0, 5).map((a) => <li key={a.id}>{a.type} with {a.doctor?.name} — {formatRelativeDay(a.scheduledAt)} ({a.status})</li>)}
                  {(appointments || []).length === 0 && <li className="text-muted-foreground">None recorded</li>}
                </ul>
              </div>
            )}
            {selected.prescriptions && (
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Prescriptions</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {(prescriptions || []).map((p) => <li key={p.id}>{p.medicationName} — {p.instructions} ({p.status})</li>)}
                  {(prescriptions || []).length === 0 && <li className="text-muted-foreground">None recorded</li>}
                </ul>
              </div>
            )}
            {selected.documents && (
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Documents</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {(documents || []).map((d) => <li key={d.id}>{d.title} — {d.category} ({formatDate(d.createdAt)})</li>)}
                  {(documents || []).length === 0 && <li className="text-muted-foreground">None uploaded</li>}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-3">
          <Select value={recipient} onValueChange={setRecipient}>
            <SelectTrigger><SelectValue placeholder="Share with…" /></SelectTrigger>
            <SelectContent>
              {recipients.map((r) => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setReviewing(false)}>Back</Button>
            <Button disabled={sharing} onClick={share} className="gap-1"><Send className="h-4 w-4" /> Share summary</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><HeartHandshake className="h-5 w-5 text-primary" /> Health Handoff</h1>
        <p className="text-sm text-muted-foreground">Prepare a summary of your own information to share with a new provider or someone in your Care Circle.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What should the summary include?</CardTitle>
          <CardDescription>Choose only what's relevant — nothing is shared automatically.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {CATEGORIES.map((c) => (
            <label key={c.key} className="flex items-center gap-2 text-sm">
              <Checkbox checked={selected[c.key]} onCheckedChange={(checked) => setSelected((s) => ({ ...s, [c.key]: checked === true }))} />
              {c.label}
            </label>
          ))}
        </CardContent>
      </Card>

      <Button onClick={() => setReviewing(true)}>Review summary</Button>
    </div>
  );
}
