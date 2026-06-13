// Payment success page — rendered after Stripe redirects back on a completed
// checkout. Deliberately sparse: we do NOT mark the link paid here (that is the
// Connect webhook's job, Prompt 4). Just acknowledge the submission.

export default function PayDonePage() {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: "#f8fafb",
        padding: "24px",
      }}
    >
      <div
        style={{
          maxWidth: 440,
          width: "100%",
          background: "#fff",
          borderRadius: 16,
          padding: "40px 36px",
          boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: "#dcfce7",
            border: "2px solid #16a34a",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 20px",
            fontSize: 24,
          }}
        >
          ✓
        </div>
        <h1
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#0f172a",
            margin: "0 0 10px",
          }}
        >
          Payment submitted
        </h1>
        <p style={{ fontSize: 14, color: "#64748b", fontWeight: 500, margin: 0 }}>
          Your payment is being processed. You&apos;ll receive a confirmation once
          it has cleared. You can close this page.
        </p>
      </div>
    </main>
  );
}
