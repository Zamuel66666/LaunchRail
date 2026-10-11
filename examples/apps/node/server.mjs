import { createServer } from "node:http";

createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ service: "launchrail-node-example", healthy: true }));
  process.stdout.write(`${request.method} ${request.url}\n`);
}).listen(3000, "0.0.0.0", () => process.stdout.write("Node example ready on port 3000\n"));
