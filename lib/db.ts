import { createClient, type Client, type InStatement } from "@libsql/client";

// The admin board is reached via /?token=admin. Overridable via env for real deployments.
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "admin";

// Real admin login (username + password), used by the login form as an
// alternative to the ?token=admin link. Set these in Vercel's env vars;
// falls back to something usable out of the box if unset.
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "admin";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? ADMIN_TOKEN;

// Reuse a single client + one-time init across hot-reloads in dev and warm
// serverless invocations (Next re-evaluates modules; globals survive).
declare global {
  // eslint-disable-next-line no-var
  var __outreachDb: Client | undefined;
  // eslint-disable-next-line no-var
  var __outreachDbReady: Promise<void> | undefined;
}

function createConnection(): Client {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    throw new Error(
      "TURSO_DATABASE_URL is not set — configure it in .env.local (local) and in the Vercel project env vars (production).",
    );
  }
  return createClient({ url, authToken });
}

async function migrate(db: Client): Promise<void> {
  // Same schema as the previous better-sqlite3 setup. IF NOT EXISTS keeps this
  // idempotent, so it is safe to run on every cold start.
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS clients (
      token         TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      username      TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS leads (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      client_token      TEXT NOT NULL,
      name              TEXT NOT NULL DEFAULT '',
      company           TEXT NOT NULL DEFAULT '',
      title             TEXT NOT NULL DEFAULT '',
      linkedin_url      TEXT NOT NULL DEFAULT '',
      email             TEXT NOT NULL DEFAULT '',
      generated_message TEXT NOT NULL DEFAULT '',
      email_subject     TEXT NOT NULL DEFAULT '',
      email_body        TEXT NOT NULL DEFAULT '',
      research_summary  TEXT NOT NULL DEFAULT '',
      signal            TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'new',
      comment           TEXT NOT NULL DEFAULT '',
      dm_sent_at        TEXT NOT NULL DEFAULT '',
      email_sent_at     TEXT NOT NULL DEFAULT '',
      generated_message_original TEXT NOT NULL DEFAULT '',
      email_subject_original     TEXT NOT NULL DEFAULT '',
      email_body_original        TEXT NOT NULL DEFAULT '',
      pending_edit_fields         TEXT NOT NULL DEFAULT '',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      FOREIGN KEY (client_token) REFERENCES clients(token)
    );

    CREATE INDEX IF NOT EXISTS idx_leads_client ON leads(client_token);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

    -- Enforce one lead per (client, linkedin_url). Partial so the many leads
    -- without a linkedin_url (empty string) don't collide. Backs upsertLead.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_client_linkedin
      ON leads(client_token, linkedin_url) WHERE linkedin_url <> '';
  `);

  // The leads table already exists in production without these two columns.
  // CREATE TABLE IF NOT EXISTS above is a no-op there, so add them here.
  // SQLite/libsql has no "ADD COLUMN IF NOT EXISTS", so check first.
  const cols = await db.execute("PRAGMA table_info(leads)");
  const existing = new Set(cols.rows.map((r) => String(r.name)));
  if (!existing.has("email_subject")) {
    await db.execute(
      "ALTER TABLE leads ADD COLUMN email_subject TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!existing.has("email_body")) {
    await db.execute(
      "ALTER TABLE leads ADD COLUMN email_body TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!existing.has("dm_sent_at")) {
    await db.execute(
      "ALTER TABLE leads ADD COLUMN dm_sent_at TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!existing.has("email_sent_at")) {
    await db.execute(
      "ALTER TABLE leads ADD COLUMN email_sent_at TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!existing.has("generated_message_original")) {
    await db.execute(
      "ALTER TABLE leads ADD COLUMN generated_message_original TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!existing.has("email_subject_original")) {
    await db.execute(
      "ALTER TABLE leads ADD COLUMN email_subject_original TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!existing.has("email_body_original")) {
    await db.execute(
      "ALTER TABLE leads ADD COLUMN email_body_original TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!existing.has("pending_edit_fields")) {
    await db.execute(
      "ALTER TABLE leads ADD COLUMN pending_edit_fields TEXT NOT NULL DEFAULT ''",
    );
  }

  // Same idempotent-add pattern for the clients table's login columns.
  const clientCols = await db.execute("PRAGMA table_info(clients)");
  const existingClientCols = new Set(clientCols.rows.map((r) => String(r.name)));
  if (!existingClientCols.has("username")) {
    await db.execute(
      "ALTER TABLE clients ADD COLUMN username TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!existingClientCols.has("password_hash")) {
    await db.execute(
      "ALTER TABLE clients ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''",
    );
  }
  // Usernames must be unique across clients once set (empty = no login yet,
  // and many clients can share that "unset" state, hence the partial index).
  await db.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_username ON clients(username) WHERE username <> ''",
  );
}

// Seed a couple of demo clients + sample leads on first run so the dashboard
// isn't empty before Clay has sent anything. Idempotent: only runs when empty.
async function seed(db: Client): Promise<void> {
  const res = await db.execute("SELECT COUNT(*) AS n FROM clients");
  const clientCount = Number(res.rows[0].n);
  if (clientCount > 0) return;

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const iso = (offsetDays: number) =>
    new Date(now - offsetDays * day).toISOString();

  const demoClients: [string, string][] = [
    ["acme-token", "ACME Manufacturing"],
    ["nordwind-token", "Nordwind Logistik"],
  ];

  const samples = [
    {
      client_token: "acme-token",
      name: "Julia Weber",
      company: "Siemens Energy",
      title: "Head of Procurement",
      linkedin_url: "https://linkedin.com/in/julia-weber",
      email: "julia.weber@siemens-energy.com",
      generated_message:
        "Hallo Julia, mir ist aufgefallen, dass Siemens Energy die Wartungszyklen für Turbinen digitalisiert – genau da setzen wir mit prädiktiver Instandhaltung an. Hätten Sie 15 Minuten für einen kurzen Austausch?",
      research_summary:
        "Siemens Energy hat kürzlich ein Predictive-Maintenance-Programm angekündigt und sucht Partner für Sensor-Integration.",
      signal: "Neue Stelle: VP Digital Operations besetzt",
      status: "new",
      comment: "",
      created_at: iso(1),
    },
    {
      client_token: "acme-token",
      name: "Markus Klein",
      company: "ThyssenKrupp",
      title: "Plant Manager",
      linkedin_url: "https://linkedin.com/in/markus-klein",
      email: "markus.klein@thyssenkrupp.com",
      generated_message:
        "Hallo Markus, Ihr Werk in Duisburg fährt aktuell eine Modernisierung – unsere Kunden senken damit ungeplante Stillstände um bis zu 30%. Lohnt sich ein Gespräch?",
      research_summary:
        "ThyssenKrupp investiert 200 Mio. EUR in die Werksmodernisierung Duisburg.",
      signal: "Pressemitteilung: Investition Werksmodernisierung",
      status: "approved",
      comment: "Sieht gut aus, bitte so rausschicken.",
      created_at: iso(2),
    },
    {
      client_token: "acme-token",
      name: "Sabine Hoffmann",
      company: "BASF",
      title: "Director Operations",
      linkedin_url: "https://linkedin.com/in/sabine-hoffmann",
      email: "sabine.hoffmann@basf.com",
      generated_message:
        "Hallo Sabine, BASF treibt die Dekarbonisierung der Produktion voran. Wir helfen Anlagenbetreibern, Energieeffizienz messbar zu steigern – Interesse an konkreten Zahlen?",
      research_summary:
        "BASF hat Net-Zero-Ziele bis 2050 und ein aktuelles Effizienzprogramm.",
      signal: "LinkedIn-Post zu Dekarbonisierung",
      status: "sent",
      comment: "",
      created_at: iso(5),
    },
    {
      client_token: "acme-token",
      name: "Thomas Berger",
      company: "Bosch",
      title: "VP Manufacturing",
      linkedin_url: "https://linkedin.com/in/thomas-berger",
      email: "thomas.berger@bosch.com",
      generated_message:
        "Hallo Thomas, Bosch skaliert die vernetzte Fertigung. Wir liefern das fehlende Puzzleteil für Echtzeit-OEE. Kurzer Call nächste Woche?",
      research_summary:
        "Bosch expandiert Industry-4.0-Initiativen über mehrere Standorte.",
      signal: "Jobanzeige: 12 offene IIoT-Stellen",
      status: "replied",
      comment: "",
      created_at: iso(8),
    },
    {
      client_token: "acme-token",
      name: "Andrea Fischer",
      company: "Continental",
      title: "COO",
      linkedin_url: "https://linkedin.com/in/andrea-fischer",
      email: "andrea.fischer@continental.com",
      generated_message:
        "Hallo Andrea, Continental optimiert die Reifenfertigung. Wir haben bei einem vergleichbaren Werk 18% Ausschuss eingespart. Zeigen wir Ihnen wie?",
      research_summary:
        "Continental Restrukturierung mit Fokus auf Effizienz in der Produktion.",
      signal: "Quartalsbericht: Effizienzfokus",
      status: "call_booked",
      comment: "Termin steht: Donnerstag 14 Uhr.",
      created_at: iso(10),
    },
    {
      client_token: "nordwind-token",
      name: "Peter Schulz",
      company: "DB Schenker",
      title: "Head of Fleet",
      linkedin_url: "https://linkedin.com/in/peter-schulz",
      email: "peter.schulz@dbschenker.com",
      generated_message:
        "Hallo Peter, DB Schenker elektrifiziert die Flotte. Unsere Routenoptimierung senkt Leerfahrten deutlich – relevant für Ihre Ziele?",
      research_summary:
        "DB Schenker hat ein Flotten-Elektrifizierungsprogramm gestartet.",
      signal: "Pressemitteilung: E-Flotte",
      status: "new",
      comment: "",
      created_at: iso(1),
    },
    {
      client_token: "nordwind-token",
      name: "Christina Wolf",
      company: "Kühne+Nagel",
      title: "Director Supply Chain",
      linkedin_url: "https://linkedin.com/in/christina-wolf",
      email: "christina.wolf@kuehne-nagel.com",
      generated_message:
        "Hallo Christina, Kühne+Nagel baut die Lagerautomatisierung aus. Wir bringen KI-gestützte Nachfrageprognosen ein. Kurzes Gespräch?",
      research_summary:
        "Kühne+Nagel investiert in automatisierte Lagerlogistik.",
      signal: "Neue Stelle: Head of Automation",
      status: "sent",
      comment: "",
      created_at: iso(4),
    },
  ];

  const stmts: InStatement[] = [];
  for (const [token, name] of demoClients) {
    stmts.push({
      sql: "INSERT INTO clients (token, name) VALUES ($token, $name)",
      args: { token, name },
    });
  }
  for (const r of samples) {
    stmts.push({
      sql: `INSERT INTO leads (
        client_token, name, company, title, linkedin_url, email,
        generated_message, email_subject, email_body, research_summary, signal, status, comment,
        created_at, updated_at
      ) VALUES (
        $client_token, $name, $company, $title, $linkedin_url, $email,
        $generated_message, '', '', $research_summary, $signal, $status, $comment,
        $created_at, $updated_at
      )`,
      args: { ...r, updated_at: r.created_at },
    });
  }

  // Wrap the seed in a single transaction: all rows land or none do.
  await db.batch(stmts, "write");
}

// Return the shared libsql client, running migrate + seed exactly once.
export async function getDb(): Promise<Client> {
  if (!global.__outreachDb) {
    global.__outreachDb = createConnection();
  }
  if (!global.__outreachDbReady) {
    const db = global.__outreachDb;
    global.__outreachDbReady = (async () => {
      await migrate(db);
      await seed(db);
    })().catch((err) => {
      // Let a later request retry init instead of caching the failure.
      global.__outreachDbReady = undefined;
      throw err;
    });
  }
  await global.__outreachDbReady;
  return global.__outreachDb;
}
