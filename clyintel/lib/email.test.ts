import { describe, it, expect, vi, afterEach } from "vitest";
import { sendEmail, SENDER_NAME } from "./email";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendEmail sender", () => {
  it("posts from Phoresight <team@phoresight.io>", async () => {
    vi.stubEnv("APP_MAILERSEND_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => new Response(null, { status: 202, headers: { "x-message-id": "msg-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendEmail({ to: "debtor@example.com", subject: "Invoice 1038", text: "Hello" });

    expect(SENDER_NAME).toBe("Phoresight");
    expect(result).toEqual({ messageId: "msg-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.mailersend.com/v1/email");
    const body = JSON.parse(init.body as string);
    expect(body.from.name).toBe("Phoresight");
    expect(body.from.email).toBe("team@phoresight.io");
  });
});
