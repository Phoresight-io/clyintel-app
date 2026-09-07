import { describe, it, expect, vi } from "vitest";
import {
  createContact,
  updateContact,
  deleteContact,
  type ContactMutationPort,
  type ContactRow,
  type ContactMeta,
} from "./mutateContact";

const ROW: ContactRow = {
  id: "ct-1",
  client_id: "cl-1",
  contact_type: "dunning",
  email: "d@x.com",
  phone: null,
  email_rank: 1,
  sms_rank: null,
  voice_rank: null,
  opt_out_email: false,
  opt_out_sms: false,
  opt_out_voice: false,
};

const DUNNING_META: ContactMeta = { id: "ct-1", client_id: "cl-1", contact_type: "dunning" };
const POC_META: ContactMeta = { id: "ct-poc", client_id: "cl-1", contact_type: "poc" };

function makePort(over: Partial<ContactMutationPort> = {}): ContactMutationPort {
  return {
    isClientOwned: vi.fn(async () => true),
    loadContactMeta: vi.fn(async () => DUNNING_META),
    insertContact: vi.fn(async () => ({ ok: true, row: ROW }) as const),
    updateContact: vi.fn(async () => ({ ok: true, row: ROW }) as const),
    deleteContact: vi.fn(async () => {}),
    ...over,
  };
}

describe("createContact", () => {
  it("valid dunning contact → 201; contact_type FORCED to 'dunning', validated email used", async () => {
    const port = makePort();
    const res = await createContact(
      { client_id: "cl-1", email: "  new@x.com ", email_rank: 2, opt_out_email: true },
      port,
    );
    expect(res.status).toBe(201);
    expect(res.body).toEqual(ROW);
    expect(port.insertContact).toHaveBeenCalledWith({
      client_id: "cl-1",
      contact_type: "dunning",
      email: "new@x.com", // trimmed by validateEmail
      email_rank: 2,
      opt_out_email: true,
    });
  });

  it("body attempting contact_type='poc' is ignored — insert still forced to 'dunning'", async () => {
    const port = makePort();
    await createContact({ client_id: "cl-1", email: "new@x.com", contact_type: "poc" }, port);
    const arg = (port.insertContact as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.contact_type).toBe("dunning");
  });

  it("missing client_id → 400, no insert", async () => {
    const port = makePort();
    const res = await createContact({ email: "new@x.com" }, port);
    expect(res.status).toBe(400);
    expect(port.insertContact).not.toHaveBeenCalled();
  });

  it("ownership fails → 403, no insert (email never even validated)", async () => {
    const port = makePort({ isClientOwned: vi.fn(async () => false) });
    const res = await createContact({ client_id: "cl-x", email: "new@x.com" }, port);
    expect(res.status).toBe(403);
    expect(port.insertContact).not.toHaveBeenCalled();
  });

  it("bad email → 400, no insert", async () => {
    const port = makePort();
    const res = await createContact({ client_id: "cl-1", email: "nope" }, port);
    expect(res.status).toBe(400);
    expect(port.insertContact).not.toHaveBeenCalled();
  });

  it("empty email → 400 'Email is required.'", async () => {
    const port = makePort();
    const res = await createContact({ client_id: "cl-1", email: "" }, port);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Email is required." });
  });

  it("per-channel-rank collision (port conflict) → 409", async () => {
    const port = makePort({ insertContact: vi.fn(async () => ({ ok: false, conflict: true }) as const) });
    const res = await createContact({ client_id: "cl-1", email: "new@x.com", email_rank: 1 }, port);
    expect(res.status).toBe(409);
  });
});

describe("updateContact", () => {
  it("dunning contact → 200, only provided fields patched", async () => {
    const port = makePort();
    const res = await updateContact({ id: "ct-1", email_rank: 3 }, port);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ROW);
    expect(port.updateContact).toHaveBeenCalledWith("ct-1", { email_rank: 3 });
  });

  it("POC row → 403, no update", async () => {
    const port = makePort({ loadContactMeta: vi.fn(async () => POC_META) });
    const res = await updateContact({ id: "ct-poc", email: "x@y.com" }, port);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Point-of-contact contacts are read-only (managed by QuickBooks)." });
    expect(port.updateContact).not.toHaveBeenCalled();
  });

  it("unknown id → 404, ownership never checked", async () => {
    const port = makePort({ loadContactMeta: vi.fn(async () => null) });
    const res = await updateContact({ id: "ghost" }, port);
    expect(res.status).toBe(404);
    expect(port.isClientOwned).not.toHaveBeenCalled();
    expect(port.updateContact).not.toHaveBeenCalled();
  });

  it("ownership fails → 403, no update", async () => {
    const port = makePort({ isClientOwned: vi.fn(async () => false) });
    const res = await updateContact({ id: "ct-1", email_rank: 2 }, port);
    expect(res.status).toBe(403);
    expect(port.updateContact).not.toHaveBeenCalled();
  });

  it("bad email when provided → 400, no update", async () => {
    const port = makePort();
    const res = await updateContact({ id: "ct-1", email: "bad email" }, port);
    expect(res.status).toBe(400);
    expect(port.updateContact).not.toHaveBeenCalled();
  });

  it("rank collision → 409", async () => {
    const port = makePort({ updateContact: vi.fn(async () => ({ ok: false, conflict: true }) as const) });
    const res = await updateContact({ id: "ct-1", email_rank: 1 }, port);
    expect(res.status).toBe(409);
  });

  it("missing id → 400", async () => {
    const port = makePort();
    const res = await updateContact({ email_rank: 2 }, port);
    expect(res.status).toBe(400);
    expect(port.loadContactMeta).not.toHaveBeenCalled();
  });
});

describe("deleteContact", () => {
  it("dunning contact → 200 { deleted: true }", async () => {
    const port = makePort();
    const res = await deleteContact({ id: "ct-1" }, port);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(port.deleteContact).toHaveBeenCalledWith("ct-1");
  });

  it("POC row → 403, no delete (QBO would re-create it anyway)", async () => {
    const port = makePort({ loadContactMeta: vi.fn(async () => POC_META) });
    const res = await deleteContact({ id: "ct-poc" }, port);
    expect(res.status).toBe(403);
    expect(port.deleteContact).not.toHaveBeenCalled();
  });

  it("unknown id → 404", async () => {
    const port = makePort({ loadContactMeta: vi.fn(async () => null) });
    const res = await deleteContact({ id: "ghost" }, port);
    expect(res.status).toBe(404);
    expect(port.deleteContact).not.toHaveBeenCalled();
  });

  it("ownership fails → 403, no delete", async () => {
    const port = makePort({ isClientOwned: vi.fn(async () => false) });
    const res = await deleteContact({ id: "ct-1" }, port);
    expect(res.status).toBe(403);
    expect(port.deleteContact).not.toHaveBeenCalled();
  });

  it("missing id (null query param) → 400", async () => {
    const port = makePort();
    const res = await deleteContact({ id: null }, port);
    expect(res.status).toBe(400);
    expect(port.loadContactMeta).not.toHaveBeenCalled();
  });
});
