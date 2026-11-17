# 09 · 全局 API 速查

所有 API 挂在 `window.LG` 下（引擎类 `RayTracer` 例外）。签名使用 ES5 风格。

## 1. `LG` 根命名空间

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `LG.state` | Object | `{project, mesh, meshCache, lastRun}` |
| `LG.Engine` | Object | `{run, mode, refreshLEDPose}` |
| `LG.Store` | Object | 持久层，见 §2 |
| `LG.Viewer` | Object | 3D 视图，见 §3 |
| `LG.Charts` | Object | 图表，见 §4 |
| `LG.Geometry` | Object | `{build}` |
| `LG.I18N` / `LG.t` | Object / Function | 国际化 |
| `LG.Router` | Object | 路由 |
| `LG.Options` | Object | 界面选项 |
| `LG.Modules` | Object | `{home, model, simulate, analysis, spot, report}` |
| `LG.fmt(v, digits)` | Function | 数值格式化，缺省 3 位，`NaN → '-'` |
| `LG.esc(s)` | Function | HTML 转义 |
| `LG.status(msg)` | Function | 底部状态条，3s 自动隐藏 |
| `LG.download(filename, text, mime)` | Function | Blob 下载 |
| `LG.parsePartFile(file, cb)` | Function | 解析 STL/OBJ/STEP，`cb(err, parsed)` |
| `LG.importIntoProject(projId, parsed)` | Function | 写入项目并同步网格/端面/LED |
| `LG.restoreMeshFromProject(proj)` | Function | 从 `geometry._mesh` 恢复内存缓存 |

### 1.1 `LG.Engine`

```js
LG.Engine.run(meshData, options) → Promise<payload>
LG.Engine.mode() → 'worker' | 'main'
LG.Engine.refreshLEDPose() → poses | null
```

`meshData`：`{positions, indices}`（也接受 `THREE.Mesh`）。

