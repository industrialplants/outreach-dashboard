"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import type {
  Client,
  ClientWithCount,
  Kpis,
  Lead,
  LeadStatus,
  WeekReportRow,
} from "@/lib/types";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/types";
import { wordDiff } from "@/lib/diff";

interface DashboardProps {
  role: "admin" | "client";
  adminToken: string | null;
  clients: Client[];
  selected: Client | null;
  leads: Lead[];
  kpis: Kpis | null;
  report: WeekReportRow[];
}

type Tab = "leads" | "report" | "clients";

// Sub-filter inside the Leads tab. "all" is the main view and hides
// call_booked leads — those live only under their own filter.
type LeadFilter =
  | "all"
  | "new"
  | "revised"
  | "approved"
  | "sent"
  | "rejected"
  | "call_booked"
  | "dnd";

// e.g. "18.08. 14:32" — German date/time, Berlin timezone, no year (recent
// enough that omitting it keeps buttons/labels short and readable).
function formatDe(iso: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

const LEAD_FILTERS: { key: LeadFilter; label: string }[] = [
  { key: "all", label: "Alle" },
  { key: "new", label: "Neu" },
  { key: "revised", label: "Überarbeitet" },
  { key: "approved", label: "Freigegeben" },
  { key: "sent", label: "Gesendet" },
  { key: "rejected", label: "Abgelehnt" },
  { key: "call_booked", label: "Call gebucht" },
  { key: "dnd", label: "Absage / DND" },
];

function matchesFilter(lead: Lead, filter: LeadFilter): boolean {
  // Main view shows everything except booked calls and DND/Absage leads —
  // both are "done, nothing more to do here" states that would just clutter it.
  if (filter === "all") return lead.status !== "call_booked" && lead.status !== "dnd";
  return lead.status === filter;
}

type ChannelFilter =
  | "all"
  | "linkedin"
  | "email"
  | "email_pending"
  | "nothing_sent"
  | "partial_sent"
  | "dm_blocked";

const CHANNEL_FILTERS: { key: ChannelFilter; label: string; adminOnly?: boolean }[] = [
  { key: "all", label: "Alle Kanäle" },
  { key: "linkedin", label: "💬 LinkedIn" },
  { key: "email", label: "📧 E-Mail" },
  { key: "email_pending", label: "📧 E-Mail ausstehend" },
  { key: "nothing_sent", label: "🗑 Nichts gesendet", adminOnly: true },
  { key: "partial_sent", label: "✏️ Nur Mail fehlt", adminOnly: true },
  { key: "dm_blocked", label: "🚫 DM nicht möglich", adminOnly: true },
];

function matchesChannelFilter(lead: Lead, filter: ChannelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "linkedin") return lead.channel === "linkedin" || lead.channel === "both";
  if (filter === "email") return lead.channel === "email" || lead.channel === "both";
  if (filter === "email_pending") {
    // "E-Mail ausstehend": needs an email (channel allows it), hasn't gotten
    // one yet — regardless of the overall status label, which can be stale
    // for leads marked "Gesendet" under the old single-channel-status logic.
    return (
      (lead.channel === "email" || lead.channel === "both") &&
      !lead.email_sent_at &&
      lead.status !== "rejected" &&
      lead.status !== "dnd"
    );
  }
  if (filter === "nothing_sent") {
    // Safe-to-delete-and-regenerate cleanup filter (19.08.2026): neither
    // channel has actually gone out yet, so deleting and letting Clay
    // re-run with the fixed prompt loses nothing.
    return (
      !lead.dm_sent_at &&
      !lead.email_sent_at &&
      !lead.dm_blocked_at &&
      lead.status !== "rejected" &&
      lead.status !== "dnd"
    );
  }
  // "partial_sent": only meaningful for both-channel leads — one side
  // already went out (almost always the DM), the other hasn't. This
  // history must be preserved, never deleted. Only the still-missing side
  // needs a manual rewrite via "Bearbeiten". A single-channel lead is either
  // fully done or fully not-done, never "partial", so it's excluded here.
  if (filter === "partial_sent") {
    return (
      lead.channel === "both" &&
      (!!lead.dm_sent_at || !!lead.dm_blocked_at) !== !!lead.email_sent_at &&
      lead.status !== "rejected" &&
      lead.status !== "dnd"
    );
  }
  // "dm_blocked": everyone flagged as technically unreachable via LinkedIn —
  // lets you cross-check against "Nichts gesendet" before bulk-deleting, so
  // a lead you already know can't be DM'd never gets swept up for a
  // pointless LinkedIn regeneration.
  return !!lead.dm_blocked_at;
}

