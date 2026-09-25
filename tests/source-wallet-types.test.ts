import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lines = readFileSync("src/integrations/supabase/types.ts", "utf8").split(/\r?\n/);
const start = lines.indexOf("      source_wallets: {");
const end = lines.findIndex((line, index) => index > start && /^ {6}[A-Za-z0-9_]+: \{$/.test(line));
const sourceWallets = lines.slice(start, end).join("\n");

describe("source_wallets generated types", () => {
  it("preserves the nullable DEV metadata columns in every generated shape", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(sourceWallets.match(/^ {10}encrypted_metadata: string \| null$/gm)).toHaveLength(1);
    expect(
      sourceWallets.match(/^ {10}encrypted_metadata_key_version: number \| null$/gm),
    ).toHaveLength(1);
    expect(sourceWallets.match(/^ {10}encrypted_metadata\?: string \| null$/gm)).toHaveLength(2);
    expect(
      sourceWallets.match(/^ {10}encrypted_metadata_key_version\?: number \| null$/gm),
    ).toHaveLength(2);
  });
});
