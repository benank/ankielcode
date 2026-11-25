const AGENT_EMAILS = new Set([
  "noreply@anthropic.com",
  "claude@anthropic.com",
  "noreply@openai.com",
  "codex@openai.com",
  "chatgpt@openai.com",
  "noreply@google.com",
  "gemini@google.com",
  "antigravity@google.com",
  "cursoragent@cursor.com",
  "noreply@cursor.com",
  "copilot@github.com",
  "noreply@github.com",
  "noreply@x.ai",
  "grok@x.ai",
  "amp@ampcode.com",
  "noreply@opencode.ai",
  "opencode@opencode.ai",
  "noreply@kiro.dev",
  "kiro@kiro.dev",
  "noreply@aider.chat",
  "aider@aider.chat",
  "noreply@devin.ai",
  "devin@devin.ai",
  "noreply@windsurf.com",
  "noreply@codeium.com",
  "noreply@cline.bot",
  "noreply@qwen.ai",
  "noreply@deepseek.com",
]);

const AI_BOT_GITHUB_NOREPLY =
  /^(?:\d+\+)?(?:devin-ai-integration|copilot-swe-agent|claude|codex|cursor|gemini|aider|sweep-ai)\[bot\]@users\.noreply\.github\.com$/i;

// Unambiguous AI model or agent names in Co-Authored-By trailers (bare "Claude" is excluded so a
// human named Claude with a personal email is preserved).
const UNAMBIGUOUS_AGENT_AUTHOR_NAME =
  /^(?:claude[\s-]+(?:code|opus|sonnet|haiku|fable|\d)|(?:opus|sonnet|haiku|fable)[\s-]+\d|gemini(?:[\s-]+\d|[\s-]+(?:pro|flash|ultra|neon|code|cli))|gpt[\s-]*\d|chatgpt\b|openai[\s-]+codex\b|codex(?:[\s-]+cli)?$|antigravity\b|cursor[\s-]+agent\b|github[\s-]+copilot\b|devin(?:\s+ai)?$|grok[\s-]+\d|opencode\b|muse[\s-]+code\b|aider\b|windsurf\b|cline\b)/i;

const KNOWN_AI_LINK =
  /\[([^[\]\r\n]+)\]\(https:\/\/(?:claude\.ai|claude\.com|www\.anthropic\.com|anthropic\.com|chatgpt\.com|openai\.com|cursor\.com|github\.com|opencode\.ai|x\.ai|antigravity\.google|gemini\.google\.com|ai\.google\.dev|deepmind\.google|devin\.ai|ampcode\.com|aider\.chat|kiro\.dev|windsurf\.com|codeium\.com|cline\.bot|code\.ankiel\.com|ankiel\.com)(?:\/[^\s)[\]]*)?\)/gi;

const VERSION_TOKEN = String.raw`\d+(?:\.\d+)*(?:[\s-]+(?:pro|flash|ultra|neon|mini|nano|turbo|codex|sol|preview|thinking|max|lite|sonnet|opus|haiku|fable))*`;

const MODEL_OR_AGENT =
  `(?:` +
  `claude(?:[\\s-]+(?:code|opus|sonnet|haiku|fable)(?:[\\s-]+${VERSION_TOKEN})?|[\\s-]+${VERSION_TOKEN})?` +
  `|(?:opus|sonnet|haiku|fable)[\\s-]+${VERSION_TOKEN}` +
  `|gemini(?:[\\s-]+${VERSION_TOKEN}|[\\s-]+(?:pro|flash|ultra|neon|code|cli))?` +
  `|gpt[\\s-]*${VERSION_TOKEN}` +
  `|chatgpt(?:[\\s-]+${VERSION_TOKEN})?` +
  `|o[134](?:-(?:mini|pro|preview))?` +
  `|grok(?:[\\s-]+${VERSION_TOKEN})?` +
  `|muse(?:[\\s-]+code|[\\s-]+spark(?:[\\s-]+${VERSION_TOKEN}(?:[\\s-]+contributor)?)?)?` +
  `|codex(?:[\\s-]+cli)?` +
  `|antigravity` +
  `|cursor(?:[\\s-]+agent)?` +
  `|github[\\s-]+copilot` +
  `|copilot` +
  `|opencode` +
  `|kiro` +
  `|pi` +
  `|fx` +
  `|devin(?:[\\s-]+ai)?` +
  `|amp` +
  `|aider` +
  `|windsurf` +
  `|cline` +
  `|deepseek(?:[\\s-]+(?:r1|v\\d+(?:\\.\\d+)*))?` +
  `|qwen(?:[\\s-]+${VERSION_TOKEN})?` +
  `)`;

const EFFORT_TAG = String.raw`(?:\s*\((?:low|medium|high|max|minimal|none|xhigh|fast|default|thinking)\))?`;

const HARNESS_NAME =
  `(?:` +
  `claude[\\s-]+code` +
  `|codex(?:[\\s-]+cli)?` +
  `|antigravity` +
  `|cursor(?:[\\s-]+agent)?` +
  `|github[\\s-]+copilot` +
  `|copilot` +
  `|opencode` +
  `|grok` +
  `|kiro` +
  `|pi` +
  `|muse(?:[\\s-]+code)?` +
  `|fx` +
  `|devin(?:[\\s-]+ai)?` +
  `|amp` +
  `|aider` +
  `|windsurf` +
  `|cline` +
  `|ankiel(?:[\\s-]+code)?` +
  `)`;

