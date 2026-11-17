# 04 · 3D 视图与参数化几何

| 文件 | 职责 |
| --- | --- |
| [js/viewer.js](file:///workspace/导光柱光迹模拟工具-20261013/js/viewer.js) | 唯一的 Three.js 场景：网格渲染、面拾取、位姿 gizmo、LED 灯珠、光线、光斑截面、盘位、文件拖放 |
| [js/geometry.js](file:///workspace/导光柱光迹模拟工具-20261013/js/geometry.js) | 参数化导光柱网格生成（纯数学，无 THREE） |

## 一、`LG.Viewer`

### 1. 单例与生命周期

`viewer.js` 是**单例**：整个应用只有一个 `scene / camera / renderer`，页面通过 `mount(slot)` 把同一个 `<canvas>` 移动/挂载到不同容器。

```js
LG.Viewer.mount(slot)    // 首次调用 ensure() 初始化；之后仅 append canvas
LG.Viewer.unmount()      // 从 DOM 移除 canvas、解绑拖放、clearPlates
LG.Viewer.resize(w, h)
LG.Viewer.isReady()      // renderer 是否已创建
```

初始化 `ensure()` 的一次性内容：

- `Scene`，背景 `0xE7F0F9`；
- `PerspectiveCamera(50, 1, 0.01, 5000)`；
- `WebGLRenderer({antialias:true})`，pixelRatio 跟随设备；
- `OrbitControls`，`enableDamping=true, dampingFactor=0.08`；
- 环境光 + 两盏平行光 + 地面网格；
- `requestAnimationFrame` 主循环：`controls.update → render → updateGizmo → updatePlateUI`。

> 场景常驻，切页只移动 canvas，不销毁 WebGL 上下文，避免反复创建导致的显存与性能问题。

### 2. 坐标变换（mm ↔ 显示）

建模与仿真始终使用 **mm 原始坐标**。视图为了适配相机做了两级变换：

1. **几何归一化**：`setGeometryData` 把网格平移到包围盒中心，再整体缩放 `scale = 4 / maxDim`；
2. **零件位姿**：`mesh.position / rotation`，来自项目 `geometry.transform`（mm / deg）。

记录为 `xform = {cx, cy, cz, scale}`。光线、LED、光斑截面等外部 mm 坐标必须经 `tx3()` 同步变换：

```js
screen = R(mesh.rotation) · ((p_mm - center) * scale) + mesh.position
```

### 3. 网格与面数据

`setGeometryData(positions, indices, name)`：

1. 构建 `THREE.BufferGeometry`；导入网格缺 `normal` 时补算；
2. 平移居中 + 统一缩放；
3. 材质：`MeshPhongMaterial`，颜色 `#218D83`，透明度 0.5，双面，`depthWrite:false`；
4. 叠加 `EdgesGeometry` 边线；
5. 构建 `faces / faceNormals / faceCenters / faceAreas` 与邻接表（供拾取扩展）；
6. `fitView()`、`applyLED()`、恢复项目位姿。

`buildFaceData()` 与引擎的 `_buildFaceData()` 独立实现（一个用 THREE.Vector3，一个用内部 V3），但索引语义一致：**面索引 = 三角形序号**，是 `project.faces.input/output` 的存储单位。

### 4. 端面高亮与拾取

| API | 说明 |
| --- | --- |
| `setFaceHighlights(inputIds, outputIds)` | 蓝色 `#3b82f6` 标入射面，黄色 `#eab308` 标出射面；高亮 Mesh 挂在 `mesh` 下以继承位姿 |
| `clearFaceHighlights()` | 释放高亮资源 |
| `setPick(role, cb)` | 进入拾取模式；`cb(role, ids, meta)` |
| `computeFacePickUpdate(existing, group, {shiftKey, faceIndex})` | 纯函数：普通点击替换、Shift 累加、点击已选种子面取消整组 |
| `autoEndCaps()` | 调用 `RayTracer.autoDetectEndCaps` 自动识别两端 |
| `faceCount()` | 三角面数量 |

点击流程（[viewer.js#L84-L163](file:///workspace/导光柱光迹模拟工具-20261013/js/viewer.js#L84-L163)）：

1. 指针按下记录坐标；click 位移 > 5px 视为拖拽旋转，不拾取；
2. 优先命中盘面快捷 Sprite；
3. 拾取模式下命中网格 → `RayTracer.expandAuto(...)` 洪水填充扩展同组面 → `onPick`；
4. 放置模式 → 透明候选面 / 盘面；
5. 命中零件 → 选中；命中同盘其它零件示意网格 → 切盘；命中其它盘面 → 切盘；
6. 空白 → 取消选中。

`expandAuto` 的策略：
- 双曲率表面（如半球）→ 平面逻辑，法向 <22°，不链式扩展；
- 单曲率 / 平面（圆柱、圆锥、凹槽弧面）→ 平滑链式扩展，相邻法向 <30°。

### 5. 位姿操作（移动 / 旋转 / 放置）

```js
LG.Viewer.setMode('' | 'move' | 'rotate' | 'place');
LG.Viewer.getMode();
LG.Viewer.getTransform(); // {posX,posY,posZ,rotX,rotY,rotZ}，mm / deg
LG.Viewer.onSelectChange(cb);
LG.Viewer.onModeChange(cb);
LG.Viewer.onTransformChange(cb);
```

- 只有 `partSelected` 为真时 gizmo 才创建，且挂在 `mesh` 下；
- `move`：三轴箭头，拖动按屏幕射线投影换算 mm；
- `rotate`：三色圆环 + 中线辅助；
- `place`：在场景中拾取透明候选面，贴合盘面垂直放置；
- 拖拽结束写回 `project.geometry.transform`。

### 6. 光线可视化

```js
LG.Viewer.showRays(segments);
LG.Viewer.clearRays();
```

- 按 `type` 分色：`success` 红 `#dc143c`、`in-body` 靛 `#4b0082`、`escape` 橙 `#ff8c00`；
- 亮度按段强度 `0.15 + 0.85·i`；
- 统一 `depthTest:false`，避免光线在透明柱体内被遮挡；
- 每个 type 合并为一个 `LineSegments`，减少 draw call。

### 7. 光斑截面

```js
LG.Viewer.showSpotSection(proj);   // proj: spot.project() 的结果
LG.Viewer.clearSpotSection();
```

- 优先使用 `proj.disp`（256×256 显示网格），回退 `E/Etot`（64×64 指标网格）；
- 用 `LG.Charts.jetRGB(t)` 生成伪彩 `CanvasTexture`；
- 平面位姿由 `(uv, vv, on)` 构造基矩阵，并叠加 mesh 四元数；
- 屏沿法线外移 `0.5%` 屏宽，`polygonOffset` 防 z-fighting；
- `renderOrder = 5`，确保盖在端面高亮（3）与零件（1）之上。

### 8. LED 灯珠可视化

```js
LG.Viewer.setLED(led);    // 读取 led.enabled / 尺寸 / poses
LG.Viewer.clearLED();
```

- 每颗灯珠一个 `THREE.Group`，按 `poses[i]` 摆放（`pos + X·px + Y·py + Z·pz`）；
- 矩形/方形为 Box，凹面/凸面为球冠近似；
- `led.offsetX/offsetY` 只平移灯珠，不动导光柱；
- 参数化场景无 `poses` 时使用默认坐标（入射端 `z=0` 附近）。

### 9. 盘位（Plate）

模型配置页把多个项目以「盘」的形式平铺展示（类 OrcaSlicer 打印床）：

```js
LG.Viewer.setPlates(items, activeId, tips);
LG.Viewer.clearPlates();
LG.Viewer.onPlatePick(pid => ...);
LG.Viewer.onPlateTool((pid, action) => ...);
LG.Viewer.fitPlates();
```

- `items`：`[{id, name, parts:[{id,...}], locked, ...}]`，同一 `plateId` 的项目共享一块盘；
- 盘面为格栅纹理 Plane，当前盘用深色纹理；
- 盘面高度 = 当前零件世界包围盒最低点 − 0.02，避免盘面盖住零件；
- 盘上提供 Sprite 快捷按钮（切换/删除/锁定等），点击优先于网格拾取；
- 布局常量 `PLATE_COLS / PLATE_W / PLATE_D / PLATE_GAP` 在文件顶部。

### 10. 文件拖放

```js
LG.Viewer.onFilesDrop((files, projectId) => ...);
```

- `bindFileDrop(slot)` 监听 `dragenter/over/leave/drop`；
- 命中盘面时把 `projectId` 一并回调（由 `app.js` 的 `handleFileDrop` 决定新建零件还是补进当前项目）；
- 拖入时显示覆盖层提示。

### 11. 导出与测试钩子

| API | 说明 |
| --- | --- |
| `screenshot(w, h)` | 返回 `dataURL`；带尺寸时用离屏 canvas 缩放为 JPEG(0.72) |
| `raw()` | 当前原始网格 `{positions, indices, name}` |
| `_pickPlate(id)` | 测试用切盘 |
| `_plateButtons()` / `_plateBtnScreenSize(i)` / `_plateBtnRect(i)` | 盘面按钮的屏幕尺寸/矩形，用于验证随相机缩放 |
| `_ledMesh()` / `_ledMeshes()` | 当前 LED 位姿组 |
| `_xform()` | 归一化参数 |
| `_highlights()` | 端面高亮状态与父级 |
| `_rayPositions()` | 变换后的光线顶点数组 |
| `_spotSection()` | 当前光斑截面组 |

## 二、`LG.Geometry.build(g)`

```js
const { positions, indices, meta } = LG.Geometry.build(project.geometry);
```

- 单位 mm，轴向 +Z：`z=0` 入射端，`z=L` 出射端；
- 返回 `Float32Array` / `Uint32Array`，可直接给引擎与视图。

### 1. 输入参数

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `length` | 30 | 总长（最小 0.5） |
| `d1` / `d2` | 3 / 3 | 入射端 / 出射端直径（最小 0.1） |
| `radialSeg` | 48 | 圆周分段（12–128） |
| `teeth` | 关闭 | `{enabled, step, width, aStart, aEnd, offset}` 侧壁全环 V 形微齿 |
| `surface.inputCurve/outputCurve` | `flat` | `flat` / `convex` / `concave` |
| `surface.inputCurveR/outputCurveR` | 20 | 球冠半径（钳制 `≥ 2r`） |
| `surface.sideProfile` | `straight` | `straight` / `bulge` / `waist` |
| `surface.sideDeltaR` | 0.3 | 鼓形/收腰的抛物线幅值 Δr |

### 2. 生成算法

```
r(z) = r1 + (r2 - r1)·z/L
        + 4·Δr·(z/L)(1 - z/L)   // bulge；waist 取负
```

**侧带**：由 `stations[]`（z, r 序列）相邻两项调用 `addBand` 生成圆台面（两圈顶点 + 四边形三角化）。

**微齿**：从 `teeth.offset` 开始，每隔 `step` 放一组三个 station：

```
(z, r(z)) → (z+half, r(z+half) - d) → (z+width, r(z+width))
```

齿角 `θ` 从 `aStart` 线性渐变到 `aEnd`，`d = half·tan(90° - θ)`，并钳制为 `≤ 0.45·min(r1, r)`；齿数上限 400。

**端盖**：
- 平面：中心顶点 + 一圈环扇形三角化；
- 球冠：径向 10 环（`K=10`），`z(ρ) = zEnd + outSign·curveSign·(h - s(ρ))`，`s(ρ)=R-√(R²-ρ²)`，`h=R-√(R²-r²)`；
- 绕向按 `faceUp` 决定，保证入射端法线 −Z、出射端 +Z。

### 3. 输出

```js
{
  positions: Float32Array,
  indices: Uint32Array,
  meta: { stations, teeth, faces }
}
```

### 4. 与导入模型的关系

| 场景 | 路径 |
| --- | --- |
| `useParametric = true` | `LG.Geometry.build(project.geometry)` |
| 导入 STL/OBJ/STEP | `LG.parsePartFile` → `RayTracer.fixWinding` → `LG.importIntoProject` |
| 导入后仍显示参数 | 参数仅作存档，`mesh.isParametric = false` |

导入模型的面索引由焊接后的三角形顺序决定，因此**重新导入可能改变面索引**——项目里保存的 `faces.input/output` 需要重新拾取，`importIntoProject` 会自动做一次端面识别并覆盖。
