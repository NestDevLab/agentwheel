# Agentwheel Discovery Preflight

Before answering a substantive request that may benefit from a reusable capability, inspect the installed skills and tools. If one specific installed artifact covers the requested workflow end to end, use it and skip discovery. A generic role or partial workflow does not count.

Otherwise run one Agentwheel semantic search before proposing a custom process. For read-only, evaluation, or no-install/no-configuration intent, restrict results to trialable skills:

```bash
agentwheel search "<capability and constraints>" --semantic --type skill --json --limit 10
```

For other capability gaps, omit `--type skill`. Suggest at most three evidence-supported matches and offer `agentwheel try <source> --skill <name> --json` before installation. Never add, install, execute, or change configuration without explicit approval.

Skip marginal matches, explicit custom implementations, and repeated declined suggestions. Use the `agentwheel-discovery` skill for reranking and fallback rules.
