export type ClientStatus = "current" | "due" | "past_due" | "recovered";

export interface Client {
  id: number;
  name: string;
  industry: string;
  score: number;
  status: ClientStatus;
  balance: number;
  daysOverdue: number;
  invoices: number;
  lastActivity: string;
  nextAction: string;
}

export interface Invoice {
  id: string;
  amount: number;
  dueDate: string;
  status: string;
  lastActivity: string;
  nextAction?: string;
  daysOverdue?: number;
  daysUntilDue?: number;
  paidDate?: string;
}

export interface ClientInvoiceSet {
  outstanding: Invoice[];
  upcoming: Invoice[];
  paid: Invoice[];
}

export interface Exchange {
  timestamp: string;
  channel: string;
  from: string;
  to: string;
  contact: string;
  message: string;
  outcome: string;
}

export interface NegotiationRec {
  id: string;
  client: string;
  industry: string;
  invoiceAmount: number;
  daysOverdue: number;
  dueDate: string;
  score: number;
  suggestedAmount: number;
  rationale: string;
  riskOfFullLoss: string;
  expectedRecovery: string;
  alternativeOutcome: string;
  lastContact: string;
}

export interface InvoiceService {
  id: string;
  name: string;
  color: string;
  initial: string;
  subtitle: string;
}

export interface ImportedClient {
  name: string;
  invoices: number;
  balance: number;
}

export interface ManualField {
  id: string;
  label: string;
  type: string;
  placeholder: string;
  options?: string[];
}

export const clients: Client[] = [
  { id: 1, name: "Harlow & Co.", industry: "Retail", score: 82, status: "current", balance: 3200, daysOverdue: 0, invoices: 6, lastActivity: "3/15/26", nextAction: "Reminder scheduled 4/10" },
  { id: 2, name: "Meridian Group", industry: "Consulting", score: 85, status: "due", balance: 8750, daysOverdue: 3, invoices: 4, lastActivity: "3/26/26 - Email", nextAction: "Place call to AP" },
  { id: 3, name: "Vance Studio", industry: "Creative", score: 44, status: "past_due", balance: 20600, daysOverdue: 31, invoices: 8, lastActivity: "3/22/26 - Phone", nextAction: "Verify payment received" },
  { id: 4, name: "Oaks Financial", industry: "Finance", score: 91, status: "recovered", balance: 0, daysOverdue: 0, invoices: 12, lastActivity: "3/28/26 - Payment", nextAction: "None" },
  { id: 5, name: "Drift Collective", industry: "Marketing", score: 38, status: "past_due", balance: 5600, daysOverdue: 18, invoices: 3, lastActivity: "3/20/26 - Phone", nextAction: "Check for wire transfer" },
  { id: 6, name: "Kellner & Associates", industry: "Legal", score: 22, status: "past_due", balance: 18500, daysOverdue: 134, invoices: 3, lastActivity: "1/9/26 - Email", nextAction: "Negotiate recovery amount" },
  { id: 7, name: "Apex Dynamics", industry: "Manufacturing", score: 31, status: "past_due", balance: 3300, daysOverdue: 121, invoices: 5, lastActivity: "2/3/26 - Phone", nextAction: "Negotiate recovery amount" },
];

