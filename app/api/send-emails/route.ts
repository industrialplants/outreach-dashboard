import { NextResponse } from "next/server";
import { ADMIN_TOKEN } from "@/lib/db";
import { listSendableEmails, updateLead } from "@/lib/store";
import { sendMailViaGraph } from "@/lib/graphMail";

// How many emails to send per run — deliberately small. This runs every 15
// minutes (Vercel Pro cron), so a modest batch size avoids ever sending a
// big burst at once; the queue just gets worked through steadily.
const BATCH_SIZE = 10;

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

async function run(): Promise<{
  sent: number;
  failed: number;
  errors: string[];
}> {
  const clientToken = process.env.MS_SEND_CLIENT_TOKEN;
  if (!clientToken) {
    throw new Error(
      "MS_SEND_CLIENT_TOKEN ist nicht gesetzt — für welchen Kunden soll automatisch gesendet werden?",
    );
  }

  const leads = await listSendableEmails(clientToken, BATCH_SIZE);
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const lead of leads) {
    try {
      await sendMailViaGraph({
        to: lead.email,
        subject: lead.email_subject || "(kein Betreff)",
        body: lead.email_body,
      });
      await updateLead(lead.id, {
        email_sent_at: new Date().toISOString(),
        status: "sent",
        isAdminEdit: true,
      });
      sent++;
    } catch (err) {
      failed++;
      errors.push(`${lead.name} <${lead.email}>: ${(err as Error).message}`);
    }
  }

  return { sent, failed, errors };
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
export async function POST(request: Request) {
  let body: { adminToken?: string } = {};
  try {
    body = (await request.json()) as { adminToken?: string };
  } catch {
    // no body is fine too
  }
  if (body.adminToken !== ADMIN_TOKEN && !isAuthorized(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
