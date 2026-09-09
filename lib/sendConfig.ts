// Per-client configuration for the automated email send job.
//
// Before 31.08.2026 the sender was hardwired to a single client via the
// MS_SEND_CLIENT_TOKEN env var — a documented limitation that blocked adding
// a second client. This replaces it with a per-client config.
//
// Credentials deliberately live in ONE env var (SEND_CONFIG) rather than in
// the database: they stay in Vercel's encrypted env store, never in Turso,
// and never in a backup dump that gets copied to someone's desktop. The
// tradeoff is that adding a client means editing the env var instead of
// clicking something in the UI — acceptable at two or three clients, and the
// safer default for secrets.

export interface MicrosoftSendConfig {
  provider: "microsoft";
  tenantId: string;
  clientId: string;
  clientSecret: string;
  sender: string; // the mailbox emails are sent from
}

export interface GhlSendConfig {
  provider: "ghl";
  locationId: string;
  token: string; // Private Integration Token, scoped to this sub-account
  fromName?: string; // optional display name, e.g. "Anna Leta Chichava"
  fromEmail?: string; // optional explicit sender address
}

export type ClientSendConfig = MicrosoftSendConfig | GhlSendConfig;

// Shape of SEND_CONFIG: an object keyed by client_token.
//
//   {
//     "bonusleben-26": {
//       "provider": "microsoft",
//       "tenantId": "…", "clientId": "…", "clientSecret": "…",
//       "sender": "sebastian.lahr@bonusleben.de"
//     },
//     "industrialplants": {
//       "provider": "ghl",
//       "locationId": "…", "token": "pit-…",
//       "fromName": "Anna Leta Chichava"
//     }
//   }
export function getSendConfigs(): Record<string, ClientSendConfig> {
  const raw = process.env.SEND_CONFIG?.trim();

  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        "SEND_CONFIG ist kein gültiges JSON. Bitte in Vercel prüfen (häufigste Ursache: ein fehlendes Komma oder Anführungszeichen).",
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("SEND_CONFIG muss ein JSON-Objekt sein, keyed nach client_token.");
    }

    const result: Record<string, ClientSendConfig> = {};
    for (const [token, cfg] of Object.entries(parsed as Record<string, unknown>)) {
      result[token] = validateConfig(token, cfg);
    }
    return result;
  }

  // Backwards compatibility: if SEND_CONFIG isn't set yet, fall back to the
  // original single-client Microsoft env vars so the BonusLeben send keeps
  // working unchanged until SEND_CONFIG is filled in.
  const legacyToken = process.env.MS_SEND_CLIENT_TOKEN?.trim();
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  const sender = process.env.MS_SENDER_EMAIL;

  if (legacyToken && tenantId && clientId && clientSecret && sender) {
    return {
      [legacyToken]: { provider: "microsoft", tenantId, clientId, clientSecret, sender },
    };
  }

  return {};
}

function validateConfig(token: string, cfg: unknown): ClientSendConfig {
  if (typeof cfg !== "object" || cfg === null) {
    throw new Error(`SEND_CONFIG: Eintrag für "${token}" ist kein Objekt.`);
  }
  const c = cfg as Record<string, unknown>;
  const provider = c.provider;

  if (provider === "microsoft") {
    for (const field of ["tenantId", "clientId", "clientSecret", "sender"]) {
      if (typeof c[field] !== "string" || !(c[field] as string).trim()) {
        throw new Error(`SEND_CONFIG: "${token}" (microsoft) — Feld "${field}" fehlt.`);
      }
    }
    return {
      provider: "microsoft",
      tenantId: String(c.tenantId),
      clientId: String(c.clientId),
      clientSecret: String(c.clientSecret),
      sender: String(c.sender),
    };
  }

  if (provider === "ghl") {
    for (const field of ["locationId", "token"]) {
      if (typeof c[field] !== "string" || !(c[field] as string).trim()) {
        throw new Error(`SEND_CONFIG: "${token}" (ghl) — Feld "${field}" fehlt.`);
      }
    }
    return {
      provider: "ghl",
      locationId: String(c.locationId),
      token: String(c.token),
      fromName: typeof c.fromName === "string" ? c.fromName : undefined,
      fromEmail: typeof c.fromEmail === "string" ? c.fromEmail : undefined,
    };
  }

  throw new Error(
    `SEND_CONFIG: "${token}" — "provider" muss "microsoft" oder "ghl" sein (war: ${String(provider)}).`,
  );
}
