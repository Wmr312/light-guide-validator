# 05 · 业务页面模块

六个页面模块遵循同一契约：

```js
LG.Modules.<name> = {
  render: function (el) {
    el.innerHTML = '...';        // 页面 DOM 全部内联生成
    // 绑定事件、读取 Store、调用 Viewer/Engine
    return function cleanup() { /* 必须返回或返回 undefined */ };
  }
};
```

模块是 IIFE，内部函数通过闭包持有本次渲染的 DOM 引用；**每次进入页面都会重新执行 `render()`**，因此不要缓存 DOM 节点。

| 路由 | 模块 | 页面职责 | 视图 |
| --- | --- | --- | --- |
| `#/home` | `home.js` | 项目卡片列表、CRUD、缩略图 | 2D Canvas 预览 |
| `#/model` | `model.js` | 建模/导入、端面拾取、材料、LED、表面、目标、盘位 | 3D |
| `#/simulate` | `simulate.js` | 逐灯珠面选择、跑仿真、光路与结果 | 3D |
| `#/analysis` | `analysis.js` | 指标、热图、轴向、配光、对比、工程结论 | 2D Canvas |
| `#/spot` | `spot.js` | 高分辨率光斑分析、色散、导出 | 2D Canvas（可选 3D 截面） |
| `#/report` | `report.js` | 选择历史记录、模板、生成单页 HTML 报告 | 无（离屏 Canvas） |

> `#/spot` 已注册但未加入顶栏导航；可通过地址栏、`docs/user-guide.html` 的说明或分析页内的入口访问。

## 1. `home.js` — 项目列表

**数据**：`LG.Store.list()`、`active()`。

**流程**：

1. `render()` 生成「新建」卡片 + 每个项目的卡片；
2. `bind(list)` 绑定卡片点击与四个操作：打开（`#/model`）、重命名、导出单项目 JSON、删除（锁定项目禁止删除）；
3. `renderPreview(canvas, project)` 绘制缩略图：
   - 参数化：`buildParametricMesh(g)` 生成网格，用离屏 Three 场景投影绘制；
   - 导入：优先内存缓存，其次 `geometry._mesh`，都没有则 `drawImportedPlaceholder` 画文件占位图；
4. `ensureOffscreen()` / `disposeOffscreen()`：每次缩略图绘制后**立即**释放离屏 WebGL 上下文（`finally` 中调用），避免累积上下文；
5. `handleCardAct(id, act)`：`open` → `Store.setActive` + 跳 `#/model`；`export` → 临时导出单项目；`del` 前置锁检查与确认。

**注意**：缩略图渲染复用 `LG.Viewer` 之外的独立 `WebGLRenderer`，避免与主视图 canvas 冲突；离屏 canvas 尺寸小，需限制数量。

## 2. `model.js` — 模型配置（最复杂的页面）

### 2.1 页面结构（6 张卡片）

卡片以 `data-sec` 标识，`options.js` 依据该属性做显隐：

| `data-sec` | 内容 |
| --- | --- |
| `build` | 导入/参数化几何、长度/直径、端面曲率、侧壁轮廓、微齿、端面自动识别/清除、位姿操作、盘位工具栏 |
| `mat` | 材料预设（PMMA / PC / PC 扩散 / MS）、折射率、阿贝数、吸收、扩散粉 |
| `surface` | 入射/出射/侧面咬花（texture + sigma）与端面/侧面曲面参数 |
| `led` | LED 封装库、尺寸、间距、凹/凸面、XY 偏移、亮度档位 |
| `env` | 光源类型（surface/point/line）、发射模式、光通量、单/多波长光谱、光线数与反弹上限 |
| `goals` | 工程目标（亮度、均匀度、漏光、公差、成型性等）与公差等级 |

### 2.2 几何与盘位

