import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { users } from "./users";
import { medications } from "./health";

export const medicationReminders = pgTable("medication_reminders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  medicationId: varchar("medication_id").notNull().references(() => medications.id),
  times: jsonb("times").$type<string[]>().notNull(),
  weekdays: jsonb("weekdays").$type<number[]>().notNull().default([0, 1, 2, 3, 4, 5, 6]),
  timezone: varchar("timezone").notNull(),
  startDate: varchar("start_date").notNull(),
  endDate: varchar("end_date"),
  enabled: boolean("enabled").notNull().default(true),
  emailEnabled: boolean("email_enabled").notNull().default(false),
  showMedicationName: boolean("show_medication_name").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_medication_reminders_one_per_medication").on(table.medicationId),
  index("idx_medication_reminders_patient").on(table.patientUserId),
]);

export const reminderDeliveries = pgTable("reminder_deliveries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reminderId: varchar("reminder_id").notNull().references(() => medicationReminders.id, { onDelete: "cascade" }),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  channel: varchar("channel").notNull(),
  status: varchar("status").notNull().default("pending"),
  errorCode: varchar("error_code"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  sentAt: timestamp("sent_at"),
  attempts: integer("attempts").notNull().default(1),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_reminder_deliveries_once").on(table.reminderId, table.dueAt, table.channel),
]);

export const jobRuns = pgTable("job_runs", {
  job: varchar("job").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  lastResult: jsonb("last_result").$type<Record<string, unknown>>().notNull().default({}),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: varchar("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  // Only the run holding the lease may execute and record an outcome.
  leaseRunId: varchar("lease_run_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
});

// One row per scheduler call: the evidence that runs are really happening.
export const jobRunHistory = pgTable("job_run_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  job: varchar("job").notNull(),
  runId: varchar("run_id").notNull(),
  source: varchar("source").notNull().default("unknown"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  outcome: varchar("outcome").notNull().default("running"), // running | ok | failed | skipped_overlap | superseded
  durationMs: integer("duration_ms"),
  error: varchar("error"),
  result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
});

// A person's request about their own data. Erasure is done by an operator.
export const dataRequests = pgTable("data_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  kind: varchar("kind").notNull(), // export | deletion
  status: varchar("status").notNull().default("open"), // open | done
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export type MedicationReminder = typeof medicationReminders.$inferSelect;
export type InsertMedicationReminder = typeof medicationReminders.$inferInsert;

export const PERSONAL_KINDS = ["medication", "appointment", "task", "bill", "subscription", "other"] as const;
export type PersonalKind = (typeof PERSONAL_KINDS)[number];

export const personalReminders = pgTable("personal_reminders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  patientUserId: varchar("patient_user_id").notNull().references(() => users.id),
  kind: varchar("kind").notNull(),
  title: varchar("title", { length: 120 }).notNull(),
  notes: text("notes"),
  recurrence: varchar("recurrence"),
  times: jsonb("times").$type<string[]>().notNull().default(["09:00"]),
  weekdays: jsonb("weekdays").$type<number[]>().notNull().default([0, 1, 2, 3, 4, 5, 6]),
  anchorDate: varchar("anchor_date"),
  startDate: varchar("start_date"),
  endDate: varchar("end_date"),
  timezone: varchar("timezone").notNull(),
  renewalDate: varchar("renewal_date"),
  renewalInterval: varchar("renewal_interval"),
  offsetsDays: jsonb("offsets_days").$type<number[]>().notNull().default([3]),
  cancelByDate: varchar("cancel_by_date"),
  amountMinor: bigint("amount_minor", { mode: "number" }),
  currency: varchar("currency", { length: 3 }),
  healthEntryId: varchar("health_entry_id"),
  status: varchar("status").notNull().default("active"),
  emailEnabled: boolean("email_enabled").notNull().default(false),
  showTitleInEmail: boolean("show_title_in_email").notNull().default(false),
  quietStart: varchar("quiet_start"),
  quietEnd: varchar("quiet_end"),
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type PersonalReminder = typeof personalReminders.$inferSelect;

export const personalReminderDeliveries = pgTable("personal_reminder_deliveries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reminderId: varchar("reminder_id").notNull().references(() => personalReminders.id, { onDelete: "cascade" }),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  channel: varchar("channel").notNull(),
  status: varchar("status").notNull().default("pending"),
  occurrence: varchar("occurrence").notNull().default("due"),
  offsetDays: integer("offset_days"),
  errorCode: varchar("error_code"),
  attempts: integer("attempts").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("personal_reminder_deliveries_once").on(t.reminderId, t.dueAt, t.channel)]);
