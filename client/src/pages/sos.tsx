import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { Phone, MessageCircle, TriangleAlert, MapPin, UserRound } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import EmergencyAction from "@/components/emergency-action";
import { useEmergency } from "@/lib/emergency";
import EmergencyInfo from "@/components/emergency-info";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { Ltr } from "@/components/ltr";

interface Pairing {
  id: string;
  status: string;
  doctor: { id: string; name: string; specialty: string; state: string; phone: string | null } | null;
}

interface EmergencyProfile {
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  allergiesText: string | null;
  emergencyNotes: string | null;
}

export default function Sos() {
  const { t } = useI18n();
  const emergency = useEmergency();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [alertingId, setAlertingId] = useState<string | null>(null);
  const [locationText, setLocationText] = useState<string | null>(null);
  const [locationRequesting, setLocationRequesting] = useState(false);
  const [alertError, setAlertError] = useState<string | null>(null);

  const { data: pairings } = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });
  const { data: profile } = useQuery<EmergencyProfile>({ queryKey: ["/api/emergency-profile"] });
  const { data: health } = useQuery<{ allergy: { picture: "not_collected" | "has_known" | "none_known" | "unknown" } }>({ queryKey: ["/api/health-profile"] });
  const { data: allergies } = useQuery<{ id: string; data: Record<string, string>; verified: unknown }[]>({ queryKey: ["/api/health-profile/entries?kind=allergy"] });
  const connected = pairings?.filter((p) => p.status === "accepted") ?? [];
  const allergyPicture = health?.allergy.picture ?? "not_collected";
  const hasInfo = !!(profile?.emergencyContactName || allergyPicture !== "not_collected" || profile?.emergencyNotes);

  // Location is only read when the person taps the button, and only goes
  // anywhere if they then choose to send a message.
  function requestShareLocation() {
    if (!navigator.geolocation) {
      toast({ title: t("pt.sos.noGeo"), variant: "destructive" });
      return;
    }
    setLocationRequesting(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocationText(`https://maps.google.com/?q=${pos.coords.latitude},${pos.coords.longitude}`);
        setLocationRequesting(false);
      },
      () => {
        setLocationRequesting(false);
        toast({ title: t("pt.sos.geoFail"), description: t("pt.sos.geoFailBody"), variant: "destructive" });
      },
      { timeout: 10000 },
    );
  }

  async function sendUrgentMessage(pairingId: string, doctorName: string) {
    setAlertingId(pairingId);
    setAlertError(null);
    const parts = [t("pt.sos.urgentMsg")];
    if (note.trim()) parts.push(note.trim());
    if (locationText) parts.push(t("pt.sos.myLocation", { url: locationText }));
    try {
      await apiRequest("POST", `/api/pairings/${pairingId}/messages`, { body: parts.join(" ") });
      setLocation(`/chat/${pairingId}?with=${encodeURIComponent(doctorName)}`);
    } catch (err: any) {
      setAlertError(t("pt.sos.notSent", { name: doctorName, error: err.message ?? "" }));
    } finally {
      setAlertingId(null);
    }
  }

  // The link sits inside the sentence, so its position comes from the translation.
  const [noInfoBefore, noInfoAfter] = t("pt.sos.noInfo").split("{link}");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="flex items-center gap-3 text-3xl font-semibold text-destructive">
        <TriangleAlert className="h-8 w-8" aria-hidden="true" /> {t("top.emergency")}
      </h1>

      <Card className="border-2 border-destructive">
        <CardHeader>
          <CardTitle as="h2" className="text-2xl">{t("pt.sos.dangerTitle")}</CardTitle>
          <CardDescription className="text-lg">
            {t("pt.sos.dangerBody", { number: emergency.label })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmergencyAction messageKey="emergency.callNow" icon={Phone} className="min-h-20 w-full text-2xl" iconClassName="!size-7" />
        </CardContent>
      </Card>

      <EmergencyInfo />

      {profile?.emergencyContactPhone && (
        <Button asChild size="lg" variant="outline" className="min-h-16 w-full text-xl">
          <a href={`tel:${profile.emergencyContactPhone}`}>
            <UserRound aria-hidden="true" /> {profile.emergencyContactName ? t("pt.callName", { name: profile.emergencyContactName }) : t("pt.sos.callContactDefault")}
          </a>
        </Button>
      )}

      <details className="rounded-xl border-2 border-input bg-card p-4">
        <summary className="min-h-11 cursor-pointer text-xl font-semibold">{t("pt.sos.infoSummary")}</summary>
        <div className="mt-3 space-y-3 text-lg">
          {!hasInfo ? (
            <p>
              {noInfoBefore}<Link href="/profile" className="font-medium text-primary underline underline-offset-4">{t("pt.sos.noInfoLink")}</Link>{noInfoAfter}
            </p>
          ) : (
            <dl className="space-y-3">
              {profile?.emergencyContactName && (<div><dt className="font-semibold">{t("pt.sos.emContact")}</dt><dd>{profile.emergencyContactName}{profile.emergencyContactPhone ? <> · <Ltr>{profile.emergencyContactPhone}</Ltr></> : ""}</dd></div>)}
              {allergyPicture !== "not_collected" && (
                <div>
                  <dt className="font-semibold">{t("pt.sos.allergies")}</dt>
                  <dd>
                    {allergyPicture === "has_known" ? (allergies ?? []).map((a) => a.data.substance).join(", ") : t(`hp.sos.allergy.${allergyPicture}` as MessageKey)}
                    {allergyPicture === "has_known" && <span className="block text-base text-muted-foreground">{(allergies ?? []).every((a) => !!a.verified) ? t("hp.sos.checked") : t("hp.sos.notChecked")}</span>}
                  </dd>
                </div>
              )}
              {profile?.emergencyNotes && (<div><dt className="font-semibold">{t("pt.sos.notes")}</dt><dd>{profile.emergencyNotes}</dd></div>)}
            </dl>
          )}
        </div>
      </details>

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-xl">{t("pt.sos.urgentTitle")}</CardTitle>
          <CardDescription className="text-base">
            {t("pt.sos.urgentBody")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {connected.length === 0 && <p className="text-lg">{t("pt.sos.noConnected", { number: emergency.label })}</p>}
          {connected.map((p) => (
            <div key={p.id} className="space-y-3 rounded-xl border-2 border-input p-4">
              <p className="text-xl font-semibold">{p.doctor?.name}</p>
              <div className="flex flex-wrap gap-3">
                {p.doctor?.phone && (
                  <Button asChild size="lg"><a href={`tel:${p.doctor.phone}`}><Phone aria-hidden="true" /> {t("pt.callName", { name: p.doctor.name })}</a></Button>
                )}
                <Button size="lg" variant="outline" disabled={alertingId === p.id} onClick={() => sendUrgentMessage(p.id, p.doctor?.name ?? t("pt.yourDoctor"))}>
                  <MessageCircle aria-hidden="true" /> {alertingId === p.id ? t("pt.sending") : t("pt.sos.sendUrgent")}<span className="sr-only"> {t("pt.sos.toName", { name: p.doctor?.name ?? "" })}</span>
                </Button>
              </div>
            </div>
          ))}
          {connected.length > 0 && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="urgent-note" className="text-base">{t("pt.sos.noteLabel")}</Label>
                <Textarea id="urgent-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
              </div>
              <Button variant="outline" disabled={locationRequesting} onClick={requestShareLocation}>
                <MapPin aria-hidden="true" /> {locationText ? t("pt.sos.locAdded") : locationRequesting ? t("pt.sos.locFinding") : t("pt.sos.locAdd")}
              </Button>
              {alertError && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{alertError}</p>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
