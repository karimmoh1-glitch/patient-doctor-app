import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { users } from "./users";

export const organizations = pgTable("organizations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 160 }).notNull(),
  kind: varchar("kind").notNull(), // clinic | hospital | practice
  country: varchar("country", { length: 2 }).notNull(),
  contactEmail: varchar("contact_email"),
  contactPhone: varchar("contact_phone"),
  address: text("address"),
  status: varchar("status").notNull().default("unverified"), // unverified | verified | suspended
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  verifiedByUserId: varchar("verified_by_user_id").references(() => users.id),
  verificationSource: varchar("verification_source"),
  verificationNote: text("verification_note"),
  createdByUserId: varchar("created_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type Organization = typeof organizations.$inferSelect;

export const orgMemberships = pgTable("org_memberships", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id),
  userId: varchar("user_id").notNull().references(() => users.id),
  role: varchar("role").notNull(),
  status: varchar("status").notNull().default("active"),
  invitedByUserId: varchar("invited_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: varchar("revoked_by_user_id").references(() => users.id),
}, (t) => [index("org_memberships_user_idx").on(t.userId, t.status)]);
export type OrgMembership = typeof orgMemberships.$inferSelect;

export const orgInvitations = pgTable("org_invitations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id),
  email: varchar("email").notNull(),
  role: varchar("role").notNull(),
  tokenHash: varchar("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  status: varchar("status").notNull().default("pending"),
  invitedByUserId: varchar("invited_by_user_id").notNull().references(() => users.id),
  acceptedByUserId: varchar("accepted_by_user_id").references(() => users.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgTasks = pgTable("org_tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  title: varchar("title", { length: 200 }).notNull(),
  dueDate: varchar("due_date"),
  status: varchar("status").notNull().default("open"),
  assignedToUserId: varchar("assigned_to_user_id").references(() => users.id),
  createdByUserId: varchar("created_by_user_id").notNull().references(() => users.id),
  completedByUserId: varchar("completed_by_user_id").references(() => users.id),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type OrgTask = typeof orgTasks.$inferSelect;

export const orgNotes = pgTable("org_notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: varchar("org_id").notNull().references(() => organizations.id),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  authorUserId: varchar("author_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type OrgNote = typeof orgNotes.$inferSelect;

void boolean;
