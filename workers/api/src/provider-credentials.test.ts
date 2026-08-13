import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential } from "./provider-credentials";

const secret = "provider-credential-master-secret-for-tests-only";

describe("provider credential encryption", () => {
  it("round trips an API key without storing plaintext", async () => {
    const encrypted = await encryptCredential("example-provider-key", secret, new Uint8Array(12).fill(7));
    expect(encrypted.encryptedValueBase64).not.toContain("example-provider-key");
    await expect(decryptCredential(encrypted.encryptedValueBase64, encrypted.ivBase64, secret)).resolves.toBe("example-provider-key");
  });

  it("rejects decryption with a different master secret", async () => {
    const encrypted = await encryptCredential("example-provider-key", secret);
    await expect(decryptCredential(encrypted.encryptedValueBase64, encrypted.ivBase64, `${secret}-different`)).rejects.toThrow("could not be decrypted");
  });
});
