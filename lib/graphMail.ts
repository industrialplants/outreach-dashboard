// Sends outreach emails through Microsoft Graph using an app-only
// (client-credentials) OAuth flow — no human login involved. The Azure app
// registration behind this must have the Mail.Send *application* permission
// with admin consent, and ideally an Application Access Policy restricting
// it to exactly the sender mailbox configured below.

interface GraphTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

async function getGraphAccessToken(): Promise<string> {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "MS_TENANT_ID, MS_CLIENT_ID und MS_CLIENT_SECRET müssen als Environment Variables gesetzt sein.",
    );
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
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

export async function sendMailViaGraph(params: {
  to: string;
  subject: string;
  body: string;
}): Promise<void> {
  const sender = process.env.MS_SENDER_EMAIL;
  if (!sender) {
    throw new Error("MS_SENDER_EMAIL muss als Environment Variable gesetzt sein.");
  }

  const accessToken = await getGraphAccessToken();

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
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