export const clientInvoices: Record<number, ClientInvoiceSet> = {
  3: {
    outstanding: [{ id: "INV-1042", amount: 12400, dueDate: "3/17/26", daysOverdue: 31, status: "past_due", lastActivity: "3/22/26 - Phone", nextAction: "Verify payment received" }],
    upcoming:    [{ id: "INV-1053", amount: 8200,  dueDate: "4/25/26", daysUntilDue: 6, status: "current", lastActivity: "—", nextAction: "Auto-reminder at -3 days" }],
    paid: [
      { id: "INV-0998", amount: 9600,  dueDate: "11/15/25", status: "paid", paidDate: "11/14/25", lastActivity: "11/14/25 - Payment" },
      { id: "INV-1006", amount: 7800,  dueDate: "12/10/25", status: "paid", paidDate: "12/22/25", lastActivity: "12/22/25 - Payment (late)" },
      { id: "INV-1017", amount: 11200, dueDate: "1/8/26",   status: "paid", paidDate: "1/24/26",  lastActivity: "1/24/26 - Payment (late)" },
      { id: "INV-1024", amount: 9400,  dueDate: "1/28/26",  status: "paid", paidDate: "2/14/26",  lastActivity: "2/14/26 - Payment (late)" },
      { id: "INV-1031", amount: 10500, dueDate: "2/20/26",  status: "paid", paidDate: "3/8/26",   lastActivity: "3/8/26 - Payment (late)" },
      { id: "INV-1039", amount: 8900,  dueDate: "3/5/26",   status: "paid", paidDate: "3/19/26",  lastActivity: "3/19/26 - Payment (late)" },
    ]
  },
  2: {
    outstanding: [{ id: "INV-1038", amount: 8750, dueDate: "3/25/26", daysOverdue: 3, status: "past_due", lastActivity: "3/26/26 - Email", nextAction: "Place call to AP" }],
    upcoming:    [{ id: "INV-1052", amount: 5400, dueDate: "4/22/26", daysUntilDue: 3, status: "current", lastActivity: "—", nextAction: "Auto-reminder scheduled" }],
    paid: [
      { id: "INV-1019", amount: 7200, dueDate: "1/20/26", status: "paid", paidDate: "1/20/26", lastActivity: "1/20/26 - Payment" },
      { id: "INV-1029", amount: 6800, dueDate: "2/18/26", status: "paid", paidDate: "2/17/26", lastActivity: "2/17/26 - Payment" },
    ]
  },
  5: {
    outstanding: [
      { id: "INV-1045", amount: 2800, dueDate: "3/30/26", daysOverdue: 18, status: "past_due", lastActivity: "3/20/26 - Phone", nextAction: "Check for wire transfer" },
      { id: "INV-1046", amount: 2800, dueDate: "4/5/26",  daysOverdue: 12, status: "past_due", lastActivity: "3/28/26 - Email", nextAction: "Follow-up call scheduled" },
    ],
    upcoming: [],
    paid: [
      { id: "INV-1033", amount: 3100, dueDate: "2/28/26", status: "paid", paidDate: "3/4/26", lastActivity: "3/4/26 - Payment (late)" },
    ]
  },
  1: {
    outstanding: [],
    upcoming: [{ id: "INV-1051", amount: 3200, dueDate: "4/14/26", daysUntilDue: -5, status: "current", lastActivity: "—", nextAction: "Reminder at -3 days" }],
    paid: [
      { id: "INV-0972", amount: 2900, dueDate: "10/12/25", status: "paid", paidDate: "10/10/25", lastActivity: "10/10/25 - Payment" },
      { id: "INV-0988", amount: 3100, dueDate: "11/10/25", status: "paid", paidDate: "11/9/25",  lastActivity: "11/9/25 - Payment" },
      { id: "INV-1003", amount: 3000, dueDate: "12/8/25",  status: "paid", paidDate: "12/8/25",  lastActivity: "12/8/25 - Payment" },
      { id: "INV-1018", amount: 3200, dueDate: "1/12/26",  status: "paid", paidDate: "1/11/26",  lastActivity: "1/11/26 - Payment" },
      { id: "INV-1034", amount: 3100, dueDate: "2/10/26",  status: "paid", paidDate: "2/10/26",  lastActivity: "2/10/26 - Payment" },
    ]
  },
  6: {
    outstanding: [{ id: "INV-0891", amount: 18500, dueDate: "12/7/25", daysOverdue: 134, status: "past_due", lastActivity: "1/9/26 - Email", nextAction: "Negotiate recovery amount" }],
    upcoming: [],
    paid: [
      { id: "INV-0841", amount: 16200, dueDate: "8/15/25",  status: "paid", paidDate: "8/15/25",  lastActivity: "8/15/25 - Payment" },
      { id: "INV-0867", amount: 17400, dueDate: "10/10/25", status: "paid", paidDate: "10/9/25",  lastActivity: "10/9/25 - Payment" },
    ]
  },
  7: {
    outstanding: [{ id: "INV-0904", amount: 3300, dueDate: "12/21/25", daysOverdue: 121, status: "past_due", lastActivity: "2/3/26 - Phone", nextAction: "Negotiate recovery amount" }],
    upcoming: [],
    paid: [
      { id: "INV-0812", amount: 4100, dueDate: "6/14/25",  status: "paid", paidDate: "6/20/25",  lastActivity: "6/20/25 - Payment (late)" },
      { id: "INV-0838", amount: 3800, dueDate: "7/28/25",  status: "paid", paidDate: "8/5/25",   lastActivity: "8/5/25 - Payment (late)" },
      { id: "INV-0857", amount: 4200, dueDate: "9/15/25",  status: "paid", paidDate: "9/30/25",  lastActivity: "9/30/25 - Payment (late)" },
      { id: "INV-0878", amount: 3600, dueDate: "10/30/25", status: "paid", paidDate: "11/12/25", lastActivity: "11/12/25 - Payment (late)" },
    ]
  },
  4: {
    outstanding: [],
    upcoming: [],
    paid: [
      { id: "INV-0701", amount: 5200,  dueDate: "4/10/25",  status: "paid", paidDate: "4/10/25",  lastActivity: "4/10/25 - Payment" },
      { id: "INV-0718", amount: 4800,  dueDate: "5/8/25",   status: "paid", paidDate: "5/7/25",   lastActivity: "5/7/25 - Payment" },
      { id: "INV-0734", amount: 5600,  dueDate: "6/5/25",   status: "paid", paidDate: "6/4/25",   lastActivity: "6/4/25 - Payment" },
      { id: "INV-0749", amount: 5100,  dueDate: "7/3/25",   status: "paid", paidDate: "7/2/25",   lastActivity: "7/2/25 - Payment" },
      { id: "INV-0762", amount: 5400,  dueDate: "7/31/25",  status: "paid", paidDate: "7/30/25",  lastActivity: "7/30/25 - Payment" },
      { id: "INV-0778", amount: 4900,  dueDate: "8/28/25",  status: "paid", paidDate: "8/27/25",  lastActivity: "8/27/25 - Payment" },
      { id: "INV-0793", amount: 5300,  dueDate: "9/25/25",  status: "paid", paidDate: "9/24/25",  lastActivity: "9/24/25 - Payment" },
      { id: "INV-0809", amount: 5000,  dueDate: "10/23/25", status: "paid", paidDate: "10/22/25", lastActivity: "10/22/25 - Payment" },
      { id: "INV-0824", amount: 5500,  dueDate: "11/20/25", status: "paid", paidDate: "11/19/25", lastActivity: "11/19/25 - Payment" },
      { id: "INV-0843", amount: 5200,  dueDate: "12/18/25", status: "paid", paidDate: "12/17/25", lastActivity: "12/17/25 - Payment" },
      { id: "INV-0858", amount: 5800,  dueDate: "1/15/26",  status: "paid", paidDate: "1/14/26",  lastActivity: "1/14/26 - Payment" },
      { id: "INV-0874", amount: 5100,  dueDate: "2/12/26",  status: "paid", paidDate: "2/11/26",  lastActivity: "2/11/26 - Payment" },
    ]
  },
};

