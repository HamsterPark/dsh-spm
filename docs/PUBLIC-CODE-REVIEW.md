# Public content review — 2026-09-20

## Scope and completion

Twenty `gpt-5.6-luna` reviewers completed twenty disjoint reading assignments. Each file was assigned to one reviewer; this was not twenty independent reviews of every file.

The reviewed snapshot contained **628 files**: 626 tracked files plus the release plan and source-notice document prepared locally. Its base commit was `22f655b6ca27e54d2fac3fb337044f9636725406`, with the earlier uncommitted release-preparation edits included. Per-file SHA-256 hashes identify that snapshot.

| Material | Coverage |
|---|---|
| Source, tests and generated source | 463 files; approximately 150,000 lines; all text read |
| Full-text mode, including the source files above | 604 files |
| Large JSON fixtures and inventories | 24 files; structured review described below |
| Reading assignments | 20 of 20 complete |
| Reading segments | 1,304 of 1,304 accounted for |

The source count comprises 414 TypeScript, 47 Python, one JavaScript and one SQL file. Documentation, configuration and tracked logs were also included.

Full-text segments preserve the complete file text. For the 24 large JSON files, every node was traversed and every unique key and text value was presented in full; repeated text was represented with its first location and occurrence count. Numeric arrays were summarized by path and range. Recognized encoded file payloads were decoded for header inspection. This does **not** claim individual numeric-element review or visual inspection of binary images.

The coordinator verified snapshot hashes, exact segment coverage, per-file report coverage and completion from all twenty reviewers. A few report path/mode labels were corrected to match the delivered manifest, with the original labels and correction notes retained. Delivery receipts alone were not treated as evidence of understanding: the records also include reviewer completion statements and per-file review notes.

Detailed reports, reading receipts and `FILE-COVERAGE.csv` are stored outside this repository. They may contain private findings and are not publication artifacts.

## Findings and treatment

The full reading found content missed by the earlier targeted scan:

- A specific experimental sample identity appeared together with acquisition details and incident narration. Copies existed in comments, skill descriptions, generated specifications and golden metadata. The same identity was also used as an arbitrary unknown-surface test label.
- One optional-module comment described an operator's actual instrument configuration and license availability.
- Some comments and descriptions retained first-person incident narratives, quoted exchanges, accusatory wording, local artifact references and developer-specific setup advice.

These findings require coordinated content cleanup. Removing an identifying comment alone does not remove its copies in generated descriptions or goldens. Unknown-surface fixtures can use a generic unregistered label while preserving the rejection case. Scientific thresholds, algorithm behavior and the distinction between reference-system observations and synthetic tests must remain intact.

The confirmed content was cleaned and the coupled goldens/generated specifications were synchronized. The identifying sample text had appeared in 17 files, including an exporter fixture reference. It no longer appears in prose or identifiers in the reviewed tree. One coincidental spelling match remains inside an encoded SXM fixture: its decoded content does not contain the name, and both the original encoded text and decoded bytes were preserved.

The cleanup intentionally changes some observable text: skill descriptions, provenance and diagnostic messages, an arbitrary unknown-surface test label (`unregistered-surface`), and the built-in profile identifier (`reference-surface-v1`). **External configurations that used the previous profile identifier must update it.** No compatibility alias containing that identity was added.

Technical instructions were reviewed separately from tone. The atomic-tip description retains its numeric settings, sacrificial/clean-frame distinction, fallback steps, qPlus refusal and entry-point guidance. The bias-series description now states the already documented limitation that its drift-check path does not currently provide `AssessFrameTrust` metrics.

## Verification of the cleanup

Post-review edits were checked separately from the original reading snapshot:

| Check | Result |
|---|---|
| Generate skill specifications and check synchronization | 442 specifications; no missing entries; check passed |
| Build | `pnpm build` passed |
| Focused unit/contract tests | **698 passed in 9 files** |
| TypeScript structural comparison | 21 changed files checked; only reviewed explanatory text and anonymous identifiers differ |
| Python structural comparison | Four changed exporters checked; documentation, anonymous fixture identifiers and explicit descriptive-text normalization are the exceptions |
| JSON comparison | Seven changed goldens; numerical values, structure and binary payloads preserved, apart from the intentional unknown-surface object-key rename; 198 text values changed |
| Mutation catalogue | All 879 rules preserved; one diagnostic rationale changed; target match counts unchanged |

