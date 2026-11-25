import { refreshUsageLimits } from "@ankielcode/client-runtime/state/usage";
import {
  collectExternalUsageLinks,
  collectLimitAccounts,
  type LimitPresentations,
} from "@ankielcode/shared/usageLimits";
import { collectLimitNotices } from "@ankielcode/shared/usageLimitsCopy";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { ensureLocalApi } from "~/localApi";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ColabBalanceRow } from "./ColabBalanceRow";
import { LimitWindows } from "./UsageLimits";

export function TitlebarUsageLimits() {
  const gt = useGT();
  const allPresentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const presentations = new Map(
    [...allPresentations].filter(
      ([, presentation]) => presentation.connection.phase === "connected",
    ),
  );
  const accounts = collectLimitAccounts(presentations);
  let highestUsage: number | undefined;
  for (const { limits } of accounts) {
    for (const window of limits.windows) {
      highestUsage = Math.max(highestUsage ?? 0, window.usedPercent);
    }
  }
  const summary =
    highestUsage === undefined
      ? gt("Provider usage limits")
      : gt("Provider usage limits · highest usage {percent}%", {
          percent: Math.round(highestUsage),
        });

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) return;
    for (const [environmentId, presentation] of presentations) {
      if (presentation.serverConfig !== null) {
        void refreshUsageLimits(
          environmentId,
          () => refreshProviders({ environmentId, input: {} }),
          true,
        );
      }
    }
  }

  return (
    <Popover onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button size="icon-sm" variant="ghost" />}
              aria-label={summary}
            />
          }
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="size-4">
            <circle
              cx="10"
              cy="10"
              r="7.5"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeDasharray={highestUsage === undefined ? "2 2" : undefined}
              className="text-muted-foreground/35"
            />
            {highestUsage !== undefined && highestUsage > 0 ? (
              <circle
                cx="10"
                cy="10"
                r="7.5"
                pathLength="100"
                strokeLinecap="round"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeDasharray={`${highestUsage} 100`}
                transform="rotate(-90 10 10)"
                className={highestUsage >= 90 ? "text-destructive" : undefined}
              />
            ) : null}
          </svg>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{summary}</TooltipPopup>
      </Tooltip>
      <PopoverPopup width="xl" padding="compact" align="end">
        <UsageLimitsBreakdown presentations={presentations} accounts={accounts} />
      </PopoverPopup>
    </Popover>
  );
}

function UsageLimitsBreakdown({
  presentations,
  accounts,
}: {
  readonly presentations: LimitPresentations;
  readonly accounts: ReturnType<typeof collectLimitAccounts>;
}) {
  const gt = useGT();
  const m = useMessages();
  const [now] = useState(() => Date.now());
  const notices = collectLimitNotices(presentations, m, false);
  const externalLinks = collectExternalUsageLinks(presentations, (provider) => provider);
  return (
    <div className="flex flex-col gap-3 py-1">
      <PopoverTitle>{gt("Provider usage limits")}</PopoverTitle>
      {/* One grid for every provider, so labels size to the longest one and bars line up. */}
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 gap-y-3 empty:hidden">
        {accounts.map((account) => {
          const name =
            account.displayName ?? providerClients.get(account.driver)?.label ?? account.driver;
          return (
            <section
              key={account.key}
              className="col-span-3 grid grid-cols-subgrid gap-y-1 border-t border-border/60 pt-2"
            >
              <h3 className="col-span-3 flex min-w-0 items-center gap-2 text-xs font-medium">
                <ProviderInstanceIcon
                  driverKind={account.driver}
                  displayName={name}
                  accentColor={account.accentColor}
                  className="size-4 shrink-0"
                  iconClassName="size-3.5"
                />
                <span className="truncate">{name}</span>
                {account.plan ? (
                  <span className="shrink-0 font-normal text-muted-foreground">
                    {shortPlanLabel(account.plan)}
                  </span>
                ) : null}
                {account.displayName === null && account.email ? (
                  <RedactedSensitiveText
                    value={account.email}
                    ariaLabel={gt("Toggle account email visibility")}
                    revealTooltip={gt("Click to reveal email")}
                    hideTooltip={gt("Click to hide email")}
                    className="truncate"
                  />
                ) : null}
              </h3>
              <LimitWindows
                compact
                subgrid
                driver={account.driver}
                accentColor={account.accentColor}
                windows={account.limits.windows}
                now={now}
              />
              {account.limits.colabComputeUnits !== undefined ? (
                <div className="col-span-3 text-xs">
                  <ColabBalanceRow balance={account.limits.colabComputeUnits} />
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      {externalLinks.map((link) => (
        <div
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2"
        >
          <span className="min-w-0 text-xs break-words text-muted-foreground">
            {link.accounts.join(", ")}
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            {link.label}
          </Button>
        </div>
      ))}
      {notices.map((notice) => (
        <p key={notice} className="text-xs break-words text-muted-foreground">
          {notice}
        </p>
      ))}
      {accounts.length === 0 && externalLinks.length === 0 && notices.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          <T>No provider limits reported.</T>
        </p>
      ) : null}
    </div>
  );
}

// Plan labels repeat the product the provider name already shows, e.g. "ChatGPT Pro 200 Subscription".
function shortPlanLabel(plan: string) {
  return plan.replace(/^(ChatGPT|Claude|Google AI)\s+/i, "").replace(/\s+Subscription$/i, "");
}
