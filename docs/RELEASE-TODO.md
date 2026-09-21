# Public release checklist

This checklist records the publication review begun on **2026-09-20**, based on commit `22f655b`, and the **2026-09-21 readiness check** below. Each observation belongs to its dated snapshot. Publication preparation covers content, provenance and the exact material to be shared.

For later installation and model results, see the [STM-Bench runtime](MINIMUM-USABLE.md), [Nanonis simulator runtime](NANONIS-SIMULATOR.md) and [review guide](REVIEW-GUIDE.md). Those runtime checks and the content review cover different snapshots.

## Outstanding publication steps

The selected route is to **rename the existing repository and keep it private, then create a new independent `HamsterPark/dsh-spm`**. Preserve the cleaned development history. Removal of retained objects from the private archive is a separate maintenance option; publication requires verifying their isolation from the new repository.

- [ ] Reconcile subsequent runtime and documentation changes with the separately prepared publication candidate; retain its later remote-audit records and selected release route. Review the added content and record the exact release commit and tree. Exclude local caches and private audit material.
- [ ] Validate that final candidate with a build and unit/contract tests. Bind results to its commit and environment; document any remaining failures and distinguish them from historical CI. Installation/model evidence remains tied to the recorded artifact hashes.
- [ ] Recheck the existing repository's identity and the availability of `dsh-spm-private-archive`; rename the existing repository while keeping it private. Before reusing its old name, point original-history clones and their shared worktree remote configuration to the private archive, or remove their push target.
- [ ] Create a new private, non-fork `HamsterPark/dsh-spm` with a different immutable repository ID. Use an empty repository, without importing the archive. Bind the publication copy to this new identity and push only reviewed `master`; do not mirror refs or push original history.
- [ ] Fresh-clone the new repository and compare its HEAD, tree, reachable commit set and object store with the reviewed candidate. Verify that all 207 original commit IDs and the confirmed old file are inaccessible through the new repository's routes. Permission/rate-limit errors and network failures are inconclusive.
- [ ] Add the new repository's description and topics. Update historical CI links to the renamed private archive and label their access/snapshot limits; record new-repository CI separately.
- [ ] Under the owner's publication instruction, make only the verified new repository public. Recheck its identity, anonymous entry points and old-content isolation; confirm that the archive remains private.

The recorded local candidate and its verification are described in [HISTORY-CLEANUP.md](HISTORY-CLEANUP.md). A prepared copy does not automatically include development performed afterward.

## Readiness check on 2026-09-21

