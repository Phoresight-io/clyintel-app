"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import { invoiceServices, importedClients, MANUAL_FIELDS, InvoiceService, ImportedClient } from "@/lib/mock-data";

type Stage = "connect" | "connecting" | "select" | "analyzing" | "manual";

type ManualForm = Record<string, string>;

export default function ConnectionsScreen() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("mode") === "manual") return "manual";
    }
    return "connect";
  });
  const [selectedService, setSelectedService] = useState<InvoiceService | null>(null);
  const [pickedClient, setPickedClient] = useState<ImportedClient | null>(null);
  const [manualForm, setManualForm] = useState<ManualForm>({ client: "", invoice: "", amount: "", dueDate: "", terms: "Net 30", notes: "" });
  const [manualSubmitted, setManualSubmitted] = useState(false);

  const handleServiceClick = (svc: InvoiceService) => {
    if (svc.id === "manual") { setSelectedService(svc); setStage("manual"); return; }
    setSelectedService(svc);
    setStage("connecting");
    setTimeout(() => setStage("select"), 1600);
  };

  const handleClientPick = (c: ImportedClient) => {
    setPickedClient(c);
    setStage("analyzing");
    setTimeout(() => router.push("/"), 2000);
  };

  const integrations = invoiceServices.filter(s => s.id !== "gdrive" && s.id !== "manual");
  const gdriveService = invoiceServices.find(s => s.id === "gdrive")!;
  const manualService = invoiceServices.find(s => s.id === "manual")!;

  return (
    <div style={{ padding: "36px 48px", minHeight: 520, fontFamily: C.sans }}>
      <style>{`
        @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes bar{from{width:0%}to{width:100%}}
        button:focus-visible,a:focus-visible{outline:2px solid #2B6CB0;outline-offset:2px}
      `}</style>

      {stage === "connect" && (
        <>
          <button onClick={() => router.push("/")} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", fontSize: 14, fontWeight: 600, color: C.blue, background: "transparent", border: "none", cursor: "pointer", marginBottom: 20 }} onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")} onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}>
            <span style={{ fontSize: 16 }}>←</span> Back to Recovery
          </button>

          <div style={{ maxWidth: 860, margin: "0 auto", textAlign: "center" }}>
            <div style={{ marginBottom: 40 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 4 }}>Clyintel</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: C.navy, marginBottom: 8 }}>Add Client</div>
              <div style={{ fontSize: 15, color: C.textMid }}>Connect your invoice source, import a file, or enter an invoice manually.</div>
            </div>

            <div style={{ marginBottom: 36 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>Connect an Integration</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
                {integrations.map(svc => (
                  <div key={svc.id} onClick={() => handleServiceClick(svc)} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "28px 20px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center", transition: "border-color 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.boxShadow = `0 0 0 3px ${C.blueBg}`; }} onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = "none"; }}>
                    <div style={{ width: 56, height: 56, borderRadius: 14, background: svc.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <span style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>{svc.initial}</span>
                    </div>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{svc.name}</div>
                      <div style={{ fontSize: 12, color: C.textDim, marginTop: 4 }}>{svc.subtitle}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 36 }}>
              <div style={{ flex: 1, height: 1, background: C.border }} />
              <div style={{ fontSize: 12, color: C.textDim, fontWeight: 500 }}>or</div>
              <div style={{ flex: 1, height: 1, background: C.border }} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {[gdriveService, manualService].map(svc => (
                <div key={svc.id} onClick={() => handleServiceClick(svc)} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "28px 28px", cursor: "pointer", display: "flex", alignItems: "center", gap: 18, textAlign: "left", transition: "border-color 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.boxShadow = `0 0 0 3px ${C.blueBg}`; }} onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = "none"; }}>
                  <div style={{ width: 56, height: 56, borderRadius: 14, background: svc.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>{svc.initial}</span>
                  </div>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{svc.name}</div>
                    <div style={{ fontSize: 13, color: C.textDim, marginTop: 4 }}>{svc.subtitle}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {stage === "connecting" && selectedService && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 360 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: selectedService.color, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 18 }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: "#fff" }}>{selectedService.initial}</span>
          </div>
          <div style={{ fontSize: 15, fontWeight: 500, color: C.text, marginBottom: 6 }}>Connecting to {selectedService.name}...</div>
          <div style={{ fontSize: 13, color: C.textMid, marginBottom: 24 }}>Syncing invoice history</div>
          <div style={{ width: 280, height: 4, background: C.border, borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", background: C.blue, borderRadius: 2, animation: "bar 1.6s ease forwards" }} />
          </div>
        </div>
      )}

      {stage === "select" && selectedService && (
        <>
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ width: 20, height: 20, borderRadius: 5, background: selectedService.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 8, fontWeight: 700, color: "#fff" }}>{selectedService.initial}</span>
              </div>
              <span style={{ fontSize: 12, color: C.green, fontWeight: 500 }}>✓ {selectedService.name} connected</span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 600, color: C.text, marginBottom: 6 }}>Select a client</div>
            <div style={{ fontSize: 13, color: C.textMid }}>Choose a client to analyze and score.</div>
          </div>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", maxWidth: 580 }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 90px 110px", padding: "9px 16px", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
              {["Client", "Invoices", "Balance"].map(h => (
                <span key={h} style={{ fontSize: 11, fontWeight: 600, color: C.textMid, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</span>
              ))}
            </div>
            {importedClients.map((c, i) => (
              <div key={c.name} onClick={() => handleClientPick(c)} style={{ display: "grid", gridTemplateColumns: "2fr 90px 110px", alignItems: "center", padding: "13px 16px", borderBottom: i < importedClients.length - 1 ? `1px solid ${C.border}` : "none", cursor: "pointer" }} onMouseEnter={(e) => (e.currentTarget.style.background = C.blueBg)} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <div style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{c.name}</div>
                <div style={{ fontSize: 13, color: C.textMid, fontFamily: C.mono }}>{c.invoices}</div>
                <div style={{ fontSize: 13, fontWeight: 500, color: c.balance > 0 ? C.text : C.textDim, fontFamily: C.mono }}>{c.balance > 0 ? `$${c.balance.toLocaleString()}` : "—"}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {stage === "analyzing" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 360 }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: C.text, marginBottom: 6 }}>Analyzing {pickedClient?.name}...</div>
          <div style={{ fontSize: 13, color: C.textMid, marginBottom: 24 }}>Scoring invoice history and calculating risk</div>
          <div style={{ width: 280, height: 4, background: C.border, borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", background: C.blue, borderRadius: 2, animation: "bar 2s ease forwards" }} />
          </div>
        </div>
      )}

      {stage === "manual" && !manualSubmitted && (
        <>
          <button onClick={() => setStage("connect")} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", fontSize: 14, fontWeight: 600, color: C.blue, background: "transparent", border: "none", cursor: "pointer", marginBottom: 12 }} onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")} onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}>
            <span style={{ fontSize: 16 }}>←</span> Back
          </button>
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 22, fontWeight: 600, color: C.text, marginBottom: 6 }}>Create Invoice Manually</div>
            <div style={{ fontSize: 13, color: C.textMid }}>Enter invoice details to add a client and invoice to Clyintel.</div>
          </div>
          <div style={{ maxWidth: 520, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "28px 32px" }}>
            {MANUAL_FIELDS.map(field => (
              <div key={field.id} style={{ marginBottom: 20 }}>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>{field.label}</label>
                {field.type === "select" ? (
                  <select value={manualForm[field.id]} onChange={(e) => setManualForm({ ...manualForm, [field.id]: e.target.value })} style={{ width: "100%", padding: "9px 12px", fontSize: 13, border: `1px solid ${C.border}`, borderRadius: 6, background: "#FFFFFF", color: C.text, outline: "none" }}>
                    {(field.options || []).map(o => <option key={o}>{o}</option>)}
                  </select>
                ) : field.type === "textarea" ? (
                  <textarea value={manualForm[field.id]} onChange={(e) => setManualForm({ ...manualForm, [field.id]: e.target.value })} placeholder={field.placeholder} rows={3} style={{ width: "100%", padding: "9px 12px", fontSize: 13, border: `1px solid ${C.border}`, borderRadius: 6, background: "#FFFFFF", color: C.text, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box", outline: "none" }} />
                ) : (
                  <input type={field.type} value={manualForm[field.id]} onChange={(e) => setManualForm({ ...manualForm, [field.id]: e.target.value })} placeholder={field.placeholder} style={{ width: "100%", padding: "9px 12px", fontSize: 13, border: `1px solid ${C.border}`, borderRadius: 6, background: "#FFFFFF", color: C.text, boxSizing: "border-box", outline: "none" }} />
                )}
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
              <button onClick={() => setStage("connect")} style={{ padding: "9px 18px", fontSize: 13, fontWeight: 600, color: C.textMid, background: "#FFFFFF", border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => { setManualSubmitted(true); setTimeout(() => router.push("/"), 1800); }} style={{ padding: "9px 18px", fontSize: 13, fontWeight: 600, color: "#FFFFFF", background: C.blue, border: "none", borderRadius: 6, cursor: "pointer" }} onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.88")} onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}>Save Invoice</button>
            </div>
          </div>
        </>
      )}

      {stage === "manual" && manualSubmitted && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 360 }}>
          <div style={{ fontSize: 32, marginBottom: 16, color: C.green }}>✓</div>
          <div style={{ fontSize: 15, fontWeight: 500, color: C.text, marginBottom: 6 }}>Invoice saved</div>
          <div style={{ fontSize: 13, color: C.textMid }}>Returning to dashboard...</div>
        </div>
      )}
    </div>
  );
}
