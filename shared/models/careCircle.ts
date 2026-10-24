import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, varchar, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./users";

// A trusted person a patient has invited into their Care Circle. Modeled
// like pairingRequests (invite -> respond -> active), but the relationship
// is patient-initiated and permission-scoped rather than a clinical match.
// caregiverUserId is null until the invite is accepted and a caregiver
// account exists to attach it to.
export const careCircleMembers = pgTable("care_circle_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  caregiverUserId: varchar("caregiver_user_id").references(() => users.id),
  name: text("name").notNull(),
  inviteEmail: varchar("invite_email").notNull(),
  relationshipLabel: varchar("relationship_label").notNull(), // e.g. "Daughter"
  // Granular, patient-controlled — never a blanket "full access" default.
  permissionMedicationStatus: boolean("permission_medication_status").notNull().default(true),
  permissionAppointments: boolean("permission_appointments").notNull().default(true),
  permissionDeliveryStatus: boolean("permission_delivery_status").notNull().default(true),
  permissionDocuments: boolean("permission_documents").notNull().default(false),
  permissionFullRecords: boolean("permission_full_records").notNull().default(false),
  status: varchar("status").notNull().default("invited"), // invited | active | revoked
  tokenHash: varchar("token_hash").unique(),
  invitedAt: timestamp("invited_at").defaultNow(),
  respondedAt: timestamp("responded_at"),
}, (table) => [
  index("idx_care_circle_patient").on(table.patientUserId),
  index("idx_care_circle_caregiver").on(table.caregiverUserId),
]);

export const insertCareCircleMemberSchema = createInsertSchema(careCircleMembers).omit({
  id: true, invitedAt: true, respondedAt: true, status: true, caregiverUserId: true,
});

export type CareCircleMember = typeof careCircleMembers.$inferSelect;
export type InsertCareCircleMember = z.infer<typeof insertCareCircleMemberSchema>;
