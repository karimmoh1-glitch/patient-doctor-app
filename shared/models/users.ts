import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, varchar, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: varchar("email").notNull().unique(),
  passwordHash: varchar("password_hash").notNull(),
  role: varchar("role").notNull().default("patient"), // patient | doctor | admin | caregiver
  // Patient's US state at signup — a doctor account also gets a row here
  // once a doctorApplications approval creates it, but a doctor's
  // *practicing* state lives on doctorProfiles, not here.
  state: varchar("state"),
  phone: varchar("phone"),
  // Interface and message language the person chose (en | ar | es).
  language: varchar("language").notNull().default("en"),
  // A seeded demonstration account. Refused (sign-in and sessions) unless demo mode is on.
  isDemo: boolean("is_demo").notNull().default(false),
  // IANA zone (e.g. "America/Chicago"), learned from the person's browser.
  timezone: varchar("timezone"),
  // Optional patient-entered emergency profile, shown on the SOS page.
  // Nullable — a patient who hasn't filled this in yet just sees the SOS
  // page without an emergency info card, not an error.
  emergencyContactName: text("emergency_contact_name"),
  emergencyContactPhone: varchar("emergency_contact_phone"),
  allergiesText: text("allergies_text"),
  emergencyNotes: text("emergency_notes"),
  createdAt: timestamp("created_at").defaultNow(),
  // Null = active. Set = blocked from login and every authenticated
  // request, checked live on every request (not just at next login).
  deactivatedAt: timestamp("deactivated_at"),
  // Null = unverified. Non-blocking today — verification isn't required to
  // use the app, only tracked.
  emailVerifiedAt: timestamp("email_verified_at"),
});

export const userDevices = pgTable("user_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  // Random token minted server-side at login and embedded as a JWT claim.
  // Never derived from user-agent/IP — those are spoofable client-supplied
  // values and must never be authorization inputs.
  deviceId: varchar("device_id").notNull().unique(),
  name: text("name"),
  platform: text("platform"),
  browser: text("browser"),
  firstSeenAt: timestamp("first_seen_at").defaultNow(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  revokedAt: timestamp("revoked_at"),
}, (table) => [
  index("idx_user_devices_user").on(table.userId),
]);

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").notNull(),
  // Raw token lives only in the email link; only its SHA-256 hash is
  // stored, so a DB read alone can never be used to reset an account.
  tokenHash: varchar("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  tokenHash: varchar("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// Records who accessed what and when. Not every action — specifically the
// points where a specific person reads *another* specific person's health
// information (a doctor or admin viewing a symptom report, a doctor
// viewing a paired patient's profile), which is what HIPAA's audit-control
// requirement (45 CFR §164.312(b)) targets. See server/services/auditService.ts.
export const auditLogs = pgTable("audit_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  actorUserId: varchar("actor_user_id").references(() => users.id),
  // Whose information this event is about (not necessarily who did it).
  subjectUserId: varchar("subject_user_id").references(() => users.id),
  action: varchar("action").notNull(),
  targetType: varchar("target_type"),
  targetId: varchar("target_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_audit_logs_created").on(table.createdAt),
  index("idx_audit_logs_subject_created").on(table.subjectUserId, table.createdAt),
]);

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertUserDeviceSchema = createInsertSchema(userDevices).omit({ id: true, firstSeenAt: true, lastSeenAt: true });
export const insertPasswordResetTokenSchema = createInsertSchema(passwordResetTokens).omit({ id: true, createdAt: true });
export const insertEmailVerificationTokenSchema = createInsertSchema(emailVerificationTokens).omit({ id: true, createdAt: true });
export const insertAuditLogSchema = createInsertSchema(auditLogs).omit({ id: true, createdAt: true });

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type UserDevice = typeof userDevices.$inferSelect;
export type InsertUserDevice = z.infer<typeof insertUserDeviceSchema>;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertPasswordResetToken = z.infer<typeof insertPasswordResetTokenSchema>;
export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type InsertEmailVerificationToken = z.infer<typeof insertEmailVerificationTokenSchema>;
export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
