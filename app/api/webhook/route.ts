import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ensureClient, upsertLead } from "@/lib/store";
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
    email_subject: str(fields.email_subject),
    email_body: str(fields.email_body),
    research_summary: str(fields.research_summary),
    signal: str(fields.signal),
    client_token: str(fields.client_token),
  };
}

function paramsToRecord(params: URLSearchParams): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const [key, value] of params) obj[key] = value;
  return obj;
}

// Parse the request into a plain record, accepting either JSON or
// application/x-www-form-urlencoded. Clay occasionally sends JSON with
// unescaped quotes (invalid JSON); form encoding sidesteps that entirely,
// and we also fall back to form parsing if a JSON body fails to parse.
// If the body is empty, fall back to query parameters
// (?name=...&company=...&linkedin_url=...&generated_message=...&signal=...&client_token=...).
async function parseBody(
  request: NextRequest,
): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  const raw = (await request.text()).trim();

  if (!raw) {
    const query = request.nextUrl.searchParams;
    return query.size > 0 ? paramsToRecord(query) : null;
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return paramsToRecord(new URLSearchParams(raw));
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // Not valid JSON — maybe it's form data sent with a wrong/missing
    // content-type. Only treat it as form data if it actually looks like it.
    if (raw.includes("=")) return paramsToRecord(new URLSearchParams(raw));
    return null;
  }
}

// Clay POSTs a personalized outreach message here for each generated lead.
export async function POST(request: NextRequest) {
  const fields = await parseBody(request);
  if (!fields) {
    return NextResponse.json(
      {
        error:
          "Provide fields as JSON, application/x-www-form-urlencoded, or query parameters",
      },
      { status: 400 },
    );
  }

  // Debug: check whether Clay actually sends a "title" and what it looks like.
  console.log("[webhook] incoming title:", JSON.stringify(fields.title));
  // Temporary debug: confirm whether Clay is sending email_subject/email_body
  // at all, and what they contain. Remove once the email display is confirmed working.
  console.log(
    "[webhook] incoming email_subject:",
    JSON.stringify(fields.email_subject),
  );
  console.log(
    "[webhook] incoming email_body:",
    JSON.stringify(fields.email_body),
  );
  console.log("[webhook] all incoming keys:", JSON.stringify(Object.keys(fields)));

  const payload = toPayload(fields);

  const clientToken = payload.client_token?.trim();
  if (!clientToken) {
    return NextResponse.json(
      { error: "client_token is required" },
      { status: 400 },
    );
  }

  // Clay sends rows before they're enriched; skip anything without an actual
  // outreach message (LinkedIn or email) so the board never fills up with
  // empty leads.
  if (!payload.generated_message?.trim() && !payload.email_body?.trim()) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Register the client on first contact so new boards appear automatically.
  await ensureClient(clientToken, payload.company);

  // Clay sometimes sends names with stray newlines — flatten them to spaces
  // so the value stays a clean single line.
  const name = payload.name?.trim().replace(/\n/g, " ");

  const lead = await upsertLead({ ...payload, client_token: clientToken, name });

  return NextResponse.json({ ok: true, id: lead.id }, { status: 201 });
}

// Small health check so hitting the URL in a browser confirms it's wired up.
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "clay outreach webhook",
    accepts: "application/json or application/x-www-form-urlencoded",
    expects:
      "POST { name, company, title, linkedin_url, email, generated_message, email_subject, email_body, research_summary, signal, client_token }",
  });
}