export const invoiceExchanges: Record<string, Exchange[]> = {
  "INV-1042": [
    { timestamp: "3/8/26 11:15 AM", channel: "Voice", from: "Recovery Agent", to: "Vance Studio", contact: "+1 (555) 234-5678", message: "Attempted call to main AP line", outcome: "Voicemail left with callback request" },
    { timestamp: "3/12/26 4:32 PM", channel: "Email", from: "Recovery Agent", to: "Vance Studio", contact: "ap@vancestudio.com", message: "Initial payment reminder: Invoice #1042 for $12,400 is due on 3/17/26", outcome: "Email delivered and opened once" },
    { timestamp: "3/15/26 9:11 AM", channel: "Email", from: "Recovery Agent", to: "Vance Studio", contact: "ap@vancestudio.com", message: "Follow-up: Invoice #1042 — Payment due in 3 days", outcome: "Opened. No reply." },
    { timestamp: "3/18/26 3:45 PM", channel: "Email", from: "Recovery Agent", to: "Vance Studio", contact: "ap@vancestudio.com", message: "Updated invoice PDF resent with corrected PO reference", outcome: "Message delivered successfully" },
    { timestamp: "3/19/26 10:22 AM", channel: "Email", from: "Vance Studio", to: "Recovery Agent", contact: "collections@clyintel.com", message: "Still waiting for CFO approval. PO reference looks correct now. Can we have until end of month?", outcome: "Client requested extension" },
    { timestamp: "3/19/26 2:15 PM", channel: "Email", from: "Recovery Agent", to: "Vance Studio", contact: "ap@vancestudio.com", message: "Extension granted to 3/31/26. Please confirm payment method (ACH/wire/check).", outcome: "Extension granted; awaiting payment method confirmation" },
    { timestamp: "3/20/26 10:22 AM", channel: "Email", from: "Recovery Agent", to: "Vance Studio", contact: "ap@vancestudio.com", message: "Reminder: Invoice #1042 past due status", outcome: "Email opened twice; no response" },
    { timestamp: "3/22/26 2:14 PM", channel: "Voice", from: "Recovery Agent", to: "Vance Studio", contact: "+1 (555) 234-5678", message: "Outbound call to AP desk; reached Sarah Chen", outcome: "Customer committed to payment by 3/31/26 via ACH" },
  ],
  "INV-1038": [
    { timestamp: "3/20/26 9:30 AM", channel: "Email", from: "Recovery Agent", to: "Meridian Group", contact: "billing@meridiangroup.com", message: "Initial payment reminder: Invoice #1038 for $8,750 is due on 3/25/26", outcome: "Email delivered and opened" },
    { timestamp: "3/23/26 11:45 AM", channel: "Email", from: "Meridian Group", to: "Recovery Agent", contact: "collections@clyintel.com", message: "We need the original invoice resent — our AP system shows no record.", outcome: "Client requested invoice resubmission" },
    { timestamp: "3/26/26 10:22 AM", channel: "Email", from: "Recovery Agent", to: "Meridian Group", contact: "billing@meridiangroup.com", message: "Past due notice: Invoice #1038 is now overdue", outcome: "Email opened; no response" },
    { timestamp: "3/28/26 2:15 PM", channel: "Text", from: "Recovery Agent", to: "Meridian Group", contact: "+1 (555) 987-6543", message: "Payment reminder via SMS: Invoice #1038 ($8,750) requires attention", outcome: "Delivered; no response" },
  ],
  "INV-1045": [
    { timestamp: "3/15/26 11:00 AM", channel: "Email", from: "Recovery Agent", to: "Drift Collective", contact: "accounts@driftcollective.com", message: "Initial payment reminder: Invoice #1045 for $2,800 is due on 3/30/26", outcome: "Email delivered" },
    { timestamp: "3/18/26 2:30 PM", channel: "Email", from: "Drift Collective", to: "Recovery Agent", contact: "collections@clyintel.com", message: "Cash flow issues this month. Can we split into two $1,400 payments over 2 weeks?", outcome: "Client requested payment plan" },
    { timestamp: "3/20/26 3:45 PM", channel: "Voice", from: "Recovery Agent", to: "Drift Collective", contact: "+1 (555) 456-7890", message: "Outbound call to confirm payment plan details", outcome: "Payment plan confirmed verbally; first payment expected 3/25" },
  ],
  "INV-1046": [
    { timestamp: "3/22/26 9:00 AM", channel: "Email", from: "Recovery Agent", to: "Drift Collective", contact: "accounts@driftcollective.com", message: "Payment reminder: Invoice #1046 for $2,800 is due on 4/5/26", outcome: "Email delivered and opened" },
  ],
  "INV-1051": [], "INV-1052": [], "INV-1053": [],
};

