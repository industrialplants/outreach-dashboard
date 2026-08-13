import type { Row } from "@libsql/client";
import { getDb } from "./db";
import { hashPassword, verifyPassword } from "./auth";
import type {
  Client,
  ClientWithCount,
  Kpis,
  Lead,
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
    dm_sent_at: String(r.dm_sent_at),
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

// Leads that are approved, have an email drafted, and haven't been sent by
// email yet — the queue for the automated Microsoft Graph send job.
// The pending_edit_fields check below is now mostly a defensive backstop:
// since 13.08.2026, approving a lead (status='approved') auto-clears any
// pending customer-edit marker (decided with the client — "Freigeben" alone
// is the trust signal now, no separate manual review step). This condition
// should therefore rarely if ever exclude anything in practice.
export async function listSendableEmails(
  clientToken: string,
  limit: number,
): Promise<Lead[]> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT * FROM leads
           WHERE client_token = ?
             AND status = 'approved'
             AND email_sent_at = ''
             AND trim(email_body) <> ''
             AND trim(email) <> ''
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

export async function createLead(payload: WebhookPayload): Promise<Lead> {
  const db = await getDb();
  const now = new Date().toISOString();
  const token = payload.client_token!.trim();
  const info = await db.execute({
    sql: `INSERT INTO leads (
        client_token, name, company, title, linkedin_url, email,
        generated_message, email_subject, email_body, research_summary, signal, status, comment,
        created_at, updated_at
      ) VALUES (
        $client_token, $name, $company, $title, $linkedin_url, $email,
        $generated_message, $email_subject, $email_body, $research_summary, $signal, 'new', '',
        $created_at, $updated_at
      )`,
    args: {
      client_token: token,
      name: payload.name ?? "",
      company: payload.company ?? "",
      title: payload.title ?? "",
      linkedin_url: payload.linkedin_url ?? "",
      email: payload.email ?? "",
      generated_message: payload.generated_message ?? "",
      email_subject: payload.email_subject ?? "",
      email_body: payload.email_body ?? "",
      research_summary: payload.research_summary ?? "",
      signal: payload.signal ?? "",
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
export async function upsertLead(payload: WebhookPayload): Promise<Lead> {
  const token = payload.client_token!.trim();
  const linkedin = payload.linkedin_url?.trim();

  if (!linkedin) return createLead(payload);

  const db = await getDb();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO leads (
        client_token, name, company, title, linkedin_url, email,
        generated_message, email_subject, email_body, research_summary, signal, status, comment,
        created_at, updated_at
      ) VALUES (
        $client_token, $name, $company, $title, $linkedin_url, $email,
        $generated_message, $email_subject, $email_body, $research_summary, $signal, 'new', '',
        $created_at, $updated_at
      )
      ON CONFLICT(client_token, linkedin_url) WHERE linkedin_url <> ''
      DO UPDATE SET
        generated_message = excluded.generated_message,
        email_subject     = excluded.email_subject,
        email_body        = excluded.email_body,
        signal            = excluded.signal,
        research_summary  = excluded.research_summary,
        title             = excluded.title,
        -- A re-send of an already-reviewed lead flags it as revised so it
        -- resurfaces for another look; untouched 'new' leads stay 'new'.
        status            = CASE WHEN leads.status = 'new'
                                 THEN 'new' ELSE 'revised' END,
        updated_at        = excluded.updated_at`,
    args: {
      client_token: token,
      name: payload.name ?? "",
      company: payload.company ?? "",
      title: payload.title ?? "",
      linkedin_url: linkedin,
      email: payload.email ?? "",
      generated_message: payload.generated_message ?? "",
      email_subject: payload.email_subject ?? "",
      email_body: payload.email_body ?? "",
      research_summary: payload.research_summary ?? "",
      signal: payload.signal ?? "",
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
    // Whether this update comes from the agency admin or from the client
    // themself — decides whether an edit is tracked as a pending customer
    // change (client) or treated as final/reviewed (admin).
    isAdminEdit?: boolean;
    // Admin-only actions on fields that currently have a pending customer
    // edit: keep the customer's text but clear the "needs review" marker, or
    // throw it away and restore the AI-generated original.
    acceptFields?: string[];
    revertFields?: string[];
  },
): Promise<Lead | undefined> {
  const existing = await getLead(id);
  if (!existing) return undefined;

  const status = changes.status ?? existing.status;
  const comment =
    changes.comment !== undefined ? changes.comment : existing.comment;
  const dm_sent_at =
    changes.dm_sent_at !== undefined ? changes.dm_sent_at : existing.dm_sent_at;
  const email_sent_at =
    changes.email_sent_at !== undefined
      ? changes.email_sent_at
      : existing.email_sent_at;

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

  // Decided with the client (13.08.2026): clicking "Freigeben" is itself the
  // trust signal, whoever clicks it — no separate manual "Übernehmen" gate.
  // Approving a lead auto-clears any still-pending edit markers on it.
  if (changes.status === "approved") {
    for (const field of TRACKED_FIELDS) {
      original[field] = "";
      pending.delete(field);
    }
  }

  const db = await getDb();
  await db.execute({
    sql: `UPDATE leads SET
            status = ?, comment = ?,
            generated_message = ?, email_subject = ?, email_body = ?,
            generated_message_original = ?, email_subject_original = ?, email_body_original = ?,
            pending_edit_fields = ?,
            dm_sent_at = ?, email_sent_at = ?,
            updated_at = ?
          WHERE id = ?`,
    args: [
      status,
      comment,
      current.generated_message,
      current.email_subject,
      current.email_body,
      original.generated_message,
      original.email_subject,
      original.email_body,
      [...pending].join(","),
      dm_sent_at,
      email_sent_at,
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

  return {
    outreachesThisWeek,
    outreachesThisWeekDm,
    outreachesThisWeekEmail,
    responseRate,
    callsBooked,
    totalLeads: leads.length,
    pendingApproval,
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
