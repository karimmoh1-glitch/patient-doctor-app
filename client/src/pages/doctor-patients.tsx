import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

interface DoctorPairing {
  id: string;
  status: string;
  patientUserId: string;
  patientName: string;
}

export default function DoctorPatients() {
  const { t } = useI18n();
  const { data: requests, isLoading } = useQuery<DoctorPairing[]>({ queryKey: ["/api/pairings/doctor"] });
  const patients = (requests || []).filter((r) => r.status === "accepted");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("nav.d.patients")}</h1>
        <p className="text-sm text-muted-foreground">{t("dpat.subtitle")}</p>
        <p className="mt-2"><Link href="/doctor/assist" className="font-medium text-primary underline underline-offset-4">{t("hp.doc.link")}</Link></p>
      </div>

      {isLoading && <p className="text-muted-foreground">{t("common.loading")}</p>}
      {!isLoading && patients.length === 0 && <p className="text-sm text-muted-foreground">{t("dpat.none")}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {patients.map((p) => (
          <Card key={p.id}>
            <CardHeader>
              <CardTitle className="text-base">{p.patientName}</CardTitle>
            </CardHeader>
            <CardContent>
              <Link href={`/doctor/patients/${p.id}`}>
                <Button size="sm" variant="outline" className="gap-1">{t("dpat.open")} <ArrowRight className="h-3.5 w-3.5 flip-rtl" /></Button>
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
