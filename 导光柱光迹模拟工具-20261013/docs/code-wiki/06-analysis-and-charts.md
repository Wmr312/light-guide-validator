# 06 · 指标口径、图表与报告

本文解释「数字是怎么算出来的」，以及 `charts.js` 提供的绘制原语。所有辐照度均为**出射端面上的相对分布**（归一化前后不影响均匀度）；工程判定使用相对指标，避免绝对光通量标定的不确定性。

## 1. 指标口径

### 1.1 能量账本

来自 `RayTracer.simulate()` 的 `ledger`：

| 项 | 含义 |
| --- | --- |
| `output` | 从出射面成功折射离开的能量 |
| `side` | 从侧面折射漏出的能量 |
| `absorbed` | 介质吸收（Beer-Lambert + 体散射路径） |
| `residual` | 达到反弹上限 / 数值泄漏的剩余能量 |

```js
util = output / (output + side + absorbed + residual)
```

- 单导光柱：`util` 即「进光利用率」；结论按 0.30 / 0.18 分级（见 §4）；
- 多导光柱：`analysis.engStats` 会按各柱出射能量加权，报告里注明是「相对利用率」。

### 1.2 均匀度

有两套口径，**用途不同，不要混用**：

| 口径 | 实现 | 特点 |
| --- | --- | --- |
| 引擎 `agg.metrics` | `raytracer.js` 的块聚合 | 与仿真一次性返回；块数 `6–16`，边缘腐蚀 1 块 |
| 图表 `Charts.computeMetrics` | `charts.js` | 与热图渲染同源；掩膜阈值 5% 峰值；块约 3 个细格 |
| 光斑 `spot.computeMetrics` | `spot.js` | 端面圆内（命中半径 ×0.97），**不设亮度阈值** |

`uniformity = min / avg`（块照度），`passRatio` 为 `E ≥ threshold·avg` 的块占比，默认 `threshold = 0.8`。

> 光斑页刻意不设亮度门槛：端面圆内的暗区（未被光线覆盖的边缘带）必须计入，否则最小值被门槛钳住，均匀度会恒等于「门槛/均值」而失去意义。

> 为什么需要块聚合：蒙特卡洛单格期望命中数低，逐格 `min/avg` 会被采样噪声主导；先聚合成约 0.3mm 的块，再统计，结果才可复现。

### 1.3 D86 光斑直径

- 以**屏心**（出射面中心）为圆心，按环带累加能量；
- `r86` 为累计达到总能量 86% 的环带半径；
- `D86 = 2 · r86`（mm）；
- 同时给出 FWHM 半径 `rFwhm`（从峰值环带向外/向内找半高）；
- 径向曲线用环带能量除以环带面积，避免单像素噪声。

### 1.4 色差

多波长时：

1. 对每个波长统计能量质心 `(u, v)`、均方根半径 `req` 与能量占比；
2. 取最长波与最短波：
   - `axial = |req_hi − req_lo|`（轴向/径向色差）；
   - `lateral = |centroid_hi − centroid_lo|`（横向色差）；
3. 同时给出各波长的相对峰值与质心；
4. 结果在光斑页以「轴向 Δr / 横向 Δ」展示，**不参与自动通过判定**，需工程师结合产品公差判断。

### 1.5 配光角

- 出射/侧漏方向与输出面法线的夹角；
- 以 `angleBinDeg`（默认 2°）分箱；
- `Charts.drawPolar` 只画 0–90°，并在达到峰值 50% 的角度处标注半强角（若可解析）。

### 1.6 轴向侧漏

- 仅统计 `sideHits`；
- 按包围盒最长轴分箱（引擎默认 `axisBins = 64`，UI 可覆盖）；
- 用于判断「光是否在近端漏光」以及微齿分布是否均匀。

## 2. `LG.Charts` API

所有函数都是**同步绘制**，接受已挂到 DOM 的 `<canvas>`，内部按 `devicePixelRatio` 设置实际像素并缩放坐标。

### 2.1 工具

