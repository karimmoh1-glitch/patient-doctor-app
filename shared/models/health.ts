import { sql } from "drizzle-orm";
import { index, uniqueIndex, jsonb, pgTable, text, timestamp, varchar, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./users";
import { pairingRequests, doctorProfiles } from "./care";

// ---------------------------------------------------------------------------
// Appointments — scoped to an accepted pairing (the only relationship that
// already implies mutual consent + PHI access). patientUserId/doctorProfileId
// are denormalized off pairingRequests for direct dashboard queries, same
// pattern symptomReports already uses for patientUserId.
// ---------------------------------------------------------------------------
export const appointments = pgTable("appointments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  pairingRequestId: varchar("pairing_request_id").notNull().references(() => pairingRequests.id),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  doctorProfileId: varchar("doctor_profile_id").notNull().references(() => doctorProfiles.id),
  type: varchar("type").notNull().default("Phone Call"), // Phone Call | In-Person (Video Visit only once a video provider exists)
  reason: text("reason").notNull(),
  scheduledAt: timestamp("scheduled_at").notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(30),
  status: varchar("status").notNull().default("requested"), // requested | confirmed | completed | cancelled
  // Patient-authored, editable up until the appointment happens — feeds the
  // "Prepare for my appointment" screen.
  questionsForDoctor: jsonb("questions_for_doctor").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  // Doctor-authored after the visit — demo clinical documentation, never
  // AI-generated. Feeds the health timeline and the follow-up engine.
  doctorNotes: text("doctor_notes"),
  followUpInstructions: text("follow_up_instructions"),
  followUpDate: timestamp("follow_up_date"),
  // Set once the "visit coming up" notice has gone out; cleared if the visit is moved.
  reminderSentAt: timestamp("reminder_sent_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_appointments_patient").on(table.patientUserId, table.scheduledAt),
  index("idx_appointments_doctor").on(table.doctorProfileId, table.scheduledAt),
  // Last line of defence against double-booking: two live appointments can
  // never start at the same instant for one doctor, whatever the app code
  // does. (Overlap with different start times is prevented by the booking
  // transaction, which locks the doctor's row.)
  uniqueIndex("idx_appointments_doctor_start_live")
    .on(table.doctorProfileId, table.scheduledAt)
    .where(sql`${table.status} IN ('requested', 'confirmed')`),
]);

// ---------------------------------------------------------------------------
// Prescriptions — doctor-authored, demo/fictional only. Instructions and
// medication names are free text the doctor enters; nothing here is
// AI-generated or inferred, and the app never invents dosing on its own.
// ---------------------------------------------------------------------------
export const prescriptions = pgTable("prescriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  pairingRequestId: varchar("pairing_request_id").notNull().references(() => pairingRequests.id),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  doctorProfileId: varchar("doctor_profile_id").notNull().references(() => doctorProfiles.id),
  appointmentId: varchar("appointment_id").references(() => appointments.id),
  medicationName: text("medication_name").notNull(),
  instructions: text("instructions").notNull(),
  frequencyPerDay: integer("frequency_per_day").notNull().default(1),
  durationDays: integer("duration_days"),
  quantity: integer("quantity"),
  refillsAllowed: integer("refills_allowed").notNull().default(0),
  refillsUsed: integer("refills_used").notNull().default(0),
  notes: text("notes"),
  activeIngredient: text("active_ingredient"),
  strength: text("strength"),
  formulation: text("formulation"),
  dose: text("dose"),
  route: text("route"),
  warnings: text("warnings"),
  // draft | active (= authorized) | completed | expired | cancelled
  status: varchar("status").notNull().default("active"),
  startDate: timestamp("start_date").notNull().defaultNow(),
  endDate: timestamp("end_date"),
  issuedAt: timestamp("issued_at"),
  authorizedAt: timestamp("authorized_at"),
  authorizedByUserId: varchar("authorized_by_user_id").references(() => users.id),
  // not_sent until a real pharmacy integration confirms otherwise.
  transmission: varchar("transmission").notNull().default("not_sent"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_prescriptions_patient").on(table.patientUserId, table.createdAt),
]);

// Append-only record of what happened to a prescription and who did it.
export const prescriptionEvents = pgTable("prescription_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  prescriptionId: varchar("prescription_id").notNull().references(() => prescriptions.id),
  actorUserId: varchar("actor_user_id").references(() => users.id),
  event: varchar("event").notNull(), // drafted | edited | authorized | cancelled | expired
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_prescription_events_rx").on(table.prescriptionId, table.createdAt),
]);

