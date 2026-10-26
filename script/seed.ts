/**
 * DEVELOPMENT AND TEST FIXTURES ONLY. Creates invented people (patient, caregiver, administrator, a dozen doctors,
 * and a small care history) so the automated browser tests and a developer's local database have something to work
 * with. Every account is marked is_demo, so a production server refuses it even if it were ever seeded there; this
 * script itself refuses to run when NODE_ENV=production. None of this is real, and none of it is ever part of a
 * production deployment. Usage: npm run db:seed
 */
import "dotenv/config";
import "./asOperator";
import { pool } from "../server/db";
import { storage } from "../server/storage";
import bcrypt from "bcryptjs";
import { defaultTimezoneForState } from "../shared/timezones";
import { replaceAvailability } from "../server/services/schedulingService";

const DEMO_PASSWORD = "DemoPass123!";

// Languages and contact methods below are invented demonstration data for fake
// doctors; they exist so the language filter and Arabic profiles can be
// exercised. A real doctor lists their own.
const DEMO_LANGUAGES: Record<string, string[]> = {
  "Dr. Emily Chen": ["en", "zh"],
  "Dr. Marcus Reed": ["en"],
  "Dr. Priya Nair": ["en", "hi"],
  "Dr. James Okafor": ["en", "ar"],
  "Dr. Lena Petrova": ["en", "ru"],
  "Dr. Samuel Osei": ["en"],
  "Dr. Grace Kim": ["en", "ko"],
  "Dr. Daniel Ruiz": ["en", "es"],
  "Dr. Fatima Malik": ["en", "ar", "ur"],
  "Dr. Robert Hayes": ["en"],
  "Dr. Nina Volkov": ["en", "ru"],
  "Dr. Tomás Alvarez": ["en", "es"],
};

const DEMO_DOCTORS: { name: string; specialty: string; state: string; phone: string; bio: string }[] = [
  { name: "Dr. Emily Chen", specialty: "Family Medicine", state: "CA", phone: "+15551230001", bio: "General family medicine, 12 years of practice." },
  { name: "Dr. Marcus Reed", specialty: "Cardiology", state: "CA", phone: "+15551230002", bio: "Board-certified cardiologist focused on preventive care." },
  { name: "Dr. Priya Nair", specialty: "Dermatology", state: "CA", phone: "+15551230003", bio: "Skin conditions, acne, and general dermatology." },
  { name: "Dr. James Okafor", specialty: "Psychiatry", state: "NY", phone: "+15551230004", bio: "Anxiety, depression, and general adult psychiatry." },
  { name: "Dr. Lena Petrova", specialty: "Pediatrics", state: "NY", phone: "+15551230005", bio: "Pediatric care from infancy through adolescence." },
  { name: "Dr. Samuel Osei", specialty: "Orthopedics", state: "NY", phone: "+15551230006", bio: "Sports injuries and joint pain." },
  { name: "Dr. Grace Kim", specialty: "Internal Medicine", state: "TX", phone: "+15551230007", bio: "Chronic condition management and general internal medicine." },
  { name: "Dr. Daniel Ruiz", specialty: "Gastroenterology", state: "TX", phone: "+15551230008", bio: "Digestive health and GI conditions." },
  { name: "Dr. Fatima Malik", specialty: "OB/GYN", state: "TX", phone: "+15551230009", bio: "Women's health and prenatal care." },
  { name: "Dr. Robert Hayes", specialty: "ENT (Ear, Nose & Throat)", state: "FL", phone: "+15551230010", bio: "Ear, nose, and throat conditions." },
  { name: "Dr. Nina Volkov", specialty: "Endocrinology", state: "FL", phone: "+15551230011", bio: "Thyroid and diabetes management." },
  { name: "Dr. Tomás Alvarez", specialty: "Urgent Care", state: "FL", phone: "+15551230012", bio: "Same-day urgent care for non-emergency injuries and illness." },
];

// Weekday clinic hours for demo doctors, so the booking flow has real slots
// to offer. Demo data only: a real doctor publishes their own hours.
async function publishDemoHours(doctorProfileId: string, timezone: string) {
  const windows = [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, startMinute: 9 * 60, endMinute: 12 * 60 },
    { weekday, startMinute: 13 * 60, endMinute: 17 * 60 },
  ]);
  await replaceAvailability(doctorProfileId, timezone, windows);
}

