import { describe, expect, it } from "vitest";

import { AesGcmSecretCipher, SecretDecryptionError } from "../src/secrets.js";

const activeKey = new Uint8Array(32).fill(7);
const historicalKey = new Uint8Array(32).fill(3);
const context = {
  organizationId: "88aaa209-1d9a-4a1f-9c75-34defdba721a",
  projectId: "c64c7243-ddf4-4189-8bcd-b7780a6fd971",
  variableName: "DATABASE_URL",
};
const plaintext = new TextEncoder().encode("postgres://launchrail:secret@database/app");

describe("AesGcmSecretCipher", () => {
  it("round-trips a secret without deterministic ciphertext", async () => {
    const cipher = new AesGcmSecretCipher(new Map([[2, activeKey]]), 2);

    const first = await cipher.encrypt(plaintext, context);
    const second = await cipher.encrypt(plaintext, context);

    expect(first.algorithm).toBe("aes-256-gcm");
    expect(first.keyVersion).toBe(2);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    await expect(cipher.decrypt(first, context)).resolves.toEqual(plaintext);
  });

  it("reads historical key versions while writing with the active version", async () => {
    const oldCipher = new AesGcmSecretCipher(new Map([[1, historicalKey]]), 1);
    const historicalSecret = await oldCipher.encrypt(plaintext, context);
    const rotatedCipher = new AesGcmSecretCipher(
      new Map([
        [1, historicalKey],
        [2, activeKey],
      ]),
      2,
    );

    await expect(rotatedCipher.decrypt(historicalSecret, context)).resolves.toEqual(plaintext);
    await expect(rotatedCipher.encrypt(plaintext, context)).resolves.toMatchObject({
      keyVersion: 2,
    });
  });

  it.each([
    ["ciphertext", { ciphertext: "AA" }],
    ["authentication tag", { authenticationTag: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["nonce", { nonce: "AAAAAAAAAAAAAAAA" }],
    ["key version", { keyVersion: 99 }],
  ])("rejects a modified %s with one safe error", async (_label, change) => {
    const cipher = new AesGcmSecretCipher(new Map([[2, activeKey]]), 2);
    const encrypted = await cipher.encrypt(plaintext, context);

    await expect(cipher.decrypt({ ...encrypted, ...change }, context)).rejects.toEqual(
      new SecretDecryptionError(),
    );
  });

  it("binds ciphertext to the organization, project, and variable name", async () => {
    const cipher = new AesGcmSecretCipher(new Map([[2, activeKey]]), 2);
    const encrypted = await cipher.encrypt(plaintext, context);

    await expect(
      cipher.decrypt(encrypted, { ...context, organizationId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(SecretDecryptionError);
    await expect(
      cipher.decrypt(encrypted, { ...context, projectId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(SecretDecryptionError);
    await expect(
      cipher.decrypt(encrypted, { ...context, variableName: "OTHER_SECRET" }),
    ).rejects.toBeInstanceOf(SecretDecryptionError);
  });

  it.each([
    ["ciphertext alphabet", { ciphertext: "not+base64url" }],
    ["nonce length", { nonce: "too-short" }],
    ["tag length", { authenticationTag: "too-short" }],
  ])("rejects malformed %s without decoder details", async (_label, change) => {
    const cipher = new AesGcmSecretCipher(new Map([[2, activeKey]]), 2);
    const encrypted = await cipher.encrypt(plaintext, context);

    await expect(cipher.decrypt({ ...encrypted, ...change }, context)).rejects.toEqual(
      new SecretDecryptionError(),
    );
  });

  it("rejects malformed keyrings before handling any secrets", () => {
    expect(() => new AesGcmSecretCipher(new Map([[1, new Uint8Array(31)]]), 1)).toThrow(
      "invalid key entry",
    );
    expect(() => new AesGcmSecretCipher(new Map([[1, activeKey]]), 2)).toThrow("not present");
  });
});
