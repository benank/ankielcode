#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadlinePromises from "node:readline/promises";
import * as NodeURL from "node:url";

const relayDir = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const defaultLocalStateDir = NodePath.join(NodeOS.homedir(), ".ankiel", "userdata");
// oxlint-disable-next-line ankielcode/no-global-process-runtime -- Standalone relay setup has no Effect runtime.
const platform = process.platform;

function parseArgs(argv) {
  const args = {
    domain: null,
    skipDeploy: false,
    connectLocal: null,
    noClipboard: false,
    dryRun: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--domain" && argv[i + 1]) {
      args.domain = argv[++i].trim();
    } else if (token === "--skip-deploy") {
      args.skipDeploy = true;
    } else if (token === "--connect-local") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.connectLocal = next;
        i++;
      } else {
        args.connectLocal = "auto";
      }
    } else if (token === "--no-clipboard") {
      args.noClipboard = true;
    } else if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--yes" || token === "-y") {
      args.yes = true;
    } else if (token === "--help" || token === "-h") {
      console.log(`Usage: npm run setup -- [options]

Options:
  --domain <host>          Custom domain (e.g. relay.ankiel.com) instead of *.workers.dev
  --skip-deploy            Skip wrangler deploy (e.g. the Worker is already deployed)
  --connect-local [dir]    Write relay.json + 0600 secrets/relay-secret (default: ~/.ankiel/userdata)
  --no-clipboard           Do not copy the setup string to clipboard
  --yes, -y                Skip interactive prompts
  --dry-run                Generate & print a local dry-run setup string without calling Cloudflare
`);
      process.exit(0);
    }
  }
  return args;
}

