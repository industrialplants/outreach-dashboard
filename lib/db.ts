import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// The admin board is reached via /?token=admin. Overridable via env for real deployments.
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "admin";

// Persist the SQLite file under <project>/data so it survives dev restarts.
const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "outreach.db");

// Reuse a single connection across hot-reloads in dev (Next re-evaluates modules).
declare global {
  // eslint-disable-next-line no-var
  var __outreachDb: Database.Database | undefined;
}

function createConnection(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seed(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      token TEXT PRIMARY KEY,
      name  TEXT NOT NULL
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
      research_summary  TEXT NOT NULL DEFAULT '',
      signal            TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'new',
      comment           TEXT NOT NULL DEFAULT '',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      FOREIGN KEY (client_token) REFERENCES clients(token)
    );

    CREATE INDEX IF NOT EXISTS idx_leads_client ON leads(client_token);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  `);
}

// Seed a couple of demo clients + sample leads on first run so the dashboard
// isn't empty before Clay has sent anything. Idempotent: only runs when empty.
function seed(db: Database.Database): void {
  const clientCount = db.prepare("SELECT COUNT(*) AS n FROM clients").get() as {
    n: number;
  };
  if (clientCount.n > 0) return;

  const insertClient = db.prepare(
    "INSERT INTO clients (token, name) VALUES (?, ?)",
  );
  const demoClients: [string, string][] = [
    ["acme-token", "ACME Manufacturing"],
    ["nordwind-token", "Nordwind Logistik"],
  ];
  for (const [token, name] of demoClients) insertClient.run(token, name);

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const iso = (offsetDays: number) =>
    new Date(now - offsetDays * day).toISOString();

  const insertLead = db.prepare(`
    INSERT INTO leads (
      client_token, name, company, title, linkedin_url, email,
      generated_message, research_summary, signal, status, comment,
      created_at, updated_at
    ) VALUES (
      @client_token, @name, @company, @title, @linkedin_url, @email,
      @generated_message, @research_summary, @signal, @status, @comment,
      @created_at, @updated_at
    )
  `);

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

  const insertMany = db.transaction((rows: typeof samples) => {
    for (const r of rows) {
      insertLead.run({ ...r, updated_at: r.created_at });
    }
  });
  insertMany(samples);
}

export function getDb(): Database.Database {
  if (!global.__outreachDb) {
    global.__outreachDb = createConnection();
  }
  return global.__outreachDb;
}
