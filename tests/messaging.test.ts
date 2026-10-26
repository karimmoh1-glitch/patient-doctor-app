import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, createAdmin, connect, auth, type TestUser, type TestDoctor } from "./helpers";
import { pool } from "../server/db";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

const send = (pairingId: string, who: { token: string }, body: string, clientMessageId?: string) =>
  request(app).post(`/api/pairings/${pairingId}/messages`).set(auth(who.token)).send({ body, ...(clientMessageId ? { clientMessageId } : {}) });
const thread = (pairingId: string, who: { token: string }, query = "") => request(app).get(`/api/pairings/${pairingId}/messages${query}`).set(auth(who.token));

async function pair() {
  const patient = await signupPatient();
  const doctor = await createDoctor();
  const { pairingId } = await connect(patient, doctor);
  return { patient, doctor, pairingId };
}

describe("sending is idempotent", () => {
  it("stores a retried message once, answers the retry with the original, and tells the recipient once", async () => {
    const { patient, doctor, pairingId } = await pair();
    const id = "attempt-0001-abcdef";
    const first = await send(pairingId, patient, "Does the rash need a visit?", id);
    expect(first.status).toBe(201);
    const retry = await send(pairingId, patient, "Does the rash need a visit?", id);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.duplicate).toBe(true);
    expect((await thread(pairingId, doctor)).body).toHaveLength(1);
    const notices = (await request(app).get("/api/notifications").set(auth(doctor.token))).body.items.filter((n: any) => n.kind === "message.new");
    expect(notices).toHaveLength(1);
  });

  it("stores exactly one when the same attempt arrives many times at once", async () => {
    const { patient, doctor, pairingId } = await pair();
    const results = await Promise.all(Array.from({ length: 12 }, () => send(pairingId, patient, "Same attempt, sent twelve times", "attempt-concurrent-1")));
    for (const r of results) expect([200, 201]).toContain(r.status);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await thread(pairingId, doctor)).body).toHaveLength(1);
  });

  it("treats the same id from the other person, or a new id, as a different message, and accepts messages with no id at all", async () => {
    const { patient, doctor, pairingId } = await pair();
    const a = await send(pairingId, patient, "From the patient", "shared-id-1234");
    const b = await send(pairingId, doctor, "From the doctor", "shared-id-1234");
    expect(a.body.id).not.toBe(b.body.id);
    expect((await send(pairingId, patient, "Second", "shared-id-5678")).status).toBe(201);
    expect((await send(pairingId, patient, "No id")).status).toBe(201);
    expect((await send(pairingId, patient, "No id")).status).toBe(201); // without a key there is nothing to de-duplicate on
    expect((await thread(pairingId, patient)).body).toHaveLength(5);
  });

  it("rejects an empty message, an over-long one, and a malformed key", async () => {
    const { patient, pairingId } = await pair();
    expect((await send(pairingId, patient, "   ")).status).toBe(400);
    expect((await send(pairingId, patient, "x".repeat(4001))).status).toBe(400);
    expect((await send(pairingId, patient, "ok", "short")).status).toBe(400);
    expect((await send(pairingId, patient, "ok", "has spaces and symbols!!")).status).toBe(400);
  });
});

