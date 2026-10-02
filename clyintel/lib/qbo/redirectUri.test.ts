import { describe, it, expect } from "vitest";
import { qboRedirectUriFor } from "./constants";

// The OAuth redirect_uri must follow the deployment the user is on, so a
// reauthorize started on develop returns to develop — never to production.
describe("qboRedirectUriFor", () => {
  it("builds the callback URL on the given origin", () => {
    expect(qboRedirectUriFor("https://dev-clyintel.vercel.app")).toBe(
      "https://dev-clyintel.vercel.app/api/qbo/callback",
    );
    expect(qboRedirectUriFor("https://clyintel.vercel.app")).toBe(
      "https://clyintel.vercel.app/api/qbo/callback",
    );
  });

  it("keeps scheme and port for local dev", () => {
    expect(qboRedirectUriFor("http://localhost:3000")).toBe("http://localhost:3000/api/qbo/callback");
  });
});
