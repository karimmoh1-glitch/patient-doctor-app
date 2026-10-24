import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import StatusBadge from "@/components/status-badge";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface DoctorListing { id: string; name: string; specialty: string; state: string; bio: string | null; isDemoProfile?: boolean }
interface Pairing { id: string; status: string; doctor: { id: string } | null }
interface Me { state: string | null }

export default function DoctorsDirectory() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [specialty, setSpecialty] = useState("all");
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const doctorsQuery = useQuery<DoctorListing[]>({ queryKey: ["/api/doctors"] });
  const { data: pairings } = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });
  const { data: me } = useQuery<Me>({ queryKey: ["/api/auth/me"] });

  const connectionByDoctorId = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of pairings || []) if (p.doctor) m.set(p.doctor.id, p.status);
    return m;
  }, [pairings]);

  async function connect(doctorProfileId: string) {
    setConnectingId(doctorProfileId);
    try {
      await apiRequest("POST", "/api/pairings", { doctorProfileId });
      queryClient.invalidateQueries({ queryKey: ["/api/pairings"] });
      toast({ title: "Request sent", description: "The doctor decides whether to accept. It can take a day or more." });
    } catch (err: any) {
      toast({ title: "We couldn't send that", description: err.message, variant: "destructive" });
    } finally {
      setConnectingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">All doctors{me?.state ? ` in ${me.state}` : ""}</h1>
        <p className="text-lg text-muted-foreground">
          Doctors can usually only treat people in the state where they are licensed. Not sure who to pick?{" "}
          <Link href="/symptoms" className="font-medium text-primary underline underline-offset-4">Tell us what you need and we'll suggest doctors.</Link>
        </p>
      </div>

      <QueryState query={doctorsQuery} loadingLabel="Loading doctors">
        {(all) => {
          const inState = all.filter((d) => !me?.state || d.state === me.state);
          const specialties = Array.from(new Set(inState.map((d) => d.specialty))).sort();
          const q = search.trim().toLowerCase();
          const shown = inState.filter(
            (d) => (specialty === "all" || d.specialty === specialty) && (!q || d.name.toLowerCase().includes(q) || d.specialty.toLowerCase().includes(q)),
          );
          return (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="doc-search" className="text-base">Search by name</Label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <Input id="doc-search" className="pl-10" value={search} onChange={(e) => setSearch(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="doc-specialty" className="text-base">Kind of doctor</Label>
                  <NativeSelect id="doc-specialty" value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
                    <option value="all">Any kind</option>
                    {specialties.map((s) => <option key={s} value={s}>{s}</option>)}
                  </NativeSelect>
                </div>
              </div>

              <p role="status" className="text-muted-foreground">{shown.length} doctor{shown.length === 1 ? "" : "s"} shown</p>
              {shown.length === 0 && <EmptyBlock title="No doctors match" />}

              <ul className="space-y-4">
                {shown.map((d) => {
                  const status = connectionByDoctorId.get(d.id);
                  const connected = status === "requested" || status === "accepted";
                  return (
                    <li key={d.id}>
                      <Card>
                        <CardHeader>
                          <CardTitle as="h2" className="text-xl">{d.name}</CardTitle>
                          <CardDescription className="text-base">{d.specialty} · licensed in {d.state}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {d.bio && <p className="text-base">{d.bio}</p>}
                          {d.isDemoProfile && <Badge variant="outline">Demonstration profile — this doctor will not reply</Badge>}
                          <div>
                            {connected && status ? (
                              <StatusBadge kind="pairing" status={status} />
                            ) : (
                              <Button size="lg" disabled={connectingId === d.id} onClick={() => connect(d.id)}>
                                {connectingId === d.id ? "Sending…" : "Ask this doctor to see me"}<span className="sr-only">: {d.name}</span>
                              </Button>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
