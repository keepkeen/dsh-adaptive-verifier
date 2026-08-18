# Security policy

## Reporting

Do not publish a vulnerability containing credentials, private trajectories, customer code, or exploitable command payloads. Contact the repository owner privately through the security-advisory mechanism once the GitHub repository is available.

## Threat model

The plugin processes untrusted model output and potentially sensitive task context. Its verifier prompt is not a security boundary: candidate text may contain prompt injection, fabricated test output, or requests to ignore criteria.

Mitigations in this repository:

- verifier system instructions prioritize observed evidence over candidate claims;
- candidate content is treated as quoted evidence, not executable input;
- rejected action candidates never reach Harness tool dispatch;
- cache files use request hashes and contain scores rather than raw prompts;
- cache files are written with owner-only mode where supported;
- API keys are read from an environment-variable reference and never serialized;
- live API tests are opt-in;
- evidence enforcement defaults to advisory;
- explicit budgets bound expensive verification loops.

## Residual risks

- A candidate can forge text that resembles terminal output. Use event-structured evidence and exact checkers where possible.
- Same-model verifiers share generator blind spots.
- A score cache hash can still reveal repeated-input equality to an observer with filesystem access.
- `enforce` mode can block legitimate operations when command patterns are poorly calibrated.
- Full trajectory fanout without workspace isolation can corrupt state.
- A selected plan can still be unsafe; preserve Harness sandbox, approval, and permission policies.

## Deployment guidance

- Pin plugin and Harness commits.
- Restrict cache-directory permissions.
- Avoid caching highly sensitive workloads, or place the cache on encrypted storage.
- Keep destructive, publishing, financial, and production-data operations behind independent approvals.
- Re-run authoritative tests in a clean promotion environment.
- Treat third-party Git plugin installation as code execution; audit and pin the exact commit.
