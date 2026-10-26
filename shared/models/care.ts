import { sql } from "drizzle-orm";
import { index, uniqueIndex, jsonb, pgTable, primaryKey, text, timestamp, varchar, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./users";

// A doctor's self-signup request, pending admin review before any account
// or public profile exists — same shape as InternOps's `applications`
// pending-approval pattern. Admin approval here is a manual trust
// decision for v1; there is no integration with a license-verification
// registry (that's a legal/business process, not something code can do).
export const doctorApplications = pgTable("doctor_applications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // The doctor's account. Exists from registration, but confers no clinical
  // access until this application is approved.
  userId: varchar("user_id").references(() => users.id),
  name: text("name").notNull(),
  displayName: text("display_name"),
  email: varchar("email").notNull(),
  // Legacy: new registrations keep the password only on the user row.
  passwordHash: varchar("password_hash"),
  professionalRole: varchar("professional_role"),
  licenseNumber: varchar("license_number"),
  licensingBody: text("licensing_body"),
  // Captured as an array for future multi-state support, though v1
  // matching only ever uses doctorProfiles.state (the primary state).
  licensedStates: jsonb("licensed_states").$type<string[]>(),
  npiNumber: varchar("npi_number"),
  specialty: varchar("specialty"),
  qualifications: text("qualifications"),
  languages: jsonb("languages").$type<string[]>().notNull().default([]),
  yearsExperience: integer("years_experience"),
  clinic: text("clinic"),
  modalities: jsonb("modalities").$type<string[]>().notNull().default(["phone"]),
  phone: varchar("phone"),
  bio: text("bio"),
  // incomplete | pending | needs_info | approved | rejected | suspended
  status: varchar("status").notNull().default("pending"),
  // What the reviewer asked the applicant to supply (status needs_info).
  infoRequest: text("info_request"),
  reviewerNotes: text("reviewer_notes"),
  reviewedByUserId: varchar("reviewed_by_user_id").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  submittedAt: timestamp("submitted_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_doctor_applications_status").on(table.status),
]);

// A doctor listed in the directory patients can be matched to. userId is
// nullable because seeded demo doctors have no login — only doctors who
// came through the application-approval flow get a linked user account.
export const doctorProfiles = pgTable("doctor_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  name: text("name").notNull(),
  specialty: varchar("specialty").notNull(),
  // Single primary practicing state — telehealth licensure generally
  // requires a doctor to be licensed in the state the patient is
  // physically in, so matching is a hard filter on this column.
  state: varchar("state").notNull(),
  licenseNumber: varchar("license_number"),
  npiNumber: varchar("npi_number"),
  phone: varchar("phone").notNull(),
  bio: text("bio"),
  // Directory visibility toggle — lets a profile be hidden without
  // deleting it (e.g. a doctor pausing availability).
  active: boolean("active").notNull().default(true),
  source: varchar("source").notNull().default("seed"), // seed | application
  // IANA zone the doctor's availability windows are written in. Appointment
  // instants are stored in UTC; this is only how "9:00–12:00 on Tuesdays"
  // is interpreted (so daylight-saving changes move the UTC time, not the
  // doctor's working hours).
  timezone: varchar("timezone").notNull().default("America/New_York"),
  languages: jsonb("languages").$type<string[]>().notNull().default([]),
  modalities: jsonb("modalities").$type<string[]>().notNull().default(["phone"]),
  clinic: text("clinic"),
  qualifications: text("qualifications"),
  yearsExperience: integer("years_experience"),
  licensingBody: text("licensing_body"),
  professionalRole: varchar("professional_role"),
  // Set only when an administrator approved the profile.
  verifiedAt: timestamp("verified_at"),
  verifiedByUserId: varchar("verified_by_user_id").references(() => users.id),
  // Earliest expiry among the verified licences; the profile is not listed once it passes. Null: nothing recorded.
  credentialExpiresAt: timestamp("credential_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_doctor_profiles_state_specialty").on(table.state, table.specialty),
]);

