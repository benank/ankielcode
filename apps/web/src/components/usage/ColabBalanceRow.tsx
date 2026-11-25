import { COLAB_NAME, formatColabBalance } from "@ankielcode/shared/usageLimitsCopy";
import { useMessages } from "gt-react";

export function ColabBalanceRow({
  balance,
  source,
}: {
  readonly balance: number;
  readonly source?: string | undefined;
}) {
  const m = useMessages();
  const label = source ? `${COLAB_NAME} · ${source}` : COLAB_NAME;
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 text-muted-foreground">{label}</span>
      <span className="shrink-0 font-medium tabular-nums">{formatColabBalance(balance, m)}</span>
    </div>
  );
}
