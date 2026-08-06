import { describe, expect, it } from "vitest";

import { PasswordHasher } from "../src/passwords.js";

const hasher = new PasswordHasher({
  blockSize: 8,
  cost: 1024,
  keyLength: 32,
  parallelization: 1,
  saltLength: 16,
});

describe("PasswordHasher", () => {
  it("stores a salted scrypt encoding and verifies the password", async () => {
    const first = await hasher.hash("correct horse battery staple");
    const second = await hasher.hash("correct horse battery staple");

    expect(first).not.toBe(second);
    await expect(hasher.verify("correct horse battery staple", first)).resolves.toBe(true);
    await expect(hasher.verify("wrong password", first)).resolves.toBe(false);
  });

  it.each(["", "sha256$not-scrypt", "scrypt$v1$bad$8$1$salt$hash"])(
    "rejects malformed encodings safely",
    async (encodedHash) => {
      await expect(hasher.verify("password", encodedHash)).resolves.toBe(false);
    },
  );
});
