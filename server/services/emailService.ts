import { Resend } from "resend";

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  html?: string;
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

function emailWrapper(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
<div style="background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);overflow:hidden">
<div style="background:linear-gradient(135deg,#0F766E 0%,#0d5f58 100%);padding:24px 28px">
<h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px">Avela</h1>
</div>
<div style="padding:28px">
<h2 style="margin:0 0 16px;color:#1a1a2e;font-size:19px;font-weight:600;line-height:1.4">${title}</h2>
${body}
</div>
<div style="padding:16px 28px;background:#fafafa;border-top:1px solid #f0f0f0">
<p style="margin:0;color:#a1a1aa;font-size:12px;line-height:1.5">This is an automated message from Avela. Please do not reply directly.</p>
</div>
</div>
</div>
</body>
</html>`;
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
    const result = await resend.client.emails.send({
      from: resend.fromEmail,
      to: [msg.to],
      subject: msg.subject,
      text: msg.body,
      html: msg.html || undefined,
    });
    if (result.error) {
      console.error("[RESEND ERROR]", result.error.name);
      return false;
    }
    console.log("[EMAIL SENT] ID: " + (result.data?.id || "unknown"));
    return true;
  } catch (err: any) {
    console.error("[EMAIL ERROR]", err?.name);
    return false;
  }
}

export async function sendDoctorApplicationReceivedEmail(email: string, name: string): Promise<void> {
  const html = emailWrapper(
    "We've received your application",
    h`<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${name},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Thanks for applying to join Avela as a doctor. An admin will review your license and specialty information and follow up by email.</p>`
  );
  await sendEmail({
    to: email,
    subject: "Your Avela doctor application was received",
    body: `Hi ${name}, thanks for applying to join Avela as a doctor. An admin will review your application and follow up by email.`,
    html,
  });
}

export async function sendNewDoctorApplicationAdminEmail(adminEmail: string, applicantName: string, specialty: string): Promise<void> {
  const html = emailWrapper(
    "New doctor application",
    h`<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">${applicantName} applied to join as a ${specialty} doctor. Review it from the admin dashboard.</p>`
  );
  await sendEmail({
    to: adminEmail,
    subject: `New doctor application: ${applicantName}`,
    body: `${applicantName} applied to join Avela as a ${specialty} doctor. Review it from the admin dashboard.`,
    html,
  });
}

export async function sendDoctorApplicationApprovedEmail(email: string, name: string): Promise<void> {
  const html = emailWrapper(
    "Your application was approved",
    h`<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${name},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Your Avela doctor application was approved. You can now log in and your profile is visible to matching patients.</p>`
  );
  await sendEmail({
    to: email,
    subject: "Your Avela doctor application was approved",
    body: `Hi ${name}, your Avela doctor application was approved. You can now log in.`,
    html,
  });
}

export async function sendDoctorApplicationRejectedEmail(email: string, name: string, reason?: string): Promise<void> {
  const html = emailWrapper(
    "Update on your application",
    h`<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${name},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Your Avela doctor application wasn't approved${reason ? `: ${reason}` : "."}</p>`
  );
  await sendEmail({
    to: email,
    subject: "Update on your Avela doctor application",
    body: `Hi ${name}, your Avela doctor application wasn't approved${reason ? `: ${reason}` : "."}`,
    html,
  });
}

export async function sendDoctorInfoRequestedEmail(email: string, name: string, message: string): Promise<void> {
  const html = emailWrapper(
    "We need a little more information",
    h`<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${name},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">The Avela team reviewing your application asked for more information:</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">${message}</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Sign in, update your application and send it again.</p>`
  );
  await sendEmail({
    to: email,
    subject: "More information needed for your Avela application",
    body: `Hi ${name}, the team reviewing your Avela application asked for more information: ${message} Sign in, update your application and send it again.`,
    html,
  });
}

export async function sendDoctorSuspendedEmail(email: string, name: string): Promise<void> {
  const html = emailWrapper(
    "Your Avela doctor account was suspended",
    h`<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${name},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Your doctor account has been suspended and is not shown to patients. Sign in to see the reason or contact the Avela team.</p>`
  );
  await sendEmail({
    to: email,
    subject: "Your Avela doctor account was suspended",
    body: `Hi ${name}, your Avela doctor account has been suspended. Sign in to see the reason or contact the team.`,
    html,
  });
}

export async function sendPasswordResetEmail(email: string, name: string, resetLink: string): Promise<void> {
  const html = emailWrapper(
    "Reset your password",
    h`<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${name},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">We received a request to reset your Avela password. This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
     <p style="margin:0"><a href="${resetLink}" style="display:inline-block;background:#0F766E;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">Reset password</a></p>`
  );
  await sendEmail({
    to: email,
    subject: "Reset your Avela password",
    body: `Reset your Avela password: ${resetLink} (expires in 1 hour, ignore if you didn't request this)`,
    html,
  });
}

export async function sendPairingRequestedEmail(doctorEmail: string, doctorName: string, patientName: string): Promise<void> {
  const html = emailWrapper(
    "New patient connection request",
    h`<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${doctorName},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">${patientName} would like to connect with you on Avela. Review the request from your dashboard.</p>`
  );
  await sendEmail({
    to: doctorEmail,
    subject: "You have a new request on Avela",
    body: `${patientName} would like to connect with you on Avela. Review the request from your dashboard.`,
    html,
  });
}

export async function sendCareCircleInviteEmail(inviteeEmail: string, inviteeName: string, patientName: string, inviteLink: string): Promise<boolean> {
  const html = emailWrapper(
    "You've been invited to a Care Circle",
    h`<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${inviteeName},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">${patientName} has invited you to join their Care Circle on Avela — a way to stay informed on the parts of their care they've chosen to share with you.</p>
     <p style="margin:0"><a href="${inviteLink}" style="display:inline-block;background:#0F766E;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">Accept invitation</a></p>`
  );
  return sendEmail({
    to: inviteeEmail,
    subject: `${patientName} invited you to their Care Circle on Avela`,
    body: `${patientName} invited you to join their Care Circle on Avela. Accept here: ${inviteLink}`,
    html,
  });
}

export async function sendPairingAcceptedEmail(patientEmail: string, patientName: string, doctorName: string): Promise<void> {
  const html = emailWrapper(
    "You're connected",
    h`<p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Hi ${patientName},</p>
     <p style="margin:0 0 12px;color:#3f3f46;font-size:15px;line-height:1.6">Dr. ${doctorName} accepted your connection request. You can now call them from your Avela pairings page.</p>`
  );
  await sendEmail({
    to: patientEmail,
    subject: "An update on your Avela request",
    body: `Dr. ${doctorName} accepted your connection request. You can now call them from your Avela pairings page.`,
    html,
  });
}
