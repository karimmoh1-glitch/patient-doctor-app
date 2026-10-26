import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { getApp, signupPatient, createDoctor, connect, auth, issuePrescription, prescriptionBody } from "./helpers";
import { db } from "../server/db";
import { storage } from "../server/storage";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

// These go straight to the database, around every route and every check in the
// application: they prove the DATABASE refuses, whatever code or hand-typed SQL asks.
async function refused(run: () => Promise<unknown>, pattern: RegExp) {
  let message = "";
  try {
    await run();
  } catch (err: any) {
    message = String(err?.cause?.message ?? err?.message ?? err);
  }
  expect(message, "the database should have refused").toMatch(pattern);
}

async function authorized() {
  const patient = await signupPatient();
  const doctor = await createDoctor();
  const { pairingId } = await connect(patient, doctor);
  const rx = await issuePrescription(doctor, pairingId, { refillsAllowed: 2 });
  return { patient, doctor, pairingId, rx };
}

describe("append-only records", () => {
  it("the access log cannot be edited or erased, by anyone, through any route", async () => {
    const { patient } = await authorized();
    const [row] = (await storage.getAuditLogsForSubject(patient.id, 5));
    expect(row).toBeTruthy();
    await refused(() => db.execute(sql`UPDATE audit_logs SET action = 'nothing.happened' WHERE id = ${row.id}`), /append-only|permission denied/); // the trigger for the table owner; the missing privilege for the restricted runtime role
    await refused(() => db.execute(sql`DELETE FROM audit_logs WHERE id = ${row.id}`), /append-only|permission denied/); // the trigger for the table owner; the missing privilege for the restricted runtime role
  });

  it("a prescription's history cannot be rewritten", async () => {
    const { rx } = await authorized();
    const [event] = await storage.getPrescriptionEvents(rx.id);
    await refused(() => db.execute(sql`UPDATE prescription_events SET event = 'drafted' WHERE id = ${event.id}`), /append-only|permission denied/); // the trigger for the table owner; the missing privilege for the restricted runtime role
    await refused(() => db.execute(sql`DELETE FROM prescription_events WHERE prescription_id = ${rx.id}`), /append-only|permission denied/); // the trigger for the table owner; the missing privilege for the restricted runtime role
  });
});

describe("an authorized prescription is frozen in the database itself", () => {
  it("refuses any change to what was prescribed", async () => {
    const { rx } = await authorized();
    for (const column of ["dose", "medication_name", "instructions", "warnings", "route"]) {
      await refused(() => db.execute(sql.raw(`UPDATE prescriptions SET ${column} = 'tampered' WHERE id = '${rx.id}'`)), /cannot be edited/);
    }
    await refused(() => db.execute(sql`UPDATE prescriptions SET quantity = 999 WHERE id = ${rx.id}`), /cannot be edited/);
    await refused(() => db.execute(sql`UPDATE prescriptions SET end_date = now() + interval '5 years' WHERE id = ${rx.id}`), /cannot be edited/);
    await refused(() => db.execute(sql`UPDATE prescriptions SET authorized_at = now() WHERE id = ${rx.id}`), /cannot be edited/);
  });

  it("refuses to move it back to a draft, or to hand it to another patient or doctor", async () => {
    const { rx } = await authorized();
    const other = await signupPatient();
    await refused(() => db.execute(sql`UPDATE prescriptions SET status = 'draft' WHERE id = ${rx.id}`), /draft/);
    await refused(() => db.execute(sql`UPDATE prescriptions SET patient_user_id = ${other.id} WHERE id = ${rx.id}`), /cannot be edited/);
  });

  it("refuses to delete it, and a draft with history can't be erased either (it is cancelled instead)", async () => {
    const { rx, doctor, pairingId } = await authorized();
    await refused(() => db.execute(sql`DELETE FROM prescriptions WHERE id = ${rx.id}`), /cannot be deleted/);
    const draft = await request(app).post("/api/prescriptions").set(auth(doctor.token)).send(prescriptionBody(pairingId));
    await refused(() => db.execute(sql`DELETE FROM prescriptions WHERE id = ${draft.body.id}`), /violates foreign key/);
  });

  it("lets it end properly (cancelled, expired, completed) and only once", async () => {
    const { rx } = await authorized();
    await db.execute(sql`UPDATE prescriptions SET status = 'cancelled' WHERE id = ${rx.id}`);
    await refused(() => db.execute(sql`UPDATE prescriptions SET status = 'active' WHERE id = ${rx.id}`), /cannot change status again/);
  });

  it("counts refills only upward and never beyond the allowance", async () => {
    const { rx } = await authorized();
    await db.execute(sql`UPDATE prescriptions SET refills_used = 1 WHERE id = ${rx.id}`);
    await refused(() => db.execute(sql`UPDATE prescriptions SET refills_used = 0 WHERE id = ${rx.id}`), /count up/);
    await refused(() => db.execute(sql`UPDATE prescriptions SET refills_used = 3 WHERE id = ${rx.id}`), /count up/);
  });
});