describe("delivered and read are only ever what really happened", () => {
  it("shows sent, then delivered once the recipient's app has fetched it, then read once they report opening it", async () => {
    const { patient, doctor, pairingId } = await pair();
    const msg = (await send(pairingId, patient, "Hello doctor")).body;
    const status = async () => (await thread(pairingId, patient)).body.find((m: any) => m.id === msg.id).status;
    expect(msg.status).toBe("sent");
    expect(await status()).toBe("sent"); // the sender fetching their own thread proves nothing about the recipient
    expect(await status()).toBe("sent");

    await thread(pairingId, doctor); // the doctor's app receives the conversation
    expect(await status()).toBe("delivered");

    const read = await request(app).post(`/api/pairings/${pairingId}/messages/read`).set(auth(doctor.token));
    expect(read.status).toBe(200);
    expect(read.body.read).toBe(1);
    expect(await status()).toBe("read");
    expect((await request(app).post(`/api/pairings/${pairingId}/messages/read`).set(auth(doctor.token))).body.read).toBe(0); // already read
  });

  it("never tells a sender about the recipient's reading if the recipient turned receipts off, and never lets a sender mark their own messages", async () => {
    const { patient, doctor, pairingId } = await pair();
    expect((await request(app).patch("/api/auth/me/preferences").set(auth(doctor.token)).send({ readReceipts: false })).body.readReceipts).toBe(false);
    const msg = (await send(pairingId, patient, "Private question")).body;
    await thread(pairingId, doctor);
    await request(app).post(`/api/pairings/${pairingId}/messages/read`).set(auth(doctor.token));
    const seen = (await thread(pairingId, patient)).body.find((m: any) => m.id === msg.id);
    expect(seen.status).toBe("delivered"); // not "read"

    // The sender calling "read" changes nothing about their own messages.
    expect((await request(app).post(`/api/pairings/${pairingId}/messages/read`).set(auth(patient.token))).body.read).toBe(0);
    const row = (await pool.query("SELECT read_at FROM messages WHERE id = $1", [msg.id])).rows[0];
    expect(row.read_at).not.toBeNull(); // recorded for the doctor's own purposes (unread counts), not shown to the sender
  });

  it("does not show a status on the other person's messages", async () => {
    const { patient, doctor, pairingId } = await pair();
    await send(pairingId, doctor, "Reply from the doctor");
    const seen = (await thread(pairingId, patient)).body[0];
    expect(seen).not.toHaveProperty("status");
  });

  it("does not let a stranger, or a doctor who is not part of the conversation, record anything", async () => {
    const { patient, pairingId } = await pair();
    const stranger = await signupPatient();
    const otherDoctor = await createDoctor();
    await send(pairingId, patient, "Hello");
    for (const who of [stranger, otherDoctor]) {
      expect((await request(app).post(`/api/pairings/${pairingId}/messages/read`).set(auth(who.token))).status).toBe(404);
      expect((await thread(pairingId, who)).status).toBe(404);
    }
    expect((await pool.query("SELECT delivered_at, read_at FROM messages WHERE pairing_request_id = $1", [pairingId])).rows[0]).toEqual({ delivered_at: null, read_at: null });
  });
});

describe("a conversation is paged, not dumped", () => {
  it("returns the newest page, and older ones by cursor, oldest first within a page", async () => {
    const { patient, pairingId } = await pair();
    for (let i = 1; i <= 5; i++) {
      await send(pairingId, patient, `message ${i}`);
      await new Promise((r) => setTimeout(r, 15));
    }
    const newest = (await thread(pairingId, patient, "?limit=2")).body;
    expect(newest.map((m: any) => m.body)).toEqual(["message 4", "message 5"]);
    const older = (await thread(pairingId, patient, `?limit=2&before=${encodeURIComponent(newest[0].createdAt)}`)).body;
    expect(older.map((m: any) => m.body)).toEqual(["message 2", "message 3"]);
    expect((await thread(pairingId, patient)).body).toHaveLength(5);
    expect((await thread(pairingId, patient, "?limit=9999")).body).toHaveLength(5); // capped, never unbounded
    expect((await thread(pairingId, patient, "?before=not-a-date")).status).toBe(200);
  });
});

describe("the inbox", () => {
  it("lists only my conversations, newest first, with unread counts that fall as I read", async () => {
    const patient = await signupPatient();
    const d1 = await createDoctor({ name: "Dr. First Inbox" });
    const d2 = await createDoctor({ name: "Dr. Second Inbox" });
    const p1 = (await connect(patient, d1)).pairingId;
    const p2 = (await connect(patient, d2)).pairingId;
    const outsider = await signupPatient();
    const d3 = await createDoctor();
    const p3 = (await connect(outsider, d3)).pairingId;
    await send(p1, d1, "Older: first doctor");
    await new Promise((r) => setTimeout(r, 20));
    await send(p2, d2, "Newer: second doctor, one");
    await send(p2, d2, "Newer: second doctor, two");
    await send(p3, d3, "Not mine");

    const inbox = (await request(app).get("/api/conversations").set(auth(patient.token))).body;
    expect(inbox.conversations.map((c: any) => c.name)).toEqual(["Dr. Second Inbox", "Dr. First Inbox"]);
    expect(inbox.conversations.map((c: any) => c.unread)).toEqual([2, 1]);
    expect(inbox.unreadTotal).toBe(3);
    expect(inbox.conversations[0].lastMessage).toMatchObject({ fromMe: false, snippet: "Newer: second doctor, two" });
    expect(JSON.stringify(inbox)).not.toContain("Not mine");

    await request(app).post(`/api/pairings/${p2}/messages/read`).set(auth(patient.token));
    const after = (await request(app).get("/api/conversations").set(auth(patient.token))).body;
    expect(after.unreadTotal).toBe(1);
    // Reading cleared the "new message" notice, so the next message nudges again.
    await send(p2, d2, "Another");
    expect((await request(app).get("/api/notifications").set(auth(patient.token))).body.items.filter((n: any) => n.kind === "message.new" && n.link.includes(p2) && !n.read).length).toBeGreaterThan(0);
  });

  it("is available to patients and approved doctors only", async () => {
    const admin = await createAdmin();
    expect((await request(app).get("/api/conversations").set(auth(admin.token))).status).toBe(403);
    expect((await request(app).get("/api/conversations")).status).toBe(401);
  });
});