// Fixture accounts are marked is_demo so a production server refuses them. The production-build smoke test needs accounts a
// production server will ACCEPT, to exercise every role signing in; it sets SEED_AS_REAL_ACCOUNTS=1 on its own throwaway database.
const FIXTURE = process.env.SEED_AS_REAL_ACCOUNTS !== "1";

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo data into a production environment (NODE_ENV=production).");
  }

  console.log("Seeding demo data...\n");

  const existing = await storage.getUserByEmail("admin@avela.dev");
  if (existing) {
    console.log("Demo data already exists (admin@avela.dev found). Skipping.");
    console.log("To reseed from scratch, drop and recreate the database, then run `npm run db:migrate` again.");
    await pool.end();
    return;
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const admin = await storage.createUser({
    name: "Avela Admin",
    email: "admin@avela.dev",
    passwordHash,
    role: "admin",
    state: null,
    phone: null,
    deactivatedAt: null,
    emailVerifiedAt: null,
    isDemo: FIXTURE,
  });
  console.log(`Admin: ${admin.email} / ${DEMO_PASSWORD}`);

  const patient = await storage.createUser({
    name: "Margaret Johnson",
    email: "patient@avela.dev",
    passwordHash,
    role: "patient",
    state: "CA",
    phone: "+15559998888",
    emergencyContactName: "Sarah Johnson (daughter)",
    emergencyContactPhone: "+15559991234",
    allergiesText: "Penicillin (demo data)",
    emergencyNotes: "Prefers hospitals within Bay Area Health Network. Hard of hearing — please speak clearly.",
    deactivatedAt: null,
    emailVerifiedAt: null,
    isDemo: FIXTURE,
  });
  console.log(`Patient: ${patient.email} / ${DEMO_PASSWORD} (CA) — "${patient.name}"`);

  const caregiverPasswordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const caregiverUser = await storage.createUser({
    name: "Sarah Johnson",
    email: "caregiver@avela.dev",
    passwordHash: caregiverPasswordHash,
    role: "caregiver",
    state: null,
    phone: null,
    deactivatedAt: null,
    emailVerifiedAt: null,
    isDemo: FIXTURE,
  });
  const careCircleInvite = await storage.createCareCircleInvite({
    patientUserId: patient.id,
    name: "Sarah Johnson",
    inviteEmail: caregiverUser.email,
    relationshipLabel: "Daughter",
    permissionMedicationStatus: true,
    permissionAppointments: true,
    permissionDeliveryStatus: true,
    permissionDocuments: false,
    permissionFullRecords: false,
    tokenHash: "seeded-preaccepted", // never redeemable — this invite is created pre-accepted below
  });
  await storage.acceptCareCircleInvite(careCircleInvite.id, caregiverUser.id);
  console.log(`Caregiver (with login): ${caregiverUser.email} / ${DEMO_PASSWORD} — Margaret's daughter, in her Care Circle`);

  // One seeded doctor also gets a real login, so both sides of the
  // pairing accept/decline flow are testable locally.
  const doctorUser = await storage.createUser({
    name: DEMO_DOCTORS[0].name,
    email: "doctor@avela.dev",
    passwordHash,
    role: "doctor",
    state: DEMO_DOCTORS[0].state,
    phone: DEMO_DOCTORS[0].phone,
    deactivatedAt: null,
    emailVerifiedAt: null,
    isDemo: FIXTURE,
  });
  const firstProfile = await storage.createDoctorProfile({
    userId: doctorUser.id,
    timezone: defaultTimezoneForState(DEMO_DOCTORS[0].state),
    name: DEMO_DOCTORS[0].name,
    specialty: DEMO_DOCTORS[0].specialty,
    state: DEMO_DOCTORS[0].state,
    licenseNumber: "DEMO-0001",
    npiNumber: null,
    phone: DEMO_DOCTORS[0].phone,
    bio: DEMO_DOCTORS[0].bio,
    active: true,
    source: "seed",
    languages: DEMO_LANGUAGES[DEMO_DOCTORS[0].name],
    modalities: ["phone", "messaging"],
  });
  await publishDemoHours(firstProfile.id, firstProfile.timezone);
  console.log(`Doctor (with login): ${doctorUser.email} / ${DEMO_PASSWORD} (${DEMO_DOCTORS[0].state})`);

  const otherProfilesByName = new Map<string, Awaited<ReturnType<typeof storage.createDoctorProfile>>>();
  for (const [i, d] of DEMO_DOCTORS.slice(1).entries()) {
    const user = await storage.createUser({
      name: d.name,
      email: `fixture.doctor${i + 2}@avela.dev`,
      passwordHash,
      role: "doctor",
      state: d.state,
      phone: d.phone,
      deactivatedAt: null,
      emailVerifiedAt: null,
      isDemo: FIXTURE,
    });
    const profile = await storage.createDoctorProfile({
      userId: user.id,
      timezone: defaultTimezoneForState(d.state),
      name: d.name,
      specialty: d.specialty,
      state: d.state,
      licenseNumber: null,
      npiNumber: null,
      phone: d.phone,
      bio: d.bio,
      active: true,
      source: "seed",
      languages: DEMO_LANGUAGES[d.name] ?? ["en"],
      modalities: ["phone", "messaging"],
    });
    await publishDemoHours(profile.id, profile.timezone);
    otherProfilesByName.set(d.name, profile);
  }
  console.log(`Seeded ${DEMO_DOCTORS.length - 1} additional fixture doctors, each with a login (fixture.doctorN@avela.dev).`);

  // --- Connected care journey for the demo patient ---------------------
  const doctorProfile = await storage.getDoctorProfileByUserId(doctorUser.id);
  const dermatologist = otherProfilesByName.get("Dr. Priya Nair"); // CA, so it fits the demo patient's state

  if (doctorProfile && dermatologist) {
    function daysAgo(n: number): Date {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return d;
    }
    function daysFromNow(n: number): Date {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return d;
    }
    function dateKey(d: Date): string {
      return d.toISOString().slice(0, 10);
    }

    // Primary care relationship — accepted, with real history.
    const primaryPairing = await storage.createPairingRequest({
      patientUserId: patient.id,
      doctorProfileId: doctorProfile.id,
      symptomReportId: null,
    });
    await storage.updatePairingRequestStatus(primaryPairing.id, "accepted");
    await storage.setPairingRelationshipLabel(primaryPairing.id, "Primary Care");

    // Specialist relationship — accepted, lighter touch, used to show the
    // Privacy Center granting extra access beyond the default.
    const specialistPairing = await storage.createPairingRequest({
      patientUserId: patient.id,
      doctorProfileId: dermatologist.id,
      symptomReportId: null,
    });
    await storage.updatePairingRequestStatus(specialistPairing.id, "accepted");
    await storage.setPairingRelationshipLabel(specialistPairing.id, "Specialist");
    await storage.upsertSharingGrant({
      patientUserId: patient.id,
      sharedWithDoctorProfileId: dermatologist.id,
      shareMedications: true,
      shareDocuments: false,
      shareAppointments: false,
      shareFullHistory: false,
    });

    // A completed visit 10 days ago, with a real visit note and follow-up
    // instructions — this is what drives the follow-up engine below.
    const pastAppointment = await storage.createAppointment({
      pairingRequestId: primaryPairing.id,
      patientUserId: patient.id,
      doctorProfileId: doctorProfile.id,
      type: "Video Visit",
      reason: "Recurring headaches and fatigue over the past two weeks",
      scheduledAt: daysAgo(10),
      durationMinutes: 30,
      questionsForDoctor: [],
    });
    await storage.completeAppointmentWithNotes(
      pastAppointment.id,
      "Patient reports recurring headaches and fatigue, likely tension-related. Blood pressure and vitals within normal range. Starting a demo medication and rechecking in two weeks.",
      "Continue the prescribed medication as directed, stay hydrated, and follow up in two weeks if symptoms persist.",
      daysFromNow(4),
    );
    await storage.createFollowUpTask({
      patientUserId: patient.id,
      appointmentId: pastAppointment.id,
      doctorProfileId: doctorProfile.id,
      title: "Follow doctor's instructions",
      detail: "Continue the prescribed medication as directed, stay hydrated, and follow up in two weeks if symptoms persist.",
      dueDate: null,
      sourceType: "doctor_instruction",
    });
    await storage.createFollowUpTask({
      patientUserId: patient.id,
      appointmentId: pastAppointment.id,
      doctorProfileId: doctorProfile.id,
      title: `Schedule follow-up with ${doctorProfile.name}`,
      detail: null,
      dueDate: daysFromNow(4),
      sourceType: "appointment",
    });

    // An upcoming confirmed visit, with prep questions already jotted down.
    const upcomingAppointment = await storage.createAppointment({
      pairingRequestId: primaryPairing.id,
      patientUserId: patient.id,
      doctorProfileId: doctorProfile.id,
      type: "Video Visit",
      reason: "Two-week follow-up on headaches and current medication",
      scheduledAt: daysFromNow(3),
      durationMinutes: 30,
      questionsForDoctor: ["Is it safe to keep taking this alongside my allergy medication?", "Should we adjust the schedule if the headaches stop?"],
    });
    await storage.updateAppointmentStatus(upcomingAppointment.id, "confirmed");

    // A not-yet-confirmed request with the specialist.
    await storage.createAppointment({
      pairingRequestId: specialistPairing.id,
      patientUserId: patient.id,
      doctorProfileId: dermatologist.id,
      type: "Phone Call",
      reason: "Follow-up on a skin patch that hasn't cleared up",
      scheduledAt: daysFromNow(9),
      durationMinutes: 20,
      questionsForDoctor: [],
    });

    // Prescription from the completed visit, added to tracking with a few
    // days of realistic (imperfect) adherence history.
    const rx = await storage.createPrescription({
      pairingRequestId: primaryPairing.id,
      patientUserId: patient.id,
      doctorProfileId: doctorProfile.id,
      appointmentId: pastAppointment.id,
      medicationName: "Demo Tension-Relief Tablet",
      instructions: "Take one tablet by mouth, twice daily, with food (demo instructions — not real dosing guidance)",
      frequencyPerDay: 2,
      durationDays: 30,
      quantity: 60,
      refillsAllowed: 2,
      notes: "Reassess at two-week follow-up.",
      startDate: daysAgo(10),
      endDate: daysFromNow(20),
    });
    const medication = await storage.createMedication({
      patientUserId: patient.id,
      prescriptionId: rx.id,
      name: rx.medicationName,
      instructions: rx.instructions,
      scheduleTimes: ["08:00", "20:00"],
      startDate: rx.startDate,
      endDate: rx.endDate,
      active: true,
    });
    const adherencePattern: ("taken" | "skipped")[][] = [
      ["taken", "taken"],
      ["taken", "taken"],
      ["taken", "skipped"],
    ];
    for (let i = 0; i < adherencePattern.length; i++) {
      const day = dateKey(daysAgo(i + 1));
      const [morning, evening] = adherencePattern[i];
      await storage.upsertMedicationLog({ medicationId: medication.id, patientUserId: patient.id, doseDate: day, doseTime: "08:00", status: morning });
      await storage.upsertMedicationLog({ medicationId: medication.id, patientUserId: patient.id, doseDate: day, doseTime: "20:00", status: evening });
    }
    await storage.upsertMedicationLog({ medicationId: medication.id, patientUserId: patient.id, doseDate: dateKey(new Date()), doseTime: "08:00", status: "taken" });

    // A second active prescription, left untracked so "Add to tracking" has
    // something to demo live.
    await storage.createPrescription({
      pairingRequestId: primaryPairing.id,
      patientUserId: patient.id,
      doctorProfileId: doctorProfile.id,
      appointmentId: null,
      medicationName: "Demo Daily Multivitamin",
      instructions: "Take one tablet by mouth every morning (demo instructions)",
      frequencyPerDay: 1,
      durationDays: 90,
      quantity: 90,
      refillsAllowed: 3,
      notes: null,
      startDate: daysAgo(2),
      endDate: daysFromNow(88),
    });

    // A demo document.
    await storage.createDocument({
      patientUserId: patient.id,
      uploadedByUserId: patient.id,
      title: "Basic Metabolic Panel — results",
      category: "Lab Result",
      fileName: null,
      filePath: null,
      notes: "Routine bloodwork ordered at the last visit. All values within normal range (demo data).",
    });

    // A couple of messages so the inbox isn't empty on first login.
    await storage.createMessage({ pairingRequestId: primaryPairing.id, senderUserId: doctorUser.id, body: "Hi! Following up after your visit — how are the headaches since starting the new medication?" });
    await storage.createMessage({ pairingRequestId: primaryPairing.id, senderUserId: patient.id, body: "Better, thank you! Down to maybe once every few days instead of daily." });
    await storage.createMessage({ pairingRequestId: primaryPairing.id, senderUserId: doctorUser.id, body: "Great to hear. Let's talk more at your follow-up next week." });

    console.log("Seeded a connected care journey: appointments, prescriptions, medication tracking, a document, follow-ups, and messages.");
  }

  console.log("\nDone.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
