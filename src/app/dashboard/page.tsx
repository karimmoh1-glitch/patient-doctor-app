import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import NavBar from "@/components/NavBar";
import PatientDashboard from "@/components/PatientDashboard";
import DoctorDashboard from "@/components/DoctorDashboard";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { patientProfile: true, doctorProfile: true },
  });
  if (!user) redirect("/login");

  return (
    <div className="flex flex-1 flex-col">
      <NavBar name={user.name} role={user.role} />
      <main className="flex-1 px-6 py-8 max-w-3xl w-full mx-auto">
        {user.role === "PATIENT" && user.patientProfile ? (
          <PatientDashboard symptoms={user.patientProfile.symptoms ?? ""} />
        ) : user.doctorProfile ? (
          <DoctorDashboard inviteCode={user.doctorProfile.inviteCode} />
        ) : null}
      </main>
    </div>
  );
}