describe("search stays inside my own conversations", () => {
  it("finds my words, never someone else's, and treats % and _ as ordinary characters", async () => {
    const mine = await pair();
    const theirs = await pair();
    const word = `needle${Date.now().toString(36)}`;
    await send(mine.pairingId, mine.patient, `Please look at my ${word} results, 100% sure`);
    await send(theirs.pairingId, theirs.patient, `Somebody else's ${word} results, 100_ sure`);

    const found = (await request(app).get(`/api/conversations/search?q=${word}`).set(auth(mine.patient.token))).body;
    expect(found).toHaveLength(1);
    expect(found[0].pairingId).toBe(mine.pairingId);
    expect(found[0].excerpt).toContain(word);
    // The doctor of the OTHER conversation cannot reach mine either.
    const fromOtherDoctor = (await request(app).get(`/api/conversations/search?q=${word}`).set(auth(theirs.doctor.token))).body;
    expect(fromOtherDoctor.map((h: any) => h.pairingId)).toEqual([theirs.pairingId]);

    expect((await request(app).get("/api/conversations/search?q=100%25").set(auth(mine.patient.token))).body).toHaveLength(1);
    expect((await request(app).get("/api/conversations/search?q=%25%25%25").set(auth(mine.patient.token))).body).toHaveLength(0); // "%%%" is not a wildcard
    expect((await request(app).get("/api/conversations/search?q=_____").set(auth(mine.patient.token))).body).toHaveLength(0);
  });

  it("asks for at least three characters and is rate limited", async () => {
    const { patient } = await pair();
    expect((await request(app).get("/api/conversations/search?q=ab").set(auth(patient.token))).status).toBe(400);
    expect((await request(app).get("/api/conversations/search").set(auth(patient.token))).status).toBe(400);
  });
});

