# 03 · 应用外壳

本文覆盖支撑整个应用运行、但不直接对应某个业务页面的 5 个文件：

| 文件 | 全局导出 | 角色 |
| --- | --- | --- |
| `js/app.js` | `LG`, `LG.Engine`, `LG.state`, `LG.fmt/esc/status/download`, `LG.parsePartFile`, `LG.importIntoProject`, `LG.restoreMeshFromProject` | 启动引导、全局工具、Worker 封装、文件导入 |
| `js/store.js` | `LG.Store` | 项目/记录/实测持久层、迁移、JSON 导入导出 |
| `js/router.js` | `LG.Router` | hash 路由与页面生命周期 |
| `js/i18n.js` | `LG.I18N`, `LG.t` | 中/英双语 |
| `js/modules/options.js` | `LG.Options` | 顶栏选项弹窗、卡片显隐、参数提示 |

## 1. `app.js`

### 1.1 全局状态 `LG.state`

见 [01-architecture.md §5](./01-architecture.md#5-全局状态)。

### 1.2 Worker 封装 `LG.Engine`

```js
LG.Engine.run(meshData, options) → Promise<payload>
LG.Engine.mode() → 'worker' | 'main'
```

实现要点（[app.js#L18-L120](file:///workspace/导光柱光迹模拟工具-20261013/js/app.js#L18-L120)）：

- **惰性创建** Worker：`new Worker('js/engine/raytracer.worker.js?v=12')`；
- 创建失败 → `workerBroken = true`，后续全部走主线程；
- **看门狗**：12 秒内没有任何消息（含 progress）→ `terminate()`，永久降级；
- 每次运行都重新 `addEventListener`，结束后移除，避免监听器泄漏；
- `onProgress` 不通过 `postMessage` 传给 Worker（函数不可克隆），在本地剥离后单独处理。

主线程降级实现 `runOnMainThread`：

- `setTimeout(..., 30)` 让出一次事件循环，避免页面卡死；
- 直接 `new RayTracer` → `simulate` → `aggregate`；
- 组装与 Worker 一致的 payload（`elapsedMs` 为 `null`）。

**payload 字段**（两条路径一致）：

```js
{
  total, success, escaped, exhausted,
  successRate, avgOutputIntensity, maxBounces,
  ledger, agg, elapsedMs, visRays,
  segments?,   // returnSegments
  hits?        // returnSpot
}
```

### 1.3 LED 位姿刷新 `LG.Engine.refreshLEDPose()`

触发时机：导入几何、拾取/切换入射面、LED 参数保存、XY 偏移变化。

逻辑：

1. 仅当 `led.enabled && mesh.isParametric === false`（手动导入模型）且存在入射面时，按 `beads[]` 逐颗计算位姿；
2. 每颗灯珠的入射面 → `RayTracer.computeLEDPose(...)`；
3. 与 `led.poses` 比较（位置与 z 轴），有变化才写回 Store；
4. 同步 `LG.Viewer.setLED(led)`；
5. 参数化圆柱等场景 `poses = null`，引擎与视图回退默认坐标。

> 语义变化：早期版本按平面自动聚类拆成多颗灯珠；现在**灯珠数量只由用户手动增减**，`beads` 的每一项对应一颗灯珠，Shift 多选只扩展该灯珠的入射范围。

### 1.4 文件导入管线

```
File
 ├─ .stl  → THREE.STLLoader.parse(ArrayBuffer)
 ├─ .obj  → THREE.OBJLoader.parse(text)
 └─ .step/.stp → 动态加载 occt-import-js（CDN + WASM）→ 合并多 mesh
        │
        ▼
RayTracer.fixWinding(positions, indices)   // 焊接顶点 + 统一绕向
        │
        ▼
{positions: Float32Array, indices: Uint32Array, name, welded, flipped}
```

对外 API：

| API | 说明 |
| --- | --- |
| `LG.parsePartFile(file, cb)` | 统一解析入口，`cb(err, parsed)` |
| `LG.importIntoProject(projId, parsed)` | 写 `geometry.fileName`、`meshCache`、`geometry._mesh`；若该项目正在显示则重建网格、自动识端面、刷新 LED 位姿 |
| `LG.restoreMeshFromProject(proj)` | 刷新后从 `geometry._mesh` 恢复到内存缓存 |

**网格持久化阈值**（[app.js#L280-L329](file:///workspace/导光柱光迹模拟工具-20261013/js/app.js#L280-L329)）：

- 估算 JSON 体积 `positions.length*8 + indices.length*6`（约 8 字节/顶点、6 字节/索引）；
- `> 256KB` 不写 `geometry._mesh`，只留在 `LG.state.meshCache`；
- 目的：避免撑爆 5MB 量级的 `localStorage`。超大模型刷新后需重新导入。

### 1.5 拖放导入 `handleFileDrop(files, projectId)`

- 只接受 `stl/obj/step/stp`；
- **默认「新增零件」到目标盘**（共享 `plateId`），不覆盖已有零件；
- 例外：目标盘 = 当前盘，且当前项目还没有几何 → 第一个文件直接补进当前项目（与文件导入一致）；
- 多文件串行解析，全部完成后激活最后导入的项目、重渲染当前路由、显示汇总状态。

### 1.6 工具函数

| API | 行为 |
| --- | --- |
| `LG.fmt(v, digits=3)` | 数值格式化，`null/NaN` → `'-'` |
| `LG.esc(s)` | HTML 转义 `& < >` |
| `LG.status(msg)` | 底部状态条，3 秒后自动隐藏 |
| `LG.download(filename, text, mime)` | Blob 下载，1 秒后回收 URL |

## 2. `store.js` — 持久层

### 2.1 存储键

| Key | 内容 |
| --- | --- |
| `lgv.projects.v1` | 项目数组（JSON） |
| `lgv.active.v1` | 当前激活项目 id |
| `lgv.ledEnabledDefault.v1` | 一次性迁移标记 |
| `lgv.lang` | 语言 |
| `lgv.ui.hiddenSections` | 模型页隐藏卡片 id 数组 |
| `lgv.ui.showTips` | 参数提示开关（默认开） |
| `lgv.simMode` | `quick` / `precise` |
| `lgv.simTol` | 公差扫参开关 |
| `lgv.spotSec` | 3D 出射光斑截面开关 |

### 2.2 API

| API | 说明 |
| --- | --- |
| `ensureProject()` | `load()` + 迁移；无项目则 `create()`；返回 active |
| `create(name)` | 新建项目，`plateId = id`，插入队首并激活 |
| `list()` / `active()` / `get(id)` | 查询 |
| `setActive(id)` / `rename(id, name)` / `remove(id)` | 激活、重命名、删除 |
| `updateActive(patch)` / `update(id, patch)` | 浅合并字段并持久化 |
| `plateIdOf(proj)` | 老项目无 `plateId` 时按自身 id 兜底 |
| `move(id, toIndex)` | 调整项目/盘顺序 |
| `toggleLock(id)` | 盘锁定（禁止删除/移动/改参） |
| `addRecord(rec)` / `removeRecord(id)` / `getRecord(id)` | 仿真历史 |
| `addMeasurement(m)` / `removeMeasurement(id)` | 实测数据 |
| `exportJSON()` | 下载 `{app, version:1, projects}` |
| `importJSON(text)` | 兼容裸数组；为每个项目重新生成 id，补默认字段 |
| `defaults()` | 返回完整默认项目结构 |
| `MATERIAL_ABBE` / `defaultAbbe(preset)` | 预设 → 阿贝数 |

### 2.3 迁移（`load()` 时自动、幂等）

| 迁移 | 作用 |
| --- | --- |
| `migrateMaterialAbsorption` | 旧 α 量级偏大约 200 倍；按 `PRESET_REMAP` 修正预设，自定义 α `>0.01` 则 `/200` |
| `migrateMaterialMeta` | 补 `material.abbe`、`material.diffusion`、`source.spectrum` |
| `migrateEngConfig` | 补 `scheme`、`eng`、`eng.targets`、`geometry.surface`；由旧 `material.preset` 反查材料库 key |
| `migrateLedEnabledDefault` | 一次性把老项目的 `led.enabled=false` 改为 `true`，之后尊重用户设置 |

### 2.4 数据模型

完整字段见 [07-data-and-storage.md](./07-data-and-storage.md)。

## 3. `router.js` — 路由

```js
LG.Router.register(name, { render(el) { ...; return cleanup; } });
LG.Router.init();          // 绑定 hashchange，立即导航
LG.Router.current();       // 当前路由名
LG.Router.rerender();      // 保持 hash，重渲染（语言切换用）
```

行为：

- `#/xxx` → `routes.xxx`；未知 hash 回退 `model`，并把 `current` 设为 `model`；
- 每次导航**先 cleanup 上一个页面**，再清空 `#view`；
- 导航高亮：`href === '#/' + current`；
- render 抛异常时渲染错误卡片，外壳仍可用。

## 4. `i18n.js` — 国际化

- 字典结构：`dict.zh` / `dict.en`，扁平 key（如 `model.matlib`、`ana.cl.bright.ok`）；
- `LG.t(key, ...args)`：按当前语言取词，缺失回退中文，再回退 key 本身；`{0}{1}` 占位替换；
- `LG.I18N.tFor(lang)`：返回指定语言的翻译函数，**报告导出**用它固定语言；
- `LG.I18N.setLang('zh'|'en')`：写 `localStorage`、设置 `<html lang>`、`applyI18n(document)`、派发 `lg:lang`；
- `applyI18n(root)`：扫描 `[data-i18n]`（textContent）与 `[data-i18n-ph]`（placeholder），并更新语言按钮激活态；
- `app.js` 监听 `lg:lang` → `Router.rerender()`。

> 页面模块的 HTML 全部在 `render()` 内用 `LG.t(...)` 拼接，因此语言切换必须整页重渲染，不能只翻译静态 DOM。

## 5. `modules/options.js` — 界面选项

- 自初始化（`DOMContentLoaded` 或立即）绑定 `#opts-btn`；
- `SECTIONS`：模型配置页 6 张卡片（build / mat / surface / led / env / goals），勾选状态存 `lgv.ui.hiddenSections`；
- `HELP_MAP`：控件 id → `help.*` 文案，为标签插入 `?` 图标与悬浮提示；
- `afterRender()`：页面渲染后应用卡片显隐与提示（由 `model.js` 在 render 末尾调用）；
- `LG.Options.getHidden / setHidden / tipsOn / setTips / afterRender / open / close`。

`open()` 同时提供「打开软件使用说明」入口，指向 `docs/user-guide.html`。