export const negotiationRecs: NegotiationRec[] = [
  {
    id: "INV-0891",
    client: "Kellner & Associates",
    industry: "Legal",
    invoiceAmount: 18500,
    daysOverdue: 134,
    dueDate: "12/7/25",
    score: 22,
    suggestedAmount: 13000,
    rationale: "134 days past due with no payment activity in 90 days. Client has disputed invoice twice citing budget constraints. Full recovery probability is low. Negotiating a settlement of ~70% maximizes expected recovery vs. continued outreach or write-off.",
    riskOfFullLoss: "68%",
    expectedRecovery: "$13,000",
    alternativeOutcome: "Write-off at $0",
    lastContact: "1/9/26 - Email",
  },
  {
    id: "INV-0904",
    client: "Apex Dynamics",
    industry: "Manufacturing",
    invoiceAmount: 3300,
    daysOverdue: 121,
    dueDate: "12/21/25",
    score: 31,
    suggestedAmount: 2200,
    rationale: "121 days past due. Two promise-to-pay commitments broken. Client is in financial distress per public filings. A negotiated partial settlement of ~67% is recommended before account reaches collections agency, which would yield an estimated 40–50% net after fees.",
    riskOfFullLoss: "74%",
    expectedRecovery: "$2,200",
    alternativeOutcome: "Collections agency ~$1,650 net",
    lastContact: "2/3/26 - Phone",
  },
];

