# Gateway update verification — 2026-11-12

- Full portable chatbot + Gateway suite: **4,877 passed, 0 failed, 0 skipped**, Node 22.23.2 on macOS.
- Included Gateway suite: **86 passed**; synthetic provider mocks test OpenAI/Claude forwarding, key failover, fallback allowlist, readiness, migration, model-test receipts, and bounded audio forwarding.
- Shell syntax checked for bootstrap/control scripts. Symlink launcher execution verified.
- Independent JavaScript/code review: high findings fixed; public privacy re-audit passed with non-blocking legacy protocol naming warnings.
- No paid provider calls, customer messages, learner VPS deployment, Windows execution or fresh systemd/Caddy recovery test in this update.
- The original local Console UI verification below remains applicable to unchanged UI assets; this update tests the Gateway/installer integration in local tests.
- model-test is a pre-go-live setup receipt, not continuous authorization enforcement after model changes. Catalog availability/pricing must be checked for the learner account.

# Verification scope

- Upstream source: 535 chassis file hashes matched the running release before generic adaptation.
- Final portable chatbot suite: **4,791 passed, 0 failed, 0 skipped** (Node 22.23.2, macOS).
- Focused brand/name and directive regression suite: 243 passed; new generic business fallback integration cases passed.
- Independent JavaScript review: 101 focused tests passed; no remaining critical/high findings in reviewed surface.
- Existing unchanged Nongkao suite: 37 passed. Content Studio: 18 passed and blueprint check passed.
- Chrome local UI: logged in to synthetic generic shop, inspected overview and knowledge screen. No live provider calls.
- Launcher check found Node/SSH/SCP/tar; expected fresh-user blockers: no learner SSH key or VPS target configured.
- No configured typecheck/ESLint in the engine. Windows and fresh VPS install/recovery were not executed in this packaging run.
- No learner VPS deployed, live channel enabled, customer message sent or content published.

Private-instance regression suites are not distributed because they require private brain/persona artifacts. Passing counts refer to portable tests included in this repo.
