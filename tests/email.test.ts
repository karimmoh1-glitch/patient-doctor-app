import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sent: any[] = [];
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async (msg: any) => { sent.push(msg); return { data: { id: "test" }, error: null }; } };
  },
}));

import {
  sendPasswordResetEmail, sendDoctorInfoRequestedEmail, sendDoctorApplicationApprovedEmail,
} from "../server/services/emailService";

beforeEach(() => {
  sent.length = 0;
  process.env.RESEND_API_KEY = "re_test_key";
});
afterEach(() => {
  delete process.env.RESEND_API_KEY;
});

describe("emails", () => {
  it("are sent in English by default and in Arabic, right-to-left, when that is the person's language", async () => {
    await sendPasswordResetEmail("a@example.org", "Layla", "https://avela.example/reset?token=abc", "en");
    await sendPasswordResetEmail("a@example.org", "ليلى", "https://avela.example/reset?token=abc", "ar");
    expect(sent[0].subject).toBe("Reset your Avela password");
    expect(sent[0].html).toContain('dir="ltr"');
    expect(sent[1].subject).toBe("إعادة تعيين كلمة المرور في أفيلا");
    expect(sent[1].html).toContain('dir="rtl"');
    expect(sent[1].html).toContain("أفيلا");
    // The working link survives in both the HTML and the plain-text part.
    for (const m of sent) {
      expect(m.html).toContain('href="https://avela.example/reset?token=abc"');
      expect(m.text).toContain("https://avela.example/reset?token=abc");
    }
  });

  it("never lets a name or a reviewer's message become markup or a link", async () => {
    await sendDoctorInfoRequestedEmail("d@example.org", `<a href="https://evil.example">Click</a>`, `<img src=x onerror=alert(1)> please add your NPI`, "en");
    const html = sent[0].html as string;
    expect(html).not.toContain("<a href=\"https://evil.example\"");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("keeps clinical detail out of subjects", async () => {
    await sendDoctorApplicationApprovedEmail("d@example.org", "Dr. A", "ar");
    expect(sent[0].subject).toBe("تمت الموافقة على طلبك في أفيلا");
  });
});