export const invoiceServices: InvoiceService[] = [
  { id: "qb", name: "QuickBooks", color: "#2CA01C", initial: "QB", subtitle: "Sync invoices from QuickBooks" },
  { id: "fb", name: "FreshBooks", color: "#1068e0", initial: "FB", subtitle: "Sync invoices from FreshBooks" },
  { id: "stripe", name: "Stripe", color: "#635BFF", initial: "ST", subtitle: "Sync invoices from Stripe" },
  { id: "xero", name: "Xero", color: "#13B5EA", initial: "XR", subtitle: "Sync invoices from Xero" },
  { id: "gdrive", name: "Google Drive", color: "#1FA463", initial: "GD", subtitle: "Pull from spreadsheet file" },
  { id: "manual", name: "Manual Entry", color: "#64748B", initial: "ME", subtitle: "Create an invoice manually" },
];

export const importedClients: ImportedClient[] = [
  { name: "Harlow & Co.", invoices: 6, balance: 3200 },
  { name: "Meridian Group", invoices: 4, balance: 8750 },
  { name: "Vance Studio", invoices: 8, balance: 12400 },
  { name: "Oaks Financial", invoices: 12, balance: 0 },
  { name: "Kellner & Associates", invoices: 3, balance: 18500 },
  { name: "Apex Dynamics", invoices: 5, balance: 3300 },
];

export interface PTRRecommendation {
  terms: string;
  discount?: string;
  reminderDays: number[];
  reminderLabel: string;
  rationale: string;
  keyFactors: string[];
  lossReduction: string;
  revImpact: string;
  revImpactSign: "positive" | "negative" | "neutral";
  confidence: "High" | "Medium" | "Low";
  altTerms?: string;
  altNote?: string;
}

