# 07 · 数据模型与持久化

持久层由 [js/store.js](file:///workspace/导光柱光迹模拟工具-20261013/js/store.js) 实现，全部基于 `localStorage`，无后端。

## 1. 存储布局

| Key | 写入方 | 说明 |
| --- | --- | --- |
| `lgv.projects.v1` | `Store` | 项目数组（全量 JSON） |
| `lgv.active.v1` | `Store` | 当前激活项目 id |
| `lgv.ledEnabledDefault.v1` | `Store` 迁移 | 一次性标记 |
| `lgv.lang` | `I18N` | `zh` / `en` |
| `lgv.ui.hiddenSections` | `Options` | 模型页隐藏卡片 id 数组 |
| `lgv.ui.showTips` | `Options` | `'1'` / `'0'` |
| `lgv.simMode` | `simulate` | `quick` / `precise` |
| `lgv.simTol` | `simulate` | 公差扫参开关 |
| `lgv.spot.mode` | `spot` / `analysis` | 光斑显示模式（jet/color/sep） |
| `lgv.spotSec` | `simulate` | 3D 出射光斑截面开关 |

> 浏览器 `localStorage` 通常约 5MB / 域。项目数组里最占空间的是 `records[].agg.heatmap`、`thumb` 与 `geometry._mesh`，删除历史记录或导出后清理是必要操作。

## 2. 项目（Project）完整结构

`Store.defaults()` 是唯一权威定义：

```js
{
  // ── 标识 ──
  id: "m1x2y3abc",                 // Date.now().toString(36) + 5 位随机
  name: "Project-11-17 14:30",
  createdAt: 1763... , updatedAt: 1763...,
  plateId: "m1x2y3abc",            // 同一 plateId 的多个项目并排在同一块盘
  locked: false,                   // 盘锁定：禁止删除/移动/改参

  // ── 几何 ──
  geometry: {
    shape: "cylinder",
    d1: 3, d2: 3, length: 30, radialSeg: 48,
    teeth: { enabled:false, step:1, width:0.8, aStart:85, aEnd:10, offset:2 },
    fileName: "",                  // 非空表示导入模型
    useParametric: true,
    transform: { posX:0, posY:0, posZ:0, rotX:0, rotY:0, rotZ:0 }, // mm / deg
    surface: {
      inputTex:"polished",  inputSigma:0,  inputCurve:"flat",  inputCurveR:20,
      outputTex:"polished", outputSigma:0, outputCurve:"flat", outputCurveR:20,
      sideTex:"polished",   sideSigma:0,
      sideProfile:"straight", sideDeltaR:0.3
    },
    _mesh: {                       // 可选：小网格持久化（>256KB 不写）
      positions: [/* Float32 序列化数组 */],
      indices:   [/* Uint32 序列化数组 */],
      name: "part.stl"
    }
  },

  // ── 光学材料 ──
  material: {
    preset: "1.49,0.0005",         // "n,alpha" 键
    n: 1.49,
    alpha: 0.0005,                 // 1/mm，Beer-Lambert
    abbe: 57.4,                    // Vd，色散
    diffusion: "none"              // none / fine / mid / coarse
  },

  // ── LED 封装（模型页） ──
  led: {
    enabled: true,
    type: "rectangle",             // rectangle / square / concave / convex
    length: 3.0, width: 2.0, height: 1.5, gap: 0.5,
    concaveDepth: 0.4, convexRadius: 0.6,
    poses: null                    // 导入模型时由 Engine.refreshLEDPose 写入
    // poses: [{pos:[x,y,z], x:[...], y:[...], z:[...], area: 1.23}]
    // 装配偏移不存这里：持久化在 eng.offsetX/eng.offsetY，仿真时并入 led 传给引擎
  },

  // ── 光源与追迹 ──
  source: {
    type: "surface",               // surface / point / line
    mode: "lambert",               // lambert / gauss
    flux: 683,                     // lm
    wavelength: 555,               // nm（单波长）
    angleSigma: 12, posSigma: 0.3, srcDist: 0,
    numRays: 1000, maxBounces: 30,
    spectrum: {
      enabled: false, preset: "rgb",
      wavelengths: [{nm:450,weight:1},{nm:550,weight:1},{nm:650,weight:1}]
    }
  },

  // ── 端面与逐灯珠范围 ──
  faces:  { input: [], output: [] },          // 三角面索引数组（合并选择）
  beads: [ { input: [], output: [] } ],       // 每颗灯珠独立的入射/出射范围

  // ── 工程化配置 ──
  scheme: {
    type: "straight",              // straight / bent / tir / plate
    template: "",
    bendAngle: 90, bendR: 3, draftAngle: 1
  },
  eng: {
    material: "pmma",              // pmma / pc / pc_diffuse / ms / custom
    ledModel: "0603",
    ledLevel: "typ",               // low / typ / high
    assemblyGap: 0.1,
    offsetX: 0, offsetY: 0,
    housing: "black", foam: true, reflector: false,
    targets: { brightness:true, uniformity:true, leak:true,
               tolerance:true, bendLoss:false, crosstalk:false, molding:true },
    checkedAt: 0
  },

  // ── 历史与实测 ──
  records: [],                     // 仿真记录（倒序，最新在前）
  measurements: []                 // 实测数据
}
```

### 2.1 字段约束

| 字段 | 约束 |
| --- | --- |
| `geometry.length` | `≥ 0.5` |
| `geometry.d1/d2` | `≥ 0.1` |
| `geometry.radialSeg` | `12–128` |
| `geometry.surface.*CurveR` | `≥ 2r`（生成时钳制） |
| `geometry.surface.sideDeltaR` | 建议 `0–0.5r` |
| `material.alpha` | 光学塑料典型 `1e-4 – 2e-3 /mm` |
| `source.numRays` | UI 500–50000；快速模式上限 1600 |
| `source.maxBounces` | 10–200；快速模式上限 40 |
| `source.spectrum.wavelengths` | 权重之和在仿真时归一化 |
| `faces.input/output` | 必须是合法三角面索引 |

## 3. 仿真记录（Record）

```js
{
  id, time,                        // addRecord 自动生成
  params: {                        // 参数快照，用于判断「结果是否过期」
    geometryName, isParametric, geometry, n, abbe, alpha, materialPreset,
    emissionMode, sourceType, flux, wavelength, angleSigma, posSigma, srcDist,
    spectrum, led, numRays, maxBounces, simMode, srcRays, diffusion,
    heatmapRes, inputCount, outputCount
  },
  summary: {
    total, success, escaped, exhausted,
    successRate, avgOutputIntensity, maxBounces, elapsedMs, mode
  },
  ledger: { output, side, absorbed, residual },
  agg: { heatmap, axis, angle, metrics, outCenter, outNormal },
  tolerance: [ {offset, brightness, drop} ] | null,
  simMode: "quick" | "precise",
  thumb: "data:image/jpeg;base64,...", // 240×180，3D 截图（含光线）
  // 注意：不保存 hits / segments / spot，避免 localStorage 爆量
  spot: undefined
}
```

**为什么记录不含 `hits`**：一次 1000 光线约 1000×6 个浮点，且热图已达 64×64。记录面向「可回看的结论」，不面向「可重算的原始数据」。因此：

- 光斑页只能基于 `LG.state.lastRun`（最近一次）；
- 报告的热图/曲线基于 `agg`，光斑图需要当前会话的 `lastRun`；
- 若需完整复现，应在仿真后立即导出光斑 JSON（`spot.exportJSON`）。

## 4. 实测数据（Measurement）

由分析页「仿真 vs 实测」使用。约定结构（页面按需读取）：

```js
{
  id, time,
  label: "样品A",
  avg: 0.85,          // 实测平均相对照度
  uniformity: 0.72,   // 实测均匀度
  cv: 0.11,           // 实测变异系数
  note: ""
}
```

> 分析页「仿真 vs 实测」只对比 `avg / uniformity / cv` 三项，偏差按 `(sim - meas)/|meas|` 计算。

> 当前版本没有独立的实测录入表单，数据通过 `Store.addMeasurement()` 或导入 JSON 写入；二次开发可在此扩展。

## 5. 迁移机制

`load()` 每次都执行 4 个幂等迁移：

| 迁移 | 触发条件 | 行为 |
| --- | --- | --- |
| `migrateMaterialAbsorption` | `material.preset` 命中 `PRESET_REMAP`，或 `alpha > 0.01` | 预设改写为新键；自定义 α `/200` |
| `migrateMaterialMeta` | 缺 `abbe` / `diffusion` / `source.spectrum` | 按预设补默认值 |
| `migrateEngConfig` | 缺 `scheme` / `eng` / `eng.targets` / `geometry.surface` | 补默认；由 `material.preset` 反查 `eng.material` |
| `migrateLedEnabledDefault` | 标记键不存在 | 所有 `led.enabled=false` → `true`，写标记 |

**α 迁移背景**：早期版本把吸收系数按 `0.01–0.40 /mm` 录入，导致 30mm 导光柱内吸收 95% 以上，表现为「光线在柱内提前消失」。修正为 `1e-4–2e-3 /mm` 量级。

### 5.1 新增字段的正确做法

1. 在 `defaults()` 中加入字段与默认值；
2. 在 `migrateXxx()` 中为老项目补齐（判断 `== null`，不要用 `!value`，否则 `0/false` 会被误判）；
3. 页面读取时仍用 `(p.xxx && p.xxx.yyy) || fallback` 做防御；
4. 更新 `importJSON` 的补字段逻辑；
5. 若字段影响报告，同步 `report.js` 与 `I18N` 字典。

## 6. 导入 / 导出

### 6.1 项目 JSON

```js
LG.Store.exportJSON();
// { app:"light-guide-validator", version:1, projects:[...] }
```

```js
const n = LG.Store.importJSON(text);
```

规则：

- 兼容裸数组与 `{projects}` 两种格式；
- 每个导入项目**重新生成 `id`**，避免与本地冲突；
- `records` / `measurements` 缺失补空数组；
- `material.abbe` / `diffusion` / `source.spectrum` 缺失时补默认；
- 无 `geometry` 的条目直接跳过；
- 导入后项目插入队首；若此前无激活项目则激活第一条；
- **不做** `plateId` 冲突合并，导入后每个项目沿用原 `plateId`（同组同盘）。

### 6.2 网格持久化

`app.importIntoProject` 写入：

```js
proj.geometry.fileName = file.name;
proj.geometry._mesh = {
  positions: Array.from(positions),
  indices: Array.from(indices),
  name: file.name
};
```

体积估算（`app.js`）：

```js
bytes ≈ positions.length * 8 + indices.length * 6
```

- `> 256KB` → 跳过 `geometry._mesh`，仅 `LG.state.meshCache[projId]` 会话内可用；
- 刷新后若无持久化网格，模型页提示「请重新导入」，**不会**用参数化几何冒充导入模型。

### 6.3 光斑 JSON

`spot.exportJSON()` 导出 `collectData()` 的结果：

```js
{
  generated, params,
  plane: "exit_face", distance_mm,
  grid: {res, half_mm, cell_mm, A_cell_m2},
  normalization: {perRayW, numRays, flux},
  brightness: {util, flux_lm, exitFlux_lm},
  metrics: {D86_mm, r86_mm, rFwhm_mm, uniformity, cv, passRatio,
            peakIrradiance_W_m2, avgIrradiance_W_m2, totalPower_W, litCells, skipped},
  chromatic: {multi, axialDeltaR_mm, lateralDelta_mm, perLambda:[...]},
  radial: {r_mm:[], irradiance_W_m2:[]},
  histogram: {bins, min_W_m2, max_W_m2, mean_W_m2},
  energyConservation: {relError, outsidePower_W, kernelClipPower_W},
  note
}
```

用于外部分析或与实测对照，不参与 Store 持久化。

## 7. 数据一致性规则

1. **`plateId` 分组**：同一 `plateId` 的项目共享一块盘；新建项目独占新盘；导入的项目沿用原 `plateId`。
2. **锁定**：锁定的盘禁止删除/移动/改参数，UI 与 Store 双层校验。
3. **切换盘**：`prepareProjectView` 会以「内存缓存 → `geometry._mesh`」顺序恢复网格；恢复失败只提示，不伪造。
4. **面索引**：导入网格的面索引在重新导入后可能变化，必须重新拾取端面；应用会自动做一次 `autoEndCaps` 并持久化。
5. **params 快照**：光斑页用 `paramsSnapshot` 与当前项目比较，参数变化后提示结果过期，但不自动删除旧结果。
6. **删除激活项目**：`Store.remove` 自动激活下一个；若删空，需用户新建项目，`app` 不会自动重建（仅首次启动 `ensureProject` 会）。
