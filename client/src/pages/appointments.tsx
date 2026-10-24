import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarPlus, ArrowRight, MessageCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import StatusBadge from "@/components/status-badge";
import SlotPicker from "@/components/slot-picker";
import ConfirmAction from "@/components/confirm-action";
import QueryState, { EmptyBlock, LoadingBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatRelativeDay } from "@/lib/format";

interface Pairing {
  id: string;
  status: string;
  doctor: { id: string; name: string; specialty: string } | null;
}

interface Appointment {
  id: string;
  pairingRequestId: string;
  type: string;
  reason: string;
  scheduledAt: string;
  status: string;
  doctor: { id: string; name: string; specialty: string } | null;
}

interface SlotsResponse {
  doctorTimezone: string | null;
  hasPublishedAvailability: boolean;
  slots: string[];
}

const TYPES = ["Video Visit", "Phone Call", "In-Person"];

const STATUS_EXPLANATION: Record<string, string> = {
  requested: "Waiting for the doctor to confirm this time.",
  confirmed: "The doctor has confirmed this time.",
};

function useSlots(pairingId: string, enabled: boolean) {
  return useQuery<SlotsResponse>({
    queryKey: [`/api/appointments/slots?pairingRequestId=${pairingId}&days=21`],
    enabled: enabled && !!pairingId,
    staleTime: 0,
  });
}

function NoTimesPublished({ doctorName, pairingId }: { doctorName: string; pairingId: string }) {
  return (
    <div className="rounded-xl border-2 border-input p-5">
      <p className="font-semibold">{doctorName} hasn't published any appointment times yet.</p>
      <p className="mt-1 text-muted-foreground">You can send a message to ask when they are free.</p>
      <Button asChild className="mt-4">
        <Link href={`/chat/${pairingId}`}>
          <MessageCircle aria-hidden="true" /> Message {doctorName}
        </Link>
      </Button>
    </div>
  );
}

