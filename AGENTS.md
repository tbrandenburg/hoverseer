# Hoverseer development rules

- Hoverseer is a thin integration layer. Prefer existing upstream components and libraries to new subsystems or forks.
- Keep one shared, unmodified Homepage. Keep Docker Compose the reference deployment.
- Keep changes small, modular and reversible. Do not mix unrelated refactoring with fixes.
- GitHub Actions is the reference test machine. Use pull requests and the same Checks workflow on manual dispatch.
- Keep the existing unit tests and full-stack smoke tests passing; add regression tests for new behavior.
- Do not claim a change is verified until CI passes for its latest commit. Inspect failing job logs and artifacts; fix failures rather than disabling checks.
- Never put real credentials in tests, logs, screenshots or artifacts. Use a fresh disposable stack with generated test-only credentials.
- No direct changes to main or automatic merge without the maintainer's approval.
- Before adding multiuser functionality, preserve the current behavior. Add explicit negative authorization/isolation tests alongside the relevant change.

- Apply KISS and YAGNI: reuse HITLy's workspace switcher and live membership API; add configuration and infrastructure only when an actual feature requires them.
