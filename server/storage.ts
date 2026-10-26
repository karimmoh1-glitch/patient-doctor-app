import { eq, and, desc, isNull, inArray, sql as sqlOp } from "drizzle-orm";

export type PairingStatus = "requested" | "accepted" | "declined" | "cancelled" | "ended";
import { db } from "./db";
import { runAsSystem } from "./dbContext";
import { fixtureAccountsAllowed } from "./config";
import {
  users, userDevices, passwordResetTokens, emailVerificationTokens, auditLogs,
  doctorApplications, doctorProfiles, symptomReports, pairingRequests, messages,
  appointments, prescriptions, prescriptionEvents, notifications, medicationReminders, reminderDeliveries, jobRuns, jobRunHistory, dataRequests, userMfa, mfaRecoveryCodes, messageReports, userBlocks, medications, medicationLogs, pharmacies, pharmacyOrders,
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
  type Message, type InsertMessage, type MessageReport,
  type Appointment, type InsertAppointment,
  type Prescription, type InsertPrescription, type PrescriptionEvent,
  type Notification, type InsertNotification,
  type MedicationReminder, type InsertMedicationReminder,
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

  updateUserLanguage(userId: string, language: string): Promise<User | undefined>;
  invalidatePasswordResetTokens(email: string): Promise<void>;
  createDoctorApplication(data: InsertDoctorApplication): Promise<DoctorApplication>;
  getDoctorApplication(id: string): Promise<DoctorApplication | undefined>;
  getDoctorApplicationByUserId(userId: string): Promise<DoctorApplication | undefined>;
  getDoctorApplicationByEmail(email: string): Promise<DoctorApplication | undefined>;
  listDoctorApplications(statuses: string[]): Promise<DoctorApplication[]>;
  countDoctorApplicationsByStatus(): Promise<Record<string, number>>;

  /** Creates the doctor's account and an "incomplete" application together, or neither. */
  registerDoctor(user: InsertUser, language: string): Promise<{ user: User; application: DoctorApplication }>;
  /** Saves profile fields while the application is still editable (incomplete / needs_info). */
  saveDoctorApplicationDraft(id: string, fields: Partial<InsertDoctorApplication>): Promise<DoctorApplication | undefined>;
  /** incomplete|needs_info -> pending, atomically. Undefined if it was not in a submittable state. */
  submitDoctorApplication(id: string): Promise<DoctorApplication | undefined>;
  /** pending -> needs_info with a message for the applicant. */
  requestDoctorApplicationInfo(id: string, reviewerUserId: string, message: string): Promise<DoctorApplication | undefined>;
  /** pending|needs_info -> rejected. */
  rejectDoctorApplication(id: string, reviewerUserId: string, reason?: string): Promise<DoctorApplication | undefined>;
  /**
   * pending -> approved as ONE transaction: claim the application and create
   * the doctor's public profile. Role and ownership never come from request
   * input. If any step fails nothing is kept.
   */
  approveDoctorApplication(applicationId: string, reviewerUserId: string, timezone: string): Promise<
    | { ok: true; profile: DoctorProfile; application: DoctorApplication }
    | { ok: false; reason: "not_reviewable" | "incomplete_application" }
  >;
  /** approved -> suspended: hides the profile and ends the doctor's sessions. */
  suspendDoctor(applicationId: string, reviewerUserId: string, reason?: string): Promise<DoctorApplication | undefined>;
  /** suspended -> approved. */
  reinstateDoctor(applicationId: string, reviewerUserId: string): Promise<DoctorApplication | undefined>;
  updateDoctorProfileSelf(profileId: string, fields: Partial<Pick<DoctorProfile, "bio" | "languages" | "modalities" | "clinic" | "phone">>): Promise<DoctorProfile | undefined>;
  createDoctorProfile(data: InsertDoctorProfile): Promise<DoctorProfile>;
  getDoctorProfile(id: string): Promise<DoctorProfile | undefined>;
  getDoctorProfileByUserId(userId: string): Promise<DoctorProfile | undefined>;
  getActiveDoctorProfiles(): Promise<DoctorProfile[]>;
  getListableDoctorProfile(id: string): Promise<DoctorProfile | undefined>;

  createSymptomReport(data: InsertSymptomReport): Promise<SymptomReport>;
  getSymptomReport(id: string): Promise<SymptomReport | undefined>;
  getSymptomReportsByPatient(patientUserId: string): Promise<SymptomReport[]>;
  getSharingGrantsByPatient(patientUserId: string): Promise<SharingGrant[]>;

  createPairingRequest(data: InsertPairingRequest): Promise<PairingRequest>;
  getPairingRequest(id: string): Promise<PairingRequest | undefined>;
  getPairingRequestsByPatient(patientUserId: string): Promise<PairingRequest[]>;
  getPairingRequestsByDoctorProfile(doctorProfileId: string): Promise<PairingRequest[]>;
  updatePairingRequestStatus(id: string, status: "accepted" | "declined" | "cancelled"): Promise<PairingRequest | undefined>;
  /** Moves a connection to `to` only if it is currently in one of `from`. Returns undefined if the guard failed. */
  transitionPairingStatus(id: string, from: PairingStatus[], to: PairingStatus): Promise<PairingRequest | undefined>;

  createMessage(data: InsertMessage): Promise<Message>;
  getMessagesByPairing(pairingRequestId: string): Promise<Message[]>;
  /** Stores a message unless the same sender already sent this client id in this conversation, in which case the original is returned. */
  createMessageIdempotent(data: InsertMessage): Promise<{ message: Message; created: boolean }>;
  /** The newest `limit` messages older than `before` (all, if omitted), oldest first. */
  getMessagesPage(pairingRequestId: string, opts: { before?: Date; limit: number }): Promise<Message[]>;
  markMessagesDelivered(pairingRequestId: string, recipientUserId: string): Promise<number>;
  markMessagesRead(pairingRequestId: string, recipientUserId: string): Promise<number>;
  getConversationStats(pairingIds: string[], userId: string): Promise<Map<string, { lastAt: Date | null; lastBody: string | null; lastSenderUserId: string | null; unread: number }>>;
  searchMessages(pairingIds: string[], query: string, limit: number): Promise<{ id: string; pairingRequestId: string; senderUserId: string; body: string; createdAt: Date | null }[]>;
  setReadReceipts(userId: string, enabled: boolean): Promise<void>;
  getMessage(id: string): Promise<Message | undefined>;
  createMessageReport(data: { reporterUserId: string; pairingRequestId: string; messageId: string | null; reason: string; details: string | null; sharedText: string | null }): Promise<MessageReport>;
  listMessageReports(status: "open" | "resolved"): Promise<(MessageReport & { reporterName: string })[]>;
  resolveMessageReport(id: string, adminUserId: string, note: string | null): Promise<MessageReport | undefined>;
  blockUser(blockerUserId: string, blockedUserId: string): Promise<void>;
  isBlockedEitherWay(a: string, b: string): Promise<boolean>;

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
  /** Drafts only: replaces the editable clinical fields. */
  updatePrescriptionDraft(id: string, fields: Partial<InsertPrescription>): Promise<Prescription | undefined>;
  /** draft -> active, atomically, stamping who authorized it and when. */
  authorizePrescription(id: string, authorizedByUserId: string, now: Date): Promise<Prescription | undefined>;
  /** draft|active -> cancelled, atomically. */
  cancelPrescription(id: string): Promise<Prescription | undefined>;
  /** Marks authorized prescriptions whose end date has passed as expired; returns the ones changed. */
  expireDuePrescriptions(now: Date): Promise<Prescription[]>;
  addPrescriptionEvent(prescriptionId: string, actorUserId: string | null, event: string): Promise<void>;
  getPrescriptionEvents(prescriptionId: string): Promise<PrescriptionEvent[]>;

  getReminderByMedication(medicationId: string): Promise<MedicationReminder | undefined>;
  getRemindersByPatient(patientUserId: string): Promise<MedicationReminder[]>;
  upsertReminder(data: InsertMedicationReminder): Promise<MedicationReminder>;
  deleteReminderByMedication(medicationId: string, patientUserId: string): Promise<boolean>;
  /** Enabled reminders for tracked, still-active medicines with an authorized, unexpired prescription. */
  getDispatchableReminders(): Promise<{ reminder: MedicationReminder; medicationName: string; email: string; language: string }[]>;
  /** Inserts the delivery row; true only for the caller that created it (so only one sender ever acts). */
  /** In-app notice and its delivery record in ONE transaction: both exist or neither. True only for the caller that created them. */
  deliverInApp(reminderId: string, dueAt: Date, notification: InsertNotification): Promise<boolean>;
  /** Inserts the email delivery row (attempt 1); the id is returned only to the caller that created it. */
  claimReminderDelivery(reminderId: string, dueAt: Date, channel: string): Promise<string | null>;
  /** Takes over a failed (or abandoned) email attempt, if attempts remain. Returns the delivery id or null. */
  retryReminderDelivery(reminderId: string, dueAt: Date, channel: string, maxAttempts: number, staleAfterMinutes: number): Promise<string | null>;
  finishReminderDelivery(id: string, status: "sent" | "failed", errorCode?: string): Promise<void>;
  getDeliveriesSince(since: Date): Promise<{ reminderId: string; dueAt: Date; channel: string; status: string; attempts: number; updatedAt: Date }[]>;
  getRecentDeliveriesForReminders(reminderIds: string[], limit: number): Promise<{ reminderId: string; dueAt: Date; channel: string; status: string; attempts: number }[]>;
  recordJobRun(job: string, now: Date, result: Record<string, unknown>, outcome: { ok: true } | { ok: false; error: string }): Promise<void>;
  getJobRun(job: string): Promise<{ lastRunAt: Date; lastSuccessAt: Date | null; lastError: string | null; consecutiveFailures: number; lastResult: Record<string, unknown> } | undefined>;
  /**
   * Takes the job's lease if nobody holds an unexpired one. Exactly one of any
   * number of simultaneous callers gets true; a crashed run's lease simply expires.
   */
  acquireJobLease(job: string, runId: string, now: Date, leaseMs: number): Promise<boolean>;
  /** Records the outcome only if this run still holds the lease (a superseded run changes nothing), then releases it. */
  finishJobRun(job: string, runId: string, now: Date, result: Record<string, unknown>, outcome: { ok: true } | { ok: false; error: string }): Promise<boolean>;
  startJobRunHistory(entry: { job: string; runId: string; source: string; startedAt: Date; outcome?: string }): Promise<void>;
  finishJobRunHistory(job: string, runId: string, entry: { finishedAt: Date; outcome: string; durationMs: number; error?: string; result?: Record<string, unknown> }): Promise<void>;
  getJobRunHistory(job: string, since: Date): Promise<{ runId: string; source: string; startedAt: Date; finishedAt: Date | null; outcome: string; durationMs: number | null }[]>;
  pruneJobRunHistory(job: string, before: Date): Promise<void>;
  getAllEnabledReminders(): Promise<MedicationReminder[]>;
  // Multi-factor sign-in. System access: only the authentication code touches these.
  getMfa(userId: string): Promise<{ secretCiphertext: string; pending: boolean; enabledAt: Date | null; lastUsedStep: number; failedAttempts: number; lockedUntil: Date | null } | undefined>;
  beginMfaEnrollment(userId: string, secretCiphertext: string): Promise<boolean>;
  enableMfa(userId: string, step: number): Promise<boolean>;
  /** Accepts a time-step only if it is newer than any already used (replay protection); resets the failure count. */
  recordMfaSuccess(userId: string, step: number, allowReuse: boolean): Promise<boolean>;
  recordMfaFailure(userId: string, now: Date, maxAttempts: number, lockMinutes: number): Promise<{ failedAttempts: number; lockedUntil: Date | null }>;
  clearMfaFailures(userId: string): Promise<void>;
  replaceRecoveryCodes(userId: string, hashes: string[]): Promise<void>;
  consumeRecoveryCode(userId: string, hash: string): Promise<boolean>;
  countRecoveryCodes(userId: string): Promise<number>;
  resetMfa(userId: string): Promise<void>;
  createDataRequest(userId: string, kind: "export" | "deletion"): Promise<{ id: string }>;
  deactivateUser(userId: string): Promise<void>;
  /** Atomically marks and returns confirmed visits starting within `hours` whose notice hasn't gone out. */
  claimDueAppointmentReminders(now: Date, hours: number): Promise<Appointment[]>;
  hasUnreadNotification(userId: string, kind: string, link: string): Promise<boolean>;
  createNotification(data: InsertNotification): Promise<Notification>;
  getNotificationsForUser(userId: string, limit: number): Promise<Notification[]>;
  countUnreadNotifications(userId: string): Promise<number>;
  markNotificationsRead(userId: string, ids?: string[]): Promise<void>;
  markNotificationsReadForLink(userId: string, linkPrefix: string): Promise<void>;
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

  async updateUserLanguage(userId: string, language: string): Promise<User | undefined> {
    const [user] = await db.update(users).set({ language }).where(eq(users.id, userId)).returning();
    return user;
  }

  async invalidatePasswordResetTokens(email: string) {
    await db.update(passwordResetTokens).set({ used: true }).where(and(eq(passwordResetTokens.email, email), eq(passwordResetTokens.used, false)));
  }

  async createDoctorApplication(data: InsertDoctorApplication): Promise<DoctorApplication> {
    const [application] = await db.insert(doctorApplications).values(data).returning();
    return application;
  }

  async getDoctorApplication(id: string): Promise<DoctorApplication | undefined> {
    const [application] = await db.select().from(doctorApplications).where(eq(doctorApplications.id, id));
    return application;
  }

  async getDoctorApplicationByUserId(userId: string): Promise<DoctorApplication | undefined> {
    const [application] = await db.select().from(doctorApplications).where(eq(doctorApplications.userId, userId));
    return application;
  }

  async getDoctorApplicationByEmail(email: string): Promise<DoctorApplication | undefined> {
    const [application] = await db.select().from(doctorApplications).where(eq(doctorApplications.email, email));
    return application;
  }

  async listDoctorApplications(statuses: string[]): Promise<DoctorApplication[]> {
    if (!statuses.length) return [];
    return db
      .select()
      .from(doctorApplications)
      .where(inArray(doctorApplications.status, statuses))
      .orderBy(desc(doctorApplications.createdAt));
  }

  async countDoctorApplicationsByStatus(): Promise<Record<string, number>> {
    const rows = await db
      .select({ status: doctorApplications.status, n: sqlOp<number>`count(*)::int` })
      .from(doctorApplications)
      .groupBy(doctorApplications.status);
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  async registerDoctor(user: InsertUser, language: string) {
    return db.transaction(async (tx) => {
      // Role is fixed here, never taken from request input.
      const [created] = await tx.insert(users).values({ ...user, role: "doctor", language }).returning();
      const [application] = await tx
        .insert(doctorApplications)
        .values({ userId: created.id, name: created.name, email: created.email, status: "incomplete" })
        .returning();
      return { user: created, application };
    });
  }

  async saveDoctorApplicationDraft(id: string, fields: Partial<InsertDoctorApplication>) {
    const [application] = await db
      .update(doctorApplications)
      .set(fields)
      .where(and(eq(doctorApplications.id, id), inArray(doctorApplications.status, ["incomplete", "needs_info"])))
      .returning();
    return application;
  }

  async submitDoctorApplication(id: string) {
    const [application] = await db
      .update(doctorApplications)
      .set({ status: "pending", submittedAt: new Date(), infoRequest: null })
      .where(and(eq(doctorApplications.id, id), inArray(doctorApplications.status, ["incomplete", "needs_info"])))
      .returning();
    return application;
  }

  async requestDoctorApplicationInfo(id: string, reviewerUserId: string, message: string) {
    const [application] = await db
      .update(doctorApplications)
      .set({ status: "needs_info", infoRequest: message, reviewedByUserId: reviewerUserId, reviewedAt: new Date() })
      .where(and(eq(doctorApplications.id, id), eq(doctorApplications.status, "pending")))
      .returning();
    return application;
  }

  async rejectDoctorApplication(id: string, reviewerUserId: string, reason?: string) {
    const [application] = await db
      .update(doctorApplications)
      .set({ status: "rejected", reviewedByUserId: reviewerUserId, reviewedAt: new Date(), reviewerNotes: reason ?? null })
      .where(and(eq(doctorApplications.id, id), inArray(doctorApplications.status, ["pending", "needs_info"])))
      .returning();
    return application;
  }

  async approveDoctorApplication(applicationId: string, reviewerUserId: string, timezone: string) {
    return db.transaction(async (tx) => {
      const [application] = await tx
        .update(doctorApplications)
        .set({ status: "approved", reviewedByUserId: reviewerUserId, reviewedAt: new Date(), infoRequest: null })
        .where(and(eq(doctorApplications.id, applicationId), eq(doctorApplications.status, "pending")))
        .returning();
      if (!application || !application.userId) return { ok: false, reason: "not_reviewable" } as const;

      const state = application.licensedStates?.[0];
      if (!application.specialty || !application.licenseNumber || !application.phone || !state) {
        // Submission validates these, so this only guards against a row edited by hand.
        tx.rollback();
        return { ok: false, reason: "incomplete_application" } as const;
      }
      const [profile] = await tx
        .insert(doctorProfiles)
        .values({
          userId: application.userId,
          name: application.displayName?.trim() || application.name,
          specialty: application.specialty,
          state,
          licenseNumber: application.licenseNumber,
          npiNumber: application.npiNumber,
          phone: application.phone,
          bio: application.bio,
          active: true,
          source: "application",
          timezone,
          languages: application.languages ?? [],
          modalities: application.modalities ?? ["phone"],
          clinic: application.clinic,
          qualifications: application.qualifications,
          yearsExperience: application.yearsExperience,
          licensingBody: application.licensingBody,
          professionalRole: application.professionalRole,
          verifiedAt: new Date(),
          verifiedByUserId: reviewerUserId,
        })
        .returning();
      await tx.update(users).set({ state, phone: application.phone }).where(eq(users.id, application.userId));
      return { ok: true, profile, application } as const;
    }).catch((err) => {
      if (err?.name === "TransactionRollbackError") return { ok: false, reason: "incomplete_application" } as const;
      throw err;
    });
  }

  // An administrator acting on someone else's account: it ends that doctor's sessions, which are theirs.
  async suspendDoctor(applicationId: string, reviewerUserId: string, reason?: string) {
    return runAsSystem(() => this.suspendDoctorUnscoped(applicationId, reviewerUserId, reason));
  }

  private async suspendDoctorUnscoped(applicationId: string, reviewerUserId: string, reason?: string) {
    return db.transaction(async (tx) => {
      const [application] = await tx
        .update(doctorApplications)
        .set({ status: "suspended", reviewedByUserId: reviewerUserId, reviewedAt: new Date(), reviewerNotes: reason ?? null })
        .where(and(eq(doctorApplications.id, applicationId), eq(doctorApplications.status, "approved")))
        .returning();
      if (!application?.userId) return undefined;
      await tx.update(doctorProfiles).set({ active: false }).where(eq(doctorProfiles.userId, application.userId));
      await tx.update(userDevices).set({ revokedAt: new Date() }).where(and(eq(userDevices.userId, application.userId), isNull(userDevices.revokedAt)));
      return application;
    });
  }

  async reinstateDoctor(applicationId: string, reviewerUserId: string) {
    return db.transaction(async (tx) => {
      const [application] = await tx
        .update(doctorApplications)
        .set({ status: "approved", reviewedByUserId: reviewerUserId, reviewedAt: new Date(), reviewerNotes: null })
        .where(and(eq(doctorApplications.id, applicationId), eq(doctorApplications.status, "suspended")))
        .returning();
      if (!application?.userId) return undefined;
      await tx.update(doctorProfiles).set({ active: true }).where(eq(doctorProfiles.userId, application.userId));
      return application;
    });
  }

  async updateDoctorProfileSelf(profileId: string, fields: Partial<Pick<DoctorProfile, "bio" | "languages" | "modalities" | "clinic" | "phone">>) {
    const [profile] = await db.update(doctorProfiles).set(fields).where(eq(doctorProfiles.id, profileId)).returning();
    return profile;
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

  /**
   * Providers a patient may see and ask: active, able to answer (they have a login), and never a fixture:
   * a production server hides any provider whose account is marked as a fixture, whatever else is in the database.
   */
  async getActiveDoctorProfiles(): Promise<DoctorProfile[]> {
    return db.select().from(doctorProfiles).where(this.listable());
  }

  async getListableDoctorProfile(id: string): Promise<DoctorProfile | undefined> {
    const [row] = await db.select().from(doctorProfiles).where(and(eq(doctorProfiles.id, id), this.listable()));
    return row;
  }

  private listable() {
    const base = and(eq(doctorProfiles.active, true), sqlOp`${doctorProfiles.userId} IS NOT NULL`);
    return fixtureAccountsAllowed()
      ? base
      : and(base, sqlOp`NOT EXISTS (SELECT 1 FROM users u WHERE u.id = ${doctorProfiles.userId} AND u.is_demo)`);
  }

  async createSymptomReport(data: InsertSymptomReport): Promise<SymptomReport> {
    const [report] = await db.insert(symptomReports).values(data).returning();
    return report;
  }

  async getSymptomReportsByPatient(patientUserId: string): Promise<SymptomReport[]> {
    return db.select().from(symptomReports).where(eq(symptomReports.patientUserId, patientUserId)).orderBy(desc(symptomReports.createdAt));
  }

  async getSharingGrantsByPatient(patientUserId: string): Promise<SharingGrant[]> {
    return db.select().from(sharingGrants).where(eq(sharingGrants.patientUserId, patientUserId)).orderBy(desc(sharingGrants.grantedAt));
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

  async createMessageIdempotent(data: InsertMessage) {
    if (!data.clientMessageId) return { message: await this.createMessage(data), created: true };
    const [inserted] = await db.insert(messages).values(data).onConflictDoNothing().returning();
    if (inserted) return { message: inserted, created: true };
    const [existing] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.pairingRequestId, data.pairingRequestId), eq(messages.senderUserId, data.senderUserId), eq(messages.clientMessageId, data.clientMessageId)));
    return { message: existing, created: false };
  }

  async getMessagesPage(pairingRequestId: string, opts: { before?: Date; limit: number }) {
    const conditions = [eq(messages.pairingRequestId, pairingRequestId)];
    // ISO text, not a Date object: the column is a timestamp without a zone that holds UTC, and a Date would be sent in local time.
    if (opts.before) conditions.push(sqlOp`${messages.createdAt} < ${opts.before.toISOString()}::timestamp`);
    const rows = await db.select().from(messages).where(and(...conditions)).orderBy(desc(messages.createdAt)).limit(opts.limit);
    return rows.reverse();
  }

  async markMessagesDelivered(pairingRequestId: string, recipientUserId: string) {
    const rows = await db
      .update(messages)
      .set({ deliveredAt: new Date() })
      .where(and(eq(messages.pairingRequestId, pairingRequestId), sqlOp`${messages.senderUserId} <> ${recipientUserId}`, isNull(messages.deliveredAt)))
      .returning({ id: messages.id });
    return rows.length;
  }

  async markMessagesRead(pairingRequestId: string, recipientUserId: string) {
    const now = new Date();
    const rows = await db
      .update(messages)
      .set({ readAt: now, deliveredAt: sqlOp`COALESCE(${messages.deliveredAt}, ${now})` })
      .where(and(eq(messages.pairingRequestId, pairingRequestId), sqlOp`${messages.senderUserId} <> ${recipientUserId}`, isNull(messages.readAt)))
      .returning({ id: messages.id });
    return rows.length;
  }

  async getConversationStats(pairingIds: string[], userId: string) {
    const out = new Map<string, { lastAt: Date | null; lastBody: string | null; lastSenderUserId: string | null; unread: number }>();
    if (!pairingIds.length) return out;
    const ids = sqlOp.join(pairingIds.map((id) => sqlOp`${id}`), sqlOp`, `);
    const res = await db.execute(sqlOp`
      SELECT pairing_request_id,
             max(created_at) AS last_at,
             (array_agg(body ORDER BY created_at DESC))[1] AS last_body,
             (array_agg(sender_user_id ORDER BY created_at DESC))[1] AS last_sender,
             count(*) FILTER (WHERE sender_user_id <> ${userId} AND read_at IS NULL)::int AS unread
        FROM messages WHERE pairing_request_id IN (${ids}) GROUP BY pairing_request_id`);
    for (const r of res.rows as any[]) {
      out.set(r.pairing_request_id, {
        lastAt: r.last_at ? new Date(typeof r.last_at === "string" && !/[zZ]|[+-]\d\d/.test(r.last_at) ? r.last_at.replace(" ", "T") + "Z" : r.last_at) : null,
        lastBody: r.last_body ?? null,
        lastSenderUserId: r.last_sender ?? null,
        unread: r.unread ?? 0,
      });
    }
    return out;
  }

  async searchMessages(pairingIds: string[], query: string, limit: number) {
    if (!pairingIds.length) return [];
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    return db
      .select({ id: messages.id, pairingRequestId: messages.pairingRequestId, senderUserId: messages.senderUserId, body: messages.body, createdAt: messages.createdAt })
      .from(messages)
      .where(and(inArray(messages.pairingRequestId, pairingIds), sqlOp`${messages.body} ILIKE ${"%" + escaped + "%"} ESCAPE '\\'`))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
  }

  async setReadReceipts(userId: string, enabled: boolean) {
    await db.update(users).set({ readReceipts: enabled }).where(eq(users.id, userId));
  }

  async getMessage(id: string) {
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    return row;
  }

  async createMessageReport(data: { reporterUserId: string; pairingRequestId: string; messageId: string | null; reason: string; details: string | null; sharedText: string | null }) {
    const [row] = await db.insert(messageReports).values(data).returning();
    return row;
  }

  // Reviewing reports is an administrator's job and sees only what the reporter chose to attach.
  async listMessageReports(status: "open" | "resolved") {
    return runAsSystem(async () => {
      const rows = await db
        .select({ report: messageReports, reporterName: users.name })
        .from(messageReports)
        .innerJoin(users, eq(users.id, messageReports.reporterUserId))
        .where(eq(messageReports.status, status))
        .orderBy(desc(messageReports.createdAt))
        .limit(200);
      return rows.map((r) => ({ ...r.report, reporterName: r.reporterName }));
    });
  }

  async resolveMessageReport(id: string, adminUserId: string, note: string | null) {
    return runAsSystem(async () => {
      const [row] = await db
        .update(messageReports)
        .set({ status: "resolved", resolvedByUserId: adminUserId, resolvedAt: new Date(), resolutionNote: note })
        .where(and(eq(messageReports.id, id), eq(messageReports.status, "open")))
        .returning();
      return row;
    });
  }

  async blockUser(blockerUserId: string, blockedUserId: string) {
    await db.insert(userBlocks).values({ blockerUserId, blockedUserId }).onConflictDoNothing();
  }

  // Whether either person has blocked the other. Asked about someone else's block list, so it is a server check.
  async isBlockedEitherWay(a: string, b: string) {
    return runAsSystem(async () => {
      const rows = await db
        .select({ x: userBlocks.blockerUserId })
        .from(userBlocks)
        .where(sqlOp`(${userBlocks.blockerUserId} = ${a} AND ${userBlocks.blockedUserId} = ${b}) OR (${userBlocks.blockerUserId} = ${b} AND ${userBlocks.blockedUserId} = ${a})`)
        .limit(1);
      return rows.length > 0;
    });
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

  // Drafts are the doctor's working copy and are never shown to the patient.
  async getPrescriptionsByPatient(patientUserId: string): Promise<Prescription[]> {
    return db
      .select()
      .from(prescriptions)
      .where(and(eq(prescriptions.patientUserId, patientUserId), sqlOp`${prescriptions.status} <> 'draft'`))
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

  async updatePrescriptionDraft(id: string, fields: Partial<InsertPrescription>) {
    const [prescription] = await db
      .update(prescriptions)
      .set(fields)
      .where(and(eq(prescriptions.id, id), eq(prescriptions.status, "draft")))
      .returning();
    return prescription;
  }

  async authorizePrescription(id: string, authorizedByUserId: string, now: Date) {
    return db.transaction(async (tx) => {
      const [current] = await tx.select().from(prescriptions).where(and(eq(prescriptions.id, id), eq(prescriptions.status, "draft")));
      if (!current) return undefined;
      // The course starts when it is authorized, not when it was first drafted.
      const endDate = current.durationDays ? new Date(now.getTime() + current.durationDays * 86_400_000) : null;
      const [prescription] = await tx
        .update(prescriptions)
        .set({ status: "active", authorizedAt: now, issuedAt: now, authorizedByUserId, startDate: now, endDate })
        .where(and(eq(prescriptions.id, id), eq(prescriptions.status, "draft")))
        .returning();
      return prescription;
    });
  }

  async cancelPrescription(id: string) {
    const [prescription] = await db
      .update(prescriptions)
      .set({ status: "cancelled" })
      .where(and(eq(prescriptions.id, id), inArray(prescriptions.status, ["draft", "active"])))
      .returning();
    return prescription;
  }

  async expireDuePrescriptions(now: Date) {
    return db
      .update(prescriptions)
      .set({ status: "expired" })
      .where(and(eq(prescriptions.status, "active"), sqlOp`${prescriptions.endDate} IS NOT NULL AND ${prescriptions.endDate} < ${now}`))
      .returning();
  }

  async addPrescriptionEvent(prescriptionId: string, actorUserId: string | null, event: string) {
    await db.insert(prescriptionEvents).values({ prescriptionId, actorUserId, event });
  }

  async getPrescriptionEvents(prescriptionId: string) {
    return db.select().from(prescriptionEvents).where(eq(prescriptionEvents.prescriptionId, prescriptionId)).orderBy(prescriptionEvents.createdAt);
  }

  async getReminderByMedication(medicationId: string) {
    const [row] = await db.select().from(medicationReminders).where(eq(medicationReminders.medicationId, medicationId));
    return row;
  }

  async getRemindersByPatient(patientUserId: string) {
    return db.select().from(medicationReminders).where(eq(medicationReminders.patientUserId, patientUserId));
  }

  async upsertReminder(data: InsertMedicationReminder) {
    const [row] = await db
      .insert(medicationReminders)
      .values(data)
      .onConflictDoUpdate({
        target: medicationReminders.medicationId,
        set: {
          times: data.times,
          weekdays: data.weekdays,
          timezone: data.timezone,
          endDate: data.endDate ?? null,
          enabled: data.enabled,
          emailEnabled: data.emailEnabled,
          showMedicationName: data.showMedicationName,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async deleteReminderByMedication(medicationId: string, patientUserId: string) {
    const rows = await db
      .delete(medicationReminders)
      .where(and(eq(medicationReminders.medicationId, medicationId), eq(medicationReminders.patientUserId, patientUserId)))
      .returning();
    return rows.length > 0;
  }

  async getDispatchableReminders() {
    const rows = await db
      .select({
        reminder: medicationReminders,
        medicationName: medications.name,
        email: users.email,
        language: users.language,
      })
      .from(medicationReminders)
      .innerJoin(medications, eq(medications.id, medicationReminders.medicationId))
      .innerJoin(prescriptions, eq(prescriptions.id, medications.prescriptionId))
      .innerJoin(users, eq(users.id, medicationReminders.patientUserId))
      .where(
        and(
          eq(medicationReminders.enabled, true),
          eq(medications.active, true),
          eq(prescriptions.status, "active"),
          isNull(users.deactivatedAt),
        ),
      );
    return rows;
  }

  async deliverInApp(reminderId: string, dueAt: Date, notification: InsertNotification) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(reminderDeliveries)
        .values({ reminderId, dueAt, channel: "in_app", status: "sent", sentAt: new Date() })
        .onConflictDoNothing()
        .returning({ id: reminderDeliveries.id });
      if (!row) return false;
      await tx.insert(notifications).values(notification);
      return true;
    });
  }

  async claimReminderDelivery(reminderId: string, dueAt: Date, channel: string) {
    const [row] = await db
      .insert(reminderDeliveries)
      .values({ reminderId, dueAt, channel })
      .onConflictDoNothing()
      .returning({ id: reminderDeliveries.id });
    return row?.id ?? null;
  }

  async retryReminderDelivery(reminderId: string, dueAt: Date, channel: string, maxAttempts: number, staleAfterMinutes: number) {
    const [row] = await db
      .update(reminderDeliveries)
      .set({ status: "pending", attempts: sqlOp`${reminderDeliveries.attempts} + 1`, updatedAt: new Date() })
      .where(and(
        eq(reminderDeliveries.reminderId, reminderId),
        eq(reminderDeliveries.dueAt, dueAt),
        eq(reminderDeliveries.channel, channel),
        sqlOp`${reminderDeliveries.attempts} < ${maxAttempts}`,
        sqlOp`(${reminderDeliveries.status} = 'failed' OR (${reminderDeliveries.status} = 'pending' AND ${reminderDeliveries.updatedAt} < now() - make_interval(mins => ${staleAfterMinutes})))`,
      ))
      .returning({ id: reminderDeliveries.id });
    return row?.id ?? null;
  }

  async finishReminderDelivery(id: string, status: "sent" | "failed", errorCode?: string) {
    await db
      .update(reminderDeliveries)
      .set({ status, errorCode: errorCode ?? null, sentAt: status === "sent" ? new Date() : null, updatedAt: new Date() })
      .where(eq(reminderDeliveries.id, id));
  }

  async getDeliveriesSince(since: Date) {
    return db
      .select({
        reminderId: reminderDeliveries.reminderId, dueAt: reminderDeliveries.dueAt, channel: reminderDeliveries.channel,
        status: reminderDeliveries.status, attempts: reminderDeliveries.attempts, updatedAt: reminderDeliveries.updatedAt,
      })
      .from(reminderDeliveries)
      .where(sqlOp`${reminderDeliveries.dueAt} >= ${since}`);
  }

  async getRecentDeliveriesForReminders(reminderIds: string[], limit: number) {
    if (!reminderIds.length) return [];
    return db
      .select({ reminderId: reminderDeliveries.reminderId, dueAt: reminderDeliveries.dueAt, channel: reminderDeliveries.channel, status: reminderDeliveries.status, attempts: reminderDeliveries.attempts })
      .from(reminderDeliveries)
      .where(inArray(reminderDeliveries.reminderId, reminderIds))
      .orderBy(desc(reminderDeliveries.dueAt))
      .limit(limit * reminderIds.length);
  }

  async recordJobRun(job: string, now: Date, result: Record<string, unknown>, outcome: { ok: true } | { ok: false; error: string }) {
    if (outcome.ok) {
      await db
        .insert(jobRuns)
        .values({ job, lastRunAt: now, lastResult: result, lastSuccessAt: now, lastError: null, consecutiveFailures: 0 })
        .onConflictDoUpdate({ target: jobRuns.job, set: { lastRunAt: now, lastResult: result, lastSuccessAt: now, lastError: null, consecutiveFailures: 0 } });
    } else {
      await db
        .insert(jobRuns)
        .values({ job, lastRunAt: now, lastResult: result, lastError: outcome.error, consecutiveFailures: 1 })
        .onConflictDoUpdate({
          target: jobRuns.job,
          set: { lastRunAt: now, lastError: outcome.error, consecutiveFailures: sqlOp`${jobRuns.consecutiveFailures} + 1` },
        });
    }
  }

  async getJobRun(job: string) {
    const [row] = await db.select().from(jobRuns).where(eq(jobRuns.job, job));
    return row
      ? { lastRunAt: row.lastRunAt, lastSuccessAt: row.lastSuccessAt, lastError: row.lastError, consecutiveFailures: row.consecutiveFailures, lastResult: row.lastResult }
      : undefined;
  }

  async acquireJobLease(job: string, runId: string, now: Date, leaseMs: number) {
    const until = new Date(now.getTime() + leaseMs);
    const res = await db.execute(sqlOp`
      INSERT INTO job_runs (job, last_run_at, lease_run_id, lease_until)
      VALUES (${job}, ${now}, ${runId}, ${until})
      ON CONFLICT (job) DO UPDATE
        SET lease_run_id = EXCLUDED.lease_run_id, lease_until = EXCLUDED.lease_until
        WHERE job_runs.lease_until IS NULL OR job_runs.lease_until <= ${now}
      RETURNING job`);
    return res.rows.length === 1;
  }

  async finishJobRun(job: string, runId: string, now: Date, result: Record<string, unknown>, outcome: { ok: true } | { ok: false; error: string }) {
    const rows = outcome.ok
      ? await db.update(jobRuns)
          .set({ lastRunAt: now, lastResult: result, lastSuccessAt: now, lastError: null, consecutiveFailures: 0, leaseRunId: null, leaseUntil: null })
          .where(and(eq(jobRuns.job, job), eq(jobRuns.leaseRunId, runId))).returning({ job: jobRuns.job })
      : await db.update(jobRuns)
          .set({ lastRunAt: now, lastResult: result, lastError: outcome.error, consecutiveFailures: sqlOp`${jobRuns.consecutiveFailures} + 1`, leaseRunId: null, leaseUntil: null })
          .where(and(eq(jobRuns.job, job), eq(jobRuns.leaseRunId, runId))).returning({ job: jobRuns.job });
    return rows.length === 1;
  }

  async startJobRunHistory(entry: { job: string; runId: string; source: string; startedAt: Date; outcome?: string }) {
    await db.insert(jobRunHistory).values({ job: entry.job, runId: entry.runId, source: entry.source, startedAt: entry.startedAt, outcome: entry.outcome ?? "running" });
  }

  async finishJobRunHistory(job: string, runId: string, e: { finishedAt: Date; outcome: string; durationMs: number; error?: string; result?: Record<string, unknown> }) {
    await db.update(jobRunHistory)
      .set({ finishedAt: e.finishedAt, outcome: e.outcome, durationMs: e.durationMs, error: e.error ?? null, result: e.result ?? {} })
      .where(and(eq(jobRunHistory.job, job), eq(jobRunHistory.runId, runId)));
  }

  async getJobRunHistory(job: string, since: Date) {
    return db
      .select({ runId: jobRunHistory.runId, source: jobRunHistory.source, startedAt: jobRunHistory.startedAt, finishedAt: jobRunHistory.finishedAt, outcome: jobRunHistory.outcome, durationMs: jobRunHistory.durationMs })
      .from(jobRunHistory)
      .where(and(eq(jobRunHistory.job, job), sqlOp`${jobRunHistory.startedAt} >= ${since}`))
      .orderBy(jobRunHistory.startedAt);
  }

  async pruneJobRunHistory(job: string, before: Date) {
    await db.delete(jobRunHistory).where(and(eq(jobRunHistory.job, job), sqlOp`${jobRunHistory.startedAt} < ${before}`));
  }

  // --- Multi-factor sign-in (always system access) ---
  async getMfa(userId: string) {
    return runAsSystem(async () => {
      const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, userId));
      return row
        ? { secretCiphertext: row.secretCiphertext, pending: row.pending, enabledAt: row.enabledAt, lastUsedStep: row.lastUsedStep, failedAttempts: row.failedAttempts, lockedUntil: row.lockedUntil }
        : undefined;
    });
  }

  async beginMfaEnrollment(userId: string, secretCiphertext: string) {
    return runAsSystem(async () => {
      // Only an enrolment that is not finished may be (re)started; a working second factor is never replaced this way.
      const res = await db.execute(sqlOp`
        INSERT INTO user_mfa (user_id, secret_ciphertext) VALUES (${userId}, ${secretCiphertext})
        ON CONFLICT (user_id) DO UPDATE SET secret_ciphertext = EXCLUDED.secret_ciphertext, failed_attempts = 0, locked_until = NULL, updated_at = now()
        WHERE user_mfa.pending
        RETURNING user_id`);
      return res.rows.length === 1;
    });
  }

  async enableMfa(userId: string, step: number) {
    return runAsSystem(async () => {
      const rows = await db.update(userMfa)
        .set({ pending: false, enabledAt: new Date(), lastUsedStep: step, failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
        .where(and(eq(userMfa.userId, userId), eq(userMfa.pending, true)))
        .returning({ id: userMfa.userId });
      return rows.length === 1;
    });
  }

  async recordMfaSuccess(userId: string, step: number, allowReuse: boolean) {
    return runAsSystem(async () => {
      const res = await db.execute(allowReuse
        ? sqlOp`UPDATE user_mfa SET last_used_step = GREATEST(last_used_step, ${step}), failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE user_id = ${userId} RETURNING user_id`
        : sqlOp`UPDATE user_mfa SET last_used_step = ${step}, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE user_id = ${userId} AND last_used_step < ${step} RETURNING user_id`);
      return res.rows.length === 1;
    });
  }

  async recordMfaFailure(userId: string, now: Date, maxAttempts: number, lockMinutes: number) {
    return runAsSystem(async () => {
      const res = await db.execute(sqlOp`
        UPDATE user_mfa SET
          failed_attempts = failed_attempts + 1,
          locked_until = CASE WHEN failed_attempts + 1 >= ${maxAttempts} THEN ${new Date(now.getTime() + lockMinutes * 60_000)} ELSE locked_until END,
          updated_at = now()
        WHERE user_id = ${userId}
        RETURNING failed_attempts, locked_until`);
      const row = res.rows[0] as { failed_attempts: number; locked_until: string | Date | null } | undefined;
      return { failedAttempts: row?.failed_attempts ?? 0, lockedUntil: row?.locked_until ? new Date(row.locked_until) : null };
    });
  }

  async clearMfaFailures(userId: string) {
    await runAsSystem(() => db.update(userMfa).set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(userMfa.userId, userId)));
  }

  async replaceRecoveryCodes(userId: string, hashes: string[]) {
    await runAsSystem(() =>
      db.transaction(async (tx) => {
        await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
        if (hashes.length) await tx.insert(mfaRecoveryCodes).values(hashes.map((codeHash) => ({ userId, codeHash })));
      }),
    );
  }

  async consumeRecoveryCode(userId: string, hash: string) {
    return runAsSystem(async () => {
      const rows = await db.update(mfaRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(mfaRecoveryCodes.userId, userId), eq(mfaRecoveryCodes.codeHash, hash), isNull(mfaRecoveryCodes.usedAt)))
        .returning({ id: mfaRecoveryCodes.id });
      return rows.length === 1;
    });
  }

  async countRecoveryCodes(userId: string) {
    return runAsSystem(async () => {
      const [row] = await db.select({ n: sqlOp<number>`count(*)::int` }).from(mfaRecoveryCodes).where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
      return row?.n ?? 0;
    });
  }

  async resetMfa(userId: string) {
    await runAsSystem(() =>
      db.transaction(async (tx) => {
        await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
        await tx.delete(userMfa).where(eq(userMfa.userId, userId));
        await tx.update(userDevices).set({ revokedAt: new Date() }).where(and(eq(userDevices.userId, userId), isNull(userDevices.revokedAt)));
      }),
    );
  }

  async getAllEnabledReminders() {
    return db.select().from(medicationReminders).where(eq(medicationReminders.enabled, true));
  }

  async createDataRequest(userId: string, kind: "export" | "deletion") {
    const [row] = await db.insert(dataRequests).values({ userId, kind }).returning({ id: dataRequests.id });
    return row;
  }

  async deactivateUser(userId: string) {
    await db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, userId));
    await db.update(userDevices).set({ revokedAt: new Date() }).where(and(eq(userDevices.userId, userId), isNull(userDevices.revokedAt)));
  }

  async claimDueAppointmentReminders(now: Date, hours: number) {
    const until = new Date(now.getTime() + hours * 3_600_000);
    return db
      .update(appointments)
      .set({ reminderSentAt: now })
      .where(and(
        eq(appointments.status, "confirmed"),
        isNull(appointments.reminderSentAt),
        sqlOp`${appointments.scheduledAt} > ${now}`,
        sqlOp`${appointments.scheduledAt} <= ${until}`,
      ))
      .returning();
  }

  // Asked about another person's notices (to avoid sending a second "new message" nudge), so it is a
  // server check, not something the asking person may read for themselves.
  async hasUnreadNotification(userId: string, kind: string, link: string) {
    return runAsSystem(() => this.hasUnreadNotificationUnscoped(userId, kind, link));
  }

  private async hasUnreadNotificationUnscoped(userId: string, kind: string, link: string) {
    const [row] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.kind, kind), eq(notifications.link, link), isNull(notifications.readAt)))
      .limit(1);
    return !!row;
  }

  // A notice is usually for someone other than the person whose action caused it (the doctor is told
  // about a request, the patient about a prescription), so writing it is the server's job, not the
  // acting person's: it runs with system access and returns the row it wrote.
  async createNotification(data: InsertNotification) {
    return runAsSystem(async () => {
      const [row] = await db.insert(notifications).values(data).returning();
      return row;
    });
  }

  async getNotificationsForUser(userId: string, limit: number) {
    return db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(limit);
  }

  async countUnreadNotifications(userId: string) {
    const [row] = await db
      .select({ n: sqlOp<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return row?.n ?? 0;
  }

  async markNotificationsReadForLink(userId: string, linkPrefix: string) {
    await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, userId), isNull(notifications.readAt), sqlOp`${notifications.link} LIKE ${linkPrefix + "%"}`));
  }

  async markNotificationsRead(userId: string, ids?: string[]) {
    const where = ids?.length
      ? and(eq(notifications.userId, userId), isNull(notifications.readAt), inArray(notifications.id, ids))
      : and(eq(notifications.userId, userId), isNull(notifications.readAt));
    await db.update(notifications).set({ readAt: new Date() }).where(where);
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
