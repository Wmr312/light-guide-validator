# 08 · 开发、测试与发布

## 1. 运行

### 1.1 必需：HTTP 静态服务器

```bash
cd 导光柱光迹模拟工具-20261013
python -m http.server 8765
# 或 npx serve -l 8765 .
```

打开 `http://localhost:8765/`。

Windows 也可双击 `start-server.bat`：

- 由 `serve.ps1` 启动 .NET `HttpListener`，同时监听 `8765` 与 `8080`（localhost + 127.0.0.1）；
- 自动打开浏览器；
- 响应头强制 `no-store`，避免调试时缓存旧 JS；
- 关闭 PowerShell 窗口即停止。

> 不要用 `file://` 直接打开 `index.html`：Worker、`occt-import-js` 的 WASM、CDN 资源与 Blob 下载都会失败。

### 1.2 无需安装依赖

项目没有 `package.json` / `node_modules`。Three.js、OrbitControls、STLLoader、OBJLoader、STEP 解析器均从 CDN 加载（见 `index.html`）。离线部署需自行把以下文件下载到 `vendor/` 并改写 `<script src>`：

| 资源 | 版本 |
| --- | --- |
| `three.min.js` | 0.137.0 |
| `OrbitControls.js` | r137（examples/js） |
| `STLLoader.js` / `OBJLoader.js` | r137（examples/js） |
| `occt-import-js.js` + `.wasm` | 0.0.22 |

### 1.3 浏览器要求

- 支持 WebGL 1.0、Web Worker、`localStorage`、`Blob`、`FileReader`；
- 推荐 Chrome / Edge 最新版（开发与测试基准）；
- Safari 对 `HttpListener` 无关，但 WebGL 性能较弱；
- 不支持 IE。

## 2. 调试

### 2.1 控制台常用入口

```js
LG.state                 // 全局状态：project / mesh / lastRun
LG.Store.list()          // 全部项目
LG.Store.active()        // 当前项目
LG.Store.defaults()      // 默认结构
LG.Engine.mode()         // 'worker' | 'main'
LG.Viewer.isReady()
LG.Viewer._xform()       // 归一化参数（mm → 显示）
LG.Viewer._rayPositions()
JSON.stringify(LG.state.lastRun.agg.metrics)
```

### 2.2 关闭 Worker 验证主线程路径

在 `app.js` 顶部临时设置 `var workerBroken = true;`，或直接在控制台 `LG.Engine.mode()` 观察降级后是否一致。也可在 Worker 内部 `throw` 触发降级。

### 2.3 重新跑一次纯引擎计算

```js
const m = LG.state.mesh;
const p = LG.state.project;
const opts = {
  n: p.material.n, alpha: p.material.alpha, abbe: p.material.abbe,
  numRays: 500, maxBounces: 30,
  inputFaceIds: p.faces.input, outputFaceIds: p.faces.output,
  led: p.led, heatmapRes: 32,
  returnSpot: true, returnSegments: true
};
LG.Engine.run(m, opts).then(r => console.log(r));
```

### 2.4 调试几何/端面

```js
LG.Viewer.faceCount();
LG.Viewer.autoEndCaps();
LG.Viewer._highlights();     // 高亮组是否挂在 mesh 下
LG.Viewer._pickPlate(id);    // 切盘
```

### 2.5 常见现象

| 现象 | 排查 |
| --- | --- |
| 页面空白、无报错 | 是否 `file://`；看 Console 的 CORS/CDN 错误 |
| 改了 JS 但没生效 | `index.html` 的 `?v=N` 未改；或服务器缓存（`serve.ps1` 已禁缓存） |
| 「请重新导入」 | 网格 >256KB 或清空了 localStorage，属于预期 |
| 光线在柱内消失 | 检查 `material.alpha` 量级（应 1e-4–2e-3） |
| 仿真很慢 | 光线数/反弹过高；改用快速模式；检查是否意外降级主线程 |
| 光斑全黑 | `outputFaceIds` 为空或选错；确认 `faces.output` |
| 导入 STEP 失败 | CDN/WASM 不可达；检查网络 |
| 报告图片空白 | 需先运行仿真使 `lastRun` 存在；报告生成依赖当前会话数据 |

## 3. 测试

项目提供两个**浏览器端单元测试页**，直接通过本地服务器打开：

| 页面 | 覆盖内容 |
| --- | --- |
| `test/coordinate-test.html` | 光线坐标系对齐：LED 局部坐标 → 世界坐标、`tx3` 变换、入射/出射法线方向、`computeLEDPose` |
| `test/led-test.html` | LED 灯珠组件：矩形/凹/凸发光面采样、面积权重、位姿与偏移、`expandAuto` 面组扩展 |

运行方式：打开页面即执行，页面内以卡片形式显示 PASS/FAIL 与断言明细。没有 Node 测试运行器，也没有 CI 配置。

辅助脚本：

| 脚本 | 用途 |
| --- | --- |
| `test/serve.ps1` | 与根目录 `serve.ps1` 相同的轻量服务器 |
| `test/check-server.ps1` | 检查端口/服务器是否存活 |
| `test/kill-port.ps1` | 释放被占用的端口 |
| `test/pack.ps1` | 打包 zip（硬编码了开发者本机路径，使用前需修改 `$src`） |

