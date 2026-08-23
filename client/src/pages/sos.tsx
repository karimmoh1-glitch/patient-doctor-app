import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Phone, MessageCircle, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface Pairing {
  id: string;
  status: string;
  doctor: { id: string; name: string; specialty: string; state: string; phone: string | null } | null;
}

export default function Sos() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [alertingId, setAlertingId] = useState<string | null>(null);

  const { data: pairings } = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });
  const connected = pairings?.filter((p) => p.status === "accepted") ?? [];

  async function sendUrgentAlert(pairingId: string, doctorName: string) {
    setAlertingId(pairingId);
    const body = `🚨 URGENT — I need to hear back as soon as possible.${note.trim() ? ` ${note.trim()}` : ""}`;
    try {
      await apiRequest("POST", `/api/pairings/${pairingId}/messages`, { body });
      toast({ title: `Alert sent to ${doctorName}`, description: "Opening your chat with them now." });
      setLocation(`/chat/${pairingId}?with=${encodeURIComponent(doctorName)}`);
    } catch (err: any) {
      toast({ title: "Couldn't send alert", description: err.message, variant: "destructive" });
    } finally {
      setAlertingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-destructive">
          <TriangleAlert /> SOS
        </h1>
        <p className="text-muted-foreground">Get help fast.</p>
      </div>

      <Card className="border-destructive">
        <CardHeader>
          <CardTitle>Life-threatening emergency?</CardTitle>
          <CardDescription>
            MedConnect is not monitored in real time and cannot dispatch help. If you or someone else may be in
            danger, call 911 (or your local emergency number) right now.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <a href="tel:911">
            <Button variant="destructive" size="lg" className="w-full text-base">
              <Phone /> Call 911
            </Button>
          </a>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reach your connected doctor</CardTitle>
          <CardDescription>
            For urgent — but not life-threatening — concerns. A chat alert is not guaranteed to be seen right away;
            calling is faster.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {connected.length === 0 && (
            <p className="text-sm text-muted-foreground">
              You don't have a connected doctor yet. Use "Find a doctor" first, or call 911 if this is an emergency.
            </p>
          )}
          {connected.map((p) => (
            <div key={p.id} className="space-y-2 rounded-md border border-border p-3">
              <p className="font-medium">{p.doctor?.name}</p>
              <div className="flex flex-wrap gap-2">
                {p.doctor?.phone && (
                  <a href={`tel:${p.doctor.phone}`}>
                    <Button size="sm">
                      <Phone /> Call {p.doctor.name}
                    </Button>
                  </a>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={alertingId === p.id}
                  onClick={() => sendUrgentAlert(p.id, p.doctor?.name ?? "your doctor")}
                >
                  <MessageCircle /> Send urgent alert
                </Button>
              </div>
            </div>
          ))}
          {connected.length > 0 && (
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional: add a quick note to include with the alert…"
              rows={3}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
