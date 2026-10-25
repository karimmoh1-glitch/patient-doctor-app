import { appointmentTypeLabel } from "@/lib/labels";
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
import { useI18n, type MessageKey } from "@/lib/i18n";
import { specialtyLabel } from "@/lib/labels";

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

// The stored values stay as they are (the server and doctors use them); each
// one maps to a label key for display.
// Video visits are not offered: Avela has no video calling, so a patient can't
// book one. Older records of that type still display (see labels.ts).
const TYPES = ["Phone Call", "In-Person"];

const STATUS_EXPLANATION: Record<string, MessageKey> = {
  requested: "pt.appt.status.requested",
  confirmed: "pt.appt.status.confirmed",
};

function useSlots(pairingId: string, enabled: boolean) {
  return useQuery<SlotsResponse>({
    queryKey: [`/api/appointments/slots?pairingRequestId=${pairingId}&days=21`],
    enabled: enabled && !!pairingId,
    staleTime: 0,
  });
}

function NoTimesPublished({ doctorName, pairingId }: { doctorName: string; pairingId: string }) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border-2 border-input p-5">
      <p className="font-semibold">{t("pt.appt.noTimes", { name: doctorName })}</p>
      <p className="mt-1 text-muted-foreground">{t("pt.appt.noTimesHelp")}</p>
      <Button asChild className="mt-4">
        <Link href={`/chat/${pairingId}`}>
          <MessageCircle aria-hidden="true" /> {t("pt.messageName", { name: doctorName })}
        </Link>
      </Button>
    </div>
  );
}

