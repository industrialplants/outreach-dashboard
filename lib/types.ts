// Shared domain types for the industrial plants outreach dashboard.

export type LeadStatus =
  | "new"
  | "revised"
  | "approved"
  | "rejected"
  | "sent"
  | "replied"
  | "call_booked";

// German labels shown in the UI, in the funnel order the user specified.
export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Neu",
  revised: "Überarbeitet",
  approved: "Freigegeben",
  rejected: "Abgelehnt",
  sent: "Gesendet",
  replied: "Geantwortet",
  call_booked: "Call gebucht",
};

export const STATUS_ORDER: LeadStatus[] = [
  "new",
  "revised",
  "approved",
  "rejected",
  "sent",
  "replied",
  "call_booked",
];

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
  dm_sent_at: string; // ISO 8601, empty string = not yet sent via LinkedIn DM
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
}

export interface WeekReportRow {
  week: string; // e.g. "2026-W27"
  weekLabel: string; // e.g. "30. Jun – 6. Jul 2026"
  total: number;
  approved: number;
  sent: number;
  dmSent: number;
  emailSent: number;
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
}
