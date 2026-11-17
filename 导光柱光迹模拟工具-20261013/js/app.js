/**
 * app.js — 启动引导：Store 初始化 / 语言切换 / Worker 引擎封装 / 工具函数
 */
(function () {
  'use strict';
  window.LG = window.LG || {};

  // ============ 全局状态 ============
  LG.state = {
    project: null,     // 当前项目（LG.Store.active() 引用）
    mesh: null,        // { positions:Float32Array(mm), indices:Uint32Array|null, faceCount, name, isParametric }
    // 导入模型网格缓存（项目 id → mesh）：导入的 STL/OBJ/STEP 只存在于内存，
    // 切换盘位后需要能原样恢复，刷新页面后才会丢失（仍提示重新导入）。
    meshCache: {},
    lastRun: null      // 最近一次仿真聚合结果（含 params 快照）
  };

  // ============ 引擎封装：Worker 优先，失败自动回退主线程 ============
  var worker = null;
  var workerBroken = false;

  function getWorker() {
    if (workerBroken) return null;
    if (worker) return worker;
    try {
      worker = new Worker('js/engine/raytracer.worker.js?v=12');
      console.info('RayTracer worker ready');
      return worker;
    } catch (e) {
      console.warn('Worker unavailable, main-thread fallback:', e.message);
      workerBroken = true;
      worker = null;
      return null;
    }
  }

  function runOnMainThread(meshData, options) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          var tracer = new RayTracer(meshData, options);
          var results = tracer.simulate(options.onProgress || null);
          var agg = tracer.aggregate(results, {
            heatmapRes: options.heatmapRes, axisBins: options.axisBins, angleBinDeg: options.angleBinDeg
          });
          var payload = {
            total: results.total, success: results.success, escaped: results.escaped,
            exhausted: results.exhausted, successRate: results.successRate,
            avgOutputIntensity: results.avgOutputIntensity, maxBounces: results.maxBounces,
            ledger: results.ledger, agg: agg, elapsedMs: null, visRays: results.visRays
          };
          if (options.returnSegments) payload.segments = results.segments;
          if (options.returnSpot) payload.hits = results.outputHits;
          resolve(payload);
        } catch (err) { reject(err); }
      }, 30);
    });
  }

  /**
   * 运行仿真（聚合结果）
   * Worker 静默挂起（脚本加载失败 / 无响应）超过看门狗时限 → 终止并永久降级主线程。
   * @returns Promise<payload> payload = {summary..., ledger, agg, elapsedMs, segments?}
   */
  LG.Engine = {
    run: function (meshData, options) {
      var w = getWorker();
      if (!w) return runOnMainThread(meshData, options);

      return new Promise(function (resolve, reject) {
        var settled = false;
        var wd = null;
        var WATCHDOG_MS = 12000;

        function armWatchdog() {
          clearTimeout(wd);
          wd = setTimeout(failover, WATCHDOG_MS,
            new Error('worker silent timeout (no message in ' + WATCHDOG_MS + 'ms)'));
        }
        function failover(err) {
          if (settled) return;
          settled = true;
          clearTimeout(wd);
          w.removeEventListener('message', handler);
          w.removeEventListener('error', failover);
          workerBroken = true;
          try { w.terminate(); } catch (e2) { /* ignore */ }
          if (worker === w) worker = null;
          console.warn('Worker failover → main thread:', err && err.message);
          runOnMainThread(meshData, options).then(resolve, reject);
        }
        function handler(e) {
          var msg = e.data || {};
          if (msg.type === 'progress') {
            armWatchdog();
            if (options.onProgress) options.onProgress(msg.done, msg.total);
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(wd);
          w.removeEventListener('message', handler);
          w.removeEventListener('error', failover);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg);
        }

        w.addEventListener('message', handler);
        w.addEventListener('error', failover);
        armWatchdog();
        var opt = {};
        for (var k in options) if (k !== 'onProgress') opt[k] = options[k];
        try {
          w.postMessage({ meshData: meshData, options: opt });
        } catch (err) {
          failover(err);
        }
      });
    },
    mode: function () { return workerBroken ? 'main' : (getWorker() ? 'worker' : 'main'); },
    /**
     * 刷新当前项目的 LED 灯珠位姿（led.poses 数组，mm 空间）。
     * 触发时机：导入模型几何变更 / 用户拾取或切换入射面 / LED 参数保存。
     * 规则：仅「手动导入模型（非参数化）+ LED 启用 + 已选入射面」时按入射面动态计算
     * （RayTracer.computeLEDPoses：按平面聚类，每个入射平面一颗灯珠，
     *  灯珠置于面前、发射方向对齐法向）；
     * 参数化圆柱等其余场景位姿为 null → 引擎与 Viewer 均回退默认坐标（向后兼容）。
     * led.pose（单数）保留为首位姿的兼容别名。
     */
    refreshLEDPose: function () {
      var p = LG.state.project, mesh = LG.state.mesh;
      if (!p || !p.led) return null;
      var poses = null;
      if (p.led.enabled && mesh && mesh.positions && mesh.isParametric === false) {
        // 逐颗灯珠独立计算位姿：每颗灯珠的入射面 → 一颗 LED pose（不再按平面自动聚类拆多颗）
        // （LED 个数只能由用户在菜单手动增减，shift 多选面只会扩展这颗灯珠的入射范围）
        var beads = (p.beads && p.beads.length) ? p.beads : [{ input: (p.faces.input||[]), output: (p.faces.output||[]) }];
        var allPoses = [];
        try {
          beads.forEach(function (bead) {
            if (bead.input && bead.input.length > 0) {
              var bp = RayTracer.computeLEDPose(mesh.positions, mesh.indices, bead.input);
              if (bp) allPoses.push(bp);
            }
          });
        } catch (e) {
          console.warn('LED pose computation failed:', e);
        }
        poses = allPoses.length ? allPoses : null;
      }
      var cur = p.led.poses || null;
      var same = (poses === cur) || (poses && cur && poses.length === cur.length && poses.every(function (np, i) {
        var cp = cur[i];
        return cp && np.pos[0] === cp.pos[0] && np.pos[1] === cp.pos[1] && np.pos[2] === cp.pos[2] &&
          np.z[0] === cp.z[0] && np.z[1] === cp.z[1] && np.z[2] === cp.z[2];
      }));
      if (!same) {
        p.led = Object.assign({}, p.led, {
          poses: poses,
          pose: (poses && poses.length === 1) ? poses[0] : null
        });
        LG.Store.updateActive({ led: p.led });
      }
      LG.Viewer.setLED(p.led);
      return poses;
    }
  };

  // ============ 工具 ============
  LG.fmt = function (v, digits) {
    if (v == null || isNaN(v)) return '-';
    return Number(v).toFixed(digits == null ? 3 : digits);
  };
  LG.esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var statusTimer = null;
  LG.status = function (msg) {
    var bar = document.getElementById('status-bar');
    if (!bar) return;
    bar.textContent = msg;
    bar.classList.add('show');
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { bar.classList.remove('show'); }, 3000);
  };
  LG.download = function (filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/html' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };

  // ============ 3D 零件文件解析（STL / OBJ / STEP）============
  // 「模型配置 → 文件导入」与「拖到盘面导入」共用这一套解析：
  // 解析后统一做 RayTracer.fixWinding（焊接重复顶点 + 统一绕向），避免两套行为。
  function loadScriptOnce(src, onload, onerror) {
    var s = document.createElement('script');
    s.src = src; s.onload = onload;
    s.onerror = onerror || function () { LG.status('Failed to load: ' + src); };
    document.head.appendChild(s);
  }

  /**
   * 解析零件文件。
   * @param {File} file
   * @param {function(Error, Object)} cb 成功回调 cb(null, {positions, indices, name, welded, flipped})
   */
  LG.parsePartFile = function (file, cb) {
    cb = cb || function () {};
    var name = (file && file.name) || '';
    var ext = name.split('.').pop().toLowerCase();

    function finish(positions, indices) {
      try {
        var fixed = RayTracer.fixWinding(
          new Float32Array(positions),
          (indices && indices.length) ? new Uint32Array(indices) : null);
        cb(null, {
          positions: fixed.positions, indices: fixed.indices, name: name,
          welded: fixed.welded || 0, flipped: fixed.flipped || 0
        });
      } catch (err) { cb(err); }
    }

    if (ext === 'stl') {
      file.arrayBuffer().then(function (buf) {
        var geo = new THREE.STLLoader().parse(buf);
        var pa = geo && geo.attributes && geo.attributes.position;
        if (!pa) { cb(new Error('empty stl')); return; }
        finish(pa.array, geo.index ? geo.index.array : null);
      }).catch(cb);
    } else if (ext === 'obj') {
      file.text().then(function (text) {
        var obj = new THREE.OBJLoader().parse(text);
        var geo = obj.children[0] ? obj.children[0].geometry : null;
        var pa = geo && geo.attributes && geo.attributes.position;
        if (!pa) { cb(new Error('empty obj')); return; }
        finish(pa.array, geo.index ? geo.index.array : null);
      }).catch(cb);
    } else if (ext === 'step' || ext === 'stp') {
      parseSTEP(file, cb, finish);
    } else {
      cb(new Error('unsupported: ' + ext));
    }
  };

  /** STEP 依赖 occt-import-js（CDN + WASM），多面片合并后交给 finish 统一修复绕向 */
  function parseSTEP(file, cb, finish) {
    var occtCdn = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/';
    loadScriptOnce(occtCdn + 'occt-import-js.js', function () {
      if (typeof occtimportjs === 'undefined') { cb(new Error('STEP parser failed to load')); return; }
      occtimportjs({ locateFile: function (p) { return occtCdn + p; } }).then(function (occt) {
        file.arrayBuffer().then(function (buf) {
          var result = occt.ReadStepFile(new Uint8Array(buf), null);
          if (!result || !result.success || !(result.meshes || []).length) {
            cb(new Error('empty step')); return;
          }
          var positions = [], indices = [], vOffset = 0;
          for (var mi = 0; mi < result.meshes.length; mi++) {
            var mm = result.meshes[mi], pa = mm.attributes.position.array;
            for (var pi = 0; pi < pa.length; pi++) positions.push(pa[pi]);
            if (mm.index) {
              var ia = mm.index.array;
              for (var ii = 0; ii < ia.length; ii++) indices.push(ia[ii] + vOffset);
            } else {
              for (var vi = 0; vi < pa.length / 3; vi += 3) {
                indices.push(vi + vOffset, vi + 1 + vOffset, vi + 2 + vOffset);
              }
            }
            vOffset += pa.length / 3;
          }
          finish(positions, indices);
        }).catch(cb);
      }).catch(cb);
    }, function () { cb(new Error('Failed to load STEP parser from CDN')); });
  }

  // ============ 网格持久化辅助 ============
  // Float32Array / Uint32Array ↔ JSON 数组（localStorage / 导出 JSON 都用普通数组，能被 JSON.stringify 直接序列化）。
  // 超过 MAX_BYTES_THRESHOLD 的大网格不持久化（序列化后体积膨胀 ~4x，避免撑爆 5MB localStorage），只保存在内存 meshCache。
  // 经验阈值：256KB ≈ 64K 顶点（positions），覆盖绝大多数 STL/STEP 零件；超阈值的超大模型刷新后需重新导入。
  var MAX_MESH_JSON_BYTES = 256 * 1024;

  function meshToJSON(positions, indices) {
    if (!positions || !positions.length) return null;
    var posArr = Array.prototype.slice.call(positions);  // Float32Array → number[]
    var idxArr = indices && indices.length ? Array.prototype.slice.call(indices) : null;
    var approxBytes = posArr.length * 8 + (idxArr ? idxArr.length * 6 : 0);  // 粗略估算 JSON 后 ~8 字节/顶点、~6 字节/索引
    if (approxBytes > MAX_MESH_JSON_BYTES) return null;
    return { positions: posArr, indices: idxArr || null };
  }

  function meshFromJSON(raw) {
    if (!raw || !raw.positions || !raw.positions.length) return null;
    return {
      positions: new Float32Array(raw.positions),
      indices: raw.indices && raw.indices.length ? new Uint32Array(raw.indices) : null
    };
  }

  /** 把网格数据（positions/indices）存入 geometry._mesh，并同步写入 meshCache */
  function persistMeshToProject(projId, parsed) {
    var jmesh = meshToJSON(parsed.positions, parsed.indices);
    var proj = LG.Store.get(projId);
    if (!proj) return;
    // meshCache 永远保留（内存中无大小限制）
    LG.state.meshCache[projId] = {
      positions: parsed.positions, indices: parsed.indices, name: parsed.name
    };
    // geometry._mesh 只在阈值内才写，避免 localStorage 爆掉
    var geomPatch = { geometry: Object.assign({}, proj.geometry, { fileName: parsed.name }) };
    if (jmesh) geomPatch.geometry._mesh = jmesh;
    else if (proj.geometry && proj.geometry._mesh) geomPatch.geometry._mesh = null;  // 大模型清空旧缓存
    LG.Store.update(projId, geomPatch);
  }

  /** 把项目里保存的网格恢复到 meshCache（刷新页面后从 geometry._mesh 兜底） */
  function restoreMeshFromProject(proj) {
    if (!proj || !proj.geometry || !proj.geometry._mesh) return false;
    if (LG.state.meshCache[proj.id]) return true;  // 已有内存缓存就不重复反序列化
    var m = meshFromJSON(proj.geometry._mesh);
    if (!m) return false;
    LG.state.meshCache[proj.id] = {
      positions: m.positions, indices: m.indices, name: proj.geometry.fileName || 'imported'
    };
    return true;
  }

  /**
   * 把解析结果导入指定项目（等价「文件导入」的落库 + 视图同步）：
   * geometry.fileName、网格缓存 LG.state.meshCache、网格持久化 geometry._mesh（可刷新恢复）、
   * 端面自动识别、LED 位姿刷新。
   * 只有该项目正在 3D 视图中显示时才重建网格；否则只写缓存，切到该项目时由页面层恢复。
   */
  LG.importIntoProject = function (projId, parsed) {
    if (!projId || !parsed || !parsed.positions) return false;
    var proj = LG.Store.get(projId);
    if (!proj) return false;
    persistMeshToProject(projId, parsed);

    var cur = LG.state.project;
    if (!cur || cur.id !== projId || !LG.Viewer || !LG.Viewer.isReady()) return true;

    LG.Viewer.setGeometryData(parsed.positions, parsed.indices, parsed.name);
    var auto = LG.Viewer.autoEndCaps();
    LG.Store.update(projId, { faces: { input: auto.input, output: auto.output } });
    LG.state.mesh = {
      positions: parsed.positions, indices: parsed.indices,
      faceCount: LG.Viewer.faceCount(), name: parsed.name, isParametric: false
    };
    LG.Viewer.setFaceHighlights(auto.input, auto.output);
    LG.Engine.refreshLEDPose();
    if (parsed.welded > 0 || parsed.flipped > 0) {
      LG.status(LG.t('model.msg.fixed', parsed.welded, parsed.flipped));
    }
    return true;
  };

  // 暴露给外部模块（model.js / home.js / importJSON 后）
  LG.restoreMeshFromProject = restoreMeshFromProject;

  /** 去掉扩展名，作为新项目名（零件名） */
  function stripExt(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  /**
   * 文件拖放到盘面：默认「新增零件」到目标盘（共享 plateId），不覆盖已有零件。
   * 目标盘就是当前盘且当前项目还没有几何时，第一个文件直接补进当前项目（与文件导入完全一致）。
   */
  function handleFileDrop(files, projectId) {
    var list = [];
    for (var i = 0; i < files.length; i++) {
      var ext = files[i].name.split('.').pop().toLowerCase();
      if (ext === 'stl' || ext === 'obj' || ext === 'step' || ext === 'stp') list.push(files[i]);
    }
    if (!list.length) { LG.status(LG.t('drop.badtype')); return; }

    var cur = LG.state.project;
    var target = projectId ? LG.Store.get(projectId) : null;
    var targetPlateId = target ? LG.Store.plateIdOf(target) : '';
    var curPlateId = cur ? LG.Store.plateIdOf(cur) : '';
    var intoCurrent = !!(cur && targetPlateId && curPlateId === targetPlateId &&
      !(cur.geometry && cur.geometry.fileName));
    var usedCurrent = false;

    var idx = 0, done = 0, fail = 0, lastId = null, lastParsed = null, names = [];

    function next() {
      if (idx >= list.length) { finish(); return; }
      var file = list[idx++];
      LG.status('Loading ' + file.name + ' ...');
      LG.parsePartFile(file, function (err, parsed) {
        if (err || !parsed) { fail++; next(); return; }
        var projId;
        if (intoCurrent && !usedCurrent) {
          usedCurrent = true;
          projId = cur.id;                       // 复用当前项目（与文件导入一致）
        } else {
          var np = LG.Store.create(stripExt(file.name));
          projId = np.id;
          LG.Store.update(np.id, {
            plateId: targetPlateId || np.id,     // 盘外拖入 → 各自独立成盘
            geometry: Object.assign({}, np.geometry, { fileName: file.name }),
            faces: { input: [], output: [] }
          });
        }
        LG.importIntoProject(projId, parsed);
        lastId = projId; lastParsed = parsed;
        names.push(file.name); done++;
        next();
      });
    }

    function finish() {
      if (!done) {
        LG.status(LG.t(fail ? 'model.msg.fail' : 'drop.badtype'));
        return;
      }
      var last = LG.Store.get(lastId);
      if (last) {
        LG.Store.setActive(lastId);
        LG.state.project = last;
        // 最后导入的零件可能不是当前视图里的项目：同步到共享 Viewer，
        // 避免重渲染后仍显示上一个项目的网格
        if (lastParsed) LG.importIntoProject(lastId, lastParsed);
      }
      if (LG.Router.current() === 'model') LG.Router.rerender();
      LG.status(LG.t('drop.ok', done, names.join('、')));
    }

    next();
  }

  // ============ 启动 ============
  function boot() {
    var project = LG.Store.ensureProject();
    if (LG.Store.list().length === 1 && project.records.length === 0) {
      LG.status(LG.I18N.t('status.noProject'));
    }
    LG.state.project = project;

    // 启动时把所有项目的持久化网格恢复到内存 meshCache（刷新页面后仍可预览 & 重新打开）
    var list = LG.Store.list();
    for (var i = 0; i < list.length; i++) restoreMeshFromProject(list[i]);

    // 文件拖放：STL/OBJ/STEP 拖到盘面 → 新增零件（与目标盘共享 plateId）
    LG.Viewer.onFilesDrop(handleFileDrop);

    // 语言切换
    var sw = document.getElementById('lang-switch');
    sw.addEventListener('click', function (e) {
      var btn = e.target.closest('.lang-btn');
      if (btn) LG.I18N.setLang(btn.getAttribute('data-lang'));
    });
    LG.I18N.applyI18n(document);
    LG.status(LG.I18N.t('status.ready'));
    window.addEventListener('lg:lang', function () { LG.Router.rerender(); });

    // 路由
    LG.Router.register('home', LG.Modules.home);
    LG.Router.register('model', LG.Modules.model);
    LG.Router.register('simulate', LG.Modules.simulate);
    LG.Router.register('analysis', LG.Modules.analysis);
    LG.Router.register('spot', LG.Modules.spot);
    LG.Router.register('report', LG.Modules.report);
    LG.Router.init();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
