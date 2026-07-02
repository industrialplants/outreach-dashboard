import { NextResponse } from "next/server";
import { createLead, ensureClient } from "@/lib/store";
import type { WebhookPayload } from "@/lib/types";

// Coerce an arbitrary field value into a trimmed string (or undefined).
function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

// Pick the fields we care about out of a loosely-typed record. Works the same
// whether the record came from JSON or from urlencoded form data.
function toPayload(fields: Record<string, unknown>): WebhookPayload {
  return {
    name: str(fields.name),
    company: str(fields.company),
    title: str(fields.title),
    linkedin_url: str(fields.linkedin_url),
    email: str(fields.email),
    generated_message: str(fields.generated_message),
    research_summary: str(fields.research_summary),
    signal: str(fields.signal),
    client_token: str(fields.client_token),
  };
}

function formToRecord(raw: string): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) obj[key] = value;
  return obj;
}

// Parse the request body into a plain record, accepting either JSON or
// application/x-www-form-urlencoded. Clay occasionally sends JSON with
// unescaped quotes (invalid JSON); form encoding sidesteps that entirely,
// and we also fall back to form parsing if a JSON body fails to parse.
async function parseBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  const raw = await request.text();

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return formToRecord(raw);
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // Not valid JSON — maybe it's form data sent with a wrong/missing
    // content-type. Only treat it as form data if it actually looks like it.
    if (raw.includes("=")) return formToRecord(raw);
    return null;
  }
}

// Clay POSTs a personalized outreach message here for each generated lead.
export async function POST(request: Request) {
  const fields = await parseBody(request);
  if (!fields) {
    return NextResponse.json(
      { error: "Body must be JSON or application/x-www-form-urlencoded" },
      { status: 400 },
    );
  }

  const payload = toPayload(fields);

  const clientToken = payload.client_token?.trim();
  if (!clientToken) {
    return NextResponse.json(
      { error: "client_token is required" },
      { status: 400 },
    );
  }

  // Register the client on first contact so new boards appear automatically.
  await ensureClient(clientToken, payload.company);

  // Clay sometimes sends names with stray newlines — flatten them to spaces
  // so the value stays a clean single line.
  const name = payload.name?.trim().replace(/\n/g, " ");

  const lead = await createLead({ ...payload, client_token: clientToken, name });

  return NextResponse.json({ ok: true, id: lead.id }, { status: 201 });
}

// Small health check so hitting the URL in a browser confirms it's wired up.
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "clay outreach webhook",
    accepts: "application/json or application/x-www-form-urlencoded",
    expects:
      "POST { name, company, title, linkedin_url, email, generated_message, research_summary, signal, client_token }",
  });
}
