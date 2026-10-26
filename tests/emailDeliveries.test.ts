import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import request from "supertest";
import type { Express } from "express";

let counter = 0;
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async () => ({ data: { id: `msg_test_${Date.now()}_${++counter}` }, error: null }) };
  },
}));

import { getApp, uniqueEmail } from "./helpers";
import { db } from "../server/db";
import { runAsSystem } from "../server/dbContext";
import { emailDeliveries } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sendPasswordResetEmail } from "../server/services/emailService";
import { hashRecipient, verifyWebhookSignature } from "../server/services/emailDeliveries";

const SECRET_BYTES = crypto.randomBytes(24);
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

function signed(payload: unknown, opts: { id?: string; timestamp?: number; secret?: Buffer } = {}) {
  const id = opts.id ?? `evt_${crypto.randomUUID()}`;
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", opts.secret ?? SECRET_BYTES).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { body, headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${sig}`, "content-type": "application/json" } };
}
const post = (app: Express, s: ReturnType<typeof signed>) => request(app).post("/api/webhooks/resend").set(s.headers).send(s.body);
const rowFor = async (messageId: string) => (await runAsSystem(() => db.select().from(emailDeliveries).where(eq(emailDeliveries.providerMessageId, messageId))))[0];

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_WEBHOOK_SECRET;
});

async function sendOne() {
  const to = uniqueEmail("deliv");
  await sendPasswordResetEmail(to, "Layla", "https://avela.example/reset?token=abc", "en");
  const rows = await runAsSystem(() => db.select().from(emailDeliveries).where(eq(emailDeliveries.recipientHash, hashRecipient(to))));
  expect(rows).toHaveLength(1);
  return { to, row: rows[0] };
}

describe("email delivery evidence", () => {
  it("records only that the provider ACCEPTED a message, with no address and no content", async () => {
    const { to, row } = await sendOne();
    expect(row.status).toBe("accepted");
    expect(row.purpose).toBe("password_reset");
    expect(JSON.stringify(row)).not.toContain(to);
    expect(JSON.stringify(row)).not.toContain("avela.example");
    expect(row.recipientHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("becomes 'delivered' only when the provider's signed webhook says so", async () => {
    const { row } = await sendOne();
    const res = await post(app, signed({ type: "email.delivered", data: { email_id: row.providerMessageId } }));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("applied");
    expect((await rowFor(row.providerMessageId)).status).toBe("delivered");
  });

  it("records a bounce with its kind, and a later 'delayed' cannot undo a delivery", async () => {
    const a = (await sendOne()).row;
    await post(app, signed({ type: "email.bounced", data: { email_id: a.providerMessageId, bounce: { type: "Permanent" } } }));
    expect(await rowFor(a.providerMessageId)).toMatchObject({ status: "bounced", statusDetail: "Permanent" });

    const b = (await sendOne()).row;
    await post(app, signed({ type: "email.delivered", data: { email_id: b.providerMessageId } }));
    const late = await post(app, signed({ type: "email.delivery_delayed", data: { email_id: b.providerMessageId } }));
    expect(late.body.outcome).toBe("ignored");
    expect((await rowFor(b.providerMessageId)).status).toBe("delivered");
  });

  it("applies a redelivered event once", async () => {
    const { row } = await sendOne();
    const event = signed({ type: "email.delivered", data: { email_id: row.providerMessageId } });
    expect((await post(app, event)).body.outcome).toBe("applied");
    expect((await post(app, event)).body.outcome).toBe("duplicate");
  });

  it("refuses a wrong signature, a stale timestamp, a tampered body and a missing signature", async () => {
    const { row } = await sendOne();
    const payload = { type: "email.delivered", data: { email_id: row.providerMessageId } };
    expect((await post(app, signed(payload, { secret: crypto.randomBytes(24) }))).status).toBe(401);
    expect((await post(app, signed(payload, { timestamp: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(401);
    const ok = signed(payload);
    const tampered = await request(app).post("/api/webhooks/resend").set(ok.headers).send(JSON.stringify({ ...payload, data: { email_id: "someone-else" } }));
    expect(tampered.status).toBe(401);
    expect((await request(app).post("/api/webhooks/resend").set("content-type", "application/json").send(ok.body)).status).toBe(401);
    expect((await rowFor(row.providerMessageId)).status).toBe("accepted"); // none of them changed anything
  });

  it("is switched off, not open, until a webhook secret is configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await request(app).post("/api/webhooks/resend").set("content-type", "application/json").send("{}");
    expect(res.status).toBe(503);
    expect(verifyWebhookSignature("{}", { "svix-id": "x", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,AAAA" })).toBe(false);
  });

  it("ignores events for messages we never sent and event types we do not track", async () => {
    expect((await post(app, signed({ type: "email.delivered", data: { email_id: "never-sent" } }))).body.outcome).toBe("unknown_message");
    expect((await post(app, signed({ type: "email.opened", data: { email_id: "x" } }))).body.outcome).toBe("ignored");
  });
});

describe("review findings: the webhook", () => {
  it("does not use up an event for a message it has not recorded yet: the provider's retry still works", async () => {
    const id = `msg_later_${Date.now()}`;
    const event = signed({ type: "email.delivered", data: { email_id: id } });
    expect((await post(app, event)).body.outcome).toBe("unknown_message");
    await runAsSystem(() => db.insert(emailDeliveries).values({ providerMessageId: id, purpose: "password_reset", recipientHash: "x".repeat(64) }));
    expect((await post(app, event)).body.outcome).toBe("applied"); // the same event, retried
    expect((await rowFor(id)).status).toBe("delivered");
  });

  it("refuses to treat a near-empty secret as a secret", async () => {
    const weak = ["whsec_", "whsec_AAAA", "   "];
    for (const secret of weak) {
      process.env.RESEND_WEBHOOK_SECRET = secret;
      const body = JSON.stringify({ type: "email.delivered", data: { email_id: "x" } });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = crypto.createHmac("sha256", Buffer.alloc(0)).update(`evt_1.${ts}.${body}`).digest("base64");
      const res = await request(app).post("/api/webhooks/resend").set({ "svix-id": "evt_1", "svix-timestamp": ts, "svix-signature": `v1,${sig}`, "content-type": "application/json" }).send(body);
      expect([401, 503]).toContain(res.status);
    }
  });
});
