import { Resend } from "resend";
import { recordAccepted } from "./emailDeliveries";

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  html?: string;
  /** Why this message exists (never its content): recorded with the provider's id as delivery evidence. */
  purpose?: string;
}

// Every value interpolated into email HTML goes through this tagged
// template, so a name like `<a href="https://evil">click</a>` typed at
// signup arrives in a doctor's or relative's inbox as inert text, not a
// working phishing link inside a message that appears to come from us.
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function h(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, str, i) => out + str + (i < values.length ? escapeHtml(values[i]) : ""), "");
}

function getFromEmail(): string {
  return process.env.EMAIL_FROM || "Avela <noreply@avela.dev>";
}

// Configured entirely through environment — never hardcoded, so this file
// has no knowledge of any specific person's address.
export function getAdminNotificationEmails(): string[] {
  return (process.env.ADMIN_NOTIFICATION_EMAILS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

let warnedNoProvider = false;

function getResendClient(): { client: Resend; fromEmail: string } | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (!warnedNoProvider && process.env.NODE_ENV !== "test") {
      warnedNoProvider = true;
      console.error(
        process.env.NODE_ENV === "development"
          ? "[EMAIL] RESEND_API_KEY is not set — emails are printed to this console instead of sent."
          : "[EMAIL] RESEND_API_KEY is not set — NO email (password resets, invitations, appointment notices) will be delivered.",
      );
    }
    return null;
  }
  return {
    client: new Resend(apiKey),
    fromEmail: getFromEmail(),
  };
}

type Lang = "en" | "ar";

function emailWrapper(title: string, body: string, lang: Lang = "en"): string {
  const rtl = lang === "ar";
  const footer = rtl ? "هذه رسالة آلية من أفيلا. يُرجى عدم الرد عليها مباشرة." : "This is an automated message from Avela. Please do not reply directly.";
  const brand = rtl ? "أفيلا" : "Avela";
  return `<!DOCTYPE html>
<html lang="${lang}" dir="${rtl ? "rtl" : "ltr"}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Tahoma,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
<div style="background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,0.08);overflow:hidden">
<div style="background:#0E5A4F;padding:22px 28px">
<h1 style="margin:0;color:#fff;font-size:24px;font-weight:700">${brand}</h1>
</div>
<div style="padding:28px">
<h2 style="margin:0 0 16px;color:#16211F;font-size:20px;font-weight:600;line-height:1.4">${title}</h2>
${body}
</div>
<div style="padding:16px 28px;background:#fbfaf6;border-top:1px solid #eee">
<p style="margin:0;color:#6b7370;font-size:13px;line-height:1.5">${footer}</p>
</div>
</div>
</div>
</body>
</html>`;
}

