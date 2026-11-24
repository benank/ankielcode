import { thrownErrorMessage } from "@ankielcode/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@ankielcode/client-runtime/state/runtime";
import type { EnvironmentId, RelayTunnelStatus } from "@ankielcode/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { m as resolveMessage } from "~/i18n/messages";
import { relayTunnelEnvironment } from "~/state/relayTunnel";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

export function RemoteRelaySettingsRow({
  title,
  environmentId,
  status,
  isLoading,
  queryError,
  canWriteAccess,
}: {
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly status: RelayTunnelStatus | null;
  readonly isLoading: boolean;
  readonly queryError: string | null;
  readonly canWriteAccess: boolean;
}) {
  const gt = useGT();
  const configureRelay = useAtomCommand(relayTunnelEnvironment.configure, {
    reportFailure: false,
  });
  const disconnectRelay = useAtomCommand(relayTunnelEnvironment.disconnect, {
    reportFailure: false,
  });

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isDisconnectDialogOpen, setIsDisconnectDialogOpen] = useState(false);
  const [setupInput, setSetupInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: gt("Copied relay URL"),
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy relay URL"),
          description: error.message,
        }),
      );
    },
  });

  const isEnvManaged = status?.source === "env";
  const isConfigured = status?.configured === true;
  const isConnected = status?.connected === true;
  const publicBaseUrl = status?.publicBaseUrl ?? null;

  const openDialog = () => {
    setSetupInput("");
    setFormError(null);
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    const trimmed = setupInput.trim();
    if (!trimmed) {
      setFormError(gt("Paste a relay setup string to continue."));
      return;
    }
    setIsSaving(true);
    setFormError(null);
    setRowError(null);
    const result = await configureRelay({
      environmentId,
      input: { setup: trimmed },
    });
    setIsSaving(false);
    if (result._tag === "Success") {
      setSetupInput("");
      setIsDialogOpen(false);
      toastManager.add({
        type: "success",
        title: result.value.connected ? gt("Remote relay connected") : gt("Remote relay saved"),
        description: result.value.publicBaseUrl ?? undefined,
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Could not configure remote relay.");
      setFormError(message);
    }
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    setRowError(null);
    const result = await disconnectRelay({
      environmentId,
      input: {},
    });
    setIsDisconnecting(false);
    if (result._tag === "Success") {
      setIsDisconnectDialogOpen(false);
      toastManager.add({
        type: "success",
        title: gt("Remote relay disconnected"),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Could not disconnect remote relay.");
      setRowError(message);
      setIsDisconnectDialogOpen(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not disconnect remote relay"),
          description: message,
        }),
      );
    }
  };

  const description = isLoading
    ? gt("Loading…")
    : isConnected && publicBaseUrl
      ? publicBaseUrl
      : isConfigured
        ? (status.relayOrigin ?? gt("Connecting to remote relay…"))
        : gt("Connect a self-hosted Cloudflare Relay for remote and mobile access.");

  const statusNode = (() => {
    const activeError = rowError ?? queryError;
    if (activeError) {
      return <span className="block text-destructive">{activeError}</span>;
    }
    if (isConfigured && !isConnected) {
      return status.lastError ? (
        <span className="block text-destructive">{status.lastError}</span>
      ) : (
        <span className="block text-muted-foreground">
          <T>Connecting to relay…</T>
        </span>
      );
    }
    if (isEnvManaged) {
      return (
        <span className="block text-muted-foreground">
          <T>Configured via environment variables.</T>
        </span>
      );
    }
    return null;
  })();

  const control = isConfigured ? (
    <div className="flex flex-wrap items-center gap-1.5">
      {publicBaseUrl ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => copyToClipboard(publicBaseUrl, undefined)}
        >
          {isCopied ? gt("Copied") : gt("Copy URL")}
        </Button>
      ) : null}
      {!isEnvManaged && canWriteAccess ? (
        <>
          <Button size="sm" variant="outline" onClick={openDialog}>
            <T>Change</T>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isDisconnecting}
            onClick={() => setIsDisconnectDialogOpen(true)}
          >
            <T>Disconnect</T>
          </Button>
        </>
      ) : null}
    </div>
  ) : (
    <Button
      size="sm"
      variant="outline"
      disabled={!canWriteAccess || isLoading}
      onClick={openDialog}
    >
      <T>Connect</T>
    </Button>
  );

  return (
    <>
      <SettingsRow title={title} description={description} status={statusNode} control={control} />

      <Dialog
        open={isDialogOpen}
        onOpenChange={(open) => {
          if (isSaving) return;
          setIsDialogOpen(open);
          if (!open) {
            setSetupInput("");
            setFormError(null);
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {isConfigured ? <T>Change remote relay</T> : <T>Connect remote relay</T>}
              </DialogTitle>
              <DialogDescription>
                <T>
                  Paste the setup string printed by your self-hosted Cloudflare Relay setup script.
                </T>
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <label className="block">
                <span className="text-sm font-medium text-foreground">
                  <T>Relay setup string</T>
                </span>
                <Input
                  className="mt-2"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="ankiel-relay://your-relay.workers.dev#secret"
                  value={setupInput}
                  onChange={(event) => {
                    setSetupInput(event.target.value);
                    if (formError) setFormError(null);
                  }}
                  disabled={isSaving}
                />
              </label>
              <p className="mt-2 text-xs text-muted-foreground">
                <T>
                  Run <code>npm run setup</code> in the <code>relay/</code> directory to deploy and
                  copy your setup string.
                </T>
              </p>
              {formError ? <p className="mt-2 text-xs text-destructive">{formError}</p> : null}
            </DialogPanel>
            <DialogFooter>
              <DialogClose
                disabled={isSaving}
                render={<Button type="button" variant="outline" disabled={isSaving} />}
              >
                <T>Cancel</T>
              </DialogClose>
              <Button type="submit" disabled={isSaving || setupInput.trim().length === 0}>
                {isSaving ? (
                  <>
                    <Spinner size="sm" />
                    <T>Connecting…</T>
                  </>
                ) : (
                  <T>Connect</T>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={isDisconnectDialogOpen}
        onOpenChange={(open) => {
          if (isDisconnecting) return;
          setIsDisconnectDialogOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Disconnect remote relay?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                This stops the outbound relay tunnel and removes the saved relay secret from this
                machine. Devices connected through the relay will lose access until you reconnect.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={isDisconnecting}
              render={<Button variant="outline" disabled={isDisconnecting} />}
            >
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={isDisconnecting}
              onClick={() => void handleDisconnect()}
            >
              {isDisconnecting ? (
                <>
                  <Spinner size="sm" />
                  <T>Disconnecting…</T>
                </>
              ) : (
                <T>Disconnect</T>
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
