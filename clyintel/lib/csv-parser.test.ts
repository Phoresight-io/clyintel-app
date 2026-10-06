import { describe, it, expect } from "vitest";
import { parseCsv } from "./csv-parser";

describe("parseCsv", () => {
  it("handles quoted comma fields", () => {
    const input = 'name,amount\n"Acme, Inc.",100\nBeta,"1,200"';
    expect(parseCsv(input)).toEqual({
      headers: ["name", "amount"],
      rows: [
        { name: "Acme, Inc.", amount: "100" },
        { name: "Beta", amount: "1,200" },
      ],
    });
  });

  // BUG: splitLines already collapses "" into a single " (and keeps the
  // surrounding quote chars), then parseLine treats the lone " as a quote
  // toggle, so embedded quotes are lost (actual note: 'He said hi').
  it("handles escaped quote (double double-quote) inside quoted field", () => {
    const input = 'name,note\nAcme,"He said ""hi"""';
    expect(parseCsv(input)).toEqual({
      headers: ["name", "note"],
      rows: [{ name: "Acme", note: 'He said "hi"' }],
    });
  });

  it("handles CRLF line endings", () => {
    const input = "name,amount\r\nAcme,100\r\nBeta,200\r\n";
    const result = parseCsv(input);
    expect(result).toEqual({
      headers: ["name", "amount"],
      rows: [
        { name: "Acme", amount: "100" },
        { name: "Beta", amount: "200" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("\\r");
  });

  it("skips blank lines between rows", () => {
    const input =
      "name,amount\n\nAcme,100\n\n\nBeta,200\r\n\r\nGamma,300\n   \nDelta,400";
    expect(parseCsv(input)).toEqual({
      headers: ["name", "amount"],
      rows: [
        { name: "Acme", amount: "100" },
        { name: "Beta", amount: "200" },
        { name: "Gamma", amount: "300" },
        { name: "Delta", amount: "400" },
      ],
    });
  });

  it("fills rows with fewer values than headers with empty strings", () => {
    const input = "name,amount,due\nAcme,100\nBeta";
    const result = parseCsv(input);
    expect(result).toEqual({
      headers: ["name", "amount", "due"],
      rows: [
        { name: "Acme", amount: "100", due: "" },
        { name: "Beta", amount: "", due: "" },
      ],
    });
    expect(Object.keys(result.rows[1])).toEqual(["name", "amount", "due"]);
  });
});
