# 02 · 光线追踪引擎

文件：[js/engine/raytracer.js](file:///workspace/导光柱光迹模拟工具-20261013/js/engine/raytracer.js)（约 1600 行）
Worker：[js/engine/raytracer.worker.js](file:///workspace/导光柱光迹模拟工具-20261013/js/engine/raytracer.worker.js)

## 1. 设计约束

- **纯 JS，零依赖**：不引用 `THREE`、DOM、`window` 业务对象，因此可直接被 `importScripts()` 加载。
- 同时支持两种暴露方式：

```js
if (typeof self !== 'undefined') self.RayTracer = RayTracer;
else globalThis.RayTracer = RayTracer;
```

- 主线程可通过 `new RayTracer(mesh, options)` 直接运行（Worker 不可用时的降级路径）。
- 也兼容传入 `THREE.Mesh`（内部自动取 `geometry.attributes.position` / `index`）。

## 2. 坐标与单位

| 项 | 约定 |
| --- | --- |
| 长度 | mm |
| 参数化几何轴向 | +Z，`z=0` 入射端，`z=L` 出射端 |
| LED 局部坐标 | `z=0` 为入射面，灯珠位于 `z<0` 侧，发光面在 `z=-gap`，局部 +Z 为发射方向 |
| 恒等 LED 位姿 | `RayTracer.IDENTITY_LED_POSE = {pos:[0,0,0], x:[1,0,0], y:[0,1,0], z:[0,0,1]}` |

## 3. 构造函数与参数

```js
const tracer = new RayTracer(
  { positions: Float32Array, indices: Uint32Array | null },
  options
);
const results = tracer.simulate(onProgress);
const agg = tracer.aggregate(results, { heatmapRes, axisBins, angleBinDeg });
```

### 3.1 `options` 字段

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `n` | `1.49` | 参考折射率（@587.6nm） |
| `abbe` | `0` | 阿贝数 Vd；`≤0` 关闭色散 |
| `alpha` | `0.10` | 吸收系数（1/mm），Beer-Lambert `I=I0·e^(-αL)` |
| `maxBounces` | `30` | 表面反弹上限 |
| `numRays` | `1000` | 总光线数 |
| `angleSigma` | `12` | 发散半角（deg） |
| `posSigma` | `0.3` | 位置抖动 σ（mm） |
| `srcDist` | `0` | 非 LED 模式下光源到入射面的空气距离（mm） |
| `visRays` | `200` | 3D 轨迹采集配额（不影响统计） |
| `sourceType` | `surface` | `surface` / `point` / `line` |
| `emissionMode` | `lambert` | `lambert` / `gauss` |
| `led` | `null` | `{enabled, type, length, width, height, gap, concaveDepth, convexRadius, offsetX, offsetY, poses?, pose?}` |
| `inputFaceIds` | `[]` | 入射三角面索引 |
| `outputFaceIds` | `[]` | 出射三角面索引 |
| `surfaceTexture` | `null` | `{input, output, side}` 散射半角（deg） |
| `muS` | `0` | 体散射系数（1/mm），0 = 纯吸收 |
| `hgG` | `0.55` | Henyey-Greenstein 各向异性因子，钳制在 `[-0.95, 0.95]` |
| `wavelengths` | `null` | `[{nm, weight}]`；存在则按波长分组追踪 |

> 注意：`alpha` 在引擎侧的默认值是 `0.10`，但应用层 `Store.defaults()` 给出的材料默认是 `0.0005`。实际运行时始终显式传入 `project.material.alpha`，不会用到引擎默认值。

## 4. 内部数据结构

### 4.1 三角面元 `_buildFaceData()`

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `faces` | `Array<[i0,i1,i2]>` | 顶点索引三元组 |
| `faceNormals` | `V3[]` | 单位法向 |
| `faceCenters` | `V3[]` | 三角面重心 |
| `faceAreas` | `number[]` | 面积 |
| `bboxMin / bboxMax` | `[x,y,z]` | 场景包围盒 |
| `gridSize` | number | 最长边，用于数值偏移尺度 |

### 4.2 均匀网格 `_buildGrid()`

`this.grid: Map<cellKey, faceId[]>`，单元边长约 `gridSize / 32`（按面数自适应）。射线求交时通过 `_getNearbyFaces(point, radius)` 收集候选，减少三角形全扫。

### 4.3 求交 `_rayTriangle` / `_raycast` / `_scanCandidates`

Möller–Trumbore 算法，返回最近正交点参数 `t` 与面索引；支持 `excludeSet` 排除自交面。

## 5. 光线生成 `_generateRays()`

### 5.1 多波长入口

若配置了 `wavelengths`：

1. 用**最大余数法** `_allocate(total, weights)` 把 `numRays` 严格分配到各 λ；
2. 对每个 λ 调用单波长生成；
3. 为每条光线标注 `ray.lam` 与 `ray.n = cauchy(n, abbe, λ)`。

### 5.2 单波长 `_generateSingleWavelengthRays()`

分两种来源：

**A. 普通光源（无 LED 或 LED 关闭）**

- 计算入射面集合的面积加权中心 `inC` 与平均法向；用探针射线判断真正朝内的方向；
- 建立局部正交基 `(right, realUp, inward)`；
- `sourceType`：
  - `surface`：在入射三角面上按面积均匀采样起点；
  - `point`：从中心点（可前移 `srcDist`）锥形发射；
  - `line`：沿线光源分布发射；
- `emissionMode`：
  - `lambert`：余弦加权半球采样；
  - `gauss`：以 `angleSigma` 为 σ 的高斯偏折；
- `srcDist > 0` 时光线从空气出发，首个入射面发生折射（`inside:false`）；
- 需要入射面，若 `inputFaceIds` 为空则返回 `[]`。

**B. LED 灯珠 `_generateLEDRays()`**

- 支持发光面形状：
  - `rectangle` / `square`：`L×W` 平面，`z=-gap`，法线 +Z；
  - `concave`：凹球碗，均匀采样球冠，法线指向球心；
  - `convex`：凸球冠，法线沿径向朝外；
- 每颗灯珠一个位姿 `poses[i] = {pos, x, y, z, area}`，光线数按 `area` 加权分配；
- 局部采样点经 `world = pos + X·px + Y·py + Z·pz` 变换到世界；
- `offsetX/offsetY` 只平移灯珠发光面（装配偏心），几何不动；
- 光线起点位于空气中（`inside=false`），首次命中的入射面发生折射。

### 5.3 随机数

使用 Halton 低差异序列（基 2/3）做初步分层，叠加高斯抖动，降低蒙特卡洛噪声。

## 6. 单条光线追踪 `_traceRay(ray)`

```
while bounces < maxBounces && scatters < 500 && intensity > 1e-4:
    1. 若在介质内，排除入射面（避免从内侧反复命中入射端）
    2. raycast 求最近交点；无交点 → escaped（数值泄漏计入 residual）
    3. 体散射：以 Exp(μs) 抽样自由程；若先于表面发生
         → 按该段长度计吸收 → HG 相函数改变方向 → 继续（不占 bounces）
    4. Beer-Lambert 吸收：intensity *= exp(-α·segLen)，absorbedE 记账
    5. 表面咬花：按面组取 σ（input/output/side），高斯扰动法线
    6. 若命中出射面：尝试折射出射
         - 成功 → 记录 outputHit {p, i, d, dExit, lam}，hitOutput=true，结束
         - 全反射 → 落到通用分支继续
    7. 通用界面：
         - 从内到外遇侧面：折射成功 → escaped（sideHit 记账）；否则全反射
         - 从外到内（LED 起点）遇入射面：折射进入介质
    8. bounces++（体散射不占用反弹预算）
```

关键实现特征：

- **不做 Fresnel 分光**：界面要么全反射、要么全折射，能量只在吸收项衰减。这是毫米级导光柱的常用简化。
- **出射命中判定**：只认 `outputFaceIds` 且折射成功；从出射面全反射回体内不算成功。
- **侧面漏光**：任何非入射/出射面折射离开都记为 `side`。
- **能量守恒**：`finalIntensity`、`absorbedE`、`residualE` 与命中强度共同支撑账本。

返回结构：

```js
{
  segments: [{start, end, length, intensity, type}], // type: in-body | success | escape
  hitOutput, escaped, bounces,
  finalIntensity, absorbedE,
  outHit:  {p, i, d, dExit, lam} | null,
  sideHit: {p, i, d} | null,
  residualE
}
```

## 7. 批量追踪 `simulate(onProgress)`

1. `_generateRays()` 得到全部光线；
2. 计算可视化抽样索引：`visIdx[k] = floor(k * total / visLimit)`，**等间隔**覆盖全部入射面；
3. 逐条追踪，累计：
   - `success / escaped / exhausted`；
   - `totalIntensity`、`maxBounces`；
   - `ledger.output / side / absorbed / residual`；
   - `outputHits[]`、`sideHits[]`；
4. 每 200 条调用一次 `onProgress(done, total)`（用于 Worker 进度消息）。

返回：

```js
{
  total, success, escaped, exhausted,
  successRate: "85.3",          // 保留 1 位小数的字符串
  avgOutputIntensity: "0.532",  // 字符串
  maxBounces,
  segments,                     // 仅可视化配额
  outputHits, sideHits,
  ledger: {output, side, absorbed, residual},
  visRays
}
```

## 8. 聚合 `aggregate(results, opts)`

### 8.1 输出面基准

对所有 `outputFaceIds` 做面积加权中心 `outCenter` 与平均法向 `outNormal`，再构造屏幕正交基 `(uv, vv)`。

### 8.2 热图 `heatmap`

- 把 `outputHits` 投影到输出面平面；
- 按 `heatmapRes`（8–256，UI 使用 32/64）分箱，累加能量 `cells` 与命中数 `counts`；
- 返回 `{res, u0, u1, v0, v1, cells, counts}`。

### 8.3 均匀性指标 `metrics`

为避免单光线量化噪声，先把细网格聚合成 `nb×nb` 块（`nb = clamp(min(w,h)/3, 6, 16)`），再腐蚀边缘：

| 指标 | 定义 |
| --- | --- |
| `n` | 有效细格数（`counts > 0`） |
| `avg` / `min` / `max` | **细格**照度均值/最小/最大（保留峰值语义） |
| `avgBlk` / `minBlk` | **块**照度均值/最小 |
| `uniformity` | `minBlk / avgBlk`（0–1） |
| `cv` | 块照度标准差 / 块均值 |
| `passRatio` | 满足 `E ≥ 0.8·avgBlk` 的块占比 |
| `nCore` | 参与统计的核心块数 |

### 8.4 轴向分布 `axis`

按包围盒最长轴（`axisIndex`）把 `sideHits` 分 `axisBins` 箱，得到沿长度方向的侧漏功率分布。

### 8.5 配光角分布 `angle`

对出射与侧漏方向，按与输出面法线的夹角（0–90°）以 `angleBinDeg`（UI 用 2°）分箱。

返回：

```js
{
  heatmap, axis, angle, metrics,
  outCenter, outNormal
}
```

## 9. 静态几何工具

| API | 作用 |
| --- | --- |
| `RayTracer.cauchy(n, abbe, lamNm)` | Cauchy 色散 `n(λ)=A+B/λ²`，由 nd、Vd 反解 |
| `RayTracer._allocate(total, weights)` | 最大余数法整数分配 |
| `RayTracer.computeLEDPose(positions, indices, faceIds)` | 单颗灯珠位姿：面积加权中心 + 法向 + 正交基；探针判定朝外方向 |
| `RayTracer.computeLEDPoses(positions, indices, faceIds)` | 多颗灯珠：按平面聚类（法向夹角 <22° 且共面），每个平面一颗，附 `area` |
| `RayTracer.autoDetectEndCaps(faces, normals, centers, areas)` | 以最长轴为端面轴，按 `|axisComp| ≥ 0.7` 区分两端，返回 `{input, output}` |
| `RayTracer.buildAdjacency(faces)` | 三角面邻接表（边共享） |
| `RayTracer.expandPlanar(...)` | 平面洪水填充：法向阈值 + 距离阈值 |
| `RayTracer.expandSmooth(...)` | 单曲率平滑扩展：相邻法向夹角阈值 |
| `RayTracer.expandAuto(...)` | 自动分流：双曲率（半球）用平面逻辑，单曲率/平面用平滑链式扩展 |
| `RayTracer.fixWinding(positions, indices)` | 焊接重复顶点、统一三角形绕向，返回 `{positions, indices, welded, flipped}` |
| `RayTracer.projectSpotGrid(hits, opts)` | 纯静态光斑投影（p98 视野 + 高斯溅射 + 三方能量记账） |

### 9.1 `projectSpotGrid` 与光斑页投影的关系

`projectSpotGrid` 是引擎侧的通用实现；应用侧 `spot.js` 的 `project()` 是**页面专用增强版**（支持多波长分色、显示/指标双网格、端面半宽约束）。两者使用同一套物理口径（屏面正交基、`flux/683/numRays` 每光线功率、高斯 PSF、能量守恒），但不要混用返回值字段。

## 10. Worker 协议

主线程 → Worker：

```js
{
  meshData: { positions, indices },
  options: {
    /* 全部引擎参数 */,
    heatmapRes, axisBins, angleBinDeg,
    returnSegments: bool,
    returnSpot: bool
  }
}
```

Worker → 主线程：

| 消息 | 说明 |
| --- | --- |
| `{type:'ping'}` → `{type:'pong'}` | 存活探测 |
| `{type:'progress', done, total}` | 进度（每 200 条） |
| `{summary..., ledger, agg, elapsedMs, visRays}` | 成功结果 |
| `+ segments` | 当 `returnSegments` |
| `+ hits` | 当 `returnSpot`，即 `outputHits` |
| `{error}` | 初始化/追踪异常 |

## 11. 已知近似与边界

1. **无 Fresnel 分光**：界面不拆分反射/透射能量。
2. **表面散射为法线扰动**：不改变能量，只改变方向，用于等效咬花/雾面。
3. **体散射为单次 HG 抽样**：最多 500 次散射，避免极端参数死循环。
4. **光斑指标仅统计出射端面**：远场发散角不参与结构判定。
5. **吸收系数历史量级问题**：`store.js` 有迁移把旧 α 缩小 200 倍，见 [07-data-and-storage.md](./07-data-and-storage.md)。
6. **数值偏移**：`offset = 0.003 * gridSize` 用于避免自交；极小几何可能需调整。
