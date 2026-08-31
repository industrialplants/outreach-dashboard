import type { Row } from "@libsql/client";
import { getDb } from "./db";
import { hashPassword, verifyPassword } from "./auth";
import type {
  Client,
  ClientWithCount,
  Kpis,
  Lead,
  LeadChannel,
  LeadStatus,
  WeekReportRow,
  WebhookPayload,
} from "./types";
import { STATUS_ORDER } from "./types";

// ---------- Row mapping ----------
// libsql rows are array-like objects (indexed and named). Map them to plain,
// typed, JSON-serializable objects before they leave this module.

function mapClient(r: Row): Client {
  const username = String(r.username ?? "");
  const passwordHash = String(r.password_hash ?? "");
  return {
    token: String(r.token),
    name: String(r.name),
    username,
    hasLogin: username !== "" && passwordHash !== "",
  };
}

function mapLead(r: Row): Lead {
  return {
    id: Number(r.id),
    client_token: String(r.client_token),
    name: String(r.name),
    company: String(r.company),
    title: String(r.title),
    linkedin_url: String(r.linkedin_url),
    email: String(r.email),
    generated_message: String(r.generated_message),
    email_subject: String(r.email_subject),
    email_body: String(r.email_body),
    research_summary: String(r.research_summary),
    signal: String(r.signal),
    status: String(r.status) as LeadStatus,
    comment: String(r.comment),
    channel: (String(r.channel) || "both") as LeadChannel,
    campaign: String(r.campaign),
    send_paused_at: String(r.send_paused_at),
    linkedin_approved_at: String(r.linkedin_approved_at),
    email_approved_at: String(r.email_approved_at),
    dm_sent_at: String(r.dm_sent_at),
    dm_blocked_at: String(r.dm_blocked_at),
    email_sent_at: String(r.email_sent_at),
    generated_message_original: String(r.generated_message_original),
    email_subject_original: String(r.email_subject_original),
    email_body_original: String(r.email_body_original),
    pending_edit_fields: String(r.pending_edit_fields),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

// ---------- Clients ----------

export async function listClients(): Promise<Client[]> {
  const db = await getDb();
  const rs = await db.execute("SELECT * FROM clients ORDER BY name");
  return rs.rows.map(mapClient);
}

export async function getClient(token: string): Promise<Client | undefined> {
  const db = await getDb();
  const rs = await db.execute({
    sql: "SELECT * FROM clients WHERE token = ?",
    args: [token],
  });
  return rs.rows[0] ? mapClient(rs.rows[0]) : undefined;
}

// Clients plus their lead count, for the admin "Kunden" tab.
export async function listClientsWithCounts(): Promise<ClientWithCount[]> {
  const db = await getDb();
  const rs = await db.execute(
    `SELECT c.token AS token, c.name AS name, c.username AS username,
            c.password_hash AS password_hash,
            COUNT(l.id) AS leadCount
       FROM clients c
       LEFT JOIN leads l ON l.client_token = c.token
      GROUP BY c.token, c.name, c.username, c.password_hash
      ORDER BY c.name`,
  );
  return rs.rows.map((r) => ({
    ...mapClient(r),
    leadCount: Number(r.leadCount),
  }));
}

// Create a new client. Returns undefined if the token is already taken.
// Optionally sets up a login (username + plaintext password, hashed here) in
// the same step — used by the "Kunde anlegen" form in the admin Kunden tab.
export async function createClient(
  token: string,
  name: string,
  username?: string,
  passwordPlain?: string,
): Promise<Client | { error: string } | undefined> {
  if (await getClient(token)) return undefined;
  const db = await getDb();
  const cleanUsername = (username?.trim() ?? "").toLowerCase();
  const passwordHash = passwordPlain ? hashPassword(passwordPlain) : "";
  if (cleanUsername) {
    const existing = await findClientByUsername(cleanUsername);
    if (existing) return { error: "Dieser Benutzername ist bereits vergeben." };
  }
  await db.execute({
    sql: "INSERT INTO clients (token, name, username, password_hash) VALUES (?, ?, ?, ?)",
    args: [token, name, cleanUsername, passwordHash],
  });
  return {
    token,
    name,
    username: cleanUsername,
    hasLogin: cleanUsername !== "" && passwordHash !== "",
  };
}

// Set or change a client's login. Empty username clears the login entirely.
export async function updateClientCredentials(
  token: string,
  username: string,
  passwordPlain: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = await getClient(token);
  if (!client) return { ok: false, error: "Kunde nicht gefunden." };

  const cleanUsername = username.trim().toLowerCase();
  if (!cleanUsername || !passwordPlain) {
    return { ok: false, error: "Benutzername und Passwort sind erforderlich." };
  }
  const existing = await findClientByUsername(cleanUsername);
  if (existing && existing.token !== token) {
    return { ok: false, error: "Dieser Benutzername ist bereits vergeben." };
  }

  const db = await getDb();
  await db.execute({
    sql: "UPDATE clients SET username = ?, password_hash = ? WHERE token = ?",
    args: [cleanUsername, hashPassword(passwordPlain), token],
  });
  return { ok: true };
}

// Internal: raw lookup by username, used for login + uniqueness checks. Not
// exported as-is because the row still carries the password hash.
async function findClientByUsername(
  username: string,
): Promise<{ token: string; passwordHash: string } | undefined> {
  const db = await getDb();
  const rs = await db.execute({
    sql: "SELECT token, password_hash FROM clients WHERE username = ?",
    args: [username],
  });
  const row = rs.rows[0];
  if (!row) return undefined;
  return { token: String(row.token), passwordHash: String(row.password_hash) };
}

// Verifies a client login attempt. Returns the Client on success, undefined
// on any failure (unknown username, wrong password, or no login configured).
export async function verifyClientLogin(
  username: string,
  password: string,
): Promise<Client | undefined> {
  const cleanUsername = username.trim().toLowerCase();
  if (!cleanUsername || !password) return undefined;
  const found = await findClientByUsername(cleanUsername);
  if (!found || !found.passwordHash) return undefined;
  if (!verifyPassword(password, found.passwordHash)) return undefined;
  return getClient(found.token);
}

// Delete a client together with all of its leads. Returns false if unknown.
export async function deleteClient(token: string): Promise<boolean> {
  const db = await getDb();
  if (!(await getClient(token))) return false;
  // One transaction: drop the leads first (FK), then the client.
  await db.batch(
    [
      { sql: "DELETE FROM leads WHERE client_token = ?", args: [token] },
      { sql: "DELETE FROM clients WHERE token = ?", args: [token] },
    ],
    "write",
  );
  return true;
}

// Auto-register a client the first time Clay sends a lead with an unknown token.
export async function ensureClient(
  token: string,
  fallbackName?: string,
): Promise<Client> {
  const existing = await getClient(token);
  if (existing) return existing;
  const name = fallbackName?.trim() || token;
  const db = await getDb();
  await db.execute({
    sql: "INSERT INTO clients (token, name) VALUES (?, ?)",
    args: [token, name],
  });
  return { token, name, username: "", hasLogin: false };
}

// ---------- Leads ----------

export async function listLeads(clientToken: string): Promise<Lead[]> {
  const db = await getDb();
  const rs = await db.execute({
    sql: "SELECT * FROM leads WHERE client_token = ? ORDER BY datetime(created_at) DESC",
    args: [clientToken],
  });
  return rs.rows.map(mapLead);
}

// One-time backfill (18.08.2026): the separate per-channel approval columns
// default to empty for all pre-existing leads. For a channel that's already
// been sent, backfilling its approval timestamp is risk-free — the send
// already happened, nothing new can be triggered by it — and it clears up
// the cosmetic oddity of an already-sent lead still showing an active
// "freigeben" button. Deliberately does NOT touch leads that are merely
// "approved" but not yet sent — restoring approval there would undermine
// the entire point of the 18.08.2026 fix (an old blanket approval never
// guaranteed each channel was actually reviewed individually).
export async function backfillApprovalForAlreadySent(clientToken: string): Promise<number> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `UPDATE leads
           SET linkedin_approved_at = CASE
                 WHEN dm_sent_at <> '' AND linkedin_approved_at = '' THEN dm_sent_at
                 ELSE linkedin_approved_at
               END,
               email_approved_at = CASE
                 WHEN email_sent_at <> '' AND email_approved_at = '' THEN email_sent_at
                 ELSE email_approved_at
               END
           WHERE client_token = ?
             AND ((dm_sent_at <> '' AND linkedin_approved_at = '')
                  OR (email_sent_at <> '' AND email_approved_at = ''))`,
    args: [clientToken],
  });
  return rs.rowsAffected;
}


