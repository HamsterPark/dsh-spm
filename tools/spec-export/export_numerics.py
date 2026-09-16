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
from scipy.signal import correlate2d, find_peaks, savgol_coeffs, savgol_filter
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
        # error / phase 是 skimage 同一次调用回的另外两个数。**它们的容差不一样**：
        # phase 是辐角（绝对、弧度），error 是一个相消之后开的方 —— 判据只能写在
        # error² 上。详见 TS 那侧 `fft.ts` 的抬头。
        "error": _plain(float(_err)),
        "error_sq": _plain(float(_err) ** 2),
        "phase": _plain(float(_pd)),
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
_perr = np.sqrt(np.diag(_pcov))
_n_pts, _n_par = int(_cx.size), len(_ctruth)
CURVE_FIT = {
    "model": "a*exp(-0.5*((x-mu)/sigma)**2) + c",
    "x": _plain(_cx),
    "y": _plain(_cy),
    "p0": [1.0, 0.0, 1.0, 0.0],
    "truth": _plain(_ctruth),
    "noise_sigma": _cnoise,
    "popt": _plain(_popt),
    "perr": _plain(_perr),
    "sse": _plain(float(np.sum((_cy - _gauss(_cx, *_popt)) ** 2))),
    # ── pcov：`curve_fit` 的第二个返回值，`absolute_sigma=False` ⇒ 已经乘过 sse/(n−p) ──
    "pcov": _plain(_pcov),
    "n_points": _n_pts,
    "n_params": _n_par,
    # 容差要用的那个量：**参数自己的相对不确定度里最大的那个**。
    # TS 那侧的 `pcovRelTol(rel_step)` 由它算出来 —— 一条可验算的容差，不是一句声明。
    "rel_step": _plain(float(np.max(_perr / np.abs(_popt)))),
    # **把「写错的那一版」也录下来**：分母写成 n 而不是 n−p 是这一件最容易犯的错，
    # 而它给出的是一组完全合理的误差棒。判据因此可以写成「离对的近、离错的远」
    # （同 RANSAC 那条），不依赖任何容差。
    "perr_if_dof_were_n": _plain(_perr * np.sqrt((_n_pts - _n_par) / _n_pts)),
    "_note": "pcov = (JᵀJ)⁻¹·sse/(n−p)；perr = sqrt(diag(pcov))",
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
            "error": _plain(float(_e)), "error_sq": _plain(float(_e) ** 2),
            "phase": _plain(float(_p)),
        })
for _dy, _dx in [(2.5, -1.25), (-0.5, 3.75)]:
    _moved = ndi.shift(_sbase, (_dy, _dx), order=1, mode="wrap")
    for _uf in [4, 10]:
        _sh, _e, _p = phase_cross_correlation(_sbase, _moved, upsample_factor=_uf)
        SUBPIXEL["cases"].append({
            "kind": "subpixel_shift", "applied_shift": [_dy, _dx], "upsample_factor": _uf,
            "reference": _plain(_sbase), "moving": _plain(_moved), "shift": _plain(_sh),
            "error": _plain(float(_e)), "error_sq": _plain(float(_e) ** 2),
            "phase": _plain(float(_p)),
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
        "error": _plain(float(_e)), "error_sq": _plain(float(_e) ** 2),
        "phase": _plain(float(_p)),
        "_note": "谱里除直流外全是 1e−22 量级的噪声 —— 归一化的分母在这里才看得出来",
    })


# ──────────────────────────────────────────────────────────────────────────
# 11. `find_peaks`（prominence / distance / width）
# ──────────────────────────────────────────────────────────────────────────
#
# **这一族的容差几乎全是 0**：峰是下标（整数），prominence 是
# `x[peak] − max(left_min, right_min)` —— 两个操作数都是输入数组里的元素原样，
# 中间只有一次减法。于是这里录的每一个数都要逐位对上。
#
# 输入**全部是确定式造的**（没有一次 rng 调用）：这一节要钉的是语义，
# 而语义要由**能分辨的输入**保证 —— 随机数只会给出一组看着挺全、其实什么都分不出的峰。
#
# 旧仓五处真调用传的参数：prominence(5/5) · distance(3/5) · width=0(1/5)。只录这三个。

