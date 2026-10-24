import { eq, and, desc, isNull, inArray, sql as sqlOp } from "drizzle-orm";

export type PairingStatus = "requested" | "accepted" | "declined" | "cancelled" | "ended";
import { db } from "./db";
import {
  users, userDevices, passwordResetTokens, emailVerificationTokens, auditLogs,
  doctorApplications, doctorProfiles, symptomReports, pairingRequests, messages,
  appointments, prescriptions, medications, medicationLogs, pharmacies, pharmacyOrders,
  documents, followUpTasks, sharingGrants, aiMessages, careCircleMembers,
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
  type Appointment, type InsertAppointment,
  type Prescription, type InsertPrescription,
  type Medication, type InsertMedication,
  type MedicationLog, type InsertMedicationLog,
  type Pharmacy, type InsertPharmacy,
  type PharmacyOrder, type InsertPharmacyOrder,
  type Document, type InsertDocument,
  type FollowUpTask, type InsertFollowUpTask,
  type SharingGrant, type InsertSharingGrant,
  type AiMessage, type InsertAiMessage,
  type CareCircleMember, type InsertCareCircleMember,
} from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(data: InsertUser): Promise<User>;
  setUserDeactivated(id: string, deactivated: boolean): Promise<User | undefined>;
  setUserTimezone(id: string, timezone: string): Promise<void>;
  updateUserPassword(id: string, passwordHash: string): Promise<void>;

  createUserDevice(data: InsertUserDevice): Promise<UserDevice>;
  getUserDeviceByDeviceId(deviceId: string): Promise<UserDevice | undefined>;
  touchUserDevice(deviceId: string): Promise<void>;
  revokeUserDevice(deviceId: string): Promise<void>;
  revokeAllUserDevices(userId: string): Promise<void>;

  createPasswordResetToken(email: string, tokenHash: string, expiresAt: Date): Promise<PasswordResetToken>;
  getPasswordResetTokenByHash(tokenHash: string): Promise<PasswordResetToken | undefined>;
  markPasswordResetTokenUsed(id: string): Promise<void>;

  createEmailVerificationToken(userId: string, tokenHash: string, expiresAt: Date): Promise<EmailVerificationToken>;
  getEmailVerificationTokenByHash(tokenHash: string): Promise<EmailVerificationToken | undefined>;
  markEmailVerificationTokenUsed(id: string): Promise<void>;

  createAuditLog(data: InsertAuditLog): Promise<AuditLog>;
  getAuditLogsForSubject(subjectUserId: string, limit: number): Promise<AuditLog[]>;
  getRecentAuditLogs(limit: number): Promise<AuditLog[]>;

  createDoctorApplication(data: InsertDoctorApplication): Promise<DoctorApplication>;
  getDoctorApplication(id: string): Promise<DoctorApplication | undefined>;
  getDoctorApplicationByEmail(email: string): Promise<DoctorApplication | undefined>;
  getPendingDoctorApplications(): Promise<DoctorApplication[]>;
  updateDoctorApplicationStatus(id: string, status: "approved" | "rejected", reviewedByUserId: string, reviewerNotes?: string): Promise<DoctorApplication | undefined>;

  /**
   * Approves a pending doctor application as ONE transaction: claim the
   * application, create the doctor's user account, create their profile. If
   * any step fails nothing is kept, so a half-approved application can never
   * block a retry.
   */
  approveDoctorApplication(applicationId: string, reviewerUserId: string, timezone: string): Promise<
    | { ok: true; user: User; profile: DoctorProfile; application: DoctorApplication }
    | { ok: false; reason: "already_reviewed" | "email_taken" }
  >;
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
  /** Moves a connection to `to` only if it is currently in one of `from`. Returns undefined if the guard failed. */
  transitionPairingStatus(id: string, from: PairingStatus[], to: PairingStatus): Promise<PairingRequest | undefined>;

  createMessage(data: InsertMessage): Promise<Message>;
  getMessagesByPairing(pairingRequestId: string): Promise<Message[]>;

  setPairingRelationshipLabel(id: string, relationshipLabel: string | null): Promise<PairingRequest | undefined>;
  getAcceptedPairingsByPatient(patientUserId: string): Promise<PairingRequest[]>;

  createAppointment(data: InsertAppointment): Promise<Appointment>;
  getAppointment(id: string): Promise<Appointment | undefined>;
  getAppointmentsByPatient(patientUserId: string): Promise<Appointment[]>;
  getAppointmentsByDoctorProfile(doctorProfileId: string): Promise<Appointment[]>;
  updateAppointmentStatus(id: string, status: "confirmed" | "completed" | "cancelled"): Promise<Appointment | undefined>;
  /** Moves an appointment to `to` only if it is currently in one of `from`; undefined if the guard failed. */
  transitionAppointmentStatus(id: string, from: string[], to: "confirmed" | "cancelled"): Promise<Appointment | undefined>;
  updateAppointmentQuestions(id: string, questionsForDoctor: string[]): Promise<Appointment | undefined>;
  completeAppointmentWithNotes(id: string, doctorNotes: string, followUpInstructions: string | null, followUpDate: Date | null): Promise<Appointment | undefined>;

  createPrescription(data: InsertPrescription): Promise<Prescription>;
  getPrescription(id: string): Promise<Prescription | undefined>;
  getPrescriptionsByPatient(patientUserId: string): Promise<Prescription[]>;
  getPrescriptionsByDoctorProfile(doctorProfileId: string): Promise<Prescription[]>;
  updatePrescriptionStatus(id: string, status: "active" | "completed" | "cancelled"): Promise<Prescription | undefined>;
  incrementPrescriptionRefills(id: string): Promise<Prescription | undefined>;

  createMedication(data: InsertMedication): Promise<Medication>;
  getMedication(id: string): Promise<Medication | undefined>;
  getMedicationByPrescriptionId(prescriptionId: string): Promise<Medication | undefined>;
  getMedicationsByPatient(patientUserId: string): Promise<Medication[]>;
  setMedicationActive(id: string, active: boolean): Promise<Medication | undefined>;

  upsertMedicationLog(data: InsertMedicationLog): Promise<MedicationLog>;
  deleteMedicationLog(medicationId: string, doseDate: string, doseTime: string): Promise<void>;
  getMedicationLogsByPatientAndDate(patientUserId: string, doseDate: string): Promise<MedicationLog[]>;
  getMedicationLogsByPatientRange(patientUserId: string, fromDate: string): Promise<MedicationLog[]>;

  getAllPharmacies(): Promise<Pharmacy[]>;
  getPharmacy(id: string): Promise<Pharmacy | undefined>;
  createPharmacy(data: InsertPharmacy): Promise<Pharmacy>;

  createPharmacyOrder(data: InsertPharmacyOrder): Promise<PharmacyOrder>;
  getPharmacyOrder(id: string): Promise<PharmacyOrder | undefined>;
  getPharmacyOrdersByPatient(patientUserId: string): Promise<PharmacyOrder[]>;
  getPharmacyOrderByPrescriptionId(prescriptionId: string): Promise<PharmacyOrder | undefined>;
  advancePharmacyOrderStatus(id: string, status: string, statusHistory: { status: string; at: string }[]): Promise<PharmacyOrder | undefined>;

  createDocument(data: InsertDocument): Promise<Document>;
  getDocument(id: string): Promise<Document | undefined>;
  deleteDocument(id: string): Promise<void>;
  getDocumentsByPatient(patientUserId: string): Promise<Document[]>;

  createFollowUpTask(data: InsertFollowUpTask): Promise<FollowUpTask>;
  getFollowUpTasksByPatient(patientUserId: string): Promise<FollowUpTask[]>;
  setFollowUpTaskStatus(id: string, status: "open" | "done"): Promise<FollowUpTask | undefined>;

  getSharingGrant(id: string): Promise<SharingGrant | undefined>;
  getActiveSharingGrantsByPatient(patientUserId: string): Promise<SharingGrant[]>;
  getActiveSharingGrantsByDoctorProfile(doctorProfileId: string): Promise<SharingGrant[]>;
  getActiveSharingGrantFor(patientUserId: string, doctorProfileId: string): Promise<SharingGrant | undefined>;
  upsertSharingGrant(data: InsertSharingGrant): Promise<SharingGrant>;
  revokeSharingGrant(id: string): Promise<SharingGrant | undefined>;

  createAiMessage(data: InsertAiMessage): Promise<AiMessage>;
  getAiMessagesByUser(userId: string, limit?: number): Promise<AiMessage[]>;

  updateEmergencyProfile(userId: string, data: { emergencyContactName: string | null; emergencyContactPhone: string | null; allergiesText: string | null; emergencyNotes: string | null }): Promise<User | undefined>;

  createCareCircleInvite(data: InsertCareCircleMember & { tokenHash: string }): Promise<CareCircleMember>;
  getCareCircleMember(id: string): Promise<CareCircleMember | undefined>;
  getCareCircleMemberByTokenHash(tokenHash: string): Promise<CareCircleMember | undefined>;
  getCareCircleByPatient(patientUserId: string): Promise<CareCircleMember[]>;
  getCareCircleByCaregiver(caregiverUserId: string): Promise<CareCircleMember[]>;
  acceptCareCircleInvite(id: string, caregiverUserId: string): Promise<CareCircleMember | undefined>;
  updateCareCirclePermissions(id: string, permissions: { permissionMedicationStatus: boolean; permissionAppointments: boolean; permissionDeliveryStatus: boolean; permissionDocuments: boolean; permissionFullRecords: boolean }): Promise<CareCircleMember | undefined>;
  revokeCareCircleMember(id: string): Promise<CareCircleMember | undefined>;
}

