import type { StealthInitStorageMessage } from "@/stealth/lib/postmessage";
import { StorageChoice } from "../components/BlockStorage";

export function StorageRoute({
  init: _init,
  parent: _parent,
}: {
  init: StealthInitStorageMessage;
  parent: Window | null;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-5">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">Downloaded Bitcoin blocks</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose where the shared download lives, see what it uses, or delete it.
        </p>
        <div className="mt-4">
          <StorageChoice />
        </div>
        <button
          type="button"
          onClick={() => window.close()}
          className="mt-4 inline-flex w-full items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
        >
          Close this window
        </button>
      </div>
    </div>
  );
}

export default StorageRoute;