### 3.1 修改算法后的最小回归集

1. `coordinate-test.html` 全绿；
2. `led-test.html` 全绿；
3. 参数化圆柱（L=30, d=3, PMMA）快速模式：`successRate > 90%`、`util > 0.3`；
4. 同一项目连续跑两次（固定参数、非固定随机种子）：均匀度差异 `< 0.02`；
5. 切换盘/刷新页面后网格、端面高亮、LED 位姿正确恢复；
6. 中英文切换后，所有页面无 `undefined` / 裸 key；
7. 报告生成、下载、打印无报错。

## 4. 发布

### 4.1 手工发布

1. 修改代码后，**逐一递增** `index.html` 中的 `?v=`（至少改被修改的文件）；
2. 确认 CDN 地址可访问；
3. 将以下内容部署到任意静态服务器（Nginx / GitHub Pages / OSS / S3）：

```
index.html
css/
js/
docs/            # 可选：内置说明
```

4. `test/`、`spec.md`、`tasks.md`、`generate-ppt.js`、`LED 封装.xlsx` 不是运行时必需，可按需排除。

### 4.2 打包 zip

```powershell
powershell -ExecutionPolicy Bypass -File .\test\pack.ps1
```

打包内容：`index.html` + `css` + `js` + `test`。注意脚本内的 `$src` 是开发者本机绝对路径，换机器前必须修改。

### 4.3 部署注意

- 应用使用**相对路径**（`js/...`、`css/...`），可部署在子目录；
- 不需要 SPA 回退规则，hash 路由不产生额外请求；
- 若启用 CSP，需要允许 `cdn.jsdelivr.net`（脚本）、`'unsafe-inline'`（内联样式与报告 HTML）、`blob:`（下载）；
- `localStorage` 按域隔离，换域名会看不到旧项目，发布前提醒用户导出 JSON。

## 5. 二次开发约定

### 5.1 代码风格

- IIFE + `'use strict'`；ES5 语法（`var`、`function`），避免箭头函数与模板字符串，以兼容旧 WebView；
- 模块挂载：`window.LG = window.LG || {}; LG.Modules.xxx = {...}`；
- 缩进 2 空格；字符串用单引号；中文注释；
- 不在 IIFE 顶层跨模块解构，运行时再取。

### 5.2 新增页面

1. 新建 `js/modules/foo.js`，实现 `render(el)` 并返回 `cleanup`；
2. 在 `index.html` 引入脚本（带 `?v=`）；
3. 在 `app.js` 的 `ROUTES` 注册 `foo`，在顶栏加入 `<a href="#/foo">`；
4. 在 `i18n.js` 添加 `nav.foo` 与页面文案（中/英）；
5. 样式加到 `css/style.css`，优先复用 `.card / .layout / .metric` 等既有类。

### 5.3 新增仿真参数

1. `Store.defaults()` 加字段 + 迁移补齐；
2. `model.js` 加控件与 `saveXxx()`；
3. `simulate.js` 的 `paramsSnapshot` 与 `opts` 组装；
4. `raytracer.js` 消费参数（保持 Worker 可运行，勿引 DOM）；
5. `i18n` 文案、报告 `geoText/params`；
6. 回归测试。

### 5.4 新增指标

1. 引擎 `aggregate` 或页面纯函数计算；
2. `analysis.render` 指标卡 + `engStats`；
3. `buildConclusion` 判定；
4. `report` 表格；
5. `Charts` 如需新图，新增独立函数并导出。

### 5.5 必须遵守的生命周期约束

| 资源 | 清理位置 |
| --- | --- |
| 3D 场景挂载 | `cleanup()` 中 `LG.Viewer.unmount()` |
| `resize` / `keydown` / `mousedown` | `cleanup()` 移除（注意 capture 参数一致） |
| 定时器 / debounce | `cleanup()` 清除 |
| 离屏 WebGL（home 缩略图） | `disposeOffscreen()` |
| Worker | 全局单例，页不销毁；降级后保持 `workerBroken` |
| 高亮/光线/光斑 Mesh | 切换前显式 `clearXxx()` 释放 geometry/material |

## 6. 性能与内存

- `agg.heatmap` 与 `thumb` 是记录里的大头；历史记录建议控制在 20 条内；
- 每次渲染生成新 DOM，避免在闭包外持有旧节点；
- 大型导入模型（>10 万三角形）会显著拖慢求交与重建，需降 `numRays`；
- `screenshot` 使用 240×180 缩略图，报告如需高清图应单独渲染；
- 多次切页不应累积 `WebGLRenderer`；若控制台看到 `Too many active WebGL contexts`，检查 home 离屏渲染是否释放。

## 7. 已知限制

1. 无服务端、无账号体系，数据仅在本机浏览器；
2. 无自动保存版本历史，误删需重新导入 JSON；
3. 无 Fresnel 分光与偏振；表面散射是法线扰动近似；
4. 报告依赖当前会话的 `lastRun` 才能生成光斑图；
5. `pack.ps1`、`serve.ps1` 为 Windows/PowerShell 脚本，Linux/macOS 用 Python/Node 静态服务器替代；
6. 无 i18n 文案完整性检查，新增 key 容易漏英文。
