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
import { EMERGENCY_NUMBER, EMERGENCY_TEL } from "@/lib/emergency";

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
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [alertingId, setAlertingId] = useState<string | null>(null);
  const [locationText, setLocationText] = useState<string | null>(null);
  const [locationRequesting, setLocationRequesting] = useState(false);
  const [alertError, setAlertError] = useState<string | null>(null);

  const { data: pairings } = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });
  const { data: profile } = useQuery<EmergencyProfile>({ queryKey: ["/api/emergency-profile"] });
  const connected = pairings?.filter((p) => p.status === "accepted") ?? [];
  const hasInfo = !!(profile?.emergencyContactName || profile?.allergiesText || profile?.emergencyNotes);

  // Location is only read when the person taps the button, and only goes
  // anywhere if they then choose to send a message.
  function requestShareLocation() {
    if (!navigator.geolocation) {
      toast({ title: "This device can't share its location", variant: "destructive" });
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
        toast({ title: "We couldn't find your location", description: "Check that location is allowed for this website.", variant: "destructive" });
      },
      { timeout: 10000 },
    );
  }

  async function sendUrgentMessage(pairingId: string, doctorName: string) {
    setAlertingId(pairingId);
    setAlertError(null);
    const parts = ["URGENT: I need to hear back as soon as possible."];
    if (note.trim()) parts.push(note.trim());
    if (locationText) parts.push(`My location: ${locationText}`);
    try {
      await apiRequest("POST", `/api/pairings/${pairingId}/messages`, { body: parts.join(" ") });
      setLocation(`/chat/${pairingId}?with=${encodeURIComponent(doctorName)}`);
    } catch (err: any) {
      setAlertError(`The message to ${doctorName} was NOT sent. ${err.message} Please call instead.`);
    } finally {
      setAlertingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="flex items-center gap-3 text-3xl font-semibold text-destructive">
        <TriangleAlert className="h-8 w-8" aria-hidden="true" /> Emergency
      </h1>

      <Card className="border-2 border-destructive">
        <CardHeader>
          <CardTitle as="h2" className="text-2xl">Is someone in danger right now?</CardTitle>
          <CardDescription className="text-lg">
            Call {EMERGENCY_NUMBER} or your local emergency number. Avela is not an emergency service. No one here is watching for urgent messages, and we cannot send help.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="destructive" size="lg" className="min-h-20 w-full text-2xl">
            <a href={EMERGENCY_TEL}><Phone className="!size-7" aria-hidden="true" /> Call {EMERGENCY_NUMBER} now</a>
          </Button>
        </CardContent>
      </Card>

      {profile?.emergencyContactPhone && (
        <Button asChild size="lg" variant="outline" className="min-h-16 w-full text-xl">
          <a href={`tel:${profile.emergencyContactPhone}`}>
            <UserRound aria-hidden="true" /> Call {profile.emergencyContactName || "my emergency contact"}
          </a>
        </Button>
      )}

      <details className="rounded-xl border-2 border-input bg-card p-4">
        <summary className="min-h-11 cursor-pointer text-xl font-semibold">Information for the people helping me</summary>
        <div className="mt-3 space-y-3 text-lg">
          {!hasInfo ? (
            <p>
              You haven't added any yet.{" "}
              <Link href="/profile" className="font-medium text-primary underline underline-offset-4">Add it in Profile &amp; privacy</Link>.
            </p>
          ) : (
            <dl className="space-y-3">
              {profile?.emergencyContactName && (<div><dt className="font-semibold">Emergency contact</dt><dd>{profile.emergencyContactName}{profile.emergencyContactPhone ? ` · ${profile.emergencyContactPhone}` : ""}</dd></div>)}
              {profile?.allergiesText && (<div><dt className="font-semibold">Allergies</dt><dd>{profile.allergiesText}</dd></div>)}
              {profile?.emergencyNotes && (<div><dt className="font-semibold">Notes</dt><dd>{profile.emergencyNotes}</dd></div>)}
            </dl>
          )}
        </div>
      </details>

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-xl">Urgent, but not life-threatening?</CardTitle>
          <CardDescription className="text-base">
            You can phone your doctor. A message may not be read for hours or days, so phoning is faster.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {connected.length === 0 && <p className="text-lg">You aren't connected with a doctor yet. If this can't wait, call {EMERGENCY_NUMBER} or go to your nearest urgent care.</p>}
          {connected.map((p) => (
            <div key={p.id} className="space-y-3 rounded-xl border-2 border-input p-4">
              <p className="text-xl font-semibold">{p.doctor?.name}</p>
              <div className="flex flex-wrap gap-3">
                {p.doctor?.phone && (
                  <Button asChild size="lg"><a href={`tel:${p.doctor.phone}`}><Phone aria-hidden="true" /> Call {p.doctor.name}</a></Button>
                )}
                <Button size="lg" variant="outline" disabled={alertingId === p.id} onClick={() => sendUrgentMessage(p.id, p.doctor?.name ?? "your doctor")}>
                  <MessageCircle aria-hidden="true" /> {alertingId === p.id ? "Sending…" : "Send an urgent message"}<span className="sr-only"> to {p.doctor?.name}</span>
                </Button>
              </div>
            </div>
          ))}
          {connected.length > 0 && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="urgent-note" className="text-base">Add a note to the message (optional)</Label>
                <Textarea id="urgent-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
              </div>
              <Button variant="outline" disabled={locationRequesting} onClick={requestShareLocation}>
                <MapPin aria-hidden="true" /> {locationText ? "My location will be added" : locationRequesting ? "Finding you…" : "Add my location to the message"}
              </Button>
              {alertError && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{alertError}</p>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
