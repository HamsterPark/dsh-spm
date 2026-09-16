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


# ──────────────────────────────────────────────────────────────────────────
# 8. 灰度形态学：erosion / dilation / opening / closing
# ──────────────────────────────────────────────────────────────────────────
#
# **平结构元的形态学没有算术**：输出的每一个数都是输入里的某一个数原样搬过来
# （最小/最大），中间一次乘加都没有。所以容差是 **0** —— 给它一个容差，
# 等于把一次真的挑错了元素藏起来。
#
# 录两种结构元：矩形（`size=(h,w)`）与十字（`footprint`）。十字那一种是
# `Destripe_MorphOpen` 真正要的形状（沿一条轴开运算去条纹）。
#
# 偶数尺寸也录一格：scipy 的原点约定是 `size//2`，而「偶数时偏向哪一边」
# 是**语义**，猜错了整张图平移一个像素而看起来完全正常。

MORPH_MODES = ["reflect", "nearest", "constant"]
_mimg = rng.standard_normal((14, 11))
_cross3 = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)
_cross5 = np.zeros((5, 5), dtype=bool)
_cross5[2, :] = True
_cross5[:, 2] = True

MORPHOLOGY: dict[str, Any] = {"input": _plain(_mimg), "cases": []}
for _size in [(3, 3), (5, 3), (4, 4)]:
    for _mode in MORPH_MODES:
        MORPHOLOGY["cases"].append({
            "kind": "rect", "size": list(_size), "mode": _mode,
            "erosion": _plain(ndi.grey_erosion(_mimg, size=_size, mode=_mode)),
            "dilation": _plain(ndi.grey_dilation(_mimg, size=_size, mode=_mode)),
            "opening": _plain(ndi.grey_opening(_mimg, size=_size, mode=_mode)),
            "closing": _plain(ndi.grey_closing(_mimg, size=_size, mode=_mode)),
        })
for _name, _fp in [("cross3", _cross3), ("cross5", _cross5)]:
    for _mode in MORPH_MODES:
        MORPHOLOGY["cases"].append({
            "kind": _name, "footprint": _plain(_fp.astype(int)), "mode": _mode,
            "erosion": _plain(ndi.grey_erosion(_mimg, footprint=_fp, mode=_mode)),
            "dilation": _plain(ndi.grey_dilation(_mimg, footprint=_fp, mode=_mode)),
            "opening": _plain(ndi.grey_opening(_mimg, footprint=_fp, mode=_mode)),
            "closing": _plain(ndi.grey_closing(_mimg, footprint=_fp, mode=_mode)),
        })

# ──────────────────────────────────────────────────────────────────────────
# 9. 插值 / 重采样：map_coordinates 与 shift
# ──────────────────────────────────────────────────────────────────────────
#
# ⚠️ **order >= 2 时 scipy 先做一次 spline 预滤波**（`spline_filter`，一条 IIR）。
# 不复现它的话结果差得**不大不小**，看起来像「插值精度不同」而不像 bug。
# 这一段只做 order 0/1，而 order=3 那一格**也录** —— 录下来是为了让
# 「我们不支持它」这件事有据可查，而不是等哪天有人以为我们支持。
#
# `shift` 的符号：`ndi.shift(a, s)` 给的是 `out[i] = a[i - s]`，也就是把内容
# **往 +s 方向搬**。一次写反不报错，只让图往反方向动 —— 同 D-NUM-3 那条。

_iimg = rng.standard_normal((12, 10))
# 坐标故意挑：整数点、半像素、边界外（每种 mode 在界外的行为不一样）
_coords = np.array([
    [0.0, 3.0, 5.5, 11.0, -1.5, 13.2, 6.25],
    [0.0, 4.0, 2.5, 9.0, -0.5, 4.0, 10.75],
])
INTERP: dict[str, Any] = {
    "input": _plain(_iimg),
    "coords": _plain(_coords),
    "map_coordinates": [],
    "shift": [],
}
for _order in [0, 1, 3]:
    for _mode in ["reflect", "nearest", "constant", "mirror", "wrap"]:
        INTERP["map_coordinates"].append({
            "order": _order, "mode": _mode, "cval": 0.0,
            "output": _plain(ndi.map_coordinates(
                _iimg, _coords, order=_order, mode=_mode, cval=0.0)),
        })
for _order in [0, 1, 3]:
    for _dy, _dx in [(1.0, -2.0), (0.5, 0.25), (-1.75, 3.5)]:
        INTERP["shift"].append({
            "order": _order, "shift": [_dy, _dx], "mode": "constant", "cval": 0.0,
            "output": _plain(ndi.shift(
                _iimg, (_dy, _dx), order=_order, mode="constant", cval=0.0)),
            "_note": "out[i] = a[i - s]：内容往 +s 方向搬",
        })

# ── 9b. 边界与取整的**判别性**探针 ──────────────────────────────────────────
#
# 上面那七个坐标分辨不出两件事，而这两件恰恰是最容易猜错的：
#
#   ① `constant` 模式下「多远算界外」—— 是 `x < 0` 还是 `x < -0.5`？
#      差半个像素，而症状是图的最外一圈莫名其妙变成 cval。
#   ② `order=0` 在正好 `x.5` 上往哪边取整 —— 四舍五入还是就近偶数？
#      差一个像素，而一张平移了一个像素的图看起来完全正常。
#
# 判据要由**能分辨的输入**保证，不能由碰巧落在中间的输入保证。

