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

Continue development and publication from the separately prepared `dsh-spm-public-ready` checkout. It retains the cleaned development branches and tool snapshots; the historical remote-tracking ref is omitted from that checkout, and no remote is configured. Do not merge or pull the retained original private history into it. The local backup, detailed findings, replacement rules and old/new commit map are not publication files.

The existing GitHub repository has not been rewritten or made public by this cleanup. Replacing its branch with cleaned history is a separate action, and a force-push alone may leave old commits accessible through cached views or pull-request references. Review those retained copies before changing visibility; GitHub documents the additional removal process and the limits of support assistance in [Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

Before a remote update, verify that no new remote work has appeared since the recorded baseline, inspect the exact branch update and keep visibility private. Do not publish every local ref or tag by default. Repository metadata and the final visibility change remain on the [release checklist](RELEASE-TODO.md).

History cleanup is a content preparation step. It does not resolve the known CI failures, prove packaged installation or authorize hardware use. Runtime limits remain in [MINIMUM-RUN-TODO.md](MINIMUM-RUN-TODO.md).