function BookDialog({
  open, onOpenChange, connected, initialPairingId,
}: { open: boolean; onOpenChange: (v: boolean) => void; connected: Pairing[]; initialPairingId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pairingId, setPairingId] = useState(initialPairingId || (connected.length === 1 ? connected[0].id : ""));
  const [type, setType] = useState(TYPES[0]);
  const [reason, setReason] = useState("");
  const [slot, setSlot] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slotsQuery = useSlots(pairingId, open);
  const doctor = connected.find((p) => p.id === pairingId)?.doctor;

  useEffect(() => {
    if (!pairingId && connected.length === 1) setPairingId(connected[0].id);
  }, [connected, pairingId]);

  async function book() {
    setError(null);
    if (!pairingId) return setError("Choose which doctor you want to see.");
    if (!slot) return setError("Choose a day and a time.");
    if (reason.trim().length < 3) return setError("Tell the doctor briefly what the visit is about.");
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/appointments", { pairingRequestId: pairingId, type, reason: reason.trim(), scheduledAt: slot });
      queryClient.invalidateQueries({ queryKey: ["/api/appointments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({ title: "Request sent", description: `${doctor?.name ?? "The doctor"} still needs to confirm this time.` });
      onOpenChange(false);
      setReason("");
      setSlot(null);
    } catch (err: any) {
      setError(err.message);
      setSlot(null);
      slotsQuery.refetch();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-2xl">Book a visit</DialogTitle>
          <DialogDescription className="text-base">Choose a time your doctor has set aside. They will confirm it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {connected.length !== 1 && (
            <div className="space-y-2">
              <Label htmlFor="book-doctor" className="text-base">Which doctor?</Label>
              <NativeSelect id="book-doctor" value={pairingId} onChange={(e) => { setPairingId(e.target.value); setSlot(null); }}>
                <option value="">Choose a doctor</option>
                {connected.map((p) => (
                  <option key={p.id} value={p.id}>{p.doctor?.name} — {p.doctor?.specialty}</option>
                ))}
              </NativeSelect>
            </div>
          )}
          {connected.length === 1 && <p className="text-lg">With <strong>{doctor?.name}</strong> <span className="text-muted-foreground">({doctor?.specialty})</span></p>}

          <div className="space-y-2">
            <Label htmlFor="book-type" className="text-base">How would you like to meet?</Label>
            <NativeSelect id="book-type" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </NativeSelect>
            {type === "Video Visit" && (
              <p className="text-sm text-muted-foreground">
                Video calling is not built into Avela yet. Your doctor will contact you by phone or send you a link at the time of your visit.
              </p>
            )}
          </div>

          {pairingId && (
            <div className="space-y-2">
              <p className="text-base font-medium">When?</p>
              <QueryState query={slotsQuery} loadingLabel="Finding available times">
                {(data) =>
                  !data.hasPublishedAvailability ? (
                    <NoTimesPublished doctorName={doctor?.name ?? "This doctor"} pairingId={pairingId} />
                  ) : data.slots.length === 0 ? (
                    <EmptyBlock title="No open times in the next three weeks">
                      <Link href={`/chat/${pairingId}`} className="text-primary underline">Message {doctor?.name}</Link> to ask about other times.
                    </EmptyBlock>
                  ) : (
                    <SlotPicker slots={data.slots} value={slot} onChange={setSlot} doctorTimezone={data.doctorTimezone} doctorName={doctor?.name ?? "The doctor"} />
                  )
                }
              </QueryState>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="book-reason" className="text-base">What is the visit about?</Label>
            <Textarea id="book-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: follow-up on my cough" rows={3} aria-describedby={error ? "book-error" : undefined} />
          </div>

          {error && (
            <p id="book-error" role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>
          )}
          <Button size="lg" className="w-full" onClick={book} disabled={submitting}>
            {submitting ? "Sending…" : "Request this time"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RescheduleDialog({ appointment, onClose }: { appointment: Appointment | null; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [slot, setSlot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const slotsQuery = useSlots(appointment?.pairingRequestId ?? "", !!appointment);

  useEffect(() => {
    setSlot(null);
    setError(null);
  }, [appointment?.id]);

  async function move() {
    if (!appointment || !slot) return setError("Choose a new day and time first.");
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest("PATCH", `/api/appointments/${appointment.id}/reschedule`, { scheduledAt: slot });
      queryClient.invalidateQueries({ queryKey: ["/api/appointments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({ title: "New time requested", description: `${appointment.doctor?.name ?? "The doctor"} needs to confirm it.` });
      onClose();
    } catch (err: any) {
      setError(err.message);
      setSlot(null);
      slotsQuery.refetch();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!appointment} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-2xl">Change the time</DialogTitle>
          <DialogDescription className="text-base">
            Now: {appointment && formatRelativeDay(appointment.scheduledAt)}. Your old time stays yours until the new one is saved, and the doctor will need to confirm the new time.
          </DialogDescription>
        </DialogHeader>
        <QueryState query={slotsQuery} loadingLabel="Finding available times">
          {(data) =>
            data.slots.length === 0 ? (
              <EmptyBlock title="No other open times in the next three weeks" />
            ) : (
              <SlotPicker slots={data.slots} value={slot} onChange={setSlot} doctorTimezone={data.doctorTimezone} doctorName={appointment?.doctor?.name ?? "The doctor"} />
            )
          }
        </QueryState>
        {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
        <Button size="lg" onClick={move} disabled={submitting || !slot}>{submitting ? "Saving…" : "Request this new time"}</Button>
      </DialogContent>
    </Dialog>
  );
}

export default function Appointments() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const params = new URLSearchParams(window.location.search);
  const [bookOpen, setBookOpen] = useState(!!params.get("book"));
  const [rescheduling, setRescheduling] = useState<Appointment | null>(null);

  const pairingsQuery = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });
  const appointmentsQuery = useQuery<Appointment[]>({ queryKey: ["/api/appointments"] });
  const connected = (pairingsQuery.data || []).filter((p) => p.status === "accepted");

  async function cancel(id: string) {
    try {
      await apiRequest("PATCH", `/api/appointments/${id}/cancel`);
      queryClient.invalidateQueries({ queryKey: ["/api/appointments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({ title: "Appointment cancelled", description: "That time is free again. You can book another whenever you like." });
    } catch (err: any) {
      toast({ title: "We couldn't cancel it", description: err.message, variant: "destructive" });
      throw err;
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Appointments</h1>
          <p className="text-muted-foreground">Your visits with your doctors.</p>
        </div>
        {connected.length > 0 && (
          <Button size="lg" onClick={() => setBookOpen(true)}>
            <CalendarPlus aria-hidden="true" /> Book a visit
          </Button>
        )}
      </div>

      {pairingsQuery.isSuccess && connected.length === 0 && (
        <EmptyBlock
          title="You need a doctor first"
          action={<Button asChild size="lg"><Link href="/symptoms">Find a doctor</Link></Button>}
        >
          Once a doctor accepts your request, you can book a time with them here.
        </EmptyBlock>
      )}

      <QueryState
        query={appointmentsQuery}
        isEmpty={(a) => a.length === 0}
        empty={connected.length > 0 ? <EmptyBlock title="No visits yet">When you book one, it will appear here.</EmptyBlock> : null}
      >
        {(all) => {
          const upcoming = all
            .filter((a) => a.status === "requested" || a.status === "confirmed")
            .sort((a, b) => +new Date(a.scheduledAt) - +new Date(b.scheduledAt));
          const past = all.filter((a) => a.status === "completed" || a.status === "cancelled");
          return (
            <>
              {upcoming.length > 0 && (
                <section aria-labelledby="upcoming-heading" className="space-y-4">
                  <h2 id="upcoming-heading" className="text-xl font-semibold">Coming up</h2>
                  <div className="grid gap-4">
                    {upcoming.map((a) => (
                      <Card key={a.id}>
                        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                          <div>
                            <CardTitle as="h3" className="text-xl">{formatRelativeDay(a.scheduledAt)}</CardTitle>
                            <CardDescription className="text-base">{a.type} with {a.doctor?.name}</CardDescription>
                          </div>
                          <StatusBadge kind="appointment" status={a.status} />
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <p className="text-muted-foreground">{STATUS_EXPLANATION[a.status]}</p>
                          <p>{a.reason}</p>
                          <div className="flex flex-wrap gap-3">
                            <Button asChild variant="outline">
                              <Link href={`/appointments/${a.id}`}>Get ready <ArrowRight aria-hidden="true" /></Link>
                            </Button>
                            <Button variant="outline" onClick={() => setRescheduling(a)}>Change time</Button>
                            <ConfirmAction
                              trigger={<Button variant="outline">Cancel visit</Button>}
                              title="Cancel this appointment?"
                              description={`Your ${a.type.toLowerCase()} with ${a.doctor?.name} on ${formatRelativeDay(a.scheduledAt)} will be cancelled. You can book another time afterwards.`}
                              confirmLabel="Yes, cancel it"
                              cancelLabel="No, keep my visit"
                              destructive
                              onConfirm={() => cancel(a.id)}
                            />
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </section>
              )}
              {past.length > 0 && (
                <section aria-labelledby="past-heading" className="space-y-4">
                  <h2 id="past-heading" className="text-xl font-semibold">Earlier</h2>
                  <div className="grid gap-4">
                    {past.map((a) => (
                      <Card key={a.id}>
                        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                          <div>
                            <CardTitle as="h3" className="text-lg">{formatRelativeDay(a.scheduledAt)}</CardTitle>
                            <CardDescription className="text-base">{a.type} with {a.doctor?.name}</CardDescription>
                          </div>
                          <StatusBadge kind="appointment" status={a.status} />
                        </CardHeader>
                        <CardContent>
                          <Button asChild variant="outline"><Link href={`/appointments/${a.id}`}>See summary</Link></Button>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </section>
              )}
            </>
          );
        }}
      </QueryState>

      {pairingsQuery.isLoading && <LoadingBlock label="Loading your doctors" />}

      {bookOpen && <BookDialog open={bookOpen} onOpenChange={setBookOpen} connected={connected} initialPairingId={params.get("book") || ""} />}
      <RescheduleDialog appointment={rescheduling} onClose={() => setRescheduling(null)} />
    </div>
  );
}