_edge_rows = np.array([
    -0.6, -0.5, -0.4, -0.001, 0.0, 0.001,
    11.0, 11.001, 11.4, 11.5, 11.6,
])
_edge_cols = np.full_like(_edge_rows, 5.0)
INTERP["edge_probe"] = {
    "coords": _plain(np.stack([_edge_rows, _edge_cols])),
    "rows": 12,
    "_note": "行坐标骑在 [0, rows-1] 两端上；列固定在中间，好让唯一的变量是行",
    "cases": [
        {
            "order": _o, "mode": _m, "cval": -99.0,
            "output": _plain(ndi.map_coordinates(
                _iimg, np.stack([_edge_rows, _edge_cols]),
                order=_o, mode=_m, cval=-99.0)),
        }
        for _o in [0, 1]
        for _m in ["constant", "nearest", "reflect", "mirror", "wrap"]
    ],
}

# order=0 的取整：整半点各来一个
_half_rows = np.array([0.5, 1.5, 2.5, 3.5, 4.5, -0.5 + 1e-12, 2.4999999999])
_half_cols = np.full_like(_half_rows, 3.0)
INTERP["round_probe"] = {
    "coords": _plain(np.stack([_half_rows, _half_cols])),
    "output_order0": _plain(ndi.map_coordinates(
        _iimg, np.stack([_half_rows, _half_cols]), order=0, mode="nearest")),
    "_note": "x.5 往哪边去：四舍五入 / 就近偶数 / 向下 —— 三者在这七个点上互不相同",
}

# ──────────────────────────────────────────────────────────────────────────
# 10. 亚像素相位互相关（upsample_factor > 1）
# ──────────────────────────────────────────────────────────────────────────
#
# 返回值是 `round(整数峰*uf)/uf + (上采样窗里的整数峰 − dftshift)/uf` ——
# **一个分母为 uf 的有理数**，所以它与 skimage 应当逐位相同，
# 而唯一可能分岔的是「上采样窗里哪一格赢了 argmax」。
#
# 所以这里既录**整像素位移**（答案必然干净）也录**真·亚像素位移**
# （用插值把图挪半个像素，答案不再是整数）。

SUBPIXEL: dict[str, Any] = {"cases": []}
_sbase = rng.standard_normal((32, 32))
for _dy, _dx in [(3, 5), (-2, 7)]:
    _moved = np.roll(np.roll(_sbase, _dy, axis=0), _dx, axis=1)
    for _uf in [2, 4, 10]:
        _sh, _e, _p = phase_cross_correlation(_sbase, _moved, upsample_factor=_uf)
        SUBPIXEL["cases"].append({
            "kind": "integer_roll", "applied_roll": [_dy, _dx], "upsample_factor": _uf,
            "reference": _plain(_sbase), "moving": _plain(_moved), "shift": _plain(_sh),
        })
for _dy, _dx in [(2.5, -1.25), (-0.5, 3.75)]:
    _moved = ndi.shift(_sbase, (_dy, _dx), order=1, mode="wrap")
    for _uf in [4, 10]:
        _sh, _e, _p = phase_cross_correlation(_sbase, _moved, upsample_factor=_uf)
        SUBPIXEL["cases"].append({
            "kind": "subpixel_shift", "applied_shift": [_dy, _dx], "upsample_factor": _uf,
            "reference": _plain(_sbase), "moving": _plain(_moved), "shift": _plain(_sh),
            "_note": "插值移过的图不再是原图的重排，峰会略偏 —— 答案由 skimage 定",
        })

# 近乎平坦的一对帧 —— **归一化的分母是 `max(|·|, 100·eps)` 还是 `|·|`，只有这里分得开**。
#
# 两张 16×16 的「几乎常数」帧各带独立的 1e−12 噪声，于是除直流外每个频点的
# 互功率模长约 1e−22，远小于 `100·eps ≈ 2.2e−14`。
# 除以 `|·|` 会把这些纯噪声一律放大成单位模长；除以 `max(|·|, 100·eps)` 则压住它们。
# **两种做法给的峰位不同**，而答案由 skimage 定，不由我们推理定 ——
# 本仓上一版是「模为零才置零」，介于两者之间，是这一格把它逼出来的。
#
# 逼近时看到的就是这种帧：一张平坦的帧该报告「看不出来」，而不是一个随机方向。
_flat_a = 1.0 + 1e-12 * rng.standard_normal((16, 16))
_flat_b = 1.0 + 1e-12 * rng.standard_normal((16, 16))
for _uf in [1, 10]:
    _sh, _e, _p = phase_cross_correlation(_flat_a, _flat_b, upsample_factor=_uf)
    SUBPIXEL["cases"].append({
        "kind": "near_flat", "upsample_factor": _uf,
        "reference": _plain(_flat_a), "moving": _plain(_flat_b), "shift": _plain(_sh),
        "_note": "谱里除直流外全是 1e−22 量级的噪声 —— 归一化的分母在这里才看得出来",
    })


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
        "morphology": MORPHOLOGY,
        "interp": INTERP,
        "subpixel": SUBPIXEL,
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
