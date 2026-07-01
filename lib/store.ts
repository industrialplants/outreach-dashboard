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

// ---------- Clients ----------

export function listClients(): Client[] {
  return getDb()
    .prepare("SELECT token, name FROM clients ORDER BY name")
    .all() as Client[];
}

export function getClient(token: string): Client | undefined {
  return getDb()
    .prepare("SELECT token, name FROM clients WHERE token = ?")
    .get(token) as Client | undefined;
}

// Clients plus their lead count, for the admin "Kunden" tab.
export function listClientsWithCounts(): ClientWithCount[] {
  return getDb()
    .prepare(
      `SELECT c.token AS token, c.name AS name,
              COUNT(l.id) AS leadCount
         FROM clients c
         LEFT JOIN leads l ON l.client_token = c.token
        GROUP BY c.token, c.name
        ORDER BY c.name`,
    )
    .all() as ClientWithCount[];
}

// Create a new client. Returns undefined if the token is already taken.
export function createClient(token: string, name: string): Client | undefined {
  if (getClient(token)) return undefined;
  getDb()
    .prepare("INSERT INTO clients (token, name) VALUES (?, ?)")
    .run(token, name);
  return { token, name };
}

// Delete a client together with all of its leads. Returns false if unknown.
export function deleteClient(token: string): boolean {
  const db = getDb();
  if (!getClient(token)) return false;
  const tx = db.transaction((t: string) => {
    db.prepare("DELETE FROM leads WHERE client_token = ?").run(t);
    db.prepare("DELETE FROM clients WHERE token = ?").run(t);
  });
  tx(token);
  return true;
}

// Auto-register a client the first time Clay sends a lead with an unknown token.
export function ensureClient(token: string, fallbackName?: string): Client {
  const existing = getClient(token);
  if (existing) return existing;
  const name = fallbackName?.trim() || token;
  getDb()
    .prepare("INSERT INTO clients (token, name) VALUES (?, ?)")
    .run(token, name);
  return { token, name };
}

// ---------- Leads ----------

export function listLeads(clientToken: string): Lead[] {
  return getDb()
    .prepare(
      "SELECT * FROM leads WHERE client_token = ? ORDER BY datetime(created_at) DESC",
    )
    .all(clientToken) as Lead[];
}

export function createLead(payload: WebhookPayload): Lead {
  const now = new Date().toISOString();
  const token = payload.client_token!.trim();
  const info = getDb()
    .prepare(
      `INSERT INTO leads (
        client_token, name, company, title, linkedin_url, email,
        generated_message, research_summary, signal, status, comment,
        created_at, updated_at
      ) VALUES (
        @client_token, @name, @company, @title, @linkedin_url, @email,
        @generated_message, @research_summary, @signal, 'new', '',
        @created_at, @updated_at
      )`,
    )
    .run({
      client_token: token,
      name: payload.name ?? "",
      company: payload.company ?? "",
      title: payload.title ?? "",
      linkedin_url: payload.linkedin_url ?? "",
      email: payload.email ?? "",
      generated_message: payload.generated_message ?? "",
      research_summary: payload.research_summary ?? "",
      signal: payload.signal ?? "",
      created_at: now,
      updated_at: now,
    });
  return getDb()
    .prepare("SELECT * FROM leads WHERE id = ?")
    .get(info.lastInsertRowid) as Lead;
}

export function updateLead(
  id: number,
  changes: { status?: LeadStatus; comment?: string },
): Lead | undefined {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as
    | Lead
    | undefined;
  if (!existing) return undefined;

  const status = changes.status ?? existing.status;
  const comment =
    changes.comment !== undefined ? changes.comment : existing.comment;

  db.prepare(
    "UPDATE leads SET status = ?, comment = ?, updated_at = ? WHERE id = ?",
  ).run(status, comment, new Date().toISOString(), id);

  return db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Lead;
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

export function computeKpis(clientToken: string): Kpis {
  const leads = listLeads(clientToken);
  const weekStart = startOfIsoWeek(new Date());

  const outreachesThisWeek = leads.filter(
    (l) => new Date(l.created_at) >= weekStart,
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
  const pendingApproval = leads.filter((l) => l.status === "new").length;

  return {
    outreachesThisWeek,
    responseRate,
    callsBooked,
    totalLeads: leads.length,
    pendingApproval,
  };
}

export function weeklyReport(clientToken: string): WeekReportRow[] {
  const leads = listLeads(clientToken);
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
