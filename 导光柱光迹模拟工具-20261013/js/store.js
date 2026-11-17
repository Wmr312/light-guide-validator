/**
 * LG.Store — 项目/仿真记录/实测数据的 localStorage 持久层 + JSON 导入导出
 */
(function () {
  'use strict';
  var KEY = 'lgv.projects.v1', KACTIVE = 'lgv.active.v1';
  var projects = [], activeId = null;

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function defaults() {
    return {
      geometry: {
        shape: 'cylinder', d1: 3, d2: 3, length: 30, radialSeg: 48,
        teeth: { enabled: false, step: 1, width: 0.8, aStart: 85, aEnd: 10, offset: 2 },
        fileName: '',
        useParametric: true,
        transform: { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 },
        // 表面处理与曲面：咬花/雾面（散射半角 σ，deg）按 入射/出射/侧面 分组；
        // 曲面仅参数化建模生效（导入网格本身已含曲面）。
        // tex: polished 镜面 / fine 细雾面 / mid 中雾面 / coarse 粗雾面·咬花 / custom（用 sigma）
        surface: {
          inputTex: 'polished', inputSigma: 0,
          inputCurve: 'flat', inputCurveR: 20,
          outputTex: 'polished', outputSigma: 0,
          outputCurve: 'flat', outputCurveR: 20,
          sideTex: 'polished', sideSigma: 0,
          sideProfile: 'straight', sideDeltaR: 0.3
        }
      },
      material: { preset: '1.49,0.0005', n: 1.49, alpha: 0.0005, abbe: 57.4, diffusion: 'none' },
      led: {
        enabled: true, type: 'rectangle',
        length: 3.0, width: 2.0, height: 1.5, gap: 0.5,
        concaveDepth: 0.4, convexRadius: 0.6
      },
      source: {
        type: 'surface', mode: 'lambert', flux: 683, wavelength: 555, angleSigma: 12, posSigma: 0.3, srcDist: 0, numRays: 1000, maxBounces: 30,
        // 多波长光谱（色散光斑分析用）：关闭时按单波长 wavelength 追迹（旧行为）
        spectrum: {
          enabled: false, preset: 'rgb',
          wavelengths: [{ nm: 450, weight: 1 }, { nm: 550, weight: 1 }, { nm: 650, weight: 1 }]
        }
      },
      faces: { input: [], output: [] },
      beads: [{ input: [], output: [] }],
      records: [],
      measurements: [],
      // ---- 工程化配置（面向结构工程师，屏蔽光学底层参数）----
      // 方案选型：straight 直筒 / bent 折弯 / tir TIR 聚光头部 / plate 片状导光板
      scheme: {
        type: 'straight',
        template: '',      // 行业模板库 key（空=未套用）
        bendAngle: 90,     // 折弯角度 (°)，仅 bent 方案生效
        bendR: 3,          // 折弯内圆角 R (mm)
        draftAngle: 1      // 拔模斜度 (°)
      },
      eng: {
        material: 'pmma',            // 材料库 key：pmma / pc / pc_diffuse / ms / custom
        ledModel: '0603',            // LED 型号库 key：none / 0402 / 0603 / 2835 / 3528 / top / side
        ledLevel: 'typ',             // 亮度档位：low / typ / high
        assemblyGap: 0.1,            // LED 与入光面空气间隙 (mm) —— 同步到 led.gap
        offsetX: 0, offsetY: 0,      // 装配偏移公差 (mm) —— 同步到几何 transform 平移
        housing: 'black',            // 周边壳体：black 吸光 / white 反光
        foam: true,                  // 泡棉遮光圈（防漏光）
        reflector: false,            // 反光片 / 麦拉片
        // 本次评估目标：决定结果页输出哪些工程结论
        targets: {
          brightness: true, uniformity: true, leak: true,
          tolerance: true, bendLoss: false, crosstalk: false, molding: true
        },
        checkedAt: 0                 // 最近一次预检查时间戳
      },
      // 盘（Plate）状态：锁定后禁止删除/调整朝向/改参数，防止误操作
      locked: false,
      // 盘位标识：同一 plateId 的多个项目并排显示在同一块盘上；
      // 老项目没有该字段时按自身 id 独立成盘（读取处统一用 LG.Store.plateIdOf 兜底）
      plateId: ''
    };
  }

  // 迁移：早期版本的材料预设 α 量级偏大约 200 倍（按 0.01–0.40 /mm 填写，真实光学塑料应为
  // 1e-4 ~ 2e-3 /mm），导致光线在 30mm 导光柱内被吸收 95% 以上，表现为“光线在柱内提前消失”。
  // 历史项目按同一比例修正，避免用户需手动重建项目。幂等：迁移后 preset 不再命中旧键、α 也低于阈值。
  var PRESET_REMAP = {
    '1.586,0.40': '1.586,0.002',
    '1.49,0.10':  '1.49,0.0005',
    '1.59,0.30':  '1.59,0.0015',
    '1.575,0.35': '1.575,0.0018',
    '1.533,0.08': '1.533,0.0004',
    '1.517,0.01': '1.517,0.00005'
  };
  function migrateMaterialAbsorption() {
    var changed = false;
    for (var i = 0; i < projects.length; i++) {
      var m = projects[i] && projects[i].material;
      if (!m) continue;
      var mapped = PRESET_REMAP[m.preset];
      if (mapped) {
        m.preset = mapped;
        m.alpha = parseFloat(mapped.split(',')[1]);   // 保留用户可能微调过的 n
        changed = true;
      } else if (m.alpha > 0.01) {                    // 自定义参数：超出新量程上限即按比例修正
        m.alpha = m.alpha / 200;
        changed = true;
      }
    }
    if (changed) save();
  }

  // 各材料预设（"n,alpha" 键）对应的阿贝数 Vd —— 供色散模型 n(λ) 反解系数用。
  // Vd 越大色散越小；光学塑料/玻璃常见 30–64。缺省按 PMMA 57.4 兜底。
  var ABBE_BY_PRESET = {
    '1.586,0.002': 30.0,
    '1.49,0.0005': 57.4,
    '1.59,0.0015': 30.9,
    '1.575,0.0018': 42.0,
    '1.533,0.0004': 56.0,
    '1.517,0.00005': 64.2
  };
  function defaultAbbe(preset) {
    return (ABBE_BY_PRESET[preset] != null) ? ABBE_BY_PRESET[preset] : 57.4;
  }

  // 迁移：历史项目补齐阿贝数与多波长光谱配置（幂等——已存在则跳过）
  function migrateMaterialMeta() {
    var changed = false;
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      if (!p) continue;
      if (p.material && p.material.abbe == null) {
        p.material.abbe = defaultAbbe(p.material.preset);
        changed = true;
      }
      if (p.material && p.material.diffusion == null) {
        p.material.diffusion = 'none';
        changed = true;
      }
      if (p.source && !p.source.spectrum) {
        p.source.spectrum = { enabled: false, preset: 'rgb', wavelengths: [{ nm: 450, weight: 1 }, { nm: 550, weight: 1 }, { nm: 650, weight: 1 }] };
        changed = true;
      }
    }
    if (changed) save();
  }

  // 迁移：历史项目补齐工程化配置（方案/材料库/LED 型号/周边结构/评估目标）。
  // 幂等——已存在则跳过；老项目的 material.preset 反查回材料库 key，保持界面选中项与真实光学参数一致。
  var PRESET_TO_LIB = {
    '1.49,0.0005': 'pmma',
    '1.586,0.002': 'pc',
    '1.59,0.0015': 'ms',
    '1.575,0.0018': 'ms',
    '1.533,0.0004': 'pc_diffuse',
    '1.517,0.00005': 'pmma'
  };
  function migrateEngConfig() {
    var changed = false;
    var d = defaults();
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      if (!p) continue;
      if (!p.scheme) {
        p.scheme = JSON.parse(JSON.stringify(d.scheme));
        // 老项目若已启用微齿，视为「直筒 + 侧面微齿」方案
        if (p.geometry && p.geometry.teeth && p.geometry.teeth.enabled) p.scheme.type = 'straight';
        changed = true;
      }
      if (!p.eng) {
        p.eng = JSON.parse(JSON.stringify(d.eng));
        changed = true;
      }
      if (p.eng && !p.eng.material && p.material) {
        p.eng.material = PRESET_TO_LIB[p.material.preset] || 'custom';
        changed = true;
      }
      if (p.eng && !p.eng.targets) {
        p.eng.targets = JSON.parse(JSON.stringify(d.eng.targets));
        changed = true;
      }
      if (p.eng && p.eng.assemblyGap == null && p.led && p.led.gap != null) {
        p.eng.assemblyGap = p.led.gap;
        changed = true;
      }
      if (p.geometry && !p.geometry.surface) {
        p.geometry.surface = JSON.parse(JSON.stringify(d.geometry.surface));
        changed = true;
      }
    }
    if (changed) save();
  }

  /** 一次性迁移：LED「启用灯珠」改为默认开启，老项目同步为开启（之后用户的取消勾选会被尊重） */
  function migrateLedEnabledDefault() {
    try {
      if (localStorage.getItem('lgv.ledEnabledDefault.v1') === '1') return;
      var changed = false;
      for (var i = 0; i < projects.length; i++) {
        var p = projects[i];
        if (p && p.led && p.led.enabled === false) { p.led.enabled = true; changed = true; }
      }
      localStorage.setItem('lgv.ledEnabledDefault.v1', '1');
      if (changed) save();
    } catch (e) { }
  }

  function load() {
    try { projects = JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { projects = []; }
    activeId = localStorage.getItem(KACTIVE) || null;
    migrateMaterialAbsorption();
    migrateMaterialMeta();
    migrateEngConfig();
    migrateLedEnabledDefault();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(projects)); } catch (e) { console.error('localStorage save failed (quota?)', e); }
    localStorage.setItem(KACTIVE, activeId || '');
  }

  function create(name) {
    var p = defaults();
    p.id = uid();
    // 新建项目独占一块新盘：plateId 显式写为自身 id
    p.plateId = p.id;
    p.name = name || ('Project-' + new Date().toISOString().slice(5, 16).replace('T', ' '));
    p.createdAt = Date.now(); p.updatedAt = Date.now();
    projects.unshift(p);
    activeId = p.id;
    save();
    return p;
  }

  function list() { return projects; }
  function active() {
    for (var i = 0; i < projects.length; i++) if (projects[i].id === activeId) return projects[i];
    return null;
  }
  function setActive(id) { activeId = id; save(); }
  function remove(id) {
    projects = projects.filter(function (p) { return p.id !== id; });
    if (activeId === id) activeId = projects.length ? projects[0].id : null;
    save();
  }
  function rename(id, name) {
    var p = get(id); if (p) { p.name = name; p.updatedAt = Date.now(); save(); }
  }
  function get(id) {
    for (var i = 0; i < projects.length; i++) if (projects[i].id === id) return projects[i];
    return null;
  }
  /** 项目所属盘位：老项目没有 plateId 时按自身 id 独立成盘 */
  function plateIdOf(proj) {
    return (proj && (proj.plateId || proj.id)) || '';
  }
  function updateActive(patch) {
    var p = active(); if (!p) return null;
    for (var k in patch) p[k] = patch[k];
    p.updatedAt = Date.now();
    save();
    return p;
  }

  // ---- 盘（Plate）排序 / 锁定 ----
  /** 按 id 更新任意项目（不要求是当前激活项目） */
  function update(id, patch) {
    var p = get(id); if (!p) return null;
    for (var k in patch) p[k] = patch[k];
    p.updatedAt = Date.now();
    save();
    return p;
  }
  /** 把盘移动到指定下标（0 = 最前），越界自动收敛 */
  function move(id, toIndex) {
    var from = -1;
    for (var i = 0; i < projects.length; i++) if (projects[i].id === id) { from = i; break; }
    if (from < 0) return false;
    var to = Math.max(0, Math.min(projects.length - 1, toIndex));
    if (to === from) return false;
    var p = projects.splice(from, 1)[0];
    projects.splice(to, 0, p);
    save();
    return true;
  }
  /** 切换锁定状态，返回新的锁定值 */
  function toggleLock(id) {
    var p = get(id); if (!p) return null;
    p.locked = !p.locked;
    p.updatedAt = Date.now();
    save();
    return p.locked;
  }

  // ---- 仿真记录 ----
  function addRecord(rec) {
    var p = active(); if (!p) return null;
    rec.id = uid();
    rec.time = Date.now();
    p.records.unshift(rec);
    p.updatedAt = Date.now();
    save();
    return rec;
  }
  function removeRecord(recId) {
    var p = active(); if (!p) return;
    p.records = p.records.filter(function (r) { return r.id !== recId; });
    save();
  }
  function getRecord(recId) {
    var p = active(); if (!p) return null;
    for (var i = 0; i < p.records.length; i++) if (p.records[i].id === recId) return p.records[i];
    return null;
  }

  // ---- 实测数据 ----
  function addMeasurement(m) {
    var p = active(); if (!p) return null;
    m.id = uid();
    p.measurements.unshift(m);
    p.updatedAt = Date.now();
    save();
    return m;
  }
  function removeMeasurement(id) {
    var p = active(); if (!p) return;
    p.measurements = p.measurements.filter(function (m) { return m.id !== id; });
    save();
  }

  // ---- 导入 / 导出 ----
  function exportJSON() {
    var data = { app: 'light-guide-validator', version: 1, projects: projects };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lgv-projects-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function importJSON(text) {
    var data = JSON.parse(text);
    var incoming = data.projects || (Array.isArray(data) ? data : null);
    if (!incoming) throw new Error('bad format');
    var n = 0;
    for (var i = 0; i < incoming.length; i++) {
      var p = incoming[i];
      if (!p || !p.geometry) continue;
      p.id = uid(); // 避免与本地冲突
      p.records = p.records || []; p.measurements = p.measurements || [];
      if (p.material && p.material.abbe == null) p.material.abbe = defaultAbbe(p.material.preset);
      if (p.material && p.material.diffusion == null) p.material.diffusion = 'none';
      if (p.source && !p.source.spectrum) p.source.spectrum = { enabled: false, preset: 'rgb', wavelengths: [{ nm: 450, weight: 1 }, { nm: 550, weight: 1 }, { nm: 650, weight: 1 }] };
      projects.unshift(p);
      n++;
    }
    if (n > 0 && !activeId) activeId = projects[0].id;
    save();
    return n;
  }

  function ensureProject() {
    load();
    if (projects.length === 0) create();
    if (!active()) activeId = projects[0].id;
    save();
    return active();
  }

  window.LG = window.LG || {};
  LG.Store = {
    ensureProject: ensureProject, create: create, list: list, active: active,
    setActive: setActive, remove: remove, rename: rename, get: get, plateIdOf: plateIdOf, updateActive: updateActive,
    move: move, toggleLock: toggleLock, update: update,
    addRecord: addRecord, removeRecord: removeRecord, getRecord: getRecord,
    addMeasurement: addMeasurement, removeMeasurement: removeMeasurement,
    exportJSON: exportJSON, importJSON: importJSON, defaults: defaults,
    MATERIAL_ABBE: ABBE_BY_PRESET, defaultAbbe: defaultAbbe
  };
})();