export default function Dashboard({
  role,
  adminToken,
  clients,
  selected,
  leads,
  kpis,
  report,
}: DashboardProps) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("leads");
  const [leadFilter, setLeadFilter] = useState<LeadFilter>("all");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [campaignFilter, setCampaignFilter] = useState<string>("");
  const [listOpen, setListOpen] = useState(false);
  const [listCopied, setListCopied] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<
    { active: boolean; leads: { id: number; name: string; company: string; email: string }[] } | null
  >(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editMessage, setEditMessage] = useState("");

  // Token used to authorize mutations against the API.
  const authToken = role === "admin" ? adminToken! : selected!.token;

  function switchClient(clientToken: string) {
    router.push(`/?token=${encodeURIComponent(adminToken!)}&client=${encodeURIComponent(clientToken)}`);
  }

  async function togglePreview() {
    if (previewOpen) {
      setPreviewOpen(false);
      return;
    }
    setPreviewOpen(true);
    setPreviewLoading(true);
    try {
      const params = new URLSearchParams({ token: authToken });
      if (role === "admin" && selected) params.set("client", selected.token);
      const res = await fetch(`/api/send-preview?${params.toString()}`);
      const data = await res.json();
      setPreviewData(data);
    } catch {
      setPreviewData({ active: false, leads: [] });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function mutate(
    id: number,
    changes: {
      status?: LeadStatus;
      comment?: string;
      generated_message?: string;
      email_subject?: string;
      email_body?: string;
      accept_fields?: string[];
      revert_fields?: string[];
      dm_sent_at?: string;
      email_sent_at?: string;
      dm_blocked_at?: string;
      channel?: string;
      email?: string;
      campaign?: string;
      paused?: boolean;
      approve_channel?: "linkedin" | "email";
    },
  ) {
    const res = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...changes, token: authToken }),
    });
    if (!res.ok) {
      alert("Aktion fehlgeschlagen. Bitte erneut versuchen.");
      return;
    }
    // Re-run the server component so KPIs, report and list stay in sync.
    startTransition(() => router.refresh());
  }

  async function removeLead(id: number) {
    const res = await fetch(`/api/leads/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: authToken }),
    });
    if (!res.ok) {
      alert("Löschen fehlgeschlagen. Bitte erneut versuchen.");
      return;
    }
    startTransition(() => router.refresh());
  }

  const noBoard = role === "admin" && !selected;

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <Image
            className="brand-logo"
            src="/logo.png"
            alt="industrial plants Logo"
            width={32}
            height={32}
            priority
          />
          <span className="brand-name">industrial plants</span>
          {role === "admin" && <span className="admin-badge">Admin</span>}
        </div>

        <div className="topbar-right">
          {isPending && <span className="syncing">aktualisiere…</span>}
          {role === "admin" ? (
            <>
              <label className="client-switch">
                <span>Kunde</span>
                <select
                  value={selected?.token ?? ""}
                  onChange={(e) => switchClient(e.target.value)}
                  disabled={clients.length === 0}
                >
                  {clients.length === 0 && <option value="">Keine Kunden</option>}
                  {clients.map((c) => (
                    <option key={c.token} value={c.token}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn ghost small"
                onClick={async () => {
                  await fetch("/api/logout", { method: "POST" });
                  router.push("/");
                  router.refresh();
                }}
              >
                Abmelden
              </button>
            </>
          ) : (
            <>
              <span className="client-name">{selected?.name}</span>
              <button
                className="btn ghost small"
                onClick={async () => {
                  await fetch("/api/logout", { method: "POST" });
                  router.push("/");
                  router.refresh();
                }}
              >
                Abmelden
              </button>
            </>
          )}
        </div>
      </header>

      <nav className="tabs">
        <button
          className={tab === "leads" ? "tab active" : "tab"}
          onClick={() => setTab("leads")}
        >
          Leads
        </button>
        <button
          className={tab === "report" ? "tab active" : "tab"}
          onClick={() => setTab("report")}
        >
          Wochenreport
        </button>
        {role === "admin" && (
          <button
            className={tab === "clients" ? "tab active" : "tab"}
            onClick={() => setTab("clients")}
          >
            Kunden
          </button>
        )}
      </nav>

      {tab === "clients" && role === "admin" ? (
        <ClientsPanel adminToken={adminToken!} selectedClientToken={selected?.token ?? null} />
      ) : noBoard ? (
        <section className="empty big">
          <p>Noch keine Kunden angelegt.</p>
          <p className="muted">
            Lege links im Tab „Kunden“ einen Kunden an — oder sobald Clay Leads
            an den Webhook sendet, erscheinen hier die Kunden-Boards.
          </p>
        </section>
      ) : tab === "leads" ? (
        <>
          <div className="send-preview">
            <button className="btn ghost small" onClick={togglePreview}>
              {previewOpen
                ? "Vorschau ausblenden ▲"
                : "📬 Wer bekommt als Nächstes eine E-Mail? ▼"}
            </button>
            {previewOpen && (
              <div className="send-preview-body">
                {previewLoading ? (
                  <p className="muted">Lädt…</p>
                ) : !previewData?.active ? (
                  <p className="muted">
                    Automatischer E-Mail-Versand ist für dieses Board aktuell
                    nicht aktiv.
                  </p>
                ) : previewData.leads.length === 0 ? (
                  <p className="muted">
                    Aktuell steht niemand in der Warteschlange für den
                    nächsten automatischen Versand.
                  </p>
                ) : (
                  <>
                    <p className="muted" style={{ margin: "0 0 8px" }}>
                      Diese {previewData.leads.length} bekommen beim nächsten
                      Durchlauf als Erstes eine E-Mail (älteste zuerst):
                    </p>
                    <ul className="send-preview-list">
                      {previewData.leads.map((l) => (
                        <li key={l.id}>
                          <strong>{l.name}</strong>
                          {l.company && <> — {l.company}</>}
                          {" "}
                          <span className="muted">{l.email}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
          {kpis && <KpiRow kpis={kpis} />}
          {(() => {
            const campaigns = Array.from(
              new Set(leads.map((l) => l.campaign).filter(Boolean)),
            ).sort();
            if (campaigns.length === 0) return null;
            return (
              <nav className="channel-filters campaign-filters">
                <button
                  className={campaignFilter === "" ? "filter-chip active" : "filter-chip"}
                  onClick={() => setCampaignFilter("")}
                >
                  Alle Kampagnen
                  <span className="filter-count">{leads.length}</span>
                </button>
                {campaigns.map((c) => (
                  <button
                    key={c}
                    className={campaignFilter === c ? "filter-chip active" : "filter-chip"}
                    onClick={() => setCampaignFilter(c)}
                  >
                    🏷 {c}
                    <span className="filter-count">
                      {leads.filter((l) => l.campaign === c).length}
                    </span>
                  </button>
                ))}
              </nav>
            );
          })()}
          <nav className="channel-filters">
            {CHANNEL_FILTERS.filter((f) => !f.adminOnly || role === "admin").map((f) => {
              const count = leads.filter(
                (l) =>
                  (campaignFilter === "" || l.campaign === campaignFilter) &&
                  matchesChannelFilter(l, f.key),
              ).length;
              return (
                <button
                  key={f.key}
                  className={
                    channelFilter === f.key ? "filter-chip channel active" : "filter-chip channel"
                  }
                  onClick={() => setChannelFilter(f.key)}
                >
                  {f.label}
                  <span className="filter-count">{count}</span>
                </button>
              );
            })}
          </nav>
          <nav className="lead-filters">
            {LEAD_FILTERS.map((f) => {
              const count = leads.filter(
                (l) =>
                  (campaignFilter === "" || l.campaign === campaignFilter) &&
                  matchesChannelFilter(l, channelFilter) &&
                  matchesFilter(l, f.key),
              ).length;
              return (
                <button
                  key={f.key}
                  className={
                    leadFilter === f.key ? "filter-chip active" : "filter-chip"
                  }
                  onClick={() => setLeadFilter(f.key)}
                >
                  {f.label}
                  <span className="filter-count">{count}</span>
                </button>
              );
            })}
          </nav>
          {(() => {
            const filteredLeads = leads.filter(
              (l) =>
                (campaignFilter === "" || l.campaign === campaignFilter) &&
                matchesChannelFilter(l, channelFilter) &&
                matchesFilter(l, leadFilter),
            );
            return (
              <>
                {role === "admin" &&
                  (channelFilter !== "all" || leadFilter !== "all" || campaignFilter !== "") && (
                  <div className="list-export">
                    <button
                      className="btn ghost small"
                      onClick={() => {
                        setListOpen((v) => !v);
                        setListCopied(false);
                      }}
                    >
                      {listOpen ? "Liste ausblenden ▲" : `📋 Liste anzeigen (${filteredLeads.length})`}
                    </button>
                    {listOpen && (
                      <div className="list-export-body">
                        <pre>
                          {filteredLeads
                            .map((l) => `${l.name}${l.company ? ` — ${l.company}` : ""}`)
                            .join("\n")}
                        </pre>
                        <button
                          className="btn small"
                          onClick={() => {
                            const text = filteredLeads
                              .map((l) => `${l.name}${l.company ? ` — ${l.company}` : ""}`)
                              .join("\n");
                            navigator.clipboard.writeText(text);
                            setListCopied(true);
                          }}
                        >
                          {listCopied ? "✓ Kopiert" : "Kopieren"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <LeadList
                  leads={filteredLeads}
                  onMutate={mutate}
                  onDelete={role === "admin" ? removeLead : undefined}
                  isAdmin={role === "admin"}
                  adminToken={role === "admin" ? adminToken : null}
                  filtered={leadFilter !== "all" || channelFilter !== "all" || campaignFilter !== ""}
                />
              </>
            );
          })()}
        </>
      ) : (
        <ReportTable report={report} />
      )}
    </main>
  );
}



function KpiRow({ kpis }: { kpis: Kpis }) {
  const cards = [
    {
      label: "Outreaches diese Woche",
      value: String(kpis.outreachesThisWeek),
      sub: `${kpis.outreachesThisWeekDm} DM · ${kpis.outreachesThisWeekEmail} E-Mail`,
    },
    {
      label: "Antwortrate",
      value: `${Math.round(kpis.responseRate * 100)}%`,
    },
    { label: "Gebuchte Calls", value: String(kpis.callsBooked) },
    { label: "Wartet auf Freigabe", value: String(kpis.pendingApproval) },
    ...(kpis.dmBlocked > 0
      ? [{ label: "DM nicht möglich", value: String(kpis.dmBlocked) }]
      : []),
  ];
  return (
    <section className="kpis">
      {cards.map((c) => (
        <div className="kpi" key={c.label}>
          <div className="kpi-value">{c.value}</div>
          <div className="kpi-label">{c.label}</div>
          {c.sub && <div className="kpi-sub">{c.sub}</div>}
        </div>
      ))}
    </section>
  );
}

function LeadList({
  leads,
  onMutate,
  onDelete,
  isAdmin,
  adminToken,
  filtered = false,
}: {
  leads: Lead[];
  onMutate: (
    id: number,
    changes: {
      status?: LeadStatus;
      comment?: string;
      generated_message?: string;
      email_subject?: string;
      email_body?: string;
      accept_fields?: string[];
      revert_fields?: string[];
      dm_sent_at?: string;
      email_sent_at?: string;
      dm_blocked_at?: string;
      channel?: string;
      email?: string;
      campaign?: string;
      paused?: boolean;
      approve_channel?: "linkedin" | "email";
    },
  ) => void;
  onDelete?: (id: number) => void;
  isAdmin: boolean;
  adminToken: string | null;
  filtered?: boolean;
}) {
  if (leads.length === 0) {
    return (
      <section className="empty">
        {filtered ? (
          <p>Keine Leads in diesem Filter.</p>
        ) : (
          <>
            <p>Noch keine Leads für dieses Board.</p>
            <p className="muted">
              Neue Leads von Clay erscheinen hier automatisch.
            </p>
          </>
        )}
      </section>
    );
  }
  return (
    <section className="leads">
      {leads.map((lead) => (
        <LeadCard
          key={lead.id}
          lead={lead}
          onMutate={onMutate}
          onDelete={onDelete}
          isAdmin={isAdmin}
          adminToken={adminToken}
        />
      ))}
    </section>
  );
}

// Renders text as-is, or — when a customer edit is pending review — as a
// Google-Docs-style diff: old wording struck through, new wording inserted.
// The word-diff view, used only inside the secondary "review" block below —
// never mixed into the primary text, so there's never any doubt about what
// the actual current (sendable) text is.
function DiffView({ current, original }: { current: string; original: string }) {
  const parts = wordDiff(original, current);
  return (
    <>
      {parts.map((part, i) => {
        if (part.type === "same") return <span key={i}>{part.text}</span>;
        if (part.type === "del") return <del key={i}>{part.text}</del>;
        return <ins key={i}>{part.text}</ins>;
      })}
    </>
  );
}

// Shown under a field that has an unreviewed customer edit. Clients just see
// a note; admins get a collapsed toggle (diff hidden by default, so the card
// never looks like it's showing two messages at once) plus review actions
// that work immediately without needing to expand anything first.
function PendingEditNote({
  fieldKey,
  current,
  original,
  isAdmin,
  onMutate,
  leadId,
}: {
  fieldKey: string;
  current: string;
  original: string;
  isAdmin: boolean;
  onMutate: (
    id: number,
    changes: { accept_fields?: string[]; revert_fields?: string[] },
  ) => void;
  leadId: number;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!isAdmin) {
    return (
      <div className="diff-note">
        ✏️ Von dir bearbeitet — dein industrial-plants-Team schaut nochmal drüber.
      </div>
    );
  }
  return (
    <div className="diff-note-wrap">
      <div className="diff-note-admin">
        <button
          type="button"
          className="btn ghost small"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Alte Nachricht ausblenden ▲" : "⏳ Vom Kunden bearbeitet — alte Nachricht ▼"}
        </button>
        <button
          className="btn small"
          onClick={() => onMutate(leadId, { accept_fields: [fieldKey] })}
        >
          Übernehmen
        </button>
        <button
          className="btn ghost small"
          onClick={() => onMutate(leadId, { revert_fields: [fieldKey] })}
        >
          Original wiederherstellen
        </button>
      </div>
      {expanded && (
        <div className="diff-review">
          <div className="diff-review-label">Vergleich zum KI-Original:</div>
          <p className="diff-review-text">
            <DiffView current={current} original={original} />
          </p>
        </div>
      )}
    </div>
  );
}

function LeadCard({
  lead,
  onMutate,
  onDelete,
  isAdmin,
  adminToken,
}: {
  lead: Lead;
  onMutate: (
    id: number,
    changes: {
      status?: LeadStatus;
      comment?: string;
      generated_message?: string;
      email_subject?: string;
      email_body?: string;
      accept_fields?: string[];
      revert_fields?: string[];
      dm_sent_at?: string;
      email_sent_at?: string;
      dm_blocked_at?: string;
      channel?: string;
      email?: string;
      campaign?: string;
      paused?: boolean;
      approve_channel?: "linkedin" | "email";
    },
  ) => void;
  onDelete?: (id: number) => void;
  isAdmin: boolean;
  adminToken: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState(lead.comment);
  const [isEditing, setIsEditing] = useState(false);
  const [editMessage, setEditMessage] = useState(lead.generated_message || "");
  const [editSubject, setEditSubject] = useState(lead.email_subject || "");
  const [editBody, setEditBody] = useState(lead.email_body || "");
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailValue, setEmailValue] = useState(lead.email || "");
  const [editingCampaign, setEditingCampaign] = useState(false);
  const [campaignValue, setCampaignValue] = useState(lead.campaign || "");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<
    { id: number; field: string; old_value: string; new_value: string; source: string; created_at: string }[]
  >([]);

  async function toggleHistory() {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const res = await fetch(
        `/api/leads/${lead.id}/history?token=${encodeURIComponent(adminToken ?? "")}`,
      );
      const data = await res.json();
      setHistoryEntries(data.history ?? []);
    } catch {
      setHistoryEntries([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  const pendingFields = new Set(
    lead.pending_edit_fields ? lead.pending_edit_fields.split(",") : [],
  );

  // Mirrors the channel setting, but never hides a channel that already has
  // real history (approved or sent) — narrowing the channel afterward must
  // not make an already-sent email disappear from view. Decided 18.08.2026
  // (reconsidered the same day: an earlier, stricter version hid sent
  // history too, which turned out to be the wrong tradeoff).
  const showLinkedIn =
    lead.channel === "linkedin" ||
    lead.channel === "both" ||
    !!lead.dm_sent_at ||
    !!lead.linkedin_approved_at;
  const showEmail =
    lead.channel === "email" ||
    lead.channel === "both" ||
    !!lead.email_sent_at ||
    !!lead.email_approved_at;

  return (
    <article className={lead.status === "dnd" ? "lead lead-dnd" : "lead"}>
      <div className="lead-head">
        <div className="lead-who">
          <div className="lead-name">{lead.name || "—"}</div>
          <div className="lead-sub">{lead.company || "—"}</div>
          {lead.title.trim() && lead.title.trim() !== "0" && (
            <div className="lead-title">{lead.title}</div>
          )}
        </div>
        <div className="lead-head-right">
          <span className={`status-pill status-${lead.status}`}>
            {STATUS_LABELS[lead.status]}
          </span>
          {isAdmin ? (
            <select
              className="status-pill channel-select"
              value={lead.channel}
              title="Kanal ändern — betrifft nur die Zuordnung, nicht den Text"
              onChange={(e) => onMutate(lead.id, { channel: e.target.value })}
            >
              <option value="both">Beide Kanäle</option>
              <option value="linkedin">💬 Nur LinkedIn</option>
              <option value="email">📧 Nur E-Mail</option>
            </select>
          ) : (
            lead.channel !== "both" && (
              <span
                className="status-pill channel-pill"
                title="Dieser Lead ist nur für diesen Kanal vorgesehen"
              >
                {lead.channel === "linkedin" ? "💬 Nur LinkedIn" : "📧 Nur E-Mail"}
              </span>
            )
          )}
          {isAdmin ? (
            editingCampaign ? (
              <span className="campaign-editor">
                <input
                  type="text"
                  value={campaignValue}
                  onChange={(e) => setCampaignValue(e.target.value)}
                  placeholder="z. B. CEO, HR"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onMutate(lead.id, { campaign: campaignValue.trim() });
                      setEditingCampaign(false);
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    onMutate(lead.id, { campaign: campaignValue.trim() });
                    setEditingCampaign(false);
                  }}
                >
                  ✓
                </button>
              </span>
            ) : (
              <span
                className="status-pill campaign-pill"
                onClick={() => setEditingCampaign(true)}
                title="Kampagne ändern"
                style={{ cursor: "pointer" }}
              >
                🏷 {lead.campaign || "Kampagne setzen"}
              </span>
            )
          ) : (
            lead.campaign && <span className="status-pill campaign-pill">🏷 {lead.campaign}</span>
          )}
          {isAdmin && pendingFields.size > 0 && (
            <span className="status-pill pending-review-pill" title="Kundenänderung wartet auf Review">
              ⏳ Review
            </span>
          )}
          <select
            className="status-select"
            value={lead.status}
            onChange={(e) =>
              onMutate(lead.id, { status: e.target.value as LeadStatus })
            }
            aria-label="Status ändern"
          >
            {STATUS_ORDER.filter((s) => s !== "approved").map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
            {lead.status === "approved" && (
              <option value="approved">{STATUS_LABELS.approved}</option>
            )}
          </select>
        </div>
      </div>

      {lead.signal && <div className="signal">⚡ {lead.signal}</div>}

      {lead.send_paused_at && (
        <div className="pause-banner">
          ⏸ Versand angehalten — es geht nichts raus, bis der Halt aufgehoben wird.
        </div>
      )}

      <div className="lead-actions">
        <button
          className={lead.send_paused_at ? "btn pause active" : "btn pause"}
          onClick={() => onMutate(lead.id, { paused: !lead.send_paused_at })}
        >
          {lead.send_paused_at ? "▶ Versand fortsetzen" : "⏸ Versand anhalten"}
        </button>
        {showLinkedIn && (
          <button
            className="btn approve"
            onClick={() => onMutate(lead.id, { approve_channel: "linkedin" })}
            disabled={!!lead.linkedin_approved_at || !!lead.send_paused_at}
            title="Gibt ausschließlich die LinkedIn-Nachricht frei — die E-Mail bleibt davon unberührt"
          >
            {lead.linkedin_approved_at
              ? `✓ LinkedIn freigegeben (${formatDe(lead.linkedin_approved_at)})`
              : "LinkedIn freigeben"}
          </button>
        )}
        {showEmail && (
          <button
            className="btn approve"
            onClick={() => onMutate(lead.id, { approve_channel: "email" })}
            disabled={!!lead.email_approved_at || !!lead.send_paused_at}
            title="Gibt ausschließlich die E-Mail frei — die LinkedIn-Nachricht bleibt davon unberührt"
          >
            {lead.email_approved_at
              ? `✓ E-Mail freigegeben (${formatDe(lead.email_approved_at)})`
              : "E-Mail freigeben"}
          </button>
        )}
        <button
          className="btn reject"
          onClick={() => onMutate(lead.id, { status: "rejected" })}
          disabled={lead.status === "rejected"}
        >
          Ablehnen
        </button>
        <button
          className="btn dnd"
          onClick={() => {
            if (
              window.confirm(
                `${lead.name} hat abgesagt / möchte keinen Kontakt mehr? Damit werden alle weiteren Nachrichten (DM & E-Mail) für diesen Lead dauerhaft gestoppt.`,
              )
            ) {
              onMutate(lead.id, { status: "dnd" });
            }
          }}
          disabled={lead.status === "dnd"}
        >
          {lead.status === "dnd" ? "✓ Absage / DND" : "Absage / DND"}
        </button>
        {lead.status !== "rejected" && lead.status !== "dnd" && (
          <>
            {showLinkedIn && (
              <>
                <button
                  className="btn sent"
                  onClick={() =>
                    onMutate(lead.id, {
                      dm_sent_at: new Date().toISOString(),
                    })
                  }
                  disabled={
                    !!lead.dm_sent_at ||
                    !!lead.dm_blocked_at ||
                    !!lead.send_paused_at ||
                    !lead.linkedin_approved_at
                  }
                  title={
                    !lead.linkedin_approved_at && !lead.dm_sent_at
                      ? "Erst 'LinkedIn freigeben' klicken"
                      : undefined
                  }
                >
                  {lead.dm_sent_at ? `✓ DM gesendet (${formatDe(lead.dm_sent_at)})` : "DM gesendet"}
                </button>
                <button
                  className={lead.dm_blocked_at ? "btn ghost active" : "btn ghost"}
                  onClick={() =>
                    onMutate(lead.id, {
                      dm_blocked_at: lead.dm_blocked_at ? "" : new Date().toISOString(),
                    })
                  }
                  disabled={!!lead.dm_sent_at}
                  title="DM technisch nicht möglich (nicht verbunden, kein InMail, Profil gesperrt o.ä.) — nicht dasselbe wie Absage/DND"
                >
                  {lead.dm_blocked_at
                    ? `✕ DM nicht möglich (${formatDe(lead.dm_blocked_at)})`
                    : "DM nicht möglich"}
                </button>
              </>
            )}
            {showEmail && (
              <button
                className="btn sent"
                onClick={() =>
                  onMutate(lead.id, {
                    email_sent_at: new Date().toISOString(),
                  })
                }
                disabled={
                  !!lead.email_sent_at || !!lead.send_paused_at || !lead.email_approved_at
                }
                title={
                  !lead.email_approved_at && !lead.email_sent_at
                    ? "Erst 'E-Mail freigeben' klicken"
                    : undefined
                }
              >
                {lead.email_sent_at ? `✓ E-Mail gesendet (${formatDe(lead.email_sent_at)})` : "E-Mail gesendet"}
              </button>
            )}
          </>
        )}
        <button className="btn ghost" onClick={() => setShowComment((v) => !v)}>
          Kommentar
        </button>
        <button className="btn ghost toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "Nachricht ▲" : "Nachricht ▼"}
        </button>
        <button
          className="btn ghost"
          onClick={() => {
            setIsEditing(true);
            setEditMessage(lead.generated_message || "");
            setEditSubject(lead.email_subject || "");
            setEditBody(lead.email_body || "");
          }}
        >
          Bearbeiten
        </button>
        {onDelete && (
          <button
            className="btn danger"
            onClick={() => {
              if (window.confirm("Wirklich löschen?")) onDelete(lead.id);
            }}
          >
            Löschen
          </button>
        )}
      </div>

      {isEditing && (
          <div className="comment-box edit-box">
            {showLinkedIn && (
              <label className="field">
                <span>LinkedIn-Nachricht</span>
                {pendingFields.has("generated_message") && (
                  <PendingEditNote
                    fieldKey="generated_message"
                    current={lead.generated_message}
                    original={lead.generated_message_original}
                    isAdmin={isAdmin}
                    onMutate={onMutate}
                    leadId={lead.id}
                  />
                )}
                <textarea
                  value={editMessage}
                  onChange={(e) => setEditMessage(e.target.value)}
                  rows={5}
                  style={{ width: "100%", resize: "vertical" }}
                />
              </label>
            )}
            {showEmail && (
              <>
                <label className="field">
                  <span>E-Mail-Betreff</span>
                  {pendingFields.has("email_subject") && (
                    <PendingEditNote
                      fieldKey="email_subject"
                      current={lead.email_subject}
                      original={lead.email_subject_original}
                      isAdmin={isAdmin}
                      onMutate={onMutate}
                      leadId={lead.id}
                    />
                  )}
                  <input
                    type="text"
                    value={editSubject}
                    onChange={(e) => setEditSubject(e.target.value)}
                    style={{ width: "100%" }}
                  />
                </label>
                <label className="field">
                  <span>E-Mail-Text</span>
                  {pendingFields.has("email_body") && (
                    <PendingEditNote
                      fieldKey="email_body"
                      current={lead.email_body}
                      original={lead.email_body_original}
                      isAdmin={isAdmin}
                      onMutate={onMutate}
                      leadId={lead.id}
                    />
                  )}
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={5}
                    style={{ width: "100%", resize: "vertical" }}
                  />
                </label>
              </>
            )}
            <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
              Speichern setzt den Status auf "Überarbeitet" zurück. Die
              Freigabe pro Kanal ist danach immer ein eigener, bewusster
              Klick in der Aktionsleiste — kein kombinierter Schritt mehr.
            </p>
            <div className="comment-actions">
              <button
                className="btn small"
                onClick={async () => {
                  const changes: {
                    generated_message?: string;
                    email_subject?: string;
                    email_body?: string;
                  } = {};
                  if (showLinkedIn && editMessage !== (lead.generated_message || "")) {
                    changes.generated_message = editMessage;
                  }
                  if (showEmail && editSubject !== (lead.email_subject || "")) {
                    changes.email_subject = editSubject;
                  }
                  if (showEmail && editBody !== (lead.email_body || "")) {
                    changes.email_body = editBody;
                  }
                  await onMutate(lead.id, changes);
                  setIsEditing(false);
                }}
              >
                Speichern
              </button>
              <button
                className="btn ghost"
                onClick={() => setIsEditing(false)}
              >
                Abbrechen
              </button>
            </div>
          </div>
        )}
        {showComment && (
        <div className="comment-box">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Kommentar für dein industrial-plants-Team…"
            rows={2}
          />
          <div className="comment-actions">
            <button
              className="btn small"
              onClick={() => {
                onMutate(lead.id, { comment });
                setShowComment(false);
              }}
            >
              Speichern
            </button>
          </div>
        </div>
      )}

      {!showComment && lead.comment && (
        <div className="comment-shown">💬 {lead.comment}</div>
      )}

      {open && (
        <div className="lead-detail">
          {showLinkedIn && (
            <div className="detail-block">
              <div className="detail-label">
                Generierte Nachricht (LinkedIn)
                {pendingFields.has("generated_message") && (
                  <span className="pending-badge"> · ⏳ Änderung wartet auf Review</span>
                )}
              </div>
              <p className="message">{lead.generated_message || "—"}</p>
              {pendingFields.has("generated_message") && (
                <PendingEditNote
                  fieldKey="generated_message"
                  current={lead.generated_message}
                  original={lead.generated_message_original}
                  isAdmin={isAdmin}
                  onMutate={onMutate}
                  leadId={lead.id}
                />
              )}
            </div>
          )}
          {showEmail && (
            <div className="detail-block">
              <div className="detail-label">
                Generierte E-Mail
                {(pendingFields.has("email_subject") ||
                  pendingFields.has("email_body")) && (
                  <span className="pending-badge"> · ⏳ Änderung wartet auf Review</span>
                )}
              </div>
              <p className="email-subject">
                <strong>Betreff:</strong> {lead.email_subject || "—"}
              </p>
              {pendingFields.has("email_subject") && (
                <PendingEditNote
                  fieldKey="email_subject"
                  current={lead.email_subject}
                  original={lead.email_subject_original}
                  isAdmin={isAdmin}
                  onMutate={onMutate}
                  leadId={lead.id}
                />
              )}
              <p className="message">{lead.email_body || "—"}</p>
              {pendingFields.has("email_body") && (
                <PendingEditNote
                  fieldKey="email_body"
                  current={lead.email_body}
                  original={lead.email_body_original}
                  isAdmin={isAdmin}
                  onMutate={onMutate}
                  leadId={lead.id}
                />
              )}
            </div>
          )}
          {lead.research_summary && (
            <div className="detail-block">
              <div className="detail-label">Research</div>
              <p className="research">{lead.research_summary}</p>
            </div>
          )}
          {isAdmin && (
            <div className="detail-block">
              <button type="button" className="btn ghost small" onClick={toggleHistory}>
                {historyOpen ? "Änderungsverlauf ausblenden ▲" : "Änderungsverlauf anzeigen ▼"}
              </button>
              {historyOpen && (
                <div className="history-list">
                  {historyLoading ? (
                    <p className="muted">Lädt…</p>
                  ) : historyEntries.length === 0 ? (
                    <p className="muted">Keine Änderungen protokolliert.</p>
                  ) : (
                    historyEntries.map((h) => (
                      <div key={h.id} className="history-entry">
                        <div className="history-meta">
                          {formatDe(h.created_at)} · {h.field} · {h.source}
                        </div>
                        <p className="history-old">{h.old_value || "(leer)"}</p>
                        <p className="history-new">{h.new_value || "(leer)"}</p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          <div className="detail-meta">
            {isAdmin ? (
              editingEmail ? (
                <span className="email-editor">
                  <input
                    type="email"
                    value={emailValue}
                    onChange={(e) => setEmailValue(e.target.value)}
                    placeholder="kontakt@firma.de"
                    autoFocus
                  />
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      onMutate(lead.id, { email: emailValue.trim() });
                      setEditingEmail(false);
                    }}
                  >
                    Speichern
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => {
                      setEmailValue(lead.email || "");
                      setEditingEmail(false);
                    }}
                  >
                    Abbrechen
                  </button>
                </span>
              ) : (
                <span>
                  {lead.email ? (
                    <>
                      ✉ <a href={`mailto:${lead.email}`}>{lead.email}</a>
                    </>
                  ) : (
                    <span className="muted">Keine E-Mail-Adresse hinterlegt</span>
                  )}{" "}
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setEditingEmail(true)}
                  >
                    {lead.email ? "Ändern" : "Hinzufügen"}
                  </button>
                </span>
              )
            ) : (
              lead.email && (
                <span>
                  ✉ <a href={`mailto:${lead.email}`}>{lead.email}</a>
                </span>
              )
            )}
            {lead.linkedin_url && (
              <span>
                in{" "}
                <a href={lead.linkedin_url} target="_blank" rel="noreferrer">
                  LinkedIn
                </a>
              </span>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function ReportTable({ report }: { report: WeekReportRow[] }) {
  if (report.length === 0) {
    return (
      <section className="empty">
        <p>Noch keine Daten für einen Report.</p>
      </section>
    );
  }
  return (
    <section className="report">
      <table>
        <thead>
          <tr>
            <th>Woche</th>
            <th>Leads</th>
            <th>Freigegeben</th>
            <th>Gesendet</th>
            <th>DM</th>
            <th>E-Mail</th>
            <th>DM n. möglich</th>
            <th>Antworten</th>
            <th>Calls</th>
            <th>Antwortrate</th>
          </tr>
        </thead>
        <tbody>
          {report.map((row) => {
            const rate =
              row.sent === 0 ? 0 : Math.round((row.replied / row.sent) * 100);
            return (
              <tr key={row.week}>
                <td>
                  <div className="week-label">{row.weekLabel}</div>
                  <div className="week-key">{row.week}</div>
                </td>
                <td>{row.total}</td>
                <td>{row.approved}</td>
                <td>{row.sent}</td>
                <td>{row.dmSent}</td>
                <td>{row.emailSent}</td>
                <td>{row.dmBlocked}</td>
                <td>{row.replied}</td>
                <td>{row.callsBooked}</td>
                <td>{rate}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// Turn a client name into a URL-safe slug for token suggestions.
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip remaining accents (é→e …)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// A short random suffix so tokens stay unique and not guessable from the name.
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function generateToken(name: string): string {
  const base = slugify(name).slice(0, 32);
  return base ? `${base}-${randomSuffix()}` : `kunde-${randomSuffix()}`;
}

// Admin-only "Kunden" tab: list, create and delete client boards.
function ClientsPanel({
  adminToken,
  selectedClientToken,
}: {
  adminToken: string;
  selectedClientToken: string | null;
}) {
  const [clients, setClients] = useState<ClientWithCount[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Shown right after a successful create, so the credentials can be copied
  // and sent to the customer once — they aren't retrievable afterwards.
  const [createdCreds, setCreatedCreds] = useState<
    { username: string; password: string } | null
  >(null);
  const [copied, setCopied] = useState(false);

  // Per-row "set/change login" editor.
  const [credsEditingToken, setCredsEditingToken] = useState<string | null>(null);
  const [credsUsername, setCredsUsername] = useState("");
  const [credsPassword, setCredsPassword] = useState("");
  const [credsError, setCredsError] = useState<string | null>(null);
  const [credsSaving, setCredsSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch(
        `/api/clients?token=${encodeURIComponent(adminToken)}`,
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { clients: ClientWithCount[] };
      setClients(data.clients);
    } catch {
      setLoadError(true);
    }
  }, [adminToken]);

  useEffect(() => {
    load();
  }, [load]);

  function loginUrl(): string {
    return typeof window !== "undefined" ? window.location.origin : "";
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (e.g. insecure origin); ignore silently.
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setCreatedCreds(null);

    const cleanName = name.trim();
    const cleanToken = token.trim();
    if (!cleanName || !cleanToken) {
      setFormError("Bitte Kundenname und Token ausfüllen.");
      return;
    }
    const cleanUsername = username.trim();
    if ((cleanUsername && !password) || (!cleanUsername && password)) {
      setFormError("Benutzername und Passwort nur zusammen ausfüllen.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: cleanName,
          token: cleanToken,
          adminToken,
          username: cleanUsername || undefined,
          password: password || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        setFormError(data.error ?? "Anlegen fehlgeschlagen.");
        return;
      }
      if (cleanUsername) {
        setCreatedCreds({ username: cleanUsername, password });
      }
      setName("");
      setToken("");
      setUsername("");
      setPassword("");
      await load();
    } catch {
      setFormError("Netzwerkfehler. Bitte erneut versuchen.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(clientToken: string, clientName: string) {
    if (
      !window.confirm(
        `Kunde „${clientName}“ und alle zugehörigen Leads unwiderruflich löschen?`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch("/api/clients", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: clientToken, adminToken }),
      });
      if (!res.ok) {
        alert("Löschen fehlgeschlagen. Bitte erneut versuchen.");
        return;
      }
      await load();
    } catch {
      alert("Netzwerkfehler. Bitte erneut versuchen.");
    }
  }

  function openCredsEditor(c: ClientWithCount) {
    setCredsEditingToken(c.token);
    setCredsUsername(c.username || "");
    setCredsPassword("");
    setCredsError(null);
  }

  async function saveCreds(clientToken: string) {
    setCredsError(null);
    if (!credsUsername.trim() || !credsPassword) {
      setCredsError("Benutzername und Passwort sind erforderlich.");
      return;
    }
    setCredsSaving(true);
    try {
      const res = await fetch("/api/clients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: clientToken,
          adminToken,
          username: credsUsername.trim(),
          password: credsPassword,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setCredsError(data.error ?? "Speichern fehlgeschlagen.");
        return;
      }
      setCredsEditingToken(null);
      await load();
    } catch {
      setCredsError("Netzwerkfehler. Bitte erneut versuchen.");
    } finally {
      setCredsSaving(false);
    }
  }

  // Manual trigger for the automated Microsoft Graph send job — useful right
  // now on the Hobby plan (no frequent Cron yet) and as a manual override later.
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<
    { sent: number; failed: number; errors: string[] } | { error: string } | null
  >(null);

  async function sendEmailsNow() {
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch("/api/send-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminToken }),
      });
      const data = (await res.json()) as {
        sent?: number;
        failed?: number;
        errors?: string[];
        error?: string;
      };
      if (!res.ok || data.error) {
        setSendResult({ error: data.error ?? "Senden fehlgeschlagen." });
      } else {
        setSendResult({
          sent: data.sent ?? 0,
          failed: data.failed ?? 0,
          errors: data.errors ?? [],
        });
      }
      await load();
    } catch {
      setSendResult({ error: "Netzwerkfehler. Bitte erneut versuchen." });
    } finally {
      setSending(false);
    }
  }

  // One-time cleanup (18.08.2026): backfill approval timestamps only for
  // channels that are already sent — see backfillApprovalForAlreadySent for
  // why this is safe and deliberately doesn't touch not-yet-sent leads.
  const [backfilling2, setBackfilling2] = useState(false);
  const [backfill2Done, setBackfill2Done] = useState<number | null>(null);

  async function backfillApprovalCleanup() {
    if (!selectedClientToken) return;
    setBackfilling2(true);
    setBackfill2Done(null);
    try {
      const res = await fetch("/api/backfill-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminToken, clientToken: selectedClientToken }),
      });
      const data = (await res.json()) as { updated?: number; error?: string };
      if (!res.ok) {
        alert(data.error ?? "Nachtragen fehlgeschlagen.");
        return;
      }
      setBackfill2Done(data.updated ?? 0);
    } catch {
      alert("Netzwerkfehler. Bitte erneut versuchen.");
    } finally {
      setBackfilling2(false);
    }
  }

  // One-time cleanup (19.08.2026): tag every pre-existing lead with a
  // campaign label based on its current channel — see
  // backfillCampaignFromChannel for why this is safe (only touches leads
  // with no campaign set yet).
  const [bothLabel, setBothLabel] = useState("CEO");
  const [linkedinLabel, setLinkedinLabel] = useState("HR");
  const [backfilling3, setBackfilling3] = useState(false);
  const [backfill3Done, setBackfill3Done] = useState<number | null>(null);

  async function backfillCampaignCleanup() {
    if (!selectedClientToken || !bothLabel.trim() || !linkedinLabel.trim()) return;
    setBackfilling3(true);
    setBackfill3Done(null);
    try {
      const res = await fetch("/api/backfill-campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminToken,
          clientToken: selectedClientToken,
          bothLabel: bothLabel.trim(),
          linkedinLabel: linkedinLabel.trim(),
        }),
      });
      const data = (await res.json()) as { updated?: number; error?: string };
      if (!res.ok) {
        alert(data.error ?? "Nachtragen fehlgeschlagen.");
        return;
      }
      setBackfill3Done(data.updated ?? 0);
    } catch {
      alert("Netzwerkfehler. Bitte erneut versuchen.");
    } finally {
      setBackfilling3(false);
    }
  }

  return (
    <section className="clients-panel">
      <div className="clients-list-card send-emails-card">
        <h2 className="section-title">E-Mail-Versand (Microsoft)</h2>
        <p className="muted" style={{ margin: "0 0 12px" }}>
          Verschickt freigegebene, noch nicht gesendete E-Mails direkt aus dem
          konfigurierten Postfach. Läuft automatisch alle 15 Minuten — der
          Button hier ist für den sofortigen Testlauf oder falls mal was
          Dringendes rausmuss.
        </p>
        <button className="btn approve" onClick={sendEmailsNow} disabled={sending}>
          {sending ? "Sendet…" : "Jetzt E-Mails senden"}
        </button>
        {sendResult && (
          <div className="send-result">
            {"error" in sendResult ? (
              <p className="form-error">{sendResult.error}</p>
            ) : (
              <>
                <p>
                  ✅ {sendResult.sent} gesendet
                  {sendResult.failed > 0 && `, ❌ ${sendResult.failed} fehlgeschlagen`}
                </p>
                {sendResult.errors.map((e, i) => (
                  <p key={i} className="form-error">
                    {e}
                  </p>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <div className="clients-list-card">
        <h2 className="section-title">Einmaliger Nachtrag (18.08.2026)</h2>
        <p className="muted" style={{ margin: "0 0 12px" }}>
          Trägt Freigabe-Zeitstempel nach — aber ausschließlich für Kanäle,
          die bereits tatsächlich verschickt wurden (risikofrei, ändert
          nichts an noch nicht gesendeten Leads). Wirkt auf den gerade oben
          ausgewählten Kunden.
        </p>
        <button
          className="btn ghost"
          onClick={backfillApprovalCleanup}
          disabled={backfilling2 || !selectedClientToken}
        >
          {backfilling2 ? "Trage nach…" : "Bereits gesendete Kanäle nachtragen"}
        </button>
        {backfill2Done !== null && (
          <span className="muted"> → {backfill2Done} Leads aktualisiert</span>
        )}
      </div>

      <div className="clients-list-card">
        <h2 className="section-title">Kampagne aus Kanal ableiten (19.08.2026)</h2>
        <p className="muted" style={{ margin: "0 0 12px" }}>
          Trägt einmalig eine Kampagnen-Markierung nach — anhand des aktuellen
          Kanals. Ändert nur Leads, die noch keine Kampagne haben; bereits
          gesetzte Werte bleiben unangetastet. Wirkt auf den oben
          ausgewählten Kunden.
        </p>
        <div className="creds-editor" style={{ marginBottom: 10 }}>
          <label>
            "Beide Kanäle" →{" "}
            <input
              type="text"
              value={bothLabel}
              onChange={(e) => setBothLabel(e.target.value)}
              style={{ width: 100 }}
            />
          </label>
          <label>
            "Nur LinkedIn" →{" "}
            <input
              type="text"
              value={linkedinLabel}
              onChange={(e) => setLinkedinLabel(e.target.value)}
              style={{ width: 100 }}
            />
          </label>
        </div>
        <button
          className="btn ghost"
          onClick={backfillCampaignCleanup}
          disabled={backfilling3 || !selectedClientToken}
        >
          {backfilling3 ? "Trage nach…" : "Kampagne einmalig setzen"}
        </button>
        {backfill3Done !== null && (
          <span className="muted"> → {backfill3Done} Leads aktualisiert</span>
        )}
      </div>

      <div className="clients-list-card">
        <h2 className="section-title">Kunden</h2>
        {loadError ? (
          <p className="muted">Kunden konnten nicht geladen werden.</p>
        ) : clients === null ? (
          <p className="muted">Lädt…</p>
        ) : clients.length === 0 ? (
          <p className="muted">Noch keine Kunden angelegt.</p>
        ) : (
          <table className="clients-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Token</th>
                <th>Leads</th>
                <th>Login</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.token}>
                  <td className="client-cell-name">{c.name}</td>
                  <td>
                    <code>{c.token}</code>
                  </td>
                  <td>{c.leadCount}</td>
                  <td>
                    {credsEditingToken === c.token ? (
                      <div className="creds-editor">
                        <input
                          type="text"
                          placeholder="Benutzername"
                          value={credsUsername}
                          onChange={(e) => setCredsUsername(e.target.value)}
                        />
                        <input
                          type="password"
                          placeholder="Neues Passwort"
                          value={credsPassword}
                          onChange={(e) => setCredsPassword(e.target.value)}
                        />
                        {credsError && <p className="form-error">{credsError}</p>}
                        <div className="creds-editor-actions">
                          <button
                            type="button"
                            className="btn small"
                            disabled={credsSaving}
                            onClick={() => saveCreds(c.token)}
                          >
                            {credsSaving ? "Speichert…" : "Speichern"}
                          </button>
                          <button
                            type="button"
                            className="btn ghost small"
                            onClick={() => setCredsEditingToken(null)}
                          >
                            Abbrechen
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {c.hasLogin ? (
                          <code>{c.username}</code>
                        ) : (
                          <span className="muted">kein Login</span>
                        )}{" "}
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => openCredsEditor(c)}
                        >
                          {c.hasLogin ? "Ändern" : "Einrichten"}
                        </button>
                      </>
                    )}
                  </td>
                  <td className="client-cell-actions">
                    <button
                      className="btn reject small"
                      onClick={() => remove(c.token, c.name)}
                    >
                      Löschen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <form className="client-form-card" onSubmit={submit}>
        <h2 className="section-title">Neuen Kunden anlegen</h2>

        <label className="field">
          <span>Kundenname</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="z. B. ACME Manufacturing"
          />
        </label>

        <label className="field">
          <span>Token</span>
          <div className="field-row">
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="z. B. acme-a1b2c3"
            />
            <button
              type="button"
              className="btn small"
              onClick={() => setToken(generateToken(name))}
            >
              Generieren
            </button>
          </div>
        </label>

        <label className="field">
          <span>Login-Benutzername</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="z. B. bonusleben"
          />
        </label>

        <label className="field">
          <span>Login-Passwort</span>
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Passwort für den Kunden"
          />
        </label>

        {formError && <p className="form-error">{formError}</p>}

        <div className="form-actions">
          <button className="btn approve" type="submit" disabled={submitting}>
            {submitting ? "Legt an…" : "Kunde anlegen"}
          </button>
        </div>

        {createdCreds && (
          <div className="created-link">
            <div className="detail-label">Zugangsdaten für den Kunden</div>
            <p className="muted" style={{ margin: "0 0 8px" }}>
              Dashboard: <code>{loginUrl()}</code>
            </p>
            <div className="created-link-row">
              <code className="link-value">
                {createdCreds.username} / {createdCreds.password}
              </code>
              <button
                type="button"
                className="btn small"
                onClick={() =>
                  copy(
                    `Dashboard: ${loginUrl()}\nBenutzername: ${createdCreds.username}\nPasswort: ${createdCreds.password}`,
                  )
                }
              >
                {copied ? "Kopiert ✓" : "Kopieren"}
              </button>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}
