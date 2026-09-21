# History cleanup and publication boundary

This records the 2026-09-20 history cleanup, private-remote replacement and retained-content audit, together with the selected new-repository publication route. The 2026-09-21 readiness check is in the [release checklist](RELEASE-TODO.md). Subsequent runtime and documentation changes need their own comparison with the publication candidate. Current reader entry points are listed in the [documentation map](README.md).

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

The commit map, reference mapping, replacement rules, hashes and detailed verification reports are retained privately outside this repository. A separate structural check verifies the commit mapping, ref types/paths, names, dates, public coauthor lines and object-store isolation. The publication checkout added cleanup commit `8d4a8a6`, including portable exporter entry points and publication documentation, followed by audit and release-plan documentation at `5afb99c` and `9aa08bd`.

These checks preserve historical structure and fixture data. They do not claim that every historical revision was built or that every old test suite passes; historical exporters use explicit source-path placeholders, while the final cleanup commit supplies the environment-based entry points.

Current-tree review and its build, contract, metadata and path-helper checks are recorded in [PUBLIC-CODE-REVIEW.md](PUBLIC-CODE-REVIEW.md). Those checks do not by themselves verify historical objects. The full reading covered a defined current snapshot; history checking combines all-object scans, targeted historical review and structural comparisons, not a claim of line-by-line reading of every historical version.

## Publishing from the cleaned copy

The recorded publication candidate is the separately prepared `dsh-spm-public-ready` checkout. At preparation time it retained the cleaned development branches and tool snapshots, omitted the historical remote-tracking ref and had no remote configured. Before using it for publication, compare it with the intended current deliverable and review any later changes that must be carried over. Do not merge or pull the retained original private history into it. The local backup, detailed findings, replacement rules and old/new commit map are not publication files.

### Private-remote update and audit on 2026-09-20

The owner separately authorized remote history replacement and a retained-content audit. The sole remote branch, `master`, was updated to the reviewed cleanup commit `8d4a8a6088ede3eeeab756f3c6bb9529f1e356de` with an explicit expected-old-commit lease. No development branches, tool snapshot refs or tags were published. The repository remained private.

A fresh clone contained exactly the 207 cleaned historical commits and the cleanup commit, with 633 files and 3,895 objects matching reviewed `master`. It contained no original commit IDs or unreachable objects. Later documentation-only commits recorded the audit separately.

The authenticated remote audit nevertheless found all 207 original commit IDs still readable through the existing repository's API, as well as a confirmed personal path in the old root instruction file. Clean normal clones did not establish removal of retained server-side content. Detailed evidence and an unsent support-request draft remain private; archive cleanup is optional under the selected new-repository route.

At that audit snapshot, the additional inventory found no pull requests, issues, comments, forks, releases, release assets, workflow artifacts or deployments. All 62 available workflow logs were downloaded privately and scanned for confirmed identifying strings, with no matches; this was a targeted scan. Pages was disabled, and no initialized Wiki repository could be accessed. Three dependency caches could not be inspected through the API; they were deleted and their absence verified. These are historical findings, and later runs may create new caches.

### Selected publication route

The existing repository stays private through and after its planned rename to `HamsterPark/dsh-spm-private-archive`. Recheck that name and the repository's immutable ID before renaming. Before reusing `HamsterPark/dsh-spm`, update the original-history clones and shared worktree remote configuration to target the private archive, or remove their push target.

Create a new, empty, private `HamsterPark/dsh-spm` with a different repository ID and `fork: false`. Do not fork, import from the archive or copy its object store. Push only the reviewed publication `master`, retaining the 207 cleaned development commits and reviewed later commits. The new repository must pass fresh-clone and old-content isolation checks before public visibility; 403/429, network errors and service failures are inconclusive. The old archive's retained objects do not need to be removed to execute this route, but their absence from the new repository must be verified.

At the earlier 2026-09-21 readiness check, the existing repository had not been renamed and the new independent repository had not been created. The subsequent preparation completed that sequence: the archive retains repository ID `1372557135` and remains private; the new independent `HamsterPark/dsh-spm` has ID `1379303402`, reports `fork: false` and remains private pending publication. Original-history local remotes were repointed before reusing the name.

The assembled code candidate is `60313d111bbeb28f12e26b7167c51f01b5706ddb`, tree `9a1a14f1cffcbcbcaa40787aabbaa6b6de01a004`, with 211 commits and 667 files. A fresh single-branch clone matched its HEAD, tree, commit set and object set; all 207 cleaned commits were retained, and no original commit object, unreachable object or alternate object store was present. Authenticated checks under the new repository returned a definitive no-commit response for all 207 old SHAs and 404 for the known old file, with successful current-head and private-archive controls. Detailed private reports and the old/new mapping stay outside the publication tree.

The [final preparation record](handoff/publication-ready-20260921.md) separates the tested code candidate from later documentation and lifecycle-test updates. The [release checklist](RELEASE-TODO.md) requires CI for the actual final HEAD and retains public visibility and its anonymous verification as the remaining publication action.

History cleanup validates the publication content within the scope above. Installation and model behavior have separate evidence in the [STM-Bench guide](MINIMUM-USABLE.md) and [Nanonis simulator guide](NANONIS-SIMULATOR.md); historical CI and remaining publication actions are recorded in the release checklist. Hardware validation remains outside these checks.
