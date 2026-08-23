import { eq, and, desc } from "drizzle-orm";
import { db } from "./db";
import {
  users, userDevices, passwordResetTokens, emailVerificationTokens, auditLogs,
  doctorApplications, doctorProfiles, symptomReports, pairingRequests, messages,
  type User, type InsertUser,
  type UserDevice, type InsertUserDevice,
  type PasswordResetToken,
  type EmailVerificationToken,
  type AuditLog, type InsertAuditLog,
  type DoctorApplication, type InsertDoctorApplication,
  type DoctorProfile, type InsertDoctorProfile,
  type SymptomReport, type InsertSymptomReport,
  type PairingRequest, type InsertPairingRequest,
  type Message, type InsertMessage,
} from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(data: InsertUser): Promise<User>;
  setUserDeactivated(id: string, deactivated: boolean): Promise<User | undefined>;
  updateUserPassword(id: string, passwordHash: string): Promise<void>;

  createUserDevice(data: InsertUserDevice): Promise<UserDevice>;
  getUserDeviceByDeviceId(deviceId: string): Promise<UserDevice | undefined>;
  touchUserDevice(deviceId: string): Promise<void>;
  revokeUserDevice(deviceId: string): Promise<void>;

  createPasswordResetToken(email: string, tokenHash: string, expiresAt: Date): Promise<PasswordResetToken>;
  getPasswordResetTokenByHash(tokenHash: string): Promise<PasswordResetToken | undefined>;
  markPasswordResetTokenUsed(id: string): Promise<void>;

  createEmailVerificationToken(userId: string, tokenHash: string, expiresAt: Date): Promise<EmailVerificationToken>;
  getEmailVerificationTokenByHash(tokenHash: string): Promise<EmailVerificationToken | undefined>;
  markEmailVerificationTokenUsed(id: string): Promise<void>;

  createAuditLog(data: InsertAuditLog): Promise<AuditLog>;

  createDoctorApplication(data: InsertDoctorApplication): Promise<DoctorApplication>;
  getDoctorApplication(id: string): Promise<DoctorApplication | undefined>;
  getDoctorApplicationByEmail(email: string): Promise<DoctorApplication | undefined>;
  getPendingDoctorApplications(): Promise<DoctorApplication[]>;
  updateDoctorApplicationStatus(id: string, status: "approved" | "rejected", reviewedByUserId: string, reviewerNotes?: string): Promise<DoctorApplication | undefined>;

  createDoctorProfile(data: InsertDoctorProfile): Promise<DoctorProfile>;
  getDoctorProfile(id: string): Promise<DoctorProfile | undefined>;
  getDoctorProfileByUserId(userId: string): Promise<DoctorProfile | undefined>;
  getActiveDoctorProfiles(): Promise<DoctorProfile[]>;

  createSymptomReport(data: InsertSymptomReport): Promise<SymptomReport>;
  getSymptomReport(id: string): Promise<SymptomReport | undefined>;

  createPairingRequest(data: InsertPairingRequest): Promise<PairingRequest>;
  getPairingRequest(id: string): Promise<PairingRequest | undefined>;
  getPairingRequestsByPatient(patientUserId: string): Promise<PairingRequest[]>;
  getPairingRequestsByDoctorProfile(doctorProfileId: string): Promise<PairingRequest[]>;
  updatePairingRequestStatus(id: string, status: "accepted" | "declined" | "cancelled"): Promise<PairingRequest | undefined>;

  createMessage(data: InsertMessage): Promise<Message>;
  getMessagesByPairing(pairingRequestId: string): Promise<Message[]>;
}

