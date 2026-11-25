import type { AuthMcpClientAccess } from "@ankielcode/contracts";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

const STYLES = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px 16px; background: #f6f7f9; color: #17191f; }
  main { width: min(100%, 440px); }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { margin: 0 0 12px; line-height: 1.5; color: #4b5060; }
  form { display: grid; gap: 8px; }
  input, select, button { font: inherit; padding: 6px 8px; }
  .actions { display: flex; gap: 8px; margin-top: 8px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e6e8ee; }
    p { color: #a0a6b4; }
  }
`;

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(title)}</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;

export function renderErrorPage(description: string): string {
  return shell(
    "Sign-in failed",
    `<h1>This sign-in cannot continue</h1>
    <p>${escapeHtml(description)}</p>
    <p>Close this page and start the sign-in again from your agent.</p>`,
  );
}

const accessLabels: Record<AuthMcpClientAccess, string> = {
  "read-only": "Read only",
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export function renderConsentPage(input: {
  readonly clientName: string;
  readonly environmentHost: string;
  readonly redirectHost: string;
  readonly levels: ReadonlyArray<AuthMcpClientAccess>;
  readonly defaultAccess: AuthMcpClientAccess;
  readonly error: string | undefined;
}): string {
  const options = input.levels.map(
    (level) =>
      `<option value="${level}"${level === input.defaultAccess ? " selected" : ""}>${accessLabels[level]}</option>`,
  );
  return shell(
    "Connect an agent",
    `<h1>Connect ${escapeHtml(input.clientName)}</h1>
    <p>Environment: <strong>${escapeHtml(input.environmentHost)}</strong></p>
    <p>After approval, sign-in returns to <strong>${escapeHtml(input.redirectHost)}</strong>.</p>
    <p>Enter a sign-in code from Ankiel Code and choose the access to grant.</p>
    ${input.error ? `<p role="alert">${escapeHtml(input.error)}</p>` : ""}
    <form method="post" autocomplete="off">
      <label for="code">Sign-in code</label>
      <input id="code" name="code" type="password" required>
      <label for="access">Access</label>
      <select id="access" name="access">${options.join("")}</select>
      <div class="actions">
        <button name="decision" value="approve">Approve</button>
        <button name="decision" value="deny" formnovalidate>Deny</button>
      </div>
    </form>`,
  );
}
