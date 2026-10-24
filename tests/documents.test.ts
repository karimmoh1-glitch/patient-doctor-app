import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getApp, signupPatient, createDoctor, connect, auth } from "./helpers";
import { storage } from "../server/storage";

let app: Express;
beforeAll(async () => {
  app = await getApp();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("document uploads", () => {
  it("stores a real file and serves it only to its owner, with safe headers", async () => {
    const patient = await signupPatient();
    const other = await signupPatient();
    const up = await request(app)
      .post("/api/documents")
      .set(auth(patient.token))
      .field("title", "Blood test")
      .attach("file", PNG, { filename: "scan.png", contentType: "image/png" });
    expect(up.status).toBe(201);
    expect(up.body.hasFile).toBe(true);
    expect(up.body.filePath).toBeUndefined();

    const mine = await request(app).get(`/api/documents/${up.body.id}/file`).set(auth(patient.token));
    expect(mine.status).toBe(200);
    expect(mine.headers["content-type"]).toContain("image/png");
    expect(mine.headers["x-content-type-options"]).toBe("nosniff");
    expect(mine.headers["content-security-policy"]).toContain("sandbox");

    expect((await request(app).get(`/api/documents/${up.body.id}/file`).set(auth(other.token))).status).toBe(404);
  });

  it("rejects an unsupported type instead of silently saving a file-less record", async () => {
    const patient = await signupPatient();
    const res = await request(app)
      .post("/api/documents")
      .set(auth(patient.token))
      .field("title", "Sneaky")
      .attach("file", Buffer.from("<script>alert(1)</script>"), { filename: "x.html", contentType: "text/html" });
    expect(res.status).toBe(400);
    expect((await storage.getDocumentsByPatient(patient.id)).length).toBe(0);
  });

  it("rejects a file whose bytes do not match its declared type", async () => {
    const patient = await signupPatient();
    const res = await request(app)
      .post("/api/documents")
      .set(auth(patient.token))
      .field("title", "Fake image")
      .attach("file", Buffer.from("<html><script>alert(1)</script></html>"), { filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect((await storage.getDocumentsByPatient(patient.id)).length).toBe(0);
  });

  it("ignores a hostile filename when storing and serving", async () => {
    const patient = await signupPatient();
    const up = await request(app)
      .post("/api/documents")
      .set(auth(patient.token))
      .field("title", "Path")
      .attach("file", PNG, { filename: "../../etc/passwd.html", contentType: "image/png" });
    expect(up.status).toBe(201);
    expect(up.body.fileName).not.toContain("/");
    const got = await request(app).get(`/api/documents/${up.body.id}/file`).set(auth(patient.token));
    expect(got.headers["content-type"]).toContain("image/png");
  });

  it("does not show a doctor a patient's document without a sharing grant", async () => {
    const patient = await signupPatient();
    const doctor = await createDoctor();
    await connect(patient, doctor);
    const up = await request(app)
      .post("/api/documents")
      .set(auth(patient.token))
      .field("title", "Private")
      .attach("file", PNG, { filename: "p.png", contentType: "image/png" });
    expect((await request(app).get(`/api/documents/${up.body.id}/file`).set(auth(doctor.token))).status).toBe(404);
  });

  it("lets the owner delete a document for good, and nobody else", async () => {
    const patient = await signupPatient();
    const other = await signupPatient();
    const up = await request(app)
      .post("/api/documents")
      .set(auth(patient.token))
      .field("title", "Delete me")
      .attach("file", PNG, { filename: "d.png", contentType: "image/png" });
    expect((await request(app).delete(`/api/documents/${up.body.id}`).set(auth(other.token))).status).toBe(404);
    expect((await request(app).delete(`/api/documents/${up.body.id}`).set(auth(patient.token))).status).toBe(200);
    expect(await storage.getDocument(up.body.id)).toBeUndefined();
    expect((await request(app).get(`/api/documents/${up.body.id}/file`).set(auth(patient.token))).status).toBe(404);
  });
});
