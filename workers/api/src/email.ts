interface AccountEmailInput {
  to: string;
  displayName: string;
  token: string;
}

export async function sendVerificationEmail(
  env: Env,
  input: AccountEmailInput,
): Promise<void> {
  const link = buildAppLink(env.APPLICATION_BASE_URL, "/verify-email", input.token);
  const safeName = escapeHtml(input.displayName);
  const safeLink = escapeHtml(link);

  await env.EMAIL.send({
    to: input.to,
    from: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME },
    subject: "Verify your myFFL account",
    text: [
      `Hi ${input.displayName},`,
      "",
      "Verify your email address to activate your myFFL account:",
      link,
      "",
      "This link expires in 24 hours. If you did not create this account, you can ignore this email.",
    ].join("\n"),
    html: emailShell(
      "Verify your email",
      `<p>Hi ${safeName},</p>
       <p>Verify your email address to activate your myFFL account.</p>
       <p class="action"><a href="${safeLink}">Verify email address</a></p>
       <p class="muted">This link expires in 24 hours. If you did not create this account, you can ignore this email.</p>`,
    ),
  });
}

export async function sendPasswordResetEmail(
  env: Env,
  input: AccountEmailInput,
): Promise<void> {
  const link = buildAppLink(env.APPLICATION_BASE_URL, "/reset-password", input.token);
  const safeName = escapeHtml(input.displayName);
  const safeLink = escapeHtml(link);

  await env.EMAIL.send({
    to: input.to,
    from: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME },
    subject: "Reset your myFFL password",
    text: [
      `Hi ${input.displayName},`,
      "",
      "Use this link to reset your myFFL password:",
      link,
      "",
      "This link expires in one hour. If you did not request a reset, you can ignore this email.",
    ].join("\n"),
    html: emailShell(
      "Reset your password",
      `<p>Hi ${safeName},</p>
       <p>Use the secure link below to choose a new myFFL password.</p>
       <p class="action"><a href="${safeLink}">Reset password</a></p>
       <p class="muted">This link expires in one hour. If you did not request a reset, you can ignore this email.</p>`,
    ),
  });
}

export async function sendNotificationEmail(
  env: Env,
  input: { to: string; displayName: string; title: string; body: string; actionUrl?: string },
): Promise<void> {
  const safeName = escapeHtml(input.displayName);
  const safeBody = escapeHtml(input.body);
  const action = input.actionUrl
    ? `<p class="action"><a href="${escapeHtml(new URL(input.actionUrl, `${env.APPLICATION_BASE_URL}/`).toString())}">Open myFFL</a></p>`
    : "";
  await env.EMAIL.send({
    to: input.to,
    from: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME },
    subject: input.title,
    text: [`Hi ${input.displayName},`, "", input.body, input.actionUrl ? new URL(input.actionUrl, `${env.APPLICATION_BASE_URL}/`).toString() : ""].filter(Boolean).join("\n"),
    html: emailShell(input.title, `<p>Hi ${safeName},</p><p>${safeBody}</p>${action}`),
  });
}

function buildAppLink(baseUrl: string, path: string, token: string): string {
  const url = new URL(path, `${baseUrl}/`);
  url.searchParams.set("token", token);
  return url.toString();
}

function emailShell(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0;background:#05080f;color:#ffffff;font-family:Inter,Segoe UI,Arial,sans-serif">
    <div style="max-width:600px;margin:0 auto;padding:32px 20px">
      <div style="font-size:28px;font-weight:800;font-style:italic;margin-bottom:28px">my<span style="color:#1d4ed8">F</span><span style="color:#dc2626">FL</span></div>
      <div style="background:#111827;border:1px solid #374151;padding:28px;border-radius:6px">
        <h1 style="font-size:26px;line-height:1.25;margin:0 0 18px">${escapeHtml(title)}</h1>
        <div style="color:#d1d5db;font-size:16px;line-height:1.55">${content}</div>
      </div>
      <p style="color:#9ca3af;font-size:12px;line-height:1.5;margin:18px 2px">Secure account message from myFFL.</p>
    </div>
    <style>
      .action { margin: 26px 0; }
      .action a { display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:5px; }
      .muted { color:#9ca3af;font-size:13px; }
    </style>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