The focused tests cover lattice analysis, scan preparation, analysis goldens, real tool schemas and the affected batch fixtures. The existing unmatched mutation pattern remains documented in [RELEASE-TODO.md](RELEASE-TODO.md). This was not a new full-suite run or mutation drill.

One exporter now applies two exact replacements to descriptive text after serialization, so its public cluster-provenance text matches the cleaned golden. No MAST exporter was executed. Other private-reference exports still require publication review after regeneration.

## Interpretation of the findings

Dates, anonymous record numbers, ordinary physical measurements, public vendor names, common material references and localhost examples were not automatically classified as private. Some reviewer suggestions inferred a publication-permission issue from those facts alone; those suggestions were not adopted as established leaks. Observed evidence must not be relabeled as synthetic data to make it appear publishable.

No new credential or private network address was identified by the full reading. No specific copied paper passage, figure or dataset was identified. Normal scientific references and copyright notices are retained. A missing per-method citation link is a traceability improvement, not evidence of infringement; source-review boundaries remain documented in [SOURCES.md](SOURCES.md).

## Remaining boundaries

- This was a full reading of the specified current-tree snapshot, not a line-by-line reading of all Git history. The earlier bounded history scan covered 207 reachable commits.
- Cleaning the working tree does not remove sample descriptions, personal paths, old conversations or author metadata from reachable history. A publication decision must cover that history too.
- A subsequent authorized pass removed confirmed developer-machine paths from exporter entry points, provenance metadata and remaining comments/documentation. Required external roots now come from `MAST_ROOT` / `STMSIM_ROOT`; generic synthetic path fixtures remain. Its additional verification is recorded below.
- Re-exporting from the private reference system can restore the original identifying prose. Public exports need an explicit content review after regeneration; sanitized observations must retain their true source category.
- Full reading is not a guarantee that every sensitive detail has been recognized. It also does not validate runtime correctness, distribution installation or hardware safety. Existing CI and runtime limitations remain in [RELEASE-TODO.md](RELEASE-TODO.md) and [MINIMUM-RUN-TODO.md](MINIMUM-RUN-TODO.md).

The original twenty-reviewer pass did not rewrite history. The owner subsequently authorized history-preserving cleanup in an isolated local copy, then remote history replacement and a retained-content audit. The remote branch now contains the cleaned history; the original local repository and its worktrees remain private backups. GitHub visibility remains private because old commits are still accessible by identifier through its authenticated API. History verification and the remaining publication boundary are recorded in `HISTORY-CLEANUP.md`.

## Final path cleanup

All 47 exporter usage examples now use a configured Python environment. A shared path helper validates required external-source directories before the exporter adds them to its import path. Forty-five exporters require `MAST_ROOT`; two require `STMSIM_ROOT`, with one using both. The numerical-library exporter requires neither. These variables identify read-only source roots, while `MAST2_PROJECT_ROOT` remains a separate isolated runtime directory.

The manifest exporter records `<MAST_ROOT>` instead of the configured local directory. Frozen manifest and Nanonis provenance metadata, two handoff references and one test comment were also deidentified. This changes exporter setup requirements; users must configure the relevant environment variables. It does not change instrument algorithms or numerical fixtures.

The Nanonis generator synchronization check passed for all 671 methods. A further **117 tests in `z-trace.test.ts` passed** after the comment change. These are additional to the previously reported 698 tests, not a fresh run of the complete suite. No private-source exporter, simulator or hardware was run.

A separate Luna review checked the exporter diffs and Python syntax, then exercised the helper with missing variables, non-directory values and temporary directories. All cases passed. JSON comparison confirmed that the manifest changed only its source-root field and the Nanonis table changed only two provenance fields; numeric and encoded payloads were unchanged. A final current-file scan found no remaining occurrences of the confirmed personal identifiers outside the verified encoded coincidence described above.

The final integration also synchronized one specific artifact filename in the claim-audit test and golden with the anonymous absolute path already used by its exporter. Only that exact path changed (two test occurrences and seventeen golden occurrences); the JSON structure, numbers and other text were preserved. All **25 claim-audit tests passed**. Generic Windows, POSIX and network-share parser cases remain covered.

The numerical exporter's module introduction was shortened to its technical purpose and tolerance/input requirements. Its executable Python AST is unchanged from the original committed version after excluding that module docstring.

The final tone pass also clarified the analysis exporter introduction and three TypeScript comment blocks about reference parsing and simulator process ownership/error handling. The Python executable AST, TypeScript emitted code and compiler directives were compared before and after these edits and remained identical. No simulator execution was required for those comment-only changes.
