# Reviewing dsh-spm

This guide provides a short path from project claims to implementations, tests and known limits. Start with the [README](../README.md) for scope and [AGENTS.md](../AGENTS.md) for repository conventions. The examples below are entry points for review, not a comprehensive audit.

## What the project owns

The migration separates instrument and scientific domain logic from the agent harness. This repository implements the Nanonis protocol integration, instrument state, safety checks, numerical and image-analysis routines, and skill contracts. DeepSeek Harness supplies model orchestration, sessions, approvals and the application shell.

The Python/LangGraph reference system, MAST, remains separate and read-only. Its instrument-use history explains the origin of some requirements; this public repository does not independently reproduce that history or establish hardware validation of the TypeScript plugin. Reference implementation code and the external STM simulator are not included.

## Five paths through the evidence

### 1. A model-facing contract and its execution checks

Read [tool.ts](../packages/host/stm-skills/src/tool.ts), [tool-schema.ts](../packages/host/kernel/src/tool-schema.ts) and [tool-schema-real.test.ts](../packages/host/kernel/src/tool-schema-real.test.ts), then follow execution into [skill-kernel.ts](../packages/host/kernel/src/skill-kernel.ts) and [safety.ts](../packages/host/kernel/src/safety.ts).

One concrete adaptation is `D-SCHEMA-2` in [the deviation register](../spec/deviations.md): the pinned dsh parameter DSL does not represent the numerical bounds used by the reference schema. The adapter includes those bounds in descriptions, while execution checks enforce them. [tool.test.ts](../packages/host/stm-skills/src/tool.test.ts) exercises the adaptation against the real dsh package; [skill-kernel.test.ts](../packages/host/kernel/src/skill-kernel.test.ts) checks execution gates. Inspect both to distinguish what is enforced from what is communicated to the model. A correct schema alone does not establish safe instrument behavior.

### 2. Reference-driven numerical behavior

Read [numerics.test.ts](../packages/host/numerics/src/numerics.test.ts), the relevant [numerical implementation](../packages/host/numerics/src), [numerics.json](../spec/golden/numerics.json) and [export_numerics.py](../tools/spec-export/export_numerics.py).

The exporter documents how reference functions produce expected results. Tests use exact comparisons or declared tolerances according to the operation. For example, `D-NUM-25` records a correlation precision difference involving NumPy/BLAS. This is evidence of behavior on the exported cases; it is not a blanket claim of bitwise equivalence with NumPy or SciPy.

The checked-in fixtures can be tested without MAST. This numerical exporter can also be rerun with its public Python dependencies: NumPy, SciPy and scikit-image. Other, MAST-specific exporters require the private reference environment. Public descriptive fields have undergone documented cleanup; see [the public-content review](PUBLIC-CODE-REVIEW.md) for changes and regeneration caveats.

### 3. Tests that must detect a deliberate defect

Read [run.ts](../tools/mutate/run.ts), select an entry in [mutations.ts](../tools/mutate/mutations.ts), and inspect the tests in its declared scope. The CLI checks the baseline before changing source, requires a unique replacement and successful compilation, and checks that tests actually ran and failed.

The distinction matters: a pre-existing test failure or a compiler error cannot establish that a guard's test detected its removal. The runner reports surviving mutations and inconclusive or insufficient-scope results separately. [green-8.md](handoff/green-8.md) records a case where baseline failures had masked surviving mutations.

A registered mutation is not a successful drill. The Vitest mutation meta-tests call `runOne` directly and do not run the CLI's batch baseline check. Use [the development guide](DEVELOPMENT.md) if executing a drill; it temporarily edits source and needs exclusive use of the working tree.

### 4. A dependency inventory with stated limits

Read [tip-phase-deps.test.ts](../packages/host/stm-skills/src/l0/tip-phase-deps.test.ts), [tip_phase_deps.json](../spec/golden/tip_phase_deps.json) and [export_tip_phase_deps.py](../tools/spec-export/export_tip_phase_deps.py).

The dependency analysis follows both direct `context.run(...)` calls and `CompositeStep(skill_name=...)` edges, then computes transitive skill dependencies; [tip-phase-closure.ts](../packages/host/stm-skills/src/l0/tip-phase-closure.ts) applies the dependency inventory on the TypeScript side. The fixture explicitly records unresolved cases in `closure_limits`. Start with `AutoTilt → TiltProbeCircle` in the test, then inspect `closure_limits.dynamic_run_sites` to see where static resolution stops. This is bounded static analysis, not proof that every runtime dependency is known.

