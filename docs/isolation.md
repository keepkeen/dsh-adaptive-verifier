# Isolation and winner promotion

## Two different forms of Best-of-N

### Response-level Best-of-N

`deepseek-verified` samples several candidate assistant responses to one Harness model request. Selection happens before the response reaches the Agent Loop, so rejected tool calls have no side effects. This mode needs no extra filesystem isolation.

### Trajectory-level Best-of-N

`ctx.adaptiveVerifier.select()` can rank completed trajectories, but it does not execute them. The orchestrator must isolate each execution world.

## What a Session fork does not copy

A copied Session/history does not clone:

- current filesystem contents;
- uncommitted git changes;
- running processes;
- terminal state;
- bound ports;
- databases;
- cloud resources;
- external API side effects;
- environment-local caches.

Running multiple candidate agents against one mutable workspace creates interference and invalidates both evidence and comparison.

## Recommended coding-agent design

```text
base commit
   ├── git worktree candidate-a
   ├── git worktree candidate-b
   └── git worktree candidate-c
```

Each candidate should receive:

- its own worktree or copy-on-write container layer;
- isolated temporary directory;
- unique port range and process namespace;
- deterministic task seed where relevant;
- a bounded runtime and cleanup owner.

Collect each candidate’s transcript, patch hash, exact test results, and artifact manifest. Rank candidates without supplying hidden labels.

## Promotion protocol

1. Select a candidate.
2. Export a patch or immutable artifact from its isolated workspace.
3. Apply it to a clean promotion workspace.
4. Re-run the authoritative tests/checks.
5. Promote only after the clean recheck passes.
6. Record selected candidate ID, artifact hash, checker output, and verifier budget.
7. Dispose every candidate environment.

A verifier score is a routing signal, not an authorization to skip exact verification.

## Destructive or external operations

For tasks that deploy, publish, send messages, mutate production data, or incur financial cost, candidate trajectories should run against mocks/staging systems. The winning plan must pass a separate approval policy before executing the real operation.
