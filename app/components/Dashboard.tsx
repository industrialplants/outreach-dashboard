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
  | "call_booked";

const LEAD_FILTERS: { key: LeadFilter; label: string }[] = [
  { key: "all", label: "Alle" },
  { key: "new", label: "Neu" },
  { key: "revised", label: "Überarbeitet" },
  { key: "approved", label: "Freigegeben" },
  { key: "sent", label: "Gesendet" },
  { key: "rejected", label: "Abgelehnt" },
  { key: "call_booked", label: "Call gebucht" },
];

function matchesFilter(lead: Lead, filter: LeadFilter): boolean {
  // Main view shows everything except booked calls.
  if (filter === "all") return lead.status !== "call_booked";
  return lead.status === filter;
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
    changes: { status?: LeadStatus; comment?: string; generated_message?: string },
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
          <nav className="lead-filters">
            {LEAD_FILTERS.map((f) => {
              const count = leads.filter((l) => matchesFilter(l, f.key)).length;
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
            leads={leads.filter((l) => matchesFilter(l, leadFilter))}
            onMutate={mutate}
            onDelete={role === "admin" ? removeLead : undefined}
            filtered={leadFilter !== "all"}
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
  onDelete,
  filtered = false,
}: {
  leads: Lead[];
  onMutate: (
    id: number,
    changes: { status?: LeadStatus; comment?: string },
  ) => void;
  onDelete?: (id: number) => void;
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
        />
      ))}
    </section>
  );
}

function LeadCard({
  lead,
  onMutate,
  onDelete,
}: {
  lead: Lead;
  onMutate: (
    id: number,
    changes: { status?: LeadStatus; comment?: string },
  ) => void;
  onDelete?: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState(lead.comment);

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
        {lead.status === "approved" && (
          <button
            className="btn sent"
            onClick={() => onMutate(lead.id, { status: "sent" })}
          >
            Gesendet
          </button>
        )}
        <button className="btn ghost" onClick={() => setShowComment((v) => !v)}>
          Kommentar
        </button>
        <button className="btn ghost toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "Nachricht ▲" : "Nachricht ▼"}
        </button>
        {onDelete && (
          <>
            <button
              className="btn ghost"
              onClick={() => {
                setIsEditing(true);
                setEditMessage(lead.generated_message || "");
              }}
            >
              Bearbeiten
            </button>
            <button
              className="btn danger"
              onClick={() => {
                if (window.confirm("Wirklich löschen?")) onDelete(lead.id);
              }}
            >
              Löschen
            </button>
          </>
        )}
      </div>

      {isEditing && (
          <div className="comment-box">
            <textarea
              value={editMessage}
              onChange={(e) => setEditMessage(e.target.value)}
              rows={5}
              style={{ width: "100%", resize: "vertical" }}
            />
            <div className="comment-actions">
              <button
                className="btn small"
                onClick={async () => {
                  await mutate(lead.id, { generated_message: editMessage });
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
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The link shown for copying right after a successful create.
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  function dashboardLink(clientToken: string): string {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/?token=${encodeURIComponent(clientToken)}`;
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
    setCreatedLink(null);

    const cleanName = name.trim();
    const cleanToken = token.trim();
    if (!cleanName || !cleanToken) {
      setFormError("Bitte Kundenname und Token ausfüllen.");
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
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        setFormError(data.error ?? "Anlegen fehlgeschlagen.");
        return;
      }
      setCreatedLink(dashboardLink(cleanToken));
      setName("");
      setToken("");
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

  return (
    <section className="clients-panel">
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

        {formError && <p className="form-error">{formError}</p>}

        <div className="form-actions">
          <button className="btn approve" type="submit" disabled={submitting}>
            {submitting ? "Legt an…" : "Kunde anlegen"}
          </button>
        </div>

        {createdLink && (
          <div className="created-link">
            <div className="detail-label">Dashboard-Link</div>
            <div className="created-link-row">
              <code className="link-value">{createdLink}</code>
              <button
                type="button"
                className="btn small"
                onClick={() => copy(createdLink)}
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
