/**
 * Minimal email wrapper. Goal: a 1:1-looking message a real person would
 * send from Gmail, NOT a marketing template.
 *
 * Design choices and why:
 * - No <table>-based layout. Spam filters down-rank promotional layouts
 *   from senders without warm-up history.
 * - No card / border / rounded corners / colored background. The body text
 *   sits directly on the email client's default chrome.
 * - The signature is plain text wrapped in <p> tags. No bold names, no
 *   logo, no decorative dashes — just three lines like a personal sign-off.
 * - The unsubscribe footer is small grey text on its own line. Not a
 *   button. Single-click compliant via the List-Unsubscribe header
 *   (added separately in tools/smtp.tool.ts), this is just a backup link.
 *
 * The `body` argument MUST already be HTML (paragraphs / line breaks).
 * Convert plain-text bodies via plainTextToHtml() below before passing.
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

/**
 * Convert a plain-text email body (with \n line breaks and \n\n paragraph
 * breaks) to minimal HTML. Each \n\n group becomes one <p>; single \n
 * inside a paragraph becomes <br>. HTML-special chars are escaped.
 */
export function plainTextToHtml(text: string): string {
  if (!text) return '';
  return text
    .split(/\n{2,}/)
    .map((para) => {
      const escaped = esc(para.trim()).replace(/\n/g, '<br>');
      return escaped ? `<p style="margin:0 0 14px;">${escaped}</p>` : '';
    })
    .filter(Boolean)
    .join('');
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

  // Signature: 1-3 lines, plain like a person typed it
  const sigLines: string[] = [];
  if (senderName) sigLines.push(esc(senderName));
  const titleAndCompany: string[] = [];
  if (senderTitle) titleAndCompany.push(esc(senderTitle));
  if (senderCompany) {
    if (senderWebsite) {
      titleAndCompany.push(`<a href="${esc(senderWebsite)}" style="color:#1a73e8; text-decoration:none;">${esc(senderCompany)}</a>`);
    } else {
      titleAndCompany.push(esc(senderCompany));
    }
  }
  if (titleAndCompany.length) sigLines.push(titleAndCompany.join(', '));

  // Optional inline scheduling link in the signature line
  if (calendlyUrl) {
    sigLines.push(`<a href="${esc(calendlyUrl)}" style="color:#1a73e8; text-decoration:underline;">Book a quick chat</a>`);
  }

  const signatureHtml = sigLines.length
    ? `<p style="margin:14px 0 0; color:#222;">${sigLines.join('<br>')}</p>`
    : '';

  // Unsubscribe footer (small grey text, last line). Backup for the
  // List-Unsubscribe header which is the primary compliance path.
  const footerHtml = unsubscribeUrl
    ? `<p style="margin:24px 0 0; font-size:11px; color:#888;">
         If you'd rather not hear from us, <a href="${esc(unsubscribeUrl)}" style="color:#888; text-decoration:underline;">unsubscribe here</a>.
       </p>`
    : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"><title></title></head>
<body style="margin:0; padding:0; background:#ffffff;">
<div style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size:14px; line-height:1.6; color:#222; max-width:640px; padding:8px;">
${body}
${signatureHtml}
${footerHtml}
</div>
</body></html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
