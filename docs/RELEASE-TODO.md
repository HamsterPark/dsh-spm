# Public release checklist

> Updated 2026-09-20. The initial review used `22f655b`; the authorized remote replacement uses cleanup commit `8d4a8a6`. Public release does not require completing every skill or proving packaged installation, but it does require a reviewed publication boundary, adequate source rights, and an honest account of validation.

## Initial inspection

- The initial local and remote `master` resolved to `22f655b6ca27e54d2fac3fb337044f9636725406`. The remote was subsequently replaced from the reviewed publication checkout; see [HISTORY-CLEANUP.md](HISTORY-CLEANUP.md).
- The remote exposes one branch (`master`) and no tags. The repository is private.
- The review covered 626 tracked files, 207 reachable commits, deleted historical paths, commit subjects and author identities, current GitHub Actions runs, and current repository metadata.
- GitHub shows no description or topics. Issues are enabled and Discussions are disabled.
- The remote README, Actions logs, and repository metadata were accessible. Release assets and package registries were not part of the current repository publication boundary.

## Content review

The following checks were performed locally without uploading repository contents to a scanning service:

- strong credential shapes: private-key headers, GitHub tokens, AWS access keys, OpenAI key shapes, and quoted secret assignments;
- private network addresses, local developer paths, private planning references, and commit author email categories;
- tracked and historical large/binary filenames, model-weight extensions, instrument data extensions, and the largest current blobs;
- source/provenance records for golden fixtures, the Nanonis command table, MAST-derived patch entries, paper-derived algorithms, and root/package license metadata.

No private network address, private-key material, quoted credential assignment, model weight, or tracked instrument-data file was found in the reviewed reachable history. Four OpenAI-key-shaped strings are the same 24-character literal reproduced in a handoff record, mutation fixture, and mutation log. The value is too short for the key shape being tested and does not appear in a credential assignment, so it is classified as a test literal. Findings are reported by location and category without reproducing their values.

Current Markdown no longer contains the local developer username. Reference and simulator paths now use `MAST_ROOT`, `STMSIM_ROOT`, or `REPOSITORY_ROOT`. Public entry documents no longer enumerate private planning directories.

The original private history contains previous Markdown, source comments, local paths, informal internal wording and an ordinary Gmail commit-author address. The owner has authorized cleaning historical versions while retaining development history and accepting changed commit hashes. This work is performed in a separate local copy with a verified private backup; the original repository and its linked worktrees remain intact. Remote history replacement and a visibility change are separate publication actions.

The later full reading by twenty Luna reviewers covered a 628-file working-tree snapshot, including all 463 source/test/generated-source files. It found a specific sample identity, copied laboratory narratives and an operator-specific instrument configuration that the targeted scan had missed. Those findings supersede the earlier negative result for sample identities. Coverage, cleanup status and limits are recorded in [PUBLIC-CODE-REVIEW.md](PUBLIC-CODE-REVIEW.md).

The final current-tree pass replaced confirmed developer-machine paths in all exporter entry points and the remaining frozen provenance fields. External source roots are explicitly configured through `MAST_ROOT` and `STMSIM_ROOT`; generated provenance uses stable placeholders. Generic path-parser fixtures remain intact. Reference-system observations retain their true source category when deidentified.

## Source and license review

- The root license is MIT with `Copyright (c) 2026 HamsterPark`; all package manifests declare MIT. Child manifests inherit the repository authorship and do not repeat an `author` field.
- `spec/nanonis/nanonis_commands.json` records that it was generated from `nanonis_spm` 1.0.9 plus twelve MAST patch entries.
- The official `nanonis-spm` 1.0.9 package includes an MIT license notice for Samuel O'Neill. PyPI's JSON metadata leaves the license fields empty, so the bundled wheel notice is preserved in [SOURCES.md](SOURCES.md).
- Paper-derived code uses algorithm names and normal scientific references. No article text, figure, or dataset was identified in the Markdown/source review.

The user has authorized migration and public preparation of the MAST-derived material. No concrete third-party conflict was found in the bounded provenance review; its limits are recorded in [SOURCES.md](SOURCES.md).

## Validation

