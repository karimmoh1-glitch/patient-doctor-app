import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// D-03c, the smallest permission model that is honest about what the database does NOT check.
//
// The `staff`, `review` and `mfa` scopes are limited by the database to named tables and operations (tests/narrowScopes.test.ts), but inside those tables the
// database cannot tell WHICH organization, applicant or account the acting person may touch: that is decided in code, before the scope is entered. This
// file pins the code-side model so it cannot grow by accident:
//   1. the call sites of the three scopes are an exact, reviewed set (a new one fails until someone reads it and records who authorises it);
//   2. every organization function that reads or writes ANOTHER PERSON'S organization data takes an `OrgAccess`, a capability that only `access()` can mint
//      (active membership + the permission matrix), and the few functions that do not are an exact, reviewed list;
//   3. every route under /:orgId obtains that capability before it does anything.
// None of this closes D-03c (binding the acting person into the signed assertion); it makes the remaining exposure small, listed and guarded.

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));

describe("authority behind the staff, review and mfa scopes", () => {
  it("has exactly the reviewed call sites", () => {
    const found: Record<string, number> = {};
    for (const file of walk("server")) {
      for (const m of read(file).matchAll(/withScope\("(staff|review|mfa)"/g)) found[`${file}:${m[1]}`] = (found[`${file}:${m[1]}`] ?? 0) + 1;
    }
    // Each entry is authorised by: staff = OrgAccess (see below); review = an administrator route or a clinician's own application; mfa = the account holder who
    // just proved their password (a signed challenge), or an administrator resetting someone's sign-in through the audited operator path.
    expect(found).toEqual({
      "server/services/credentialService.ts:review": 4,
      "server/services/orgs.ts:staff": 26,
      "server/services/orgs.ts:review": 2,
      "server/storage.ts:review": 4,
      "server/storage.ts:mfa": 10,
    });
  });

  it("gives every organization function that touches organization data a capability, except a short reviewed list", () => {
    const src = read("server/services/orgs.ts");
    const parts = src.split(/\n(?=(?:export )?(?:async )?function )/);
    const withoutCapability: string[] = [];
    for (const p of parts) {
      const m = p.match(/^(?:export )?(?:async )?function (\w+)\(([^)]*)/);
      if (!m || !p.includes('withScope("staff"')) continue;
      if (!m[2].split(",")[0].trim().startsWith("a: OrgAccess")) withoutCapability.push(m[1]);
    }
    // What each does without a capability, and why that is acceptable:
    //  access                      mints the capability itself (membership + permission matrix)
    //  createOrg, myOrganizations  act for the signed-in person only (their own id is the only key)
    //  previewInvitation, claimInvitationForNewAccount, acceptWithAccount   a single-use token is the authority (hash compared, atomic claim)
    //  organizationsSeeingPatient, setStaffVisibility   called from patient routes with the patient's own id
    //  organizationsOfClinician, tellPatientAboutOrganizationStaff, tellPatientsOfClinicianAbout   notices about a clinician's own organizations
    expect(withoutCapability.sort()).toEqual(
      [
        "access", "acceptWithAccount", "claimInvitationForNewAccount", "createOrg", "myOrganizations", "organizationsOfClinician",
        "organizationsSeeingPatient", "previewInvitation", "setStaffVisibility", "tellPatientAboutOrganizationStaff", "tellPatientsOfClinicianAbout",
      ].sort(),
    );
  });

  it("mints the capability in exactly one place", () => {
    const src = read("server/services/orgs.ts");
    // An object with exactly the capability's three fields can only be built inside access().
    const mints = [...src.matchAll(/return \{ org: [^}]*membership[^}]*role[^}]*\}/g)];
    expect(mints).toHaveLength(1);
    for (const file of walk("server").filter((f) => f !== "server/services/orgs.ts")) {
      expect(read(file), file).not.toMatch(/as OrgAccess|<OrgAccess>/);
    }
  });

  it("obtains the capability in every /:orgId route before doing anything", () => {
    const src = read("server/routes/orgs.ts");
    const chunks = src.split(/\n(?=router\.(?:get|post|put|patch|delete)\()/).filter((c) => /^router\.\w+\("\/:orgId/.test(c));
    expect(chunks.length).toBeGreaterThanOrEqual(15);
    const lacking = chunks.filter((c) => !/\bneed\(req|orgs\.access\(/.test(c)).map((c) => c.split("\n")[0]);
    expect(lacking).toEqual([]);
  });

  it("lets only an administrator reach the review functions of organizations", () => {
    // listForReview and setOrgStatus are imported by the administrator router only, and every call there sits behind `adminOnly`.
    const importers = walk("server").filter((f) => f !== "server/services/orgs.ts" && /\b(listForReview|setOrgStatus)\b/.test(read(f)));
    expect(importers).toEqual(["server/routes/admin.ts"]);
    const admin = read("server/routes/admin.ts");
    expect(admin).toMatch(/const adminOnly = \[requireAuth, requireRole\("admin"\)\]/);
    const uses = admin.split(/\n(?=router\.)/).filter((c) => /\b(listForReview|setOrgStatus)\(/.test(c));
    expect(uses).toHaveLength(4);
    for (const c of uses) expect(c.split("\n")[0], c.split("\n")[0]).toContain("...adminOnly");
  });
});