// A doctor's recurring weekly working windows, in the doctor's own time zone.
// A doctor with NO rows has published no availability: the app offers no
// bookable times for them and says so — it never invents open slots.
export const doctorAvailability = pgTable("doctor_availability", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  doctorProfileId: varchar("doctor_profile_id").notNull().references(() => doctorProfiles.id),
  weekday: integer("weekday").notNull(), // 0 = Sunday … 6 = Saturday
  startMinute: integer("start_minute").notNull(), // minutes after local midnight
  endMinute: integer("end_minute").notNull(),
}, (table) => [
  index("idx_doctor_availability_doctor").on(table.doctorProfileId),
]);

// PHI-bearing: what a patient told the app is wrong, and where they were
// when they said it. State is captured at submission time (not read from
// the user's profile at match time) because it's the value actually used
// for matching and must stay accurate even if a profile is edited later.
export const symptomReports = pgTable("symptom_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  state: varchar("state").notNull(),
  symptomText: text("symptom_text").notNull(),
  inputMethod: varchar("input_method").notNull(), // typed | voice
  transcriptionProvider: varchar("transcription_provider"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_symptom_reports_patient").on(table.patientUserId),
]);

// A patient's request to connect with a specific doctor, and the doctor's
// response. The doctor's phone number is only ever revealed to the
// patient once status = "accepted" — enforced server-side in the route
// handler, not just hidden client-side.
export const pairingRequests = pgTable("pairing_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  doctorProfileId: varchar("doctor_profile_id").notNull().references(() => doctorProfiles.id),
  // Ties the request to the reason it was made, for the audit trail —
  // nullable since a request could in principle be made without one.
  symptomReportId: varchar("symptom_report_id").references(() => symptomReports.id),
  status: varchar("status").notNull().default("requested"), // requested | accepted | declined | cancelled | ended
  // Patient-set label for the Care Team view (e.g. "Primary Care",
  // "Specialist", "Dentist") — falls back to the doctor's specialty in the
  // UI when null, so setting one is optional.
  relationshipLabel: varchar("relationship_label"),
  // How the connection began: the patient asked ("request"), or the patient confirmed a clinician's invitation ("invitation").
  connectedVia: varchar("connected_via").notNull().default("request"),
  invitationId: varchar("invitation_id"),
  requestedAt: timestamp("requested_at").defaultNow(),
  respondedAt: timestamp("responded_at"),
}, (table) => [
  index("idx_pairing_requests_patient").on(table.patientUserId),
  index("idx_pairing_requests_doctor").on(table.doctorProfileId),
  // DB-enforced guard against duplicate concurrent requests to the same
  // doctor — an app-level check alone can't prevent a race between two
  // near-simultaneous requests, same rationale as InternOps's one-active-
  // work-session unique index.
  uniqueIndex("idx_pairing_requests_one_open_per_pair")
    .on(table.patientUserId, table.doctorProfileId)
    .where(sql`${table.status} IN ('requested', 'accepted')`),
]);

// A chat message between a patient and doctor — only ever exchanged once
// pairingRequests.status = "accepted" (enforced in the route handler, not
// just hidden client-side, same pattern as the doctor's phone reveal).
// PHI-bearing like symptomReports, since a patient may describe symptoms
// here too — redacted from server logs the same way (see server/index.ts).
export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  pairingRequestId: varchar("pairing_request_id").notNull().references(() => pairingRequests.id),
  senderUserId: varchar("sender_user_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  // Idempotency key supplied by the sender's app, so a retried send never duplicates.
  clientMessageId: varchar("client_message_id"),
  // Set only by what the recipient's app actually did: it fetched the conversation / it reported the conversation was opened.
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (table) => [
  index("idx_messages_pairing").on(table.pairingRequestId, table.createdAt),
]);

export const insertMessageSchema = createInsertSchema(messages).omit({ id: true, createdAt: true, deliveredAt: true, readAt: true });
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export const insertDoctorProfileSchema = createInsertSchema(doctorProfiles).omit({ id: true, createdAt: true });
export const insertSymptomReportSchema = createInsertSchema(symptomReports).omit({ id: true, createdAt: true });
export const insertPairingRequestSchema = createInsertSchema(pairingRequests).omit({ id: true, requestedAt: true, respondedAt: true, status: true });

