import { describe, expect, it } from "vitest";
import {
  hashOpaqueToken,
  hashPassword,
  issueAccessToken,
  newOpaqueToken,
  verifyAccessToken,
  verifyPassword,
} from "./security";

const signingSecret = "test-signing-secret-that-is-at-least-thirty-two-bytes-long";

describe("password hashing", () => {
  it("accepts the original password and rejects a different password", async () => {
    const hash = await hashPassword("StrongPassword123");

    expect(hash).toMatch(/^pbkdf2_sha256\$100000\$/);
    await expect(verifyPassword("StrongPassword123", hash)).resolves.toBe(true);
    await expect(verifyPassword("DifferentPassword123", hash)).resolves.toBe(false);
  });

  it("rejects malformed password hashes", async () => {
    await expect(verifyPassword("StrongPassword123", "not-a-password-hash")).resolves.toBe(false);
  });
});

describe("opaque account tokens", () => {
  it("generates random tokens and keys their hashes to a secret", async () => {
    const first = newOpaqueToken();
    const second = newOpaqueToken();
    expect(first).not.toBe(second);

    const firstHash = await hashOpaqueToken(first, signingSecret);
    const otherSecretHash = await hashOpaqueToken(
      first,
      "another-test-secret-that-is-at-least-thirty-two-bytes",
    );
    expect(firstHash).not.toBe(otherSecretHash);
  });
});

describe("access tokens", () => {
  it("round-trips the authenticated principal", async () => {
    const issued = await issueAccessToken(
      {
        userId: "usr_test",
        sessionId: "rft_test",
        displayName: "Test Manager",
        email: "manager@example.com",
        emailVerified: true,
      },
      signingSecret,
      900,
    );

    const principal = await verifyAccessToken(issued.token, signingSecret);
    expect(principal).toMatchObject({
      userId: "usr_test",
      sessionId: "rft_test",
      displayName: "Test Manager",
      email: "manager@example.com",
      emailVerified: true,
    });
    expect(new Date(issued.expiresAtUtc).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a token signed with another secret", async () => {
    const issued = await issueAccessToken(
      {
        userId: "usr_test",
        sessionId: "rft_test",
        displayName: "Test Manager",
        email: "manager@example.com",
        emailVerified: true,
      },
      signingSecret,
      900,
    );

    await expect(
      verifyAccessToken(
        issued.token,
        "incorrect-test-secret-that-is-at-least-thirty-two-bytes",
      ),
    ).rejects.toThrow();
  });
});
