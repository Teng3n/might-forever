import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(root, ".env") });

const clientId = String(process.env.WCL_CLIENT_ID ?? "").trim();
const clientSecret = String(process.env.WCL_CLIENT_SECRET ?? "").trim();
const redirectUri = String(process.env.WCL_USER_REDIRECT_URI ?? "http://localhost:8787/callback").trim();
const redirectUrl = new URL(redirectUri);
const port = Number(redirectUrl.port || (redirectUrl.protocol === "https:" ? 443 : 80));
const state = randomBytes(24).toString("hex");

if (!clientId || !clientSecret) {
  throw new Error("WCL_CLIENT_ID and WCL_CLIENT_SECRET must be present in the local .env file.");
}
if (redirectUrl.hostname !== "localhost" && redirectUrl.hostname !== "127.0.0.1") {
  throw new Error("WCL_USER_REDIRECT_URI must use localhost or 127.0.0.1.");
}

const authorizationUrl = new URL("https://www.warcraftlogs.com/oauth/authorize");
authorizationUrl.searchParams.set("client_id", clientId);
authorizationUrl.searchParams.set("redirect_uri", redirectUri);
authorizationUrl.searchParams.set("response_type", "code");
authorizationUrl.searchParams.set("state", state);

const htmlResponse = (message: string) => `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Warcraft Logs authorization</title>
<body style="font-family:system-ui;margin:3rem;max-width:42rem"><h1>Warcraft Logs authorization</h1><p>${message}</p></body></html>`;

const runAudit = (accessToken: string) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/audit-historical-raider-evidence.ts"], {
      cwd: root,
      env: { ...process.env, WCL_USER_ACCESS_TOKEN: accessToken },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

let handled = false;
const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", redirectUri);
  if (requestUrl.pathname !== redirectUrl.pathname) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  if (handled) {
    response.writeHead(409, { "Content-Type": "text/html; charset=utf-8" });
    response.end(htmlResponse("This authorization response has already been handled."));
    return;
  }
  handled = true;

  const returnedState = requestUrl.searchParams.get("state");
  const code = requestUrl.searchParams.get("code");
  const oauthError = requestUrl.searchParams.get("error");
  if (oauthError || !code || returnedState !== state) {
    response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    response.end(htmlResponse(`Authorization failed: ${oauthError ?? "invalid response"}.`));
    server.close();
    process.exitCode = 1;
    return;
  }

  const tokenResponse = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  const tokenBody = await tokenResponse.text();
  if (!tokenResponse.ok) {
    response.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    response.end(htmlResponse(`Token exchange failed with HTTP ${tokenResponse.status}.`));
    console.error(`Token exchange failed with HTTP ${tokenResponse.status}: ${tokenBody.slice(0, 300)}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  const token = JSON.parse(tokenBody) as { access_token?: string };
  if (!token.access_token) {
    response.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    response.end(htmlResponse("Warcraft Logs returned no access token."));
    server.close();
    process.exitCode = 1;
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(htmlResponse("Authorization succeeded. The evidence audit is now running; this tab can be closed."));
  console.log("Warcraft Logs user authorization succeeded. Starting evidence audit.");

  const exitCode = await runAudit(token.access_token);
  server.close();
  process.exitCode = exitCode;
});

server.listen(port, redirectUrl.hostname, () => {
  console.log(`WCL_AUTHORIZATION_URL ${authorizationUrl.toString()}`);
  console.log(`Waiting for Warcraft Logs to redirect to ${redirectUri}`);
});