- The publication checkout is clean at `9aa08bd`, with 210 reachable commits: 207 cleaned development commits and three later preparation/documentation commits. It does not yet include the subsequent simulator runtimes, acceptance records or reader-documentation revision.
- A read-only GitHub check found the existing `HamsterPark/dsh-spm` still private, with `master` at `5afb99c`. It has not yet been renamed or replaced by the planned new repository. The proposed archive name returned 404 to the authenticated lookup; this does not reserve that name.
- The latest run returned by GitHub was [run 35520355401](https://github.com/HamsterPark/dsh-spm/actions/runs/35520355401), for `5afb99c`. All four Windows/Ubuntu × Node 22.19/24 jobs failed at the unit/contract test step. This is a later snapshot than the initial matrix detailed below, and does not test the new local runtime work.
- The README now identifies the plugin as **experimental and under active development**. APIs, configuration and supported tools may change; real-instrument operation remains unvalidated. Publication of the development repository does not assert a stable release or hardware readiness.

The current work is ready for final candidate assembly and review. The outstanding steps above are still needed before public visibility; the remaining skill migration and hardware work are separate development milestones.

## Scope inspected on 2026-09-20

- Local and remote `master` both resolved to `22f655b6ca27e54d2fac3fb337044f9636725406`.
- The remote exposed one branch (`master`) and no tags. The repository was private.
- The review covered 626 tracked files, 207 reachable commits, deleted historical paths, commit subjects and author identities, current GitHub Actions runs, and current repository metadata.
- GitHub showed no description or topics. Issues were enabled and Discussions were disabled.
- The remote README, Actions logs, and repository metadata were accessible. Release assets and package registries were not part of the current repository publication boundary.

## Content review

The following checks were performed locally without uploading repository contents to a scanning service:

- strong credential shapes: private-key headers, GitHub tokens, AWS access keys, OpenAI key shapes, and quoted secret assignments;
- private network addresses, local developer paths, private planning references, and commit author email categories;
- tracked and historical large/binary filenames, model-weight extensions, instrument data extensions, and the largest current blobs;
- source/provenance records for golden fixtures, the Nanonis command table, MAST-derived patch entries, paper-derived algorithms, and root/package license metadata.

No private network address, private-key material, quoted credential assignment, model weight, or tracked instrument-data file was found in the reviewed reachable history. Four OpenAI-key-shaped strings are the same 24-character literal reproduced in a handoff record, mutation fixture, and mutation log. The value is too short for the key shape being tested and does not appear in a credential assignment, so it is classified as a test literal. Findings are reported by location and category without reproducing their values.

In the reviewed Markdown snapshot, the local developer username and private planning directory inventory were removed. Reference and simulator paths use `MAST_ROOT`, `STMSIM_ROOT`, or `REPOSITORY_ROOT` placeholders where applicable.

The original private history contains previous Markdown, source comments, local paths, informal internal wording and an ordinary Gmail commit-author address. The owner authorized cleaning historical versions while retaining development history and accepting changed commit hashes. This work used a separate local copy with a verified private backup; the original repository and its linked worktrees remain intact. The subsequent private-remote replacement and retained-content audit are recorded in [HISTORY-CLEANUP.md](HISTORY-CLEANUP.md); the selected publication target is a new independent repository.

The later full reading by twenty Luna reviewers covered a 628-file working-tree snapshot, including all 463 source/test/generated-source files. It found a specific sample identity, copied laboratory narratives and an operator-specific instrument configuration that the targeted scan had missed. Those findings supersede the earlier negative result for sample identities. Coverage, cleanup status and limits are recorded in [PUBLIC-CODE-REVIEW.md](PUBLIC-CODE-REVIEW.md).

The final current-tree pass replaced confirmed developer-machine paths in all exporter entry points and the remaining frozen provenance fields. External source roots are explicitly configured through `MAST_ROOT` and `STMSIM_ROOT`; generated provenance uses stable placeholders. Generic path-parser fixtures remain intact. Reference-system observations retain their true source category when deidentified.

## Source and license review

- The root license is MIT with `Copyright (c) 2026 HamsterPark`; all package manifests declare MIT. Child manifests inherit the repository authorship and do not repeat an `author` field.
- `spec/nanonis/nanonis_commands.json` records that it was generated from `nanonis_spm` 1.0.9 plus twelve MAST patch entries.
- The official `nanonis-spm` 1.0.9 package includes an MIT license notice for Samuel O'Neill. PyPI's JSON metadata leaves the license fields empty, so the bundled wheel notice is preserved in [SOURCES.md](SOURCES.md).
- Paper-derived code uses algorithm names and normal scientific references. No article text, figure, or dataset was identified in the Markdown/source review.

The user has authorized migration and public preparation of the MAST-derived material. No concrete third-party conflict was found in the bounded provenance review; its limits are recorded in [SOURCES.md](SOURCES.md).

## Validation

The GitHub Actions run inspected for `22f655b` failed in all four Node/OS jobs: [run 35502853052](https://github.com/HamsterPark/dsh-spm/actions/runs/35502853052).

| Runner | Result |
|---|---|
| Windows, Node 22.19 | 2 failed, 7,443 passed |
| Windows, Node 24 | 2 failed, 7,443 passed |
| Ubuntu, Node 22.19 | 27 failed, 7,418 passed |
| Ubuntu, Node 24 | 27 failed, 7,418 passed |

Both Windows failures were in the calibration/trace goldens and depended on local-time rendering. Ubuntu additionally exposed absolute-path normalization and platform-shaped trace differences. The initial documentation pass used that existing matrix result. Later local Windows results are linked in the review guide; they do not rerun this cross-platform matrix.

The separate comment-cleanup pass was checked without rerunning the full suite: 16 TypeScript files produced the same compiler output and directives as `HEAD`; three YAML/gitignore files retained identical non-comment lines; four Python exporters had identical ASTs after docstrings were removed; and the mutation catalogue retained all 879 entries and all fields except one diagnostic `why` string. The catalogue self-test passed (`1 passed`, `879 skipped`). No exporter or mutation drill was run, and this does not establish that 879 mutations are red.

An additional read-only check found that 878 of 879 mutation replacement patterns match exactly once. `forge-required-covers-the-terrace-leveling` has zero matches in `packages/host/stm-skills/src/l0/tip-selfcheck.ts`, both in `22f655b` and in the cleaned working tree. All 45 mutations targeting edited files retain their original match counts. The unmatched pattern is a pre-existing maintenance issue; this preparation did not change mutation rules or run the drill.

After the twenty-reviewer full reading and coordinated content cleanup, the build passed and **698 focused unit/contract tests passed in nine files**. Static comparison preserved numerical payloads and mutation rules while allowing the explicitly reviewed descriptive text and anonymous identifiers. These results validate the cleanup's affected contracts; they do not replace the full CI result above. The public profile identifier is now `reference-surface-v1`, requiring existing external configurations that used the old identifier to update it. Details and export caveats are in [PUBLIC-CODE-REVIEW.md](PUBLIC-CODE-REVIEW.md).

The final path pass added **117 passing z-trace tests and 25 passing claim-audit tests**, checked the external-root helper without importing either private source tree, and verified synchronization of all 671 generated Nanonis methods. These are focused cleanup checks, not a new full CI matrix.

## Recorded preparation checks

- [x] Finish and verify the coordinated content cleanup described in [PUBLIC-CODE-REVIEW.md](PUBLIC-CODE-REVIEW.md), including copied descriptions and golden metadata.
- [x] Remove confirmed developer-machine paths from exporter entry points and frozen provenance.
- [x] Choose history-preserving cleanup with a complete local private backup.
- [x] Verify the isolated rewritten history and assemble the reviewed publication copy; results are recorded in [HISTORY-CLEANUP.md](HISTORY-CLEANUP.md).
- [x] Record the cross-platform CI failures as an accepted runtime limitation. The public README does not claim that current CI is green.
- [x] Review the final combined diff, including the separate source/configuration comment cleanup authorized for this release-preparation pass.

## Repository presentation

Proposed description:

> Experimental TypeScript plugin for STM/SPM control in DeepSeek Harness, with simulator workflows, persistent tool records, and reference-driven tests. In active development.

Proposed topics: `stm`, `scanning-tunneling-microscopy`, `llm-agent`, `scientific-instruments`, `typescript`.

Issues were enabled in the recorded inspection. Their current setting should be checked when preparing the remote update.

## Scope of the recorded preparation

The following were outside that content-preparation pass:

- npm publication;
- completing the remaining 60 in-scope skills;
- packaged plugin installation and model invocation, which were verified separately in the later runtime work linked above;
- simulator CI setup or hardware use;
- remote pushes, visibility changes or messages to third parties without the corresponding instruction. The recorded local history cleanup and publication-copy commit were part of this preparation.
