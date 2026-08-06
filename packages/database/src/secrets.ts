import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";

import type { EncryptedSecret, SecretCipher, SecretContext } from "@launchrail/application";

const algorithm = "aes-256-gcm" as const;
const authenticationTagLength = 16;
const keyLength = 32;
const nonceLength = 12;
const envelopeVersion = 1;

export class SecretDecryptionError extends Error {
  public constructor() {
    super("Secret could not be decrypted");
    this.name = "SecretDecryptionError";
  }
}

function additionalAuthenticatedData(context: SecretContext): Buffer {
  return Buffer.from(
    JSON.stringify([
      "launchrail-environment-variable",
      envelopeVersion,
      context.organizationId,
      context.projectId,
      context.variableName,
    ]),
    "utf8",
  );
}

function decodeBase64Url(value: string, expectedLength?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SecretDecryptionError();
  }

  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length === 0 ||
    (expectedLength !== undefined && decoded.length !== expectedLength) ||
    decoded.toString("base64url") !== value
  ) {
    throw new SecretDecryptionError();
  }
  return decoded;
}

export class AesGcmSecretCipher implements SecretCipher {
  private readonly activeKeyVersion: number;
  private readonly keys: ReadonlyMap<number, Buffer>;

  public constructor(keys: ReadonlyMap<number, Uint8Array>, activeKeyVersion: number) {
    if (!Number.isInteger(activeKeyVersion) || activeKeyVersion <= 0) {
      throw new Error("Active secret key version must be a positive integer");
    }
    if (keys.size === 0 || keys.size > 8) {
      throw new Error("Secret keyring must contain between one and eight keys");
    }

    const clonedKeys = new Map<number, Buffer>();
    for (const [version, key] of keys) {
      if (!Number.isInteger(version) || version <= 0 || key.byteLength !== keyLength) {
        throw new Error("Secret keyring contains an invalid key entry");
      }
      clonedKeys.set(version, Buffer.from(key));
    }
    if (!clonedKeys.has(activeKeyVersion)) {
      throw new Error("Active secret key version is not present in the keyring");
    }

    this.activeKeyVersion = activeKeyVersion;
    this.keys = clonedKeys;
  }

  public async encrypt(plaintext: Uint8Array, context: SecretContext): Promise<EncryptedSecret> {
    const key = this.keys.get(this.activeKeyVersion);
    if (key === undefined) {
      throw new Error("Active secret key is unavailable");
    }

    const nonce = randomBytes(nonceLength);
    const cipher = createCipheriv(algorithm, key, nonce, {
      authTagLength: authenticationTagLength,
    }) as CipherGCM;
    cipher.setAAD(additionalAuthenticatedData(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return {
      algorithm,
      authenticationTag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      keyVersion: this.activeKeyVersion,
      nonce: nonce.toString("base64url"),
    };
  }

  public async decrypt(secret: EncryptedSecret, context: SecretContext): Promise<Uint8Array> {
    try {
      if (secret.algorithm !== algorithm) {
        throw new SecretDecryptionError();
      }
      const key = this.keys.get(secret.keyVersion);
      if (key === undefined) {
        throw new SecretDecryptionError();
      }

      const nonce = decodeBase64Url(secret.nonce, nonceLength);
      const authenticationTag = decodeBase64Url(secret.authenticationTag, authenticationTagLength);
      const ciphertext = decodeBase64Url(secret.ciphertext);
      const decipher = createDecipheriv(algorithm, key, nonce, {
        authTagLength: authenticationTagLength,
      }) as DecipherGCM;
      decipher.setAAD(additionalAuthenticatedData(context));
      decipher.setAuthTag(authenticationTag);
      return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    } catch (error) {
      if (error instanceof SecretDecryptionError) {
        throw error;
      }
      throw new SecretDecryptionError();
    }
  }
}