const HARNESS_QUALIFIER =
  `(?:` +
  `(?:via|in|with|on)\\s+(?:the\\s+)?${HARNESS_NAME}(?:\\s+(?:harness|cli|agent))?` +
  `|\\(\\s*(?:the\\s+)?${HARNESS_NAME}(?:\\s+(?:harness|cli|agent))?\\s*\\)` +
  `|\\/\\s*${HARNESS_NAME}(?:\\s+(?:harness|cli|agent))?` +
  `)`;

const GENERATED_BY_AGENT = new RegExp(
  `^(?:(?:🤖|✨|⚡)\\s*)?(?:generated|implemented|written|authored|created|built|powered)\\s+(?:with|by|using)\\s+(?:the\\s+)?${MODEL_OR_AGENT}${EFFORT_TAG}(?:\\s+${HARNESS_QUALIFIER})*[.!]?$`,
  "i",
);

const LABELED_ATTRIBUTION = new RegExp(
  `^(?:model(?:\\s*(?:and|&|\\/|\\+)\\s*harness)?|agent|harness|ai(?:\\s+(?:model|agent|assistant))?)\\s*:\\s*${MODEL_OR_AGENT}${EFFORT_TAG}(?:\\s+${HARNESS_QUALIFIER})*[.!]?$`,
  "i",
);

const STANDALONE_MODEL_HARNESS = new RegExp(
  `^${MODEL_OR_AGENT}${EFFORT_TAG}(?:\\s+${HARNESS_QUALIFIER})+[.!]?$`,
  "i",
);

const CO_AUTHOR_PREFIX = /^co-authored-by:/i;
const SCISSOR_LINE = /^# -+ >8 -+$/;

function isAgentAuthor(text: string): boolean {
  const prefix = CO_AUTHOR_PREFIX.exec(text);
  if (prefix === null || !text.endsWith(">")) return false;
  const emailStart = text.lastIndexOf("<");
  if (emailStart < prefix[0].length) return false;
  const name = text.slice(prefix[0].length, emailStart).trim();
  const email = text.slice(emailStart + 1, -1).toLowerCase();
  if (AGENT_EMAILS.has(email)) {
    // GitHub's generic noreply address is also used by people; require Copilot's name.
    return email !== "noreply@github.com" || /^(?:github )?copilot$/i.test(name);
  }
  if (AI_BOT_GITHUB_NOREPLY.test(email)) return true;
  return UNAMBIGUOUS_AGENT_AUTHOR_NAME.test(name);
}

function isAgentAttributionLine(text: string): boolean {
  if (isAgentAuthor(text)) return true;
  const unwrapped = text.replace(KNOWN_AI_LINK, "$1");
  return (
    GENERATED_BY_AGENT.test(unwrapped) ||
    LABELED_ATTRIBUTION.test(unwrapped) ||
    STANDALONE_MODEL_HARNESS.test(unwrapped)
  );
}

export function removeAgentCredits(message: string): string {
  let fence: string | undefined;
  let removed = false;
  const newline = message.includes("\r\n") ? "\r\n" : "\n";
  const lines = message.split(/\r?\n/).filter((line) => {
    if (/^(?: {4}|\t)/.test(line)) return true;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = delimiter?.[1];
    const remainder = delimiter?.[2] ?? "";
    if (marker !== undefined) {
      if (fence === undefined) {
        if (marker[0] === "~" || !remainder.includes("`")) fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^[ \t]*$/.test(remainder)
      ) {
        fence = undefined;
      }
      return true;
    }
    if (fence !== undefined) return true;
    const text = line.trim().replace(/^(?:[-*]\s+)/, "");
    if (!isAgentAttributionLine(text)) return true;
    removed = true;
    return false;
  });
  if (!removed) return message;
  while (lines.length > 1 && /^[ \t]*$/.test(lines.at(-1)!)) {
    lines.pop();
  }
  if (lines.length === 1 && /^[ \t]*$/.test(lines[0]!)) {
    return "";
  }
  return lines.join(newline);
}

/** Strips agent credits from a git commit message file while leaving scissor diffs and comments intact. */
export function stripCommitMessageFileContent(content: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const rawLines = content.split(/\r?\n/);
  const scissorIndex = rawLines.findIndex((line) => SCISSOR_LINE.test(line));
  const editableEnd = scissorIndex === -1 ? rawLines.length : scissorIndex;

  let trailingCommentStart = editableEnd;
  while (trailingCommentStart > 0) {
    const line = rawLines[trailingCommentStart - 1]!;
    if (line.startsWith("#") || /^[ \t]*$/.test(line)) {
      trailingCommentStart -= 1;
    } else {
      break;
    }
  }
  // Only treat trailing lines as a git comment block if at least one starts with '#'.
  const hasTrailingComments = rawLines
    .slice(trailingCommentStart, editableEnd)
    .some((line) => line.startsWith("#"));
  const bodyEnd = hasTrailingComments ? trailingCommentStart : editableEnd;

  const body = rawLines.slice(0, bodyEnd).join(newline);
  const cleaned = removeAgentCredits(body);
  if (cleaned === body) return content;

  const suffix = rawLines.slice(bodyEnd);
  if (suffix.length === 0) {
    return content.endsWith("\n") && cleaned.length > 0 ? `${cleaned}${newline}` : cleaned;
  }
  return cleaned.length > 0 ? `${cleaned}${newline}${suffix.join(newline)}` : suffix.join(newline);
}
