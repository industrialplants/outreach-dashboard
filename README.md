# industrial plants — Outreach Dashboard

KI-Outreach-Service für B2B-Kunden. Clay generiert personalisierte Nachrichten und
schickt sie per Webhook. Kunden sehen ihre Leads, geben Nachrichten frei oder lehnen
sie ab und verfolgen KPIs.

Gebaut mit **Next.js 16** (App Router, TypeScript) und **better-sqlite3**. Plain CSS,
kein Tailwind. Akzentfarbe `#FF0E4E`, Hintergrund `#0e0d0d`.

## Starten

```bash
npm run dev
```

Beim ersten Start wird automatisch eine SQLite-Datenbank unter `data/outreach.db`
angelegt und mit zwei Demo-Kunden inkl. Beispiel-Leads befüllt.

## Zugang

Der Zugang läuft über einen Token in der URL:

| Rolle  | URL                      | Sieht                                    |
| ------ | ------------------------ | ---------------------------------------- |
| Admin  | `/?token=admin`          | Alle Kunden-Boards + Kunden-Switch o. r. |
| Kunde  | `/?token=acme-token`     | Nur die eigenen Leads                    |
| Kunde  | `/?token=nordwind-token` | Nur die eigenen Leads                    |

Der Admin wechselt über das Dropdown oben rechts zwischen den Boards
(`/?token=admin&client=<KUNDENTOKEN>`). Der Admin-Token lässt sich per
Umgebungsvariable `ADMIN_TOKEN` überschreiben.

## Webhook (Clay)

Clay sendet pro Lead ein `POST` an `/api/webhook`:

```bash
curl -X POST http://localhost:3000/api/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Max Mustermann",
    "company": "Muster GmbH",
    "title": "Head of Ops",
    "linkedin_url": "https://linkedin.com/in/max",
    "email": "max@muster.de",
    "generated_message": "Hallo Max, ...",
    "research_summary": "Muster GmbH expandiert ...",
    "signal": "Neue Finanzierungsrunde",
    "client_token": "acme-token"
  }'
```

- `client_token` ist Pflicht. Ist der Token unbekannt, wird der Kunde automatisch
  angelegt (Board erscheint sofort für den Admin).
- Jeder neue Lead startet im Status **Neu**.

## Leads & Status

Statuslauf: **Neu → Freigegeben → Abgelehnt → Gesendet → Geantwortet → Call gebucht**.

- Status per Dropdown pro Lead änderbar.
- Schnellaktionen **Freigeben** / **Ablehnen** / **Kommentar**.
- Nachricht + Research pro Lead aufklappbar.

## KPIs & Report

- **Outreaches diese Woche** – neue Leads seit Montag dieser Woche.
- **Antwortrate** – Antworten (inkl. Calls) im Verhältnis zu gesendeten Nachrichten.
- **Gebuchte Calls** – Leads im Status *Call gebucht*.
- **Wochenreport** – Tab mit Leads/Freigaben/Sendungen/Antworten/Calls je Kalenderwoche.

## Struktur

```
app/
  page.tsx                 Server Component: Token -> Board-Auflösung
  layout.tsx
  globals.css              Design (plain CSS)
  components/
    Dashboard.tsx          Client Component: Tabs, KPIs, Leads, Report
    AccessGate.tsx         Zugangsseite bei fehlendem/ungültigem Token
  api/
    webhook/route.ts       POST von Clay
    leads/[id]/route.ts    PATCH Status/Kommentar
lib/
  db.ts                    better-sqlite3, Schema, Seed
  store.ts                 Queries, KPIs, Wochenreport
  types.ts                 Typen, Status-Labels
```

## API

| Methode | Pfad             | Zweck                                     |
| ------- | ---------------- | ----------------------------------------- |
| `POST`  | `/api/webhook`   | Lead von Clay empfangen                   |
| `GET`   | `/api/webhook`   | Health-Check                              |
| `PATCH` | `/api/leads/:id` | Status/Kommentar ändern (Token-geschützt) |
