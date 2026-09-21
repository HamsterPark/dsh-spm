# Reviewing dsh-spm

Start with the [README](../README.md) for capabilities and setup. This guide follows the implementation from an installed model tool to a simulator result, then examines how the larger Python-to-TypeScript migration is checked. The [development guide](DEVELOPMENT.md) contains maintenance procedures.

## Start with a complete execution path

Read [minimal.ts](../packages/bundle/dsh-spm/src/minimal.ts), [native-skills.ts](../packages/bundle/dsh-spm/src/native-skills.ts), the [shutdown regression test](../packages/bundle/dsh-spm/src/minimal-lifecycle.test.ts) and the [Nanonis acceptance record](handoff/native-nanonis-20260921.json).

These show a concrete sequence: dsh dispatches a tool, the skill kernel checks execution, the instrument connection performs the operation, and the result is persisted with the tool call ID. The native simulator branch serializes each operation with its readback so concurrent writes cannot consume one another's results. On unload, in-flight calls finish recording before SQLite and connections close. The regression test deliberately delays a call while Cordis disposes the plugin.

Two runtime modes have separate installation and model evidence:

| Mode | Artifact SHA256 prefix | Recorded behavior | Evidence |
|---|---|---|---|
| Managed STM-Bench | `8c510e265984` | Two independent Windows homes; model calls to hello and GetBias; independent bias comparison, disconnect failure and records reopened after exit | [Implementation handoff](handoff/minimum-usable-20260921.md), [installation / dispatcher checks](handoff/minimal-acceptance-20260921.json), [model-session associations](handoff/minimal-model-20260921.json) |
| Existing Nanonis Mimea simulator | `b5a7ab1a088e` | Installed package; 7 model requests and 9 calls covering the seven STM tools; bias changes, scan start/stop and persistent records | [Implementation handoff](handoff/native-nanonis-20260921.md), [structured results](handoff/native-nanonis-20260921.json) |

The reports retain full hashes. Both builds use the filename `dsh-spm-0.0.1.tgz`; the hash identifies which artifact a result belongs to. The two-home result applies to the managed build. In the native run, the directory contained seven STM tools plus hello; the nine observed calls used the STM tools. Independent TCP comparison covers bias and scan state, while current and Z were checked for finite readings.

The reports preserve summarized results and call associations; original session and database paths refer to the validation machine. Reproduction requires the runtime's external simulator and, for model acceptance, credentials. See [STM-Bench setup](MINIMUM-USABLE.md) or [Nanonis setup](NANONIS-SIMULATOR.md). The recorded scope is Windows, the listed versions and the selected tools; complete image acquisition, the dedicated client, other platforms and real hardware require separate validation.

## Follow the design decisions

### Simulator identity and lifetime

[NativeSimulatorConnection](../packages/bundle/dsh-spm/src/native-simulator.ts) checks the Windows process identity, Mimea/Sim-Engine relationship, listeners and backend connections; its [tests](../packages/bundle/dsh-spm/src/native-simulator.test.ts) exercise rejection and reconnection cases. The managed provider has its own [process ownership checks](../packages/instrument/instrument-stmsim/src/ownership.ts).

The lifetime rules differ: the managed path owns the process it starts; the native path disconnects from an application the user already opened. Native mode has no automatic background polling or watchdog retract. Its scan tool requires feedback to be enabled and verifies running/stopped state. Review [native-skills.test.ts](../packages/bundle/dsh-spm/src/native-skills.test.ts) and [native-runtime.test.ts](../packages/bundle/dsh-spm/src/native-runtime.test.ts) for readback, ordering and cancellation behavior.

### Model contracts and execution checks

[tool-schema-real.test.ts](../packages/host/kernel/src/tool-schema-real.test.ts) compares model schemas with reference output. [tool.ts](../packages/host/stm-skills/src/tool.ts) adapts those contracts to dsh; [skill-kernel.ts](../packages/host/kernel/src/skill-kernel.ts) enforces execution checks.

A concrete tradeoff is `D-SCHEMA-2` in the [deviation register](../spec/deviations.md): the pinned dsh parameter DSL cannot express the reference schema's numerical bounds. The adapter communicates them in descriptions while execution checks enforce them. [tool.test.ts](../packages/host/stm-skills/src/tool.test.ts) exercises the adaptation against the real package; [skill-kernel.test.ts](../packages/host/kernel/src/skill-kernel.test.ts) covers the gates. `D-MINIMAL-1` and `D-NATIVE-1` describe the runtime's measured-value display and bounded simulator behavior.

### Numerical compatibility

Read [numerics.test.ts](../packages/host/numerics/src/numerics.test.ts), an operation's implementation in [numerics/src](../packages/host/numerics/src), [numerics.json](../spec/golden/numerics.json) and [export_numerics.py](../tools/spec-export/export_numerics.py). Tests distinguish byte/integer equality, operation-specific floating-point tolerances and acceptance regions for algorithms that do not promise identical output.

`D-NUM-25` records why a NumPy/BLAS correlation result needs a tolerance. The rationale belongs with the operation, so a test cannot silently choose a convenient error margin. This numerical fixture can be regenerated with public NumPy, SciPy and scikit-image dependencies. MAST-specific fixtures require the private reference environment; the saved fixtures can be tested without it.

### Verifying the tests themselves

Select a rule in [mutations.ts](../tools/mutate/mutations.ts), inspect its declared test scope, then read [run.ts](../tools/mutate/run.ts). The CLI first checks that the selected scopes pass without mutations. A valid detection requires a unique replacement, successful compilation, actual test execution and a failure in the declared scope.