The reviewed historical GitHub Actions run for `22f655b` failed in all four Node/OS jobs: [run 35502853052](https://github.com/HamsterPark/dsh-spm/actions/runs/35502853052). This records the original validation result, not a claim about the latest run after history replacement.

| Runner | Result |
|---|---|
| Windows, Node 22.19 | 2 failed, 7,443 passed |
| Windows, Node 24 | 2 failed, 7,443 passed |
| Ubuntu, Node 22.19 | 27 failed, 7,418 passed |
| Ubuntu, Node 24 | 27 failed, 7,418 passed |

Both Windows failures are in the calibration/trace goldens and depend on local-time rendering. Ubuntu additionally exposes absolute-path normalization and platform-shaped trace differences. These results supersede any unqualified statement that current CI is green. Because the same code commit already ran the full matrix, the initial documentation pass did not repeat the suite locally.

The separate comment-cleanup pass was checked without rerunning the full suite: 16 TypeScript files produced the same compiler output and directives as `HEAD`; three YAML/gitignore files retained identical non-comment lines; four Python exporters had identical ASTs after docstrings were removed; and the mutation catalogue retained all 879 entries and all fields except one diagnostic `why` string. The catalogue self-test passed (`1 passed`, `879 skipped`). No exporter or mutation drill was run, and this does not establish that 879 mutations are red.

An additional read-only check found that 878 of 879 mutation replacement patterns match exactly once. `forge-required-covers-the-terrace-leveling` has zero matches in `packages/host/stm-skills/src/l0/tip-selfcheck.ts`, both in `22f655b` and in the cleaned working tree. All 45 mutations targeting edited files retain their original match counts. The unmatched pattern is a pre-existing maintenance issue; this preparation did not change mutation rules or run the drill.

After the twenty-reviewer full reading and coordinated content cleanup, the build passed and **698 focused unit/contract tests passed in nine files**. Static comparison preserved numerical payloads and mutation rules while allowing the explicitly reviewed descriptive text and anonymous identifiers. These results validate the cleanup's affected contracts; they do not replace the full CI result above. The public profile identifier is now `reference-surface-v1`, requiring existing external configurations that used the old identifier to update it. Details and export caveats are in [PUBLIC-CODE-REVIEW.md](PUBLIC-CODE-REVIEW.md).

The final path pass added **117 passing z-trace tests and 25 passing claim-audit tests**, checked the external-root helper without importing either private source tree, and verified synchronization of all 671 generated Nanonis methods. These are focused cleanup checks, not a new full CI matrix.

## Release blockers

- [x] Finish and verify the coordinated content cleanup described in [PUBLIC-CODE-REVIEW.md](PUBLIC-CODE-REVIEW.md), including copied descriptions and golden metadata.
- [x] Remove confirmed developer-machine paths from exporter entry points and frozen provenance.
- [x] Choose history-preserving cleanup with a complete local private backup.
- [x] Verify the isolated rewritten history and assemble the reviewed publication copy; results are recorded in [HISTORY-CLEANUP.md](HISTORY-CLEANUP.md).
- [x] Replace the sole remote branch from the reviewed publication copy using an explicit expected-old-commit lease, keep the repository private, and verify a fresh clone against the reviewed history and files.
- [x] Inventory the additional remote surfaces, scan all 62 available workflow logs for confirmed identifying strings, and remove the three uninspectable old dependency caches. Scope and results are recorded in [HISTORY-CLEANUP.md](HISTORY-CLEANUP.md).
- [ ] Resolve retained server-side old commits before changing visibility. The audit confirmed that original commit IDs remain readable through GitHub's authenticated API; a clean fresh clone does not establish that these retained objects are gone.
- [x] Record the cross-platform CI failures as an accepted runtime limitation. The public README does not claim that current CI is green.
- [x] Review the final combined diff, including the separate source/configuration comment cleanup authorized for this release-preparation pass.
- [ ] Add the repository description and topics after the reviewed commit is pushed.
- [ ] Switch visibility only after an explicit instruction to publish.

## Repository presentation

Proposed description:

> DeepSeek Harness plugin for STM/SPM instrument control, with golden fixtures, contract tests, and mutation drills for verifiable domain-skill migration.

Proposed topics: `stm`, `scanning-tunneling-microscopy`, `llm-agent`, `scientific-instruments`, `typescript`.

Issues are currently enabled. The earlier checklist proposed leaving them off; changing this setting is a repository-maintenance choice and is not part of content cleanup.

## Out of scope for publication preparation

- npm publication;
- completing the remaining 60 in-scope skills;
- packaged plugin installation and model invocation;
- simulator CI setup or hardware use;
- Remote pushes, visibility changes or messages to third parties without the corresponding instruction. The authorized local history cleanup and publication-copy commit are part of this preparation.
