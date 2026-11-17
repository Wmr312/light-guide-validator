# Spec — 彩色辐照度伪彩云图（彩虹环状光斑）光斑分析模块

> 目标：在 light-guide-validator（纯 JS 光线追踪 + Canvas 可视化平台）中新增「光斑分析」功能模块，
> 实现基于物理的光学光斑伪彩云图、沿光轴动态观测、远场指标/色差评估、交互读数与导出。
> 语言：简体中文界面（i18n 同时提供 en）。

---

## 1. 需求映射（用户原始 5 点）

| # | 需求 | 交付 |
|---|------|------|
| 1 | 彩虹环状光斑伪彩图 + 完整色彩渐变 + 按波长呈现辐照度 | `drawSpotCloud`（jet 伪彩 + 色标）+ 真彩合成（按 λ 着色，亮度归一） |
| 2 | 沿光轴距离参数调节，实时渲染形态/能量随距离变化 | 距离 `d` 滑块（0.5–200 mm）→ 虚拟探测屏投影重分箱，仅重算不重跑仿真 |
| 3 | 远场参数（尺寸/发散角/均匀度）+ 色差量化 + 热力图/直方图/径向曲线 | 指标卡 + 色差表 + 径向曲线 `drawRadial` + 直方图 `drawHistogram` |
| 4 | 悬停读数（辐照度 + 波长）、双距离对比、导出图像与报告 | canvas mousemove→(u,v,E,主导 λ)；对比视图；PNG/HTML/JSON 导出 |
| 5 | 辐照度精度 ≥ 1e-6 W/m²、色彩映射符合 CIE 标准色度系统 | 双精度浮点累加 + 能量守恒校验；λ→XYZ→sRGB（Wyman 解析 CMF 拟合） |

## 2. 已确认设计决策（用户此前拍板，不再变更）

1. **完整多波长色散**：引入 n(λ) Cauchy 模型，多波长分别追迹并合成/量化色差。
2. **新建独立页面「光斑分析」**：顶部导航新增，与 模型/仿真/结果分析 并列，路由名 `spot`。
3. **虚拟探测面投影**：复用出射光线 `dExit` 投影到距离 `d` 的虚拟屏重新分箱；距离滑块实时刷新，**不重跑仿真**。

## 3. 项目约束（来自项目记忆，必须遵守）

- 功能修改后**默认不做浏览器验证**（节省 token），由用户 `Ctrl+Shift+R` 强刷自测；仅在用户明确要求时才启动浏览器 agent。
- 所有文案必须与引擎实际实现一致（光源/色散/辐照度口径）。
- 可视化必须带标注与评级解读（目标参考线、合格范围、异常点高亮、通俗建议）。

## 4. 架构与数据流

```
模型配置页(材料 abbe + 光源 spectrum)  ──┐
                                        ▼
仿真引擎 raytracer.js：多波长分配 → 逐光线 n(λ) → 出射面折射 dExit
                                        │
        LG.Engine.run(..., {returnSpot:true, returnSegments:false, visRays:0})
                                        ▼
      payload.hits = [{ p, i, d, dExit, lam }]  + payload.agg.outCenter/outNormal
                                        ▼
                        光斑分析页 spot.js
   距离 d → 投影到虚拟屏 (u,v) → 逐 λ 分箱 → 辐照度网格 E[]
                                        ▼
   jet 伪彩云图 / 真彩合成 / 逐 λ 分离 / 径向曲线 / 直方图 / 指标 / 色差 / 悬停 / 对比 / 导出
```

### 4.1 引擎输出契约（已完成，s1–s2 已实现并验证）

`RayTracer`（`js/engine/raytracer.js`）：
- 构造：`this.abbe`（≤0 无色散）、`this.wavelengths`（`[{nm,weight}]`）。
- `_generateRays()` 多波长入口：按权重用 `RayTracer._allocate`（最大余数法）精确分配光线数；每条光线带 `lam` 与 `n=RayTracer.cauchy(n,abbe,nm)`。
- `_traceRay` 用 `ray.n` 作为介质折射率（`nMat`）做 Fresnel/折射。
- 出射面命中：`outHit = { p:[x,y,z], i:intensity, d:[..], dExit:[..], lam }`（`d`=介质内入射方向，`dExit`=Snell 折射后真正离开方向）。
- `RayTracer.cauchy(n,abbe,lamNm)`：`B=(n−1)/(Vd·1.9104e-6)`，`A=n−B·2.8963e-6`，`n(λ)=A+B/λ²`。
- `RayTracer._allocate(total, weights)`：最大余数法，和严格等于 total。

