"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Client, Kpis, Lead, LeadStatus, WeekReportRow } from "@/lib/types";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/types";

interface DashboardProps {
  role: "admin" | "client";
  adminToken: string | null;
  clients: Client[];
  selected: Client | null;
  leads: Lead[];
  kpis: Kpis | null;
  report: WeekReportRow[];
}

type Tab = "leads" | "report";

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
  const [isPending, startTransition] = useTransition();

  // Token used to authorize mutations against the API.
  const authToken = role === "admin" ? adminToken! : selected!.token;

  function switchClient(clientToken: string) {
    router.push(`/?token=${encodeURIComponent(adminToken!)}&client=${encodeURIComponent(clientToken)}`);
  }

  async function mutate(
    id: number,
    changes: { status?: LeadStatus; comment?: string },
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

  const noBoard = role === "admin" && !selected;

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">industrial plants</span>
          {role === "admin" && <span className="admin-badge">Admin</span>}
        </div>

        <div className="topbar-right">
          {isPending && <span className="syncing">aktualisiere…</span>}
          {role === "admin" ? (
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
          ) : (
            <span className="client-name">{selected?.name}</span>
          )}
        </div>
      </header>

      {noBoard ? (
        <section className="empty big">
          <p>Noch keine Kunden angelegt.</p>
          <p className="muted">
            Sobald Clay Leads an den Webhook sendet, erscheinen hier die
            Kunden-Boards.
          </p>
        </section>
      ) : (
        <>
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
          </nav>

          {tab === "leads" ? (
            <>
              {kpis && <KpiRow kpis={kpis} />}
              <LeadList leads={leads} onMutate={mutate} />
            </>
          ) : (
            <ReportTable report={report} />
          )}
        </>
      )}
    </main>
  );
}

function KpiRow({ kpis }: { kpis: Kpis }) {
  const cards = [
    { label: "Outreaches diese Woche", value: String(kpis.outreachesThisWeek) },
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
        </div>
      ))}
    </section>
  );
}

function LeadList({
  leads,
  onMutate,
}: {
  leads: Lead[];
  onMutate: (
    id: number,
    changes: { status?: LeadStatus; comment?: string },
  ) => void;
}) {
  if (leads.length === 0) {
    return (
      <section className="empty">
        <p>Noch keine Leads für dieses Board.</p>
        <p className="muted">
          Neue Leads von Clay erscheinen hier automatisch.
        </p>
      </section>
    );
  }
  return (
    <section className="leads">
      {leads.map((lead) => (
        <LeadCard key={lead.id} lead={lead} onMutate={onMutate} />
      ))}
    </section>
  );
}

function LeadCard({
  lead,
  onMutate,
}: {
  lead: Lead;
  onMutate: (
    id: number,
    changes: { status?: LeadStatus; comment?: string },
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState(lead.comment);

  return (
    <article className="lead">
      <div className="lead-head">
        <div className="lead-who">
          <div className="lead-name">{lead.name || "—"}</div>
          <div className="lead-sub">
            {[lead.title, lead.company].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
        <div className="lead-head-right">
          <span className={`status-pill status-${lead.status}`}>
            {STATUS_LABELS[lead.status]}
          </span>
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
        <button className="btn ghost" onClick={() => setShowComment((v) => !v)}>
          Kommentar
        </button>
        <button className="btn ghost toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "Nachricht ▲" : "Nachricht ▼"}
        </button>
      </div>

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
            <div className="detail-label">Generierte Nachricht</div>
            <p className="message">{lead.generated_message || "—"}</p>
          </div>
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
