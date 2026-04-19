export function Terminal() {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-terminal text-terminal-foreground shadow-2xl shadow-foreground/10">
      {/* Title bar */}
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-[#FF5F56]" />
          <span className="h-3 w-3 rounded-full bg-[#FFBD2E]" />
          <span className="h-3 w-3 rounded-full bg-[#27C93F]" />
        </div>
        <span className="font-mono text-xs text-terminal-muted">~/orangerails</span>
        <span className="w-12" />
      </div>

      {/* Body */}
      <div className="space-y-1.5 px-5 py-5 font-mono text-[13px] leading-relaxed">
        <Line>
          <Prompt />
          <span>npx orangerails init</span>
        </Line>
        <Line muted>
          <Check /> Detected: <Hl>Bitcoin Core</Hl>, <Hl>BTCPay Server</Hl>
        </Line>
        <Line muted>
          <Check /> Added adapters: <Hl>Blink</Hl>, <Hl>Kraken</Hl>, <Hl>Ocean Pool</Hl>
        </Line>
        <Line muted>
          <Check /> Sync enabled. Zero-knowledge mode: <span className="text-primary">ON</span>
        </Line>
        <div className="h-2" />
        <Line>
          <Prompt />
          <span>orangerails sync --live</span>
        </Line>
        <Line muted>
          <span className="text-terminal-muted">[14:32]</span> Imported{" "}
          <span className="text-primary">47</span> transactions
          <Cursor />
        </Line>
      </div>
    </div>
  );
}

function Prompt() {
  return <span className="mr-2 text-primary">$</span>;
}

function Check() {
  return <span className="mr-2 text-[#22C55E]">✓</span>;
}

function Hl({ children }: { children: React.ReactNode }) {
  return <span className="text-terminal-foreground">{children}</span>;
}

function Line({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <div className={`flex items-baseline ${muted ? "text-terminal-muted" : "text-terminal-foreground"}`}>
      {children}
    </div>
  );
}

function Cursor() {
  return <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse bg-primary align-middle" />;
}
