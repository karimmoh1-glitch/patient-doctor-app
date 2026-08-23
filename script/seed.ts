/**
 * Development-only demo data seed. Refuses to run against a production
 * database. Usage: npm run db:seed
 */
import "dotenv/config";
import { pool } from "../server/db";
import { storage } from "../server/storage";
import bcrypt from "bcryptjs";

const DEMO_PASSWORD = "DemoPass123!";

const DEMO_DOCTORS: { name: string; specialty: string; state: string; phone: string; bio: string }[] = [
  { name: "Dr. Alice Chen", specialty: "Family Medicine", state: "CA", phone: "+15551230001", bio: "General family medicine, 12 years of practice." },
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

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo data into a production environment (NODE_ENV=production).");
  }

  console.log("Seeding demo data...\n");

  const existing = await storage.getUserByEmail("admin@medconnect.dev");
  if (existing) {
    console.log("Demo data already exists (admin@medconnect.dev found). Skipping.");
    console.log("To reseed from scratch, drop and recreate the database, then run `npm run db:push` again.");
    await pool.end();
    return;
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const admin = await storage.createUser({
    name: "MedConnect Admin",
    email: "admin@medconnect.dev",
    passwordHash,
    role: "admin",
    state: null,
    phone: null,
    deactivatedAt: null,
    emailVerifiedAt: null,
  });
  console.log(`Admin: ${admin.email} / ${DEMO_PASSWORD}`);

  const patient = await storage.createUser({
    name: "Demo Patient",
    email: "patient@medconnect.dev",
    passwordHash,
    role: "patient",
    state: "CA",
    phone: "+15559998888",
    deactivatedAt: null,
    emailVerifiedAt: null,
  });
  console.log(`Patient: ${patient.email} / ${DEMO_PASSWORD} (CA)`);

  // One seeded doctor also gets a real login, so both sides of the
  // pairing accept/decline flow are testable locally.
  const doctorUser = await storage.createUser({
    name: DEMO_DOCTORS[0].name,
    email: "doctor@medconnect.dev",
    passwordHash,
    role: "doctor",
    state: DEMO_DOCTORS[0].state,
    phone: DEMO_DOCTORS[0].phone,
    deactivatedAt: null,
    emailVerifiedAt: null,
  });
  await storage.createDoctorProfile({
    userId: doctorUser.id,
    name: DEMO_DOCTORS[0].name,
    specialty: DEMO_DOCTORS[0].specialty,
    state: DEMO_DOCTORS[0].state,
    licenseNumber: "DEMO-0001",
    npiNumber: null,
    phone: DEMO_DOCTORS[0].phone,
    bio: DEMO_DOCTORS[0].bio,
    active: true,
    source: "seed",
  });
  console.log(`Doctor (with login): ${doctorUser.email} / ${DEMO_PASSWORD} (${DEMO_DOCTORS[0].state})`);

  for (const d of DEMO_DOCTORS.slice(1)) {
    await storage.createDoctorProfile({
      userId: null,
      name: d.name,
      specialty: d.specialty,
      state: d.state,
      licenseNumber: null,
      npiNumber: null,
      phone: d.phone,
      bio: d.bio,
      active: true,
      source: "seed",
    });
  }
  console.log(`Seeded ${DEMO_DOCTORS.length - 1} additional demo doctors without logins.`);

  console.log("\nDone.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
