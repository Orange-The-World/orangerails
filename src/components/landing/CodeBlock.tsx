export function CodeBlock({ code, language = "ts" }: { code: string; language?: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-terminal text-terminal-foreground shadow-2xl shadow-foreground/10">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-[#FF5F56]" />
          <span className="h-3 w-3 rounded-full bg-[#FFBD2E]" />
          <span className="h-3 w-3 rounded-full bg-[#27C93F]" />
        </div>
        <span className="font-mono text-xs text-terminal-muted">adapter.{language}</span>
        <span className="w-12" />
      </div>
      <pre className="overflow-x-auto px-5 py-5 font-mono text-[13px] leading-relaxed">
        <code dangerouslySetInnerHTML={{ __html: highlight(code) }} />
      </pre>
    </div>
  );
}

// Tiny TS/JS highlighter — no runtime deps. Escapes HTML, then tokenizes.
function highlight(src: string): string {
  const escaped = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const KEYWORDS =
    /\b(import|from|export|default|const|let|var|async|await|function|return|if|else|for|while|new|class|extends|of|in|yield|true|false|null|undefined)\b/g;

  return escaped
    // comments
    .replace(/(\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g, '<span class="text-terminal-muted italic">$1</span>')
    // strings
    .replace(/(['"`])((?:\\.|(?!\1).)*)\1/g, '<span class="text-[#7dd3fc]">$1$2$1</span>')
    // keywords
    .replace(KEYWORDS, '<span class="text-primary">$1</span>')
    // function names after . or before (
    .replace(/\b([a-zA-Z_$][\w$]*)(?=\s*\()/g, '<span class="text-[#fbbf24]">$1</span>');
}
