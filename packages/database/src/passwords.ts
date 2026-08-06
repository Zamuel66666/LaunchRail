import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface ScryptParameters {
  readonly cost: number;
  readonly keyLength: number;
  readonly parallelization: number;
  readonly saltLength: number;
  readonly blockSize: number;
}

const defaultParameters: ScryptParameters = {
  blockSize: 8,
  cost: 32_768,
  keyLength: 64,
  parallelization: 1,
  saltLength: 16,
};

function deriveKey(password: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      parameters.keyLength,
      {
        N: parameters.cost,
        maxmem: 64 * 1024 * 1024,
        p: parameters.parallelization,
        r: parameters.blockSize,
      },
      (error, derivedKey) => {
        if (error === null) {
          resolve(derivedKey);
        } else {
          reject(error);
        }
      },
    );
  });
}

export class PasswordHasher {
  public constructor(private readonly parameters: ScryptParameters = defaultParameters) {}

  public async hash(password: string): Promise<string> {
    const salt = randomBytes(this.parameters.saltLength);
    const derivedKey = await deriveKey(password, salt, this.parameters);

    return [
      "scrypt",
      "v1",
      this.parameters.cost,
      this.parameters.blockSize,
      this.parameters.parallelization,
      salt.toString("base64url"),
      derivedKey.toString("base64url"),
    ].join("$");
  }

  public async verify(password: string, encodedHash: string): Promise<boolean> {
    const parts = encodedHash.split("$");
    if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== "v1") {
      return false;
    }

    const cost = Number(parts[2]);
    const blockSize = Number(parts[3]);
    const parallelization = Number(parts[4]);
    const saltValue = parts[5];
    const expectedValue = parts[6];

    if (
      !Number.isSafeInteger(cost) ||
      !Number.isSafeInteger(blockSize) ||
      !Number.isSafeInteger(parallelization) ||
      cost < 2 ||
      blockSize < 1 ||
      parallelization < 1 ||
      saltValue === undefined ||
      expectedValue === undefined
    ) {
      return false;
    }

    const expected = Buffer.from(expectedValue, "base64url");
    if (expected.length === 0 || expected.length > 128) {
      return false;
    }

    try {
      const derived = await deriveKey(password, Buffer.from(saltValue, "base64url"), {
        blockSize,
        cost,
        keyLength: expected.length,
        parallelization,
        saltLength: 16,
      });
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }
}
