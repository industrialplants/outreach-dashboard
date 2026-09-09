// Sends outreach emails through GoHighLevel's v2 API.
//
// Unlike Microsoft Graph — where you just POST to a mailbox and name a
// recipient address — GHL is contact-centric: the recipient must exist as a
// contact in the sub-account before anything can be sent to them. So this is
// a two-step flow:
//
//   1. POST /contacts/upsert  → creates the contact or finds the existing one
//                               by email, returns its contactId
//   2. POST /conversations/messages with type "Email" and that contactId
//
// The upside of going through GHL rather than a raw mailbox: the sent email
// shows up in the contact's conversation thread, so replies and history live
// in the CRM where the team already works.
//
// Auth: a Private Integration Token scoped to the SUB-ACCOUNT (location),
// not an agency-level key. Required scopes: contacts.write and
// conversations/message.write.

import type { GhlSendConfig } from "./sendConfig";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function ghlHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Version: GHL_VERSION,
    Accept: "application/json",
  };
}

// Splits a full name into first/last for the GHL contact record. Everything
// before the last space is the first name, so "Maria Fernanda Monteiro"
// becomes "Maria Fernanda" + "Monteiro" rather than dropping a middle name.
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

// Our message bodies are plain text with blank lines between paragraphs.
// GHL sends email as HTML, so line breaks have to be converted or the whole
// mail arrives as one run-on block.
function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const paragraphs = escaped
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6;">${paragraphs}</div>`;
}

async function upsertContact(
  config: GhlSendConfig,
  params: { email: string; name: string; company: string },
): Promise<string> {
  const { firstName, lastName } = splitName(params.name);

  const res = await fetch(`${GHL_BASE}/contacts/upsert`, {
    method: "POST",
    headers: ghlHeaders(config.token),
    body: JSON.stringify({
      locationId: config.locationId,
      email: params.email,
      firstName,
      lastName,
      companyName: params.company || undefined,
      source: "Outreach Dashboard",
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GHL contacts/upsert fehlgeschlagen (${res.status}): ${text}`);
  }

  let data: { contact?: { id?: string }; id?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`GHL contacts/upsert: Antwort war kein JSON: ${text}`);
  }

  // GHL has returned the contact nested under "contact" and (in older
  // responses) at the top level — accept either rather than breaking on a
  // shape change.
  const contactId = data.contact?.id ?? data.id;
  if (!contactId) {
    throw new Error(`GHL contacts/upsert: keine contactId in der Antwort: ${text}`);
  }
  return contactId;
}

export async function sendMailViaGhl(
  config: GhlSendConfig,
  params: { to: string; subject: string; body: string; name: string; company: string },
): Promise<void> {
  const contactId = await upsertContact(config, {
    email: params.to,
    name: params.name,
    company: params.company,
  });

  const payload: Record<string, unknown> = {
    type: "Email",
    contactId,
    subject: params.subject,
    message: params.body, // plain-text version
    html: textToHtml(params.body),
    emailTo: params.to,
  };
  if (config.fromEmail) {
    payload.emailFrom = config.fromName
      ? `${config.fromName} <${config.fromEmail}>`
      : config.fromEmail;
  }

  const res = await fetch(`${GHL_BASE}/conversations/messages`, {
    method: "POST",
    headers: ghlHeaders(config.token),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GHL conversations/messages fehlgeschlagen (${res.status}): ${text}`);
  }
}