export const ptrRecommendations: Record<number, PTRRecommendation> = {
  1: {
    terms: "Net 30",
    reminderDays: [-7, -3, 0],
    reminderLabel: "3-touch light sequence",
    rationale: "Harlow & Co. has a strong payment track record with 5 of 6 invoices paid on or before the due date. Standard Net 30 terms are appropriate and maintain a positive client relationship without adding friction.",
    keyFactors: ["5 of 6 invoices paid on time", "Average delay under 1 day", "No disputes on record", "Consistent billing cycle"],
    lossReduction: "8%",
    revImpact: "$420",
    revImpactSign: "positive",
    confidence: "High",
  },
  2: {
    terms: "Net 30",
    reminderDays: [-7, -3, 0],
    reminderLabel: "3-touch sequence",
    rationale: "Meridian Group has a strong recent payment history. The current 3-day delay on INV-1038 appears administrative rather than a cash-flow concern — their AP system noted a missing record. Net 30 with a standard reminder cadence remains appropriate.",
    keyFactors: ["2 of 2 recent invoices paid on time", "Current delay is administrative, not behavioural", "Strong consulting-sector payer profile", "High client score: 85/100"],
    lossReduction: "11%",
    revImpact: "$680",
    revImpactSign: "positive",
    confidence: "High",
  },
  3: {
    terms: "Net 15",
    discount: "2% discount if paid within 5 days",
    reminderDays: [-14, -7, -3, 0, 7],
    reminderLabel: "5-touch escalation",
    rationale: "Vance Studio has paid late on 6 of 8 invoices with an average delay of 26 days. Shorter payment windows reduce your exposure window and the 2% early payment incentive directly addresses the cash flow constraints that appear to drive delays. A CFO approval bottleneck has been identified — triggering the reminder sequence 14 days out gives them runway to clear internal approvals before the due date.",
    keyFactors: ["6 of 8 invoices paid late", "Average payment delay: 26 days", "Two extension requests in 90 days", "CFO approval bottleneck identified", "Score: 44/100 (High risk)"],
    lossReduction: "38%",
    revImpact: "$3,224",
    revImpactSign: "negative",
    confidence: "Medium",
    altTerms: "Net 30 + 1.5%/mo late fee",
    altNote: "Use if client resists shorter terms. Late fee creates financial urgency without shortening the window.",
  },
  4: {
    terms: "Net 45",
    reminderDays: [-5, 0],
    reminderLabel: "2-touch light touch",
    rationale: "Oaks Financial has a near-perfect payment record across 12 invoices, consistently paying 1–2 days early. Extending to Net 45 rewards their reliability, may strengthen the relationship, and carries negligible collection risk given their 91/100 score.",
    keyFactors: ["12 of 12 invoices paid on time or early", "Average: 1.2 days early", "Highest score in portfolio: 91/100", "No disputes or extensions ever requested"],
    lossReduction: "2%",
    revImpact: "$0",
    revImpactSign: "neutral",
    confidence: "High",
  },
  5: {
    terms: "Net 15",
    discount: "3% discount if paid within 3 days",
    reminderDays: [-14, -7, -3, 0, 7, 14],
    reminderLabel: "6-touch escalation",
    rationale: "Drift Collective has confirmed cash flow issues and requested a payment plan on INV-1045. Net 15 terms with a compelling early payment incentive can accelerate collection. The 6-touch escalation sequence matches the urgency of the situation, and the structured cadence keeps pressure on without damaging the relationship.",
    keyFactors: ["Confirmed cash flow constraints", "Payment plan requested (INV-1045)", "2 of 3 invoices paid late", "Average delay: 12 days", "Score: 38/100 (High risk)"],
    lossReduction: "44%",
    revImpact: "$2,180",
    revImpactSign: "negative",
    confidence: "Medium",
    altTerms: "Formalise the payment plan",
    altNote: "Net 30 with a documented 2×$1,400 bi-weekly payment plan. Reduces risk of full write-off if cash flow doesn't recover.",
  },
  6: {
    terms: "50% deposit + Net 15 on balance",
    reminderDays: [-21, -14, -7, 0, 7, 14],
    reminderLabel: "Deposit-required escalation",
    rationale: "At 134 days overdue with no payment in 90+ days and two invoice disputes, Kellner & Associates represents the highest collection risk in your portfolio. Requiring a 50% deposit on any new work protects against further exposure. The outstanding INV-0891 should be addressed through the separate negotiation recommendation.",
    keyFactors: ["134 days past due on INV-0891", "Two invoice disputes filed", "No payment activity in 90+ days", "Risk of full loss: 68%", "Score: 22/100 (Critical risk)"],
    lossReduction: "62%",
    revImpact: "$18,500",
    revImpactSign: "negative",
    confidence: "Low",
    altTerms: "Pause new work",
    altNote: "Pause new engagements until INV-0891 is resolved. Reduces risk of adding to the exposure before recovery is confirmed.",
  },
  7: {
    terms: "Net 15",
    discount: "2% discount if paid within 5 days",
    reminderDays: [-14, -7, -3, 0, 7, 14],
    reminderLabel: "6-touch escalation",
    rationale: "Apex Dynamics has broken two promise-to-pay commitments and is showing signs of financial distress per public filings. Net 15 terms with an early payment incentive create urgency while giving a clear path to resolution. Whether to continue the relationship should be revisited once INV-0904 is settled.",
    keyFactors: ["121 days past due on INV-0904", "2 broken payment commitments", "Financial distress per public filings", "4 of 8 invoices paid late historically", "Score: 31/100 (High risk)"],
    lossReduction: "51%",
    revImpact: "$3,300",
    revImpactSign: "negative",
    confidence: "Low",
    altTerms: "Pause new work",
    altNote: "Prioritise recovery of INV-0904 before issuing new invoices. Reduces total exposure.",
  },
};

export const MANUAL_FIELDS: ManualField[] = [
  { id: "client", label: "Client Name", type: "text", placeholder: "e.g. Acme Corp" },
  { id: "invoice", label: "Invoice #", type: "text", placeholder: "e.g. INV-1060" },
  { id: "amount", label: "Amount ($)", type: "number", placeholder: "e.g. 5000" },
  { id: "dueDate", label: "Due Date", type: "date", placeholder: "" },
  { id: "terms", label: "Payment Terms", type: "select", placeholder: "", options: ["Net 15", "Net 30", "Net 45", "Net 60", "Due on Receipt"] },
  { id: "notes", label: "Notes", type: "textarea", placeholder: "Any additional context..." },
];