// ---------------------------------------------------------------------------
// Medications — a patient's tracked daily schedule, created by "adding" an
// active prescription to tracking. Kept separate from prescriptions so a
// cancelled/expired prescription doesn't retroactively wipe history.
// ---------------------------------------------------------------------------
export const medications = pgTable("medications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  prescriptionId: varchar("prescription_id").notNull().references(() => prescriptions.id),
  name: text("name").notNull(),
  instructions: text("instructions").notNull(),
  // Local "HH:mm" times, e.g. ["08:00", "20:00"] — derived once from
  // frequencyPerDay at add-time, editable afterward.
  scheduleTimes: jsonb("schedule_times").$type<string[]>().notNull(),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  uniqueIndex("idx_medications_one_per_prescription").on(table.prescriptionId),
  index("idx_medications_patient").on(table.patientUserId, table.active),
]);

// A recorded dose event. Only written when the patient actually acts on a
// dose (taken/skipped) — "upcoming" doses are computed on read from
// medications.scheduleTimes rather than pre-populated as rows.
export const medicationLogs = pgTable("medication_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  medicationId: varchar("medication_id").notNull().references(() => medications.id),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  doseDate: varchar("dose_date").notNull(), // "YYYY-MM-DD"
  doseTime: varchar("dose_time").notNull(), // "HH:mm", one of the medication's scheduleTimes
  status: varchar("status").notNull().default("taken"), // taken | skipped
  recordedAt: timestamp("recorded_at").defaultNow(),
}, (table) => [
  uniqueIndex("idx_medication_logs_slot").on(table.medicationId, table.doseDate, table.doseTime),
  index("idx_medication_logs_patient_date").on(table.patientUserId, table.doseDate),
]);

// ---------------------------------------------------------------------------
// Pharmacy — explicitly a DEMO fulfillment simulation, never a real order.
// ---------------------------------------------------------------------------
export const pharmacies = pgTable("pharmacies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  address: text("address").notNull(),
  city: varchar("city").notNull(),
  state: varchar("state").notNull(),
  zip: varchar("zip").notNull(),
  phone: varchar("phone").notNull(),
  hoursText: text("hours_text"),
  deliveryAvailable: boolean("delivery_available").notNull().default(true),
  pickupAvailable: boolean("pickup_available").notNull().default(true),
  // Rural access intelligence: a nationwide mail-order pharmacy has no
  // meaningful "distance", and is the fallback fulfillment option shown
  // when no local pharmacy is practical — see server/services/fulfillmentService.ts.
  isMailOrder: boolean("is_mail_order").notNull().default(false),
  distanceMiles: integer("distance_miles"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const pharmacyOrders = pgTable("pharmacy_orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  prescriptionId: varchar("prescription_id").notNull().references(() => prescriptions.id),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  pharmacyId: varchar("pharmacy_id").notNull().references(() => pharmacies.id),
  fulfillmentType: varchar("fulfillment_type").notNull(), // pickup | delivery
  deliveryAddress: text("delivery_address"),
  // received -> processing -> preparing -> (ready_for_pickup | out_for_delivery) -> (picked_up | delivered)
  status: varchar("status").notNull().default("received"),
  statusHistory: jsonb("status_history").$type<{ status: string; at: string }[]>().notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_pharmacy_orders_patient").on(table.patientUserId, table.createdAt),
  uniqueIndex("idx_pharmacy_orders_one_per_prescription").on(table.prescriptionId),
]);

// ---------------------------------------------------------------------------
// Documents — patient-owned health records. filePath is null for demo
// seed rows that only carry metadata (no real file to serve).
// ---------------------------------------------------------------------------
export const documents = pgTable("documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  uploadedByUserId: varchar("uploaded_by_user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  category: varchar("category").notNull().default("Other"), // Lab Result | Imaging | Visit Summary | Insurance | Other
  fileName: text("file_name"),
  filePath: text("file_path"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_documents_patient").on(table.patientUserId, table.createdAt),
]);

// ---------------------------------------------------------------------------
// Follow-up engine — organizational tasks derived from doctor instructions,
// prescriptions, or appointments. Never medical advice on its own; just
// turns something a doctor already said into a trackable checklist item.
// ---------------------------------------------------------------------------
export const followUpTasks = pgTable("follow_up_tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  appointmentId: varchar("appointment_id").references(() => appointments.id),
  doctorProfileId: varchar("doctor_profile_id").references(() => doctorProfiles.id),
  title: text("title").notNull(),
  detail: text("detail"),
  dueDate: timestamp("due_date"),
  status: varchar("status").notNull().default("open"), // open | done
  sourceType: varchar("source_type").notNull().default("manual"), // doctor_instruction | medication | appointment | manual
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("idx_follow_up_tasks_patient").on(table.patientUserId, table.status),
]);

