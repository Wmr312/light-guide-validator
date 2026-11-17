# 导光柱光迹模拟工具 — Code Wiki

> 面向开发者的代码级文档。项目目录：`导光柱光迹模拟工具-20261013`
> 版本标识：`light-guide-validator`（内部亦称 Light Guide Simulator v2.1）

## 1. 项目是什么

一个**纯前端、免构建**的导光柱（Light Guide）光学仿真与工程验证工具，在浏览器内完成：

1. **参数化建模 / 模型导入**：直圆柱、圆锥台、侧壁微齿、端面球冠、鼓形/收腰轮廓；导入 STL / OBJ / STEP。
2. **蒙特卡洛光线追踪**：折射、全反射、Beer-Lambert 吸收、表面咬花散射、体散射（扩散粉）、多波长色散、LED 灯珠光源。
3. **量化分析**：出射端面辐照度云图、均匀度、D86 光斑直径、沿轴侧漏分布、配光角分布、能量账本、色差。
4. **工程结论与报告**：DFM 风险清单、公差衰减、单页 HTML 报告导出（可打印/PDF）。
5. **项目与记录管理**：多项目 / 多盘位（Plate）、仿真历史记录、实测数据、JSON 导入导出，全部存 `localStorage`。

所有几何单位为 **mm**；参数化导光柱默认沿 **Z 轴**，`z=0` 为入射端（LED 侧），`z=L` 为出射端。

## 2. 技术栈与运行形态

| 维度 | 选型 | 说明 |
| --- | --- | --- |
| 语言 / 组织 | 原生 JavaScript（ES5 风格 IIFE） | 无打包器、无框架，所有模块挂到全局 `window.LG` |
| 3D 渲染 | Three.js **r137**（UMD）+ OrbitControls / STLLoader / OBJLoader | 通过 jsDelivr CDN 引入 |
| STEP 解析 | `occt-import-js@0.0.22`（CDN + WASM） | 仅在导入 `.step/.stp` 时按需加载 |
| 图表 | 手写 Canvas 2D（`js/charts.js`） | 热图 / 折线 / 极坐标 / 云图 / 径向 / 直方图，无图表库 |
| 计算并行 | Web Worker（`js/engine/raytracer.worker.js`） | Worker 失败/超时自动降级主线程 |
| 持久化 | `localStorage` | Key：`lgv.projects.v1`、`lgv.active.v1` 等 |
| 路由 | 手写 hash 路由（`#/model` 等） | `js/router.js` |

**没有 `package.json`、没有构建步骤。** 源码即产物，直接由静态服务器托管。

## 3. 快速启动

```bash
# 任选其一（必须通过 HTTP 访问，不能直接双击 index.html）
python -m http.server 8765
# 或
npx serve .
```

Windows 下可双击 `start-server.bat`（调用 `serve.ps1`，监听 8765 / 8080）。

打开 `http://localhost:8765/`。

> 为什么必须起服务器：Web Worker、STEP WASM、CDN 资源与 `Blob` 下载在 `file://` 下会被浏览器安全策略限制。

## 4. 推荐使用路径

```
Home（#/home）
   └─ 新建/打开项目
Model 配置（#/model）
   └─ 导入模型或参数化生成 → 3D 拾取入射/出射面 → 材料 / LED / 表面 / 方案
Simulate 仿真（#/simulate）
   └─ 选择快速/精确 → 运行 → 光路 + 能量账本 + 公差扫参
Analysis 结果分析（#/analysis）
   └─ 热图 / 轴向 / 配光 / 仿真 vs 实测 / 工程结论
Spot 光斑分析（#/spot，未挂导航，可直接改 hash 或由分析页内嵌入口进入）
Report 报告（#/report）
   └─ 选择历史记录 → 模板（DFM/光学）→ 生成/下载/打印
```

## 5. 文档地图

| 文档 | 内容 |
| --- | --- |
| [01-architecture.md](./01-architecture.md) | 整体分层、模块依赖、启动时序、核心数据流 |
| [02-raytracer-engine.md](./02-raytracer-engine.md) | 光线追踪引擎：API、参数、光线生成、追踪循环、聚合、几何工具 |
| [03-app-shell.md](./03-app-shell.md) | `app.js` / `store.js` / `router.js` / `i18n.js` / `options.js` |
| [04-viewer-and-geometry.md](./04-viewer-and-geometry.md) | Three.js 视图层与参数化几何生成 |
| [05-feature-modules.md](./05-feature-modules.md) | 六个业务页面模块的职责、DOM 结构、关键流程 |
| [06-analysis-and-charts.md](./06-analysis-and-charts.md) | 指标口径、光斑投影、图表 API、报告生成 |
| [07-data-and-storage.md](./07-data-and-storage.md) | 项目数据模型、localStorage、迁移、导入导出 |
| [08-development-guide.md](./08-development-guide.md) | 运行、调试、测试页、打包、二次开发约定 |
| [09-api-reference.md](./09-api-reference.md) | 全局 API 速查（`LG.*`、`RayTracer.*`） |

## 6. 目录结构

```
导光柱光迹模拟工具-20261013/
├─ index.html                 # 单页外壳：导航、语言切换、脚本清单
├─ css/style.css              # 全部样式（设计令牌 + 布局 + 组件 + 报告/光斑页）
├─ js/
│  ├─ app.js                  # 启动引导、全局状态、Worker 封装、文件导入、拖放
│  ├─ store.js                # 项目/记录/实测持久层 + 数据迁移 + JSON 导入导出
│  ├─ router.js               # hash 路由
│  ├─ i18n.js                 # 中/英双语字典与 DOM 翻译
│  ├─ geometry.js             # 参数化导光柱网格生成
│  ├─ viewer.js               # Three.js 场景、拾取、 gizmo、盘位、光线、光斑截面
│  ├─ charts.js               # Canvas 2D 图表原语
│  ├─ engine/
│  │  ├─ raytracer.js         # 光线追踪核心（Worker 兼容，无 THREE 依赖）
│  │  └─ raytracer.worker.js  # Worker 入口
│  └─ modules/
│     ├─ home.js              # 项目列表
│     ├─ model.js             # 模型配置（几何/材料/LED/表面/方案/目标）
│     ├─ simulate.js          # 仿真计算
│     ├─ analysis.js          # 结果分析
│     ├─ spot.js              # 光斑分析（可被 analysis/report 复用）
│     ├─ report.js            # 报告生成
│     └─ options.js           # 顶栏「选项」弹窗
├─ docs/                      # 使用说明 / 原理说明 / 课题演示（HTML）
├─ test/                      # 浏览器端单元测试页 + 本地服务器/打包脚本
├─ spec.md / tasks.md         # 特性规格与任务拆分（开发过程文档）
├─ generate-ppt.js            # 课题演示 PPT 生成脚本（pptxgenjs，非运行时依赖）
├─ serve.ps1 / start-server.bat
└─ LED 封装.xlsx              # LED 封装尺寸参考资料（数据资产）
```