回传：
- `js/engine/raytracer.worker.js`：`if (msg.options.returnSpot) payload.hits = results.outputHits;`
- `js/app.js` `runOnMainThread`：`if (options.returnSpot) payload.hits = results.outputHits;`

### 4.2 光斑数据模型（spot.js 内部）

```js
LG.state.spot = {
  sig,                      // 几何/光源签名（与当前不符则缓存失效）
  hits,                     // 引擎 outputHits
  axis:  [x,y,z],           // 传播主轴 = normalize(Σ dExit·i)（保证 dd·axis>0）
  center:[x,y,z],           // 出射面面积加权中心（agg.outCenter）
  numRays, flux,            // 归一化用（flux 默认 683 lm）
  lams:  [nm...],           // 出现过的波长
  params                    // 快照（导出报告用）
}
```

动态指纹：
`sig = mesh.name + '|' + mesh.faceCount + '|' + input.length + '|' + output.length + '|' + numRays + '|' + spectrum.enabled + '|' + wavelengths 序列`

## 5. 核心算法（已在沙箱验证，直接实现）

### 5.1 投影
对每条命中 `h`：`dd = normalize(h.dExit)`；`rel0 = h.p − center`；`t = d / (dd·axis)`；
屏幕点 `S = h.p + t·dd`；相对光轴中心 `C+d·axis` 的偏移 `srel = rel0 + t·dd − d·axis`；
屏幕基 `uv, vv` 复刻 `aggregate()` 的构造（`up=[0,1,0]` 或 `[1,0,0]`）；
`su = srel·uv`，`sv = srel·vv`（mm）。

### 5.2 分箱与辐照度
- 网格 `res`（32–192，默认 96）；`half = max(|su|,|sv|)·1.05`，下限 1 mm。
- `cell_mm = 2·half/res`；`A_cell = (cell_mm/1000)²` m²。
- `perRayW = (flux/683)/numRays`；`E[cell] = Σ (perRayW·i) / A_cell`（W/m²，双精度）。
- 索引 `gIdx = iy·res+ix`（iy 随 sv 增大）；同时维护逐 λ 网格 `Eλ[λ][gIdx]` 与 `Pλ[λ][gIdx]`（功率）。
- 能量守恒校验：`Σ_cells Σ_perRayW·i` 必须等于命中总功率（±1e-9 相对）。

### 5.3 真彩合成（CIE 标准色度）
- 波长 → 颜色：Wyman 解析 CMF 拟合 `x̄(λ),ȳ(λ),z̄(λ)` → XYZ → sRGB（D65 白点矩阵），`λ→[r,g,b]` 归一化到单位最大分量。
- `rgbCells[gIdx] = clamp(255 · (E[gIdx]/Emax)^0.7 · unitColorMix)`；
  `unitColorMix` = 该单元各 λ 功率加权混合色（归一化），亮度由 `E/Emax` 承载（暗区趋黑）。
- 供 `LG.Charts.drawSpotCloud(canvas, spot, {mode:'color', rgbCells})`。

### 5.4 远场指标
- 径向曲线：半径 `r∈[0,half]` 分 `Nr`（默认 48）环带，`E_r(r)=Σ环带功率/环带面积`。
- **光斑尺寸**：D86 直径 = 累积能量达 86% 的半径 ×2；FWHM 半径 = 峰值一半处半径。
- **发散角**：半角 `θ = atan(r_FWHM / d)`（°），同时给出等效 `atan(r86/d)`。
- **均匀度**：`uniformity = E_min/E_avg`（点亮的环带/网格单元），并给 CV=σ/μ、passRatio(≥0.8·Eavg)。
- **峰值辐照度** `Emax`、**总功率** `Σ perRayW·i`（W）。

### 5.5 色差量化
- 逐 λ 质心：`(ū_λ, v̄_λ) = Σ(Pλ·(su,sv)) / Σ Pλ`；等效半径 `r_λ = sqrt(Σ Pλ·r² / Σ Pλ)`。
- **轴向色差**：`Δr = |r_650 − r_450|`（蓝/红等效半径差）。
- **横向色差**：蓝/红质心欧氏距离 `|Δcentroid|`。
- 输出表：λ | 质心(ū,v) | 等效半径 | 功率占比 | 相对峰值。

### 5.6 直方图
- 取点亮的网格单元 E 值，`Nb`（默认 28）等宽分箱 → `counts/min/max/mean/peakE`。
- 供 `LG.Charts.drawHistogram`。

## 6. UI / 页面结构（`js/modules/spot.js`，路由 `spot`）