| API | 说明 |
| --- | --- |
| `setup(canvas)` | 统一 DPR 适配，返回 `{ctx, w, h}`（CSS 像素尺寸） |
| `jet(t)` | 返回 `[r,g,b]`，`t ∈ [0,1]` |
| `jetRGB(t)` | 返回 `'rgb(r,g,b)'` |

### 2.2 `computeMetrics(heat, threshold)`

输入引擎/光斑的 `heatmap {res, cells, counts}`，输出：

```js
{
  n,          // 有效细格数
  nCore,      // 核心块数
  avg, min, max,       // 细格口径
  avgBlk, minBlk,      // 块口径
  cv,         // 块标准差/块均值
  uniformity, // minBlk/avgBlk
  passRatio   // E ≥ threshold·avgBlk 的块占比
}
```

实现步骤：细格包围盒 → 块聚合（`nb = clamp(min(w,h)/3, 6, 16)`）→ 照度掩膜（≥5% 峰值）→ 边缘腐蚀 → 统计。空数据返回全 0。

### 2.3 `drawHeatmap(canvas, heat, metrics)`

- 伪彩热图 + 色标条；
- **均值带状高亮**：对处于 `0.85·avg ~ 1.15·avg` 的单元，在边界画白色半透明描边，直观标出「均匀区」；
- 无数据单元跳过；
- 坐标以 mm 标注（依赖 `heat.u0/u1/v0/v1` 与 `metrics`）；
- 返回绘图尺寸信息，便于页面做 hover 坐标反查。

### 2.4 `drawLineChart(canvas, values, opts)`

折线 + 均值 ±15% 绿色目标带 + 网格 + 极值标记。

| `opts` | 说明 |
| --- | --- |
| `min` / `max` | x 轴范围（缺省 0..n-1） |
| `xLabel` / `yLabel` | 轴标题 |

返回 `{avg, peaks, valleys}`。极值标记是默认行为，没有开关。

### 2.5 `drawPolar(canvas, angle)`

极坐标配光曲线，0° 向上、顺时针；返回 `{beamAngle}`（半功率角，即光强降到峰值 50% 的角度）。数据为 `{binDeg, bins, values}`，与 `agg.angle` 一致。

### 2.6 `drawSpotCloud(canvas, spot, opts)`

光斑 2D 伪彩/真彩渲染：

- 输入必须有 `{res, half, E, Emax}`（可由 `project()` 的 `Etot/Emax` 构造，或 `disp` 的 `Etot`）；
- `opts.mode === 'color'` + `opts.rgbCells` 时按真彩逐像素输出，否则 `jet(E/Emax)` 伪彩；
- `opts.unit` 仅用于色标单位文字；
- 返回 `{ox, oy, size, res, half}`，用于 hover 反查 mm 坐标。

> 页面通常传 64×64 的 `Etot` 进行显示；3D 截面才使用 256 的 `disp`。

### 2.7 `drawRadial(canvas, radial, opts)`

径向辐照度曲线：

- 输入 `radial = {r:[], e:[], r86, rFwhm}`；
- 绿色区域标出 `0 ~ r86`（D86 内区）并标注半径；
- 返回 `{peak, r86, rFwhm}`。

### 2.8 `drawHistogram(canvas, hist, opts)`

照度分布直方图，返回 `{peakCount, mean}`。

## 3. 光斑投影的物理口径（`spot.project`）

