import type { UsageProviderKind } from "@ankielcode/contracts";
import type { TranscriptUsageFormat } from "@ankielcode/provider-core/server/usage";
import { piUsageFormat } from "@ankielcode/provider-pi/server/usage";
import { grokUsageFormat } from "@ankielcode/provider-grok/server/usage";
import { museUsageFormat } from "@ankielcode/provider-muse/server/usage";

import { claudeUsageFormat } from "../provider/Drivers/claudeUsage.ts";
import { codexUsageFormat } from "../provider/Drivers/codexUsage.ts";

export const TEST_FORMATS: Record<
  "claude" | "codex" | "grok" | "pi" | "muse",
  TranscriptUsageFormat<unknown>
> = {
  claude: claudeUsageFormat,
  codex: codexUsageFormat,
  grok: grokUsageFormat,
  pi: piUsageFormat,
  muse: museUsageFormat,
};

export const TEST_FORMAT_MAP = new Map<UsageProviderKind, TranscriptUsageFormat<unknown>>(
  Object.entries(TEST_FORMATS) as Array<[UsageProviderKind, TranscriptUsageFormat<unknown>]>,
);
