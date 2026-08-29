// Shared domain types for the industrial plants outreach dashboard.

export type LeadStatus =
  | "new"
  | "revised"
  | "approved"
  | "rejected"
  | "sent"
  | "replied"
  | "call_booked"
  | "dnd";

// German labels shown in the UI, in the funnel order the user specified.
export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Neu",
  revised: "Überarbeitet",
  approved: "Freigegeben",
  rejected: "Abgelehnt",
  sent: "Gesendet",
  replied: "Geantwortet",
  call_booked: "Call gebucht",
  dnd: "Absage / DND",
};

export const STATUS_ORDER: LeadStatus[] = [
  "new",
  "revised",
  "approved",
  "rejected",
  "sent",
  "replied",
  "call_booked",
  "dnd",
];

// Which channel(s) a lead is actually meant to be contacted through. Set by
// Clay depending on which target-group table/campaign the row came from.
// "both" is also the default for all pre-existing leads (no prior campaign
// segmentation existed, so nothing should suddenly become restricted).
export type LeadChannel = "linkedin" | "email" | "both";

export interface Lead {
  id: number;
  client_token: string;
  name: string;
  company: string;
  title: string;
  linkedin_url: string;
  email: string;
  generated_message: string;
  email_subject: string;
  email_body: string;
  research_summary: string;
  signal: string;
  status: LeadStatus;
  comment: string;
  channel: LeadChannel; // which channel(s) this lead is meant to be contacted through
  // Free-text campaign label (e.g. "CEO", "HR") — fully independent of
  // channel. Added 19.08.2026 because two campaigns happened to correlate
  // with channel (CEO=both, HR=linkedin-only) at first, which made the
  // overall "Alle Kanäle" view confusing once that correlation mattered
  // less than which actual campaign a lead belonged to.
  campaign: string;
  send_paused_at: string; // ISO 8601, non-empty = emergency stop is active — blocks all sending
  // Separate, independent approval per channel — approving one never implies
  // the other. Cleared automatically the moment the corresponding text
  // changes (edit, accept, or revert), so an approval always matches the
  // exact text it was granted for. Decided 18.08.2026 after an email went
  // out that had only ever been reviewed on the LinkedIn side.
  linkedin_approved_at: string;
  email_approved_at: string;
  dm_sent_at: string; // ISO 8601, empty string = not yet sent via LinkedIn DM
  dm_blocked_at: string; // technically impossible to DM (not connected, no InMail, etc.)
  email_sent_at: string; // ISO 8601, empty string = not yet sent via email
  // Customer-edit tracking: when a client edits a field, its pre-edit value
  // is snapshotted here so the diff can be shown until an admin accepts or
  // reverts it. Empty string = no pending edit captured for that field.
  generated_message_original: string;
  email_subject_original: string;
  email_body_original: string;
  // Comma-separated subset of "generated_message,email_subject,email_body" —
  // which fields currently have an unreviewed customer edit.
  pending_edit_fields: string;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

export interface Client {
  token: string;
  name: string;
  username: string; // empty string = no login set up yet
  hasLogin: boolean; // username AND password are both set
}

// A client enriched with its lead count, for the admin "Kunden" tab.
export interface ClientWithCount extends Client {
  leadCount: number;
}

export interface Kpis {
  outreachesThisWeek: number;
  outreachesThisWeekDm: number;
  outreachesThisWeekEmail: number;
  responseRate: number; // 0..1
  callsBooked: number;
  totalLeads: number;
  pendingApproval: number;
  dmBlocked: number;
}

export interface WeekReportRow {
  week: string; // e.g. "2026-W27"
  weekLabel: string; // e.g. "30. Jun – 6. Jul 2026"
  total: number;
  approved: number;
  sent: number;
  dmSent: number;
  emailSent: number;
  dmBlocked: number;
  replied: number;
  callsBooked: number;
}

// Shape of the payload Clay POSTs to /api/webhook.
export interface WebhookPayload {
  name?: string;
  company?: string;
  title?: string;
  linkedin_url?: string;
  email?: string;
  generated_message?: string;
  email_subject?: string;
  email_body?: string;
  research_summary?: string;
  signal?: string;
  client_token?: string;
  channel?: string; // "linkedin" | "email" | "both" — defaults to "both" if omitted/unrecognized
  campaign?: string; // free-text campaign label, e.g. "CEO", "HR"
}
