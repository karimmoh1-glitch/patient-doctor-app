import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { users } from "./users";

// In-app notifications. Stores a kind and small parameters rather than text,
// so wording is chosen in the reader's language at display time and nothing
// sensitive is duplicated into a second table.
export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  kind: varchar("kind").notNull(),
  params: jsonb("params").$type<Record<string, string | number>>().notNull().default({}),
  link: varchar("link"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  readAt: timestamp("read_at"),
}, (table) => [
  index("idx_notifications_user").on(table.userId, table.createdAt),
]);

export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = typeof notifications.$inferInsert;
