# OR-T1344 live demonstration (throwaway)

Push 2 of 2, done in quick succession to supersede push 1's Cloudflare
Pages deployment, so push 1's "Cloudflare Pages: orangerails-dev" check
reads queued:skipped and the stuck-check-run sweep
(cf-pages-check-sweep.yml) has something real to resolve.

This file and branch are throwaway, per OR-T1344 acceptance item 2.

Attempt 2: pushes 1 and 2 landed 6s apart and Cloudflare skipped push 1's
deployment before ever posting a check-run for it (0 check-runs on
b063c8b3), so there was nothing for the sweep to resolve. Widening the
gap this time so the first check-run has time to be created before the
second push supersedes it.

Push 3 (45e94227) sat queued:active for several minutes under real queue
load before this push superseded it, per orangerails-dev's live deployment
queue at the time.