`options`：见 [02-raytracer-engine.md §3](./02-raytracer-engine.md#31-options-字段)，额外支持：

| 字段 | 说明 |
| --- | --- |
| `heatmapRes` | 热图分辨率（8–256） |
| `axisBins` | 轴向分箱数 |
| `angleBinDeg` | 配光角分箱（deg） |
| `returnSegments` | 是否回传 3D 轨迹 |
| `returnSpot` | 是否回传 `outputHits` |
| `onProgress(done, total)` | 进度回调（不进入 Worker） |

`payload`：`{total, success, escaped, exhausted, successRate, avgOutputIntensity, maxBounces, ledger, agg, elapsedMs, visRays, segments?, hits?}`。

## 2. `LG.Store`

| API | 返回 | 说明 |
| --- | --- | --- |
| `ensureProject()` | Project | 加载 + 迁移 + 必要时新建 |
| `create(name?)` | Project | 新建项目，独占新盘，设为激活 |
| `list()` | Project[] | 全部项目（引用，勿直接改结构） |
| `active()` | Project \| null | 当前激活项目 |
| `get(id)` | Project \| null | 按 id 取 |
| `setActive(id)` | void | 切换激活 |
| `rename(id, name)` | void | 重命名 |
| `remove(id)` | void | 删除；若为激活项则激活下一个 |
| `updateActive(patch)` | Project | 浅合并当前项目并保存 |
| `update(id, patch)` | Project | 浅合并任意项目并保存 |
| `plateIdOf(proj)` | string | 盘标识兜底（老项目 = 自身 id） |
| `move(id, toIndex)` | boolean | 调整盘顺序 |
| `toggleLock(id)` | boolean | 切换锁定，返回新值 |
| `addRecord(rec)` | Record | 插入历史（自动 id/time，头插） |
| `removeRecord(recId)` | void | 删除记录 |
| `getRecord(recId)` | Record \| null | 查询记录 |
| `addMeasurement(m)` | Measurement | 插入实测数据 |
| `removeMeasurement(id)` | void | 删除实测 |
| `exportJSON()` | void | 触发下载 |
| `importJSON(text)` | number | 导入条数（重新生成 id） |
| `defaults()` | Object | 完整默认项目结构 |
| `MATERIAL_ABBE` | Object | `"n,alpha" → Vd` |
| `defaultAbbe(preset)` | number | 预设对应阿贝数，缺省 57.4 |

> `update` / `updateActive` 是**浅合并**：传 `{led: {...}}` 会整块替换 `led`，应传完整对象。

## 3. `LG.Viewer`

### 3.1 生命周期

| API | 说明 |
| --- | --- |
| `mount(slot)` | 首次初始化并挂载 canvas |
| `unmount()` | 移除 canvas、解绑拖放、清盘 |
| `resize(w, h)` | 手动调整 |
| `isReady()` | 场景是否已初始化 |
| `hasGeometry()` | 是否已有网格 |
| `fitView()` / `fitPlates()` | 框选视图 / 框选全部盘 |

### 3.2 几何

| API | 说明 |
| --- | --- |
| `setGeometryData(positions, indices, name)` | 构建网格、面数据、材质、边线，重置视图 |
| `clearGeometry()` | 清除网格 |
| `raw()` | `{positions, indices, name}` 原始 mm 网格 |
| `faceCount()` | 三角面数 |
| `autoEndCaps()` | 自动识别端面，返回 `{input, output}` |
| `setFaceHighlights(inputIds, outputIds)` | 端面高亮 |
| `clearFaceHighlights()` | 清除高亮 |
| `setPick(role, cb)` | 进入拾取模式 |
| `computeFacePickUpdate(existingIds, groupIds, opts)` | 纯函数，合并/取消选择 |

### 3.3 位姿

| API | 说明 |
| --- | --- |
| `setTransform(tr)` / `getTransform()` | mm / deg 位姿 |
| `setMode(''|'move'|'rotate'|'place')` / `getMode()` | 操作模式 |
| `selectMesh()` / `deselectMesh()` / `isSelected()` | 零件选中 |
| `onSelectChange(cb)` / `onModeChange(cb)` / `onTransformChange(cb)` | 回调注册 |

### 3.4 效果

| API | 说明 |
| --- | --- |
| `showRays(segments)` / `clearRays()` | 光路 |
| `showSpotSection(proj)` / `clearSpotSection()` | 出射光斑截面 |
| `setLED(led)` / `clearLED()` | LED 灯珠 |
| `screenshot(w?, h?)` | PNG，或指定尺寸的 JPEG(0.72) |

### 3.5 盘与拖放

| API | 说明 |
| --- | --- |
| `setPlates(items, activeId, tips)` | 铺盘 |
| `clearPlates()` | 清盘 |
| `onPlatePick(cb)` | 点击盘回调 `(projectId)` |
| `onPlateTool(cb)` | 盘快捷控件回调 `(pid, action, btn)` |
| `onFilesDrop(cb)` | 拖放回调 `(files, projectId)` |

### 3.6 测试钩子

`_pickPlate / _plateButtons / _plateBtnScreenSize / _plateBtnRect / _ledMesh / _ledMeshes / _xform / _highlights / _rayPositions / _spotSection`。

## 4. `LG.Charts`

| API | 返回 | 说明 |
| --- | --- | --- |
| `setup(canvas)` | `{ctx, w, h}` | DPR 适配 |
| `jet(t)` | `[r,g,b]` | 色阶 |
| `jetRGB(t)` | string | CSS 颜色 |
| `computeMetrics(heat, threshold=0.8)` | metrics | 均匀度等 |
| `drawHeatmap(canvas, heat, metrics)` | void | 热图 + 色标 |
| `drawLineChart(canvas, values, opts)` | `{avg, peaks, valleys}` | 折线 |
| `drawPolar(canvas, angle)` | `{beamAngle}` | 极坐标 |
| `drawSpotCloud(canvas, spot, opts)` | `{ox, oy, size, res, half}` | 光斑云图 |
| `drawRadial(canvas, radial, opts)` | `{peak, r86, rFwhm}` | 径向 |
| `drawHistogram(canvas, hist, opts)` | `{peakCount, mean}` | 直方图 |

## 5. `LG.Geometry`

```js
LG.Geometry.build(geometry) → {positions, indices, meta}
```

输入输出见 [04-viewer-and-geometry.md §二](./04-viewer-and-geometry.md#二lggeometrybuildg)。

## 6. `LG.I18N`

| API | 说明 |
| --- | --- |
| `LG.t(key, ...args)` | 当前语言翻译；缺失回退中文→key；`{0}` 占位 |
| `LG.I18N.t(key, ...args)` | 同上 |
| `LG.I18N.tFor(lang)` | 返回指定语言的 `t`（报告用） |
| `LG.I18N.setLang('zh'|'en')` | 持久化 + 应用 + 派发 `lg:lang` |
| `LG.I18N.applyI18n(root?)` | 翻译 `[data-i18n]` / `[data-i18n-ph]` |
| `LG.I18N.lang()` | 当前语言 |

## 7. `LG.Router`

| API | 说明 |
| --- | --- |
| `register(name, mod)` | `mod.render(el)` 返回 cleanup |
| `init()` | 绑定 hashchange 并立即导航 |
| `current()` | 当前路由名 |
| `rerender()` | 保持 hash 重渲染 |

## 8. `LG.Options`

| API | 说明 |
| --- | --- |
| `getHidden()` / `setHidden(ids)` | 模型页隐藏卡片 |
| `tipsOn()` / `setTips(on)` | 参数提示开关 |
| `afterRender(el)` | 页面渲染后应用偏好 |
| `open()` / `close()` | 选项弹窗 |

## 9. `RayTracer`

构造函数：`new RayTracer(meshData, options)`。

| 实例方法 | 返回 |
| --- | --- |
| `simulate(onProgress?)` | `{total, success, escaped, exhausted, successRate, avgOutputIntensity, maxBounces, segments, outputHits, sideHits, ledger, visRays}` |
| `aggregate(results, opts)` | `{heatmap, axis, angle, metrics, outCenter, outNormal}` |

静态方法：

| 方法 | 说明 |
| --- | --- |
| `cauchy(n, abbe, lamNm)` | 色散折射率 |
| `computeLEDPose(positions, indices, faceIds)` | 单灯珠位姿 |
| `computeLEDPoses(positions, indices, faceIds)` | 多灯珠位姿（按平面聚类） |
| `autoDetectEndCaps(faces, normals, centers, areas)` | 自动识端面 |
| `buildAdjacency(faces)` | 面邻接表 |
| `expandPlanar(...)` / `expandSmooth(...)` / `expandAuto(...)` | 面组扩展 |
| `fixWinding(positions, indices)` | 焊接 + 统一绕向 |
| `projectSpotGrid(hits, opts)` | 通用光斑投影 |

常量：`RayTracer.IDENTITY_LED_POSE`。

## 10. 页面模块

| 模块 | 导出 |
| --- | --- |
| `LG.Modules.home` | `{render}` |
| `LG.Modules.model` | `{render}` |
| `LG.Modules.simulate` | `{render}` |
| `LG.Modules.analysis` | `{render, buildConclusion, engStats}` |
| `LG.Modules.spot` | `{render, capture, projectLastRun, buildView}` |
| `LG.Modules.report` | `{render}` |

## 11. 关键数据结构速查

```js
// 网格
mesh = { positions: Float32Array, indices: Uint32Array, faceCount, name, isParametric }

// 仿真 payload
payload = {
  total, success, escaped, exhausted, successRate, avgOutputIntensity, maxBounces,
  ledger: {output, side, absorbed, residual},
  agg: {heatmap, axis, angle, metrics, outCenter, outNormal},
  elapsedMs, visRays, segments?, hits?, params?, tolerance?, mode?, simMode?
}

// 热图
heatmap = { res, u0, u1, v0, v1, cells: Float64Array, counts: Int32Array }

// 光斑投影（spot.project）
spot = {
  d, res, half, cellMM, A_cell, perRayW,
  center, on, uv, vv,              // 屏心 / 法线 / 面内正交基
  us, vs, ws, lamOf,               // 投影后的命中点与能量
  Ptot, Etot, Plam, lamKeys, lamStat, Emax,
  disp: {res, Etot, Plam, Ptot, Emax, cellMM, A_cell},  // 256 显示网格
  radial, r86, rFwhm,
  metrics, chroma, hist,
  outside, outsidePow, clipPow, conserve
}
```
