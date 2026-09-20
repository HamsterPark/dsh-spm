# History cleanup and publication boundary

## Decision and scope

On 2026-09-20 the owner chose to retain development history, clean historical versions and accept changed commit hashes. The original private repository and its linked worktrees are retained locally. A verified Git bundle and detailed findings are stored outside the publication tree; they are private backup material.

The original reachable history contains 207 commits. Cleanup is performed in a separate mirror, with empty commits and merge structure retained. Historical files receive targeted text changes; they are not replaced wholesale with today's implementation. New exporter configuration support belongs in the final cleanup commit, not in earlier development commits.

The cleanup covers confirmed identifying source paths, sample/profile identifiers, laboratory narratives, private configuration descriptions and reviewed informal text in historical blobs. Personal author/committer email is replaced with the project owner's verified GitHub noreply address. Public contributor attribution, license notices, normal scientific references and generic synthetic fixtures are retained.

Numerical fixtures and encoded payloads must remain intact. A coincidental spelling match inside an encoded fixture is not removed: the decoded content was inspected and the original payload preserved. Reference observations remain reference observations after deidentification.

## Verification status

The cleaned historical baseline is `d15568414fd7818daa67045adf8dbc7c92c06bb4`. The following checks were completed against that baseline, before the final current-tree cleanup commit:

| Check | Result |
|---|---|
| Development history | 207 commits retained; parent order, author/committer names and dates preserved |
| Reference coverage | All 15 baseline refs covered, including four tool snapshot refs pointing directly to two unique trees |
| Contributor attribution | 196 public coauthor trailers retained; personal project-owner email replaced with the verified noreply address |
| Historical content comparison | 447 distinct changed blob pairs checked; no binary blob changed |
| JSON invariants | 17 changed historical pairs; structure, numbers and all recognized long base64 payloads preserved, allowing the reviewed anonymous object-key rename |
| Source syntax | 136 Python and 118 TypeScript historical pairs checked; no new parse failures |
| Object storage | Integrity check passed; no unreachable objects, backup refs, temporary wrapper refs or alternate object stores in the cleaned mirror |
| Confirmed private content | No unresolved confirmed identifiers or paths; the verified encoded coincidence remains unchanged |

The commit map, reference mapping, replacement rules, hashes and detailed verification reports are retained privately outside this repository. A separate structural check verifies the commit mapping, ref types/paths, names, dates, public coauthor lines and object-store isolation. The final publication checkout adds one commit containing the reviewed current files, including portable exporter entry points and the publication documentation.

These checks preserve historical structure and fixture data. They do not claim that every historical revision was built or that every old test suite passes; historical exporters use explicit source-path placeholders, while the final cleanup commit supplies the environment-based entry points.

Current-tree review and its build, contract, metadata and path-helper checks are recorded in [PUBLIC-CODE-REVIEW.md](PUBLIC-CODE-REVIEW.md). Those checks do not by themselves verify historical objects. The full reading covered a defined current snapshot; history checking combines all-object scans, targeted historical review and structural comparisons, not a claim of line-by-line reading of every historical version.

## Publishing from the cleaned copy

Continue development and publication from the separately prepared `dsh-spm-public-ready` checkout. It retains the cleaned development branches and tool snapshots. Its `origin` now points to the existing GitHub repository, and the remote-tracking branch contains the cleaned history. Do not merge or pull the retained original private history into it. The local backup, detailed findings, replacement rules and old/new commit map are not publication files.

On 2026-09-20 the owner separately authorized remote history replacement and a retained-content audit. The sole remote branch, `master`, was updated to the reviewed cleanup commit `8d4a8a6088ede3eeeab756f3c6bb9529f1e356de` with an explicit expected-old-commit lease. No development branches, tool snapshot refs or tags were published. Visibility remains private.

A fresh clone from GitHub contained exactly the 207 cleaned historical commits and the cleanup commit, with 633 files and 3,895 objects matching the reviewed master branch. It contained no original commit IDs or unreachable objects. Later documentation-only commits record the remote audit separately.

The remote audit also confirmed a remaining blocker: all 207 original commit IDs returned HTTP 200 through GitHub's authenticated API, and the old root instruction file remained readable with a confirmed personal absolute path. Normal clones contain only cleaned history, but remote branch replacement does not remove these server-side objects or cached views. Keep the repository private while resolving this residue. GitHub documents the support-assisted removal process and its eligibility limits in [Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository). Detailed evidence and a support-request draft are retained outside the repository; no support message has been sent.

The additional remote inventory found no pull requests, issues, comments, forks, releases, release assets, workflow artifacts or deployments. All 62 workflow logs available at the audit snapshot were downloaded privately and scanned for confirmed identifying strings, with no matches; this is a targeted scan, not a guarantee about unrecognized content. Pages is disabled, and no initialized Wiki repository could be accessed. Three old dependency caches could not be inspected through the API; those three regenerable caches were deleted and their absence verified. Later workflow runs may create new caches.

Before subsequent remote updates, verify that no new remote work has appeared since the recorded baseline. Do not publish every local ref or tag by default. The retained-content findings, repository metadata and final visibility change remain on the [release checklist](RELEASE-TODO.md).

History cleanup is a content preparation step. It does not resolve the known CI failures, prove packaged installation or authorize hardware use. Runtime limits remain in [MINIMUM-RUN-TODO.md](MINIMUM-RUN-TODO.md).