The runner distinguishes detected, surviving, inconclusive and insufficient-scope results. [green-8.md](handoff/green-8.md) explains why the baseline check was added: unrelated failures had masked surviving mutations. Historical [119-entry](handoff/drill-7a-merged-119-2026-09-20.log) and [167-entry](handoff/drill-7b-merged-167-2026-09-20.log) runs describe selected batches, not a current full-catalogue result.

Use the [development procedure](DEVELOPMENT.md) when executing a drill: it edits source temporarily and requires exclusive use of the working tree. The Vitest mutation meta-tests invoke `runOne` directly and omit the CLI's batch baseline check.

### Dependency closure with an explicit analysis boundary

Read [tip-phase-closure.ts](../packages/host/stm-skills/src/l0/tip-phase-closure.ts), its [dependency tests](../packages/host/stm-skills/src/l0/tip-phase-deps.test.ts), the [fixture](../spec/golden/tip_phase_deps.json) and [exporter](../tools/spec-export/export_tip_phase_deps.py).

The analysis follows both `context.run(...)` and `CompositeStep(skill_name=...)`, then computes transitive skill dependencies. `AutoTilt → TiltProbeCircle` is one test example. Unresolved dispatch is retained in `closure_limits`, including `dynamic_run_sites`, so an unknown edge remains distinguishable from a leaf with no dependencies. This makes the limits of static analysis part of the reviewable output.

### Upstream adaptation and independent installation

Production dsh imports go through [compat](../packages/host/compat/src/index.ts); the [boundary test](../packages/host/compat/src/boundary.test.ts) and [real-package contracts](../packages/host/compat/contract/pin.test.ts) check that boundary and version pinning. Contract tests intentionally have direct access to upstream packages.

Follow [build-minimal.ts](../scripts/build-minimal.ts) into [install-minimal.ts](../scripts/install-minimal.ts) to inspect distribution: internal workspace code is bundled, external dependencies are pinned, and installation creates a new home outside the checkout and checks module identity. The [distribution test](../packages/bundle/dsh-spm/contract/minimal-distribution.test.ts) provides local checks; the artifact-specific reports above supply the installation evidence.

## Interpret the measurements by snapshot

Migration counts live in [progress.json](../spec/progress.json), with their definition in [build-progress.ts](../scripts/build-progress.ts). `done` requires implementation registration, a generated spec, a reference model schema and at least one reference trace. It does not read integration or mutation results. The [migration checklist](MIGRATION-TODO.md) separates remaining scope from intentional exclusions.

Validation records describe different stages:

| Record | Result and scope |
|---|---|
| [2026-09-21 final candidate validation and publication boundary](handoff/publication-ready-20260921.md) | Code candidate `60313d1`: local Windows / Node 24.14.0 build and unit/contract checks passed, with 7,518 tests in 128 files. The record tracks final candidate checks and publication boundaries separately from the earlier artifact-specific simulator acceptance. |
| [2026-09-20 CI, commit `22f655b`](RELEASE-TODO.md) | Windows recorded 2 failures; Ubuntu 27, including time/path-dependent golden output. This is the earlier committed snapshot. |
| [2026-09-21 managed-runtime handoff](handoff/minimum-usable-20260921.md) | Windows unit/contract: 7,454 tests in 122 files; selected STM-Bench integration: 11 tests in 2 files. A later session-decoder regression is recorded separately. |
| [2026-09-21 native-runtime handoff](handoff/native-nanonis-20260921.md) | Windows unit/contract: 7,512 tests in 127 files before the final cancellation patch. The final bundle check passed 66 tests in 9 files; a separate TCP-probe check passed 3 tests in 1 file. |

Do not add overlapping runs together or relabel a focused final check as a full-suite run. Runtime reports bind uncommitted work to artifact hashes and build provenance; the base commit alone does not identify that code. Check the current checkout's tracking and commit state when assessing what a repository publication contains.

## Run a local starting check

Use the Node/pnpm versions in [package.json](../package.json), install dependencies and build as described in the README. This smaller test selection covers the import boundary, reference schemas, shutdown ordering and native skill behavior without connecting an external simulator or calling a model:

```text
pnpm test --project unit packages/host/compat/src/boundary.test.ts packages/host/kernel/src/tool-schema-real.test.ts packages/bundle/dsh-spm/src/minimal-lifecycle.test.ts packages/bundle/dsh-spm/src/native-skills.test.ts
```

After a successful build, check generated-file synchronization without rewriting those files:

```text
node scripts/gen-skill-specs.ts --check
node scripts/build-progress.ts --check
```

For the full unit/contract suite, use `pnpm test --project unit --project contract`. Plain `pnpm test` also includes STM-Bench integration and requires its external prerequisites. Installation and simulator acceptance procedures are in the two runtime guides, with their write operations stated explicitly.

## Sources and remaining work

[spec/golden/README.md](../spec/golden/README.md) indexes reference declarations, execution traces, numerical results and source-analysis outputs. [SOURCES.md](SOURCES.md) and [PUBLIC-CODE-REVIEW.md](PUBLIC-CODE-REVIEW.md) describe provenance and public-text normalization; deidentifying a reference-system observation does not make it a synthetic test.

Use [MIGRATION-TODO.md](MIGRATION-TODO.md) for remaining domain capabilities and [RELEASE-TODO.md](RELEASE-TODO.md) for publication checks. [MINIMUM-RUN-TODO.md](MINIMUM-RUN-TODO.md) preserves the earlier investigation; current runtime setup and acceptance are documented in [MINIMUM-USABLE.md](MINIMUM-USABLE.md) and [NANONIS-SIMULATOR.md](NANONIS-SIMULATOR.md).
