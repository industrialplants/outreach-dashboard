import type { Row } from "@libsql/client";
import { getDb } from "./db";
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
  return { token: String(r.token), name: String(r.name) };
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
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

// ---------- Clients ----------

export async function listClients(): Promise<Client[]> {
  const db = await getDb();
  const rs = await db.execute("SELECT token, name FROM clients ORDER BY name");
  return rs.rows.map(mapClient);
}

export async function getClient(token: string): Promise<Client | undefined> {
  const db = await getDb();
  const rs = await db.execute({
    sql: "SELECT token, name FROM clients WHERE token = ?",
    args: [token],
  });
  return rs.rows[0] ? mapClient(rs.rows[0]) : undefined;
}

// Clients plus their lead count, for the admin "Kunden" tab.
export async function listClientsWithCounts(): Promise<ClientWithCount[]> {
  const db = await getDb();
  const rs = await db.execute(
    `SELECT c.token AS token, c.name AS name,
            COUNT(l.id) AS leadCount
       FROM clients c
       LEFT JOIN leads l ON l.client_token = c.token
      GROUP BY c.token, c.name
      ORDER BY c.name`,
  );
  return rs.rows.map((r) => ({
    token: String(r.token),
    name: String(r.name),
    leadCount: Number(r.leadCount),
  }));
}

// Create a new client. Returns undefined if the token is already taken.
export async function createClient(
  token: string,
  name: string,
): Promise<Client | undefined> {
  if (await getClient(token)) return undefined;
  const db = await getDb();
  await db.execute({
    sql: "INSERT INTO clients (token, name) VALUES (?, ?)",
    args: [token, name],
  });
  return { token, name };
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
  return { token, name };
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

export async function updateLead(
  id: number,
  changes: {
    status?: LeadStatus;
    comment?: string;
    generated_message?: string;
    dm_sent_at?: string;
    email_sent_at?: string;
  },
): Promise<Lead | undefined> {
  const existing = await getLead(id);
  if (!existing) return undefined;

  const status = changes.status ?? existing.status;
  const comment =
    changes.comment !== undefined ? changes.comment : existing.comment;
  const generated_message =
    changes.generated_message !== undefined ? changes.generated_message : existing.generated_message;
  // Channel-sent timestamps only ever move forward (get set once), so an
  // update that doesn't mention them must leave the existing value alone.
  const dm_sent_at =
    changes.dm_sent_at !== undefined ? changes.dm_sent_at : existing.dm_sent_at;
  const email_sent_at =
    changes.email_sent_at !== undefined
      ? changes.email_sent_at
      : existing.email_sent_at;

  const db = await getDb();
  await db.execute({
    sql: "UPDATE leads SET status = ?, comment = ?, generated_message = ?, dm_sent_at = ?, email_sent_at = ?, updated_at = ? WHERE id = ?",
    args: [
      status,
      comment,
      generated_message,
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