// One-time backfill (19.08.2026): before the campaign field existed, "Beide
// Kanäle" leads were all the CEO campaign and "Nur LinkedIn" leads were all
// HR. Tags every existing lead accordingly — but only where campaign is
// still empty, so it can never overwrite a value someone already set by
// hand, and running it twice is harmless.
export async function backfillCampaignFromChannel(
  clientToken: string,
  bothLabel: string,
  linkedinLabel: string,
): Promise<number> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `UPDATE leads
           SET campaign = CASE
                 WHEN channel = 'both' THEN ?
                 WHEN channel = 'linkedin' THEN ?
                 ELSE campaign
               END
           WHERE client_token = ?
             AND campaign = ''
             AND channel IN ('both', 'linkedin')`,
    args: [bothLabel, linkedinLabel, clientToken],
  });
  return rs.rowsAffected;
}

// Leads eligible for the automated Microsoft Graph email send job. Gated on
// the real, explicit email_approved_at timestamp — NOT the coarse overall
// status. Before 18.08.2026 this checked status IN ('approved','sent'),
// which meant a lead approved only on the LinkedIn side (status='approved')
// could still have its never-reviewed email sent automatically. That
// happened in production once — this is the direct fix.
export async function listSendableEmails(
  clientToken: string,
  limit: number,
): Promise<Lead[]> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT * FROM leads
           WHERE client_token = ?
             AND send_paused_at = ''
             AND status NOT IN ('rejected', 'dnd', 'call_booked')
             AND email_approved_at <> ''
             AND email_sent_at = ''
             AND trim(email_body) <> ''
             AND trim(email) <> ''
             AND channel IN ('email', 'both')
             AND pending_edit_fields NOT LIKE '%email_subject%'
             AND pending_edit_fields NOT LIKE '%email_body%'
           ORDER BY datetime(created_at) ASC
           LIMIT ?`,
    args: [clientToken, limit],
  });
  return rs.rows.map(mapLead);
}

export async function getLead(id: number): Promise<Lead | undefined> {
  const db = await getDb();
  const rs = await db.execute({
    sql: "SELECT * FROM leads WHERE id = ?",
    args: [id],
  });
  return rs.rows[0] ? mapLead(rs.rows[0]) : undefined;
}

// Clay's email-finder tools often prefix the address with a verification
// marker, e.g. "✅ name@firma.de" instead of a clean address. Pull out just
// the actual email so it's always usable as a real recipient address —
// everywhere (Graph sendMail, mailto links, dedup) benefits from this being
// clean at the source rather than needing to sanitize it at every call site.
function extractEmail(raw: string | undefined): string {
  if (!raw) return "";
  const match = raw.match(/[^\s<>()]+@[^\s<>()]+\.[^\s<>()]+/);
  return match ? match[0].replace(/[.,;:]+$/, "") : "";
}

// Clay sends channel as free text; anything unrecognized safely falls back
// to "both" rather than silently blocking a lead from every channel. Trimmed
// and lower-cased so "LinkedIn", " linkedin ", etc. all still match.
function normalizeChannel(value: string | undefined): LeadChannel {
  const v = value?.trim().toLowerCase();
  if (v === "linkedin" || v === "email" || v === "both") return v;
  return "both";
}

export async function createLead(payload: WebhookPayload): Promise<Lead> {
  const db = await getDb();
  const now = new Date().toISOString();
  const token = payload.client_token!.trim();
  const info = await db.execute({
    sql: `INSERT INTO leads (
        client_token, name, company, title, linkedin_url, email,
        generated_message, email_subject, email_body, research_summary, signal, status, comment, channel, campaign,
        created_at, updated_at
      ) VALUES (
        $client_token, $name, $company, $title, $linkedin_url, $email,
        $generated_message, $email_subject, $email_body, $research_summary, $signal, 'new', '', $channel, $campaign,
        $created_at, $updated_at
      )`,
    args: {
      client_token: token,
      name: payload.name ?? "",
      company: payload.company ?? "",
      title: payload.title ?? "",
      linkedin_url: payload.linkedin_url ?? "",
      email: extractEmail(payload.email),
      generated_message: payload.generated_message ?? "",
      email_subject: payload.email_subject ?? "",
      email_body: payload.email_body ?? "",
      research_summary: payload.research_summary ?? "",
      signal: payload.signal ?? "",
      channel: normalizeChannel(payload.channel),
      campaign: (payload.campaign ?? "").trim(),
      created_at: now,
      updated_at: now,
    },
  });
  const created = await getLead(Number(info.lastInsertRowid));
  return created!;
}

// Insert a lead, or — if one with the same linkedin_url already exists for this
// client — refresh its generated content instead of creating a duplicate.
// Clay re-sends the same person as it enriches them; we keep one row per person.
//
// Done atomically via INSERT ... ON CONFLICT against the partial unique index
// idx_leads_client_linkedin, so even concurrent webhook calls for the same
// person can't create a duplicate. On conflict the generated content is
// refreshed and an already-reviewed lead (status != 'new') is flagged
// 'revised' so it resurfaces; the comment and created_at are preserved.
// Leads without a linkedin_url can't be matched, so they are always inserted.
// The one place that defines "is this lead fully approved" — depends on
// which channel(s) actually apply. A linkedin-only lead only ever needs the
// LinkedIn approval; a both-channel lead needs both, independently.
function isFullyApproved(
  channel: LeadChannel,
  linkedinApprovedAt: string,
  emailApprovedAt: string,
): boolean {
  const linkedinOk = channel === "email" || !!linkedinApprovedAt;
  const emailOk = channel === "linkedin" || !!emailApprovedAt;
  return linkedinOk && emailOk;
}

// Same idea for "sent": a both-channel lead is only truly Gesendet once
// BOTH channels have actually gone out. Before 18.08.2026, clicking either
// "DM gesendet" or "E-Mail gesendet" alone force-set status to 'sent',
// making the status pill lie for the still-outstanding channel.
function isFullySent(
  channel: LeadChannel,
  dmSentAt: string,
  emailSentAt: string,
  dmBlockedAt: string,
): boolean {
  const linkedinOk = channel === "email" || !!dmSentAt || !!dmBlockedAt;
  const emailOk = channel === "linkedin" || !!emailSentAt;
  return linkedinOk && emailOk;
}

// Logs a change to one of the three tracked text fields. Called from every
// path that can change them — dashboard edits, accept/revert, and (as a
// "Clay tried to overwrite this, here's what it attempted" record) resends
// that get blocked. Never overwrites or deletes prior entries.
async function logMessageChange(
  leadId: number,
  field: string,
  oldValue: string,
  newValue: string,
  source: string,
): Promise<void> {
  if (oldValue === newValue) return;
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO lead_message_history (lead_id, field, old_value, new_value, source, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [leadId, field, oldValue, newValue, source, new Date().toISOString()],
  });
}

export async function upsertLead(payload: WebhookPayload): Promise<Lead> {
  const token = payload.client_token!.trim();
  const linkedin = payload.linkedin_url?.trim();

  if (!linkedin) return createLead(payload);

  const db = await getDb();
  const now = new Date().toISOString();
  const incomingMessage = payload.generated_message ?? "";
  const incomingSubject = payload.email_subject ?? "";
  const incomingBody = payload.email_body ?? "";

  // Hard cut (19.08.2026, decided with Daniela): once a lead row exists, a
  // Clay resend can NEVER change generated_message/email_subject/email_body
  // again — no conditions, no exceptions. Everything that ever lived in the
  // dashboard stays exactly as it was; the dashboard is the only place that
  // can change it from here on. This replaces an earlier, conditional
  // version of this protection (approved/sent/pending-only) after a lead's
  // manually-corrected email got overwritten with no visible trace of what
  // happened — "idR läuft Clay bei uns nie zweimal", so there's no real
  // workflow this breaks, and it's far simpler to reason about as absolute.
  const existing = await db.execute({
    sql: "SELECT id, generated_message, email_subject, email_body FROM leads WHERE client_token = ? AND linkedin_url = ?",
    args: [token, linkedin],
  });
  const existingRow = existing.rows[0];
  if (existingRow) {
    const leadId = Number(existingRow.id);
    // Log what Clay attempted, even though it's being blocked — this is the
    // audit trail: if this ever needs investigating, "what did Clay try to
    // send, and when" is answered here, instead of the change happening
    // invisibly (or, as before, being silently applied).
    await logMessageChange(
      leadId,
      "generated_message",
      String(existingRow.generated_message),
      incomingMessage,
      "webhook_blocked",
    );
    await logMessageChange(
      leadId,
      "email_subject",
      String(existingRow.email_subject),
      incomingSubject,
      "webhook_blocked",
    );
    await logMessageChange(
      leadId,
      "email_body",
      String(existingRow.email_body),
      incomingBody,
      "webhook_blocked",
    );
  }

  await db.execute({
    sql: `INSERT INTO leads (
        client_token, name, company, title, linkedin_url, email,
        generated_message, email_subject, email_body, research_summary, signal, status, comment, channel, campaign,
        created_at, updated_at
      ) VALUES (
        $client_token, $name, $company, $title, $linkedin_url, $email,
        $generated_message, $email_subject, $email_body, $research_summary, $signal, 'new', '', $channel, $campaign,
        $created_at, $updated_at
      )
      ON CONFLICT(client_token, linkedin_url) WHERE linkedin_url <> ''
      DO UPDATE SET
        -- generated_message, email_subject, email_body, linkedin_approved_at,
        -- email_approved_at, status, pending_edit_fields, dm_sent_at,
        -- email_sent_at are deliberately NOT listed here — a resend can
        -- never touch any of them once the row exists. Only these
        -- "metadata" fields still refresh on a resend:
        signal            = excluded.signal,
        research_summary  = excluded.research_summary,
        title             = excluded.title,
        channel           = excluded.channel,
        campaign          = CASE WHEN excluded.campaign <> '' THEN excluded.campaign ELSE leads.campaign END,
        updated_at        = excluded.updated_at`,
    args: {
      client_token: token,
      name: payload.name ?? "",
      company: payload.company ?? "",
      title: payload.title ?? "",
      linkedin_url: linkedin,
      email: extractEmail(payload.email),
      generated_message: incomingMessage,
      email_subject: incomingSubject,
      email_body: incomingBody,
      research_summary: payload.research_summary ?? "",
      signal: payload.signal ?? "",
      channel: normalizeChannel(payload.channel),
      campaign: (payload.campaign ?? "").trim(),
      created_at: now,
      updated_at: now,
    },
  });

  const rs = await db.execute({
    sql: "SELECT * FROM leads WHERE client_token = ? AND linkedin_url = ?",
    args: [token, linkedin],
  });
  return mapLead(rs.rows[0]);
}

// Fields that support the customer-edit tracking (snapshot + diff) described
// above. Kept as a const tuple so TypeScript can narrow over it.
const TRACKED_FIELDS = ["generated_message", "email_subject", "email_body"] as const;
type TrackedField = (typeof TRACKED_FIELDS)[number];

function parsePending(value: string): Set<TrackedField> {
  return new Set(
    value.split(",").filter((f): f is TrackedField =>
      TRACKED_FIELDS.includes(f as TrackedField),
    ),
  );
}

export interface MessageHistoryEntry {
  id: number;
  field: string;
  old_value: string;
  new_value: string;
  source: string;
  created_at: string;
}

// Full change history for a lead's three tracked text fields, oldest first.
export async function getLeadHistory(leadId: number): Promise<MessageHistoryEntry[]> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT id, field, old_value, new_value, source, created_at
           FROM lead_message_history
          WHERE lead_id = ?
          ORDER BY datetime(created_at) ASC`,
    args: [leadId],
  });
  return rs.rows.map((r) => ({
    id: Number(r.id),
    field: String(r.field),
    old_value: String(r.old_value),
    new_value: String(r.new_value),
    source: String(r.source),
    created_at: String(r.created_at),
  }));
}

