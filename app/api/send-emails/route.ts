import { NextResponse } from "next/server";
import { ADMIN_TOKEN } from "@/lib/db";
import { listSendableEmails, updateLead } from "@/lib/store";
import { sendMailViaGraph } from "@/lib/graphMail";

// How many emails to send per run — deliberately small. This runs every 15
// minutes (Vercel Pro cron), so a modest batch size avoids ever sending a
// big burst at once; the queue just gets worked through steadily.
const BATCH_SIZE = 10;

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

// GET so Vercel Cron can call it directly; also used by the manual button.
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
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

// POST for the manual "Jetzt senden" button in the admin UI, authorized via
// the same admin token used everywhere else in the dashboard.
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
