import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Phone, MessageCircle } from "lucide-react";
import PairingStatusBadge from "@/components/pairing-status-badge";

interface Pairing {
  id: string;
  status: string;
  requestedAt: string;
  doctor: { id: string; name: string; specialty: string; state: string; phone: string | null } | null;
}

export default function Pairings() {
  const { data: pairings, isLoading } = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">My connections</h1>
      {isLoading && <p className="text-muted-foreground">Loading…</p>}
      {!isLoading && pairings?.length === 0 && (
        <p className="text-muted-foreground">You haven't requested to connect with a doctor yet.</p>
      )}
      <div className="space-y-4">
        {pairings?.map((p) => (
          <Card key={p.id}>
            <CardHeader className="flex flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle>{p.doctor?.name ?? "Doctor"}</CardTitle>
                <CardDescription>
                  {p.doctor?.specialty} · {p.doctor?.state}
                </CardDescription>
              </div>
              <PairingStatusBadge status={p.status} />
            </CardHeader>
            {p.status === "accepted" && (
              <CardContent className="flex gap-2">
                {p.doctor?.phone && (
                  <a href={`tel:${p.doctor.phone}`}>
                    <Button size="sm">
                      <Phone /> Call {p.doctor.name}
                    </Button>
                  </a>
                )}
                <Link href={`/chat/${p.id}?with=${encodeURIComponent(p.doctor?.name ?? "your doctor")}`}>
                  <Button size="sm" variant="outline">
                    <MessageCircle /> Message
                  </Button>
                </Link>
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
