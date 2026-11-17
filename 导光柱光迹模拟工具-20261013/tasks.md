# Tasks — 彩色辐照度伪彩云图（彩虹环状光斑）光斑分析模块

> 依赖 spec.md。按序执行，每个任务完成后即时校验。功能修改默认不做浏览器验证（用户 Ctrl+Shift+R 自测）。

## 已完成（s1–s5）

- [x] **s1 引擎色散与出射方向**（`js/engine/raytracer.js`）
  - `this.abbe`、`this.wavelengths`；`_generateRays()` 多波长入口 + `RayTracer.cauchy` + `RayTracer._allocate`；
    逐光线 `n/lam`；`_traceRay` 用 `nMat`；outHit 增 `dExit`。
  - 校验：Cauchy 恒等、分配守恒、per-λ 命中和守恒。✅ 沙箱通过。
- [x] **s2 回传 hits**（`js/engine/raytracer.worker.js`、`js/app.js`）
  - `returnSpot` → `payload.hits = results.outputHits`。✅
- [x] **s3 store 默认与迁移**（`js/store.js`）
  - `material.abbe` 默认 + `defaultAbbe()` + `migrateMaterialMeta()`（幂等）；
    `source.spectrum` 默认 + 迁移；导入/导出补齐；`MATERIAL_ABBE/defaultAbbe` 导出。✅
- [x] **s4 模型页 UI**（`js/modules/model.js`）
  - 材质卡 Abbe 输入 + 说明；光源卡多波长光谱（预设 rgb/rgbw/ledwhite、增删、权重、`renderSpecList`）。✅
- [x] **s5 图元绘制**（`js/charts.js`）
  - `jetRGB`、`drawSpotCloud`(返回布局)、`drawRadial`(D86/FWHM)、`drawHistogram`；导出。✅

## 待执行

- [x] **s6 新建 `js/modules/spot.js`（本 Spec 主体）**
  - 文件骨架：IIFE + `window.LG.Modules.spot = { render }`（与 analysis.js 同范式）。
  - `render(el)`：
    - 布局（`layout`：左控件 / 右结果）；`cleanup` 返回函数。
    - 状态：读 `LG.state.spot`，用 §4.2 `sig` 比对当前几何/光源，失效则清空。
    - 控件：数据源卡（run 按钮/进度）、距离卡（d 滑块+数值、res 滑块）、模式卡、对比卡、色差卡、导出卡。
    - 结果：metrics + verdict、光斑云图 canvas、对比云图 canvas、径向 canvas、直方图 canvas、逐λ 小图区。
  - `runSim()`：组装 options（含 `abbe: material.abbe`、`wavelengths: spectrum.enabled ? spectrum.wavelengths : null`、
    `numRays/flux`、`inputFaceIds/outputFaceIds`、`led`、`returnSpot:true`、`returnSegments:false`、`visRays:0`），
    调 `LG.Engine.run({positions,indices}, options)` → 存 `LG.state.spot`。
  - `recomputeAndDraw()`：§5.1 投影 → §5.2 分箱（逐 λ 网格）→ 画出四种视图 + 指标 + 色差表 + 悬停绑定。
  - 函数：`projectHits(d)`、`binGrid(res,half)`、`radialProfile()`、`histogram()`、`colorSeparation()`、
    `trueColorCells()`、`wavelengthToRGB(λ)`（Wyman CMF）、`computeMetrics()`、`hoverHandler()`、
    `exportPNG()/exportReportHTML()/exportJSON()`、`fmtSci()`。
  - 导出：PNG 用 `canvas.toDataURL()` + 临时 `<a download>`；报告用 `LG.download(name, html, 'text/html')`。
  - 自检点：能量守恒断言、`dd·axis` 过滤计数、未启用多波长降级提示。
- [x] **s7 i18n**（`js/i18n.js`）
  - zh + en 各追加：`nav.spot`、`spot.*`（§8 全量）、`model.mat.abbe`、`model.mat.desc.abbe`、`model.src.spec.*`。
  - 键须与 model.js/spot.js 中 `LG.t()` 实参逐一对应（用 Grep 反查，无遗漏/无多余）。
- [x] **s8 装配与版本号**（`index.html`、`css/style.css`、`js/app.js`、`js/engine/raytracer.worker.js`）
  - `index.html`：`<a href="#/spot" class="nav-item" data-i18n="nav.spot">` 插在 analysis 之后；
    新增 `<script src="js/modules/spot.js?v=1">`（在 analysis 之后、app 之前）；
    按 §7.1 bump：style 15 / i18n 21 / store 14 / charts 15 / raytracer 23 / model 20 / app 14。
  - `js/app.js`：`LG.Router.register('spot', LG.Modules.spot);`；worker URL `?v=10`。
  - `js/engine/raytracer.worker.js`：`importScripts('raytracer.js?v=23')`。
  - `css/style.css`：如需新增类（`.spot-hover`、`.spot-sep-grid`），随 style bump 一起。
- [x] **s9 沙箱回归**（code_mode `Exec`）
  - 复用 s1 断言 + 新增：投影读数复算、能量守恒（相对误差 <1e-9）、`dd·axis` 过滤、未启用多波长降级路径不抛错。
  - 明确：不启动浏览器 agent。
  - ✅ 结果：全部 JS 文件 `new Function` 解析通过；i18n 键交叉核对无缺失（修复 s6 使用但缺失的 `spot.export` / `spot.export.png` / `spot.export.report` / `spot.export.json` 4 键 zh+en）；
    Cauchy 恒等（n@587.6=1.49 精确）、`_allocate` 求和精确（1000/12345）、多波长圆柱仿真 per-λ 命中分配正确、`outCenter≈(0,0,30)`、`outNormal=[0,0,1]`、全 hits 含 p/dExit/lam/i、能量守恒相对误差 4.5e-16（<1e-9）、Emax≈1.4e5 W/m²（≥1e-6）、`dd·axis` 过滤 skipped=0、单波长降级路径不抛错。
  - ⚠ 回归发现并修复 **CIE 色匹配函数缺陷**：`cieX` 两条高斯幅值顺序颠倒（应为 `0.362·g(442) + 1.056·g(599.8)`）、`_g(t)` 缺 `0.5` 因子（应为 `exp(-0.5·t²)`）——导致 450nm 渲染成洋红。修复后 450→蓝、550→绿、650→红，XYZ 与 CIE 1931 参考值 3 位小数吻合。
  - 同步将 `spot.disp.advice` 文案由“蓝光等效半径更大”改为方向中性的色差量化表述（引擎实测 d=50 处 r450 与 r650 差异 <1%，原断言不成立）。

## 完成定义（DoD）

- §9 验收标准 1–10 全部满足。
- s9 沙箱断言全过。
- 不改动无关文件；不新增文档（除本 spec.md/tasks.md）。
- 向用户报告：改动文件清单 + 已验证项 + 「请 Ctrl+Shift+R 自测」。
