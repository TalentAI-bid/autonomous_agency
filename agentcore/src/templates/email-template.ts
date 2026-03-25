/**
 * Professional HTML email wrapper template.
 * Wraps LLM-generated email body in a responsive, styled layout
 * with signature block, optional CTA, and footer.
 */

export interface EmailTemplateOptions {
  body: string;
  senderName?: string;
  senderTitle?: string;
  senderCompany?: string;
  senderWebsite?: string;
  calendlyUrl?: string;
  unsubscribeUrl?: string;
}

export function wrapEmailBody(opts: EmailTemplateOptions): string {
  const {
    body,
    senderName,
    senderTitle,
    senderCompany,
    senderWebsite,
    calendlyUrl,
    unsubscribeUrl,
  } = opts;

  // Build signature lines
  const sigLines: string[] = [];
  if (senderName) {
    sigLines.push(`<p style="margin:4px 0 0; font-weight:600; color:#18181b;">${esc(senderName)}</p>`);
  }
  if (senderTitle) {
    sigLines.push(`<p style="margin:2px 0 0;">${esc(senderTitle)}</p>`);
  }
  if (senderCompany) {
    const companyText = senderWebsite
      ? `<a href="${esc(senderWebsite)}" target="_blank" rel="noopener noreferrer" style="color:#3b82f6; text-decoration:none;">${esc(senderCompany)}</a>`
      : esc(senderCompany);
    sigLines.push(`<p style="margin:2px 0 0;">${companyText}</p>`);
  }

  const signatureBlock = sigLines.length > 0
    ? `<tr><td style="padding:0 32px 24px; font-size:13px; line-height:1.5; color:#71717a;">
        <p style="margin:0;">—</p>
        ${sigLines.join('\n        ')}
      </td></tr>`
    : '';

  // CTA button (if calendly URL provided)
  const ctaBlock = calendlyUrl
    ? `<tr><td style="padding:0 32px 24px;" align="left">
        <a href="${esc(calendlyUrl)}" target="_blank" rel="noopener noreferrer"
           style="display:inline-block; padding:10px 24px; background:#3b82f6; color:#ffffff; font-size:13px; font-weight:600; text-decoration:none; border-radius:6px;">
          Book a Quick Chat
        </a>
      </td></tr>`
    : '';

  // Footer
  const footerParts: string[] = [];
  if (senderCompany) footerParts.push(esc(senderCompany));
  if (unsubscribeUrl) {
    footerParts.push(`<a href="${esc(unsubscribeUrl)}" style="color:#a1a1aa; text-decoration:underline;">Unsubscribe</a>`);
  }
  const footerContent = footerParts.length > 0 ? footerParts.join(' &middot; ') : '';

  const footerBlock = footerContent
    ? `<tr><td style="padding:16px 32px; border-top:1px solid #e4e4e7; font-size:11px; line-height:1.4; color:#a1a1aa; text-align:center;">
        ${footerContent}
      </td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title></title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff; border-radius:8px; border:1px solid #e4e4e7; max-width:600px; width:100%;">
          <!-- Body -->
          <tr>
            <td style="padding:32px 32px 16px; font-size:14px; line-height:1.7; color:#18181b; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
              ${body}
            </td>
          </tr>
          <!-- Signature -->
          ${signatureBlock}
          <!-- CTA -->
          ${ctaBlock}
          <!-- Footer -->
          ${footerBlock}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
