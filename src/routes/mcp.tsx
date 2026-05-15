import { createFileRoute } from "@tanstack/react-router";

const TARGET = "https://docs.orangerails.com/mcp";

export const Route = createFileRoute("/mcp")({
  beforeLoad: () => {
    if (typeof window !== "undefined") {
      window.location.replace(TARGET);
    }
  },
  component: McpRedirect,
});

function McpRedirect() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      Redirecting to the MCP docs…{" "}
      <a href={TARGET} className="ml-1 text-primary underline">
        click here
      </a>
      .
    </div>
  );
}
