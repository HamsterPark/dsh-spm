# Sources and third-party notices

This repository contains original TypeScript implementation work, deterministic fixtures derived from a separately maintained reference implementation, and one imported protocol metadata table. Source provenance does not by itself imply that private source code is included.

## Reference implementation and golden fixtures

The Python MAST repository is maintained separately and is treated as read-only by this project. Exporters under `tools/spec-export/` execute selected reference functions against synthetic inputs and save their deterministic outputs under `spec/golden/`. The repository does not include the MAST source tree, model weights, private research snapshots, or real instrument data.

The project owner has directed the migration and public preparation of the MAST-derived material. This review found no specific third-party ownership conflict in the generated fixtures or the twelve MAST patch entries. The review was bounded: it checked repository provenance records and source metadata, not every line of the separately maintained private repository.

## Nanonis protocol metadata

`spec/nanonis/nanonis_commands.json` was copied from the separately maintained STM-Bench protocol table. Its `generated_from` metadata records two inputs:

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

## Paper-derived algorithms

Several skills are named after published scientific methods. The repository contains implementations and synthetic test cases, not copies of article text, figures, or datasets. Normal bibliographic references, DOI links, and algorithm names should be preserved. If a future contribution imports article text, figures, supplementary data, or reference code, its license and attribution must be recorded here before publication.