function resolveWranglerBin() {
  const localBin = NodePath.join(
    relayDir,
    "node_modules",
    ".bin",
    platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  return NodeFS.existsSync(localBin) ? localBin : "wrangler";
}

function runWrangler(wranglerArgs, options = {}) {
  const bin = resolveWranglerBin();
  return NodeChildProcess.spawnSync(bin, wranglerArgs, {
    cwd: relayDir,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    input: options.input,
  });
}

function copyToClipboard(text) {
  const candidates =
    platform === "darwin"
      ? [["pbcopy", []]]
      : platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];

  for (const [cmd, cmdArgs] of candidates) {
    const result = NodeChildProcess.spawnSync(cmd, cmdArgs, {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (result.status === 0) return true;
  }
  return false;
}

function saveLocalRelayConfig(stateDir, relayHost, secret) {
  const isWorkersDev = relayHost.toLowerCase().endsWith(".workers.dev");
  const routingMode = isWorkersDev ? "path" : "subdomain";
  const secretsDir = NodePath.join(stateDir, "secrets");

  NodeFS.mkdirSync(stateDir, { recursive: true });
  NodeFS.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  try {
    NodeFS.chmodSync(secretsDir, 0o700);
  } catch {
    // Windows ignores POSIX chmod.
  }

  const secretPath = NodePath.join(secretsDir, "relay-secret");
  NodeFS.writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  try {
    NodeFS.chmodSync(secretPath, 0o600);
  } catch {
    // Windows ignores POSIX chmod.
  }

  const configPath = NodePath.join(stateDir, "relay.json");
  NodeFS.writeFileSync(
    configPath,
    `${JSON.stringify({ url: `https://${relayHost}`, routingMode, enabled: true }, null, 2)}\n`,
    { mode: 0o600 },
  );

  return { configPath, secretPath, routingMode };
}

function putWranglerSecret(name, value) {
  const result = runWrangler(["secret", "put", name], {
    input: value.endsWith("\n") ? value : `${value}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`Failed to set ${name} on Cloudflare.`);
  }
}

async function askYes(rl, question) {
  const answer = (await rl.question(question)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function readSecretFile(rawPath) {
  const resolved = NodePath.resolve(rawPath.trim().replace(/^~(?=\/)/, NodeOS.homedir()));
  return NodeFS.readFileSync(resolved, "utf8");
}

async function offerPushSecrets(rl) {
  if (await askYes(rl, "Set up iOS push notifications (APNs .p8 key)? [y/N] ")) {
    const keyP8 = readSecretFile(await rl.question("Path to AuthKey_XXXXXXXXXX.p8: "));
    const keyId = (await rl.question("APNs key id: ")).trim();
    const teamId = (await rl.question("Apple team id: ")).trim();
    putWranglerSecret("APNS_KEY_P8", keyP8);
    putWranglerSecret("APNS_KEY_ID", keyId);
    putWranglerSecret("APNS_TEAM_ID", teamId);
  }
  if (await askYes(rl, "Set up Android push notifications (Firebase service account)? [y/N] ")) {
    const json = readSecretFile(await rl.question("Path to the service account JSON: "));
    JSON.parse(json);
    putWranglerSecret("FCM_SERVICE_ACCOUNT_JSON", json);
  }
}

function extractWorkerHost(output) {
  const match = /https:\/\/([a-z0-9.-]+\.workers\.dev)/i.exec(output);
  return match ? match[1] : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rl =
    !args.yes && process.stdin.isTTY
      ? NodeReadlinePromises.createInterface({ input: process.stdin, output: process.stdout })
      : null;

  try {
    const secret = NodeCrypto.randomBytes(32).toString("base64url");
    let relayHost = args.domain
      ? args.domain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
      : null;

    if (args.dryRun) {
      relayHost = relayHost ?? "ankiel-relay.example.workers.dev";
      console.log("[dry-run] Skipping Cloudflare login, deploy, and secret upload.");
    } else {
      // 1. Check Cloudflare authentication
      const whoami = runWrangler(["whoami"]);
      if (whoami.status !== 0) {
        console.log("Not logged into Cloudflare yet — launching `wrangler login`...");
        const login = runWrangler(["login"], { stdio: "inherit" });
        if (login.status !== 0) {
          throw new Error("Cloudflare login failed or was cancelled.");
        }
      }

      // 2. Deploy Worker (unless skipped)
      if (!args.skipDeploy) {
        console.log("Deploying ankiel-relay Worker + Durable Object to Cloudflare...");
        const deploy = runWrangler(["deploy"]);
        if (deploy.stdout) process.stdout.write(deploy.stdout);
        if (deploy.stderr) process.stderr.write(deploy.stderr);
        if (deploy.status !== 0) {
          throw new Error("`wrangler deploy` failed.");
        }
        if (!relayHost) {
          relayHost = extractWorkerHost(`${deploy.stdout ?? ""}\n${deploy.stderr ?? ""}`);
        }
      }

      if (!relayHost && rl) {
        const answer = (
          await rl.question(
            "Enter your deployed Worker hostname (e.g. ankiel-relay.you.workers.dev or relay.ankiel.com): ",
          )
        ).trim();
        relayHost = answer.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
      }

      if (!relayHost) {
        throw new Error(
          "Could not determine Worker hostname. Re-run with `--domain <your-worker-host>`.",
        );
      }

      // 3. Push RELAY_SECRET via stdin so it never hits shell history
      console.log("Uploading newly generated 256-bit RELAY_SECRET to Cloudflare...");
      const putSecret = runWrangler(["secret", "put", "RELAY_SECRET"], {
        input: `${secret}\n`,
        stdio: ["pipe", "inherit", "inherit"],
      });
      if (putSecret.status !== 0) {
        throw new Error("Failed to set RELAY_SECRET on Cloudflare.");
      }

      if (rl) {
        await offerPushSecrets(rl);
      }
    }

    const setupString = `ankiel-relay://${relayHost}#${secret}`;
    const copied = !args.noClipboard && copyToClipboard(setupString);

    let localSaved = null;
    if (args.connectLocal) {
      const targetDir = args.connectLocal === "auto" ? defaultLocalStateDir : args.connectLocal;
      localSaved = saveLocalRelayConfig(targetDir, relayHost, secret);
    } else if (rl) {
      const answer = (
        await rl.question(
          `Configure this computer automatically in ${defaultLocalStateDir}? [Y/n] `,
        )
      )
        .trim()
        .toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") {
        localSaved = saveLocalRelayConfig(defaultLocalStateDir, relayHost, secret);
      }
    }

    console.log("\n============================================================");
    console.log("  Ankiel Relay is locked and ready!");
    console.log("============================================================\n");
    console.log("Relay Setup String (save this in your password manager for other computers):");
    console.log(`\n  ${setupString}\n`);
    if (copied) {
      console.log("✓ Copied Relay Setup String to your clipboard.");
    }
    if (localSaved) {
      console.log(`✓ Configured this computer:`);
      console.log(`  - Config: ${localSaved.configPath} (routingMode=${localSaved.routingMode})`);
      console.log(`  - Secret: ${localSaved.secretPath} (chmod 0600)`);
    } else {
      console.log("To connect a computer via CLI/env:");
      console.log(`  ANKIEL_RELAY_SETUP="${setupString}"`);
    }
    console.log(
      "\nNext: restart your Ankiel Code server/desktop app and scan its QR code on your phone.",
    );
  } finally {
    rl?.close();
  }
}

main().catch((err) => {
  console.error(`\nSetup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
