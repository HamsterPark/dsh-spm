# Final publication preparation — 2026-09-21

The updated source is ready to be published as an **experimental plugin under active development**. The new independent repository remains **private**. Public visibility and the subsequent anonymous checks are the remaining publication action; this preparation did not publish an npm package or validate real instruments.

## Candidate and validation

The tested code candidate is commit `60313d111bbeb28f12e26b7167c51f01b5706ddb`, tree `9a1a14f1cffcbcbcaa40787aabbaa6b6de01a004`. It contains 667 tracked files and 211 reachable commits: 207 cleaned development commits and four preparation/runtime commits. Later documentation-only commits record these results; the final publication HEAD must be checked against the reviewed branch before changing visibility.

| Check | Result |
|---|---|
| Local environment | Windows, Node `v24.14.0`, pnpm `11.7.0`; frozen lockfile installation passed |
| `pnpm build` | Passed |
| `pnpm test --project unit --project contract` | 7,518 passed in 128 files; zero failed or skipped; parent environment explicitly used `TZ=UTC` |
| Generated skill/progress synchronization | Both `--check` commands passed; 442/515 skills, 112/165 modules |
| [New-repository CI run 35574839292](https://github.com/HamsterPark/dsh-spm/actions/runs/35574839292) | Windows and Ubuntu × Node `22.19.0` and `24.20.0`: all four build/test jobs passed for `60313d1`; each passed 7,518 tests in 128 files |
| Reader documentation | 175 local links/anchors checked across ten entry/operation/provenance documents before the final report links were added |

The previous CI failures were test-environment differences: reference-local time was exported in UTC+8; Windows/POSIX paths and Node ENOENT wording differed. The test workers now replay the reference timezone, and the trace comparator normalizes separators only inside recognized project paths. The missing-file expectations remain exact for each platform. Three regression checks retain distinctions in directories, channel/direction, sequence and extension, and preserve unrelated backslashes. Production behavior and golden data were not changed for this fix; no failing cases were skipped.

The managed STM-Bench and native Nanonis runtime code, reports and reader guides are included. Their installation/model evidence remains tied to the separate package hashes in [the managed report](minimum-usable-20260921.md) and [the native report](native-nanonis-20260921.md). This final preparation did not rebuild those packages or rerun their simulator/model sessions. It did not run reference exporters, mutation drills or real-instrument operations.

## Repository identity and isolation

| Repository | Immutable ID | State at this check |
|---|---|---|
| `HamsterPark/dsh-spm-private-archive` | `1372557135` | Existing repository renamed; private |
| `HamsterPark/dsh-spm` | `1379303402` | New empty independent repository, `fork: false`; private |

Before the name was reused, the original development checkout's shared remote configuration, including its nine linked worktrees, was repointed to the private archive. The additional local audit clone that still targeted the old URL was also repointed. The publication checkout alone was used to push reviewed `master`; no mirror push, original-history merge, tool ref or tag was published. The new repository has its experimental-development description and five project topics.

An independent local inspection and fresh single-branch download confirmed:

- HEAD, tree, all 211 commits and all 4,000 master-reachable objects matched the reviewed code candidate.
- All 207 cleaned historical commits were retained; none of the 207 original commit objects was present. The downloaded store had no extra/unreachable objects or alternate object store, and its integrity check passed.
- All current files, objects introduced after the earlier reviewed candidate, and commit metadata passed known-identifier and strong-credential-pattern checks. Generic path/address fixtures were reviewed in context. The earlier approved encoded-fixture exception was verified by its exact decoded hash and a fresh decoded-content scan.
- Authenticated queries through the **new** repository returned HTTP 422 with “No commit found for SHA” for all 207 original commits, and HTTP 404 for the confirmed old file. Current-head access succeeded; the old commit remained accessible through the private archive as a control. No permission, rate-limit or network error was counted as absence.

These are bounded content and route checks, not a guarantee against unrecognized private content. The prior full review and historical cleanup remain the basis for unchanged history. Private backups, commit mappings, scan details and raw logs stay outside the publication tree. The archive's retained original objects have not been deleted and are not claimed to be deleted.

## Publication boundary

The README, agent instructions and documentation map explicitly state active development, experimental maturity, changing interfaces/configuration/tool scope, and the absence of real-instrument validation. Source publication does not assert a stable release or hardware readiness.

When publication is requested, use the reviewed `dsh-spm-public-ready` checkout and verify the actual `master` HEAD and repository ID `1379303402`. Make only this new repository public, then check anonymous README/current-source access and original-commit isolation. Confirm that archive ID `1372557135` remains private. Do not publish from the original-history checkout or change the archive's visibility.
