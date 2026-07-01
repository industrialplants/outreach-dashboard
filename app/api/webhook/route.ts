import { NextResponse } from "next/server";
import { createLead, ensureClient } from "@/lib/store";
import type { WebhookPayload } from "@/lib/types";

// Clay POSTs a personalized outreach message here for each generated lead.
export async function POST(request: Request) {
  let payload: WebhookPayload;
  try {
    payload = (await request.json()) as WebhookPayload;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const clientToken = payload.client_token?.trim();
  if (!clientToken) {
    return NextResponse.json(
      { error: "client_token is required" },
      { status: 400 },
    );
  }

  // Register the client on first contact so new boards appear automatically.
  ensureClient(clientToken, payload.company);

  const lead = createLead({ ...payload, client_token: clientToken });

  return NextResponse.json({ ok: true, id: lead.id }, { status: 201 });
}

// Small health check so hitting the URL in a browser confirms it's wired up.
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "clay outreach webhook",
    expects: "POST JSON { name, company, title, linkedin_url, email, generated_message, research_summary, signal, client_token }",
  });
}
