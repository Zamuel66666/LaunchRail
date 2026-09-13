export interface GitHubPushEvent {
  readonly branch: string;
  readonly repositoryName: string;
  readonly repositoryOwner: string;
  readonly revision: string;
}

export async function verifyGitHubSignature(
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
  secret: string,
): Promise<boolean> {
  if (secret.length === 0 || signatureHeader === undefined) return false;
  const provided = signatureHeader.trim();
  if (!/^sha256=[0-9a-f]{64}$/.test(provided)) return false;
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", key, new Uint8Array(rawBody).buffer as ArrayBuffer),
  );
  const expected = `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1)
    difference |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  return difference === 0;
}

export function parseGitHubPushEvent(payload: unknown): GitHubPushEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;
  const ref = value.ref;
  const after = value.after;
  const repository = value.repository;
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || typeof after !== "string")
    return null;
  if (!/^[0-9a-f]{40}$/.test(after)) return null;
  if (typeof repository !== "object" || repository === null) return null;
  const repo = repository as Record<string, unknown>;
  const owner = repo.owner;
  if (typeof owner !== "object" || owner === null) return null;
  const ownerLogin = (owner as Record<string, unknown>).login;
  if (typeof repo.name !== "string" || typeof ownerLogin !== "string") return null;
  return {
    branch: ref.slice("refs/heads/".length),
    repositoryName: repo.name,
    repositoryOwner: ownerLogin,
    revision: after,
  };
}
