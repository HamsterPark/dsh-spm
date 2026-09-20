# dsh-spm

`dsh-spm` is a TypeScript plugin project for exposing scanning tunneling microscopy (STM/SPM) instrument operations as inspectable, callable, and testable DeepSeek Harness skills.

The work migrates the domain layer of an existing Python/LangGraph system while leaving session management, model orchestration, approvals, background work, and the application shell to dsh. The original system has operated real STM instruments; that experience is background for the migration, not evidence that this plugin has completed hardware or distribution validation.

For a code review, start with the [review guide](docs/REVIEW-GUIDE.md): it follows five engineering decisions through their implementations, tests and limits. [AGENTS.md](AGENTS.md) provides repository instructions for coding agents.

## Current status

| Area | Current evidence | Boundary |
|---|---|---|
| Skill migration | 442 of the original 515 skill contracts are marked done in `spec/progress.json` | 60 remain in scope; 13 are explicitly excluded, so the current target is 502 |
| Module migration | 112 of 165 modules are complete | The current reachable target is 160 because five modules contain excluded skills |
| Unit and contract suite | 7,445 tests across 118 files in the recorded run | Local handoff records report a clean run; the recorded CI run for `22f655b` failed on environment-dependent golden output |
| Mutation catalogue | 879 registered mutations | Recent handoff batches report 119/119 and 167/167 red; this is not a current full-catalogue run |
| Behavioral deviations | 228 entries in `spec/deviations.md` | Each entry records the observed difference and the evidence required to change it |
| dsh integration | Development-mode loading, `apply`, dependency injection, and host tool registration have been observed | Tarball/npm installation, a real model call, and end-to-end execution remain unverified; the client layer has a recorded integration blocker |
| Hardware | No real-instrument run is part of this repository's validation | Hardware validation is intentionally deferred to Phase 8 |

The generated progress file is the source for migration counts. Its `done` status requires a registered implementation, generated specification, reference model schema and at least one reference trace; it does not certify the complete migration acceptance criteria. Test counts and mutation results are dated measurements rather than permanent project properties; see the [review guide](docs/REVIEW-GUIDE.md) and linked records for their exact scope.

## Why STM skills need explicit evidence

STM control is partially observable and stateful: an operation can change the surface, the probe, or the next operation's safety envelope. This repository therefore treats model-visible responses, refusal paths, numerical behavior, and workflow dependencies as contracts.

The main verification methods are:

- **Golden fixtures:** exporters capture reference declarations, source-analysis results and executed behavior under controlled inputs in `spec/golden/`; descriptive provenance can also include deidentified reference-system observations. Public-text normalization is documented in [the content review](docs/PUBLIC-CODE-REVIEW.md).
- **Contract tests:** parameter schemas, returned fields, and model-visible messages are checked alongside numerical behavior.
- **Mutation drills:** a guard is deliberately removed to confirm that its declared test scope fails.
- **Deviation records:** intentional differences from the reference are documented in `spec/deviations.md`.
- **Dependency closure:** composite skill dependencies include both direct calls and nested workflow steps, with limits of static analysis stated explicitly.

## Repository map

| Path | Purpose |
|---|---|
| `packages/host/` | Safety logic, numerical routines, image analysis, records, and skills |
| `packages/instrument/` | Protocol, connection, state cache, watchdog, and simulator provider |
| `packages/client/` | Client integration under development |
| `packages/bundle/` | dsh plugin bundle entry point |
| `spec/golden/` | Reference declarations, execution traces, numerical and source-analysis results, and provenance |
| `spec/nanonis/` | Machine-readable Nanonis command metadata and provenance |
| `tools/spec-export/` | Read-only reference exporters |
| `tools/mutate/` | Mutation catalogue and runner |

## Build and test

Use Node.js 22.19 or 24 and the repository's pinned pnpm version:

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm test --project unit --project contract
```

The integration project additionally requires an external STM simulator through `STMSIM_PYTHON` and `STMSIM_ROOT`. It is not part of the command above. A green unit/contract run does not establish simulator, packaged-installation, model, or hardware behavior.

The GitHub Actions run recorded on 2026-09-20 for commit `22f655b` failed: Windows reported 2 failures and Ubuntu reported 27, primarily because golden responses contain local-time and path-dependent text. See [the recorded CI run](https://github.com/HamsterPark/dsh-spm/actions/runs/35502853052) and [the release checklist](docs/RELEASE-TODO.md). This is a historical result, not a live CI-status indicator.

## Project documents

- [Review guide](docs/REVIEW-GUIDE.md) connects representative implementations to their tests and evidence boundaries.
- [AGENTS.md](AGENTS.md) explains repository rules, reading paths and evidence standards.
- [Development guide](docs/DEVELOPMENT.md) covers migration acceptance, generation, mutation drills and collaboration.
- [Release checklist](docs/RELEASE-TODO.md) records public-release checks and unresolved blockers.
- [Minimum-run checklist](docs/MINIMUM-RUN-TODO.md) separates development loading from packaged installation and end-to-end use.
- [Migration checklist](docs/MIGRATION-TODO.md) lists the remaining 60 in-scope skills and 13 exclusions.
- [Sources and third-party notices](docs/SOURCES.md) records provenance and licensing for imported reference material.

The repository is licensed under the [MIT License](LICENSE). Third-party material retains its own notices as described in [docs/SOURCES.md](docs/SOURCES.md).