- `plateItems()`：按 `plateId` 分组，一块盘可并排多个「零件」（各自独立项目），返回 Viewer 需要的 `{id,name,locked,parts[]}`；
- `fillPartMesh()`：参数化实时 `Geometry.build`，导入模型取 `state.meshCache`；
- `refreshPlates()`：盘结构变化后重建 3D，不重置相机；
- `addPlate()`：新建项目（新盘）并切换；
- `switchPlate(pid)` → `prepareProjectView(proj)`：
  - 参数化：由 `LG.Geometry.build` 重建；
  - 导入：`restoreCachedMesh`（内存 → `geometry._mesh`）；
  - 恢复端面高亮、位姿、LED，`LG.Engine.refreshLEDPose()`；
  - 若网格不可恢复，徽标提示「请重新导入」，**不伪造几何**；
- `deletePlate` / `lockPlate` / `applyOrient(pid, kind)` / `applyOrder(pid, kind)`；
- 键盘 `Delete/Backspace` 删除选中零件（输入框内不生效）。

### 2.3 端面识别（不在本页手动拾取）

- 导入/重建网格后调用 `LG.Viewer.autoEndCaps()`，再写回 `project.faces`；
- 已有 `faces.input/output` 时优先沿用；任一为空则用自动识别结果覆盖；
- 提供「清除端面」操作（`faces` 置空），用于重新识别；
- 状态徽标显示 `c.facesSet(inputCount, outputCount)`；
- **手动逐面拾取在仿真页完成**（按灯珠选择入射/出射面范围），模型页只负责自动端面与几何。

### 2.4 保存策略

页面没有「保存」按钮，**所有控件 change 即写 Store**：

| 函数 | 写入分区 |
| --- | --- |
| `saveMaterial()` | `material.preset/n/abbe/alpha/diffusion` |
| `saveSource()` / `saveLED()` | `source` / `led` |
| `saveSurface()` | `geometry.surface`（咬花 σ、端面曲率、侧面轮廓） |
| `saveEng()` / `saveEngOffset()` | `eng`、`eng.offsetX/Y`（仿真时并入 `led`） |
| `saveTransform()` | `geometry.transform` |
| `runPrecheck()` | 仅在页面展示风险清单，并写 `eng.checkedAt` |

材料库与 LED 封装库是模块内常量：

- `MATERIAL_LIB`：`pmma / pc / pc_diffuse / ms`，值为 `{preset:"n,alpha"}`；`pc_diffuse` 会同时启用扩散档；
- `TEX_SIGMA`：咬花等级 → 散射半角 `polished 0 / fine 2 / mid 5 / coarse 10`（`custom` 取用户值，上限 25°）；
- `LED_LIB`：`0402 / 0603 / 2835 / 3528 / top / side`，含 `length/width/height/flux/angle`；
- `LED_LEVEL`：`low 0.6 / typ 1 / high 1.6` 亮度系数；
- `SPEC_PRESETS`：`rgb / rgbw / ledwhite` 多波长权重。

### 2.5 导入

- `loadFile(file)` → `LG.parsePartFile`；
- `applyImported(parsed)` → `LG.importIntoProject(p.id, parsed)` → 重建网格、自动识端面、刷新 LED 位姿、刷新盘位；
- 支持拖放（由 `Viewer.onFilesDrop` 回调 `app.handleFileDrop`）。

### 2.6 cleanup

```js
return function cleanup() {
  closePlatePop();
  document.removeEventListener('mousedown', onPlateDocDown, true);
  LG.Viewer.unmount();
};
```

## 3. `simulate.js` — 仿真计算

### 3.1 页面结构

- 左栏：盘/项目选择、逐灯珠入射面列表、模式（快速/精确）、光线数、反弹上限、公差扫参开关、运行按钮、进度条；
- 主区：3D 视图、结果面板（概览 / 能量账本 / 公差）。

### 3.2 关键函数

