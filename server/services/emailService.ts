import { Resend } from "resend";

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  html?: string;
}

function getFromEmail(): string {
  return process.env.EMAIL_FROM || "MedConnect <noreply@medconnect.dev>";
}

// Configured entirely through environment — never hardcoded, so this file
// has no knowledge of any specific person's address.
export function getAdminNotificationEmails(): string[] {
  return (process.env.ADMIN_NOTIFICATION_EMAILS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

function getResendClient(): { client: Resend; fromEmail: string } | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[RESEND] No RESEND_API_KEY environment variable found");
    return null;
  }
  return {
    client: new Resend(apiKey),
    fromEmail: getFromEmail(),
  };
}

function emailWrapper(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
<div style="background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);overflow:hidden">
<div style="background:linear-gradient(135deg,#0F766E 0%,#0d5f58 100%);padding:24px 28px">
<h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px">MedConnect</h1>
</div>
<div style="padding:28px">
<h2 style="margin:0 0 16px;color:#1a1a2e;font-size:19px;font-weight:600;line-height:1.4">${title}</h2>
${body}
</div>
<div style="padding:16px 28px;background:#fafafa;border-top:1px solid #f0f0f0">
<p style="margin:0;color:#a1a1aa;font-size:12px;line-height:1.5">This is an automated message from MedConnect. Please do not reply directly.</p>
</div>
</div>
</div>
</body>
</html>`;
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const resend = getResendClient();

  if (!resend) {
    console.log(
      "[MOCK EMAIL] Resend not configured. To: " + msg.to + " | Subject: " + msg.subject + "\n" + msg.body,
    );
    return;
  }

  try {
    const result = await resend.client.emails.send({
      from: resend.fromEmail,
      to: [msg.to],
      subject: msg.subject,
      text: msg.body,
      html: msg.html || undefined,
    });
    if (result.error) {
      console.error("[RESEND ERROR]", result.error);
    } else {
      console.log("[EMAIL SENT] To: " + msg.to + " | ID: " + (result.data?.id || "unknown"));
    }
  } catch (err: any) {
    console.error("[EMAIL ERROR] " + err.message);
  }
}

export async function sendDoctorApplicationReceivedEmail(email: string, name: string): Promise<void> {
  const html = emailWrapper(
    "We've received your application",
    `<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${name},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Thanks for applying to join MedConnect as a doctor. An admin will review your license and specialty information and follow up by email.</p>`
  );
  await sendEmail({
    to: email,
    subject: "Your MedConnect doctor application was received",
    body: `Hi ${name}, thanks for applying to join MedConnect as a doctor. An admin will review your application and follow up by email.`,
    html,
  });
}

export async function sendNewDoctorApplicationAdminEmail(adminEmail: string, applicantName: string, specialty: string): Promise<void> {
  const html = emailWrapper(
    "New doctor application",
    `<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">${applicantName} applied to join as a ${specialty} doctor. Review it from the admin dashboard.</p>`
  );
  await sendEmail({
    to: adminEmail,
    subject: `New doctor application: ${applicantName}`,
    body: `${applicantName} applied to join MedConnect as a ${specialty} doctor. Review it from the admin dashboard.`,
    html,
  });
}

export async function sendDoctorApplicationApprovedEmail(email: string, name: string): Promise<void> {
  const html = emailWrapper(
    "Your application was approved",
    `<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${name},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Your MedConnect doctor application was approved. You can now log in and your profile is visible to matching patients.</p>`
  );
  await sendEmail({
    to: email,
    subject: "Your MedConnect doctor application was approved",
    body: `Hi ${name}, your MedConnect doctor application was approved. You can now log in.`,
    html,
  });
}

export async function sendDoctorApplicationRejectedEmail(email: string, name: string, reason?: string): Promise<void> {
  const html = emailWrapper(
    "Update on your application",
    `<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${name},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Your MedConnect doctor application wasn't approved${reason ? `: ${reason}` : "."}</p>`
  );
  await sendEmail({
    to: email,
    subject: "Update on your MedConnect doctor application",
    body: `Hi ${name}, your MedConnect doctor application wasn't approved${reason ? `: ${reason}` : "."}`,
    html,
  });
}

export async function sendPasswordResetEmail(email: string, name: string, resetLink: string): Promise<void> {
  const html = emailWrapper(
    "Reset your password",
    `<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${name},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">We received a request to reset your MedConnect password. This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
     <p style="margin:0"><a href="${resetLink}" style="display:inline-block;background:#0F766E;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">Reset password</a></p>`
  );
  await sendEmail({
    to: email,
    subject: "Reset your MedConnect password",
    body: `Reset your MedConnect password: ${resetLink} (expires in 1 hour, ignore if you didn't request this)`,
    html,
  });
}

export async function sendPairingRequestedEmail(doctorEmail: string, doctorName: string, patientName: string): Promise<void> {
  const html = emailWrapper(
    "New patient connection request",
    `<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${doctorName},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">${patientName} would like to connect with you on MedConnect. Review the request from your dashboard.</p>`
  );
  await sendEmail({
    to: doctorEmail,
    subject: `${patientName} wants to connect on MedConnect`,
    body: `${patientName} would like to connect with you on MedConnect. Review the request from your dashboard.`,
    html,
  });
}

export async function sendPairingAcceptedEmail(patientEmail: string, patientName: string, doctorName: string): Promise<void> {
  const html = emailWrapper(
    "You're connected",
    `<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${patientName},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Dr. ${doctorName} accepted your connection request. You can now call them from your MedConnect pairings page.</p>`
  );
  await sendEmail({
    to: patientEmail,
    subject: `Dr. ${doctorName} accepted your connection request`,
    body: `Dr. ${doctorName} accepted your connection request. You can now call them from your MedConnect pairings page.`,
    html,
  });
}