// ---------------------------------------------------------------------------
// Privacy Center — patient-controlled sharing of extra data categories with
// a specific doctor, on top of what an accepted pairing already implies
// (messages + the symptom report that led to it). One active grant per
// (patient, doctor) pair; revoking sets revokedAt rather than deleting, so
// the "when access was granted/revoked" history stays visible.
// ---------------------------------------------------------------------------
export const sharingGrants = pgTable("sharing_grants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  sharedWithDoctorProfileId: varchar("shared_with_doctor_profile_id").notNull().references(() => doctorProfiles.id),
  shareMedications: boolean("share_medications").notNull().default(false),
  shareDocuments: boolean("share_documents").notNull().default(false),
  shareAppointments: boolean("share_appointments").notNull().default(false),
  shareFullHistory: boolean("share_full_history").notNull().default(false),
  grantedAt: timestamp("granted_at").defaultNow(),
  revokedAt: timestamp("revoked_at"),
}, (table) => [
  index("idx_sharing_grants_patient").on(table.patientUserId),
  uniqueIndex("idx_sharing_grants_one_active_per_doctor")
    .on(table.patientUserId, table.sharedWithDoctorProfileId)
    .where(sql`${table.revokedAt} is null`),
]);

// ---------------------------------------------------------------------------
// AI assistant — a linear per-user message log. Deliberately simple (no
// threads) since the assistant always re-grounds itself in live app data on
// every turn rather than relying on conversation memory for facts.
// ---------------------------------------------------------------------------
export const aiMessages = pgTable("ai_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  role: varchar("role").notNull(), // user | assistant
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_ai_messages_user").on(table.userId, table.createdAt),
]);

// ---------------------------------------------------------------------------
// Insert schemas / types
// ---------------------------------------------------------------------------
export const insertAppointmentSchema = createInsertSchema(appointments, {
  questionsForDoctor: z.array(z.string()).optional(),
}).omit({ id: true, createdAt: true, status: true, doctorNotes: true, followUpInstructions: true, followUpDate: true });
export const insertPrescriptionSchema = createInsertSchema(prescriptions).omit({ id: true, createdAt: true, refillsUsed: true, status: true });
export const insertMedicationSchema = createInsertSchema(medications, {
  scheduleTimes: z.array(z.string()),
}).omit({ id: true, createdAt: true });
export const insertMedicationLogSchema = createInsertSchema(medicationLogs).omit({ id: true, recordedAt: true });
export const insertPharmacySchema = createInsertSchema(pharmacies).omit({ id: true, createdAt: true });
export const insertPharmacyOrderSchema = createInsertSchema(pharmacyOrders, {
  statusHistory: z.array(z.object({ status: z.string(), at: z.string() })),
}).omit({ id: true, createdAt: true, status: true });
export const insertDocumentSchema = createInsertSchema(documents).omit({ id: true, createdAt: true });
export const insertFollowUpTaskSchema = createInsertSchema(followUpTasks).omit({ id: true, createdAt: true, status: true, completedAt: true });
export const insertSharingGrantSchema = createInsertSchema(sharingGrants).omit({ id: true, grantedAt: true, revokedAt: true });
export const insertAiMessageSchema = createInsertSchema(aiMessages).omit({ id: true, createdAt: true });

export type Appointment = typeof appointments.$inferSelect;
export type InsertAppointment = z.infer<typeof insertAppointmentSchema>;
export type Prescription = typeof prescriptions.$inferSelect;
export type PrescriptionEvent = typeof prescriptionEvents.$inferSelect;
export type InsertPrescription = typeof prescriptions.$inferInsert;
export type Medication = typeof medications.$inferSelect;
export type InsertMedication = z.infer<typeof insertMedicationSchema>;
export type MedicationLog = typeof medicationLogs.$inferSelect;
export type InsertMedicationLog = z.infer<typeof insertMedicationLogSchema>;
export type Pharmacy = typeof pharmacies.$inferSelect;
export type InsertPharmacy = z.infer<typeof insertPharmacySchema>;
export type PharmacyOrder = typeof pharmacyOrders.$inferSelect;
export type InsertPharmacyOrder = z.infer<typeof insertPharmacyOrderSchema>;
export type Document = typeof documents.$inferSelect;
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type FollowUpTask = typeof followUpTasks.$inferSelect;
export type InsertFollowUpTask = z.infer<typeof insertFollowUpTaskSchema>;
export type SharingGrant = typeof sharingGrants.$inferSelect;
export type InsertSharingGrant = z.infer<typeof insertSharingGrantSchema>;
export type AiMessage = typeof aiMessages.$inferSelect;
export type InsertAiMessage = z.infer<typeof insertAiMessageSchema>;
