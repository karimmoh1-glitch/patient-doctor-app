import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface DoctorApplication {
  id: string;
  name: string;
  email: string;
  licenseNumber: string;
  licensedStates: string[];
  npiNumber: string | null;
  specialty: string;
  phone: string;
  bio: string | null;
  createdAt: string;
}

export default function AdminDashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [actingId, setActingId] = useState<string | null>(null);

  const { data: applications, isLoading } = useQuery<DoctorApplication[]>({
    queryKey: ["/api/admin/doctor-applications"],
  });

  async function handleDecision(id: string, decision: "approve" | "reject") {
    setActingId(id);
    try {
      await apiRequest("POST", `/api/admin/doctor-applications/${id}/${decision}`);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/doctor-applications"] });
      toast({ title: decision === "approve" ? "Doctor approved" : "Application rejected" });
    } catch (err: any) {
      toast({ title: "Action failed", description: err.message, variant: "destructive" });
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Doctor applications</h1>
      {isLoading && <p className="text-muted-foreground">Loading…</p>}
      {!isLoading && applications?.length === 0 && <p className="text-muted-foreground">No pending applications.</p>}
      <div className="space-y-4">
        {applications?.map((a) => (
          <Card key={a.id}>
            <CardHeader>
              <CardTitle>{a.name}</CardTitle>
              <CardDescription>
                {a.specialty} · Licensed in {a.licensedStates.join(", ")} · License #{a.licenseNumber}
                {a.npiNumber ? ` · NPI ${a.npiNumber}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {a.email} · {a.phone}
              </p>
              {a.bio && <p className="text-sm">{a.bio}</p>}
              <div className="flex gap-2">
                <Button size="sm" disabled={actingId === a.id} onClick={() => handleDecision(a.id, "approve")}>
                  Approve
                </Button>
                <Button size="sm" variant="outline" disabled={actingId === a.id} onClick={() => handleDecision(a.id, "reject")}>
                  Reject
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
