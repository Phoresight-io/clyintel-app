// Shared UI type/interface definitions for client, invoice, and recommendation
// shapes. This module is TYPES ONLY — all hardcoded mock/seed data has been
// flushed (D2 closeout) so the app renders real subscriber data (or blank),
// never fabricated numbers. Do not add const data exports here.

export type ClientStatus = "current" | "due" | "past_due" | "recovered";

export interface Client {
  id: string | number;
  name: string;
  industry: string;
  score: number;
  prevScore: number;
  status: ClientStatus;
  balance: number;
  daysOverdue: number;
  invoices: number;
  lastActivity: string;
  nextAction: string;
  scoreSummary: string[];
  scoreFactors: string[];
  riskDrivers: string[];
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
  logo?: string;
}

export interface DriveFolder {
  name: string;
  files: number;
  modified: string;
}

export interface DriveFile {
  name: string;
  size: string;
  modified: string;
  rows: number;
}

export interface GoogleAccount {
  email: string;
  name: string;
  initial: string;
  color: string;
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