export async function updateLead(
  id: number,
  changes: {
    status?: LeadStatus;
    comment?: string;
    generated_message?: string;
    email_subject?: string;
    email_body?: string;
    dm_sent_at?: string;
    email_sent_at?: string;
    dm_blocked_at?: string;
    // Whether this update comes from the agency admin or from the client
    // themself — decides whether an edit is tracked as a pending customer
    // change (client) or treated as final/reviewed (admin).
    isAdminEdit?: boolean;
    // Admin-only actions on fields that currently have a pending customer
    // edit: keep the customer's text but clear the "needs review" marker, or
    // throw it away and restore the AI-generated original.
    acceptFields?: string[];
    revertFields?: string[];
    // Reassigns which channel(s) a lead is eligible for. Deliberately its own
    // independent field — never touches text or review markers (but DOES
    // affect what "fully approved" means — see isFullyApproved).
    channel?: string;
    // Corrects/adds the contact email address. Same principle: independent
    // of everything else, admin-only, no side effects on text or status.
    email?: string;
    // Free-text campaign label (e.g. "CEO", "HR") — same independence
    // guarantee as channel/email: admin-only, no side effects elsewhere.
    campaign?: string;
    // Emergency stop — available to admin AND client. Blocks the automated
    // send queue outright and disables the manual send-confirmation buttons,
    // regardless of status/channel/approval. Decided 18.08.2026.
    paused?: boolean;
    // Explicit, separate approval per channel (18.08.2026). Approving
    // LinkedIn never approves the email side, and vice versa — closes the
    // gap where a lead was approved for LinkedIn and its still-unreviewed
    // email went out anyway. Setting one just stamps that channel's
    // timestamp; it never touches the other channel's approval.
    approveChannel?: "linkedin" | "email";
  },
): Promise<Lead | undefined> {
  const existing = await getLead(id);
  if (!existing) return undefined;

  const comment =
    changes.comment !== undefined ? changes.comment : existing.comment;
  const channel =
    changes.channel !== undefined ? normalizeChannel(changes.channel) : existing.channel;
  const email = changes.email !== undefined ? extractEmail(changes.email) : existing.email;
  const campaign = changes.campaign !== undefined ? changes.campaign.trim() : existing.campaign;
  const send_paused_at =
    changes.paused === undefined
      ? existing.send_paused_at
      : changes.paused
        ? new Date().toISOString()
        : "";
  const dm_sent_at =
    changes.dm_sent_at !== undefined ? changes.dm_sent_at : existing.dm_sent_at;
  const email_sent_at =
    changes.email_sent_at !== undefined
      ? changes.email_sent_at
      : existing.email_sent_at;
  const dm_blocked_at =
    changes.dm_blocked_at !== undefined ? changes.dm_blocked_at : existing.dm_blocked_at;

  const pending = parsePending(existing.pending_edit_fields);
  const accept = new Set(changes.acceptFields ?? []);
  const revert = new Set(changes.revertFields ?? []);

  // Working copies of the three tracked text fields + their baselines.
  const current: Record<TrackedField, string> = {
    generated_message: existing.generated_message,
    email_subject: existing.email_subject,
    email_body: existing.email_body,
  };
  const original: Record<TrackedField, string> = {
    generated_message: existing.generated_message_original,
    email_subject: existing.email_subject_original,
    email_body: existing.email_body_original,
  };

  for (const field of TRACKED_FIELDS) {
    if (revert.has(field) && pending.has(field)) {
      current[field] = original[field];
      original[field] = "";
      pending.delete(field);
      continue;
    }
    if (accept.has(field) && pending.has(field)) {
      original[field] = "";
      pending.delete(field);
      continue;
    }
    const incoming = changes[field];
    if (incoming === undefined || incoming === current[field]) continue;

    if (changes.isAdminEdit) {
      // The admin's edit is the new source of truth — no diff needed.
      current[field] = incoming;
      original[field] = "";
      pending.delete(field);
    } else {
      // A client edit: capture the pre-edit baseline the first time only, so
      // repeated edits before admin review still diff against the original
      // AI-generated text, not an intermediate customer draft.
      if (!pending.has(field)) {
        original[field] = current[field];
        pending.add(field);
      }
      current[field] = incoming;
    }
  }

  // Did the actual LinkedIn / email text change value in this update, via
  // ANY path — direct edit, "Original wiederherstellen", even an admin edit?
  // If so, whatever approval existed for the old text no longer applies to
  // the new text and must be re-earned. This is the rule that makes approval
  // trustworthy: it always matches the exact text it was granted for.
  const linkedinTextChanged = current.generated_message !== existing.generated_message;
  const emailTextChanged =
    current.email_subject !== existing.email_subject ||
    current.email_body !== existing.email_body;

  let linkedin_approved_at = existing.linkedin_approved_at;
  let email_approved_at = existing.email_approved_at;

  if (changes.approveChannel === "linkedin") linkedin_approved_at = new Date().toISOString();
  if (changes.approveChannel === "email") email_approved_at = new Date().toISOString();

  // Invalidation always wins over approval, even if (implausibly) both were
  // requested in the same call — a stale approval must never survive.
  if (linkedinTextChanged) linkedin_approved_at = "";
  if (emailTextChanged) email_approved_at = "";

  // A hard reject, a DND/Absage, a booked call, or an explicit manual
  // downgrade back to "Neu" all kill any standing approval outright —
  // full-lead resets, so both channels reset with them.
  if (
    changes.status === "rejected" ||
    changes.status === "dnd" ||
    changes.status === "new" ||
    changes.status === "call_booked"
  ) {
    linkedin_approved_at = "";
    email_approved_at = "";
  }
  // "Überarbeitet" is set two ways: (a) the API layer sets it automatically
  // whenever a message field was just edited — already precisely handled
  // above (only the channel whose text actually changed loses its
  // approval); or (b) someone manually flags the lead via the status
  // dropdown with no accompanying edit, meaning "needs a fresh look" for
  // everything — that's a full reset, so both are cleared. Never do both:
  // an edit to just the LinkedIn text must never also wipe a still-valid,
  // untouched email approval.
  if (changes.status === "revised" && !linkedinTextChanged && !emailTextChanged) {
    linkedin_approved_at = "";
    email_approved_at = "";
  }

  // "Freigeben" auto-clears any pending customer-edit marker on the channel
  // being approved (decided with the client 13.08.2026 — approving is
  // itself the trust signal) — but only for that one channel's fields, not
  // both, since the two are approved independently now.
  if (changes.approveChannel === "linkedin") {
    original.generated_message = "";
    pending.delete("generated_message");
  }
  if (changes.approveChannel === "email") {
    original.email_subject = "";
    original.email_body = "";
    pending.delete("email_subject");
    pending.delete("email_body");
  }

  // Status: explicit terminal actions (reject/dnd/sent/call_booked) or an
  // explicit status from the API layer (e.g. "revised" after an edit) always
  // win. A pure approve-channel call with no explicit status auto-promotes
  // to "approved" once every channel this lead actually needs is approved —
  // and otherwise leaves status exactly as it was; approving one of two
  // required channels shouldn't (yet) claim the whole lead is approved.
  let status = changes.status ?? existing.status;
  if (changes.status === undefined && changes.approveChannel) {
    if (isFullyApproved(channel, linkedin_approved_at, email_approved_at)) {
      status = "approved";
    }
  }
  // Same principle for the send confirmations: clicking "DM gesendet" or
  // "E-Mail gesendet" only promotes status to "sent" once every channel this
  // lead actually needs has gone out. Otherwise it stays "approved" (or
  // whatever it already was) — never downgrades something further along
  // like "replied" or "call_booked" back to "sent".
  if (
    changes.status === undefined &&
    (changes.dm_sent_at !== undefined ||
      changes.email_sent_at !== undefined ||
      changes.dm_blocked_at !== undefined) &&
    (existing.status === "approved" || existing.status === "sent") &&
    isFullySent(channel, dm_sent_at, email_sent_at, dm_blocked_at)
  ) {
    status = "sent";
  }
  // Hard safety net, independent of how this function was called: "approved"
  // is a claim that every applicable channel was individually, deliberately
  // approved. It can never be true just because someone (or some other code
  // path, e.g. the raw status dropdown) set status="approved" directly — if
  // the underlying approvals don't actually back that up, it's downgraded.
  // Sending is gated on the approval timestamps anyway, never on this label,
  // but the label must never lie about what's actually been reviewed.
  if (status === "approved" && !isFullyApproved(channel, linkedin_approved_at, email_approved_at)) {
    status = existing.status === "new" ? "new" : "revised";
  }

  const db = await getDb();
  const changeSource = changes.isAdminEdit ? "admin_edit" : "client_edit";
  if (linkedinTextChanged) {
    await logMessageChange(
      id,
      "generated_message",
      existing.generated_message,
      current.generated_message,
      revert.has("generated_message") ? "revert" : changeSource,
    );
  }
  if (current.email_subject !== existing.email_subject) {
    await logMessageChange(
      id,
      "email_subject",
      existing.email_subject,
      current.email_subject,
      revert.has("email_subject") ? "revert" : changeSource,
    );
  }
  if (current.email_body !== existing.email_body) {
    await logMessageChange(
      id,
      "email_body",
      existing.email_body,
      current.email_body,
      revert.has("email_body") ? "revert" : changeSource,
    );
  }
  await db.execute({
    sql: `UPDATE leads SET
            status = ?, comment = ?, channel = ?, campaign = ?, email = ?, send_paused_at = ?,
            linkedin_approved_at = ?, email_approved_at = ?,
            generated_message = ?, email_subject = ?, email_body = ?,
            generated_message_original = ?, email_subject_original = ?, email_body_original = ?,
            pending_edit_fields = ?,
            dm_sent_at = ?, email_sent_at = ?, dm_blocked_at = ?,
            updated_at = ?
          WHERE id = ?`,
    args: [
      status,
      comment,
      channel,
      campaign,
      email,
      send_paused_at,
      linkedin_approved_at,
      email_approved_at,
      current.generated_message,
      current.email_subject,
      current.email_body,
      original.generated_message,
      original.email_subject,
      original.email_body,
      [...pending].join(","),
      dm_sent_at,
      email_sent_at,
      dm_blocked_at,
      new Date().toISOString(),
      id,
    ],
  });

  return getLead(id);
}

