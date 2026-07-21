const [url, expectedService] = process.argv.slice(2);

if (url === undefined || expectedService === undefined) {
  process.stderr.write("Usage: node scripts/wait-for-health.mjs <url> <service>\n");
  process.exit(2);
}

const timeoutAt = Date.now() + 30_000;
let lastError = "service did not respond";

while (Date.now() < timeoutAt) {
  try {
    const response = await fetch(url);
    const body = await response.json();

    if (response.ok && body.status === "ok" && body.service === expectedService) {
      process.stdout.write(`${expectedService} healthy at ${url}\n`);
      process.exit(0);
    }

    lastError = `unexpected response ${response.status}: ${JSON.stringify(body)}`;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
}

process.stderr.write(`${expectedService} health check failed: ${lastError}\n`);
process.exit(1);
