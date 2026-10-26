import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
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
