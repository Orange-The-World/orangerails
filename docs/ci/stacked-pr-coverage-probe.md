# Stacked pull request coverage probe

Scratch. Not product code. Delete the branches this lives on once the
evidence has been recorded.

## Why this file exists

CI used to be triggered only for pull requests based on `dev` or `prod`:

    on:
      pull_request:
        branches: [dev, prod]

A pull request based on any other branch therefore ran no job from that
workflow. No unit tests, no lint or build, no edge function typecheck, no
secret scan. The Cloudflare Pages checks were posted by a different
integration and kept appearing, so such a pull request still showed a row
of green ticks that a reviewer could reasonably mistake for coverage.

The base filter has been removed from the `pull_request` trigger. The
`push` trigger keeps its own filter, so nothing changed about what runs on
a branch push.

## What this branch is for

A one-line change to a trigger is only proven by watching it fire. This
branch is stacked deliberately: its pull request is opened against
another feature branch rather than against `dev`, which is exactly the
shape that used to run nothing. The evidence is the check list on that
pull request, not anything in this file.

The file has no product meaning and must not be imported, linked or built
against.
