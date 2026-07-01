// Shown when no token is provided or the token doesn't match any board.
export default function AccessGate({
  reason,
}: {
  reason: "missing" | "invalid";
}) {
  return (
    <main className="gate">
      <div className="gate-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">industrial plants</span>
        </div>
        <h1>Outreach Dashboard</h1>
        <p className="gate-text">
          {reason === "missing"
            ? "Bitte öffne dein Dashboard über deinen persönlichen Zugangs-Link."
            : "Dieser Zugangs-Token ist ungültig. Bitte prüfe deinen Link oder wende dich an dein industrial-plants-Team."}
        </p>
        <p className="gate-hint">
          Zugang erfolgt über <code>/?token=DEIN_TOKEN</code>
        </p>
      </div>
    </main>
  );
}
