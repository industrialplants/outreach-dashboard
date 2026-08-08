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
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

export interface Client {
  token: string;
  name: string;
}

// A client enriched with its lead count, for the admin "Kunden" tab.
export interface ClientWithCount extends Client {
  leadCount: number;
}

export interface Kpis {
  outreachesThisWeek: number;
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