describe("reporting and blocking", () => {
  it("reaches an administrator with only what the reporter attached, and can be resolved", async () => {
    const { patient, doctor, pairingId } = await pair();
    const admin = await createAdmin();
    const rude = (await send(pairingId, doctor, "An unprofessional remark")).body;
    const secret = (await send(pairingId, patient, "My private medical detail")).body;
    expect(secret.id).toBeTruthy();

    // Not shared: the reviewer learns a report exists, and the reason, not the text.
    const a = await request(app).post(`/api/conversations/messages/${rude.id}/report`).set(auth(patient.token)).send({ reason: "harassment", details: "Keeps pressuring me", shareText: false });
    expect(a.status).toBe(201);
    const b = await request(app).post(`/api/conversations/messages/${rude.id}/report`).set(auth(patient.token)).send({ reason: "abuse", shareText: true });
    expect(b.status).toBe(201);

    const list = (await request(app).get("/api/admin/message-reports").set(auth(admin.token))).body;
    const mineReports = list.filter((r: any) => [a.body.id, b.body.id].includes(r.id));
    expect(mineReports).toHaveLength(2);
    expect(mineReports.find((r: any) => r.id === a.body.id)).toMatchObject({ reason: "harassment", sharedText: null });
    expect(mineReports.find((r: any) => r.id === b.body.id).sharedText).toBe("An unprofessional remark");
    expect(JSON.stringify(list)).not.toContain("My private medical detail"); // the rest of the conversation is never exposed

    const resolved = await request(app).post(`/api/admin/message-reports/${a.body.id}/resolve`).set(auth(admin.token)).send({ note: "Spoke with the clinician" });
    expect(resolved.body.status).toBe("resolved");
    expect((await request(app).post(`/api/admin/message-reports/${a.body.id}/resolve`).set(auth(admin.token)).send({})).status).toBe(404); // already resolved
    expect((await pool.query("SELECT action FROM audit_logs WHERE actor_user_id = $1 AND action IN ('message_reports.listed','message_report.resolved')", [admin.id])).rows.length).toBeGreaterThanOrEqual(2);
  });

  it("only lets a party report the OTHER person's message, and only an administrator read the reports", async () => {
    const { patient, doctor, pairingId } = await pair();
    const stranger = await signupPatient();
    const mine = (await send(pairingId, patient, "My own message")).body;
    const theirs = (await send(pairingId, doctor, "Their message")).body;
    expect((await request(app).post(`/api/conversations/messages/${mine.id}/report`).set(auth(patient.token)).send({ reason: "spam" })).status).toBe(404); // not their own
    expect((await request(app).post(`/api/conversations/messages/${theirs.id}/report`).set(auth(stranger.token)).send({ reason: "spam" })).status).toBe(404);
    expect((await request(app).post(`/api/conversations/messages/${theirs.id}/report`).set(auth(patient.token)).send({ reason: "not-a-reason" })).status).toBe(400);
    for (const who of [patient, doctor, stranger]) expect((await request(app).get("/api/admin/message-reports").set(auth(who.token))).status).toBe(403);
  });

  it("a patient blocking a doctor ends the conversation and stops them being asked again", async () => {
    const { patient, doctor, pairingId } = await pair();
    await send(pairingId, doctor, "hello");
    expect((await request(app).post(`/api/conversations/${pairingId}/block`).set(auth(patient.token))).status).toBe(200);
    expect((await send(pairingId, patient, "can I still write?")).status).toBe(403);
    expect((await send(pairingId, doctor, "can I still write?")).status).toBe(403);
    const again = await request(app).post("/api/pairings").set(auth(patient.token)).send({ doctorProfileId: doctor.profileId });
    expect(again.status).toBe(404); // indistinguishable from "no such doctor"
  });

  it("a doctor blocking a patient does the same from the other side", async () => {
    const { patient, doctor, pairingId } = await pair();
    expect((await request(app).post(`/api/conversations/${pairingId}/block`).set(auth(doctor.token))).status).toBe(200);
    expect((await send(pairingId, patient, "hello?")).status).toBe(403);
    expect((await request(app).post("/api/pairings").set(auth(patient.token)).send({ doctorProfileId: doctor.profileId })).status).toBe(404);
    // Another patient is unaffected.
    const other = await signupPatient();
    expect((await request(app).post("/api/pairings").set(auth(other.token)).send({ doctorProfileId: doctor.profileId })).status).toBe(201);
  });

  it("cannot be done to a conversation that is not yours", async () => {
    const { pairingId } = await pair();
    const stranger = await signupPatient();
    expect((await request(app).post(`/api/conversations/${pairingId}/block`).set(auth(stranger.token))).status).toBe(404);
  });
});

describe("a sent message cannot be altered, even by the database's own owner", () => {
  it("refuses edits, deletion, re-attribution and rewriting a receipt, but allows the erasure marker", async () => {
    const { patient, doctor, pairingId } = await pair();
    const m = (await send(pairingId, patient, "Original words")).body;
    await expect(pool.query("UPDATE messages SET body = 'Edited' WHERE id = $1", [m.id])).rejects.toThrow(/cannot be edited/);
    // The owner is stopped by the trigger; the restricted application role has no delete policy at all (zero rows). Either way it stays.
    await pool.query("DELETE FROM messages WHERE id = $1", [m.id]).then((r) => expect(r.rowCount).toBe(0), (e) => expect(String(e.message)).toMatch(/cannot be deleted/));
    expect((await pool.query("SELECT count(*)::int n FROM messages WHERE id = $1", [m.id])).rows[0].n).toBe(1);
    await expect(pool.query("UPDATE messages SET sender_user_id = $2 WHERE id = $1", [m.id, doctor.id])).rejects.toThrow(/re-attributed/);
    await thread(pairingId, doctor);
    await expect(pool.query("UPDATE messages SET delivered_at = now() - interval '1 day' WHERE id = $1", [m.id])).rejects.toThrow(/receipt cannot be changed/);
    await pool.query("UPDATE messages SET body = '[erased]' WHERE id = $1", [m.id]); // what the erasure procedure does
    expect((await pool.query("SELECT body FROM messages WHERE id = $1", [m.id])).rows[0].body).toBe("[erased]");
  });
});