PEAKS: dict[str, Any] = {"cases": []}


def _peak_case(label: str, y, note: str, **kw) -> None:
    y = np.asarray(y, dtype=np.float64)
    idx, props = find_peaks(y, **kw)
    PEAKS["cases"].append({
        "label": label,
        "input": _plain(y),
        "args": {k: _plain(v) for k, v in kw.items()},
        "peaks": _plain(idx),
        "prominences": _plain(props.get("prominences")) if "prominences" in props else None,
        "left_bases": _plain(props.get("left_bases")) if "left_bases" in props else None,
        "right_bases": _plain(props.get("right_bases")) if "right_bases" in props else None,
        "widths": _plain(props.get("widths")) if "widths" in props else None,
        "width_heights": _plain(props.get("width_heights")) if "width_heights" in props else None,
        "left_ips": _plain(props.get("left_ips")) if "left_ips" in props else None,
        "right_ips": _plain(props.get("right_ips")) if "right_ips" in props else None,
        "_note": note,
    })


# ── ① 筛选顺序：distance **在** prominence 之前 ──
# 下标 3 那个峰又高又**不突出**（prom = 0.1）。distance 先筛 ⇒ 它先把下标 1 挤掉，
# 然后自己被 prominence 筛掉，只剩 [8]；prominence 先筛 ⇒ 它先没了，于是 [1, 8] 都留下。
# **别的输入分不出这两种顺序。**
_order_x = [0.0, 5.0, 0.0, 9.9, 9.8, 9.8, 9.8, 9.8, 10.0, 0.0]
_peak_case("order_probe_both", _order_x, "scipy 的顺序 ⇒ [8]；prominence 先筛 ⇒ [1, 8]",
           prominence=1.0, distance=3)
_peak_case("order_probe_prom_only", _order_x, "同一条信号，只筛 prominence", prominence=1.0)
_peak_case("order_probe_dist_only", _order_x, "同一条信号，只筛 distance", distance=3)

# ── ② 平台峰取中点向下取整；紧贴数组末尾的极大值**不算峰** ──
_peak_case("plateau", [0.0, 1.0, 2.0, 2.0, 2.0, 1.0, 0.0, 3.0, 3.0, 0.0, 5.0],
           "平台 [2,4] ⇒ 3；平台 [7,8] ⇒ 7（向下取整）；末尾那个 5 不是峰")
_peak_case("plateau_even", [0.0, 1.0, 1.0, 1.0, 1.0, 0.0],
           "四格宽的平台 ⇒ 2（偏左）。向上取整会给 3")

# ── ③ prominence 取两侧最小值的 **max** 不是 min ──
# 下标 3：左侧走到 0.5 停（x[1]=1 更高），右侧走到 0.2 停（x[5]=3 更高）。
# max ⇒ 0.9−0.5 = 0.4；min ⇒ 0.9−0.2 = 0.7。**两个都是合理的数。**
_peak_case("prominence_side", [0.0, 1.0, 0.5, 0.9, 0.2, 3.0, 0.0],
           "肩上的小凸起：max(left,right) ⇒ 0.4，min ⇒ 0.7", prominence=0.0)

# ── ④ `_band_peak` 的形状：径向功率谱里挑周期 ──
# 三个真峰（两个原子级、一个 moiré）叠在一条缓慢下降的基线上，外加一个只有基线一半
# 高度的小包（它该被 prominence 筛掉）。`_band_peak` 用的阈值就是 `median(prof)*0.5`。
_bb = np.arange(160.0)
_band = (
    6.0 * np.exp(-0.5 * ((_bb - 24.0) / 3.0) ** 2)
    + 2.2 * np.exp(-0.5 * ((_bb - 63.0) / 4.5) ** 2)
    + 9.0 * np.exp(-0.5 * ((_bb - 118.0) / 2.5) ** 2)
    + 0.30 * np.exp(-0.5 * ((_bb - 90.0) / 6.0) ** 2)
    + 1.6 * np.exp(-_bb / 70.0)
    + 0.15
)
_band_prom = float(np.median(_band) * 0.5)
_peak_case("band_peak", _band, "旧仓 seg_scale_adaptive._band_peak 的形状（阈值 = median·0.5）",
           prominence=_band_prom)

