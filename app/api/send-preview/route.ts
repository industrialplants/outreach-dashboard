import { NextResponse } from "next/server";
import { ADMIN_TOKEN } from "@/lib/db";
import { getClient, listSendableEmails } from "@/lib/store";
import { getSendConfigs } from "@/lib/sendConfig";

// GET /api/send-preview?token=<admin or client token>[&client=<clientToken>]
// Read-only — shows who WOULD be emailed on the next automated run, without
// sending anything. Available to admin (any board, via &client=) and to a
// client themself (their own board only).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim();
  const requestedClient = url.searchParams.get("client")?.trim();

  if (!token) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let clientToken: string | undefined;
  if (token === ADMIN_TOKEN) {
    clientToken = requestedClient;
  } else {
    const client = await getClient(token);
    if (!client) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    clientToken = client.token;
  }

  if (!clientToken) {
    return NextResponse.json({ error: "Kein Kunde angegeben" }, { status: 400 });
  }

  // Automatic sending is only active for clients that appear in SEND_CONFIG.
  // A misconfigured SEND_CONFIG shouldn't break the preview for everyone, so
  // a parse error is reported as "not active" rather than thrown.
  let sendConfigured = false;
  let provider: string | undefined;
  try {
    const configs = getSendConfigs();
    const cfg = configs[clientToken];
    sendConfigured = !!cfg;
    provider = cfg?.provider;
  } catch {
    sendConfigured = false;
  }

  if (!sendConfigured) {
    return NextResponse.json({ active: false, leads: [] });
  }

  const leads = await listSendableEmails(clientToken, 10);
  return NextResponse.json({
    active: true,
    provider,
    leads: leads.map((l) => ({
      id: l.id,
      name: l.name,
      company: l.company,
      email: l.email,
    })),
  });
}