```
输入：outputHits（世界坐标，含出射点 p 与出射方向 dExit）、出射面中心/法向/尺寸、总光通量 flux、numRays
1. 以出射面法线为 on，构造 (uv, vv, on) 正交基
2. 每条光线沿 dExit 传播到距端面 d 的探测屏：u = (p-center)·uv + d·(dExit·uv)/(dExit·on)，v 同理
   （d=0 即端面本身；3D 截面可把屏外移）
3. 视野：half = max(p98·1.12, 端面半宽 faceHalf)，保证窄光束也能看到整个端面
4. 每光线功率 perRayW = flux / 683 / numRays   // 光通量 → 辐射通量近似
5. 高斯 PSF：σ = 2.4 × (视野宽/64) × clamp(√(2000/N), 1, 3)
   低样本（快速模式）自动展宽，高样本收敛到同一物理核宽
6. 双线性高斯溅射到指标网格（64）与显示网格（256），核权重归一 → 能量严格守恒
7. 能量记账：
     Ptot/Etot  端面范围内的功率与辐照度
     outside    落在端面外的功率（outsidePow）
     clipPow    核被视野裁剪的部分
     conserve   |网格功率 + outside + clip − 期望功率| / 期望功率
8. 多波长：按 λ 分别溅射，记录 Ptot/Plam、质心与均方根半径
9. CIE：由各 λ 能量加权 XYZ → sRGB，用于真彩显示
```

**指标网格 vs 显示网格**：

- `project(spot, d, res)` 的 `res` 控制指标网格（默认 64）；
- 显示网格固定 256，仅用于绘制；
- 两者使用同一 `sigmaMM`（物理宽度），因此视觉与数字一致。

## 4. 工程结论生成 `analysis.buildConclusion(d, st, proj, tr)`

输入：

- `d`：本次结果（`ledger`、`agg`、`tolerance`、`params`）；
- `st`：`engStats(d, m, proj)` 的返回值 `{util, outLm, m, flux}`；
- `proj`：项目（读取 `eng.targets`、`scheme`、`beads`）；
- `tr`：翻译函数（界面用 `LG.t`，报告用 `LG.I18N.tFor(lang)`）。

输出：**一段 HTML 字符串**（`verdict-card`），包含：

```html
<div class="verdict-card verdict-ok|warn|bad">
  <div class="verdict-badge">优/良/需关注</div>
  <div class="verdict-items">
    <span class="vi vi-ok">✓ ...</span>
    <span class="vi vi-warn">⚠ ...</span>
  </div>
  <div class="verdict-advice">...</div>
</div>
```

逐项判定（仅当 `eng.targets` 对应布尔项为真时输出）：

1. 进光利用率（30% / 18%）；
2. 均匀度（0.70 / 0.50）；
3. 多导光柱漏光（5% / 15%）；
4. 公差衰减（≤30%）；
5. 折弯损耗（bent 方案提示）；
6. 串扰（多灯珠提示）；
7. 拔模角（≥1°）。

报告与页面共用该函数，保证「页面看到的结论」和「导出的报告」一致。

## 5. 报告中的图表

`report.js` 在隐藏容器里创建 `<canvas>`，调用 `LG.Charts` 绘制后转成 `dataURL` 内嵌：

| 图 | 生成方式 |
| --- | --- |
| 光斑（最新记录） | `spot.capture(canvas)` 投影 `lastRun` 并画 256 显示网格 |
| 热图 | `Charts.drawHeatmap(canvas, rec.agg.heatmap)` |
| 轴向分布 | `Charts.drawLineChart(canvas, rec.agg.axis.values, {min,max,...})` |
| 配光曲线 | `Charts.drawPolar(canvas, rec.agg.angle)` |
| 3D 截图 | 勾选「附带截图」时 `Viewer.screenshot()` |
| 公差 | 以表格形式输出 `rec.tolerance[]`，不画折线 |

报告是**单页自包含 HTML**：内联 CSS、内联图片数据，无脚本依赖，可直接邮件发送或用浏览器打印为 PDF。

## 6. 一致性检查清单（改动指标时）

1. 若修改引擎 `aggregate.metrics` 的块聚合规则，同步检查 `Charts.computeMetrics` 是否仍匹配；
2. 若修改 `spot.project` 的 p98 视野或 σ，报告中的 D86/均匀度会整体漂移，需要回归对比历史记录；
3. 若修改 `ledger` 字段，必须同步 `analysis.engStats`、`spot.renderSourceInfo`、`report.dfmVerdict`；
4. 多波长权重之和必须为 1（`source.spectrum` 归一化在 `simulate.js` 中完成）；
5. 任何新指标都应同时出现在「分析页指标卡」与「报告表格」，否则用户会认为数据丢失。