| 函数 | 作用 |
| --- | --- |
| `render(el)` | 生成 DOM，恢复 `lgv.simMode` / `lgv.simTol`；自动选中当前项目 |
| `onRaysInput(fromRange)` | 光线数与滑杆双向同步 |
| `startPick(beadIdx, role, btn)` / `onPick` | 在仿真页直接补选入射面 |
| `runSim()` | 组装 options → `LG.Engine.run` → `showResults` |
| `paramsSnapshot(opts)` | 固化本次参数快照（含 `n`、`alpha`、`led`、端面集合），用于判断光斑页参数是否已过期 |
| `recordFrom(payload, thumb)` | 生成历史记录（含缩略图）并 `Store.addRecord` |
| `showResults(payload)` | 概览、账本、公差 UI；切换 `Viewer.showRays` |
| `showSpotSectionFrom()` | 用 `spot.projectLastRun()` 生成光斑投影，再 `Viewer.showSpotSection` |

### 3.3 `runSim()` 流程

```
读取 UI → 克隆当前 project（深拷贝，防止运行中被改）
  ├─ 校验：有网格、有入射面、有出射面、材料/LED 合法
  ├─ 组装 options（n/abbe/alpha/maxBounces/numRays/faces/led/spectrum/texture/muS）
  ├─ quick/precise 覆盖 numRays / maxBounces / heatmapRes / visRays
  ├─ LG.state.lastRun = null（先失效旧结果）
  ├─ 进度条 → LG.Engine.run(mesh, options, onProgress)
  ├─ 成功：
  │    state.lastRun = payload（附 params 快照）
  │    Viewer.showRays(payload.segments)
  │    showResults(payload)
  │    Store.addRecord(recordFrom(payload, screenshot))
  │    status('✓ ...')
  └─ 失败：进度归零、status(error)
```

**自动重跑**：只有「光线数」滑杆/输入框变更会触发自动重跑——写回 `source.numRays` 后 700ms debounce，且要求网格、端面齐全；页面离开后定时器会失效（`dead` 守卫）。改几何/材料后不会自动跑，需手动点击「开始仿真」。

**记录字段**（`recordFrom`）：

```js
{
  id, time,                        // addRecord 自动生成
  params,                          // 参数快照（见 07）
  summary: {total, success, escaped, exhausted, successRate,
            avgOutputIntensity, maxBounces, elapsedMs, mode},
  ledger, agg,
  tolerance: [{offset, brightness, drop}] | null,
  simMode: "quick" | "precise",
  thumb: dataURL | null            // 240×180 3D 截图（含光线）
  // 不保存 hits / segments / spot
}
```

### 3.4 公差扫参

勾选后，在基准仿真之外对「导光柱相对 LED 的 X 向装配偏位」做 0.1 / 0.2 / 0.3mm 三次扰动：

- 每次把网格顶点整体平移 `dx`（等价于 LED 偏心），光线数降到 `min(numRays, 400)`、热图 24、不采集轨迹；
- 结果记为 `tolerance[] = [{offset, brightness, drop}]`，`drop` 为相对基准亮度的百分比衰减；
- 供分析页折线图与报告「公差敏感度」表使用。

> 只扫一个方向（+X）。若需 ±X/±Y 或长度/直径公差，需扩展 `runTolerance()`。

## 4. `analysis.js` — 结果分析

**数据源**：顶部下拉框可选「最近一次运行」（`LG.state.lastRun`）或任一历史记录（`Store.getRecord(id)`）。历史记录只有 `agg`，因此光斑区块仅对 `lastRun` 可用；若两者都为空，页面显示空态并引导去仿真页。

### 4.1 页面区块

| 区块 | 内容 |
| --- | --- |
| 数据源 | 「最近一次运行」或任一历史记录 |
| 指标卡 | 出射光通量、利用率、均匀度、峰值；三条进度条（`metricRange`） |
| 光斑卡 | 基于 `lastRun` 的 `spot.buildView`：伪彩/真彩/色差分图、hover 读数、PNG 导出、D86 与色差提示 |
| 热图 | 出射面辐照度云图 + 阈值输入（`#a-thr`，默认 0.8） |
| 公差 | 偏移-亮度折线与明细表 |
| 工程结论 | `buildConclusion()` 生成的 verdict 卡片 |
| 光学折叠区 | 轴向侧漏曲线、极坐标配光曲线 |
| 对比 | 选择另一条记录/项目做指标对比 |
| 仿真 vs 实测 | 读取 `project.measurements`，展示差值（`#a-meas`） |
| 追踪 | 记录附带的 3D 截图缩略图 |