# ── ⑤ `_hist_modes` 的形状：高度直方图里挑台阶 ──
# 四个台阶 + 一个**贴着主峰**的卫星（离它 8 格 < distance=12）。前后各补一个 0
# —— 那是旧仓 `np.concatenate([[0.0], cnt, [0.0]])` 那一行，为的是让**贴着直方图
# 两端**的台阶也能算成峰（scipy 不认边界极大值）。
#
# 这一格**两个条件各自都在干活**：只筛 prominence ⇒ [41 106 114 181 251]，
# 加上 distance ⇒ 卫星 114 被主峰 106 挤掉。同一条信号三种筛法都录。
_hb = np.arange(256.0)
_hist = (
    900.0 * np.exp(-0.5 * ((_hb - 40.0) / 6.0) ** 2)
    + 640.0 * np.exp(-0.5 * ((_hb - 105.0) / 4.0) ** 2)
    + 300.0 * np.exp(-0.5 * ((_hb - 114.0) / 2.0) ** 2)
    + 420.0 * np.exp(-0.5 * ((_hb - 180.0) / 9.0) ** 2)
    + 250.0 * np.exp(-0.5 * ((_hb - 250.0) / 5.0) ** 2)
    + 8.0
)
_hist_padded = np.concatenate([[0.0], _hist, [0.0]])
_hist_prom = float(_hist.max() * 0.04)
_peak_case("hist_modes", _hist_padded,
           "旧仓 seg_scale_adaptive._hist_modes：补零两端 + prominence + distance",
           prominence=_hist_prom, distance=12)
_peak_case("hist_modes_no_distance", _hist_padded,
           "同一条信号不筛 distance ⇒ 卫星峰 114 留下来了",
           prominence=_hist_prom)

# ── ⑥ `width=0`：只要 widths 这个属性，不筛 ──
# 三个宽度差很多的峰，坐在一条非零基线上 —— 半高是**相对 prominence** 的半高，
# 不是绝对半高，而只有非零基线分得开这两种。
_wb = np.arange(120.0)
_wsig = (
    4.0 * np.exp(-0.5 * ((_wb - 20.0) / 2.0) ** 2)
    + 3.0 * np.exp(-0.5 * ((_wb - 60.0) / 8.0) ** 2)
    + 5.0 * np.exp(-0.5 * ((_wb - 95.0) / 4.0) ** 2)
    + 1.75
)
_peak_case("widths", _wsig, "width=0 ⇒ 不筛，只把 widths 一族算出来（半高是相对 prominence 的）",
           prominence=0.5, width=0)

# ──────────────────────────────────────────────────────────────────────────
# 12. `scipy.signal.correlate2d(mode='same')` 与 `numpy.hanning`
# ──────────────────────────────────────────────────────────────────────────
#
# ⚠️ **`correlate2d(mode='same')` 的原点是 `(Mb−1)//2`，而 `ndi.grey_*` 的是 `Mb//2`。**
# 两个都是 scipy、两个都叫「中心」，偶数尺寸时差一格。所以这里**必须**录偶数核
# （2×2 与 4×4）—— 奇数核上两种猜法完全同解。
#
# 头几格是**小整数**输入：乘积与部分和都在 2⁵³ 以内 ⇒ 浮点加法在整数上是精确的
# ⇒ 与 scipy **逐位相同**，容差 0。那一档才是真正在测「对齐对不对」的那一档。

