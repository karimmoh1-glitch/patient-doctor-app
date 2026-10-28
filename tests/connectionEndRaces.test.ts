import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, connect, auth, operatorPool, type TestUser, type TestDoctor } from "./helpers";

// Ending a connection races with everything else the patient can do at the same moment (booking another visit from a second tab, a second
// "end" from a second device). The patient's decision about booked visits must hold whichever request wins: a visit is never left standing on
// an ended connection by an end that never asked about it, and two simultaneous ends never leave a half state.

let app: Express;
beforeAll(async () => {
  app = await getApp();
});
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 }));

async function scene() {
  const patient = await signupPatient();
  const doctor = await createDoctor();
  expect((await request(app).put("/api/doctors/me/availability").set(auth(doctor.token)).send({ timezone: "America/Los_Angeles", windows: EVERY_DAY })).status).toBe(200);
  const { pairingId } = await connect(patient, doctor);
  const slots = (await request(app).get(`/api/appointments/slots?pairingRequestId=${pairingId}&days=3`).set(auth(patient.token))).body.slots as string[];
  return { patient, doctor, pairingId, slots };
}
const book = (patient: TestUser, pairingId: string, at: string) =>
  request(app).post("/api/appointments").set(auth(patient.token)).send({ pairingRequestId: pairingId, type: "Phone Call", reason: "Follow-up on cough", scheduledAt: at });
const end = (patient: TestUser, id: string, body?: object) => request(app).patch(`/api/pairings/${id}/end`).set(auth(patient.token)).send(body ?? {});
const live = async (pairingId: string) =>
  (await operatorPool().query(`SELECT id, status FROM appointments WHERE pairing_request_id = $1 AND status IN ('requested','confirmed') AND scheduled_at > now()`, [pairingId])).rows;
const pairing = async (id: string) => (await operatorPool().query("SELECT status FROM pairing_requests WHERE id = $1", [id])).rows[0].status as string;

describe("ending while another request books a visit", () => {
  it("never ends a connection past a booked visit without the patient's decision about it, over many races", async () => {
    const scenes = await Promise.all(Array.from({ length: 12 }, scene));
    const outcomes: string[] = [];
    for (let round = 0; round < 2; round++) {
      const results = await Promise.all(
        scenes.map(async (s, i) => {
          if (round === 1 && (await pairing(s.pairingId)) !== "accepted") return null;
          // Stagger a little so the two requests overlap at different points of the end.
          const [b, e] = await Promise.all([book(s.patient, s.pairingId, s.slots[10 + round]), (async () => { await new Promise((r) => setTimeout(r, i % 4)); return end(s.patient, s.pairingId); })()]);
          return { s, b: b.status, e: e.status, code: e.body.code, kept: e.body.visitsKept };
        }),
      );
      for (const r of results) {
        if (!r) continue;
        const standing = await live(r.s.pairingId);
        const state = await pairing(r.s.pairingId);
        outcomes.push(`${r.b}/${r.e}`);
        if (state === "ended") {
          // Ended with nothing asked about a visit: it must be that there was no visit, and none can be standing.
          expect(r.e, "an end that succeeded").toBe(200);
          expect(r.kept ?? 0, `the end kept a visit nobody asked about (book ${r.b})`).toBe(0);
          expect(standing, "a visit standing on an ended connection").toEqual([]);
          expect([404, 409], "booking on a connection that ended").toContain(r.b);
        } else {
          expect(r.e, "end refused").toBe(409);
          expect(r.code).toBe("decide_upcoming_visits");
          expect(r.b).toBe(201);
          expect(standing.length, "the visit that won the race").toBeGreaterThanOrEqual(1);
        }
      }
    }
    expect(outcomes.length).toBeGreaterThan(12);
  }, 120_000);

  it("applies the patient's explicit decision to a visit booked at the same moment: 'cancel' leaves none standing, 'keep' leaves it recorded as kept", async () => {
    const scenes = await Promise.all(Array.from({ length: 10 }, scene));
    await Promise.all(
      scenes.map(async (s, i) => {
        const decision = i % 2 ? "keep" : "cancel";
        const [b, e] = await Promise.all([book(s.patient, s.pairingId, s.slots[20]), end(s.patient, s.pairingId, { upcomingVisits: decision })]);
        expect(e.status).toBe(200);
        const standing = await live(s.pairingId);
        if (decision === "cancel") expect(standing, `book ${b.status}`).toEqual([]);
        else expect(standing.length, `book ${b.status}`).toBe(b.status === 201 ? 1 : 0);
        expect(e.body.visitsCancelled + e.body.visitsKept).toBe(b.status === 201 ? 1 : 0);
        expect(await pairing(s.pairingId)).toBe("ended");
      }),
    );
  }, 120_000);
});

describe("two ends at once", () => {
  it("lets exactly one finish, whichever decisions they carry, and leaves a consistent record", async () => {
    const scenes = await Promise.all(Array.from({ length: 10 }, scene));
    for (const s of scenes) await book(s.patient, s.pairingId, s.slots[5]);
    await Promise.all(
      scenes.map(async (s) => {
        const [a, b] = await Promise.all([end(s.patient, s.pairingId, { upcomingVisits: "cancel" }), end(s.patient, s.pairingId, { upcomingVisits: "keep" })]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        const winner = a.status === 200 ? "cancel" : "keep";
        const audits = (await operatorPool().query(`SELECT metadata FROM audit_logs WHERE action = 'pairing.ended' AND target_id = $1`, [s.pairingId])).rows;
        expect(audits).toHaveLength(1);
        expect(audits[0].metadata.upcomingVisits).toBe(winner);
        expect((await live(s.pairingId)).length).toBe(winner === "cancel" ? 0 : 1);
      }),
    );
  }, 120_000);
});
