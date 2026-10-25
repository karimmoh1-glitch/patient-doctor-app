import { storage } from "../storage";
import type { DoctorStatus } from "@shared/languages";

/**
 * Where a doctor account stands. Only "approved" grants clinical access.
 * A doctor with a profile but no application (a seeded demonstration login)
 * counts as approved, because the profile is what grants access.
 */
export async function doctorStatusFor(userId: string): Promise<DoctorStatus> {
  const [profile, application] = await Promise.all([
    storage.getDoctorProfileByUserId(userId),
    storage.getDoctorApplicationByUserId(userId),
  ]);
  if (application?.status === "suspended") return "suspended";
  if (profile) return profile.active ? "approved" : "suspended";
  return (application?.status as DoctorStatus | undefined) ?? "incomplete";
}