### 4.2 导出给报告的纯函数

| 函数 | 说明 |
| --- | --- |
| `engStats(d, m, proj)` | 返回 `{util, outLm, m, flux}`：利用率、出射光通量、指标对象、输入通量 |
| `isMultiGuide(proj)` | 判定是否多导光柱：`beads.length > 1` 或 `Store.list().length > 1` |
| `buildConclusion(d, st, proj, tr)` | **返回一段 HTML 字符串**（verdict 卡片），不是数组；`tr` 为翻译函数，报告可指定语言 |

`buildConclusion` 内部按 `project.eng.targets` 的布尔开关逐项判定，并用 `lv ∈ ok / warn / bad` 汇总为 `worst`，最后渲染徽标、条目与建议。

### 4.3 阈值来源（代码内常量，非可配置）

| 项 | ok | warn | bad | 位置 |
| --- | --- | --- | --- | --- |
| 利用率 `util` | ≥ 0.30 | 0.18–0.30 | < 0.18 | `buildConclusion` |
| 均匀度 `uniformity` | ≥ 0.70 | 0.50–0.70 | < 0.50 | `buildConclusion` |
| 漏光 `1-util`（多导光柱） | ≤ 5% | 5–15% | > 15% | `buildConclusion` |
| 公差亮度衰减 | ≤ 30% | > 30% | — | `buildConclusion` |
| 拔模角 | ≥ 1° | < 1° | — | `buildConclusion` |
| 指标条 `uniformity` | ≥ 0.70 | 0.40–0.70 | < 0.40 | `metricRange` |
| `passRatio` | ≥ 0.90 | 0.70–0.90 | < 0.70 | `renderVerdict` |

`project.eng.targets` 只控制**是否输出该项结论**：

```js
targets: {
  brightness: true, uniformity: true, leak: true, tolerance: true,
  bendLoss: false, crosstalk: false, molding: true
}
```

> 若要支持「按产品自定义阈值」，需要把上表常量移入 `targets` 或新的 `eng.limits`，并同步迁移与报告。

### 4.4 生命周期

`render()` 末尾返回 `null`（无 cleanup）。页面未注册全局 `resize` 监听，Canvas 由自身 CSS 尺寸驱动；离开页面后旧 DOM 与闭包由浏览器回收。若后续加入动画/定时刷新，必须在返回值中实现清理。

## 5. `spot.js` — 光斑分析

### 5.1 数据来源

```js
buildFromLastRun()  // 只读 LG.state.lastRun，返回带投影参数的 spot 对象或 null
buildView(mode)     // mode: 'jet'（伪彩） / 'color'（真彩） / 'sep'（分波长色差）
                    // 返回 {spot, cur, cloud, opts, sep, util}
```

`paramsStale(prm)` 比较当前项目参数快照与光斑数据的快照：参数已变则提示「结果已过期」，但仍允许查看。光斑页**不读取历史记录**——历史记录未保存出射光线。

### 5.2 核心算法（页面内纯函数）

| 函数 | 说明 |
| --- | --- |
| `project(spot, d, res)` | 沿出射方向把命中点传播到探测屏：`half=max(p98·1.12, faceHalf)`、自适应高斯 PSF、每光线功率 `flux/683/numRays`、能量守恒校验、CIE 三刺激值 |
| `splatGrid(us, vs, ws, lamOf, half, res, sigmaMM, perRayW, lamKeysInit)` | 高斯溅射到指定网格，返回功率/辐照度/每波长分色 |
| `radialProfile(cur)` | 屏心起算的环带辐照度、D86、FWHM |
| `computeMetrics(cur)` | 端面圆内（命中半径 ×0.97）的 `avg/min/max/cv/uniformity/passRatio/D86/r86/rFwhm` |
| `colorSeparation(cur)` | 多波长质心偏移 → 色差（mm） |
| `histogram(cur)` | 照度直方图 |
| `trueColorCells(cur, spot)` | 多波长按 CIE XYZ→sRGB 合成真彩 |
| `capture(canvas)` | 返回 canvas 的 PNG dataURL（报告复用） |

