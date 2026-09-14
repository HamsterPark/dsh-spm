r"""通过 NumPy、SciPy 和 scikit-image 生成数值计算参考结果。

输入数组与计算结果一并保存，TypeScript 实现使用相同输入进行比较。
各算法的比较容差及依据在对应 TypeScript 文档中声明，应在实现前确定。
固定随机种子用于复现输入；差分测试比较保存的数值，不以种子相同代替输入相同。

    python tools/spec-export/export_numerics.py
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import numpy as np
import scipy.ndimage as ndi
from scipy.optimize import curve_fit as sp_curve_fit
from skimage.metrics import structural_similarity
from skimage.registration import phase_cross_correlation

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "spec" / "golden" / "numerics.json"

#: 这一份金样用的种子。换种子 = 换一份金样，要当成一次有意的改动。
SEED = 20260914


def _plain(v: Any) -> Any:
    """JSON 化。**NaN / inf 走字符串占位**（`allow_nan=False` 是这份金样的纪律：
    一个 `NaN` 字面量在 JSON 里不是合法值，而各家解析器对它的容忍度不一样——
    靠运气的互通不是互通）。同 `export_zctrl_presets.py` 的 `_plain`。"""
    if isinstance(v, (np.ndarray,)):
        return _plain(v.tolist())
    if isinstance(v, (np.floating, np.integer, np.bool_)):
        return _plain(v.item())
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, float):
        if v != v:
            return "NaN"
        if v == float("inf"):
            return "Infinity"
        if v == float("-inf"):
            return "-Infinity"
        return v
    if v is None or isinstance(v, (bool, int, str)):
        return v
    return str(v)


rng = np.random.default_rng(SEED)

# ──────────────────────────────────────────────────────────────────────────
# 1. 统计：mean / std / percentile / histogram / ptp
# ──────────────────────────────────────────────────────────────────────────
#
# ⚠️ **numpy 的 `sum` 是成对求和（pairwise），Python 3.12+ 的 `sum()` 是 Neumaier
# 补偿求和。两者不是同一个算法，最后一位会分岔。** 本仓已经为后者写了 `pySum`
# （`kernel/src/si.ts`，那是技能金样逐字节比要的那一个），所以这一层对 numpy 的
# 比对**必须带容差**，而容差的理由是成对求和的误差界 O(eps·log₂N)。
#
# 录一长一短两串：短的（8 个）差不多处处 bit-exact，长的（2048 个）才看得见分岔。

STATS: dict[str, Any] = {}
for name, arr in [
    ("small", np.array([3.0, 1.0, 4.0, 1.0, 5.0, 9.0, 2.0, 6.0])),
    ("normal2048", rng.standard_normal(2048)),
    # p 量级：STM 的电流就在这个数量级上，而「相对误差」在这里才是有意义的那个量
    ("picoamp", rng.standard_normal(512) * 1e-12 + 1.5e-10),
    ("withties", np.array([2.0, 2.0, 2.0, 1.0, 3.0, 3.0])),
]:
    STATS[name] = {
        "input": _plain(arr),
        "sum": _plain(float(np.sum(arr))),
        "mean": _plain(float(np.mean(arr))),
        "std_ddof0": _plain(float(np.std(arr))),
        "std_ddof1": _plain(float(np.std(arr, ddof=1))),
        "ptp": _plain(float(np.ptp(arr))),
        "min": _plain(float(np.min(arr))),
        "max": _plain(float(np.max(arr))),
        "median": _plain(float(np.median(arr))),
        # `linear` 是 numpy 的缺省插值法：虚拟下标 vi = q/100*(n-1)，
        # 然后在 sorted[floor(vi)] 与 sorted[ceil(vi)] 之间线性插。
        # 别的方法（`lower` / `midpoint` / …）给的是别的数，不是「同一个数的不同精度」。
        "percentile_linear": {
            str(q): _plain(float(np.percentile(arr, q, method="linear")))
            for q in [0, 1, 5, 25, 33.3, 50, 75, 95, 99, 100]
        },
    }

# histogram：**bin 边界的归属**是判据。numpy 的规则是左闭右开，**最后一个 bin 例外**
# （右也闭）——这一条在 `AssessSpectrum` 那类「最高的那个 bin 是哪个」上会翻结论。
_hist_x = np.array([0.0, 0.5, 1.0, 1.5, 2.0, 2.0, 2.5, 3.0])
_counts, _edges = np.histogram(_hist_x, bins=3, range=(0.0, 3.0))
HISTOGRAM = {
    "input": _plain(_hist_x),
    "bins": 3,
    "range": [0.0, 3.0],
    "counts": _plain(_counts),
    "edges": _plain(_edges),
    "_note": "左闭右开，最后一个 bin 右边界也闭 —— 3.0 落进最后一个 bin",
}

# ──────────────────────────────────────────────────────────────────────────
# 2. 可分离滤波：gaussian / laplacian，**五种边界模式各录一份**
# ──────────────────────────────────────────────────────────────────────────
#
# scipy 的核是 exp(-0.5*(x/σ)²) 归一化，半宽 lw = int(truncate*σ + 0.5)。
# 实测（见本文件抬头的探针）这个核与 scipy 的核**逐位相同**，所以滤波本身的
# 误差只来自那 2lw+1 次乘加 —— 容差按它写。
#
# **边界模式是语义不是精度**：scipy 的 `reflect` 是 (d c b a | a b c d)，
# `mirror` 是 (d c b | a b c d) —— 少一个元素，而两者的名字在 numpy.pad 里
# 正好**反过来**。录五份，谁也别想靠「差不多」蒙混过去。

FILTER_MODES = ["reflect", "nearest", "constant", "mirror", "wrap"]
_sig1d = rng.standard_normal(64)
GAUSS1D: dict[str, Any] = {"input": _plain(_sig1d), "cases": []}
for sigma in [0.8, 1.0, 2.5]:
    for mode in FILTER_MODES:
        GAUSS1D["cases"].append({
            "sigma": sigma,
            "truncate": 4.0,
            "mode": mode,
            "output": _plain(ndi.gaussian_filter1d(_sig1d, sigma, mode=mode, truncate=4.0)),
        })

_img = rng.standard_normal((24, 20))
GAUSS2D: dict[str, Any] = {"input": _plain(_img), "cases": []}
for sigma in [1.0, 2.0]:
    for mode in ["reflect", "nearest", "constant"]:
        GAUSS2D["cases"].append({
            "sigma": sigma,
            "truncate": 4.0,
            "mode": mode,
            "output": _plain(ndi.gaussian_filter(_img, sigma, mode=mode, truncate=4.0)),
        })

# 拉普拉斯：scipy 的 `laplace` 是 **[1, -2, 1] 沿每一轴相加**，不是 3×3 的那个九点核。
LAPLACE: dict[str, Any] = {"input": _plain(_img), "cases": []}
for mode in ["reflect", "nearest", "constant"]:
    LAPLACE["cases"].append({"mode": mode, "output": _plain(ndi.laplace(_img, mode=mode))})

# ──────────────────────────────────────────────────────────────────────────
# 3. 拟合：平面 / 二维多项式 / RANSAC 的内点判定
# ──────────────────────────────────────────────────────────────────────────
#
# 用 `lstsq`（SVD）录答案，而 TS 那侧走正规方程（Aᵀ A x = Aᵀ b）——**两种算法**，
# 于是容差要按**条件数**写：正规方程把条件数平方，κ(AᵀA) = κ(A)²。
# 所以金样里把 κ(A) 一起录下来：读的人要能自己算那个容差是不是够。

_h, _w = 16, 20
_yy, _xx = np.mgrid[0:_h, 0:_w].astype(float)
_plane = 3.0 + 0.25 * _xx - 0.4 * _yy
_noise = rng.standard_normal((_h, _w)) * 0.01
_z = _plane + _noise

_A_plane = np.column_stack([np.ones(_h * _w), _xx.ravel(), _yy.ravel()])
_coef_plane, *_ = np.linalg.lstsq(_A_plane, _z.ravel(), rcond=None)
PLANE = {
    "shape": [_h, _w],
    "z": _plain(_z),
    "truth": {"c": 3.0, "cx": 0.25, "cy": -0.4},
    "coef": _plain(_coef_plane),          # [c, cx, cy]
    "cond": _plain(float(np.linalg.cond(_A_plane))),
    "residual": _plain(_z.ravel() - _A_plane @ _coef_plane),
}

# 二维二次多项式：1, x, y, x², xy, y²
_poly_truth = np.array([1.0, 0.3, -0.2, 0.01, -0.005, 0.02])
_A_poly = np.column_stack([
    np.ones(_h * _w), _xx.ravel(), _yy.ravel(),
    _xx.ravel() ** 2, _xx.ravel() * _yy.ravel(), _yy.ravel() ** 2,
])
_zp = (_A_poly @ _poly_truth).reshape(_h, _w) + rng.standard_normal((_h, _w)) * 0.005
_coef_poly, *_ = np.linalg.lstsq(_A_poly, _zp.ravel(), rcond=None)
POLY2D = {
    "shape": [_h, _w],
    "z": _plain(_zp),
    "truth": _plain(_poly_truth),
    "coef": _plain(_coef_poly),
    "cond": _plain(float(np.linalg.cond(_A_poly))),
}

# RANSAC：**不录 numpy 的结果**（scikit 的 RANSAC 用它自己的 RNG，复现不了）。
# 录的是一份**带离群点的输入**与「正确答案应该长什么样」的判据：
# 用全部内点做最小二乘得到的系数。TS 那侧的 RANSAC 若真把离群点甩掉了，
# 它的系数就该落在这个答案附近；甩不掉就会被那 12 个 +50 拽走。
_ro = _plane.ravel().copy()
_outlier_idx = rng.choice(_h * _w, size=12, replace=False)
_ro[_outlier_idx] += 50.0
_inlier_mask = np.ones(_h * _w, dtype=bool)
_inlier_mask[_outlier_idx] = False
_coef_clean, *_ = np.linalg.lstsq(_A_plane[_inlier_mask], _ro[_inlier_mask], rcond=None)
_coef_dirty, *_ = np.linalg.lstsq(_A_plane, _ro, rcond=None)
RANSAC = {
    "shape": [_h, _w],
    "z": _plain(_ro.reshape(_h, _w)),
    "outlier_index": _plain(np.sort(_outlier_idx)),
    "coef_inliers_only": _plain(_coef_clean),
    "coef_all_points": _plain(_coef_dirty),
    "_note": "RANSAC 的判据不是「等于哪个数」，是「离 coef_inliers_only 近、离 coef_all_points 远」",
}

# ──────────────────────────────────────────────────────────────────────────
# 4. FFT：1-D / 2-D / 互相关 / phase_cross_correlation
# ──────────────────────────────────────────────────────────────────────────
#
# numpy 的 `fft` **不做归一化**，`ifft` 除以 N（norm='backward'）。这是约定不是精度，
# 选错了整条曲线差一个常数因子，而形状看起来完全正常。
#
# 长度取三种：2 的幂（radix-2 走得到）、素数（只能走 Bluestein）、以及一个合数。

FFT1D: dict[str, Any] = {"cases": []}
for n in [64, 61, 96]:
    sig = rng.standard_normal(n)
    sp = np.fft.fft(sig)
    FFT1D["cases"].append({
        "n": n,
        "input": _plain(sig),
        "re": _plain(sp.real),
        "im": _plain(sp.imag),
        "roundtrip": _plain(np.fft.ifft(sp).real),
    })

_f2 = rng.standard_normal((16, 12))
_sp2 = np.fft.fft2(_f2)
FFT2D = {
    "shape": [16, 12],
    "input": _plain(_f2),
    "re": _plain(_sp2.real),
    "im": _plain(_sp2.imag),
}

# ⚠️ **峰位约定就是漂移方向的符号。**
#
# `phase_cross_correlation(reference, moving)` 给的是「把 moving 移动多少才能对上
# reference」。实测：b = roll(a, +3, +5) 时它返回 [-3, -5] —— **负的**那一个。
# 而 `ifft2(F_a · conj(F_b) / |…|)` 的峰位折到负半轴之后正好也是 [-3, -5]。
#
# 用**不对称**的位移（3 ≠ 5、且都不为 0）录，好让一次轴对调或一次符号翻转
# 在金样上立刻现形。
XCORR: dict[str, Any] = {"cases": []}
_base = rng.standard_normal((32, 32))
for dy, dx in [(3, 5), (-2, 7), (0, 4), (6, 0)]:
    moved = np.roll(np.roll(_base, dy, axis=0), dx, axis=1)
    shift, _err, _pd = phase_cross_correlation(_base, moved, upsample_factor=1)
    XCORR["cases"].append({
        "applied_roll": [dy, dx],
        "reference": _plain(_base),
        "moving": _plain(moved),
        "shift": _plain(shift),
        "_note": "shift = 把 moving 移回 reference 要的位移 = −applied_roll",
    })

# ──────────────────────────────────────────────────────────────────────────
# 5. 连通域 / SSIM
# ──────────────────────────────────────────────────────────────────────────
#
# 连通域是**整数标签**，没有容差可言：对就是对。但**邻接数**是语义：
# 一条对角线在 4-邻接下是 n 个连通域，在 8-邻接下是 1 个。
_mask = np.array([
    [1, 1, 0, 0, 1],
    [1, 0, 0, 1, 1],
    [0, 0, 1, 0, 0],
    [1, 0, 0, 0, 1],
    [1, 1, 0, 0, 1],
], dtype=int)
_lab4, _n4 = ndi.label(_mask, structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]]))
_lab8, _n8 = ndi.label(_mask, structure=np.ones((3, 3), dtype=int))
LABEL = {
    "mask": _plain(_mask),
    "labels4": _plain(_lab4), "count4": int(_n4),
    "labels8": _plain(_lab8), "count8": int(_n8),
    "sizes4": _plain(np.bincount(_lab4.ravel())[1:]),
    "sizes8": _plain(np.bincount(_lab8.ravel())[1:]),
}

# SSIM：skimage 的缺省是 7×7 **均匀**窗（不是高斯），且 `data_range` 必须显式给
# —— 不给的话它按 dtype 猜，而那个猜测在 float 图上是错的。
_a_img = rng.random((24, 24))
_b_img = _a_img + rng.standard_normal((24, 24)) * 0.05
SSIM = {
    "a": _plain(_a_img),
    "b": _plain(_b_img),
    "data_range": 1.0,
    "win_size": 7,
    "ssim_self": _plain(float(structural_similarity(_a_img, _a_img, data_range=1.0, win_size=7))),
    "ssim_ab": _plain(float(structural_similarity(_a_img, _b_img, data_range=1.0, win_size=7))),
}

# ──────────────────────────────────────────────────────────────────────────
# 6. `.npy` 读：**真 numpy 写出来的字节**
# ──────────────────────────────────────────────────────────────────────────
#
# 这一件没有容差，只有字节。录 base64，TS 那侧解出来逐元素比。
# 四种组合各一份：v1.0/v2.0 × C/F order × float64/float32/int32。
import io

NPY: dict[str, Any] = {"cases": []}


def _npy_bytes(arr: np.ndarray, version: tuple[int, int]) -> bytes:
    buf = io.BytesIO()
    np.lib.format.write_array(buf, arr, version=version)
    return buf.getvalue()


for label, arr, ver in [
    ("f8_2d_v1", np.arange(12, dtype=np.float64).reshape(3, 4) * 1.5, (1, 0)),
    ("f8_2d_v2", np.arange(12, dtype=np.float64).reshape(3, 4) * 1.5, (2, 0)),
    ("f8_fortran", np.asfortranarray(np.arange(6, dtype=np.float64).reshape(2, 3)), (1, 0)),
    ("f4_1d", np.array([1.5, -2.25, 3.125], dtype=np.float32), (1, 0)),
    ("i4_2d", np.arange(6, dtype=np.int32).reshape(2, 3), (1, 0)),
    ("f8_1d", np.array([1e-12, -3.5e8, 0.0, 7.0], dtype=np.float64), (1, 0)),
    ("f8_empty", np.zeros((0,), dtype=np.float64), (1, 0)),
]:
    raw = _npy_bytes(arr, ver)
    NPY["cases"].append({
        "label": label,
        "version": list(ver),
        "dtype": str(arr.dtype),
        "fortran_order": bool(arr.flags.f_contiguous and not arr.flags.c_contiguous),
        "shape": list(arr.shape),
        "bytes_b64": base64.b64encode(raw).decode("ascii"),
        "values": _plain(arr.ravel(order="C")),
    })

# ──────────────────────────────────────────────────────────────────────────
# 7. curve_fit（Levenberg–Marquardt）
# ──────────────────────────────────────────────────────────────────────────
#
# 录的是 scipy 的拟合结果。TS 那侧自写 LM，**两种实现**（scipy 走 MINPACK 的
# `lmdif`，带自己的信赖域与缩放），所以容差不能按机器精度写，只能按
# **「拟合值离真值多远」** 写：两边都该收敛到同一个极小点附近，
# 而那个点的不确定度由噪声水平定。金样里把噪声 σ 与协方差一起录下来。


def _gauss(x, a, mu, sigma, c):
    return a * np.exp(-0.5 * ((x - mu) / sigma) ** 2) + c


_cx = np.linspace(-5.0, 5.0, 80)
_ctruth = [2.5, 0.7, 1.3, 0.4]
_cnoise = 0.02
_cy = _gauss(_cx, *_ctruth) + rng.standard_normal(_cx.size) * _cnoise
_popt, _pcov = sp_curve_fit(_gauss, _cx, _cy, p0=[1.0, 0.0, 1.0, 0.0], maxfev=20000)
CURVE_FIT = {
    "model": "a*exp(-0.5*((x-mu)/sigma)**2) + c",
    "x": _plain(_cx),
    "y": _plain(_cy),
    "p0": [1.0, 0.0, 1.0, 0.0],
    "truth": _plain(_ctruth),
    "noise_sigma": _cnoise,
    "popt": _plain(_popt),
    "perr": _plain(np.sqrt(np.diag(_pcov))),
    "sse": _plain(float(np.sum((_cy - _gauss(_cx, *_popt)) ** 2))),
}


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_numerics.py 生成——numpy/scipy 真跑一遍。"
                 "输入与答案一起录：TS 复现不了 PCG64，「同一批输入」只能靠录下来。",
        "_seed": SEED,
        "versions": {
            "numpy": np.__version__,
            "scipy": __import__("scipy").__version__,
            "skimage": __import__("skimage").__version__,
        },
        "stats": STATS,
        "histogram": HISTOGRAM,
        "gauss1d": GAUSS1D,
        "gauss2d": GAUSS2D,
        "laplace": LAPLACE,
        "plane": PLANE,
        "poly2d": POLY2D,
        "ransac": RANSAC,
        "fft1d": FFT1D,
        "fft2d": FFT2D,
        "xcorr": XCORR,
        "label": LABEL,
        "ssim": SSIM,
        "npy": NPY,
        "curve_fit": CURVE_FIT,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False) + "\n"
    OUT.write_bytes(text.encode("utf-8").replace(b"\r\n", b"\n"))
    kb = len(text.encode("utf-8")) / 1024
    print(f"✓ {OUT.relative_to(REPO)}：{len(doc) - 3} 节 · {kb:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