_ci = np.array([
    [1.0, 2.0, 3.0, 4.0, 5.0],
    [6.0, 7.0, 8.0, 9.0, 10.0],
    [11.0, 12.0, 13.0, 14.0, 15.0],
    [16.0, 17.0, 18.0, 19.0, 20.0],
    [21.0, 22.0, 23.0, 24.0, 25.0],
    [26.0, 27.0, 28.0, 29.0, 30.0],
])
CORRELATE2D: dict[str, Any] = {"cases": []}
for _lbl, _kern in [
    ("k1x1", np.array([[2.0]])),
    ("k3x3", np.arange(1.0, 10.0).reshape(3, 3)),
    ("k2x2", np.arange(1.0, 5.0).reshape(2, 2)),          # 偶数：原点 (0,0) 不是 (1,1)
    ("k4x4", np.arange(1.0, 17.0).reshape(4, 4)),         # 偶数：原点 (1,1) 不是 (2,2)
    ("k3x5", np.arange(1.0, 16.0).reshape(3, 5)),         # 非方：行列对调当场现形
    ("k4x3", np.arange(1.0, 13.0).reshape(4, 3)),
    ("k6x5_same_shape", _ci * 2.0 - 7.0),                 # 与图同形，消费方就是这一格
]:
    CORRELATE2D["cases"].append({
        "label": _lbl, "exact": True,
        "a": _plain(_ci), "b": _plain(_kern),
        "out": _plain(correlate2d(_ci, _kern, mode="same")),
        "_note": "小整数 ⇒ 逐位相同，容差 0",
    })

# 消费方的真形状：两张 24×20 的帧各自扣掉均值再互相关。这一格有浮点容差。
_cr_a = _img - float(_img.mean())                         # 复用第 2 节那张 24×20
_cr_b = np.roll(np.roll(_img, 2, axis=0), -3, axis=1)
_cr_b = _cr_b - float(_cr_b.mean())
CORRELATE2D["cases"].append({
    "label": "frames_24x20", "exact": False,
    "a": _plain(_cr_a), "b": _plain(_cr_b),
    "out": _plain(correlate2d(_cr_a, _cr_b, mode="same")),
    "_note": "ComputeDriftVector / TrackDrift_ReferenceScan 的形状：两张同形状的帧",
})

# `np.hanning`：1 与 2 两格是**边界**，其余是常用窗长。
# hanning(1) = [1.]（不是 [0.]：M−1 = 0，那个式子除零，numpy 单独判）
# hanning(2) = [0., 0.]（一个把信号乘没的窗，也是对的）
HANNING: dict[str, Any] = {
    "windows": {str(_m): _plain(np.hanning(_m)) for _m in [1, 2, 3, 4, 5, 8, 33, 64]},
    "window2d": {
        "rows": 5, "cols": 4,
        "out": _plain(np.outer(np.hanning(5), np.hanning(4))),
    },
    "_note": "0.5 + 0.5*cos(pi*n/(M-1))，n = 1-M, 3-M, …, M-1",
}

# ──────────────────────────────────────────────────────────────────────────
# 13. 非归一化互相关（`normalization=None`）+ error / phase
# ──────────────────────────────────────────────────────────────────────────
#
# 旧仓 `drift_xcorr` 明确传 `normalization=None`，注释里写明理由：**对 SPM 的行噪声
# 更稳**。相位归一化把每个频点抬成同样的份量，于是一条横贯整帧的噪声脊与真信号
# 一样有投票权。关掉它 = 按功率加权。
#
# **两档在同一对帧上给不同的答案** —— `near_flat` 那一对就是证据（'phase' 报一个
# 纯属虚构的位移，None 报 (0,0)）。一组两档同解的金样证不了这个开关存在。
#
# 另外录一格 `b = −roll(a)`：CCmax 是**负实数** ⇒ phase = ±π。
# 这一格是 phase 唯一的判别性输入 —— 对得上的帧 phase 恒为 0，两种写法（取不取那次
# 共轭）都给 0，分不出来。

XCORR_RAW: dict[str, Any] = {"cases": []}


def _raw_case(label: str, a, b, uf: int, norm, note: str) -> None:
    sh, err, pd = phase_cross_correlation(a, b, upsample_factor=uf, normalization=norm)
    XCORR_RAW["cases"].append({
        "label": label, "upsample_factor": uf, "normalization": norm,
        "reference": _plain(a), "moving": _plain(b),
        "shift": _plain(sh), "error": _plain(float(err)),
        "error_sq": _plain(float(err) ** 2), "phase": _plain(float(pd)),
        "_note": note,
    })


