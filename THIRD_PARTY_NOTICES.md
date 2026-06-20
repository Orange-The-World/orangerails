# Third-party notices

This document aggregates the licenses of third-party components shipped or
linked by Orange Rails. Each component is governed by the license stated in
its own source distribution.

## NPM dependencies

The runtime and build-time NPM dependency tree is the source of truth for
this list. To regenerate a fresh inventory:

```bash
bunx license-checker --production --json > third-party-npm.json
```

## Cargo dependencies (Rust crates)

```bash
cargo about generate --output-file third-party-cargo.html
```

## Notable inclusions

- **@noble/curves**, **@noble/hashes** — MIT (Paul Miller).
- **viem**, **wagmi** — MIT.
- **deno_std** — MIT (Deno authors). Edge function shared modules.
- **@supabase/supabase-js** — MIT.
- **shadcn/ui** components — MIT.
- **react**, **react-dom** — MIT (Meta).
- **typescript** — Apache 2.0 (Microsoft).
- **vite** — MIT.
- **tailwindcss** — MIT.

If you reuse Orange Rails downstream, regenerate the inventories above
against your own lockfile; the dependency surface evolves with each
release.
