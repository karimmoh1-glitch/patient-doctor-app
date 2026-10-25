import { Link } from "wouter";
import DoctorFinder from "@/components/doctor-finder";
import PublicLayout from "@/components/public-layout";
import PageHeader from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

// Anyone can browse; connecting needs an account. Said up front, so nobody is
// surprised by a sign-up wall after choosing a doctor.
export default function FindDoctors() {
  const { t } = useI18n();
  return (
    <PublicLayout wide>
      <div className="space-y-6">
        <PageHeader title={t("dir.public.title")} description={t("dir.public.intro")} actions={<Button asChild><Link href="/signup">{t("landing.patient.cta")}</Link></Button>} />
        <DoctorFinder mode="public" />
      </div>
    </PublicLayout>
  );
}