左栏（控件）：
1. **数据源卡**：显示几何/光源摘要 + `运行仿真` 按钮 + 进度条 + 「本页独立运行、不影响其它页」提示。
2. **探测距离卡**：`d` 滑块 0.5–200 mm（线性/对数可选，默认线性）+ 数值输入框；`网格分辨率 res` 滑块。
3. **显示模式卡**：单选 `jet 伪彩` / `真彩合成` / `逐 λ 分离`（分离模式并排小图逐 λ）。
4. **对比视图卡**：开关 + 第二距离 `d2` 滑块 → 双云图并列 + 指标对照。
5. **色差量化卡**：λ 表（质心/半径/功率占比/Δr）。
6. **导出卡**：`导出 PNG` / `导出报告(HTML)` / `导出数据(JSON)`。

右侧（结果）：
- **指标区**（metrics + 评级解读 verdict，复用 analysis 风格）。
- **光斑伪彩云图** canvas（悬停读数浮动框）。
- **对比云图** canvas（可选）。
- **径向分布曲线** canvas（D86/FWHM 标注）。
- **辐照度直方图** canvas。
- **逐 λ 分离** 小图区（模式 3）。

交互：
- 距离/res/模式/对比 改变 → `recomputeAndDraw()`（投影与绘制，不碰引擎）。
- canvas `mousemove` → `layout`（drawSpotCloud 返回）反解 `(ix,iy)` → 显示 `u,v(mm) · E(W/m²) · 主导 λ`。
- `cleanup()` 释放 canvas 引用、移除 mousemove 监听，不残留。

## 7. 文件改动清单（精确）

| 文件 | 改动 | 状态 |
|------|------|------|
| `js/engine/raytracer.js` | Cauchy 色散、多波长采样、逐光线 n/lam、outHit 出射 `dExit` | ✅ 已完成 |
| `js/engine/raytracer.worker.js` | `returnSpot` 回传 `hits`；`importScripts('raytracer.js?v=23')` | 回传✅ / 版本号待 s8 |
| `js/app.js` | 主线程 fallback 回传 `returnSpot`；worker URL `?v=10`；注册 `spot` 路由 | fallback✅ / URL+注册待 s8 |
| `js/store.js` | `material.abbe` 默认+`defaultAbbe()`+迁移；`source.spectrum` 默认+迁移 | ✅ 已完成 |
| `js/modules/model.js` | 材质卡 Abbe 输入；光源卡多波长光谱 UI（预设/增删/权重） | ✅ 已完成 |
| `js/charts.js` | `jetRGB`、`drawSpotCloud`、`drawRadial`、`drawHistogram` | ✅ 已完成 |
| `js/modules/spot.js` | **新建** 光斑分析页（本 Spec 主体） | ⏳ s6 |
| `js/i18n.js` | 新增 `nav.spot`、`spot.*`、`model.mat.abbe`、`model.mat.desc.abbe`、`model.src.spec.*`（zh+en） | ⏳ s7 |
| `index.html` | 新增 `nav.spot` 导航项 + `spot.js` 脚本 + 全部 `?v=N` bump | ⏳ s8 |
| `css/style.css` | 光斑页少量新类（悬停读数/逐λ小图网格），无则复用现有类 | ⏳ s8 |
| `js/router.js` | 无需改动 | — |

### 7.1 版本号 bump 计划（index.html）
`style.css 14→15`、`i18n.js 20→21`、`store.js 13→14`、`charts.js 14→15`、`raytracer.js 22→23`、
`model.js 19→20`、`spot.js 新增 ?v=1`、`app.js 13→14`；`worker.js` 内 `importScripts ?v=23`；`app.js` worker URL `?v=10`。
未改动文件（router/geometry/viewer/simulate/analysis/project/report/options）版本保持不变。

## 8. i18n 键清单（zh / en 各一份）

