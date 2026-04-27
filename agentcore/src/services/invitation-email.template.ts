export interface InvitationEmailParams {
  inviteUrl: string;
  tenantName: string;
  inviterName: string | null;
  inviterEmail: string;
  role: string;
  expiresAt: Date;
}

export function buildInvitationEmail(params: InvitationEmailParams): { subject: string; html: string; text: string } {
  const { inviteUrl, tenantName, inviterName, inviterEmail, role, expiresAt } = params;
  const expires = expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const subject = `You're invited to join ${tenantName}`;
  const inviterDisplay = inviterName ? `${inviterName} (${inviterEmail})` : inviterEmail;

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;border:1px solid #e5e7eb;">
        <tr><td style="padding:32px 32px 16px 32px;">
          <h1 style="margin:0 0 12px 0;font-size:20px;color:#111827;">Join ${escapeHtml(tenantName)}</h1>
          <p style="margin:0 0 20px 0;color:#4b5563;line-height:1.5;">
            ${escapeHtml(inviterDisplay)} invited you to join <strong>${escapeHtml(tenantName)}</strong> as a <strong>${escapeHtml(role)}</strong>.
          </p>
          <p style="margin:0 0 24px 0;">
            <a href="${escapeHtml(inviteUrl)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Accept invitation</a>
          </p>
          <p style="margin:0 0 8px 0;color:#6b7280;font-size:13px;">This link expires on ${escapeHtml(expires)}.</p>
          <p style="margin:0;color:#6b7280;font-size:13px;">If the button doesn't work, copy and paste this URL:<br><span style="word-break:break-all;">${escapeHtml(inviteUrl)}</span></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `You're invited to join ${tenantName}.`,
    '',
    `${inviterDisplay} invited you as a ${role}.`,
    '',
    `Accept the invitation: ${inviteUrl}`,
    '',
    `This link expires on ${expires}.`,
  ].join('\n');

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