**双网格**：

- `res`（默认 64）：指标统计，保持稳定；
- `disp`（256）：显示与导出，仅影响观感。

**端面半宽约束**：`project` 会按出射面尺寸限制屏面范围，避免把远离端面的杂散命中计入光斑。

### 5.3 页面交互

- 左侧：工况信息（只读，来自 `lastRun`）、阈值滑杆、显示模式（`jet` 伪彩 / `color` 真彩 / `sep` 色差）、导出；
- 右侧：光斑图（可 hover 读数）、径向曲线、直方图、色差框、指标与判定；
- `exportPNG` 导出当前 canvas；`exportJSON` 导出 `collectData()` 的整理数据；`exportHTML` 使用本页自有模板生成单页 HTML（与报告模板不同，自带指标表与色差表）。

## 6. `report.js` — 报告生成

### 6.1 流程

```
render(el)
  ├─ 载入项目与历史记录（默认勾选最新一条）
  ├─ 模板：dfm（DFM 工程评估，默认） / optical（光学评估）
  ├─ 语言：跟随界面 / 简体中文 / English
  ├─ 可选：附带当前 3D 截图
  └─ generate()
        ├─ 逐条记录取 agg / params / ledger / tolerance
        ├─ 在离屏 <canvas> 上用 LG.Charts 绘制热图等，导出 PNG dataURL
        ├─ 最新记录且 lastRun 存在时，用 spot.capture 生成出射光斑图
        ├─ 组装单页 HTML（内联 CSS + 内联图片）
        ├─ 注入隐藏 iframe 预览
        └─ 启用「下载 .html」「打印/PDF」
```

> 报告不使用 SVG：图表全部由 Canvas 渲染成 PNG 后以 dataURL 内嵌，保证所见即所得。历史记录只有 `agg`，因此光斑图退化为端面热图；只有「最新记录」才能使用完整出射光线云图。

### 6.2 关键函数

| 函数 | 说明 |
| --- | --- |
| `selectedRecords()` | 取勾选记录；为空时提示 |
| `generate()` | 生成报告 DOM 与 HTML 字符串 |
| `dfmRisks(p0, tr)` | DFM 风险清单（壁厚、拔模、齿深、R 角、装配间隙） |
| `toleranceTable(rec, tr)` | 公差敏感度表 |
| `dfmVerdict(rec, util, m, tr)` | DFM 结论 |
| `geoText(params, tr)` / `materialName(params, tr)` | 参数与材料本地化 |
| `reportCSS()` | 内联样式（A4 打印友好） |

### 6.3 依赖

- 复用 `Modules.spot.capture(canvas)`：内部基于 `LG.state.lastRun` 投影并绘制 256 显示网格，**返回投影对象或 `null`**（图片通过 `canvas.toDataURL` 取得）；
- 复用 `Modules.analysis.buildConclusion / engStats`；
- 使用 `LG.I18N.tFor(lang)` 固定报告语言，不改变界面语言；
- 语言下拉的 `follow` 表示跟随当前界面。

### 6.4 注意

报告是**自包含 HTML 字符串**（图片以 dataURL 内嵌），因此体积可能较大（数百 KB～数 MB）；生成时避免把全部历史记录都放入同一报告，建议一次 1–3 条。

## 7. 模块间协作清单

| 触发 | 结果 |
| --- | --- |
| 模型页参数变化 | Store 更新 → 3D 重建（参数化）或仅刷新 LED 位姿 → 标记 lastRun 过期（光斑页提示） |
| 仿真完成 | `state.lastRun` + 历史记录 + 3D 光路 + 结果面板 |
| 切换盘 | `prepareProjectView` 恢复网格/端面/LED，清空 lastRun 相关显示 |
| 语言切换 | `lg:lang` → `Router.rerender()`，各页重新 `render()` |
| 删除项目 | 若删除 active，`Store` 自动激活下一个；页面需重渲染 |
| 拖放文件 | `app.handleFileDrop` → 新建盘/零件 → 重渲染当前路由 |