function BookDialog({
  open, onOpenChange, connected, initialPairingId,
}: { open: boolean; onOpenChange: (v: boolean) => void; connected: Pairing[]; initialPairingId: string }) {
  const { t } = useI18n();
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
  // Names and links sit inside sentences, so their position comes from the translation.
  const [withBefore, withAfter] = t("pt.appt.with").split("{doctor}");
  const [noOpenBefore, noOpenAfter] = t("pt.appt.noOpenBody").split("{link}");

  useEffect(() => {
    if (!pairingId && connected.length === 1) setPairingId(connected[0].id);
  }, [connected, pairingId]);

  async function book() {
    setError(null);
    if (!pairingId) return setError(t("pt.appt.errDoctor"));
    if (!slot) return setError(t("pt.appt.errSlot"));
    if (reason.trim().length < 3) return setError(t("pt.appt.errReason"));
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/appointments", { pairingRequestId: pairingId, type, reason: reason.trim(), scheduledAt: slot });
      queryClient.invalidateQueries({ queryKey: ["/api/appointments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({ title: t("pt.requestSent"), description: t("pt.appt.needsConfirm", { name: doctor?.name ?? t("pt.theDoctor") }) });
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
          <DialogTitle className="text-2xl">{t("home.book")}</DialogTitle>
          <DialogDescription className="text-base">{t("pt.appt.bookDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {connected.length !== 1 && (
            <div className="space-y-2">
              <Label htmlFor="book-doctor" className="text-base">{t("pt.appt.whichDoctor")}</Label>
              <NativeSelect id="book-doctor" value={pairingId} onChange={(e) => { setPairingId(e.target.value); setSlot(null); }}>
                <option value="">{t("pt.appt.chooseDoctor")}</option>
                {connected.map((p) => (
                  <option key={p.id} value={p.id}>{p.doctor ? t("pt.nameSpecialtyDash", { name: p.doctor.name, specialty: specialtyLabel(t, p.doctor.specialty) }) : ""}</option>
                ))}
              </NativeSelect>
            </div>
          )}
          {connected.length === 1 && (
            <p className="text-lg">
              {withBefore}<strong>{doctor?.name}</strong>{withAfter} <span className="text-muted-foreground">({doctor ? specialtyLabel(t, doctor.specialty) : ""})</span>
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor="book-type" className="text-base">{t("pt.appt.howMeet")}</Label>
            <NativeSelect id="book-type" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((v) => <option key={v} value={v}>{appointmentTypeLabel(t, v)}</option>)}
            </NativeSelect>
          </div>

          {pairingId && (
            <div className="space-y-2">
              <p className="text-base font-medium">{t("pt.appt.when")}</p>
              <QueryState query={slotsQuery} loadingLabel={t("pt.appt.findingTimes")}>
                {(data) =>
                  !data.hasPublishedAvailability ? (
                    <NoTimesPublished doctorName={doctor?.name ?? t("pt.thisDoctor")} pairingId={pairingId} />
                  ) : data.slots.length === 0 ? (
                    <EmptyBlock title={t("pt.appt.noOpenTitle")}>
                      {noOpenBefore}<Link href={`/chat/${pairingId}`} className="text-primary underline">{t("pt.messageName", { name: doctor?.name ?? "" })}</Link>{noOpenAfter}
                    </EmptyBlock>
                  ) : (
                    <SlotPicker slots={data.slots} value={slot} onChange={setSlot} doctorTimezone={data.doctorTimezone} doctorName={doctor?.name ?? t("pt.theDoctor")} />
                  )
                }
              </QueryState>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="book-reason" className="text-base">{t("pt.appt.about")}</Label>
            <Textarea id="book-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("pt.appt.aboutPh")} rows={3} aria-describedby={error ? "book-error" : undefined} />
          </div>

          {error && (
            <p id="book-error" role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>
          )}
          <Button size="lg" className="w-full" onClick={book} disabled={submitting}>
            {submitting ? t("pt.sending") : t("pt.appt.request")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RescheduleDialog({ appointment, onClose }: { appointment: Appointment | null; onClose: () => void }) {
  const { t } = useI18n();
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
    if (!appointment || !slot) return setError(t("pt.appt.errNewTime"));
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest("PATCH", `/api/appointments/${appointment.id}/reschedule`, { scheduledAt: slot });
      queryClient.invalidateQueries({ queryKey: ["/api/appointments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      toast({ title: t("pt.appt.newTimeTitle"), description: t("pt.appt.newTimeBody", { name: appointment.doctor?.name ?? t("pt.theDoctor") }) });
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
          <DialogTitle className="text-2xl">{t("pt.appt.changeTitle")}</DialogTitle>
          <DialogDescription className="text-base">
            {t("pt.appt.changeDesc", { when: appointment ? formatRelativeDay(appointment.scheduledAt) : "" })}
          </DialogDescription>
        </DialogHeader>
        <QueryState query={slotsQuery} loadingLabel={t("pt.appt.findingTimes")}>
          {(data) =>
            data.slots.length === 0 ? (
              <EmptyBlock title={t("pt.appt.noOtherTimes")} />
            ) : (
              <SlotPicker slots={data.slots} value={slot} onChange={setSlot} doctorTimezone={data.doctorTimezone} doctorName={appointment?.doctor?.name ?? t("pt.theDoctor")} />
            )
          }
        </QueryState>
        {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
        <Button size="lg" onClick={move} disabled={submitting || !slot}>{submitting ? t("common.saving") : t("pt.appt.requestNew")}</Button>
      </DialogContent>
    </Dialog>
  );
}

export default function Appointments() {
  const { t } = useI18n();
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
      toast({ title: t("pt.appt.cancelledTitle"), description: t("pt.appt.cancelledBody") });
    } catch (err: any) {
      toast({ title: t("pt.cancelFail"), description: err.message, variant: "destructive" });
      throw err;
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">{t("nav.appointments")}</h1>
          <p className="text-muted-foreground">{t("pt.appt.subtitle")}</p>
        </div>
        {connected.length > 0 && (
          <Button size="lg" onClick={() => setBookOpen(true)}>
            <CalendarPlus aria-hidden="true" /> {t("home.book")}
          </Button>
        )}
      </div>

      {pairingsQuery.isSuccess && connected.length === 0 && (
        <EmptyBlock
          title={t("pt.appt.needDoctor")}
          action={<Button asChild size="lg"><Link href="/symptoms">{t("home.findDoctor")}</Link></Button>}
        >
          {t("pt.appt.needDoctorBody")}
        </EmptyBlock>
      )}

      <QueryState
        query={appointmentsQuery}
        isEmpty={(a) => a.length === 0}
        empty={connected.length > 0 ? <EmptyBlock title={t("pt.appt.noVisits")}>{t("pt.appt.noVisitsBody")}</EmptyBlock> : null}
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
                  <h2 id="upcoming-heading" className="text-xl font-semibold">{t("pt.appt.comingUp")}</h2>
                  <div className="grid gap-4">
                    {upcoming.map((a) => (
                      <Card key={a.id}>
                        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                          <div>
                            <CardTitle as="h3" className="text-xl">{formatRelativeDay(a.scheduledAt)}</CardTitle>
                            <CardDescription className="text-base">{t("pt.appt.typeWith", { type: appointmentTypeLabel(t, a.type), doctor: a.doctor?.name ?? "" })}</CardDescription>
                          </div>
                          <StatusBadge kind="appointment" status={a.status} />
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <p className="text-muted-foreground">{STATUS_EXPLANATION[a.status] ? t(STATUS_EXPLANATION[a.status]) : ""}</p>
                          <p>{a.reason}</p>
                          <div className="flex flex-wrap gap-3">
                            <Button asChild variant="outline">
                              <Link href={`/appointments/${a.id}`}>{t("pt.getReady")} <ArrowRight aria-hidden="true" className="flip-rtl" /></Link>
                            </Button>
                            <Button variant="outline" onClick={() => setRescheduling(a)}>{t("pt.appt.changeTime")}</Button>
                            <ConfirmAction
                              trigger={<Button variant="outline">{t("pt.appt.cancelVisit")}</Button>}
                              title={t("pt.appt.cancelTitle")}
                              description={t("pt.appt.cancelBody", { type: appointmentTypeLabel(t, a.type).toLowerCase(), doctor: a.doctor?.name ?? "", when: formatRelativeDay(a.scheduledAt) })}
                              confirmLabel={t("pt.yesCancel")}
                              cancelLabel={t("pt.appt.keepVisit")}
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
                  <h2 id="past-heading" className="text-xl font-semibold">{t("pt.appt.earlier")}</h2>
                  <div className="grid gap-4">
                    {past.map((a) => (
                      <Card key={a.id}>
                        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                          <div>
                            <CardTitle as="h3" className="text-lg">{formatRelativeDay(a.scheduledAt)}</CardTitle>
                            <CardDescription className="text-base">{t("pt.appt.typeWith", { type: appointmentTypeLabel(t, a.type), doctor: a.doctor?.name ?? "" })}</CardDescription>
                          </div>
                          <StatusBadge kind="appointment" status={a.status} />
                        </CardHeader>
                        <CardContent>
                          <Button asChild variant="outline"><Link href={`/appointments/${a.id}`}>{t("pt.appt.summary")}</Link></Button>
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

      {pairingsQuery.isLoading && <LoadingBlock label={t("pt.appt.loadingDoctors")} />}

      {bookOpen && <BookDialog open={bookOpen} onOpenChange={setBookOpen} connected={connected} initialPairingId={params.get("book") || ""} />}
      <RescheduleDialog appointment={rescheduling} onClose={() => setRescheduling(null)} />
    </div>
  );
}
