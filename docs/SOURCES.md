# Sources and third-party notices

This repository contains TypeScript implementation work, reference-derived fixtures and imported protocol metadata. This register identifies those sources and preserves third-party notices. For implementation and validation, see the [review guide](REVIEW-GUIDE.md).

## Reference implementation and golden fixtures

The Python MAST repository is maintained separately and is treated as read-only by this project. Files under [spec/golden/](../spec/golden/README.md) have several source categories:

| Material | How it is obtained |
|---|---|
| Skill and parameter declarations | Extracted from the reference implementation's declarations |
| Behavioral traces | Selected reference functions executed with controlled inputs and recorded calls/results |
| Dependency inventories | Static analysis of reference source, with unresolved cases recorded explicitly |
| Numerical fixtures | Public numerical libraries executed on saved inputs; the numerical exporter uses NumPy, SciPy and scikit-image |
| Protocol fixtures | Reference protocol implementations and simulator-related exporters, identified by the corresponding script |
| Visual-harness fixtures | The Python visual-memory reference ([VISTA-SPM](https://github.com/HamsterPark/VISTA-SPM), pinned at `3bef5c7`) executed on synthetic inputs; its design derives from [VISTA](https://github.com/joshhhhhan/VISTA). See [Visual harness](#visual-harness-vista-and-vista-spm) |

Each exporter documents its dependencies and source. Descriptive fields can also contain deidentified reference-system observations; those remain observations rather than synthetic tests. The [public-content review](PUBLIC-CODE-REVIEW.md) records normalization of descriptions and identifiers, including its compatibility and byte-comparison limits. Exported public text must be reviewed again after regeneration.

The repository does not include the MAST source tree, model weights, private research snapshots or original instrument datasets. Testing the saved fixtures does not require the private source; regenerating MAST-specific fixtures does.

The recorded provenance review found no specific third-party ownership conflict in the generated fixtures or the twelve MAST patch entries. Its scope was repository provenance records and source metadata, not every line of the separately maintained private repository. The project owner directed the migration and public preparation of the reference-derived material.

## Nanonis protocol metadata

[nanonis_commands.json](../spec/nanonis/nanonis_commands.json) was copied from the separately maintained STM-Bench protocol table. Its `generated_from` metadata records two inputs:

1. command metadata extracted from `nanonis_spm` version 1.0.9; and
2. twelve MAST-specific patch entries.

The [`nanonis-spm` 1.0.9 release on PyPI](https://pypi.org/project/nanonis-spm/1.0.9/) identifies itself as the Python interface package for Nanonis. The reviewed wheel is `nanonis_spm-1.0.9-py3-none-any.whl`; its notice is stored at `nanonis_spm-1.0.9.dist-info/licenses/LICENSE`. [PyPI's release JSON](https://pypi.org/pypi/nanonis-spm/1.0.9/json) does not populate the license fields, so the bundled wheel notice is the controlling evidence used here.

> MIT License
>
> Copyright (c) 2024 Samuel O'Neill
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The Nanonis company and product names identify protocol compatibility and do not imply endorsement. The MAST-specific patch entries are identified separately in the table metadata rather than attributed to the upstream package.

## Visual harness: VISTA and VISTA-SPM

The `dsh-spm-visual-memory` package and the four visual golden fixtures (`visual_memory.json`, `measure_profile.json`, `measure_fft_blobs.json`, `measure_diff.json`) build on two MIT-licensed projects. Both notices are reproduced below, as the licenses require.

**VISTA.** Qiushi Han, Keya Hu, Linlu Qiu, Cathy Wu and Kaiming He, "VISTA: A Visual Harness for Reasoning in an Interactive World", [arXiv 2610.02200](https://arxiv.org/abs/2610.02200) (2026); code at [joshhhhhan/VISTA](https://github.com/joshhhhhan/VISTA). VISTA-SPM ports parts of it from commit `c97c354f0a8948256545a3e8850a1848f8e5b8c1` (2026-10-04).

> MIT License
>
> Copyright (c) 2026 VISTA contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

**VISTA-SPM.** [HamsterPark/VISTA-SPM](https://github.com/HamsterPark/VISTA-SPM) is the Python reference implementation of the visual-memory and measurement design and is itself partly derived from VISTA (see its [THIRD_PARTY_NOTICES.md](https://github.com/HamsterPark/VISTA-SPM/blob/main/THIRD_PARTY_NOTICES.md)). The golden fixtures here are exported from VISTA-SPM at commit `3bef5c7` (tag `m1-surface`); fixes made on its main branch afterwards have not been re-exported.

> MIT License
>
> Copyright (c) 2026 HamsterPark
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

**What is derived here.** In `packages/host/visual-memory/src/` the TypeScript code re-implements, with the reference implementation's argument rules, reply fields and messages:

- the system-prompt wording (`prompt.ts`), which follows VISTA's own prompt through VISTA-SPM;
- the `inspect` / `read_pixels` tool semantics and caps (here `stm_inspect` / `stm_read_values`; `views.ts`, `args.ts`);
- the notes tools (`notes.ts`);
- the measurement tools ported from VISTA-SPM's `measure.py` (`line-profile.ts`, `fft-peaks.ts`, `detect-blobs.ts`, `frame-diff.ts`, `frame-stats.ts`, `register.ts`);
- the frame-id format and new-file ingestion rules (`frame-id.ts`, `observe.ts`), and the graph-paper overlay (`render.ts`), adapted from VISTA's cell-boundary overlay.

The persistent archive, the one-action-one-observation gate on dsh's agent loop, the skill-kernel wiring and the PNG codec are specific to this repository; deliberate differences are registered in the [deviation register](../spec/deviations.md) as `D-VMEM-*`.

## Paper-derived algorithms

Several skills are named after published scientific methods. The recorded content review identified implementations and synthetic test cases; it did not identify copied article text, figures or datasets. Preserve bibliographic references, DOI links and algorithm names. If a contribution imports article text, figures, supplementary data or reference code, record its source, license and attribution here before publication.