### 5. Keeping upstream changes at a defined boundary

Read the [compat exports](../packages/host/compat/src/index.ts), [boundary.test.ts](../packages/host/compat/src/boundary.test.ts) and [contract tests](../packages/host/compat/contract), together with [pnpm-workspace.yaml](../pnpm-workspace.yaml).

Production imports of dsh APIs go through `dsh-spm-compat`; contract tests can import the real upstream packages directly. Version pinning and boundary checks make the integration surface inspectable. Those tests exercise package contracts, while packaged installation, model visibility and client integration require their own runtime evidence in [MINIMUM-RUN-TODO.md](MINIMUM-RUN-TODO.md).

## Reading the measurements

The table below describes the repository records inspected on **2026-09-20**. Historical executions are labeled as such; they do not certify a later working tree or commit.

| Record | What it establishes | What it does not establish |
|---|---|---|
| [progress.json](../spec/progress.json): 442 / 515 skills; 112 / 165 modules | The generated `done` classification requires a registered implementation, generated spec, reference model schema and at least one reference trace; a complete module has all its skills classified `done` | Passing every test, full migration acceptance, or end-to-end readiness. See the [counter](../scripts/build-progress.ts) and its [tests](../packages/host/stm-skills/src/progress.test.ts) |
| [Migration scope](MIGRATION-TODO.md): 60 remaining in scope, 13 excluded | The declared reachable targets are 502 skills and 160 modules; exclusions are explicit | A completion percentage against the original inventory is not a release-readiness percentage |
| [Recorded CI run](RELEASE-TODO.md) for `22f655b`: 7,445 tests across 118 files | Windows recorded 2 failures; Ubuntu recorded 27, with time/path-dependent golden output among the causes | Current CI status or a clean result for uncommitted changes |
| [Mutation catalogue](../tools/mutate/mutations.ts): 879 entries | The size of the registered catalogue at this snapshot | That every pattern still matches or that every mutation is detected; the release checklist records an unmatched pattern |
| Historical [119-entry](handoff/drill-7a-merged-119-2026-09-20.log) and [167-entry](handoff/drill-7b-merged-167-2026-09-20.log) drills | Those logs report 119/119 and 167/167 `red` for the selected batches | A current full-catalogue run |
| [Deviation register](../spec/deviations.md) | Reasons and reconsideration criteria for recorded behavior differences | An exhaustive proof that no unrecorded differences exist |

Golden fixtures include declarations, executed reference traces, numerical results and source-analysis outputs; their source categories are indexed in [spec/golden/README.md](../spec/golden/README.md). Some descriptions derive from reference-system observations. Deidentification does not make an observation synthetic, and public text normalization limits claims of byte identity with private original exports.

## Reproduce what is available locally

After inspecting the repository and with the Node/pnpm versions declared in [package.json](../package.json), run from the root:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm test --project unit --project contract
```

These checks do not require MAST, a model API key or the external simulator. Installation downloads dependencies; the build creates local outputs. Compare results with the recorded CI limitations rather than assuming the historical test count or result is unchanged.

For a smaller starting point, the following command checks the import boundary, model schemas and dependency inventory:

```text
pnpm test --project unit packages/host/compat/src/boundary.test.ts packages/host/kernel/src/tool-schema-real.test.ts packages/host/stm-skills/src/l0/tip-phase-deps.test.ts
```

After a successful build, these commands check generated-file synchronization without rewriting those files:

```text
node scripts/gen-skill-specs.ts --check
node scripts/build-progress.ts --check
```

The simulator tests require `STMSIM_PYTHON` and `STMSIM_ROOT` and use local ports. They are distinct from a real model calling the packaged plugin. Running `pnpm test` without project selection includes that integration project and fails explicitly if its prerequisites are absent.

## Where the remaining work is recorded

- [MINIMUM-RUN-TODO.md](MINIMUM-RUN-TODO.md): development-mode loading has been observed; packaged installation, real model calls and end-to-end execution remain unverified, with a client integration blocker recorded.
- [MIGRATION-TODO.md](MIGRATION-TODO.md): remaining capabilities, dependency blockers and intentional exclusions.
- [RELEASE-TODO.md](RELEASE-TODO.md), [PUBLIC-CODE-REVIEW.md](PUBLIC-CODE-REVIEW.md) and [SOURCES.md](SOURCES.md): recorded CI results, public-content review, historical publication concerns and provenance.

Real-instrument validation is deferred to Phase 8. Code inspection, fixture tests, simulator behavior, distribution checks and hardware runs provide different kinds of evidence and should be reported with their actual scope.