export type DoctorApplication = typeof doctorApplications.$inferSelect;
export type InsertDoctorApplication = typeof doctorApplications.$inferInsert;
export type DoctorAvailability = typeof doctorAvailability.$inferSelect;
export type DoctorProfile = typeof doctorProfiles.$inferSelect;
export type InsertDoctorProfile = typeof doctorProfiles.$inferInsert;
export type SymptomReport = typeof symptomReports.$inferSelect;
export type InsertSymptomReport = z.infer<typeof insertSymptomReportSchema>;
export type PairingRequest = typeof pairingRequests.$inferSelect;
export type InsertPairingRequest = z.infer<typeof insertPairingRequestSchema>;

// A report of abusive or unsafe behaviour in a conversation. The reporter chooses whether to attach the message text.
export const messageReports = pgTable("message_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reporterUserId: varchar("reporter_user_id").notNull().references(() => users.id),
  pairingRequestId: varchar("pairing_request_id").notNull().references(() => pairingRequests.id),
  messageId: varchar("message_id").references(() => messages.id),
  reason: varchar("reason").notNull(),
  details: text("details"),
  sharedText: text("shared_text"),
  status: varchar("status").notNull().default("open"), // open | resolved
  resolvedByUserId: varchar("resolved_by_user_id").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionNote: text("resolution_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type MessageReport = typeof messageReports.$inferSelect;

export const userBlocks = pgTable("user_blocks", {
  blockerUserId: varchar("blocker_user_id").notNull().references(() => users.id),
  blockedUserId: varchar("blocked_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.blockerUserId, t.blockedUserId] })]);

export const emailDeliveries = pgTable("email_deliveries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  provider: text("provider").notNull().default("resend"),
  providerMessageId: text("provider_message_id").notNull(),
  purpose: text("purpose").notNull(),
  recipientHash: text("recipient_hash").notNull(),
  status: text("status").notNull().default("accepted"), // accepted | delayed | delivered | bounced | complained | failed
  statusDetail: text("status_detail"),
  lastEventId: text("last_event_id"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  statusAt: timestamp("status_at", { withTimezone: true }).notNull().defaultNow(),
});
export type EmailDelivery = typeof emailDeliveries.$inferSelect;

export const emailWebhookEvents = pgTable("email_webhook_events", {
  eventId: text("event_id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const CREDENTIAL_STATUSES = ["submitted", "pending", "verified", "rejected", "suspended", "expired"] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];
export const CREDENTIAL_SOURCES = ["document_review", "registry_lookup", "issuer_confirmation"] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

export const doctorCredentials = pgTable("doctor_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").notNull().references(() => doctorApplications.id),
  userId: varchar("user_id").references(() => users.id),
  kind: varchar("kind").notNull(), // license | npi
  identifier: varchar("identifier").notNull(),
  jurisdiction: varchar("jurisdiction"),
  issuer: text("issuer"),
  status: varchar("status").notNull().default("pending"),
  source: varchar("source"),
  evidenceNote: text("evidence_note"),
  reviewerUserId: varchar("reviewer_user_id").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type DoctorCredential = typeof doctorCredentials.$inferSelect;

export const credentialEvents = pgTable("credential_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  credentialId: varchar("credential_id").notNull().references(() => doctorCredentials.id),
  fromStatus: varchar("from_status"),
  toStatus: varchar("to_status").notNull(),
  actorUserId: varchar("actor_user_id").references(() => users.id),
  source: varchar("source"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pairingInvitations = pgTable("pairing_invitations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  doctorProfileId: varchar("doctor_profile_id").notNull().references(() => doctorProfiles.id),
  createdByUserId: varchar("created_by_user_id").notNull().references(() => users.id),
  tokenHash: varchar("token_hash").notNull(),
  codeHash: varchar("code_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  status: varchar("status").notNull().default("pending"), // pending | accepted | revoked
  acceptedByUserId: varchar("accepted_by_user_id").references(() => users.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  pairingRequestId: varchar("pairing_request_id").references(() => pairingRequests.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type PairingInvitation = typeof pairingInvitations.$inferSelect;
