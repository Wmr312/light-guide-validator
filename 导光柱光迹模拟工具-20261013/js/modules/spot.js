/**
 * LG.Modules.spot — 光斑分析页（出射端面辐照度云图）
 * 数据来源：复用「仿真计算」页最近一次仿真的出射命中点（LG.state.lastRun.hits，
 * 含出射方向 dExit 与波长 λ），与仿真结果页严格同一批光线、零二次仿真偏差；
 * 探测屏固定在导光柱出射端端面上（d = 0，不可调），得到"光从端面出来时"的真实分布；
 * 3D 截面、本页云图、报告截图共用同一套常量与同一投影函数，前后数据完全一致。
 * 判定只看「端面出射均匀性」与「前后端亮度」，发散半角等远场参数不参与结构判定。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  // 探测屏固定口径：出射端端面（d = 0 mm）、固定网格 64×64，三处（3D 截面 / 本页 / 报告）共用
  var SEC = { d: 0, res: 64 };
  // 显示网格：仅用于云图与 3D 截面的纹理渲染，固定 256×256，不参与指标计算（前后数据仍以 64 网格为准）。
  // 把计算网格（指标）与显示网格（画面）分离，画面更细腻但均匀度/达标比例等数值完全不变。
  var DISP = { res: 256 };
  var NRAD = 48;   // 径向分布环带数
  var NHIST = 28;  // 直方图分箱数
  // 结构判定标准：只判「出射均匀性」与「前后端亮度」
  var CRITERIA = { uniOk: 0.70, uniWarn: 0.50, passOk: 0.90, passWarn: 0.70, utilOk: 0.30, utilWarn: 0.18 };

  // ---- 轻量向量工具 ----
  function vlen(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function vnorm(a) { var l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vcross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  // ---- CIE 1931 色匹配函数（Wyman 解析高斯拟合）→ sRGB ----
  function _g(t) { return Math.exp(-0.5 * t * t); }
  function cieX(l) {
    var t1 = (l - 442.0) * (l < 442.0 ? 0.0624 : 0.0374);
    var t2 = (l - 599.8) * (l < 599.8 ? 0.0264 : 0.0323);
    var t3 = (l - 493.4) * (l < 493.4 ? 0.0209 : 0.0174);
    return 0.362 * _g(t1) + 1.056 * _g(t2) - 0.065 * _g(t3);
  }
  function cieY(l) {
    var t1 = (l - 568.8) * (l < 568.8 ? 0.0213 : 0.0247);
    var t2 = (l - 530.9) * (l < 530.9 ? 0.0613 : 0.0322);
    return 0.821 * _g(t1) + 0.286 * _g(t2);
  }
  function cieZ(l) {
    var t1 = (l - 437.0) * (l < 437.0 ? 0.0845 : 0.0278);
    var t2 = (l - 459.0) * (l < 459.0 ? 0.0385 : 0.0725);
    return 1.217 * _g(t1) + 0.681 * _g(t2);
  }
  var _wlCache = {};
  /** λ(nm) → 单位化 sRGB 三元组（最大分量为 1），缓存 */
  function wavelengthToRGB(lam) {
    lam = Math.round(lam);
    if (_wlCache[lam]) return _wlCache[lam];
    var X = cieX(lam), Y = cieY(lam), Z = cieZ(lam);
    var r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
    var g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
    var b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
    r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
    var m = Math.max(r, g, b) || 1;
    r = Math.pow(r / m, 1 / 2.2); g = Math.pow(g / m, 1 / 2.2); b = Math.pow(b / m, 1 / 2.2);
    var out = [r, g, b];
    _wlCache[lam] = out;
    return out;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function fmtE(v) { return v >= 1e-3 ? v.toExponential(3) : v.toExponential(3); }
  function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); }

  // ================= 模块级：数据构建与投影（页面渲染与报告 capture 共用） =================

  // ---- 数据来源：最近一次仿真（LG.state.lastRun.hits），与仿真页严格同一批光线 ----
  // 仿真页恒以 returnSpot:true 运行并缓存 hits/agg/params 快照，本模块不再独立调用引擎，
  // 彻底消除"仿真结果"与"光斑分析"因多次仿真随机采样产生的偏差。
  function buildFromLastRun() {
    var lr = LG.state.lastRun;
    if (!lr || !lr.hits || !lr.hits.length) return null;
    var hits = lr.hits;
    var center = (lr.agg && lr.agg.outCenter) ? lr.agg.outCenter.slice() : [0, 0, 0];
    // 传播主轴：优先取出射端面法线（保证探测屏与端面共面，3D 截面能贴住端面）；
    // 缺失时退回功率加权出射方向
    var ax = (lr.agg && lr.agg.outNormal) ? lr.agg.outNormal.slice() : [0, 0, 0];
    if (vlen(ax) < 1e-9) {
      ax = [0, 0, 0];
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i];
        if (!h.dExit) continue;
        var wI = h.i || 0;
        ax[0] += h.dExit[0] * wI; ax[1] += h.dExit[1] * wI; ax[2] += h.dExit[2] * wI;
      }
    }
    ax = vnorm(ax);

    var lamSet = {}, lams = [];
    for (var j = 0; j < hits.length; j++) {
      var L = hits[j].lam;
      if (L != null && !lamSet[L]) { lamSet[L] = true; lams.push(L); }
    }
    lams.sort(function (a, b) { return a - b; });

    var prm = lr.params || {};

    // ---- 出射端面真实半宽（mm）：把 output face 所有顶点投影到端面平面，取投影包围盒半宽 ----
    // 用于解决"宽导光柱但光束窄时，热图只显示光斑局部、看不到整个端面"的问题
    var faceHalf = 0;
    var stProj = LG.state.project || {};
    var stMesh = LG.state.mesh;
    var outFaces = stProj.faces && stProj.faces.output;
    if (outFaces && outFaces.length && stMesh && stMesh.positions && stMesh.indices &&
        ax && vlen(ax) > 1e-9) {
      var fuv = vnorm(vcross(Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], ax));
      var fvv = vcross(ax, fuv);
      var uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (var fi = 0; fi < outFaces.length; fi++) {
        var fi3 = outFaces[fi] * 3;
        for (var vi = 0; vi < 3; vi++) {
          var idx = stMesh.indices[fi3 + vi] * 3;
          var px = stMesh.positions[idx];
          var py = stMesh.positions[idx + 1];
          var pz = stMesh.positions[idx + 2];
          var rx = px - center[0], ry = py - center[1], rz = pz - center[2];
          var fu = rx * fuv[0] + ry * fuv[1] + rz * fuv[2];
          var fv = rx * fvv[0] + ry * fvv[1] + rz * fvv[2];
          if (fu < uMin) uMin = fu; if (fu > uMax) uMax = fu;
          if (fv < vMin) vMin = fv; if (fv > vMax) vMax = fv;
        }
      }
      faceHalf = Math.max(Math.abs(uMin), Math.abs(uMax), Math.abs(vMin), Math.abs(vMax), 0);
    }

    return {
      hits: hits,
      axis: ax,
      center: center,
      numRays: prm.numRays || hits.length,
      flux: prm.flux || 683,
      lams: lams,
      multi: lams.length > 1,
      singleLam: prm.wavelength || 550,
      params: prm,
      faceHalf: faceHalf   // ← 新增：端面投影半宽（mm）
    };
  }

  // ---- 前后端亮度：前端 = 进光利用率（出射能量 / 全部能量），后端 = 折算到出射端的光通量(lm) ----
  function utilStats(spot) {
    var L = (LG.state.lastRun && LG.state.lastRun.ledger) || {};
    var sum = (L.output || 0) + (L.side || 0) + (L.absorbed || 0) + (L.residual || 0);
    var util = sum > 0 ? (L.output || 0) / sum : 0;
    var flux = (spot && spot.flux) || LG.state.project.source.flux || 683;
    return { util: util, outLm: flux * util, flux: flux };
  }

  // ---- 投影 + 分箱（纯函数：不依赖页面 DOM） ----
  function project(spot, d, res) {
    var hits = spot.hits, axis = spot.axis, center = spot.center;
    var on = axis;
    var up = Math.abs(on[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    var uv = vnorm(vcross(up, on));
    var vv = vcross(on, uv);

    var perRayW = (spot.flux / 683) / (spot.numRays || 1);
    var us = [], vs = [], ws = [], lamOf = [];
    var skipped = 0, sumI = 0;

    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!h.dExit || !h.p) { skipped++; continue; }
      var de = vnorm(h.dExit);
      var denom = vdot(de, on);
      if (!isFinite(denom) || Math.abs(denom) < 1e-3) { skipped++; continue; }
      var t = d / denom;
      var rel0 = [h.p[0] - center[0], h.p[1] - center[1], h.p[2] - center[2]];
      var u = vdot(rel0, uv) + t * vdot(de, uv);
      var v = vdot(rel0, vv) + t * vdot(de, vv);
      if (!isFinite(u) || !isFinite(v) || Math.abs(u) > 1e6 || Math.abs(v) > 1e6) { skipped++; continue; }
      us.push(u); vs.push(v); ws.push(h.i || 0); lamOf.push(h.lam != null ? h.lam : null);
      sumI += (h.i || 0);
    }

    // ---- 稳健视野：p98 半径 × 1.12，但至少覆盖整个出射端面 ----
    // 取两者较大值：光斑自身覆盖（p98×1.12）vs 端面真实半宽（faceHalf）
    // 这样窄光束在宽导光柱端面时也能看到整个端面的热图分布
    var rr = new Array(us.length);
    for (var ri = 0; ri < us.length; ri++) rr[ri] = Math.max(Math.abs(us[ri]), Math.abs(vs[ri]));
    rr.sort(function (a, b) { return a - b; });
    var p98 = rr.length ? rr[Math.min(rr.length - 1, Math.floor(0.98 * (rr.length - 1)))] : 1;
    var halfHits = Math.max(p98 * 1.12, 1e-3);
    var halfFace = (spot.faceHalf > 0) ? spot.faceHalf : 0;
    var half = Math.max(halfHits, halfFace);
    // 端面实际半径：出射命中的最大径向距离（所有命中点都在端面上）
    var rHitMax = 0;
    for (var rm = 0; rm < us.length; rm++) {
      var rr2 = Math.sqrt(us[rm] * us[rm] + vs[rm] * vs[rm]);
      if (rr2 > rHitMax) rHitMax = rr2;
    }

    // ---- 高斯溅射核（探测器 PSF）—— 核宽用物理长度（mm）表示，保证不同分辨率下展宽一致 ----
    // 真实探测器/肉眼看到的是光场而非点采样：每条光线按归一化高斯核展宽到邻域单元，
    // 离散光点 → 连续渐变光场（靶心式光圈）。核权重和为 1，能量严格守恒。
    // sigmaMM 取「64 网格下 σ=2.4 单元格」对应的物理宽度，保证指标网格（64）与显示网格（256）
    // 上的物理展宽完全一致 → 指标不会随显示分辨率变化而漂移。
    // 采样自适应：快速预览只有约 1600 条光线，固定核宽会留下明显的蒙特卡洛颗粒/斑块，
    // 与精准评估观感差异很大；按 sqrt(NREF/N) 展宽（上限 3×）让低样本光斑呈现一致的形态。
    // N ≥ NREF 时系数 = 1 → 精准评估结果不受任何影响。
    var NREF = 2000;
    var sigmaMM = 2.4 * (2 * half / 64) *
      Math.min(3, Math.max(1, Math.sqrt(NREF / Math.max(1, us.length))));
    var lamKeysInit = spot.lams.length ? spot.lams.slice() : ['s'];

    // 指标网格（64×64）：所有均匀度/达标比例/径向/色差/直方图等数值均由此网格计算
    var metric = splatGrid(us, vs, ws, lamOf, half, res, sigmaMM, perRayW, lamKeysInit);
    // 显示网格（256×256）：仅用于云图与 3D 截面纹理渲染，不参与任何指标计算
    var disp = splatGrid(us, vs, ws, lamOf, half, DISP.res, sigmaMM, perRayW, lamKeysInit);

    var Ptot = metric.Ptot, Etot = metric.Etot, Plam = metric.Plam;
    var lamKeys = metric.lamKeys, lamStat = metric.lamStat, Emax = metric.Emax;
    var cellMM = metric.cellMM, A_cell = metric.A_cell;
    var outside = metric.outside, outsidePow = metric.outsidePow, clipPow = metric.clipPow;

    // 能量守恒校验：网格能量 + 视野外 + 核裁剪 应等于投影总能量（数值残差 ~1e-16）
    var totalPower = 0;
    for (var c2 = 0; c2 < Ptot.length; c2++) totalPower += Ptot[c2];
    var expectPower = perRayW * sumI;
    var conserve = expectPower > 0 ? Math.abs(totalPower + outsidePow + clipPow - expectPower) / expectPower : 0;

    var out = {
      d: d, res: res, half: half, cellMM: cellMM, A_cell: A_cell, perRayW: perRayW,
      // 屏心 / 法线 / 面内基：供 3D 视图把探测屏贴到出射端面（d=0 时即端面本身）
      center: [center[0] + on[0] * d, center[1] + on[1] * d, center[2] + on[2] * d],
      on: on, uv: uv, vv: vv,
      us: us, vs: vs, ws: ws, lamOf: lamOf,
      Ptot: Ptot, Etot: Etot, Plam: Plam, lamKeys: lamKeys, lamStat: lamStat,
      rHitMax: rHitMax,
      Emax: Emax, totalPower: totalPower, conserve: conserve, skipped: skipped,
      outside: outside, outsidePow: outsidePow, clipPow: clipPow, expectPower: expectPower,
      half_hits: us.length,
      // 显示网格：云图 / 3D 截面纹理专用，指标计算不使用
      disp: { res: DISP.res, Etot: disp.Etot, Plam: disp.Plam, Ptot: disp.Ptot, Emax: disp.Emax, cellMM: disp.cellMM, A_cell: disp.A_cell }
    };
    out.radial = radialProfile(out);
    out.r86 = out.radial.r86; out.rFwhm = out.radial.rFwhm;
    out.metrics = computeMetrics(out);
    out.chroma = colorSeparation(out);
    out.hist = histogram(out);
    return out;
  }

  // ---- 单分辨率高斯溅射分箱（纯函数） ----
  // 入参：us/vs/ws/lamOf 为已投影的出射点（mm）；half 为视野半宽（mm）；res 为目标网格边长；
  // sigmaMM 为高斯核物理宽度（mm）；perRayW 为单光线权重；lamKeysInit 为初始波长键列表。
  // 返回：Ptot/Etot(辐照度 W/m²)/Plam/lamKeys/lamStat/Emax/cellMM/A_cell/outside/outsidePow/clipPow
  function splatGrid(us, vs, ws, lamOf, half, res, sigmaMM, perRayW, lamKeysInit) {
    var cellMM = 2 * half / res;
    var A_cell = Math.pow(cellMM / 1000, 2);   // m²
    var sigmaC = sigmaMM / cellMM;              // 核宽（单元格）：物理宽度 / 单元格物理宽度
    var kr = Math.max(2, Math.ceil(sigmaC * 2.5));
    var kern = [], ksum = 0;
    for (var ky0 = -kr; ky0 <= kr; ky0++) for (var kx0 = -kr; kx0 <= kr; kx0++) {
      var kw = Math.exp(-(kx0 * kx0 + ky0 * ky0) / (2 * sigmaC * sigmaC));
      kern.push(kw); ksum += kw;
    }
    for (var kn = 0; kn < kern.length; kn++) kern[kn] /= ksum;

    var cells = res * res;
    var Ptot = new Float64Array(cells);
    var lamKeys = lamKeysInit.slice();
    var Plam = {};
    for (var q = 0; q < lamKeys.length; q++) Plam[lamKeys[q]] = new Float64Array(cells);
    var lamStat = {};
    for (var q2 = 0; q2 < lamKeys.length; q2++) lamStat[lamKeys[q2]] = { w: 0, wu: 0, wv: 0, wr2: 0, p: 0 };

    var outside = 0, outsidePow = 0, clipPow = 0;
    for (var m = 0; m < us.length; m++) {
      var uu = us[m], vvv = vs[m];
      var pw = perRayW * ws[m];
      if (uu < -half || uu >= half || vvv < -half || vvv >= half) { outside++; outsidePow += pw; continue; }
      var key = (lamOf[m] != null) ? lamOf[m] : 's';
      if (!Plam[key]) { Plam[key] = new Float64Array(cells); lamStat[key] = { w: 0, wu: 0, wv: 0, wr2: 0, p: 0 }; lamKeys.push(key); }
      var ix = Math.round((uu + half) / (2 * half) * res - 0.5);
      var iy = Math.round((vvv + half) / (2 * half) * res - 0.5);
      var ki = 0, added = 0;
      for (var ky = -kr; ky <= kr; ky++) {
        var yy = iy + ky;
        for (var kx = -kr; kx <= kr; kx++, ki++) {
          var xx = ix + kx;
          if (xx < 0 || xx >= res || yy < 0 || yy >= res) continue;
          var g = yy * res + xx;
          Ptot[g] += pw * kern[ki];
          Plam[key][g] += pw * kern[ki];
          added += kern[ki];
        }
      }
      clipPow += pw * (1 - added);
      var st = lamStat[key];
      st.w += ws[m]; st.wu += ws[m] * uu; st.wv += ws[m] * vvv;
      st.wr2 += ws[m] * (uu * uu + vvv * vvv); st.p += pw;
    }

    var Etot = new Float64Array(cells);
    var Emax = 0;
    for (var c = 0; c < cells; c++) { Etot[c] = Ptot[c] / A_cell; if (Etot[c] > Emax) Emax = Etot[c]; }

    return {
      Ptot: Ptot, Etot: Etot, Plam: Plam, lamKeys: lamKeys, lamStat: lamStat, Emax: Emax,
      cellMM: cellMM, A_cell: A_cell, outside: outside, outsidePow: outsidePow, clipPow: clipPow
    };
  }

  // ---- 径向分布（含 D86 / FWHM） ----
  function radialProfile(cur) {
    var res = cur.res, half = cur.half, Ptot = cur.Ptot, A_cell = cur.A_cell;
    var r = new Float64Array(NRAD), e = new Float64Array(NRAD);
    var pRing = new Float64Array(NRAD);
    var dr = half / NRAD;
    for (var iy = 0; iy < res; iy++) {
      var vc = ((iy + 0.5) / res - 0.5) * 2 * half;
      for (var ix = 0; ix < res; ix++) {
        var g = iy * res + ix;
        if (Ptot[g] <= 0) continue;
        var uc = ((ix + 0.5) / res - 0.5) * 2 * half;
        var rc = Math.sqrt(uc * uc + vc * vc);
        var k = Math.floor(rc / dr); if (k >= NRAD) k = NRAD - 1;
        pRing[k] += Ptot[g];
      }
    }
    for (var k2 = 0; k2 < NRAD; k2++) {
      var r1 = k2 * dr, r2 = (k2 + 1) * dr;
      var area = Math.PI * (r2 * r2 - r1 * r1) / 1e6;   // mm²→m²
      r[k2] = (r1 + r2) / 2;
      e[k2] = area > 0 ? pRing[k2] / area : 0;
    }
    // D86：累积能量达 86%
    var totalP = 0;
    for (var k3 = 0; k3 < NRAD; k3++) totalP += pRing[k3];
    var r86 = half, cum = 0, target = 0.86 * totalP;
    for (var k4 = 0; k4 < NRAD; k4++) {
      cum += pRing[k4];
      if (cum >= target) { r86 = (k4 + 1) * dr; break; }
    }
    // FWHM：从峰值环带向外找半高
    var peak = 0, pk = 0;
    for (var k5 = 0; k5 < NRAD; k5++) if (e[k5] > peak) { peak = e[k5]; pk = k5; }
    var rFwhm = half;
    if (peak > 0) {
      var half2 = 0.5 * peak, found = -1;
      for (var k6 = pk; k6 < NRAD; k6++) { if (e[k6] <= half2) { found = k6; break; } }
      if (found < 0) { for (var k7 = pk; k7 >= 0; k7--) { if (e[k7] <= half2) { found = k7; break; } } }
      if (found >= 0) rFwhm = (found + 1) * dr;
    }
    return { r: r, e: e, r86: r86, rFwhm: rFwhm, peak: peak, peakR: r[pk] };
  }

  // ---- 端面指标（统计范围：出射端面圆内，向内收缩 3% 以避开圆周锯齿单元）----
  // 不设亮度门槛：端面圆内的暗区（未被光线覆盖的边缘带）必须计入，
  // 否则最小值会被亮度门槛钳住（E ≥ 1%·Emax 时 min 恒≈门槛 → 均匀度恒≈门槛/均值，失去意义）。
  function computeMetrics(cur) {
    var res = cur.res, Etot = cur.Etot, half = cur.half, span = 2 * half;
    var rMax = cur.rHitMax > 0 ? cur.rHitMax * 0.97 : (cur.r86 > 0 ? cur.r86 : Infinity);
    var n = 0, sum = 0, mn = Infinity, mx = 0;
    var vals = [];
    for (var iy = 0; iy < res; iy++) {
      var vv = (iy + 0.5) / res * span - half;
      for (var ix = 0; ix < res; ix++) {
        var uu = (ix + 0.5) / res * span - half;
        if (uu * uu + vv * vv > rMax * rMax) continue;
        var v = Etot[iy * res + ix];
        vals.push(v); n++; sum += v;
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
    }
    var avg = n > 0 ? sum / n : 0, std = 0, pass = 0;
    for (var i = 0; i < vals.length; i++) {
      std += (vals[i] - avg) * (vals[i] - avg);
      if (vals[i] >= 0.8 * avg) pass++;
    }
    std = n > 0 ? Math.sqrt(std / n) : 0;
    return {
      n: n, avg: avg, min: n > 0 ? mn : 0, max: mx,
      cv: avg > 0 ? std / avg : 0,
      uniformity: avg > 0 ? (n > 0 ? mn / avg : 0) : 0,
      passRatio: n > 0 ? pass / n : 0,
      D86: 2 * cur.r86, r86: cur.r86, rFwhm: cur.rFwhm
    };
  }

  // ---- 色差量化 ----
  function colorSeparation(cur) {
    var lams = cur.lamKeys.filter(function (k) { return k !== 's'; });
    var list = [];
    for (var i = 0; i < lams.length; i++) {
      var L = lams[i], st = cur.lamStat[L];
      if (!st || st.w <= 0) continue;
      list.push({
        lam: L,
        u: st.wu / st.w, v: st.wv / st.w,
        req: Math.sqrt(st.wr2 / st.w),
        frac: cur.totalPower > 0 ? st.p / cur.totalPower : 0,
        peak: 0
      });
    }
    list.sort(function (a, b) { return a.lam - b.lam; });
    // 相对峰值（该 λ 网格 Emax / 总 Emax）
    for (var j = 0; j < list.length; j++) {
      var arr = cur.Plam[list[j].lam], mx = 0;
      for (var c = 0; c < arr.length; c++) if (arr[c] > mx) mx = arr[c];
      list[j].peak = cur.Emax > 0 ? (mx / cur.A_cell) / cur.Emax : 0;
    }
    var axial = null, lateral = null;
    if (list.length >= 2) {
      var lo = list[0], hi = list[list.length - 1];
      axial = Math.abs(hi.req - lo.req);
      lateral = Math.sqrt((hi.u - lo.u) * (hi.u - lo.u) + (hi.v - lo.v) * (hi.v - lo.v));
    }
    return { multi: cur.lamKeys.length > 1, list: list, axial: axial, lateral: lateral };
  }

  // ---- 统计直方图 ----
  function histogram(cur) {
    var Etot = cur.Etot;
    var litThr = cur.Emax > 0 ? cur.Emax * 0.01 : Infinity;   // 与指标同口径
    var vals = [];
    for (var c = 0; c < Etot.length; c++) if (Etot[c] >= litThr) vals.push(Etot[c]);
    if (!vals.length) return { counts: [], min: 0, max: 0, mean: 0, peakE: 0, peakCount: 0 };
    var mn = Infinity, mx = -Infinity, sum = 0;
    for (var i = 0; i < vals.length; i++) {
      if (vals[i] < mn) mn = vals[i];
      if (vals[i] > mx) mx = vals[i];
      sum += vals[i];
    }
    var mean = sum / vals.length;
    var span = (mx - mn) || (mx || 1);
    var counts = new Array(NHIST).fill(0);
    for (var j = 0; j < vals.length; j++) {
      var b = Math.floor((vals[j] - mn) / span * NHIST);
      if (b < 0) b = 0; if (b >= NHIST) b = NHIST - 1;
      counts[b]++;
    }
    return { counts: counts, min: mn, max: mx, mean: mean };
  }

  // ---- 出射端面投影（3D 截面 / 报告 / 本页共用同一口径与同一函数） ----
  function projectLastRun() {
    var spot = buildFromLastRun();
    if (!spot) return null;
    return project(spot, SEC.d, SEC.res);
  }

  // ---- 报告页复用：把出射端面光斑云图绘制到给定 canvas ----
  // 返回投影结果（含 metrics/half/d/util/outLm）；无仿真数据时返回 null。
  function capture(canvas) {
    var spot = buildFromLastRun();
    if (!spot) return null;
    var proj = project(spot, SEC.d, SEC.res);
    // 报告截图使用 256 显示网格，与光斑页 / 3D 截面画面一致
    var d = proj.disp;
    LG.Charts.drawSpotCloud(canvas, { res: d.res, half: proj.half, E: d.Etot, Emax: proj.Emax }, {});
    var st = utilStats(spot);
    proj.util = st.util; proj.outLm = st.outLm;
    return proj;
  }

  // ---- 真彩合成（按 λ 着色，亮度归一）—— 使用 256 显示网格，画面更细腻 ----
  function trueColorCells(cur, spot) {
    var d = cur.disp;
    var cells = d.res * d.res;
    var rgbCells = new Array(cells).fill([0, 0, 0]);
    var uniq = cur.lamKeys.filter(function (k) { return k !== 's'; });
    var fallback = spot.multi ? null : spot.singleLam;
    for (var g = 0; g < cells; g++) {
      var tot = d.Ptot[g];
      if (tot <= 0) { rgbCells[g] = [0, 0, 0]; continue; }
      var mix = [0, 0, 0];
      if (uniq.length) {
        for (var k = 0; k < uniq.length; k++) {
          var w = d.Plam[uniq[k]][g] / tot;
          if (w <= 0) continue;
          var col = wavelengthToRGB(uniq[k]);
          mix[0] += col[0] * w; mix[1] += col[1] * w; mix[2] += col[2] * w;
        }
      } else {
        mix = wavelengthToRGB(fallback && fallback > 0 ? fallback : 550);
      }
      var mm = Math.max(mix[0], mix[1], mix[2]) || 1;
      var lum = cur.Emax > 0 ? Math.pow(d.Etot[g] / cur.Emax, 0.7) : 0;
      rgbCells[g] = [
        Math.round(255 * (mix[0] / mm) * lum),
        Math.round(255 * (mix[1] / mm) * lum),
        Math.round(255 * (mix[2] / mm) * lum)
      ];
    }
    return rgbCells;
  }

  /**
   * 构建一次可绘制的光斑视图（结果分析页复用）：
   * 返回 { spot, cur, cloud, opts, sep, util }，无仿真数据时返回 null。
   * mode: jet 伪彩 / color 真彩 / sep 逐λ分离（sep 附带各波长云图数据）
   */
  function buildView(mode) {
    var spot = buildFromLastRun();
    if (!spot) return null;
    var cur = project(spot, SEC.d, SEC.res);
    var d = cur.disp;
    var cloud = { res: d.res, half: cur.half, E: d.Etot, Emax: cur.Emax };
    var opts = (mode === 'color') ? { mode: 'color', rgbCells: trueColorCells(cur, spot) } : {};
    var sep = [];
    var keys = cur.lamKeys.filter(function (k) { return k !== 's'; });
    if (mode === 'sep') {
      for (var k = 0; k < keys.length; k++) {
        var L = keys[k], arr = d.Plam[L], mx = 0;
        for (var c = 0; c < arr.length; c++) if (arr[c] > mx) mx = arr[c];
        var eL = new Float64Array(arr.length);
        for (var c2 = 0; c2 < arr.length; c2++) eL[c2] = arr[c2] / d.A_cell;
        sep.push({ lam: L, E: eL, Emax: mx / d.A_cell });
      }
    }
    return { spot: spot, cur: cur, cloud: cloud, opts: opts, sep: sep, util: utilStats(spot) };
  }

  function render(el) {
    var dead = false;
    var cur = null;         // 当前投影结果（供悬停/导出）
    var cloudLayout = null;

    var p = LG.state.project;
    var hasMesh = !!(LG.state.mesh && LG.state.mesh.positions && LG.state.mesh.positions.length);
    var hasFaces = p.faces.input.length > 0 && p.faces.output.length > 0;

    // 读取本地偏好（探测屏与网格已固定，只有显示模式可调）
    var mode0 = localStorage.getItem('lgv.spot.mode') || 'jet';

    el.innerHTML =
      '<div class="page-title">' + LG.t('spot.title') + '</div>' +
      '<div class="layout">' +
        '<div>' +
          '<div class="card">' +
            '<div class="card-title">' + LG.t('spot.src') + '</div>' +
            '<div class="hint" id="sp-src-info" style="margin:0 0 8px"></div>' +
            '<div class="hint" id="sp-data-info" style="margin:0;font-weight:600;color:var(--ink)"></div>' +
            '<div class="hint" id="sp-preview" style="margin:4px 0 0;color:#b45309;display:none"></div>' +
            '<div class="hint" id="sp-stale" style="margin:4px 0 0;color:#b45309;display:none"></div>' +
            '<div class="hint" style="margin-top:8px">' + LG.t('spot.hint') + '</div>' +
          '</div>' +
          '<div class="card">' +
            '<div class="card-title">' + LG.t('spot.proj') + '</div>' +
            '<div class="hint" style="margin:0 0 10px">' + LG.t('spot.proj.plane') + '</div>' +
            '<div class="field" style="margin-bottom:0"><label>' + LG.t('spot.mode') + '</label>' +
              '<select id="sp-mode">' +
              '<option value="jet">' + LG.t('spot.mode.jet') + '</option>' +
              '<option value="color">' + LG.t('spot.mode.color') + '</option>' +
              '<option value="sep">' + LG.t('spot.mode.sep') + '</option>' +
            '</select></div>' +
          '</div>' +
          '<div class="card">' +
            '<div class="card-title">' + LG.t('spot.export') + '</div>' +
            '<div class="btn-row">' +
              '<button id="sp-png" class="btn btn-ghost btn-sm">' + LG.t('spot.export.png') + '</button>' +
              '<button id="sp-html" class="btn btn-ghost btn-sm">' + LG.t('spot.export.report') + '</button>' +
            '</div>' +
            '<button id="sp-json" class="btn btn-ghost btn-sm btn-block" style="margin-top:8px">' + LG.t('spot.export.json') + '</button>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div id="sp-empty"></div>' +
          '<div id="sp-content" style="display:none">' +
            '<div id="sp-verdict"></div>' +
            '<div class="card" style="margin-top:12px">' +
              '<div class="card-title">' + LG.t('spot.heat') + '</div>' +
              '<div class="card-body card-open">' +
                '<div style="position:relative">' +
                  '<canvas id="sp-cloud" style="width:100%;height:460px"></canvas>' +
                  '<div id="sp-hover" class="spot-hover" style="display:none"></div>' +
                '</div>' +
                '<div class="hint" style="margin-top:8px" id="sp-cloud-hint"></div>' +
              '</div>' +
            '</div>' +
            '<div class="card" id="sp-sep-card" style="display:none;margin-top:16px">' +
              '<div class="card-title">' + LG.t('spot.mode.sep') + '</div>' +
              '<div class="card-body card-open"><div id="sp-sep-grid" class="spot-sep-grid"></div></div>' +
            '</div>' +
            '<div class="card" style="margin-top:16px">' +
              '<div class="card-title">' + LG.t('spot.disp') + '</div>' +
              '<div class="card-body card-open"><div id="sp-disp"></div></div>' +
            '</div>' +
            '<details class="adv-box" style="margin-top:16px">' +
              '<summary>' + LG.t('spot.conf.title') + '</summary>' +
              '<div style="margin-top:10px;line-height:1.7;font-size:13px">' +
                '<p style="margin:0 0 10px">' + LG.t('spot.conf.paradigm') + '</p>' +
                '<p style="margin:0 0 10px">' + LG.t('spot.conf.modeled') + '</p>' +
                '<p style="margin:0 0 10px">' + LG.t('spot.conf.notModeled') + '</p>' +
                '<p style="margin:0 0 10px">' + LG.t('spot.conf.assurance') + '</p>' +
                '<p style="margin:0">' + LG.t('spot.conf.conclusion') + '</p>' +
              '</div>' +
            '</details>' +
          '</div>' +
        '</div>' +
      '</div>';

    // ---- 控件初始化 ----
    $('sp-mode').value = mode0;
    renderSourceInfo();

    function renderSourceInfo() {
      var box = $('sp-src-info');
      if (!box) return;
      if (!hasMesh) { box.textContent = LG.t('spot.noMesh'); return; }
      var m = LG.state.mesh;
      var sp = p.source.spectrum;
      var specTxt = (sp && sp.enabled && sp.wavelengths && sp.wavelengths.length)
        ? sp.wavelengths.map(function (w) { return w.nm + 'nm'; }).join('+')
        : (p.source.wavelength + 'nm');
      box.textContent = LG.t('spot.srcInfo',
        (m.name || '-') + (m.isParametric === false ? '' : ' · ' + p.geometry.length + 'mm'),
        p.faces.input.length, p.faces.output.length, specTxt);
    }

    // ---- 数据来自最近一次仿真（lastRun.hits）：与仿真页同一批光线，无二次仿真偏差 ----
    var spot = buildFromLastRun();

    // ---- 空态 / 就绪态 ----
    if (!spot) {
      $('sp-empty').innerHTML =
        '<div class="card"><div class="hint" style="font-size:14px;margin:8px 0">' +
        (hasMesh ? (hasFaces ? LG.t('spot.needRun') : LG.t('spot.needFaces')) : LG.t('spot.noMesh')) +
        '</div></div>';
      $('sp-content').style.display = 'none';
    } else {
      $('sp-empty').innerHTML = '';
      $('sp-content').style.display = '';
      renderDataInfo();
      recomputeAndDraw();
    }

    // ---- 事件 ----
    $('sp-mode').addEventListener('change', function () {
      localStorage.setItem('lgv.spot.mode', $('sp-mode').value);
      recomputeAndDraw();
    });

    $('sp-png').addEventListener('click', exportPNG);
    $('sp-html').addEventListener('click', exportHTML);
    $('sp-json').addEventListener('click', exportJSON);

    // 悬停读数
    var cloud = $('sp-cloud');
    cloud.addEventListener('mousemove', onHover);
    cloud.addEventListener('mouseleave', function () { $('sp-hover').style.display = 'none'; });

    return function cleanup() {
      dead = true;
      try { cloud.removeEventListener('mousemove', onHover); } catch (e) {}
      cur = null; cloudLayout = null;
    };

    // ================= functions =================

    // buildFromLastRun / project / computeMetrics / colorSeparation / histogram 等
    // 已提升至模块作用域（供本页与报告生成页 capture 复用），此处仅保留页面级逻辑。

    // ---- 参数过期检测：当前项目参数与上次仿真快照不一致 → 提示重新仿真（仅提示不阻断） ----
    function paramsStale(prm) {
      if (!prm || !prm.numRays) return true;
      var src = p.source;
      var sp = src.spectrum;
      var multi = !!(sp && sp.enabled && sp.wavelengths && sp.wavelengths.length);
      if (prm.geometryName !== ((LG.state.mesh && LG.state.mesh.name) || '-')) return true;
      if ((prm.inputCount | 0) !== p.faces.input.length) return true;
      if ((prm.outputCount | 0) !== p.faces.output.length) return true;
      // 与光源设置的光线总数比较（快速预览会按模式截断实际光线数，不能用 opts.numRays 判过期）
      if ((prm.srcRays != null ? (prm.srcRays | 0) : (prm.numRays | 0)) !== (src.numRays | 0)) return true;
      if (prm.n !== p.material.n || (prm.abbe || 0) !== (p.material.abbe || 0) || prm.alpha !== p.material.alpha) return true;
      if (prm.sourceType !== (src.type || 'surface') || prm.emissionMode !== src.mode) return true;
      if ((prm.srcDist || 0) !== (src.srcDist || 0)) return true;
      var specNow = multi ? sp.wavelengths.map(function (w) { return { nm: w.nm, weight: w.weight }; }) : null;
      if (JSON.stringify(prm.spectrum || null) !== JSON.stringify(specNow)) return true;
      if (!!prm.led !== !!(p.led && p.led.enabled)) return true;
      // 表面处理与曲面变化同样使光斑过期（σ 影响出射角分布，曲面/轮廓改变网格）
      var surfNow = (p.geometry && p.geometry.surface) || null;
      var surfThen = (prm.geometry && prm.geometry.surface) || null;
      if (JSON.stringify(surfThen) !== JSON.stringify(surfNow)) return true;
      return false;
    }

    // ---- 数据来源信息 + 过期提示 ----
    function renderDataInfo() {
      var box = $('sp-data-info');
      if (box) box.textContent = LG.t('spot.dataInfo', spot.hits.length, spot.numRays);
      // 快速预览数据提示：低样本光斑经自适应平滑，形态参考用，均匀度/判定须用精确评估
      var pvEl = $('sp-preview');
      if (pvEl) {
        var isQuick = (LG.state.lastRun && LG.state.lastRun.simMode === 'quick');
        pvEl.style.display = isQuick ? '' : 'none';
        if (isQuick) pvEl.textContent = LG.t('spot.previewNote');
      }
      var stEl = $('sp-stale');
      if (stEl) {
        var stale = paramsStale(spot.params);
        stEl.style.display = stale ? '' : 'none';
        if (stale) stEl.textContent = LG.t('spot.stale');
      }
    }

    // ---- 术语说明已随专业指标一并移除 ----

    // ---- 投影 + 分箱（固定出射端面口径，不重跑仿真） ----
    function recomputeAndDraw() {
      if (!spot) return;
      cur = project(spot, SEC.d, SEC.res);
      drawAll();
    }

    // ---- 绘制 ----
    function drawAll() {
      var mode = $('sp-mode').value;

      // 主云图：使用 256 显示网格渲染（指标仍由 64 网格计算，数值不变）
      var d = cur.disp;
      var spotData = { res: d.res, half: cur.half, E: d.Etot, Emax: cur.Emax };
      var opts = {};
      if (mode === 'color') {
        opts = { mode: 'color', rgbCells: trueColorCells(cur, spot) };
      }
      cloudLayout = LG.Charts.drawSpotCloud($('sp-cloud'), spotData, opts);

      // 判定结论（工程语言）
      renderVerdict();

      // 云图提示（探测屏固定贴出射端面，只报视野 / 网格 / 有效单元）
      var hintTxt = LG.t('spot.cloudHint',
        (2 * cur.half).toFixed(1), cur.res, cur.metrics.n, cur.skipped + cur.outside);
      if (cur.expectPower > 0 && cur.outsidePow / cur.expectPower > 0.005) {
        hintTxt += ' · ' + LG.t('spot.outsideHint', (cur.outsidePow / cur.expectPower * 100).toFixed(1));
      }
      $('sp-cloud-hint').textContent = hintTxt;
      if (cur.conserve > 1e-9) {
        $('sp-cloud-hint').textContent += ' · ⚠ ' + LG.t('spot.msg.conserveErr', cur.conserve.toExponential(1));
      }

      // 逐 λ 分离（使用 256 显示网格，与主云图同口径）
      var sepCard = $('sp-sep-card');
      var sepGrid = $('sp-sep-grid');
      if (mode === 'sep' && cur.lamKeys.filter(function (k) { return k !== 's'; }).length >= 1) {
        sepCard.style.display = '';
        var keys = cur.lamKeys.filter(function (k) { return k !== 's'; });
        sepGrid.innerHTML = '';
        var dd = cur.disp;
        for (var k = 0; k < keys.length; k++) {
          var L = keys[k];
          var arr = dd.Plam[L], mx = 0;
          for (var c = 0; c < arr.length; c++) if (arr[c] > mx) mx = arr[c];
          var EmaxL = mx / dd.A_cell;
          var eL = new Float64Array(arr.length);
          for (var c2 = 0; c2 < arr.length; c2++) eL[c2] = arr[c2] / dd.A_cell;
          var wrap = document.createElement('div');
          wrap.className = 'spot-sep-item';
          var cv = document.createElement('canvas');
          cv.style.width = '100%'; cv.style.height = '260px';
          var cap = document.createElement('div');
          cap.className = 'hint'; cap.style.textAlign = 'center';
          cap.textContent = L + ' nm';
          wrap.appendChild(cv); wrap.appendChild(cap);
          sepGrid.appendChild(wrap);
          LG.Charts.drawSpotCloud(cv, { res: dd.res, half: cur.half, E: eL, Emax: EmaxL }, {});
        }
      } else {
        sepCard.style.display = 'none';
      }

      // 色差表
      renderChroma();
    }

    /** 0/1 区间：越大越好；返回 ok / warn / bad */
    function level(v, warnAt, okAt) {
      return v >= okAt ? 'ok' : (v >= warnAt ? 'warn' : 'bad');
    }

    // 判定结论：面向结构工程师的大白话 —— 只回答「均不均匀、够不够亮」，不摆专业术语
    function renderVerdict() {
      var m = cur.metrics;
      var st = utilStats(spot);
      var uniL = level(m.uniformity, CRITERIA.uniWarn, CRITERIA.uniOk);
      var passL = level(m.passRatio, CRITERIA.passWarn, CRITERIA.passOk);
      var utilL = level(st.util, CRITERIA.utilWarn, CRITERIA.utilOk);
      var verdict = 'ok';
      [uniL, passL, utilL].forEach(function (lv) {
        if (lv === 'bad') verdict = 'bad';
        else if (lv === 'warn' && verdict !== 'bad') verdict = 'warn';
      });
      var label = verdict === 'ok' ? LG.t('ana.verdict.ok') : (verdict === 'bad' ? LG.t('ana.verdict.bad') : LG.t('ana.verdict.warn'));
      var ic = function (lvl) { return lvl === 'ok' ? '✓' : (lvl === 'warn' ? '⚠' : '✗'); };
      var item = function (name, val, lvl) {
        return '<span class="vi vi-' + lvl + '"><b>' + ic(lvl) + '</b> ' + name + ' ' + val + '</span>';
      };
      var html = '<div class="verdict-card verdict-' + verdict + '">' +
        '<div class="verdict-badge">' + label + '</div>' +
        '<div class="verdict-body">' +
          '<div class="verdict-items">' +
            item(LG.t('spot.v.uni'), LG.t('spot.v.uni.' + uniL), uniL) +
            item(LG.t('spot.v.pass'), (m.passRatio * 100).toFixed(1) + '%', passL) +
            item(LG.t('spot.v.util'), (st.util * 100).toFixed(1) + '%', utilL) +
            item(LG.t('spot.v.bright'), st.outLm.toFixed(1) + ' lm', utilL) +
          '</div>' +
        '</div></div>';
      $('sp-verdict').innerHTML = html;
    }

    function renderChroma() {
      var ch = cur.chroma;
      var box = $('sp-disp');
      if (!ch.multi || !ch.list.length) {
        box.innerHTML = '<div class="hint">' + LG.t('spot.disp.nomulti') + '</div>';
        return;
      }
      var html = '<table class="tbl"><thead><tr>' +
        '<th>' + LG.t('spot.disp.col.lam') + '</th>' +
        '<th>' + LG.t('spot.disp.col.u') + '</th>' +
        '<th>' + LG.t('spot.disp.col.v') + '</th>' +
        '<th>' + LG.t('spot.disp.col.radius') + '</th>' +
        '<th>' + LG.t('spot.disp.col.power') + '</th></tr></thead><tbody>';
      for (var i = 0; i < ch.list.length; i++) {
        var it = ch.list[i];
        html += '<tr><td>' + it.lam + ' nm</td>' +
          '<td class="num">' + it.u.toFixed(3) + '</td>' +
          '<td class="num">' + it.v.toFixed(3) + '</td>' +
          '<td class="num">' + it.req.toFixed(3) + '</td>' +
          '<td class="num">' + (it.frac * 100).toFixed(1) + '%</td></tr>';
      }
      html += '</tbody></table>';
      html += '<div class="interp-box" style="margin-top:10px">' +
        '<span class="vi vi-warn"><b>Δr</b> ' + LG.t('spot.disp.dr') + ' = ' +
        (ch.axial != null ? ch.axial.toFixed(3) : '-') + ' mm</span>' +
        '<span class="vi vi-warn"><b>Δc</b> ' + LG.t('spot.disp.dc') + ' = ' +
        (ch.lateral != null ? ch.lateral.toFixed(3) : '-') + ' mm</span>' +
        '</div>';
      box.innerHTML = html;
    }

    // ---- 悬停读数 ----
    function onHover(e) {
      if (!cur || !cloudLayout) return;
      var cv = $('sp-cloud');
      var rc = cv.getBoundingClientRect();
      var lay = cloudLayout;
      var sx = lay ? (cv.clientWidth || rc.width) / rc.width : 1;
      var mx = (e.clientX - rc.left) * sx;
      var my = (e.clientY - rc.top) * (rc.height ? (cv.clientHeight || rc.height) / rc.height : 1);
      var box = $('sp-hover');
      if (mx < lay.ox || mx > lay.ox + lay.size || my < lay.oy || my > lay.oy + lay.size) {
        box.style.display = 'none'; return;
      }
      // 画面用 256 显示网格渲染 → 读数也从显示网格取，保证指哪读哪
      var d = cur.disp;
      var fx = (mx - lay.ox) / lay.size, fy = (my - lay.oy) / lay.size;
      var ix = clamp(Math.floor(fx * d.res), 0, d.res - 1);
      var rowFromTop = clamp(Math.floor(fy * d.res), 0, d.res - 1);
      var iy = d.res - 1 - rowFromTop;
      var g = iy * d.res + ix;
      var u = ((ix + 0.5) / d.res - 0.5) * 2 * cur.half;
      var v = ((iy + 0.5) / d.res - 0.5) * 2 * cur.half;
      var E = d.Etot[g];
      var domLam = null, best = -1;
      var keys = cur.lamKeys;
      for (var i = 0; i < keys.length; i++) {
        var val = d.Plam[keys[i]][g];
        if (val > best) { best = val; domLam = keys[i]; }
      }
      var lamTxt = (domLam === 's' || domLam == null)
        ? (spot.singleLam ? spot.singleLam + ' nm' : LG.t('spot.hover.nolam'))
        : domLam + ' nm';
      box.innerHTML =
        '<div>' + LG.t('spot.hover.pos') + ': <b>' + u.toFixed(3) + ', ' + v.toFixed(3) + '</b> mm</div>' +
        '<div>' + LG.t('spot.hover.e') + ': <b>' + fmtE(E) + '</b> W/m²</div>' +
        '<div>' + LG.t('spot.hover.lam') + ': <b>' + lamTxt + '</b></div>';
      box.style.display = '';
      box.style.left = (e.clientX - rc.left + 14) + 'px';
      box.style.top = (e.clientY - rc.top + 14) + 'px';
    }

    // ---- 导出 ----
    function exportPNG() {
      if (!cur) { LG.status(LG.t('spot.needRun')); return; }
      var cv = $('sp-cloud');
      try {
        var url = cv.toDataURL('image/png');
        var a = document.createElement('a');
        a.href = url; a.download = 'spot_' + stamp() + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        LG.status(LG.t('spot.msg.exported'));
      } catch (e) { LG.status('Error: ' + e.message); }
    }

    function collectData() {
      var m = cur.metrics;
      var st = utilStats(spot);
      return {
        generated: new Date().toISOString(),
        params: spot.params,
        plane: 'exit_face',
        distance_mm: cur.d,
        grid: { res: cur.res, half_mm: cur.half, cell_mm: cur.cellMM, A_cell_m2: cur.A_cell },
        normalization: { perRayW: cur.perRayW, numRays: spot.numRays, flux: spot.flux },
        brightness: { util: st.util, flux_lm: spot.flux, exitFlux_lm: st.outLm },
        metrics: {
          D86_mm: m.D86, r86_mm: m.r86, rFwhm_mm: m.rFwhm,
          uniformity: m.uniformity, cv: m.cv, passRatio: m.passRatio,
          peakIrradiance_W_m2: m.max, avgIrradiance_W_m2: m.avg,
          totalPower_W: cur.totalPower, litCells: m.n, skipped: cur.skipped
        },
        chromatic: {
          multi: cur.chroma.multi,
          axialDeltaR_mm: cur.chroma.axial,
          lateralDelta_mm: cur.chroma.lateral,
          perLambda: cur.chroma.list.map(function (it) {
            return { nm: it.lam, centroidU_mm: it.u, centroidV_mm: it.v, req_mm: it.req, powerFraction: it.frac };
          })
        },
        radial: { r_mm: Array.from(cur.radial.r), irradiance_W_m2: Array.from(cur.radial.e) },
        histogram: {
          bins: cur.hist.counts, min_W_m2: cur.hist.min, max_W_m2: cur.hist.max, mean_W_m2: cur.hist.mean
        },
        energyConservation: { relError: cur.conserve, outsidePower_W: cur.outsidePow, kernelClipPower_W: cur.clipPow },
        note: 'Irradiance computed by projecting exit rays onto the light-guide exit end face (d=0); precision >= 1e-6 W/m^2; color mapping uses CIE 1931 analytic CMF fits -> sRGB.'
      };
    }

    function exportJSON() {
      if (!cur) { LG.status(LG.t('spot.needRun')); return; }
      LG.download('spot_' + stamp() + '.json', JSON.stringify(collectData(), null, 2), 'application/json');
      LG.status(LG.t('spot.msg.exported'));
    }

    function exportHTML() {
      if (!cur) { LG.status(LG.t('spot.needRun')); return; }
      function img(id) { try { return document.getElementById(id).toDataURL('image/png'); } catch (e) { return ''; } }
      var m = cur.metrics;
      var st = utilStats(spot);
      var E = LG.esc;
      var chromaRows = '';
      if (cur.chroma.multi) {
        for (var i = 0; i < cur.chroma.list.length; i++) {
          var it = cur.chroma.list[i];
          chromaRows += '<tr><td>' + it.lam + '</td><td>' + it.u.toFixed(3) + '</td><td>' + it.v.toFixed(3) +
            '</td><td>' + it.req.toFixed(3) + '</td><td>' + (it.frac * 100).toFixed(1) + '%</td></tr>';
        }
      }
      var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
        '<title>光斑分析报告 ' + E(spot.params.geometryName) + '</title>' +
        '<style>body{font-family:system-ui,Segoe UI,sans-serif;max-width:920px;margin:24px auto;color:#0f172a;padding:0 16px}' +
        'h1{font-size:22px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #e2e8f0;padding-bottom:6px}' +
        'table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13px}' +
        'th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:left}th{background:#f8fafc}' +
        'td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}' +
        'img{max-width:100%;border:1px solid #e2e8f0;border-radius:6px;margin:8px 0}' +
        '.meta{color:#64748b;font-size:12px}</style></head><body>' +
        '<h1>光斑分析报告 · ' + E(spot.params.geometryName) + '</h1>' +
        '<div class="meta">生成时间 ' + E(new Date().toLocaleString()) +
        ' · 探测屏 = 出射端端面（d = 0）· 网格 ' + cur.res + '×' + cur.res +
        ' · 光线数 ' + spot.numRays + '</div>' +

        '<h2>1. 出射端面光斑</h2>' +
        '<img src="' + img('sp-cloud') + '" alt="spot cloud">' +

        '<h2>2. 判定结论</h2><table><thead><tr><th>项目</th><th class="num">结果</th></tr></thead><tbody>' +
        '<tr><td>端面均匀性</td><td class="num">' + LG.t('spot.v.uni.' + level(m.uniformity, CRITERIA.uniWarn, CRITERIA.uniOk)) + '</td></tr>' +
        '<tr><td>光斑达标面积</td><td class="num">' + (m.passRatio * 100).toFixed(1) + '%</td></tr>' +
        '<tr><td>进光利用率</td><td class="num">' + (st.util * 100).toFixed(1) + '%</td></tr>' +
        '<tr><td>出射亮度</td><td class="num">' + st.outLm.toFixed(1) + ' lm</td></tr>' +
        '</tbody></table>' +

        '<h2>3. 色差量化</h2>' +
        (cur.chroma.multi
          ? '<table><thead><tr><th>λ (nm)</th><th class="num">质心 ū (mm)</th><th class="num">质心 v̄ (mm)</th>' +
            '<th class="num">等效半径 (mm)</th><th class="num">功率占比</th></tr></thead><tbody>' + chromaRows + '</tbody></table>' +
            '<div>轴向色差 Δr = ' + (cur.chroma.axial != null ? cur.chroma.axial.toFixed(3) : '-') + ' mm；' +
            '横向色差 Δc = ' + (cur.chroma.lateral != null ? cur.chroma.lateral.toFixed(3) : '-') + ' mm</div>'
          : '<div>未启用多波长光谱，无逐 λ 色差数据。</div>') +

        '<h2>4. 参数快照</h2><table><tbody>' +
        '<tr><td>材料折射率 n</td><td class="num">' + spot.params.n + '</td></tr>' +
        '<tr><td>阿贝数 Vd</td><td class="num">' + spot.params.abbe + '</td></tr>' +
        '<tr><td>吸收系数 α (1/mm)</td><td class="num">' + spot.params.alpha + '</td></tr>' +
        '<tr><td>光源类型 / 模式</td><td class="num">' + E(spot.params.sourceType) + ' / ' + E(spot.params.emissionMode) + '</td></tr>' +
        '<tr><td>光线数 / 最大反弹</td><td class="num">' + spot.params.numRays + ' / ' + spot.params.maxBounces + '</td></tr>' +
        '<tr><td>多波长</td><td class="num">' + (spot.params.spectrum ? spot.params.spectrum.map(function (w) { return w.nm + 'nm(w=' + w.weight + ')'; }).join(', ') : '单波长') + '</td></tr>' +
        '<tr><td>入射面 / 出射面</td><td class="num">' + spot.params.inputCount + ' / ' + spot.params.outputCount + '</td></tr>' +
        '</tbody></table>' +
        '<div class="meta">辐照度由出射光线投影到出射端端面计算，精度 ≥ 1e-6 W/m²；色彩映射采用 CIE 1931 解析 CMF 拟合 → sRGB。</div>' +
        '</body></html>';
      LG.download('spot_report_' + stamp() + '.html', html, 'text/html');
      LG.status(LG.t('spot.msg.exported'));
    }
  }

  window.LG = window.LG || {};
  LG.Modules = LG.Modules || {};
  LG.Modules.spot = { render: render, capture: capture, projectLastRun: projectLastRun, buildView: buildView };
})();
