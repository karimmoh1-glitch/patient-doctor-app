import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, MessageCircle, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import StatusBadge from "@/components/status-badge";
import QueryState from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatRelativeDay } from "@/lib/format";

interface DoctorPairing {
  id: string;
  status: string;
  patientUserId: string;
  patientName: string;
  symptomReportId: string | null;
}

interface Appointment {
  id: string;
  pairingRequestId: string;
  type: string;
  reason: string;
  scheduledAt: string;
  status: string;
}

interface Prescription {
  id: string;
  pairingRequestId: string;
  medicationName: string;
  instructions: string;
  status: string;
}

function CompleteAppointmentDialog({ appointment, onDone }: { appointment: Appointment; onDone: () => void }) {
  const { toast } = useToast();
  const [notes, setNotes] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(false);

  async function submit() {
    if (!notes.trim()) {
      toast({ title: "Add a visit note", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest("POST", `/api/appointments/${appointment.id}/complete`, {
        doctorNotes: notes.trim(),
        followUpInstructions: followUp.trim() || undefined,
        followUpDate: followUpDate ? new Date(followUpDate).toISOString() : undefined,
      });
      toast({ title: "Visit completed" });
      setOpen(false);
      onDone();
    } catch (err: any) {
      toast({ title: "Couldn't complete visit", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">Complete visit</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Complete visit</DialogTitle>
          <DialogDescription>This becomes the patient's visit summary and drives their follow-up tasks. Demo clinical documentation.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Visit notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Summary of the visit…" />
          </div>
          <div className="space-y-1.5">
            <Label>Follow-up instructions (optional)</Label>
            <Textarea value={followUp} onChange={(e) => setFollowUp(e.target.value)} rows={2} placeholder="e.g. Continue current medication and follow up in 2 weeks" />
          </div>
          <div className="space-y-1.5">
            <Label>Follow-up date (optional)</Label>
            <Input type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button disabled={submitting} onClick={submit}>Complete visit</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewPrescriptionDialog({ pairingId, onDone }: { pairingId: string; onDone: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [medicationName, setMedicationName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [frequencyPerDay, setFrequencyPerDay] = useState("1");
  const [durationDays, setDurationDays] = useState("");
  const [refillsAllowed, setRefillsAllowed] = useState("0");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!medicationName.trim() || !instructions.trim()) {
      toast({ title: "Fill in medication name and instructions", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/prescriptions", {
        pairingRequestId: pairingId,
        medicationName: medicationName.trim(),
        instructions: instructions.trim(),
        frequencyPerDay: Number(frequencyPerDay),
        durationDays: durationDays ? Number(durationDays) : undefined,
        refillsAllowed: Number(refillsAllowed),
      });
      toast({ title: "Prescription saved in Avela", description: "It has not been sent to a pharmacy." });
      setOpen(false);
      setMedicationName(""); setInstructions(""); setDurationDays("");
      onDone();
    } catch (err: any) {
      toast({ title: "Couldn't create prescription", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1"><Plus className="h-3.5 w-3.5" /> New prescription</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a prescription</DialogTitle>
          <DialogDescription>This records the prescription for the patient in Avela. It is not sent to any pharmacy, and Avela does not check doses or interactions. Prescribe through your usual system as well.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Medication name</Label>
            <Input value={medicationName} onChange={(e) => setMedicationName(e.target.value)} placeholder="e.g. Demo Med A" />
          </div>
          <div className="space-y-1.5">
            <Label>Instructions</Label>
            <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} placeholder="e.g. Take one tablet by mouth, as directed" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Times per day</Label>
              <Select value={frequencyPerDay} onValueChange={setFrequencyPerDay}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Duration (days)</Label>
              <Input type="number" min={1} value={durationDays} onChange={(e) => setDurationDays(e.target.value)} placeholder="30" />
            </div>
            <div className="space-y-1.5">
              <Label>Refills</Label>
              <Input type="number" min={0} value={refillsAllowed} onChange={(e) => setRefillsAllowed(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={submitting} onClick={submit}>Create prescription</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


interface SharedRecords {
  granted: string[];
  medications?: { name: string; instructions: string; scheduleTimes: string[] }[];
  documents?: { id: string; title: string; category: string; hasFile: boolean }[];
  appointments?: { type: string; scheduledAt: string; status: string; specialty: string | null }[];
  prescriptions?: { medicationName: string; status: string }[];
}

// Only what this patient has chosen to share with this doctor, only while the
// connection lasts. Each time this loads it is recorded in the patient's
// access log — so it is fetched when the tab is opened, not in the background.
function SharedByPatient({ pairingId }: { pairingId: string }) {
  const query = useQuery<SharedRecords>({ queryKey: [`/api/pairings/${pairingId}/shared-records`], staleTime: 0 });
  return (
    <QueryState query={query}>
      {(d) =>
        d.granted.length === 0 ? (
          <p className="rounded-xl border-2 border-input p-4 text-lg">This patient hasn't shared anything beyond your messages and what they wrote when they asked for help.</p>
        ) : (
          <div className="space-y-4">
            <p className="text-muted-foreground">Shared with you: {d.granted.join(", ")}. Opening this is recorded in the patient's access log.</p>
            {d.medications && (
              <Card><CardHeader><CardTitle as="h3" className="text-lg">Current medicines</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {d.medications.length === 0 && <p className="text-muted-foreground">None being tracked.</p>}
                  {d.medications.map((m, i) => <p key={i}><strong>{m.name}</strong> — {m.instructions} <span className="text-muted-foreground">({m.scheduleTimes.join(", ")})</span></p>)}
                </CardContent></Card>
            )}
            {d.documents && (
              <Card><CardHeader><CardTitle as="h3" className="text-lg">Documents</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {d.documents.length === 0 && <p className="text-muted-foreground">None saved.</p>}
                  {d.documents.map((x) => <p key={x.id}>{x.title} <span className="text-muted-foreground">· {x.category}</span></p>)}
                </CardContent></Card>
            )}
            {d.appointments && (
              <Card><CardHeader><CardTitle as="h3" className="text-lg">Visits with other doctors</CardTitle><CardDescription>Dates and kind only. No reasons or notes.</CardDescription></CardHeader>
                <CardContent className="space-y-2">
                  {d.appointments.length === 0 && <p className="text-muted-foreground">None.</p>}
                  {d.appointments.map((a, i) => <p key={i}>{formatRelativeDay(a.scheduledAt)} · {a.type}{a.specialty ? ` · ${a.specialty}` : ""} <span className="text-muted-foreground">({a.status})</span></p>)}
                </CardContent></Card>
            )}
            {d.prescriptions && (
              <Card><CardHeader><CardTitle as="h3" className="text-lg">Prescribed by other doctors</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {d.prescriptions.length === 0 && <p className="text-muted-foreground">None.</p>}
                  {d.prescriptions.map((p, i) => <p key={i}>{p.medicationName} <span className="text-muted-foreground">({p.status})</span></p>)}
                </CardContent></Card>
            )}
          </div>
        )
      }
    </QueryState>
  );
}

// What the patient wrote when they asked for help. Fetched only on request,
// because each read is recorded in the patient's access log.
function WhatThePatientWrote({ pairingId }: { pairingId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest("GET", `/api/pairings/${pairingId}/symptom-report`);
      setText((await res.json()).symptomText);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="space-y-2">
      {text === null ? (
        <Button variant="outline" onClick={load} disabled={loading}>{loading ? "Opening…" : "Show what they wrote when they asked for help"}</Button>
      ) : (
        <p className="rounded-xl border-2 border-input bg-card p-4 text-lg"><strong>They wrote:</strong> {text}</p>
      )}
      {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
    </div>
  );
}

export default function DoctorPatientWorkspace({ pairingId }: { pairingId: string }) {
  const queryClient = useQueryClient();
  const { data: pairings } = useQuery<DoctorPairing[]>({ queryKey: ["/api/pairings/doctor"] });
  const { data: appointments } = useQuery<Appointment[]>({ queryKey: ["/api/appointments/doctor"] });
  const { data: prescriptions } = useQuery<Prescription[]>({ queryKey: ["/api/prescriptions/doctor"] });

  const pairing = pairings?.find((p) => p.id === pairingId);
  const myAppointments = (appointments || []).filter((a) => a.pairingRequestId === pairingId);
  const myPrescriptions = (prescriptions || []).filter((p) => p.pairingRequestId === pairingId);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["/api/appointments/doctor"] });
    queryClient.invalidateQueries({ queryKey: ["/api/prescriptions/doctor"] });
  }

  async function confirmAppointment(id: string) {
    await apiRequest("PATCH", `/api/appointments/${id}/confirm`);
    refresh();
  }

  if (!pairing) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/doctor/patients">
        <Button variant="ghost" size="sm" className="-ml-3 gap-1"><ArrowLeft className="h-4 w-4" /> Back to patients</Button>
      </Link>

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{pairing.patientName}</h1>
        <Link href={`/chat/${pairing.id}?with=${encodeURIComponent(pairing.patientName)}`}>
          <Button size="sm" variant="outline" className="gap-1"><MessageCircle className="h-3.5 w-3.5" /> Message</Button>
        </Link>
      </div>

      <WhatThePatientWrote pairingId={pairing.id} />

      <Tabs defaultValue="appointments">
        <TabsList>
          <TabsTrigger value="appointments">Appointments</TabsTrigger>
          <TabsTrigger value="prescriptions">Prescriptions</TabsTrigger>
          <TabsTrigger value="shared">Shared by patient</TabsTrigger>
        </TabsList>

        <TabsContent value="shared" className="space-y-3 pt-4">
          <SharedByPatient pairingId={pairing.id} />
        </TabsContent>

        <TabsContent value="appointments" className="space-y-3 pt-4">
          {myAppointments.length === 0 && <p className="text-sm text-muted-foreground">No appointments with this patient yet.</p>}
          {myAppointments.map((a) => (
            <Card key={a.id}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="text-base">{a.type}</CardTitle>
                  <CardDescription>{formatRelativeDay(a.scheduledAt)}</CardDescription>
                </div>
                <StatusBadge kind="appointment" status={a.status} />
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-2">
                <p className="line-clamp-1 text-sm text-muted-foreground">{a.reason}</p>
                <div className="flex shrink-0 gap-2">
                  {a.status === "requested" && <Button size="sm" variant="outline" onClick={() => confirmAppointment(a.id)}>Confirm</Button>}
                  {(a.status === "requested" || a.status === "confirmed") && <CompleteAppointmentDialog appointment={a} onDone={refresh} />}
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="prescriptions" className="space-y-3 pt-4">
          <NewPrescriptionDialog pairingId={pairing.id} onDone={refresh} />
          {myPrescriptions.length === 0 && <p className="text-sm text-muted-foreground">No prescriptions written for this patient yet.</p>}
          {myPrescriptions.map((p) => (
            <Card key={p.id}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0">
                <CardTitle className="text-base">{p.medicationName}</CardTitle>
                <StatusBadge kind="prescription" status={p.status} />
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{p.instructions}</p>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
