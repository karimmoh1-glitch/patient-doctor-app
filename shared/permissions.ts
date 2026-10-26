/**
 * The one place that says who may do what inside an organization. Every organization endpoint asks `can(role, permission)`;
 * nothing else decides, and the interface only hides what this table already forbids (it never grants).
 *
 * What is NOT here, on purpose:
 *  - Clinical access to a patient's records. That comes only from a connection the patient accepted (and, for health
 *    information, a grant the patient made). Belonging to an organization, even as its owner, gives none of it.
 *  - Patients and caregivers: they are not organization members; their access is to their own information (and what they share).
 *  - Avela's platform reviewers and the system operator: they act through their own, separately audited, routes.
 */
export const ORG_ROLES = ["owner", "admin", "clinician", "coordinator", "scheduler", "auditor"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PERMISSIONS = [
  "org.view",
  "org.settings.edit",
  "org.owner.manage",
  "org.staff.view",
  "org.staff.invite",
  "org.staff.role",
  "org.staff.revoke",
  "org.dashboard.view",
  "org.patients.list", // names of patients connected to the organization's clinicians, who allowed staff to see them
  "org.appointments.view", // appointment times and statuses, never what they are about
  "org.tasks.view",
  "org.tasks.manage",
  "org.notes.read", // internal notes: staff only, never shown to patients
  "org.notes.write",
  "org.audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL_ORG: Permission[] = [...PERMISSIONS];
const ADMIN: Permission[] = PERMISSIONS.filter((p) => p !== "org.owner.manage");

export const MATRIX: Record<OrgRole, readonly Permission[]> = {
  owner: ALL_ORG,
  admin: ADMIN,
  // A clinician works with their own patients through the normal clinical screens. In the organization they see the
  // organization, the dashboard, and the tasks and notes about patients who are theirs.
  clinician: ["org.view", "org.dashboard.view", "org.staff.view", "org.tasks.view", "org.tasks.manage", "org.notes.read", "org.notes.write"],
  coordinator: ["org.view", "org.dashboard.view", "org.staff.view", "org.patients.list", "org.appointments.view", "org.tasks.view", "org.tasks.manage", "org.notes.read", "org.notes.write"],
  scheduler: ["org.view", "org.dashboard.view", "org.patients.list", "org.appointments.view", "org.tasks.view"],
  // An auditor reads who did what. Sees no patient, no appointment, no note.
  auditor: ["org.view", "org.staff.view", "org.audit.view"],
};

export const can = (role: OrgRole | null | undefined, permission: Permission): boolean => !!role && MATRIX[role]?.includes(permission) === true;

/** Roles an organization administrator may give. Only an owner may make another owner. */
export const assignableRoles = (actor: OrgRole): OrgRole[] => (actor === "owner" ? [...ORG_ROLES] : actor === "admin" ? ORG_ROLES.filter((r) => r !== "owner" && r !== "admin") : []);

/** Roles that must have a platform account of their own (not a doctor account). */
export const STAFF_ONLY_ROLES: OrgRole[] = ["admin", "coordinator", "scheduler", "auditor", "owner"];
