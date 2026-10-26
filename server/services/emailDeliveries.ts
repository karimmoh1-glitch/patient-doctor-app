import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { runAsSystem } from "../dbContext";
import { emailDeliveries, emailWebhookEvents } from "@shared/schema";

/**
 * What we can honestly say about an email. The provider accepting a message is not delivery; only its signed webhook
 * reports delivery, a delay, a bounce or a complaint. Nothing is stored that identifies the recipient or the content.
 */

export type EmailStatus = "accepted" | "delayed" | "delivered" | "bounced" | "complained" | "failed";

/** A status never moves "backwards": a late 'delayed' cannot undo 'delivered'. A complaint or bounce after delivery is allowed. */
const RANK: Record<EmailStatus, number> = { accepted: 0, delayed: 1, delivered: 2, bounced: 3, complained: 3, failed: 3 };

const EVENT_STATUS: Record<string, EmailStatus> = {
  "email.sent": "accepted",
  "email.delivery_delayed": "delayed",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
};

export function hashRecipient(address: string): string {
  const key = process.env.JWT_SECRET || "dev-secret-change-me";
  return crypto.createHmac("sha256", key).update(`email-recipient:${address.trim().toLowerCase()}`).digest("hex");
}

/** Called when the provider accepted a message. Never throws: bookkeeping must not turn a sent email into an error. */
export async function recordAccepted(input: { providerMessageId: string; purpose: string; to: string }): Promise<void> {
  try {
    await runAsSystem(() =>
      db
        .insert(emailDeliveries)
        .values({ providerMessageId: input.providerMessageId, purpose: input.purpose, recipientHash: hashRecipient(input.to) })
        .onConflictDoNothing(),
    );
  } catch (err: any) {
    console.error("[email] could not record delivery evidence:", err?.name || "Error");
  }
}

// ---------------------------------------------------------------------------------------------- signature (Svix, used by Resend)

const TOLERANCE_SECONDS = 5 * 60;

export function webhookSecretConfigured(): boolean {
  return !!process.env.RESEND_WEBHOOK_SECRET;
}

/** True only if the body was signed with our webhook secret, recently, with a constant-time comparison. */
export function verifyWebhookSignature(rawBody: Buffer | string, headers: Record<string, unknown>, now = Date.now()): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;
  const id = String(headers["svix-id"] ?? "");
  const timestamp = String(headers["svix-timestamp"] ?? "");
  const signatures = String(headers["svix-signature"] ?? "");
  if (!id || !timestamp || !signatures) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  for (const part of signatures.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return true;
  }
  return false;
}

export type WebhookOutcome = "applied" | "duplicate" | "ignored" | "unknown_message";

/** Applies one verified event. Safe to call twice with the same event id. */
export async function applyWebhookEvent(eventId: string, payload: any): Promise<WebhookOutcome> {
  const status = EVENT_STATUS[String(payload?.type ?? "")];
  const messageId = typeof payload?.data?.email_id === "string" ? payload.data.email_id : null;
  if (!status || !messageId) return "ignored";
  return runAsSystem(async () => {
    const fresh = await db.insert(emailWebhookEvents).values({ eventId }).onConflictDoNothing().returning({ id: emailWebhookEvents.eventId });
    if (fresh.length === 0) return "duplicate" as const;
    const [row] = await db.select().from(emailDeliveries).where(and(eq(emailDeliveries.provider, "resend"), eq(emailDeliveries.providerMessageId, messageId)));
    if (!row) return "unknown_message" as const;
    if (RANK[status] <= RANK[row.status as EmailStatus] && status !== row.status) return "ignored" as const;
    const detail = typeof payload?.data?.bounce?.type === "string" ? String(payload.data.bounce.type).slice(0, 60) : null;
    await db.update(emailDeliveries).set({ status, statusDetail: detail, lastEventId: eventId, statusAt: new Date() }).where(eq(emailDeliveries.id, row.id));
    return "applied" as const;
  });
}

/** Counts by status, for the operations screen. */
export async function emailDeliverySummary(days = 7): Promise<Record<EmailStatus, number>> {
  const rows = await runAsSystem(() =>
    db
      .select({ status: emailDeliveries.status, n: sql<number>`count(*)::int` })
      .from(emailDeliveries)
      .where(sql`${emailDeliveries.acceptedAt} > now() - make_interval(days => ${days})`)
      .groupBy(emailDeliveries.status),
  );
  const out: Record<EmailStatus, number> = { accepted: 0, delayed: 0, delivered: 0, bounced: 0, complained: 0, failed: 0 };
  for (const r of rows) out[r.status as EmailStatus] = r.n;
  return out;
}
