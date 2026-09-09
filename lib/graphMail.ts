// Sends outreach emails through Microsoft Graph using an app-only
// (client-credentials) OAuth flow — no human login involved. The Azure app
// registration behind this must have the Mail.Send *application* permission
// with admin consent, and ideally an Application Access Policy restricting
// it to exactly the configured sender mailbox.
//
// Credentials are passed in per client (see lib/sendConfig.ts) rather than
// read from global env vars, so several clients can each send from their own
// tenant and mailbox.

import type { MicrosoftSendConfig } from "./sendConfig";

interface GraphTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

async function getGraphAccessToken(config: MicrosoftSendConfig): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );

  const data = (await res.json()) as GraphTokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Graph-Token konnte nicht geholt werden: ${data.error ?? res.status} ${data.error_description ?? ""}`,
    );
  }
  return data.access_token;
}

export async function sendMailViaGraph(
  config: MicrosoftSendConfig,
  params: { to: string; subject: string; body: string },
): Promise<void> {
  const accessToken = await getGraphAccessToken(config);

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.sender)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: params.subject,
          body: { contentType: "Text", content: params.body },
          toRecipients: [{ emailAddress: { address: params.to } }],
        },
        saveToSentItems: true,
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph sendMail fehlgeschlagen (${res.status}): ${text}`);
  }
}
