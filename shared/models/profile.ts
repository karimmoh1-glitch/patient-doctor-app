import { sql } from "drizzle-orm";
import { jsonb, pgTable, primaryKey, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";
import { users } from "./users";
import { doctorProfiles } from "./care";

export const PROFILE_SECTIONS = ["basic", "allergies", "medications", "history", "preferences", "review"] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];
export const SECTION_STATUSES = ["in_progress", "complete", "skipped"] as const;

export const ENTRY_KINDS = ["allergy", "medication", "condition", "procedure", "provider", "need"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** Which section each kind of entry belongs to. */
export const SECTION_OF_KIND: Record<EntryKind, ProfileSection> = {
  allergy: "allergies", medication: "medications", condition: "history", procedure: "history", provider: "history", need: "history",
};

const text200 = z.string().trim().min(1).max(200);
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));
// Approximate dates are free text on purpose ("about 2019", "as a child"): a person may not know the exact day.
const approx = optText(60);

/** The shape of each kind of entry. What the person wrote is stored as written; nothing is inferred or normalised into a claim. */
export const ENTRY_DATA = {
  allergy: z.object({
    substance: text200,
    reaction: optText(300),
    severity: z.enum(["mild", "moderate", "severe", "unknown"]).default("unknown"),
    approximateDate: approx,
    notes: optText(500),
  }).strict(),
  medication: z.object({
    name: text200,
    strength: optText(80),
    form: optText(80),
    // As the person (or clinician) wrote it. Avela never edits, completes or interprets instructions.
    instructions: optText(500),
    prescriber: optText(120),
    startDate: approx,
    endDate: approx,
    notes: optText(500),
  }).strict(),
  condition: z.object({ name: text200, since: approx, notes: optText(500) }).strict(),
  procedure: z.object({ name: text200, approximateDate: approx, notes: optText(500) }).strict(),
  provider: z.object({ name: text200, organization: optText(200), phone: optText(40), notes: optText(300) }).strict(),
  need: z.object({ description: z.string().trim().min(1).max(500) }).strict(),
} as const;

export const ALLERGY_STATES = ["has_known", "none_known", "unknown"] as const;
/** What the allergy section means. "not_collected" is the absence of any statement and any entry, never a claim of "none". */
export type AllergyPicture = "not_collected" | (typeof ALLERGY_STATES)[number];

export const CONSENT_PURPOSES = ["health_profile_storage"] as const;

export const onboardingSections = pgTable("onboarding_sections", {
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  section: varchar("section").notNull(),
  status: varchar("status").notNull().default("in_progress"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.patientUserId, t.section] })]);

export const allergyStatements = pgTable("allergy_statements", {
  patientUserId: varchar("patient_user_id").primaryKey().references(() => users.id),
  state: varchar("state").notNull(),
  statedByUserId: varchar("stated_by_user_id").notNull().references(() => users.id),
  statedByRole: varchar("stated_by_role").notNull(),
  statedAt: timestamp("stated_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedByUserId: varchar("reviewed_by_user_id").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});

export const healthEntries = pgTable("health_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  kind: varchar("kind").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  source: varchar("source").notNull(), // patient_reported | clinician_entered
  status: varchar("status").notNull().default("active"), // active | superseded | withdrawn
  enteredByUserId: varchar("entered_by_user_id").notNull().references(() => users.id),
  enteredByRole: varchar("entered_by_role").notNull(),
  verifiedByUserId: varchar("verified_by_user_id").references(() => users.id),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  disputedAt: timestamp("disputed_at", { withTimezone: true }),
  disputeNote: text("dispute_note"),
  supersedesId: varchar("supersedes_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type HealthEntry = typeof healthEntries.$inferSelect;

export const healthEntryEvents = pgTable("health_entry_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  entryId: varchar("entry_id").notNull().references(() => healthEntries.id),
  action: varchar("action").notNull(),
  actorUserId: varchar("actor_user_id").notNull().references(() => users.id),
  actorRole: varchar("actor_role").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const patientConsents = pgTable("patient_consents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  purpose: varchar("purpose").notNull(),
  version: varchar("version").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const assistGrants = pgTable("assist_grants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  doctorProfileId: varchar("doctor_profile_id").notNull().references(() => doctorProfiles.id),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