// Permanently delete a lead. Returns false if no row matched.
export async function deleteLead(id: number): Promise<boolean> {
  const db = await getDb();
  const res = await db.execute({
    sql: "DELETE FROM leads WHERE id = ?",
    args: [id],
  });
  return res.rowsAffected > 0;
}

// ---------- KPIs & reporting ----------

// Monday 00:00 (local) of the week containing `d`.
function startOfIsoWeek(d: Date): Date {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0 = Sun ... 6 = Sat
  const diff = (day === 0 ? -6 : 1) - day; // shift back to Monday
  date.setDate(date.getDate() + diff);
  return date;
}

// ISO week number + year, e.g. { year: 2026, week: 27 }.
function isoWeekParts(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return { year: date.getUTCFullYear(), week };
}

function isoWeekKey(d: Date): string {
  const { year, week } = isoWeekParts(d);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const dateFmt = new Intl.DateTimeFormat("de-DE", {
  day: "numeric",
  month: "short",
});
const dateFmtFull = new Intl.DateTimeFormat("de-DE", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function weekLabel(anyDayInWeek: Date): string {
  const start = startOfIsoWeek(anyDayInWeek);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${dateFmt.format(start)} – ${dateFmtFull.format(end)}`;
}

export async function computeKpis(clientToken: string): Promise<Kpis> {
  const leads = await listLeads(clientToken);
  const weekStart = startOfIsoWeek(new Date());

  // An outreach only counts once it has actually been sent this week.
  const outreachesThisWeek = leads.filter(
    (l) => l.status === "sent" && new Date(l.updated_at) >= weekStart,
  ).length;
  const outreachesThisWeekDm = leads.filter(
    (l) => l.dm_sent_at && new Date(l.dm_sent_at) >= weekStart,
  ).length;
  const outreachesThisWeekEmail = leads.filter(
    (l) => l.email_sent_at && new Date(l.email_sent_at) >= weekStart,
  ).length;

  // Response rate is measured over leads that actually left the building.
  const sentLike = leads.filter((l) =>
    ["sent", "replied", "call_booked"].includes(l.status),
  ).length;
  const responded = leads.filter((l) =>
    ["replied", "call_booked"].includes(l.status),
  ).length;
  const responseRate = sentLike === 0 ? 0 : responded / sentLike;

  const callsBooked = leads.filter((l) => l.status === "call_booked").length;
  // "new" and re-surfaced "revised" leads both await a (re-)approval.
  const pendingApproval = leads.filter(
    (l) => l.status === "new" || l.status === "revised",
  ).length;
  const dmBlocked = leads.filter((l) => l.dm_blocked_at).length;

  return {
    outreachesThisWeek,
    outreachesThisWeekDm,
    outreachesThisWeekEmail,
    responseRate,
    callsBooked,
    totalLeads: leads.length,
    pendingApproval,
    dmBlocked,
  };
}

export async function weeklyReport(
  clientToken: string,
): Promise<WeekReportRow[]> {
  const leads = await listLeads(clientToken);
  const byWeek = new Map<string, { sample: Date; rows: Lead[] }>();

  for (const lead of leads) {
    const created = new Date(lead.created_at);
    const key = isoWeekKey(created);
    const bucket = byWeek.get(key);
    if (bucket) {
      bucket.rows.push(lead);
    } else {
      byWeek.set(key, { sample: created, rows: [lead] });
    }
  }

  const rows: WeekReportRow[] = [...byWeek.entries()].map(([week, bucket]) => {
    const count = (status: LeadStatus) =>
      bucket.rows.filter((l) => l.status === status).length;
    return {
      week,
      weekLabel: weekLabel(bucket.sample),
      total: bucket.rows.length,
      approved: count("approved"),
      // "sent" in the report means "left the building": sent + replied + calls.
      sent: count("sent") + count("replied") + count("call_booked"),
      dmSent: bucket.rows.filter((l) => l.dm_sent_at).length,
      emailSent: bucket.rows.filter((l) => l.email_sent_at).length,
      dmBlocked: bucket.rows.filter((l) => l.dm_blocked_at).length,
      replied: count("replied") + count("call_booked"),
      callsBooked: count("call_booked"),
    };
  });

  // Most recent week first.
  rows.sort((a, b) => (a.week < b.week ? 1 : -1));
  return rows;
}

export function isValidStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && STATUS_ORDER.includes(value as LeadStatus);
}