const emailTimeoutMs = () => Number(process.env.EMAIL_TIMEOUT_MS) || 8_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "EmailTimeout" })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Returns true only if a real email provider accepted the message. */
export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  const resend = getResendClient();

  if (!resend) {
    // The body of a reset or invitation email contains a working secret
    // link, so it is only ever printed on a developer's own machine. Anywhere
    // else (including a deploy where NODE_ENV was forgotten) the message is
    // dropped and the log says so without leaking the link or the address.
    if (process.env.NODE_ENV === "development") {
      console.log("[MOCK EMAIL] To: " + msg.to + " | Subject: " + msg.subject + "\n" + msg.body);
    } else if (process.env.NODE_ENV !== "test") {
      console.error("[EMAIL NOT SENT] No provider configured. Subject: " + msg.subject);
    }
    return false;
  }

  try {
    // A provider that hangs must not hold a scheduled run (or a request) open until the host kills it.
    // A timed-out send is reported as not accepted; the caller decides whether to retry.
    const result = await withTimeout(
      resend.client.emails.send({
        from: resend.fromEmail,
        to: [msg.to],
        subject: msg.subject,
        text: msg.body,
        html: msg.html || undefined,
      }),
      emailTimeoutMs(),
    );
    if (result.error) {
      console.error("[RESEND ERROR]", result.error.name);
      return false;
    }
    console.log("[EMAIL SENT] ID: " + (result.data?.id || "unknown"));
    if (result.data?.id) await recordAccepted({ providerMessageId: result.data.id, purpose: msg.purpose ?? "other", to: msg.to });
    return true;
  } catch (err: any) {
    console.error("[EMAIL ERROR]", err?.name);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Messages. Each one exists in English and Arabic and is sent in the language
// the recipient chose. Subjects are deliberately generic: they never include
// medicine names, conditions or a doctor's decision details.
// ---------------------------------------------------------------------------
interface Spec { subject: string; heading: string; paragraphs: string[]; cta?: { label: string; href: string } }
interface Message { subject: string; heading: string; p: readonly string[]; cta?: { label: string; href: string } }

const T = {
  en: {
    hi: (n: string) => `Hi ${n},`,
    received: { subject: "Your Avela doctor application was received", heading: "We've received your application", p: ["Thanks for applying to join Avela as a doctor. A person on our team will review your details and follow up by email."] } as Message,
    approved: { subject: "Your Avela doctor application was approved", heading: "Your application was approved", p: ["Your Avela doctor application was approved. You can now sign in; your profile is visible to matching patients."] } as Message,
    rejected: (reason?: string): Message => ({ subject: "Update on your Avela doctor application", heading: "Update on your application", p: [`Your Avela doctor application wasn't approved${reason ? `: ${reason}` : "."}`] }),
    info: (message: string): Message => ({ subject: "More information needed for your Avela application", heading: "We need a little more information", p: ["The team reviewing your application asked for more information:", message, "Sign in, update your application and send it again."] }),
    suspended: { subject: "Your Avela doctor account was suspended", heading: "Your doctor account was suspended", p: ["Your doctor account has been suspended and is not shown to patients. Sign in to see the reason, or contact the Avela team."] } as Message,
    reset: (link: string): Message => ({ subject: "Reset your Avela password", heading: "Reset your password", p: ["We received a request to reset your Avela password. This link expires in 1 hour. If you didn't request this, you can safely ignore this email."], cta: { label: "Reset password", href: link } }),
    pairingRequested: (patient: string): Message => ({ subject: "You have a new request on Avela", heading: "New patient connection request", p: [`${patient} would like to connect with you on Avela. Review the request from your dashboard.`] }),
    pairingAccepted: (doctor: string): Message => ({ subject: "An update on your Avela request", heading: "You're connected", p: [`${doctor} accepted your connection request. You can now call them from Avela.`] }),
    invite: (patient: string, link: string): Message => ({ subject: `${patient} invited you to their Care Circle on Avela`, heading: "You've been invited to a Care Circle", p: [`${patient} has invited you to join their Care Circle on Avela, a way to stay informed on the parts of their care they've chosen to share with you.`], cta: { label: "Accept invitation", href: link } }),
  },
  ar: {
    hi: (n: string) => `مرحبًا ${n}،`,
    received: { subject: "تم استلام طلبك للانضمام إلى أفيلا كطبيب", heading: "استلمنا طلبك", p: ["شكرًا لتقديمك طلب الانضمام إلى أفيلا كطبيب. سيراجع أحد أعضاء فريقنا بياناتك ويتواصل معك عبر البريد الإلكتروني."] } as Message,
    approved: { subject: "تمت الموافقة على طلبك في أفيلا", heading: "تمت الموافقة على طلبك", p: ["تمت الموافقة على طلبك للانضمام إلى أفيلا كطبيب. يمكنك الآن تسجيل الدخول، وسيظهر ملفك للمرضى المناسبين."] } as Message,
    rejected: (reason?: string): Message => ({ subject: "مستجدات بشأن طلبك في أفيلا", heading: "مستجدات بشأن طلبك", p: [`لم تتم الموافقة على طلبك للانضمام إلى أفيلا كطبيب${reason ? `: ${reason}` : "."}`] }),
    info: (message: string): Message => ({ subject: "نحتاج إلى معلومات إضافية لطلبك في أفيلا", heading: "نحتاج إلى مزيد من المعلومات", p: ["طلب الفريق الذي يراجع طلبك معلومات إضافية:", message, "سجّل الدخول وحدّث طلبك ثم أرسله مرة أخرى."] }),
    suspended: { subject: "تم إيقاف حسابك كطبيب في أفيلا", heading: "تم إيقاف حسابك كطبيب", p: ["تم إيقاف حسابك كطبيب ولم يعد ظاهرًا للمرضى. سجّل الدخول لمعرفة السبب، أو تواصل مع فريق أفيلا."] } as Message,
    reset: (link: string): Message => ({ subject: "إعادة تعيين كلمة المرور في أفيلا", heading: "إعادة تعيين كلمة المرور", p: ["تلقينا طلبًا لإعادة تعيين كلمة مرورك في أفيلا. ينتهي هذا الرابط خلال ساعة واحدة. إذا لم تطلب ذلك، فيمكنك تجاهل هذه الرسالة بأمان."], cta: { label: "إعادة تعيين كلمة المرور", href: link } }),
    pairingRequested: (patient: string): Message => ({ subject: "لديك طلب جديد في أفيلا", heading: "طلب تواصل جديد من مريض", p: [`يود ${patient} التواصل معك في أفيلا. راجع الطلب من لوحتك.`] }),
    pairingAccepted: (doctor: string): Message => ({ subject: "مستجدات بشأن طلبك في أفيلا", heading: "تم الاتصال", p: [`قبل ${doctor} طلب التواصل. يمكنك الآن الاتصال به من أفيلا.`] }),
    invite: (patient: string, link: string): Message => ({ subject: `دعاك ${patient} إلى دائرة رعايته في أفيلا`, heading: "تمت دعوتك إلى دائرة رعاية", p: [`دعاك ${patient} للانضمام إلى دائرة رعايته في أفيلا، وهي وسيلة لتبقى على اطلاع على ما اختار مشاركته معك من رعايته.`], cta: { label: "قبول الدعوة", href: link } }),
  },
};

const toSpec = (m: Message): Spec => ({ subject: m.subject, heading: m.heading, paragraphs: [...m.p], cta: m.cta });

// Every value placed in the HTML is escaped, so a name or a reviewer's message
// can never become a working link or markup in someone's inbox.
async function deliver(to: string, lang: Lang, name: string | null, spec: Spec, purpose: string): Promise<boolean> {
  const hi = name ? T[lang].hi(name) : "";
  const intro = hi ? `<p style="margin:0 0 12px;color:#3f3f46;font-size:16px;line-height:1.7">${escapeHtml(hi)}</p>` : "";
  const paras = spec.paragraphs.map((p) => `<p style="margin:0 0 12px;color:#3f3f46;font-size:16px;line-height:1.7">${escapeHtml(p)}</p>`).join("");
  const cta = spec.cta
    ? `<p style="margin:16px 0 0"><a href="${escapeHtml(spec.cta.href)}" style="display:inline-block;background:#0E5A4F;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:16px;font-weight:600">${escapeHtml(spec.cta.label)}</a></p>`
    : "";
  const html = emailWrapper(escapeHtml(spec.heading), intro + paras + cta, lang);
  const text = [hi, ...spec.paragraphs, spec.cta ? `${spec.cta.label}: ${spec.cta.href}` : ""].filter(Boolean).join("\n\n");
  return sendEmail({ to, subject: spec.subject, body: text, html, purpose });
}

export async function sendDoctorApplicationReceivedEmail(email: string, name: string, lang: Lang = "en"): Promise<void> {
  await deliver(email, lang, name, toSpec(T[lang].received), "doctor_application_received");
}

export async function sendNewDoctorApplicationAdminEmail(adminEmail: string, applicantName: string, specialty: string): Promise<void> {
  await deliver(adminEmail, "en", null, {
    subject: `New doctor application: ${applicantName}`,
    heading: "New doctor application",
    paragraphs: [`${applicantName} applied to join as a ${specialty} doctor. Review it from the admin dashboard.`],
  }, "new_doctor_application_admin");
}

export async function sendDoctorApplicationApprovedEmail(email: string, name: string, lang: Lang = "en"): Promise<void> {
  await deliver(email, lang, name, toSpec(T[lang].approved), "doctor_application_approved");
}

export async function sendDoctorApplicationRejectedEmail(email: string, name: string, reason?: string, lang: Lang = "en"): Promise<void> {
  await deliver(email, lang, name, toSpec(T[lang].rejected(reason)), "doctor_application_rejected");
}

export async function sendDoctorInfoRequestedEmail(email: string, name: string, message: string, lang: Lang = "en"): Promise<void> {
  await deliver(email, lang, name, toSpec(T[lang].info(message)), "doctor_info_requested");
}

export async function sendDoctorSuspendedEmail(email: string, name: string, lang: Lang = "en"): Promise<void> {
  await deliver(email, lang, name, toSpec(T[lang].suspended), "doctor_suspended");
}

export async function sendPasswordResetEmail(email: string, name: string, resetLink: string, lang: Lang = "en"): Promise<void> {
  await deliver(email, lang, name, toSpec(T[lang].reset(resetLink)), "password_reset");
}

export async function sendPairingRequestedEmail(doctorEmail: string, doctorName: string, patientName: string, lang: Lang = "en"): Promise<void> {
  await deliver(doctorEmail, lang, doctorName, toSpec(T[lang].pairingRequested(patientName)), "pairing_requested");
}

export async function sendPairingAcceptedEmail(patientEmail: string, patientName: string, doctorName: string, lang: Lang = "en"): Promise<void> {
  await deliver(patientEmail, lang, patientName, toSpec(T[lang].pairingAccepted(doctorName)), "pairing_accepted");
}

export async function sendCareCircleInviteEmail(inviteeEmail: string, inviteeName: string, patientName: string, inviteLink: string, lang: Lang = "en"): Promise<boolean> {
  return deliver(inviteeEmail, lang, inviteeName, toSpec(T[lang].invite(patientName, inviteLink)), "care_circle_invite");
}
