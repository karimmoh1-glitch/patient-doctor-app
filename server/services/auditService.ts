import { storage } from "../storage";

export async function logAudit(params: {
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await storage.createAuditLog({
      actorUserId: params.actorUserId,
      action: params.action,
      targetType: params.targetType || null,
      targetId: params.targetId || null,
      metadata: params.metadata || null,
    });
  } catch (err) {
    // Audit logging must never break the request it's describing.
    console.error("Failed to write audit log:", err);
  }
}