_rb = _sbase                                            # 复用第 10 节那张 32×32
_rm = np.roll(np.roll(_rb, 3, axis=0), 5, axis=1)
for _uf in [1, 10]:
    _raw_case(f"roll_none_uf{_uf}", _rb, _rm, _uf, None, "整像素 roll，不归一化")
    _raw_case(f"neg_none_uf{_uf}", _rb, -_rm, _uf, None, "b = −roll(a) ⇒ CCmax 为负实数 ⇒ phase = ±π")
# 同一对帧，两档给**不同**的位移 —— 这一格就是「归一化可关」这个开关的判据
for _uf in [1, 10]:
    _raw_case(f"near_flat_none_uf{_uf}", _flat_a, _flat_b, _uf, None,
              "几乎平坦的一对帧：'phase' 报 (5,5)，None 报 (0,0)")
# 窗 + 扣直流 + 不归一化：旧仓 `_prepare_for_registration` → `drift_xcorr` 的整条路
_win = np.outer(np.hanning(32), np.hanning(32))
_wa = (_rb - _rb.mean()) * _win
_wm = (_rm - _rm.mean()) * _win
_raw_case("windowed_none_uf10", _wa, _wm, 10, None, "汉宁窗 + 扣直流 + normalization=None")
# 只有一行：那条轴上的位移没有意义，skimage 置 0。
# **uf=1 那一格分不出来**（一行的 argmax 恒在第 0 行，本来就是 0）；
# 要 uf=10 才照得出：不置 0 的话上采样那一步会在退化轴上给出 −dftshift/uf = −0.7。
_row_a = _rb[:1, :]
_row_b = np.roll(_row_a, 4, axis=1)
_raw_case("single_row_uf1", _row_a, _row_b, 1, None, "1×32：uf=1 时两种写法同解")
_raw_case("single_row_uf10", _row_a, _row_b, 10, None,
          "1×32 @ uf=10：置 0 ⇒ 0，不置 ⇒ −0.7。**只有这一格分得开**")


# ──────────────────────────────────────────────────────────────────────────
# 14. Savitzky–Golay（`savgol_filter`，deriv=0 / mode='interp' / 奇数窗）
# ──────────────────────────────────────────────────────────────────────────
#
# `mode='interp'` 把这个滤波拆成**三段不同的算法**，而只有中间那段是「卷积」：
#
#   系数      `savgol_coeffs` 解一个**欠定**方程 A c = y ⇒ **最小范数**解
#   中间      那串系数与信号的一次 w 抽头相关（`convolve1d(..., mode='constant')`）
#   两端各 w//2 个点   **完全不经过那串系数** —— 对最外 w 个样本 `polyfit` 再求值
#
# 两端那一段最容易被当成「边界模式」糊过去。一条谱的最外几个点正是
# 「有没有能隙」要看的地方，所以这里**专门录一条两端有结构的信号**。
#
# 两个条件数一起录（`cond(A·Aᵀ)` 与 `cond(缩放后的 Vandermonde)`），
# 于是 TS 那侧的容差是可验算的，不是一句声明。

