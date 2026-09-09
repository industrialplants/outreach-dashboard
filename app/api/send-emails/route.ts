import { NextResponse } from "next/server";
import { ADMIN_TOKEN } from "@/lib/db";
import { listSendableEmails, updateLead } from "@/lib/store";
import { sendMailViaGraph } from "@/lib/graphMail";
import { sendMailViaGhl } from "@/lib/ghlMail";
import { getSendConfigs } from "@/lib/sendConfig";

// Exactly one email per client per run — spread naturally across the Mon-Wed
// 7-18 window (one every 15 minutes) instead of a burst within a single
// minute, which reads as automated/spammy to receiving mail servers and
// risks deliverability. Decided with the client 14.08.2026.
//
// Deliberately per CLIENT, not per run overall: each client sends from their
// own mailbox with its own sending reputation, so they don't need to share
// one throttle. Two clients means up to two emails per 15 minutes, one each.
const BATCH_SIZE_PER_CLIENT = 1;

// Automated sends only happen Mon–Wed, 7:00–18:00 German time — matches the
// CTA wording ("Hast du diese Woche 20 Minuten?"), decided with the client
// 14.08.2026. Vercel Cron runs in UTC, so this is computed in Europe/Berlin
// local time (handles the CET/CEST switch automatically) rather than trusting
// the cron schedule alone to get timezone + DST right.
function isWithinSendWindow(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday"); // "Mon", "Tue", "Wed", ...
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const minutesSinceMidnight = hour * 60 + minute;

  const isMonToWed = ["Mon", "Tue", "Wed"].includes(weekday);
  const isWithinHours = minutesSinceMidnight >= 7 * 60 && minutesSinceMidnight <= 18 * 60;
  return isMonToWed && isWithinHours;
}

function isAuthorized(request: Request): boolean {
  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  if (process.env.CRON_SECRET && querySecret === process.env.CRON_SECRET) {
    return true;
  }
  const authHeader = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader === `Bearer ${process.env.CRON_SECRET}`
  ) {
    return true; // how Vercel Cron itself calls this once configured that way
  }
  return false;
}

interface RunResult {
  sent: number;
  failed: number;
  errors: string[];
  perClient: Record<string, { sent: number; failed: number }>;
}

// Runs the send for every configured client. `onlyClient` restricts it to a
// single client — used by the manual "Jetzt senden" button so the admin can
// trigger one board without touching the others.
async function run(onlyClient?: string): Promise<RunResult> {
  const configs = getSendConfigs();
  const tokens = onlyClient
    ? Object.keys(configs).filter((t) => t === onlyClient)
    : Object.keys(configs);

  if (tokens.length === 0) {
    throw new Error(
      onlyClient
        ? `Für "${onlyClient}" ist kein automatischer Versand konfiguriert (siehe SEND_CONFIG).`
        : "Kein Kunde für automatischen Versand konfiguriert — SEND_CONFIG ist leer oder nicht gesetzt.",
    );
  }

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  const perClient: Record<string, { sent: number; failed: number }> = {};

  for (const token of tokens) {
    const config = configs[token];
    perClient[token] = { sent: 0, failed: 0 };

    // One client's broken credentials must never stop the others from
    // sending, so each client is wrapped individually.
    let leads;
    try {
      leads = await listSendableEmails(token, BATCH_SIZE_PER_CLIENT);
    } catch (err) {
      failed++;
      perClient[token].failed++;
      errors.push(`[${token}] Warteschlange konnte nicht gelesen werden: ${(err as Error).message}`);
      continue;
    }

    for (const lead of leads) {
      try {
        if (config.provider === "microsoft") {
          await sendMailViaGraph(config, {
            to: lead.email,
            subject: lead.email_subject || "(kein Betreff)",
            body: lead.email_body,
          });
        } else {
          await sendMailViaGhl(config, {
            to: lead.email,
            subject: lead.email_subject || "(kein Betreff)",
            body: lead.email_body,
            name: lead.name,
            company: lead.company,
          });
        }

        await updateLead(lead.id, {
          email_sent_at: new Date().toISOString(),
          isAdminEdit: true,
        });
        sent++;
        perClient[token].sent++;
      } catch (err) {
        failed++;
        perClient[token].failed++;
        errors.push(`[${token}] ${lead.name} <${lead.email}>: ${(err as Error).message}`);
      }
    }
  }

  return { sent, failed, errors, perClient };
}

// GET so Vercel Cron can call it directly. This is the automatic path, so
// it's the one that respects the Mon–Wed 7–18 send window.
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isWithinSendWindow(new Date())) {
    return NextResponse.json({ ok: true, skipped: "outside_send_window" });
  }
  try {
    const result = await run();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

// POST for the manual "Jetzt senden" button in the admin UI, authorized via
// the same admin token used everywhere else in the dashboard. Deliberately
// bypasses the send window — it's the explicit override for "something
// urgent needs to go out right now", so it should always work.
//
// `clientToken` restricts it to the board currently selected in the UI, so
// clicking the button on one client's board never sends for another.
export async function POST(request: Request) {
  let body: { adminToken?: string; clientToken?: string } = {};
  try {
    body = (await request.json()) as { adminToken?: string; clientToken?: string };
  } catch {
    // no body is fine too
  }
  if (body.adminToken !== ADMIN_TOKEN && !isAuthorized(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const result = await run(body.clientToken);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