export class DbStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(sqlOp`lower(${users.email}) = ${email.trim().toLowerCase()}`);
    return user;
  }

  async createUser(data: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(data).returning();
    return user;
  }

  async setUserTimezone(id: string, timezone: string): Promise<void> {
    await db.update(users).set({ timezone }).where(eq(users.id, id));
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

  // Used after a password reset: whoever held the old password (or a stolen
  // session) must not keep access. Already-revoked rows keep their original
  // timestamp.
  async revokeAllUserDevices(userId: string): Promise<void> {
    await db
      .update(userDevices)
      .set({ revokedAt: new Date() })
      .where(and(eq(userDevices.userId, userId), isNull(userDevices.revokedAt)));
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

  async getAuditLogsForSubject(subjectUserId: string, limit: number): Promise<AuditLog[]> {
    return db.select().from(auditLogs).where(eq(auditLogs.subjectUserId, subjectUserId)).orderBy(desc(auditLogs.createdAt)).limit(limit);
  }

  async createAuditLog(data: InsertAuditLog): Promise<AuditLog> {
    const [log] = await db.insert(auditLogs).values(data).returning();
    return log;
  }

  async getRecentAuditLogs(limit: number): Promise<AuditLog[]> {
    return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
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

  async approveDoctorApplication(applicationId: string, reviewerUserId: string, timezone: string) {
    try {
      return await db.transaction(async (tx) => {
        const [application] = await tx
          .update(doctorApplications)
          .set({ status: "approved", reviewedByUserId: reviewerUserId, reviewedAt: new Date() })
          .where(and(eq(doctorApplications.id, applicationId), eq(doctorApplications.status, "pending")))
          .returning();
        if (!application) return { ok: false, reason: "already_reviewed" } as const;

        // Role is fixed here, never taken from request input.
        const [user] = await tx
          .insert(users)
          .values({
            name: application.name,
            email: application.email.trim().toLowerCase(),
            passwordHash: application.passwordHash,
            role: "doctor",
            state: application.licensedStates[0] || null,
            phone: application.phone,
            deactivatedAt: null,
            emailVerifiedAt: null,
          })
          .returning();
        const [profile] = await tx
          .insert(doctorProfiles)
          .values({
            userId: user.id,
            name: application.name,
            specialty: application.specialty,
            state: application.licensedStates[0],
            licenseNumber: application.licenseNumber,
            npiNumber: application.npiNumber,
            phone: application.phone,
            bio: application.bio,
            active: true,
            source: "application",
            timezone,
          })
          .returning();
        return { ok: true, user, profile, application } as const;
      });
    } catch (err: any) {
      if (err?.code === "23505" || err?.cause?.code === "23505") return { ok: false, reason: "email_taken" } as const;
      throw err;
    }
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

  async transitionPairingStatus(id: string, from: PairingStatus[], to: PairingStatus): Promise<PairingRequest | undefined> {
    const [request] = await db
      .update(pairingRequests)
      .set({ status: to, respondedAt: new Date() })
      .where(and(eq(pairingRequests.id, id), inArray(pairingRequests.status, from)))
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

  async setPairingRelationshipLabel(id: string, relationshipLabel: string | null): Promise<PairingRequest | undefined> {
    const [request] = await db
      .update(pairingRequests)
      .set({ relationshipLabel })
      .where(eq(pairingRequests.id, id))
      .returning();
    return request;
  }

  async getAcceptedPairingsByPatient(patientUserId: string): Promise<PairingRequest[]> {
    return db
      .select()
      .from(pairingRequests)
      .where(and(eq(pairingRequests.patientUserId, patientUserId), eq(pairingRequests.status, "accepted")))
      .orderBy(desc(pairingRequests.respondedAt));
  }

  // ---- Appointments ----

  async createAppointment(data: InsertAppointment): Promise<Appointment> {
    const [appointment] = await db.insert(appointments).values(data).returning();
    return appointment;
  }

  async getAppointment(id: string): Promise<Appointment | undefined> {
    const [appointment] = await db.select().from(appointments).where(eq(appointments.id, id));
    return appointment;
  }

  async getAppointmentsByPatient(patientUserId: string): Promise<Appointment[]> {
    return db
      .select()
      .from(appointments)
      .where(eq(appointments.patientUserId, patientUserId))
      .orderBy(desc(appointments.scheduledAt));
  }

  async getAppointmentsByDoctorProfile(doctorProfileId: string): Promise<Appointment[]> {
    return db
      .select()
      .from(appointments)
      .where(eq(appointments.doctorProfileId, doctorProfileId))
      .orderBy(desc(appointments.scheduledAt));
  }

  async updateAppointmentStatus(id: string, status: "confirmed" | "completed" | "cancelled"): Promise<Appointment | undefined> {
    const [appointment] = await db.update(appointments).set({ status }).where(eq(appointments.id, id)).returning();
    return appointment;
  }

  async transitionAppointmentStatus(id: string, from: string[], to: "confirmed" | "cancelled"): Promise<Appointment | undefined> {
    const [appointment] = await db
      .update(appointments)
      .set({ status: to })
      .where(and(eq(appointments.id, id), inArray(appointments.status, from)))
      .returning();
    return appointment;
  }

  async updateAppointmentQuestions(id: string, questionsForDoctor: string[]): Promise<Appointment | undefined> {
    const [appointment] = await db.update(appointments).set({ questionsForDoctor }).where(eq(appointments.id, id)).returning();
    return appointment;
  }

  async completeAppointmentWithNotes(
    id: string,
    doctorNotes: string,
    followUpInstructions: string | null,
    followUpDate: Date | null,
  ): Promise<Appointment | undefined> {
    const [appointment] = await db
      .update(appointments)
      .set({ status: "completed", doctorNotes, followUpInstructions, followUpDate })
      // Only a live visit can be completed — never a cancelled one, and never
      // twice (which would overwrite the notes and duplicate follow-up tasks).
      .where(and(eq(appointments.id, id), inArray(appointments.status, ["requested", "confirmed"])))
      .returning();
    return appointment;
  }

  // ---- Prescriptions ----

  async createPrescription(data: InsertPrescription): Promise<Prescription> {
    const [prescription] = await db.insert(prescriptions).values(data).returning();
    return prescription;
  }

  async getPrescription(id: string): Promise<Prescription | undefined> {
    const [prescription] = await db.select().from(prescriptions).where(eq(prescriptions.id, id));
    return prescription;
  }

  async getPrescriptionsByPatient(patientUserId: string): Promise<Prescription[]> {
    return db
      .select()
      .from(prescriptions)
      .where(eq(prescriptions.patientUserId, patientUserId))
      .orderBy(desc(prescriptions.createdAt));
  }

  async getPrescriptionsByDoctorProfile(doctorProfileId: string): Promise<Prescription[]> {
    return db
      .select()
      .from(prescriptions)
      .where(eq(prescriptions.doctorProfileId, doctorProfileId))
      .orderBy(desc(prescriptions.createdAt));
  }

  async updatePrescriptionStatus(id: string, status: "active" | "completed" | "cancelled"): Promise<Prescription | undefined> {
    const [prescription] = await db.update(prescriptions).set({ status }).where(eq(prescriptions.id, id)).returning();
    return prescription;
  }

  async incrementPrescriptionRefills(id: string): Promise<Prescription | undefined> {
    const [prescription] = await db
      .update(prescriptions)
      .set({ refillsUsed: sqlOp`${prescriptions.refillsUsed} + 1` })
      // The limit check lives in the UPDATE itself, so two simultaneous
      // requests can't both squeeze past the last remaining refill.
      .where(and(eq(prescriptions.id, id), eq(prescriptions.status, "active"), sqlOp`${prescriptions.refillsUsed} < ${prescriptions.refillsAllowed}`))
      .returning();
    return prescription;
  }

  // ---- Medications ----

  async createMedication(data: InsertMedication): Promise<Medication> {
    const [medication] = await db.insert(medications).values(data).returning();
    return medication;
  }

  async getMedication(id: string): Promise<Medication | undefined> {
    const [medication] = await db.select().from(medications).where(eq(medications.id, id));
    return medication;
  }

  async getMedicationByPrescriptionId(prescriptionId: string): Promise<Medication | undefined> {
    const [medication] = await db.select().from(medications).where(eq(medications.prescriptionId, prescriptionId));
    return medication;
  }

  async getMedicationsByPatient(patientUserId: string): Promise<Medication[]> {
    return db
      .select()
      .from(medications)
      .where(eq(medications.patientUserId, patientUserId))
      .orderBy(desc(medications.createdAt));
  }

  async setMedicationActive(id: string, active: boolean): Promise<Medication | undefined> {
    const [medication] = await db.update(medications).set({ active }).where(eq(medications.id, id)).returning();
    return medication;
  }

  // ---- Medication logs ----

  async upsertMedicationLog(data: InsertMedicationLog): Promise<MedicationLog> {
    const [log] = await db
      .insert(medicationLogs)
      .values(data)
      .onConflictDoUpdate({
        target: [medicationLogs.medicationId, medicationLogs.doseDate, medicationLogs.doseTime],
        set: { status: data.status, recordedAt: new Date() },
      })
      .returning();
    return log;
  }

  async deleteMedicationLog(medicationId: string, doseDate: string, doseTime: string): Promise<void> {
    await db
      .delete(medicationLogs)
      .where(and(eq(medicationLogs.medicationId, medicationId), eq(medicationLogs.doseDate, doseDate), eq(medicationLogs.doseTime, doseTime)));
  }

  async getMedicationLogsByPatientAndDate(patientUserId: string, doseDate: string): Promise<MedicationLog[]> {
    return db
      .select()
      .from(medicationLogs)
      .where(and(eq(medicationLogs.patientUserId, patientUserId), eq(medicationLogs.doseDate, doseDate)));
  }

  async getMedicationLogsByPatientRange(patientUserId: string, fromDate: string): Promise<MedicationLog[]> {
    return db
      .select()
      .from(medicationLogs)
      .where(and(eq(medicationLogs.patientUserId, patientUserId), sqlOp`${medicationLogs.doseDate} >= ${fromDate}`))
      .orderBy(medicationLogs.doseDate);
  }

  // ---- Pharmacies ----

  async getAllPharmacies(): Promise<Pharmacy[]> {
    return db.select().from(pharmacies);
  }

  async getPharmacy(id: string): Promise<Pharmacy | undefined> {
    const [pharmacy] = await db.select().from(pharmacies).where(eq(pharmacies.id, id));
    return pharmacy;
  }

  async createPharmacy(data: InsertPharmacy): Promise<Pharmacy> {
    const [pharmacy] = await db.insert(pharmacies).values(data).returning();
    return pharmacy;
  }

  // ---- Pharmacy orders ----

  async createPharmacyOrder(data: InsertPharmacyOrder): Promise<PharmacyOrder> {
    const [order] = await db.insert(pharmacyOrders).values(data).returning();
    return order;
  }

  async getPharmacyOrder(id: string): Promise<PharmacyOrder | undefined> {
    const [order] = await db.select().from(pharmacyOrders).where(eq(pharmacyOrders.id, id));
    return order;
  }

  async getPharmacyOrdersByPatient(patientUserId: string): Promise<PharmacyOrder[]> {
    return db
      .select()
      .from(pharmacyOrders)
      .where(eq(pharmacyOrders.patientUserId, patientUserId))
      .orderBy(desc(pharmacyOrders.createdAt));
  }

  async getPharmacyOrderByPrescriptionId(prescriptionId: string): Promise<PharmacyOrder | undefined> {
    const [order] = await db.select().from(pharmacyOrders).where(eq(pharmacyOrders.prescriptionId, prescriptionId));
    return order;
  }

  async advancePharmacyOrderStatus(
    id: string,
    status: string,
    statusHistory: { status: string; at: string }[],
  ): Promise<PharmacyOrder | undefined> {
    const [order] = await db.update(pharmacyOrders).set({ status, statusHistory }).where(eq(pharmacyOrders.id, id)).returning();
    return order;
  }

  // ---- Documents ----

  async createDocument(data: InsertDocument): Promise<Document> {
    const [document] = await db.insert(documents).values(data).returning();
    return document;
  }

  async getDocument(id: string): Promise<Document | undefined> {
    const [document] = await db.select().from(documents).where(eq(documents.id, id));
    return document;
  }

  async deleteDocument(id: string): Promise<void> {
    await db.delete(documents).where(eq(documents.id, id));
  }

  async getDocumentsByPatient(patientUserId: string): Promise<Document[]> {
    return db
      .select()
      .from(documents)
      .where(eq(documents.patientUserId, patientUserId))
      .orderBy(desc(documents.createdAt));
  }

  // ---- Follow-up tasks ----

  async createFollowUpTask(data: InsertFollowUpTask): Promise<FollowUpTask> {
    const [task] = await db.insert(followUpTasks).values(data).returning();
    return task;
  }

  async getFollowUpTasksByPatient(patientUserId: string): Promise<FollowUpTask[]> {
    return db
      .select()
      .from(followUpTasks)
      .where(eq(followUpTasks.patientUserId, patientUserId))
      .orderBy(followUpTasks.status, followUpTasks.dueDate);
  }

  async setFollowUpTaskStatus(id: string, status: "open" | "done"): Promise<FollowUpTask | undefined> {
    const [task] = await db
      .update(followUpTasks)
      .set({ status, completedAt: status === "done" ? new Date() : null })
      .where(eq(followUpTasks.id, id))
      .returning();
    return task;
  }

  // ---- Sharing grants (Privacy Center) ----

  async getSharingGrant(id: string): Promise<SharingGrant | undefined> {
    const [grant] = await db.select().from(sharingGrants).where(eq(sharingGrants.id, id));
    return grant;
  }

  async getActiveSharingGrantsByPatient(patientUserId: string): Promise<SharingGrant[]> {
    return db
      .select()
      .from(sharingGrants)
      .where(and(eq(sharingGrants.patientUserId, patientUserId), isNull(sharingGrants.revokedAt)));
  }

  async getActiveSharingGrantsByDoctorProfile(doctorProfileId: string): Promise<SharingGrant[]> {
    return db
      .select()
      .from(sharingGrants)
      .where(and(eq(sharingGrants.sharedWithDoctorProfileId, doctorProfileId), isNull(sharingGrants.revokedAt)));
  }

  async getActiveSharingGrantFor(patientUserId: string, doctorProfileId: string): Promise<SharingGrant | undefined> {
    const [grant] = await db
      .select()
      .from(sharingGrants)
      .where(
        and(
          eq(sharingGrants.patientUserId, patientUserId),
          eq(sharingGrants.sharedWithDoctorProfileId, doctorProfileId),
          isNull(sharingGrants.revokedAt),
        ),
      );
    return grant;
  }

  async upsertSharingGrant(data: InsertSharingGrant): Promise<SharingGrant> {
    const existing = await this.getActiveSharingGrantFor(data.patientUserId, data.sharedWithDoctorProfileId);
    if (existing) {
      const [grant] = await db
        .update(sharingGrants)
        .set({
          shareMedications: data.shareMedications,
          shareDocuments: data.shareDocuments,
          shareAppointments: data.shareAppointments,
          shareFullHistory: data.shareFullHistory,
        })
        .where(eq(sharingGrants.id, existing.id))
        .returning();
      return grant;
    }
    const [grant] = await db.insert(sharingGrants).values(data).returning();
    return grant;
  }

  async revokeSharingGrant(id: string): Promise<SharingGrant | undefined> {
    const [grant] = await db.update(sharingGrants).set({ revokedAt: new Date() }).where(eq(sharingGrants.id, id)).returning();
    return grant;
  }

  // ---- AI assistant messages ----

  async createAiMessage(data: InsertAiMessage): Promise<AiMessage> {
    const [message] = await db.insert(aiMessages).values(data).returning();
    return message;
  }

  async getAiMessagesByUser(userId: string, limit = 50): Promise<AiMessage[]> {
    const rows = await db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.userId, userId))
      .orderBy(desc(aiMessages.createdAt))
      .limit(limit);
    return rows.reverse();
  }

  async updateEmergencyProfile(
    userId: string,
    data: { emergencyContactName: string | null; emergencyContactPhone: string | null; allergiesText: string | null; emergencyNotes: string | null },
  ): Promise<User | undefined> {
    const [user] = await db.update(users).set(data).where(eq(users.id, userId)).returning();
    return user;
  }

  // ---- Care Circle ----

  async createCareCircleInvite(data: InsertCareCircleMember & { tokenHash: string }): Promise<CareCircleMember> {
    const [member] = await db.insert(careCircleMembers).values(data).returning();
    return member;
  }

  async getCareCircleMember(id: string): Promise<CareCircleMember | undefined> {
    const [member] = await db.select().from(careCircleMembers).where(eq(careCircleMembers.id, id));
    return member;
  }

  async getCareCircleMemberByTokenHash(tokenHash: string): Promise<CareCircleMember | undefined> {
    const [member] = await db.select().from(careCircleMembers).where(eq(careCircleMembers.tokenHash, tokenHash));
    return member;
  }

  async getCareCircleByPatient(patientUserId: string): Promise<CareCircleMember[]> {
    return db
      .select()
      .from(careCircleMembers)
      .where(eq(careCircleMembers.patientUserId, patientUserId))
      .orderBy(desc(careCircleMembers.invitedAt));
  }

  async getCareCircleByCaregiver(caregiverUserId: string): Promise<CareCircleMember[]> {
    return db
      .select()
      .from(careCircleMembers)
      .where(and(eq(careCircleMembers.caregiverUserId, caregiverUserId), eq(careCircleMembers.status, "active")));
  }

  async acceptCareCircleInvite(id: string, caregiverUserId: string): Promise<CareCircleMember | undefined> {
    const [member] = await db
      .update(careCircleMembers)
      .set({ caregiverUserId, status: "active", respondedAt: new Date(), tokenHash: null })
      .where(eq(careCircleMembers.id, id))
      .returning();
    return member;
  }

  async updateCareCirclePermissions(
    id: string,
    permissions: { permissionMedicationStatus: boolean; permissionAppointments: boolean; permissionDeliveryStatus: boolean; permissionDocuments: boolean; permissionFullRecords: boolean },
  ): Promise<CareCircleMember | undefined> {
    const [member] = await db.update(careCircleMembers).set(permissions).where(eq(careCircleMembers.id, id)).returning();
    return member;
  }

  async revokeCareCircleMember(id: string): Promise<CareCircleMember | undefined> {
    const [member] = await db.update(careCircleMembers).set({ status: "revoked" }).where(eq(careCircleMembers.id, id)).returning();
    return member;
  }
}

export const storage = new DbStorage();