SAVGOL: dict[str, Any] = {"cases": []}
_sg_t = np.linspace(-1.0, 1.0, 201)
# 两个洛伦兹峰 + 一条斜基线 + 一段确定式的「噪声」（正弦叠加，不是 rng ——
# 这一节要钉的是三段拼接，输入必须原样可重放）
_sg_y = (
    1.0 / (1.0 + ((_sg_t + 0.35) / 0.05) ** 2)
    + 0.6 / (1.0 + ((_sg_t - 0.42) / 0.08) ** 2)
    + 0.30 * _sg_t
    + 0.9
    + 0.02 * np.sin(37.0 * _sg_t)
    + 0.01 * np.sin(91.0 * _sg_t + 1.0)
)
for _w, _po in [(5, 2), (9, 3), (15, 3), (25, 3), (31, 5)]:
    _A = np.arange(_w - 1 - (_w >> 1), -(_w >> 1) - 1, -1.0)[None, :] ** np.arange(_po + 1)[:, None]
    # **行**缩放：A 的第 k 行是 x^k，w=25 时第 0 行全是 1、第 3 行到 1728。
    # 除以各自的 2-范数**不动那个约束集**（最小范数解一模一样），只把 κ 从 1.2e6
    # 压到 23 —— 于是 TS 那侧的容差才可能是一条在测东西的容差。
    _As = _A / np.sqrt((_A * _A).sum(axis=1))[:, None]
    # 列缩放的 Vandermonde：两端 polyfit 走正规方程 ⇒ **这个 κ 要平方**
    _V = np.vander(np.arange(float(_w)), _po + 1)
    _V = _V / np.sqrt((_V * _V).sum(axis=0))
    SAVGOL["cases"].append({
        "window_length": _w,
        "polyorder": _po,
        # ⚠️ polyorder > 3 **本仓不实现**（重构那一步在高阶上相消，容差推不出来）。
        # 照录是为了证明我们知道它长什么样、并且确实没在复现它 —— 同 D-NUM-11。
        "supported": _po <= 3,
        "coeffs": _plain(savgol_coeffs(_w, _po)),
        "cond_normal": _plain(float(np.linalg.cond(_As @ _As.T))),
        "cond_normal_unscaled": _plain(float(np.linalg.cond(_A @ _A.T))),
        "cond_edge": _plain(float(np.linalg.cond(_V))),
        "input": _plain(_sg_y),
        "output": _plain(savgol_filter(_sg_y, _w, _po)),
        "_note": "deriv=0, mode='interp'（缺省）",
    })

# 两端那 w//2 个点**真的与中间那段不同**：把它们与「一路卷积到底」的结果比一比。
# `mode='constant'` 那一档就是「不做 polyfit」的样子 —— 两者只在两端不同，
# 而那个不同是**肉眼可见**的（补零把最外几个点拉向 0）。
_sg_w = 15
SAVGOL["edge_matters"] = {
    "window_length": _sg_w,
    "polyorder": 3,
    "interp": _plain(savgol_filter(_sg_y, _sg_w, 3, mode="interp")),
    "constant": _plain(savgol_filter(_sg_y, _sg_w, 3, mode="constant")),
    "_note": "两端 w//2 个点：'interp' 用 polyfit 重算，'constant' 补零卷积 —— 差得看得见",
}

# `polyfit` / `polyval` 自己也录一格：它们是 savgol 两端那一步的本体，
# 而旧仓另有几处（`thermal_settle` 的一次线性拟合）会直接用。
_pf_x = np.array([0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0])
_pf_y = np.array([1.2, 2.9, 5.1, 9.8, 17.3, 28.0, 43.1, 63.9])
POLYFIT: dict[str, Any] = {"cases": []}
for _deg in [1, 2, 3]:
    _V = np.vander(_pf_x, _deg + 1)
    _V = _V / np.sqrt((_V * _V).sum(axis=0))
    _c = np.polyfit(_pf_x, _pf_y, _deg)
    POLYFIT["cases"].append({
        "deg": _deg,
        "x": _plain(_pf_x), "y": _plain(_pf_y),
        "coef": _plain(_c),                       # **高次在前**
        "cond": _plain(float(np.linalg.cond(_V))),
        "evaluated": _plain(np.polyval(_c, _pf_x)),
        "_note": "numpy 的 polyfit 先把设计阵每列除以自己的 2-范数再解；系数高次在前",
    })


# ──────────────────────────────────────────────────────────────────────────
# 15. 成对求和（`np.add.reduce`）—— **批 4b 追加，容差 0**
# ──────────────────────────────────────────────────────────────────────────
#
# 这一节不走那条共用的 `rng` 流（输入是闭式的 `sin`），所以它**一个已有节都没动**。
#
# 判据是**逐位**：`sumRelTol(n)` 那条界是在「本仓 Neumaier vs numpy 成对」这个前提
# 下推的，而把 numpy 那一种照着写一遍，两边就是同一串浮点运算。
PAIRWISE: dict = {"_note": "np.sum / np.mean / np.std 对连续一维 float64 的答案；容差 0",
                  "cases": []}
