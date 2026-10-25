import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import DoctorFinder from "@/components/doctor-finder";
import PageHeader from "@/components/page-header";
import { useI18n } from "@/lib/i18n";

export default function DoctorsDirectory() {
  const { t } = useI18n();
  const { data: me } = useQuery<{ state: string | null }>({ queryKey: ["/api/auth/me"] });
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={me?.state ? t("dir.page.titleIn", { state: me.state }) : t("dir.page.title")}
        description={
          <>
            {t("dir.page.intro")}{" "}
            <Link href="/symptoms" className="font-medium text-primary underline underline-offset-4">{t("dir.page.describe")}</Link>
          </>
        }
      />
      {/* Remount once we know the person's state so it becomes the starting filter. */}
      <DoctorFinder key={me?.state ?? "none"} mode="patient" defaultState={me?.state} />
    </div>
  );
}