export class DbStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async createUser(data: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(data).returning();
    return user;
  }

  async setUserDeactivated(id: string, deactivated: boolean): Promise<User | undefined> {
    const [user] = await db
      .update(users)
      .set({ deactivatedAt: deactivated ? new Date() : null })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async updateUserPassword(id: string, passwordHash: string): Promise<void> {
    await db.update(users).set({ passwordHash }).where(eq(users.id, id));
  }

  async createUserDevice(data: InsertUserDevice): Promise<UserDevice> {
    const [device] = await db.insert(userDevices).values(data).returning();
    return device;
  }

  async getUserDeviceByDeviceId(deviceId: string): Promise<UserDevice | undefined> {
    const [device] = await db.select().from(userDevices).where(eq(userDevices.deviceId, deviceId));
    return device;
  }

  async touchUserDevice(deviceId: string): Promise<void> {
    await db.update(userDevices).set({ lastSeenAt: new Date() }).where(eq(userDevices.deviceId, deviceId));
  }

  async revokeUserDevice(deviceId: string): Promise<void> {
    await db.update(userDevices).set({ revokedAt: new Date() }).where(eq(userDevices.deviceId, deviceId));
  }

  async createPasswordResetToken(email: string, tokenHash: string, expiresAt: Date): Promise<PasswordResetToken> {
    const [token] = await db.insert(passwordResetTokens).values({ email, tokenHash, expiresAt, used: false }).returning();
    return token;
  }

  async getPasswordResetTokenByHash(tokenHash: string): Promise<PasswordResetToken | undefined> {
    const [token] = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.tokenHash, tokenHash));
    return token;
  }

  async markPasswordResetTokenUsed(id: string): Promise<void> {
    await db.update(passwordResetTokens).set({ used: true }).where(eq(passwordResetTokens.id, id));
  }

  async createEmailVerificationToken(userId: string, tokenHash: string, expiresAt: Date): Promise<EmailVerificationToken> {
    const [token] = await db.insert(emailVerificationTokens).values({ userId, tokenHash, expiresAt, used: false }).returning();
    return token;
  }

  async getEmailVerificationTokenByHash(tokenHash: string): Promise<EmailVerificationToken | undefined> {
    const [token] = await db.select().from(emailVerificationTokens).where(eq(emailVerificationTokens.tokenHash, tokenHash));
    return token;
  }

  async markEmailVerificationTokenUsed(id: string): Promise<void> {
    await db.update(emailVerificationTokens).set({ used: true }).where(eq(emailVerificationTokens.id, id));
  }

  async createAuditLog(data: InsertAuditLog): Promise<AuditLog> {
    const [log] = await db.insert(auditLogs).values(data).returning();
    return log;
  }

  async createDoctorApplication(data: InsertDoctorApplication): Promise<DoctorApplication> {
    const [application] = await db.insert(doctorApplications).values(data).returning();
    return application;
  }

  async getDoctorApplication(id: string): Promise<DoctorApplication | undefined> {
    const [application] = await db.select().from(doctorApplications).where(eq(doctorApplications.id, id));
    return application;
  }

  async getDoctorApplicationByEmail(email: string): Promise<DoctorApplication | undefined> {
    const [application] = await db.select().from(doctorApplications).where(eq(doctorApplications.email, email));
    return application;
  }

  async getPendingDoctorApplications(): Promise<DoctorApplication[]> {
    return db
      .select()
      .from(doctorApplications)
      .where(eq(doctorApplications.status, "pending"))
      .orderBy(desc(doctorApplications.createdAt));
  }

  async updateDoctorApplicationStatus(
    id: string,
    status: "approved" | "rejected",
    reviewedByUserId: string,
    reviewerNotes?: string,
  ): Promise<DoctorApplication | undefined> {
    const [application] = await db
      .update(doctorApplications)
      .set({ status, reviewedByUserId, reviewedAt: new Date(), reviewerNotes: reviewerNotes ?? null })
      .where(eq(doctorApplications.id, id))
      .returning();
    return application;
  }

  async createDoctorProfile(data: InsertDoctorProfile): Promise<DoctorProfile> {
    const [profile] = await db.insert(doctorProfiles).values(data).returning();
    return profile;
  }

  async getDoctorProfile(id: string): Promise<DoctorProfile | undefined> {
    const [profile] = await db.select().from(doctorProfiles).where(eq(doctorProfiles.id, id));
    return profile;
  }

  async getDoctorProfileByUserId(userId: string): Promise<DoctorProfile | undefined> {
    const [profile] = await db.select().from(doctorProfiles).where(eq(doctorProfiles.userId, userId));
    return profile;
  }

  async getActiveDoctorProfiles(): Promise<DoctorProfile[]> {
    return db.select().from(doctorProfiles).where(eq(doctorProfiles.active, true));
  }

  async createSymptomReport(data: InsertSymptomReport): Promise<SymptomReport> {
    const [report] = await db.insert(symptomReports).values(data).returning();
    return report;
  }

  async getSymptomReport(id: string): Promise<SymptomReport | undefined> {
    const [report] = await db.select().from(symptomReports).where(eq(symptomReports.id, id));
    return report;
  }

  async createPairingRequest(data: InsertPairingRequest): Promise<PairingRequest> {
    const [request] = await db.insert(pairingRequests).values(data).returning();
    return request;
  }

  async getPairingRequest(id: string): Promise<PairingRequest | undefined> {
    const [request] = await db.select().from(pairingRequests).where(eq(pairingRequests.id, id));
    return request;
  }

  async getPairingRequestsByPatient(patientUserId: string): Promise<PairingRequest[]> {
    return db
      .select()
      .from(pairingRequests)
      .where(eq(pairingRequests.patientUserId, patientUserId))
      .orderBy(desc(pairingRequests.requestedAt));
  }

  async getPairingRequestsByDoctorProfile(doctorProfileId: string): Promise<PairingRequest[]> {
    return db
      .select()
      .from(pairingRequests)
      .where(eq(pairingRequests.doctorProfileId, doctorProfileId))
      .orderBy(desc(pairingRequests.requestedAt));
  }

  async updatePairingRequestStatus(id: string, status: "accepted" | "declined" | "cancelled"): Promise<PairingRequest | undefined> {
    const [request] = await db
      .update(pairingRequests)
      .set({ status, respondedAt: new Date() })
      .where(eq(pairingRequests.id, id))
      .returning();
    return request;
  }

  async createMessage(data: InsertMessage): Promise<Message> {
    const [message] = await db.insert(messages).values(data).returning();
    return message;
  }

  async getMessagesByPairing(pairingRequestId: string): Promise<Message[]> {
    return db
      .select()
      .from(messages)
      .where(eq(messages.pairingRequestId, pairingRequestId))
      .orderBy(messages.createdAt);
  }
}

export const storage = new DbStorage();
