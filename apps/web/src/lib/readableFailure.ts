import { sourceControlClients } from "@ankielcode/client-runtime/source-control-clients";

const HOST_LABELS = sourceControlClients.definitions
  .map((definition) => definition.label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
  .join("|");

const TOOL_NOISE = [
  new RegExp(`^(${HOST_LABELS})?\\s*(cli|api)?\\s*(command\\s*)?failed\\.?$`, "iu"),
  /^exited? with (code|status) \d+\.?$/iu,
  /^unknown error\.?$/iu,
];

const FAILURE_DETAIL_MAX_LENGTH = 320;

/** A host failure's own words when they say something, else `hint`. */
export function readableFailure(failure: unknown, hint: string): string {
  const raw =
    failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
  const detail = raw.trim();
  if (detail.length === 0 || TOOL_NOISE.some((pattern) => pattern.test(detail))) return hint;
  if (detail.length <= FAILURE_DETAIL_MAX_LENGTH) return detail;
  let end = FAILURE_DETAIL_MAX_LENGTH - 1;
  const last = detail.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${detail.slice(0, end)}…`;
}
