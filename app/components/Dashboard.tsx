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

type ChannelFilter = "all" | "linkedin" | "email";

const CHANNEL_FILTERS: { key: ChannelFilter; label: string }[] = [
  { key: "all", label: "Alle Kanäle" },
  { key: "linkedin", label: "💬 LinkedIn" },
  { key: "email", label: "📧 E-Mail" },
];

function matchesChannelFilter(lead: Lead, filter: ChannelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "linkedin") return lead.channel === "linkedin" || lead.channel === "both";
  return lead.channel === "email" || lead.channel === "both";
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
  const [isPending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editMessage, setEditMessage] = useState("");

  // Token used to authorize mutations against the API.
  const authToken = role === "admin" ? adminToken! : selected!.token;

  function switchClient(clientToken: string) {
    router.push(`/?token=${encodeURIComponent(adminToken!)}&client=${encodeURIComponent(clientToken)}`);
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
      channel?: string;
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
        <ClientsPanel adminToken={adminToken!} />
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
          {kpis && <KpiRow kpis={kpis} />}
          <nav className="channel-filters">
            {CHANNEL_FILTERS.map((f) => {
              const count = leads.filter((l) => matchesChannelFilter(l, f.key)).length;
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
                (l) => matchesChannelFilter(l, channelFilter) && matchesFilter(l, f.key),
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
          <LeadList
            leads={leads.filter(
              (l) => matchesChannelFilter(l, channelFilter) && matchesFilter(l, leadFilter),
            )}
            onMutate={mutate}
            onDelete={role === "admin" ? removeLead : undefined}
            isAdmin={role === "admin"}
            filtered={leadFilter !== "all" || channelFilter !== "all"}
          />
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
      channel?: string;
    },
  ) => void;
  onDelete?: (id: number) => void;
  isAdmin: boolean;
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
      channel?: string;
    },
  ) => void;
  onDelete?: (id: number) => void;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState(lead.comment);
  const [isEditing, setIsEditing] = useState(false);
  const [editMessage, setEditMessage] = useState(lead.generated_message || "");
  const [editSubject, setEditSubject] = useState(lead.email_subject || "");
  const [editBody, setEditBody] = useState(lead.email_body || "");

  const pendingFields = new Set(
    lead.pending_edit_fields ? lead.pending_edit_fields.split(",") : [],
  );

  return (
    <article className="lead">
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
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {lead.signal && <div className="signal">⚡ {lead.signal}</div>}

      <div className="lead-actions">
        <button
          className="btn approve"
          onClick={() => onMutate(lead.id, { status: "approved" })}
          disabled={lead.status === "approved"}
        >
          Freigeben
        </button>
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
        {lead.status !== "new" &&
          lead.status !== "revised" &&
          lead.status !== "rejected" &&
          lead.status !== "dnd" && (
            <>
              {(lead.channel === "linkedin" || lead.channel === "both") && (
                <button
                  className="btn sent"
                  onClick={() =>
                    onMutate(lead.id, {
                      status: "sent",
                      dm_sent_at: new Date().toISOString(),
                    })
                  }
                  disabled={!!lead.dm_sent_at}
                >
                  {lead.dm_sent_at ? "✓ DM gesendet" : "DM gesendet"}
                </button>
              )}
              {(lead.channel === "email" || lead.channel === "both") && (
                <button
                  className="btn sent"
                  onClick={() =>
                    onMutate(lead.id, {
                      status: "sent",
                      email_sent_at: new Date().toISOString(),
                    })
                  }
                  disabled={!!lead.email_sent_at}
                >
                  {lead.email_sent_at ? "✓ E-Mail gesendet" : "E-Mail gesendet"}
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
            <div className="comment-actions">
              <button
                className="btn small"
                onClick={async () => {
                  const changes: {
                    generated_message?: string;
                    email_subject?: string;
                    email_body?: string;
                  } = {};
                  if (editMessage !== (lead.generated_message || "")) {
                    changes.generated_message = editMessage;
                  }
                  if (editSubject !== (lead.email_subject || "")) {
                    changes.email_subject = editSubject;
                  }
                  if (editBody !== (lead.email_body || "")) {
                    changes.email_body = editBody;
                  }
                  await onMutate(lead.id, changes);
                  setIsEditing(false);
                }}
              >
                Speichern
              </button>
              <button
                className="btn small approve"
                onClick={async () => {
                  const changes: {
                    generated_message?: string;
                    email_subject?: string;
                    email_body?: string;
                  } = {};
                  if (editMessage !== (lead.generated_message || "")) {
                    changes.generated_message = editMessage;
                  }
                  if (editSubject !== (lead.email_subject || "")) {
                    changes.email_subject = editSubject;
                  }
                  if (editBody !== (lead.email_body || "")) {
                    changes.email_body = editBody;
                  }
                  // Saving an edited message always resets status to
                  // "Überarbeitet" server-side (by design, so raw edits get a
                  // second look) — so approving has to be a separate,
                  // follow-up call, not bundled into the same request.
                  if (Object.keys(changes).length > 0) {
                    await onMutate(lead.id, changes);
                  }
                  await onMutate(lead.id, { status: "approved" });
                  setIsEditing(false);
                }}
              >
                Speichern &amp; Freigeben
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
          {(lead.email_subject ||
            lead.email_body ||
            pendingFields.has("email_subject") ||
            pendingFields.has("email_body")) && (
            <div className="detail-block">
              <div className="detail-label">
                Generierte E-Mail
                {(pendingFields.has("email_subject") ||
                  pendingFields.has("email_body")) && (
                  <span className="pending-badge"> · ⏳ Änderung wartet auf Review</span>
                )}
              </div>
              {(lead.email_subject || pendingFields.has("email_subject")) && (
                <>
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
                </>
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
          <div className="detail-meta">
            {lead.email && (
              <span>
                ✉ <a href={`mailto:${lead.email}`}>{lead.email}</a>
              </span>
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
function ClientsPanel({ adminToken }: { adminToken: string }) {
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