- `nav.spot`：光斑分析 / Spot Analysis
- `spot.title`：光斑分析 / Beam Spot Analysis
- `spot.src`：数据源 / Data Source
- `spot.run`：运行仿真获取光斑数据 / Run simulation to capture spot data
- `spot.needRun`：尚无光斑数据，点击「运行仿真获取光斑数据」/ No spot data yet — click Run
- `spot.noMesh`：请先在「模型配置」生成或导入几何 / Build or import geometry first
- `spot.hint`：本页独立运行，不影响「仿真计算」页结果 / Runs independently
- `spot.dist`：探测距离 d / Detection distance d
- `spot.res`：网格分辨率 / Grid resolution
- `spot.mode`：显示模式 / Display mode
- `spot.mode.jet`：伪彩（彩虹环） / Pseudo-color (rainbow)
- `spot.mode.color`：真彩合成 / True-color composite
- `spot.mode.sep`：逐 λ 分离 / Per-λ separation
- `spot.compare`：对比视图 / Comparison view
- `spot.compare.d2`：对比距离 d₂ / Comparison distance d₂
- `spot.metrics.*`：size/w86/fwhm/angle/uni/cv/pass/peak 等
- `spot.disp`：色差量化 / Chromatic aberration
- `spot.disp.col.lam/centroid/radius/power`：波长/质心/等效半径/功率占比
- `spot.disp.dr`：轴向色差 Δr / Axial Δr
- `spot.disp.dc`：横向色差 / Lateral Δ
- `spot.heat`：辐照度伪彩云图 / Irradiance pseudo-color
- `spot.radial`：径向分布曲线 / Radial profile
- `spot.hist`：辐照度直方图 / Irradiance histogram
- `spot.export`：导出 / Export
- `spot.export.png/report/json`：导出 PNG / 导出报告 HTML / 导出数据 JSON
- `spot.hover.*`：坐标为 / 辐照度 / 主导波长
- `model.mat.abbe`：阿贝数 Vd / Abbe number Vd
- `model.mat.desc.abbe`：阿贝数说明（色散 n(λ)，Vd 越大色散越小）
- `model.src.spec.enable/preset/preset.rgb/preset.rgbw/preset.ledwhite/add/nm/weight/hint`

## 9. 验收标准

1. 有几何 + 已设 input/output 面时，点「运行仿真获取光斑数据」得到 hits；无则给出明确提示（不抛错）。
2. 距离滑块 0.5→200 mm 拖动，云图半径随距离线性增大（≈ `d·tanθ`），**不重跑仿真**、无卡顿（< ~50ms/次）。
3. jet 云图呈彩色环状（环带高亮、中心暗）；真彩合成下 450/650 nm 蓝红分离可见。
4. 指标卡输出：D86（mm）、FWHM（mm）、发散角（°）、均匀度、CV、峰值 E（W/m²，科学计数）；带评级解读。
5. 色差表逐 λ 给出质心/半径/功率占比；`Δr`、横向色差为非负有限值。
6. 悬停任意位置显示 `(u,v)mm`、`E W/m²`、主导 λ；挪开消失。
7. 对比视图：d 与 d2 两张云图并列 + 关键指标对照表。
8. 导出 PNG 成功下载；报告 HTML 含内嵌图像 + 指标 + 色差表 + 参数快照；JSON 含全部结构化数据。
9. 能量守恒校验通过（Σ 单元能量 == Σ perRayW·i，相对误差 < 1e-9）；辐照度数值分辨率 ≥ 1e-6 W/m²。
10. 语言切换（zh↔en）与路由切换不报错、不残留监听；`Ctrl+Shift+R` 强刷后正常。

## 10. 验证方式（沙箱回归，非浏览器）

- code_mode `Exec`（V8 isolate，无 fs）：`tools.Read` 读源码 → 正则剥行号 → eval；断言：
  - Cauchy 反解恒等：`cauchy(1.49,57.4,587.6)=1.4909998`；`Vd_back=57.4`。
  - 多波长分配守恒：`_allocate(1000,[1,1,1])=[334,333,333]`；`(12345,[1,2,3,4,5])` 和 == 总数。
  - 完整仿真+投影：per-λ 命中和 == 总命中；`Σ cells == Σ hits`；`precision_ok = Emax>1e-6`。
  - 投影读数复算：任取命中点，用 5.1 公式算 `(u,v)` 与分箱索引一致。
- **不启动浏览器 agent**（遵守项目规则）。

## 11. 风险与边界

- 出射面法线绕向不确定 → 主轴用 `Σ dExit·i` 归一化（保证正向），不依赖面法线符号。
- 多出射面/大角度出射 → 部分光线 `dd·axis≈0` 投影爆炸：以 `|dd·axis|>1e-3` 过滤，剔除数入账并在提示中显示。
- 未开启多波长光谱（`spectrum.enabled=false`）→ 仅有单 λ 或 `lam=null`：色差表降级为「未启用多波长」，真彩模式退化为单色热图。
- `res` 过大与 `numRays` 过大 → 分箱耗时；已限制 res ≤ 192、逐 λ 网格复用同一 res。

## 12. 需用户审批的决策点

- A. 距离 `d` 范围与默认：**0.5–200 mm，默认 50 mm**。
- B. 默认显示模式：**jet 伪彩**（可切真彩/逐λ）。
- C. 「光斑分析」导航位置：置于「结果分析」之后、「项目管理」之前。
- D. 版本号 bump 按 §7.1 执行。

以上若无需调整即视为通过，进入 tasks.md 执行。