for _n in [0, 1, 3, 7, 8, 9, 17, 100, 127, 128, 129, 300, 1000, 4096]:
    _i = np.arange(_n, dtype=np.float64)
    _a = np.sin(_i * 1.7) * np.exp(_i / 500.0) + 1e-3 * _i
    PAIRWISE["cases"].append({
        "n": _n,
        "x": _plain(_a),
        "sum": _plain(float(np.sum(_a)) if _n else 0.0),
        "mean": _plain(float(np.mean(_a)) if _n else float("nan")),
        "std": _plain(float(np.std(_a)) if _n else float("nan")),
        "std_ddof1": _plain(float(np.std(_a, ddof=1)) if _n > 1 else float("nan")),
    })
# **一格必然分岔的**：朴素顺序累加与成对求和在这一串上给不同的答案，
# 于是「照抄累加顺序」这件事有东西可验（同 D-NUM-1 那条「判据要由构造保证」）。
_KAHAN = np.array([1e16, 1.0, 1.0, -1e16, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0], dtype=np.float64)
PAIRWISE["cases"].append({
    "n": int(_KAHAN.size), "x": _plain(_KAHAN),
    "sum": _plain(float(np.sum(_KAHAN))),
    "mean": _plain(float(np.mean(_KAHAN))),
    "std": _plain(float(np.std(_KAHAN))),
    "std_ddof1": _plain(float(np.std(_KAHAN, ddof=1))),
    "_note": "顺序累加给 8.0，成对求和给 6.0 —— 这一格是「照抄顺序」的钉子",
})
PAIRWISE["naive_vs_pairwise"] = {
    "x": _plain(_KAHAN),
    "naive": _plain(float(np.add.reduce(_KAHAN.tolist()))) if False else _plain(
        float(sum(_KAHAN.tolist()))),
    "pairwise": _plain(float(np.sum(_KAHAN))),
}


# ──────────────────────────────────────────────────────────────────────────
# 16. `numpy.random.default_rng` —— PCG64，**四层各录一遍，容差 0**
# ──────────────────────────────────────────────────────────────────────────
#
# 只比最后一层是不够的：`uniform` 对得上而 `pool` 错了，说明我在两处各犯了一个
# 互相抵消的错，而下一个种子上它们就不抵消了。
PCG64: dict = {"_note": "SeedSequence.pool / generate_state / random_raw / uniform；容差 0",
               "cases": []}
for _seed in [0, 1, 42, 12345, 2 ** 32 - 1, 2 ** 40 + 7]:
    _ss = np.random.SeedSequence(_seed)
    _g = np.random.default_rng(_seed)
    _raw = _g.bit_generator.random_raw(6)
    _g2 = np.random.default_rng(_seed)
    PCG64["cases"].append({
        "seed": int(_seed),
        "pool": [int(x) for x in _ss.pool],
        "state32": [int(x) for x in _ss.generate_state(8, np.uint32)],
        "state64": [str(int(x)) for x in _ss.generate_state(4, np.uint64)],
        "raw": [str(int(x)) for x in _raw],
        "uniform_0_1": _plain([float(_g2.uniform()) for _ in range(6)]),
        "uniform_015_085": _plain([float(np.random.default_rng(_seed).uniform(0.15, 0.85))
                                   for _ in range(1)]),
    })
# `superstructure_test` 真正用的那一串（`seed=0`，`uniform(0.15, 0.85)` 连抽 24 次）。
_g3 = np.random.default_rng(0)
PCG64["superstructure_stream"] = _plain([float(_g3.uniform(0.15, 0.85)) for _ in range(24)])


def main() -> int:
    doc = {
        "_note": "由 tools/spec-export/export_numerics.py 生成——numpy/scipy 真跑一遍。"
                 "输入与答案一起录。**PCG64 从批 4b 起复现得了**（pcg64.ts 逐位），"
                 "所以第 16 节直接比那一串，不再靠录。",
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
        "peaks": PEAKS,
        "correlate2d": CORRELATE2D,
        "hanning": HANNING,
        "xcorr_raw": XCORR_RAW,
        "savgol": SAVGOL,
        "polyfit": POLYFIT,
        "pairwise": PAIRWISE,
        "pcg64": PCG64,
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
