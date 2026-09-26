import { describe, it, expect, afterEach, vi } from "vitest";

import { sendEmail, SENDER_NAME } from "./email";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendEmail — sender identity", () => {
  it("posts from Phoresight <team@phoresight.io>", async () => {
    vi.stubEnv("APP_MAILERSEND_API_KEY", "ms_test_key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 202, headers: { "x-message-id": "msg_1" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendEmail({ to: "debtor@example.com", subject: "Hi", text: "Body" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(SENDER_NAME).toBe("Phoresight");
    expect(body.from).toEqual({ email: "team@phoresight.io", name: "Phoresight" });
  });
});
