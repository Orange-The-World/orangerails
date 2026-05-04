/**
 * Stealth Sync widget — direct-load fallback card.
 *
 * Shown when the widget is loaded directly in a browser (no opener, no parent
 * frame) and no OR_STEALTH_INIT message arrives within the grace window. This
 * replaces the indefinite "Loading…" placeholder so visitors see a clear,
 * plain-English explanation instead of what looks like a hung page.
 */

export function DirectLoadCard() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md rounded-lg border border-orange-500/30 bg-orange-500/5 p-6 text-center">
        <h1 className="text-lg font-semibold text-orange-600">
          Stealth Sync widget
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This page is the Stealth Sync widget. It is meant to be opened from
          inside an app when you connect a Bitcoin xpub. Opening it directly
          in your browser is fine, it just means it has nothing to do until
          an app talks to it.
        </p>
        <ul className="mt-4 space-y-2 text-left text-sm text-muted-foreground">
          <li>
            If you got here by clicking a link from an app: try the connect
            button in that app again.
          </li>
          <li>
            If you are a developer testing the integration: send an
            OR_STEALTH_INIT postMessage to this window.
          </li>
          <li>
            For more information, visit{" "}
            <a
              href="https://orangerails.com"
              className="text-orange-600 underline hover:text-orange-700"
            >
              orangerails.com
            </a>
            .
          </li>
        </ul>
      </div>
    </div>
  );
}

export default DirectLoadCard;
