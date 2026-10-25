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
import { formatRelativeDay, timeAgo } from "@/lib/format";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { specialtyLabel } from "@/lib/labels";
import ConfirmAction from "@/components/confirm-action";
import PrescriptionDialog, { type PrescriptionRecord } from "@/components/prescription-form";
import { Ltr } from "@/components/ltr";
import { appointmentTypeLabel } from "@/lib/labels";

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

function CompleteAppointmentDialog({ appointment, onDone }: { appointment: Appointment; onDone: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [notes, setNotes] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(false);

  async function submit() {
    if (!notes.trim()) {
      toast({ title: t("dws.complete.needNote"), variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest("POST", `/api/appointments/${appointment.id}/complete`, {
        doctorNotes: notes.trim(),
        followUpInstructions: followUp.trim() || undefined,
        followUpDate: followUpDate ? new Date(followUpDate).toISOString() : undefined,
      });
      toast({ title: t("dws.complete.done") });
      setOpen(false);
      onDone();
    } catch (err: any) {
      toast({ title: t("dws.complete.failed"), description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">{t("dws.complete.button")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dws.complete.button")}</DialogTitle>
          <DialogDescription>{t("dws.complete.intro")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("dws.complete.notes")}</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder={t("dws.complete.notesPlaceholder")} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("dws.complete.followUp")}</Label>
            <Textarea value={followUp} onChange={(e) => setFollowUp(e.target.value)} rows={2} placeholder={t("dws.complete.followUpPlaceholder")} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("dws.complete.followUpDate")}</Label>
            <Input type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button disabled={submitting} onClick={submit}>{t("dws.complete.button")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PrescriptionCard({ p, pairingId, onChanged }: { p: PrescriptionRecord; pairingId: string; onChanged: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [history, setHistory] = useState<{ id: string; event: string; createdAt: string }[] | null>(null);

  async function authorize() {
    try {
      await apiRequest("POST", `/api/prescriptions/${p.id}/authorize`, { confirm: true });
      toast({ title: t("dws.rx.authorized"), description: t("dws.rx.authorizedBody") });
      onChanged();
    } catch (err: any) {
      toast({ title: t("dws.rx.authorizeFailed"), description: err.message, variant: "destructive" });
      throw err;
    }
  }
  async function cancel() {
    try {
      await apiRequest("PATCH", `/api/prescriptions/${p.id}/cancel`);
      onChanged();
    } catch (err: any) {
      toast({ title: t("dws.rx.cancelFailed"), description: err.message, variant: "destructive" });
      throw err;
    }
  }
  async function loadHistory() {
    const res = await apiRequest("GET", `/api/prescriptions/${p.id}/history`);
    setHistory(await res.json());
  }

  const isDraft = p.status === "draft";
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="text-base">{p.medicationName}</CardTitle>
          <CardDescription>
            <Ltr>{[p.strength, p.dose].filter(Boolean).join(" · ")}</Ltr>
          </CardDescription>
        </div>
        <StatusBadge kind="prescription" status={p.status} />
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{p.instructions}</p>
        {isDraft && <p className="rounded-lg bg-sand p-3 text-sm text-sand-foreground">{t("dws.rx.draftNote")}</p>}
        {!isDraft && p.status === "active" && <p className="text-sm text-muted-foreground">{t("rx.notSentShort")}</p>}
        <div className="flex flex-wrap gap-2">
          {isDraft && (
            <>
              <PrescriptionDialog pairingId={pairingId} existing={p} onDone={onChanged} trigger={<Button size="sm" variant="outline">{t("dws.rx.editDraft")}</Button>} />
              <ConfirmAction
                trigger={<Button size="sm">{t("dws.rx.authorize")}</Button>}
                title={t("dws.rx.authorize.title", { name: p.medicationName })}
                description={t("dws.rx.authorize.body")}
                confirmLabel={t("dws.rx.authorize.yes")}
                cancelLabel={t("dws.rx.authorize.no")}
                onConfirm={authorize}
              />
            </>
          )}
          {(isDraft || p.status === "active") && (
            <ConfirmAction
              trigger={<Button size="sm" variant="outline">{isDraft ? t("dws.rx.discard") : t("dws.rx.cancel")}</Button>}
              title={isDraft ? t("dws.rx.discard.title") : t("dws.rx.cancel.title", { name: p.medicationName })}
              description={isDraft ? t("dws.rx.discard.body") : t("dws.rx.cancel.body")}
              confirmLabel={isDraft ? t("dws.rx.discard.yes") : t("dws.rx.cancel.yes")}
              cancelLabel={t("dws.rx.keep")}
              onConfirm={cancel}
            />
          )}
          <Button size="sm" variant="ghost" onClick={loadHistory}>{t("dws.rx.history")}</Button>
        </div>
        {history && (
          <ul className="space-y-1 text-sm text-muted-foreground" aria-label={t("dws.rx.history")}>
            {history.map((h) => <li key={h.id}>{t(`rx.event.${h.event}` as MessageKey)} · {timeAgo(h.createdAt)}</li>)}
          </ul>
        )}
      </CardContent>
    </Card>
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
  const { t } = useI18n();
  const query = useQuery<SharedRecords>({ queryKey: [`/api/pairings/${pairingId}/shared-records`], staleTime: 0 });
  return (
    <QueryState query={query}>
      {(d) =>
        d.granted.length === 0 ? (
          <p className="rounded-xl border-2 border-input p-4 text-lg">{t("dws.shared.nothing")}</p>
        ) : (
          <div className="space-y-4">
            <p className="text-muted-foreground">{t("dws.shared.with", { list: d.granted.join(", ") })}</p>
            {d.medications && (
              <Card><CardHeader><CardTitle as="h3" className="text-lg">{t("dws.shared.meds")}</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {d.medications.length === 0 && <p className="text-muted-foreground">{t("dws.shared.noneTracked")}</p>}
                  {d.medications.map((m, i) => <p key={i}><strong>{m.name}</strong> — {m.instructions} <span className="text-muted-foreground">({m.scheduleTimes.join(", ")})</span></p>)}
                </CardContent></Card>
            )}
            {d.documents && (
              <Card><CardHeader><CardTitle as="h3" className="text-lg">{t("dws.shared.docs")}</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {d.documents.length === 0 && <p className="text-muted-foreground">{t("dws.shared.noneSaved")}</p>}
                  {d.documents.map((x) => <p key={x.id}>{x.title} <span className="text-muted-foreground">· {x.category}</span></p>)}
                </CardContent></Card>
            )}
            {d.appointments && (
              <Card><CardHeader><CardTitle as="h3" className="text-lg">{t("dws.shared.visits")}</CardTitle><CardDescription>{t("dws.shared.visitsNote")}</CardDescription></CardHeader>
                <CardContent className="space-y-2">
                  {d.appointments.length === 0 && <p className="text-muted-foreground">{t("common.none")}</p>}
                  {d.appointments.map((a, i) => <p key={i}>{formatRelativeDay(a.scheduledAt)} · {appointmentTypeLabel(t, a.type)}{a.specialty ? ` · ${specialtyLabel(t, a.specialty)}` : ""} <span className="text-muted-foreground">({t(`status.appointment.${a.status}` as MessageKey)})</span></p>)}
                </CardContent></Card>
            )}
            {d.prescriptions && (
              <Card><CardHeader><CardTitle as="h3" className="text-lg">{t("dws.shared.otherRx")}</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {d.prescriptions.length === 0 && <p className="text-muted-foreground">{t("common.none")}</p>}
                  {d.prescriptions.map((p, i) => <p key={i}>{p.medicationName} <span className="text-muted-foreground">({t(`status.prescription.${p.status}` as MessageKey)})</span></p>)}
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
  const { t } = useI18n();
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
        <Button variant="outline" onClick={load} disabled={loading}>{loading ? t("dws.wrote.opening") : t("dws.wrote.show")}</Button>
      ) : (
        <p className="rounded-xl border-2 border-input bg-card p-4 text-lg"><strong>{t("dws.wrote.label")}</strong> {text}</p>
      )}
      {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
    </div>
  );
}

export default function DoctorPatientWorkspace({ pairingId }: { pairingId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: pairings } = useQuery<DoctorPairing[]>({ queryKey: ["/api/pairings/doctor"] });
  const { data: appointments } = useQuery<Appointment[]>({ queryKey: ["/api/appointments/doctor"] });
  const { data: prescriptions } = useQuery<PrescriptionRecord[]>({ queryKey: ["/api/prescriptions/doctor"] });

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

  if (!pairing) return <p className="text-muted-foreground">{t("common.loading")}</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/doctor/patients">
        <Button variant="ghost" size="sm" className="-ms-3 gap-1"><ArrowLeft className="h-4 w-4 flip-rtl" /> {t("dws.back")}</Button>
      </Link>

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{pairing.patientName}</h1>
        <Link href={`/chat/${pairing.id}?with=${encodeURIComponent(pairing.patientName)}`}>
          <Button size="sm" variant="outline" className="gap-1"><MessageCircle className="h-3.5 w-3.5" /> {t("dws.message")}</Button>
        </Link>
      </div>

      <WhatThePatientWrote pairingId={pairing.id} />

      <Tabs defaultValue="appointments">
        <TabsList>
          <TabsTrigger value="appointments">{t("nav.d.appointments")}</TabsTrigger>
          <TabsTrigger value="prescriptions">{t("rx.page.title")}</TabsTrigger>
          <TabsTrigger value="shared">{t("dws.tab.shared")}</TabsTrigger>
        </TabsList>

        <TabsContent value="shared" className="space-y-3 pt-4">
          <SharedByPatient pairingId={pairing.id} />
        </TabsContent>

        <TabsContent value="appointments" className="space-y-3 pt-4">
          {myAppointments.length === 0 && <p className="text-sm text-muted-foreground">{t("dws.noAppointments")}</p>}
          {myAppointments.map((a) => (
            <Card key={a.id}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="text-base">{appointmentTypeLabel(t, a.type)}</CardTitle>
                  <CardDescription>{formatRelativeDay(a.scheduledAt)}</CardDescription>
                </div>
                <StatusBadge kind="appointment" status={a.status} />
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-2">
                <p className="line-clamp-1 text-sm text-muted-foreground">{a.reason}</p>
                <div className="flex shrink-0 gap-2">
                  {a.status === "requested" && <Button size="sm" variant="outline" onClick={() => confirmAppointment(a.id)}>{t("dws.confirm")}</Button>}
                  {(a.status === "requested" || a.status === "confirmed") && <CompleteAppointmentDialog appointment={a} onDone={refresh} />}
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="prescriptions" className="space-y-3 pt-4">
          <PrescriptionDialog pairingId={pairing.id} onDone={refresh} />
          {myPrescriptions.length === 0 && <p className="text-sm text-muted-foreground">{t("dws.noPrescriptions")}</p>}
          {myPrescriptions.map((p) => <PrescriptionCard key={p.id} p={p} pairingId={pairing.id} onChanged={refresh} />)}
        </TabsContent>
      </Tabs>
    </div>
  );
}
