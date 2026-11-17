/**
 * Light Guide Ray Tracer v2.1 (validator edition)
 * -----------------------------------------------
 * 纯 JS 光线追踪引擎 — 无 THREE 依赖，Worker 兼容。
 * 基于 light-guide-sim v2.0（网格加速 + Beer-Lambert 吸收已修复验证），
 * 本版新增：
 *   [1] 能量账本 ledger：输出 / 侧面出光 / 吸收 / 残留（能量守恒可视化）
 *   [2] 命中点采集 outputHits / sideHits（含出射方向）
 *   [3] aggregate()：出射端面热图 binning、沿轴侧壁分布、配光角分布、均匀性指标
 *
 * 运行方式：
 *   主线程： new RayTracer(meshData, options)   // meshData = {positions, indices}
 *   Worker： importScripts('raytracer.js')
 */

'use strict';

// ================= 轻量 Vec3 =================
function V3(x, y, z) { this.x = x; this.y = y; this.z = z; }
V3.prototype.add = function(o) { return new V3(this.x + o.x, this.y + o.y, this.z + o.z); };
V3.prototype.sub = function(o) { return new V3(this.x - o.x, this.y - o.y, this.z - o.z); };
V3.prototype.scale = function(s) { return new V3(this.x * s, this.y * s, this.z * s); };
V3.prototype.length = function() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); };
V3.prototype.dot = function(o) { return this.x * o.x + this.y * o.y + this.z * o.z; };
V3.prototype.cross = function(o) {
  return new V3(
    this.y * o.z - this.z * o.y,
    this.z * o.x - this.x * o.z,
    this.x * o.y - this.y * o.x);
};
V3.prototype.normalize = function() {
  var l = this.length();
  if (l < 1e-15) return new V3(0, 0, 0);
  return new V3(this.x / l, this.y / l, this.z / l);
};
V3.prototype.clone = function() { return new V3(this.x, this.y, this.z); };
V3.toArray = function(v) { return [v.x, v.y, v.z]; };

// ================= RayTracer =================
class RayTracer {
  constructor(meshData, options) {
    options = options || {};
    // 兼容旧用法：传入 THREE.Mesh（主线程 fallback 时）
    if (meshData && meshData.geometry && meshData.geometry.attributes) {
      meshData = {
        positions: meshData.geometry.attributes.position.array,
        indices: meshData.geometry.index ? meshData.geometry.index.array : null
      };
    }
    this.positions = meshData.positions;
    this.indices   = meshData.indices || null;

    this.n            = (options.n            != null) ? options.n            : 1.49;
    this.abbe         = (options.abbe != null) ? +options.abbe : 0;   // 阿贝数 Vd（色散模型用）；≤0 = 无色散（单折射率）
    this.alpha        = (options.alpha        != null) ? options.alpha        : 0.10;  // Beer-Lambert: I = I0·exp(-α·L)
    this.maxBounces   = (options.maxBounces   != null) ? options.maxBounces   : 30;
    this.numRays      = (options.numRays      != null) ? options.numRays      : 1000;
    this.angleSigma   = (options.angleSigma   != null) ? options.angleSigma   : 12;    // deg
    this.posSigma     = (options.posSigma     != null) ? options.posSigma     : 0.3;
    this.srcDist      = Math.max(0, +options.srcDist || 0);  // 非 LED 模式：灯珠到入射面距离（mm）。0=贴面发射（旧行为）
    this.visRays      = (options.visRays != null) ? Math.max(0, Math.floor(+options.visRays || 0)) : 200; // 3D 预览采集轨迹的光线配额
    this.sourceType   = options.sourceType || 'surface';   // point | line | surface
    this.emissionMode = options.emissionMode || 'lambert'; // lambert | gauss
    // LED 灯珠光源：启用时光线从灯珠发光面发射（mm 坐标，z=0 为入射端面，LED 在 z<0 侧）
    this.led = (options.led && options.led.enabled) ? options.led : null;
    // 装配偏心（mm）：沿灯珠位姿局部 X/Y 平移发光面，只动灯珠、不动导光柱（与 Viewer.applyLED 一致）
    this.ledOffsetX = this.led ? (+this.led.offsetX || 0) : 0;
    this.ledOffsetY = this.led ? (+this.led.offsetY || 0) : 0;
    // LED 位姿列表（mm 空间）：{ pos:[x,y,z], x/y/z:[方向向量], area?:mm² }，z 轴 = 发射方向（指向入射面法向）。
    // 多颗灯珠：每个入射平面一颗（computeLEDPoses 按平面聚类生成），光线数按面积加权分配。
    // 兼容旧版单 pose；无位姿 → [恒等位姿]，与参数化圆柱旧版固定坐标行为完全一致。
    var lp = options.led ? (options.led.poses || options.led.pose) : null;
    this.ledPoses = lp ? (Array.isArray(lp) ? lp : [lp]) : [RayTracer.IDENTITY_LED_POSE];
    if (!this.ledPoses.length) this.ledPoses = [RayTracer.IDENTITY_LED_POSE];

    this.inputFaceIds  = options.inputFaceIds  || [];
    this.outputFaceIds = options.outputFaceIds || [];

    // 表面咬花/雾面：按面组（入射/出射/侧面）的散射半角 σ（deg → rad）。
    // σ=0 为镜面（无扰动）；σ>0 时以高斯微面元扰动表面法线（等效模具咬花的统计粗糙度），
    // 只改变光线方向、不改变能量，能量账本守恒不受影响。
    var stx = options.surfaceTexture || null;
    this.surfaceTex = stx ? {
      input:  Math.max(0, +stx.input  || 0) * Math.PI / 180,
      output: Math.max(0, +stx.output || 0) * Math.PI / 180,
      side:   Math.max(0, +stx.side   || 0) * Math.PI / 180
    } : null;
    // 体散射（扩散粉/散光剂）：μs 为介质的散射系数（1/mm），0 = 纯吸收体。
    // 导光柱加扩散粉后，光线在体内被多次散射 → 出射端面填充更满、更均匀（实物比无粉模型更匀的原因）。
    this.muS = Math.max(0, +options.muS || 0);
    this.hgG = Math.min(0.95, Math.max(-0.95, (options.hgG != null ? +options.hgG : 0.55)));

    // 多波长色散：options.wavelengths = [{ nm, weight }]（nm 为空/缺省 → 单波长，向后兼容）。
    // 每条光线按波长携带各自的折射率 n(λ)（Cauchy 模型），统计时按 λ 分组以量化色差。
    this.wavelengths = (Array.isArray(options.wavelengths) && options.wavelengths.length)
      ? options.wavelengths.filter(function (w) { return w && +w.nm > 0; })
      : null;

    this._buildFaceData();
    this._buildGrid();
  }

  // ---- 从原始顶点/索引提取三角面元数据 ----
  _buildFaceData() {
    var pos = this.positions;
    var idx = this.indices;
    this.faces = [];
    this.faceNormals = [];
    this.faceCenters = [];
    this.faceAreas = [];

    var vA = new V3(0, 0, 0), vB = new V3(0, 0, 0), vC = new V3(0, 0, 0);
    var faceCount = idx ? idx.length / 3 : pos.length / 9;
    for (var i = 0; i < faceCount; i++) {
      var a, b, c;
      if (idx) { a = idx[i * 3]; b = idx[i * 3 + 1]; c = idx[i * 3 + 2]; }
      else     { a = i * 3;       b = i * 3 + 1;     c = i * 3 + 2; }
      vA.x = pos[a * 3]; vA.y = pos[a * 3 + 1]; vA.z = pos[a * 3 + 2];
      vB.x = pos[b * 3]; vB.y = pos[b * 3 + 1]; vB.z = pos[b * 3 + 2];
      vC.x = pos[c * 3]; vC.y = pos[c * 3 + 1]; vC.z = pos[c * 3 + 2];
      var e1 = vB.sub(vA), e2 = vC.sub(vA);
      var normal = e1.cross(e2);
      var area = normal.length() * 0.5;
      normal = normal.normalize();
      var center = new V3((vA.x + vB.x + vC.x) / 3, (vA.y + vB.y + vC.y) / 3, (vA.z + vB.z + vC.z) / 3);
      this.faces.push({a: vA.clone(), b: vB.clone(), c: vC.clone()});
      this.faceNormals.push(normal);
      this.faceCenters.push(center);
      this.faceAreas.push(area);
    }

    var mn = [1e12, 1e12, 1e12], mx = [-1e12, -1e12, -1e12];
    for (var k = 0; k < pos.length; k += 3) {
      if (pos[k]     < mn[0]) mn[0] = pos[k];
      if (pos[k + 1] < mn[1]) mn[1] = pos[k + 1];
      if (pos[k + 2] < mn[2]) mn[2] = pos[k + 2];
      if (pos[k]     > mx[0]) mx[0] = pos[k];
      if (pos[k + 1] > mx[1]) mx[1] = pos[k + 1];
      if (pos[k + 2] > mx[2]) mx[2] = pos[k + 2];
    }
    this.bboxMin = mn;
    this.bboxMax = mx;
    var sizeX = mx[0] - mn[0], sizeY = mx[1] - mn[1], sizeZ = mx[2] - mn[2];
    this.gridSize = Math.max(sizeX, sizeY, sizeZ);
    if (this.gridSize < 0.001) this.gridSize = 1.0;
  }

  // ---- 空间网格加速结构 ----
  _buildGrid() {
    var cellSize = this.gridSize / 30;
    if (cellSize < 1e-5) cellSize = 1e-5;
    this.gridCellSize = cellSize;
    this.gridOrigin = this.bboxMin.slice();
    this.grid = new Map();
    var mnX = this.bboxMin[0], mnY = this.bboxMin[1], mnZ = this.bboxMin[2];
    for (var i = 0; i < this.faces.length; i++) {
      var c = this.faceCenters[i];
      var gx = Math.floor((c.x - mnX) / cellSize);
      var gy = Math.floor((c.y - mnY) / cellSize);
      var gz = Math.floor((c.z - mnZ) / cellSize);
      var key = gx + ',' + gy + ',' + gz;
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(i);
    }
  }

  _getNearbyFaces(point, radius) {
    radius = radius == null ? 2 : radius;
    var gx = Math.floor((point.x - this.gridOrigin[0]) / this.gridCellSize);
    var gy = Math.floor((point.y - this.gridOrigin[1]) / this.gridCellSize);
    var gz = Math.floor((point.z - this.gridOrigin[2]) / this.gridCellSize);
    var result = [];
    var seen = new Set();
    for (var dx = -radius; dx <= radius; dx++)
      for (var dy = -radius; dy <= radius; dy++)
        for (var dz = -radius; dz <= radius; dz++) {
          var key = (gx + dx) + ',' + (gy + dy) + ',' + (gz + dz);
          if (!this.grid.has(key)) continue;
          var arr = this.grid.get(key);
          for (var k = 0; k < arr.length; k++) {
            var idx = arr[k];
            if (!seen.has(idx)) { seen.add(idx); result.push(idx); }
          }
        }
    return result;
  }

  // ---- Ray / Triangle 求交（Möller–Trumbore） ----
  _rayTriangle(origin, dir, face) {
    var eps = 1e-9;
    var e1 = face.b.sub(face.a);
    var e2 = face.c.sub(face.a);
    var h  = dir.cross(e2);
    var a  = e1.dot(h);
    if (a > -eps && a < eps) return null;
    var f  = 1 / a;
    var s  = origin.sub(face.a);
    var u  = f * s.dot(h);
    if (u < 0 || u > 1) return null;
    var q  = s.cross(e1);
    var v  = f * dir.dot(q);
    if (v < 0 || u + v > 1) return null;
    var t  = f * e2.dot(q);
    if (t > eps) return { t: t, u: u, v: v };
    return null;
  }

  // ---- 网格加速的 raycast（网格没中时回退到全扫） ----
  _raycast(origin, dir, excludeSet) {
    var candidates = this._getNearbyFaces(origin, 2);
    var hit = this._scanCandidates(origin, dir, candidates, excludeSet);
    if (hit) return hit;
    if (candidates.length < this.faces.length) {
      candidates = this._getNearbyFaces(origin, 4);
      hit = this._scanCandidates(origin, dir, candidates, excludeSet);
      if (hit) return hit;
    }
    return this._scanCandidates(origin, dir, null, excludeSet);
  }
  _scanCandidates(origin, dir, faceIds, excludeSet) {
    var nearest = null, nearestIdx = -1;
    var n = faceIds ? faceIds.length : this.faces.length;
    for (var k = 0; k < n; k++) {
      var idx = faceIds ? faceIds[k] : k;
      if (excludeSet && excludeSet.has(idx)) continue;
      var h = this._rayTriangle(origin, dir, this.faces[idx]);
      if (h && (nearest === null || h.t < nearest.t)) {
        nearest = h; nearestIdx = idx;
      }
    }
    return nearest ? { t: nearest.t, u: nearest.u, v: nearest.v, faceIdx: nearestIdx } : null;
  }

  // ---- 折射 / 反射 ----
  _refract(incident, normal, n1, n2) {
    var eta = n1 / n2;
    var cosI = -incident.dot(normal);
    var sinT2 = eta * eta * (1 - cosI * cosI);
    if (sinT2 > 1) return null; // 全反射
    var cosT = Math.sqrt(1 - sinT2);
    return incident.scale(eta).add(normal.scale(eta * cosI - cosT)).normalize();
  }
  _reflect(incident, normal) {
    return incident.sub(normal.scale(2 * incident.dot(normal))).normalize();
  }
  _gaussian() {
    var u1 = Math.random() + 1e-10;
    var u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // 体散射相函数采样：Henyey-Greenstein（g>0 前向散射，扩散粉典型值 0.5~0.7）
  _hgScatter(dir, g) {
    var u1 = Math.random() + 1e-9, u2 = Math.random();
    var cosT;
    if (Math.abs(g) < 1e-4) {
      cosT = 1 - 2 * u1;
    } else {
      var sq = (1 - g * g) / (1 - g + 2 * g * u1);
      cosT = (1 + g * g - sq * sq) / (2 * g);
    }
    cosT = Math.max(-1, Math.min(1, cosT));
    var sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    var phi = 2 * Math.PI * u2;
    var up = Math.abs(dir.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
    var t1 = up.cross(dir).normalize();
    var t2 = dir.cross(t1).normalize();
    return dir.scale(cosT)
      .add(t1.scale(sinT * Math.cos(phi)))
      .add(t2.scale(sinT * Math.sin(phi)))
      .normalize();
  }

  // 咬花/雾面法线扰动：在法线切平面内叠加高斯斜率（sigmaRad 为散射半角，弧度）。
  // 扰动后的法线若背向入射光线（dot>0，掠射下的过度扰动），由调用方回退几何法线。
  _perturbNormal(n, sigmaRad) {
    var up = Math.abs(n.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
    var t1 = up.cross(n).normalize();
    var t2 = n.cross(t1).normalize();
    var gx = this._gaussian() * sigmaRad;
    var gy = this._gaussian() * sigmaRad;
    return n.add(t1.scale(Math.tan(gx))).add(t2.scale(Math.tan(gy))).normalize();
  }
  _lambert() {
    // 朗伯取样：关于 +Z，之后旋转
    var u1 = Math.random(), u2 = Math.random();
    var r = Math.sqrt(u1), phi = 2 * Math.PI * u2;
    return new V3(r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - u1)));
  }

  // ---- Halton 低差异序列（确定性的均匀采样，避免随机聚簇导致的局部过密/过疏） ----
  _halton(index, base) {
    var f = 1, r = 0, i = index;
    while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
    return r;
  }

  // ---- 生成光线（多波长入口：按权重把 numRays 分配给各 λ，逐 λ 生成并标注 lam/n） ----
  _generateRays() {
    if (!this.wavelengths) return this._generateSingleWavelengthRays();
    var total = this.numRays;
    var counts = RayTracer._allocate(total, this.wavelengths.map(function (w) { return +w.weight || 1; }));
    var out = [];
    for (var i = 0; i < this.wavelengths.length; i++) {
      if (counts[i] <= 0) continue;
      this.numRays = counts[i];
      var rays = this._generateSingleWavelengthRays();
      var nLam = RayTracer.cauchy(this.n, this.abbe, this.wavelengths[i].nm);
      for (var j = 0; j < rays.length; j++) { rays[j].lam = this.wavelengths[i].nm; rays[j].n = nLam; }
      out = out.concat(rays);
    }
    this.numRays = total;
    return out;
  }

  // ---- 单波长光线生成（原 _generateRays 主体） ----
  _generateSingleWavelengthRays() {
    // LED 灯珠模式：光线从灯珠发光面发射（无需入射端面也可生成）
    if (this.led) return this._generateLEDRays();
    if (this.inputFaceIds.length === 0) return [];
    var inC = new V3(0, 0, 0), totalA = 0;
    for (var i = 0; i < this.inputFaceIds.length; i++) {
      var idx = this.inputFaceIds[i];
      inC.x += this.faceCenters[idx].x * this.faceAreas[idx];
      inC.y += this.faceCenters[idx].y * this.faceAreas[idx];
      inC.z += this.faceCenters[idx].z * this.faceAreas[idx];
      totalA += this.faceAreas[idx];
    }
    inC.x /= totalA; inC.y /= totalA; inC.z /= totalA;

    var avgN = new V3(0, 0, 0);
    for (var i2 = 0; i2 < this.inputFaceIds.length; i2++) {
      var idx2 = this.inputFaceIds[i2];
      avgN.x += this.faceNormals[idx2].x * this.faceAreas[idx2];
      avgN.y += this.faceNormals[idx2].y * this.faceAreas[idx2];
      avgN.z += this.faceNormals[idx2].z * this.faceAreas[idx2];
      avgN.x /= totalA; avgN.y /= totalA; avgN.z /= totalA;
    }
    avgN = avgN.normalize();

    // 判定入射方向：负法线方向打得到内部就用它
    var inward = avgN.scale(-1);
    var inputSet = new Set(this.inputFaceIds);
    var probeOrigin = inC.add(inward.scale(0.005));
    if (!this._raycast(probeOrigin, inward, inputSet)) {
      inward = avgN;
    }

    // 局部坐标系
    var up = Math.abs(inward.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
    var right = up.cross(inward).normalize();
    var realUp = inward.cross(right).normalize();

    var sigmaRad = this.angleSigma * Math.PI / 180;
    var srcType = this.sourceType || 'surface';
    var dist = this.srcDist;   // 灯珠到入射面距离：>0 时光线从空气中发射，折射进入介质
    var rays = [];

    if (srcType === 'point') {
      // 点光源：所有光线从入射面中心（前移 dist）一点发出，按发散半角锥形扩散
      var pOrigin = dist > 0 ? inC.add(inward.scale(-dist)) : inC.clone();
      for (var ip = 0; ip < this.numRays; ip++) {
        var dir;
        if (this.emissionMode === 'lambert') {
          var lv = this._lambert();
          var ld = right.scale(lv.x).add(realUp.scale(lv.y)).add(inward.scale(lv.z)).normalize();
          var jx = this._gaussian() * sigmaRad * 0.15;
          var jy = this._gaussian() * sigmaRad * 0.15;
          dir = ld.add(right.scale(jx)).add(realUp.scale(jy)).normalize();
        } else {
          var dx = this._gaussian() * sigmaRad;
          var dy = this._gaussian() * sigmaRad;
          dir = inward.add(right.scale(dx)).add(realUp.scale(dy)).normalize();
        }
        if (dist > 0) {
          // 空气中发射：先飞行 dist 距离，再在入射面折射（inside:false）
          rays.push({ origin: pOrigin.clone(), dir: dir, inside: false });
        } else {
          rays.push({ origin: pOrigin.add(dir.scale(0.005 * this.gridSize)), dir: dir });
        }
      }
      return rays;
    }

    // ---- 线/面平行光：入射面均匀采样（面积加权分配 + Halton 低差异序列） ----
    // [1] 按各三角形面积占比分配光线数（最大余数法保证总数严格等于 numRays）
    var counts = [], assigned = 0, remainders = [];
    for (var i3 = 0; i3 < this.inputFaceIds.length; i3++) {
      var exact = this.numRays * this.faceAreas[this.inputFaceIds[i3]] / totalA;
      var cnt = Math.floor(exact);
      counts.push(cnt); assigned += cnt;
      remainders.push({ i: i3, rem: exact - cnt });
    }
    remainders.sort(function (a, b) { return b.rem - a.rem; });
    for (var leftover = this.numRays - assigned; leftover > 0; leftover--) {
      counts[remainders[(this.numRays - assigned - leftover) % remainders.length].i]++;
    }

    // [2] 逐面生成：面内用 Halton(2,3) 序列做均匀采样（sqrt 折叠映射到三角形）
    for (var fi = 0; fi < this.inputFaceIds.length; fi++) {
      var faceIdx = this.inputFaceIds[fi];
      var face = this.faces[faceIdx];
      var n = counts[fi];
      for (var k = 0; k < n; k++) {
        var u1 = this._halton(k + 1, 2), u2 = this._halton(k + 1, 3);
        var r1 = Math.sqrt(u1);
        // 均匀三角形映射：P = (1-√u1)·a + √u1(1-u2)·b + √u1·u2·c
        var samplePt = face.a.scale(1 - r1)
          .add(face.b.scale(r1 * (1 - u2)))
          .add(face.c.scale(r1 * u2));
        var origin;
        if (srcType === 'line') {
          // 线平行光：采样点投影到过面心的一条直径（right 方向）上
          var v = samplePt.sub(inC);
          var along = v.dot(right) * this.posSigma;
          origin = inC.add(right.scale(along));
        } else {
          // 面平行光：posSigma 控制从面心到全面采样的混合比例
          origin = inC.add(samplePt.sub(inC).scale(this.posSigma));
        }
        // 平行光：方向 = inward，仅保留极小高斯扰动（angleSigma 的 10%）
        var pdx = this._gaussian() * sigmaRad * 0.1;
        var pdy = this._gaussian() * sigmaRad * 0.1;
        var dir2 = inward.add(right.scale(pdx)).add(realUp.scale(pdy)).normalize();
        if (dist > 0) {
          // 从入射面前方 dist 处的空气中发射（inside:false），保持发射位置铺满分布
          rays.push({ origin: origin.add(inward.scale(-dist)), dir: dir2, inside: false });
        } else {
          var initOffset = 0.005 * this.gridSize;
          rays.push({ origin: origin.add(dir2.scale(initOffset)), dir: dir2 });
        }
      }
    }
    return rays;
  }

  // ---- LED 灯珠发光面光线生成 ----
  // 坐标约定与 Viewer.applyLED 一致：LED 局部系中 z=0 为导光柱入射端面，LED 位于 z<0 侧，
  // 发光面（最靠近 z=0 的面）在 z=-gap。光线从发光面外表面发出，
  // 方向按真实 LED 发光方式：围绕发光点局部表面法线的朗伯/高斯分布。
  // 球形灯珠（凹面/凸面）的发光面为球冠曲面，法线沿球面径向。
  // LED 位姿列表 this.ledPoses（mm 空间）将局部坐标映射到世界坐标：
  //   world = pos + X·px + Y·py + Z·pz
  // 位姿由入射面中心/法向量计算（computeLEDPoses，每个入射平面一颗灯珠），
  // 恒等位姿保持参数化圆柱旧版行为。
  _generateLEDRays() {
    var p = this.led;
    function pget(v, def) { return (v != null && !isNaN(+v)) ? +v : def; }
    var L = Math.max(0.3, pget(p.length, 3));
    var W = Math.max(0.3, pget(p.width, 2));
    var H = Math.max(0.3, pget(p.height, 1.5));
    var gap = Math.max(0, pget(p.gap, 0.5));
    var type = p.type || 'rectangle';

    // 发光面采样器：均匀采样发光面并返回 { point, normal }（局部系，法线朝 +Z / 发光方向半球）
    var sampler;
    if (type === 'concave') {
      // 凹面球碗：碗沿半径 r=W/2 在 z=-gap，碗底深 concaveDepth
      var r = W / 2;
      var d = Math.min(Math.max(0.1, pget(p.concaveDepth, 0.4)), H * 0.7);
      var R = (r * r + d * d) / (2 * d);
      var cz = -gap - d + R;                 // 球心 z（在发光面上方）
      var cosMax = (R - d) / R;              // 碗沿对应 cosθ（θ 从 -Z 轴量起）
      sampler = function () {
        var cosT = cosMax + (1 - cosMax) * Math.random();   // 球冠均匀采样
        var sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        var phi = 2 * Math.PI * Math.random();
        var pt = new V3(R * sinT * Math.cos(phi), R * sinT * Math.sin(phi), cz - R * cosT);
        // 凹面法线（朝 +Z 半球）= 指向球心
        return { point: pt, normal: new V3(-sinT * Math.cos(phi), -sinT * Math.sin(phi), cosT) };
      };
    } else if (type === 'convex') {
      // 凸面球冠：顶点在 z=-gap，底沿半径 r=W/2 在 z=-gap-domeH
      var r2 = W / 2;
      var domeR = Math.max(Math.max(0.2, pget(p.convexRadius, 0.6)), r2);
      var domeH = domeR - Math.sqrt(Math.max(0, domeR * domeR - r2 * r2));
      var cz2 = -gap - domeR;                // 球心 z（在发光面下方）
      var cosMax2 = (domeR - domeH) / domeR; // 底沿对应 cosθ（θ 从 +Z 轴量起）
      sampler = function () {
        var cosT = cosMax2 + (1 - cosMax2) * Math.random();
        var sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        var phi = 2 * Math.PI * Math.random();
        var pt = new V3(domeR * sinT * Math.cos(phi), domeR * sinT * Math.sin(phi), cz2 + domeR * cosT);
        // 凸面法线 = 背向球心（径向朝外）
        return { point: pt, normal: new V3(sinT * Math.cos(phi), sinT * Math.sin(phi), cosT) };
      };
    } else {
      // 矩形 / 正方形：z=-gap 平面上 L×W 发光面，法线 +Z
      sampler = function () {
        return {
          point: new V3((Math.random() - 0.5) * L, (Math.random() - 0.5) * W, -gap),
          normal: new V3(0, 0, 1)
        };
      };
    }

    var sigmaRad = this.angleSigma * Math.PI / 180;
    var off = 0.001 * this.gridSize;
    var rays = [];

    // 多灯珠：总光线数按各入射面面积加权分配（位姿缺 area 时按 1 计 → 均分）
    var poses = this.ledPoses;
    var totalA = 0;
    for (var pa = 0; pa < poses.length; pa++) totalA += (poses[pa].area > 0 ? poses[pa].area : 1);
    var counts = [], assigned = 0;
    for (var pc = 0; pc < poses.length; pc++) {
      var share = (poses[pc].area > 0 ? poses[pc].area : 1) / totalA;
      var cnt = (pc === poses.length - 1) ? (this.numRays - assigned) : Math.round(this.numRays * share);
      cnt = Math.max(0, cnt);
      counts.push(cnt);
      assigned += cnt;
    }

    for (var pi = 0; pi < poses.length; pi++) {
      // LED 位姿基向量（mm 空间）
      var pose = poses[pi] || RayTracer.IDENTITY_LED_POSE;
      var px = pose.pos, ax = pose.x, ay = pose.y, az = pose.z;
      // 装配偏心：发光面整体沿位姿局部 X/Y 平移（与 Viewer.applyLED 的偏移公式一致）
      if (this.ledOffsetX || this.ledOffsetY) {
        px = [
          px[0] + ax[0] * this.ledOffsetX + ay[0] * this.ledOffsetY,
          px[1] + ax[1] * this.ledOffsetX + ay[1] * this.ledOffsetY,
          px[2] + ax[2] * this.ledOffsetX + ay[2] * this.ledOffsetY
        ];
      }
      // 局部点/方向 → 世界（方向仅旋转，不做平移）
      var toWorldPt = function (lx, ly, lz) {
        return new V3(
          px[0] + ax[0] * lx + ay[0] * ly + az[0] * lz,
          px[1] + ax[1] * lx + ay[1] * ly + az[1] * lz,
          px[2] + ax[2] * lx + ay[2] * ly + az[2] * lz);
      };
      var toWorldDir = function (lx, ly, lz) {
        return new V3(
          ax[0] * lx + ay[0] * ly + az[0] * lz,
          ax[1] * lx + ay[1] * ly + az[1] * lz,
          ax[2] * lx + ay[2] * ly + az[2] * lz);
      };
      for (var i = 0; i < counts[pi]; i++) {
        var s = sampler();
        var n = toWorldDir(s.normal.x, s.normal.y, s.normal.z).normalize();      // 世界系发光点法线
        // 以法线为轴的正交基：up 候选依次为位姿局部 Y/X → 世界 Y/X（避免与 n 平行）
        var up = ay ? new V3(ay[0], ay[1], ay[2]) : new V3(0, 1, 0);
        if (Math.abs(n.dot(up)) > 0.9) up = new V3(ax[0], ax[1], ax[2]);
        if (Math.abs(n.dot(up)) > 0.9) up = new V3(0, 1, 0);
        if (Math.abs(n.dot(up)) > 0.9) up = new V3(1, 0, 0);
        var right = up.cross(n).normalize();
        var realUp = n.cross(right).normalize();
        var dir;
        if (this.emissionMode === 'lambert') {
          var lv = this._lambert();
          dir = right.scale(lv.x).add(realUp.scale(lv.y)).add(n.scale(lv.z)).normalize();
        } else {
          var dx = this._gaussian() * sigmaRad;
          var dy = this._gaussian() * sigmaRad;
          dir = n.add(right.scale(dx)).add(realUp.scale(dy)).normalize();
        }
        var origin = toWorldPt(s.point.x, s.point.y, s.point.z);
        // inside:false —— 光线起始于空气中，先飞行 gap 距离，再在导光柱表面折射入射
        rays.push({ origin: origin.add(dir.scale(off)), dir: dir, inside: false });
      }
    }
    return rays;
  }

  // ---- 单条光线追踪（吸收 + 能量账本 + 命中采集） ----
  _traceRay(ray) {
    var segments = [];
    var origin = ray.origin.clone();
    var dir = ray.dir.clone();
    var intensity = 1.0;
    var nMat = (ray.n != null) ? ray.n : this.n;   // 该光线的折射率（多波长时按 λ 取值）
    var inside = (ray.inside !== false);   // LED 光线起始于空气（inside=false），折射后进入介质
    var bounces = 0;
    var hitOutput = false;
    var escaped = false;
    var absorbedE = 0.0;
    var leakResidual = 0.0; // 无交点数值泄漏时保留的能量（守恒用）
    var outHit = null, sideHit = null;
    var maxDim = this.gridSize;
    var offset = 0.003 * maxDim;

    var inputSet  = new Set(this.inputFaceIds);
    var outputSet = new Set(this.outputFaceIds);
    var prevHit   = new Set();

    var scatters = 0;   // 体散射次数单独计数：散射不是表面反射，不应占用 maxBounces 预算
    while (bounces < this.maxBounces && scatters < 500 && intensity > 1e-4) {
      var exclude = new Set(prevHit);
      if (inside) { for (var fi = 0; fi < this.inputFaceIds.length; fi++) exclude.add(this.inputFaceIds[fi]); }

      var hit = this._raycast(origin, dir, exclude);
      if (!hit) { escaped = true; leakResidual = intensity; break; }

      var hitPt = origin.add(dir.scale(hit.t));
      var segLen = hit.t;

      // ---- 体散射（扩散粉匀光）：按指数自由程抽样散射点 ----
      // 模拟法蒙特卡洛：先抽散射自由程 s ~ Exp(μs)。若散射发生在到达表面前，
      // 就在该点按 HG 相函数改变方向继续传播（吸收只计 s 段）；否则原样到达表面。
      if (inside && this.muS > 0) {
        var sScat = -Math.log(1 - Math.random()) / this.muS;
        if (sScat < segLen) {
          if (this.alpha > 0) {
            var fa = 1 - Math.exp(-this.alpha * sScat);
            absorbedE += intensity * fa;
            intensity *= (1 - fa);
          }
          var spt = origin.add(dir.scale(sScat));
          segments.push({
            start: V3.toArray(origin), end: V3.toArray(spt),
            length: sScat, intensity: intensity, type: 'in-body'
          });
          var sdir = this._hgScatter(dir, this.hgG);
          // 散射点在体内，只需极小偏移避免自交；不能用面反弹的 offset（0.3% 尺寸），
          // 否则近表面散射会被推出实体，导致光线丢失并虚增“残留/未出”。
          origin = spt.add(sdir.scale(1e-5 * maxDim));
          dir = sdir;
          scatters++;
          continue;
        }
      }

      // Beer-Lambert 吸收：介质内传播段衰减，同时记账
      if (inside && this.alpha > 0) {
        var frac = 1 - Math.exp(-this.alpha * segLen);
        absorbedE += intensity * frac;
        intensity *= (1 - frac);
      }

      var faceNormal = this.faceNormals[hit.faceIdx];
      if (faceNormal.dot(dir) > 0) faceNormal = faceNormal.scale(-1);

      // 表面咬花/雾面：按面组（入射/出射/侧面）以 σ 高斯微面元扰动法线
      var sigma = 0, st = this.surfaceTex;
      if (st) {
        if (outputSet.has(hit.faceIdx)) sigma = st.output;
        else if (inputSet.has(hit.faceIdx)) sigma = st.input;
        else sigma = st.side;
      }
      var nEff = sigma > 0 ? this._perturbNormal(faceNormal, sigma) : faceNormal;
      if (nEff.dot(dir) > 0) nEff = faceNormal;   // 掠射下过度扰动 → 回退几何法线

      // 输出面命中 → 折射出射即成功；若（曲面/咬花扰动后）入射角超过临界角则全反射回体内继续传播
      if (inside && outputSet.has(hit.faceIdx)) {
        var dExit = this._refract(dir, nEff, nMat, 1.0);
        if (dExit) {
          segments.push({
            start: V3.toArray(origin), end: V3.toArray(hitPt),
            length: segLen, intensity: intensity, type: 'success'
          });
          var exitEnd = hitPt.add(dExit.scale(maxDim * 0.3));
          segments.push({
            start: V3.toArray(hitPt), end: V3.toArray(exitEnd),
            length: maxDim * 0.08, intensity: intensity * 0.8, type: 'success'
          });
          outHit = {
            p: V3.toArray(hitPt), i: intensity,
            d: V3.toArray(dir), dExit: V3.toArray(dExit),
            lam: (ray.lam != null) ? ray.lam : null
          };
          hitOutput = true;
          break;
        }
        // dExit 为 null：出射面 TIR —— 走下方通用分支（记录 in-body 段并镜面反射回体内）
      }

      segments.push({
        start: V3.toArray(origin), end: V3.toArray(hitPt),
        length: segLen, intensity: intensity,
        type: inside ? 'in-body' : 'escape'
      });

      var n1 = inside ? nMat : 1.0;
      var n2 = inside ? 1.0  : nMat;
      var refracted = this._refract(dir, nEff, n1, n2);
      prevHit.clear();
      prevHit.add(hit.faceIdx);

      if (refracted && inside && inputSet.has(hit.faceIdx)) refracted = null;

      if (refracted) {
        if (inside) {
          var escEnd = hitPt.add(refracted.scale(maxDim * 0.3));
          segments.push({
            start: V3.toArray(hitPt), end: V3.toArray(escEnd),
            length: maxDim * 0.15, intensity: intensity * 0.8, type: 'escape'
          });
          sideHit = { p: V3.toArray(hitPt), i: intensity, d: V3.toArray(refracted) };
          escaped = true;
          break;
        } else {
          inside = true;
        }
        dir = refracted;
        origin = hitPt.add(dir.scale(offset));
      } else {
        dir = this._reflect(dir, nEff);
        origin = hitPt.add(dir.scale(offset));
      }
      bounces++;
    }

    var residualE = (!hitOutput && !escaped) ? intensity : leakResidual;
    return {
      segments: segments, hitOutput: hitOutput, escaped: escaped, bounces: bounces,
      finalIntensity: intensity, absorbedE: absorbedE,
      outHit: outHit, sideHit: sideHit, residualE: residualE
    };
  }

  // ---- 批量追踪 ----
  simulate(onProgress) {
    var rays = this._generateRays();
    var total = rays.length;
    var results = {
      total: total, success: 0, escaped: 0, exhausted: 0, segments: [],
      totalIntensity: 0, maxBounces: 0,
      outputHits: [], sideHits: [],
      ledger: { output: 0, side: 0, absorbed: 0, residual: 0 }
    };

    var BATCH = 200;
    // 轨迹可视化配额：仅抽 visRays 条光线采集 segments（统计指标始终基于全部 numRays），
    // 避免万级光线 × 多段反弹产生超大 segments 数组拖垮传输与渲染（worker 曾有 6000 段静默丢弃上限）。
    // 按等间隔抽取而非取前 N 条：光线按入射三角面顺序生成，取前 N 条会全部集中在最初几个三角面，
    // 多面入射时可视光线的空间分布严重偏斜；等间隔抽取可覆盖整个入射面与全部光线。
    var visLimit = Math.min(this.visRays, total);
    var visIdx = [];
    for (var v = 0; v < visLimit; v++) visIdx.push(Math.floor(v * total / visLimit));
    var visPtr = 0;
    for (var i = 0; i < total; i++) {
      var r = this._traceRay(rays[i]);
      if (visPtr < visIdx.length && i === visIdx[visPtr]) {
        visPtr++;
        for (var j = 0; j < r.segments.length; j++) results.segments.push(r.segments[j]);
      }
      if (r.hitOutput) {
        results.success++;
        results.totalIntensity += r.finalIntensity;
        results.ledger.output += r.outHit.i;
        results.outputHits.push(r.outHit);
      } else if (r.escaped) {
        results.escaped++;
        results.ledger.side += r.sideHit ? r.sideHit.i : 0;
        if (r.sideHit) results.sideHits.push(r.sideHit);
      } else {
        results.exhausted++;
      }
      results.ledger.absorbed += r.absorbedE;
      results.ledger.residual += r.residualE;
      if (r.bounces > results.maxBounces) results.maxBounces = r.bounces;
      if ((i + 1) % BATCH === 0 && typeof onProgress === 'function') {
        onProgress(i + 1, total);
      }
    }

    results.successRate = total > 0 ? (results.success / total * 100).toFixed(1) : '0.0';
    results.avgOutputIntensity = results.success > 0
      ? (results.totalIntensity / results.success).toFixed(3) : '0.000';
    results.visRays = visLimit;   // 实际采集轨迹的光线数（3D 预览用）
    return results;
  }

  // ---- 聚合分析：热图 / 轴向分布 / 角度分布 / 均匀性指标 ----
  aggregate(results, opts) {
    opts = opts || {};
    var res = Math.min(256, Math.max(8, opts.heatmapRes || 64));
    var axisBins = Math.min(512, Math.max(8, opts.axisBins || 64));
    var angleBinDeg = Math.min(10, Math.max(0.5, opts.angleBinDeg || 2));

    // --- 输出面基准（面积加权中心 + 平均法线） ---
    var oc = [0, 0, 0], on = [0, 0, 0], totalA = 0;
    for (var i = 0; i < this.outputFaceIds.length; i++) {
      var id = this.outputFaceIds[i];
      var A = this.faceAreas[id];
      oc[0] += this.faceCenters[id].x * A; oc[1] += this.faceCenters[id].y * A; oc[2] += this.faceCenters[id].z * A;
      on[0] += this.faceNormals[id].x * A; on[1] += this.faceNormals[id].y * A; on[2] += this.faceNormals[id].z * A;
      totalA += A;
    }
    if (totalA > 0) { oc[0] /= totalA; oc[1] /= totalA; oc[2] /= totalA; }
    var oLen = Math.sqrt(on[0] * on[0] + on[1] * on[1] + on[2] * on[2]) || 1;
    on[0] /= oLen; on[1] /= oLen; on[2] /= oLen;
    var up = Math.abs(on[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    var uv = [
      up[1] * on[2] - up[2] * on[1],
      up[2] * on[0] - up[0] * on[2],
      up[0] * on[1] - up[1] * on[0]
    ];
    var uLen = Math.sqrt(uv[0] * uv[0] + uv[1] * uv[1] + uv[2] * uv[2]) || 1;
    uv[0] /= uLen; uv[1] /= uLen; uv[2] /= uLen;
    var vv = [
      on[1] * uv[2] - on[2] * uv[1],
      on[2] * uv[0] - on[0] * uv[2],
      on[0] * uv[1] - on[1] * uv[0]
    ];

    // --- 主轴（bbox 最长维，轴向分布用） ---
    var dims = [
      this.bboxMax[0] - this.bboxMin[0],
      this.bboxMax[1] - this.bboxMin[1],
      this.bboxMax[2] - this.bboxMin[2]
    ];
    var ai = 0;
    if (dims[1] >= dims[0] && dims[1] >= dims[2]) ai = 1;
    else if (dims[2] >= dims[0] && dims[2] >= dims[1]) ai = 2;

    // --- 热图 binning ---
    var u0 = 1e12, u1 = -1e12, v0 = 1e12, v1 = -1e12;
    var proj = [];
    for (var h1 = 0; h1 < results.outputHits.length; h1++) {
      var P = results.outputHits[h1].p;
      var rel = [P[0] - oc[0], P[1] - oc[1], P[2] - oc[2]];
      var du = rel[0] * uv[0] + rel[1] * uv[1] + rel[2] * uv[2];
      var dv = rel[0] * vv[0] + rel[1] * vv[1] + rel[2] * vv[2];
      proj.push([du, dv, results.outputHits[h1].i]);
      if (du < u0) u0 = du; if (du > u1) u1 = du;
      if (dv < v0) v0 = dv; if (dv > v1) v1 = dv;
    }
    var padU = (u1 - u0) * 0.02 || 0.001, padV = (v1 - v0) * 0.02 || 0.001;
    u0 -= padU; u1 += padU; v0 -= padV; v1 += padV;
    var cells = new Array(res * res).fill(0);
    var counts = new Array(res * res).fill(0);
    for (var h2 = 0; h2 < proj.length; h2++) {
      var iu = Math.floor((proj[h2][0] - u0) / (u1 - u0) * res);
      var iv = Math.floor((proj[h2][1] - v0) / (v1 - v0) * res);
      if (iu < 0) iu = 0; if (iu >= res) iu = res - 1;
      if (iv < 0) iv = 0; if (iv >= res) iv = res - 1;
      cells[iv * res + iu] += proj[h2][2];
      counts[iv * res + iu]++;
    }

    // --- 热图指标：与 charts.computeMetrics 同口径 ---
    // 直接按细格取 min/avg 会被单光线量化噪声钉死 Emin（≈1），使 uniformity
    // 退化成 1/平均亮度（越亮反而"越不均匀"）。先聚合成 N×N 块（等效探测器像元
    // 面积积分）再腐蚀 1 圈去边缘部分照射块，最后统计 Emin/Eavg、CV。
    var rMin = res, rMax = -1, cMin = res, cMax = -1, litN = 0;
    var fSum = 0, fMin = Infinity, fMax = -Infinity;
    for (var rc = 0; rc < res; rc++) {
      var baseR = rc * res;
      for (var cc = 0; cc < res; cc++) {
        if (counts[baseR + cc] > 0) {
          litN++;
          var vFine = cells[baseR + cc];
          fSum += vFine;
          if (vFine < fMin) fMin = vFine;
          if (vFine > fMax) fMax = vFine;
          if (rc < rMin) rMin = rc;
          if (rc > rMax) rMax = rc;
          if (cc < cMin) cMin = cc;
          if (cc > cMax) cMax = cc;
        }
      }
    }
    var vals = [];
    if (litN > 0) {
      var bw = cMax - cMin + 1, bh = rMax - rMin + 1;
      var nb = Math.round(Math.min(bw, bh) / 3);
      if (nb < 6) nb = 6;
      if (nb > 16) nb = 16;
      var cEdge = [], rEdge = [], qq;
      for (qq = 0; qq <= nb; qq++) cEdge.push(cMin + Math.floor(qq * bw / nb));
      for (qq = 0; qq <= nb; qq++) rEdge.push(rMin + Math.floor(qq * bh / nb));
      var bE = new Float64Array(nb * nb), bI = new Float64Array(nb * nb), bArea = new Int32Array(nb * nb);
      var bb, iMax = 0;
      for (var br = 0; br < nb; br++) {
        for (var bc = 0; bc < nb; bc++) {
          var r0 = rEdge[br], r1 = rEdge[br + 1], c0 = cEdge[bc], c1 = cEdge[bc + 1];
          var eSum = 0;
          for (var r3 = r0; r3 < r1; r3++) {
            for (var c3 = c0; c3 < c1; c3++) {
              var i3 = r3 * res + c3;
              if (counts[i3] > 0) eSum += cells[i3];
            }
          }
          var bi0 = br * nb + bc;
          bE[bi0] = eSum;
          bArea[bi0] = (r1 - r0) * (c1 - c0) || 1;
          bI[bi0] = bE[bi0] / bArea[bi0];
          if (bI[bi0] > iMax) iMax = bI[bi0];
        }
      }
      // 有效块：照度 ≥5% 峰值，剔除零星单光线杂散块；再腐蚀 1 圈去边缘部分照射块
      var mask = new Uint8Array(nb * nb), mCnt = 0;
      for (bb = 0; bb < nb * nb; bb++) {
        if (iMax > 0 && bI[bb] >= 0.05 * iMax) { mask[bb] = 1; mCnt++; }
      }
      var curM = mask;
      var nextM = new Uint8Array(nb * nb);
      for (var rr = 0; rr < nb; rr++) {
        for (var cc2 = 0; cc2 < nb; cc2++) {
          var ii = rr * nb + cc2;
          if (!curM[ii]) continue;
          if (rr > 0 && !curM[ii - nb]) continue;
          if (rr < nb - 1 && !curM[ii + nb]) continue;
          if (cc2 > 0 && !curM[ii - 1]) continue;
          if (cc2 < nb - 1 && !curM[ii + 1]) continue;
          nextM[ii] = 1;
        }
      }
      var core = mask, eCnt = 0;
      for (bb = 0; bb < nb * nb; bb++) { if (nextM[bb]) eCnt++; }
      if (eCnt >= Math.max(4, Math.round(mCnt * 0.3))) core = nextM;
      for (bb = 0; bb < nb * nb; bb++) { if (core[bb]) vals.push(bI[bb]); }
    }
    if (vals.length === 0) vals.push(0);
    // 均匀性/CV/达标率取「块照度」分布；avg/min/max 保持细格口径（峰值亮度等指标不变）
    var bAvg = 0, bMin = 0, bStd = 0, bPass = 0;
    for (var c2 = 0; c2 < vals.length; c2++) bAvg += vals[c2];
    bAvg /= vals.length;
    bMin = Infinity;
    for (var c3i = 0; c3i < vals.length; c3i++) {
      if (vals[c3i] < bMin) bMin = vals[c3i];
      bStd += (vals[c3i] - bAvg) * (vals[c3i] - bAvg);
      if (vals[c3i] >= 0.8 * bAvg) bPass++;
    }
    bStd = Math.sqrt(bStd / vals.length);
    if (bMin === Infinity) bMin = 0;
    var metrics = {
      n: litN, nCore: vals.length,
      avg: litN > 0 ? fSum / litN : 0,
      min: litN > 0 ? fMin : 0,
      max: litN > 0 ? fMax : 0,
      avgBlk: bAvg, minBlk: bMin,
      cv: bAvg > 0 ? bStd / bAvg : 0,
      uniformity: bAvg > 0 ? bMin / bAvg : 0,
      passRatio: vals.length > 0 ? bPass / vals.length : 0
    };

    // --- 沿轴侧壁出光分布 ---
    var amin = this.bboxMin[ai], amax = this.bboxMax[ai];
    var aspan = (amax - amin) || 1;
    var av = new Array(axisBins).fill(0);
    for (var s1 = 0; s1 < results.sideHits.length; s1++) {
      var t = (results.sideHits[s1].p[ai] - amin) / aspan;
      var bin = Math.floor(t * axisBins);
      if (bin < 0) bin = 0; if (bin >= axisBins) bin = axisBins - 1;
      av[bin] += results.sideHits[s1].i;
    }

    // --- 出射角分布（相对输出面法线） ---
    var nAng = Math.ceil(90 / angleBinDeg);
    var ang = new Array(nAng).fill(0);
    function binAngle(d, inten) {
      var dotv = d[0] * on[0] + d[1] * on[1] + d[2] * on[2];
      if (dotv > 1) dotv = 1; if (dotv < -1) dotv = -1;
      var a = Math.acos(Math.abs(dotv)) * 180 / Math.PI;
      var b = Math.floor(a / angleBinDeg);
      if (b < 0) b = 0; if (b >= nAng) b = nAng - 1;
      ang[b] += inten;
    }
    for (var s2 = 0; s2 < results.outputHits.length; s2++) binAngle(results.outputHits[s2].d, results.outputHits[s2].i);
    for (var s3 = 0; s3 < results.sideHits.length; s3++) binAngle(results.sideHits[s3].d, results.sideHits[s3].i);

    return {
      heatmap: { res: res, u0: u0, u1: u1, v0: v0, v1: v1, cells: cells, counts: counts },
      axis: { axisIndex: ai, min: amin, max: amax, bins: axisBins, values: av },
      angle: { binDeg: angleBinDeg, bins: nAng, values: ang },
      metrics: metrics,
      outCenter: oc, outNormal: on
    };
  }

  // ================= 静态工具（主线程拾取用） =================
  /**
   * Cauchy 色散：n(λ) = A + B/λ²（λ 单位 nm）。
   * 由参考折射率 n@587.6nm（nd）与阿贝数 Vd 反解系数：
   *   B = (nd − 1) / (Vd · 1.9104e-6)     （1/486.1² − 1/656.3² = 1.9104e-6）
   *   A = nd − B / 587.6² = nd − B · 2.8963e-6
   * 无色散参数（n ≤ 0 或 Vd ≤ 0）时直接返回参考折射率 n（向后兼容）。
   */
  static cauchy(n, abbe, lamNm) {
    if (!(n > 0) || !(abbe > 0) || !(lamNm > 0)) return n;
    var B = (n - 1) / (abbe * 1.9104e-6);
    var A = n - B * 2.8963e-6;
    return A + B / (lamNm * lamNm);
  }

  /** 按权重把整数 total 分配给各类别（最大余数法，保证 Σ 严格等于 total） */
  static _allocate(total, weights) {
    var n = weights.length, out = [];
    for (var i = 0; i < n; i++) out.push(0);
    if (n === 0) return out;
    var sum = 0;
    for (var a = 0; a < n; a++) { var w = +weights[a] || 0; if (w < 0) w = 0; sum += w; }
    if (sum <= 0) { out[0] = total; return out; }
    var assigned = 0, rems = [];
    for (var b = 0; b < n; b++) {
      var exact = total * Math.max(0, +weights[b] || 0) / sum;
      var c = Math.floor(exact);
      out[b] = c; assigned += c; rems.push({ i: b, r: exact - c });
    }
    rems.sort(function (x, y) { return y.r - x.r; });
    for (var k = 0; k < total - assigned; k++) out[rems[k % n].i]++;
    return out;
  }

  /**
   * 由选中的入射面三角组计算 LED 灯珠位姿（mm 空间）。
   * 流程：面积加权求入射面中心 C 与平均法向 N → 探针判定朝外方向 →
   *       构建正交基（局部 +Z = 指向体内的入射方向）。
   * 返回 { pos:[Cx,Cy,Cz], x:[..], y:[..], z:[..] }；
   * LED 局部系 z=0 即入射面所在平面，灯珠本体位于局部 z<0（入射面前方），发光面在 z=-gap。
   */
  static computeLEDPose(positions, indices, faceIds) {
    if (!positions || !faceIds || faceIds.length === 0) return null;
    var cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0, totalA = 0;
    var maxA = 0, maxN = null;
    for (var i = 0; i < faceIds.length; i++) {
      var fi = faceIds[i];
      var a = fi * 3, b = a + 1, c = a + 2;
      if (indices) { a = indices[fi * 3]; b = indices[fi * 3 + 1]; c = indices[fi * 3 + 2]; }
      var ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      var bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      var cxx = positions[c * 3], cyy = positions[c * 3 + 1], czz = positions[c * 3 + 2];
      var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      var e2x = cxx - ax, e2y = cyy - ay, e2z = czz - az;
      var mx = e1y * e2z - e1z * e2y;
      var my = e1z * e2x - e1x * e2z;
      var mz = e1x * e2y - e1y * e2x;
      var area = Math.sqrt(mx * mx + my * my + mz * mz) * 0.5;
      if (area <= 1e-12) continue;
      cx += (ax + bx + cxx) / 3 * area;
      cy += (ay + by + cyy) / 3 * area;
      cz += (az + bz + czz) / 3 * area;
      nx += mx; ny += my; nz += mz;      // 2·A·n̂，面积加权
      totalA += area;
      if (area > maxA) { maxA = area; maxN = [mx, my, mz]; }
    }
    if (totalA <= 1e-12) return null;
    cx /= totalA; cy /= totalA; cz /= totalA;
    var nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nLen < 1e-9) {                   // 弯曲面加权抵消 → 退回最大三角面法向
      nx = maxN[0]; ny = maxN[1]; nz = maxN[2];
      nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    }
    nx /= nLen; ny /= nLen; nz /= nLen;

    // 朝向判定：从面心沿 +N 微移后发射探针，命中本体则 +N 指向体内 → 翻转
    var bbox = RayTracer._bboxOf(positions);
    var gridSize = Math.max(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2], 1e-6);
    var eps = Math.max(1e-5, gridSize * 0.002);
    var exclude = new Set(faceIds);
    var hit = RayTracer._raycastStatic(positions, indices,
      [cx + nx * eps, cy + ny * eps, cz + nz * eps], [nx, ny, nz], exclude);
    if (hit) { nx = -nx; ny = -ny; nz = -nz; }
    // outN = 朝外法向（指向灯珠一侧）；局部 +Z = 入射方向 = -outN
    var zx = -nx, zy = -ny, zz = -nz;
    // 正交基：up 候选避免与 z 平行
    var ux, uy, uz;
    if (Math.abs(zy) < 0.9) { ux = 0; uy = 1; uz = 0; }
    else { ux = 1; uy = 0; uz = 0; }
    // x = up × z（单位化）；y = z × x
    var xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
    var xl = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return {
      pos: [cx, cy, cz],
      x: [xx, xy, xz],
      y: [yx, yy, yz],
      z: [zx, zy, zz]
    };
  }

  /**
   * 多灯珠位姿计算：将选中的入射面按「平面」聚类（法向夹角 < 22° 且共面），
   * 每个平面生成一颗灯珠位姿（computeLEDPose），并附带该平面总面积（用于光线数分配）。
   * 选择几个入射面 → 放置几颗灯珠；同一平面内的多次拾取合并为一颗。
   * 返回 [{ pos, x, y, z, area, faces }] 或 null。
   */
  static computeLEDPoses(positions, indices, faceIds) {
    if (!positions || !faceIds || faceIds.length === 0) return null;
    var bbox = RayTracer._bboxOf(positions);
    var maxDim = Math.max(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2], 1e-6);
    var cosThr = Math.cos(22 * Math.PI / 180);
    var distThr = 0.08 * maxDim;
    var clusters = [];   // { ids:[], nx,ny,nz (参考法向), d (平面参数), area }
    for (var i = 0; i < faceIds.length; i++) {
      var fi = faceIds[i];
      var a, b, c;
      if (indices) { a = indices[fi * 3]; b = indices[fi * 3 + 1]; c = indices[fi * 3 + 2]; }
      else { a = fi * 3; b = fi * 3 + 1; c = fi * 3 + 2; }
      var ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      var bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      var cx2 = positions[c * 3], cy2 = positions[c * 3 + 1], cz2 = positions[c * 3 + 2];
      var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      var e2x = cx2 - ax, e2y = cy2 - ay, e2z = cz2 - az;
      var mx = e1y * e2z - e1z * e2y, my = e1z * e2x - e1x * e2z, mz = e1x * e2y - e1y * e2x;
      var len = Math.sqrt(mx * mx + my * my + mz * mz);
      if (len <= 1e-12) continue;
      var area = len * 0.5;
      var nx = mx / len, ny = my / len, nz = mz / len;
      var d = nx * (ax + bx + cx2) / 3 + ny * (ay + by + cy2) / 3 + nz * (az + bz + cz2) / 3;
      var placed = false;
      for (var k = 0; k < clusters.length; k++) {
        var cl = clusters[k];
        var dot = nx * cl.nx + ny * cl.ny + nz * cl.nz;
        if (dot > cosThr && Math.abs(d - cl.d) < distThr) {
          // 合并：参考法向按面积加权更新，d 取面积加权平均
          cl.nx += nx * area; cl.ny += ny * area; cl.nz += nz * area;
          var rl = Math.sqrt(cl.nx * cl.nx + cl.ny * cl.ny + cl.nz * cl.nz) || 1;
          cl.nx /= rl; cl.ny /= rl; cl.nz /= rl;
          cl.d = (cl.d * cl.area + d * area) / (cl.area + area);
          cl.area += area;
          cl.ids.push(fi);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ ids: [fi], nx: nx, ny: ny, nz: nz, d: d, area: area });
    }
    var poses = [];
    for (var m = 0; m < clusters.length; m++) {
      var pose = RayTracer.computeLEDPose(positions, indices, clusters[m].ids);
      if (pose) {
        pose.area = clusters[m].area;
        pose.faces = clusters[m].ids.slice();
        poses.push(pose);
      }
    }
    return poses.length ? poses : null;
  }

  static _bboxOf(positions) {
    var mn = [1e12, 1e12, 1e12], mx = [-1e12, -1e12, -1e12];
    for (var k = 0; k < positions.length; k += 3) {
      for (var d = 0; d < 3; d++) {
        var v = positions[k + d];
        if (v < mn[d]) mn[d] = v;
        if (v > mx[d]) mx[d] = v;
      }
    }
    return { min: mn, max: mx };
  }

  /** 静态暴力 raycast（Möller–Trumbore 全扫，仅位姿计算时一次性调用） */
  static _raycastStatic(positions, indices, origin, dir, excludeSet) {
    var ox = origin[0], oy = origin[1], oz = origin[2];
    var dx = dir[0], dy = dir[1], dz = dir[2];
    var faceCount = indices ? indices.length / 3 : positions.length / 9;
    var nearest = null;
    for (var i = 0; i < faceCount; i++) {
      if (excludeSet && excludeSet.has(i)) continue;
      var a, b, c;
      if (indices) { a = indices[i * 3]; b = indices[i * 3 + 1]; c = indices[i * 3 + 2]; }
      else { a = i * 3; b = i * 3 + 1; c = i * 3 + 2; }
      var ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      var e1x = positions[b * 3] - ax, e1y = positions[b * 3 + 1] - ay, e1z = positions[b * 3 + 2] - az;
      var e2x = positions[c * 3] - ax, e2y = positions[c * 3 + 1] - ay, e2z = positions[c * 3 + 2] - az;
      // h = dir × e2
      var hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
      var det = e1x * hx + e1y * hy + e1z * hz;
      if (det > -1e-9 && det < 1e-9) continue;
      var f = 1 / det;
      var sx = ox - ax, sy = oy - ay, sz = oz - az;
      var u = f * (sx * hx + sy * hy + sz * hz);
      if (u < 0 || u > 1) continue;
      // q = s × e1
      var qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      var v = f * (dx * qx + dy * qy + dz * qz);
      if (v < 0 || u + v > 1) continue;
      var t = f * (e2x * qx + e2y * qy + e2z * qz);
      if (t > 1e-9 && (nearest === null || t < nearest)) nearest = t;
    }
    return nearest;
  }

  static autoDetectEndCaps(faces, normals, centers, areas) {
    if (!faces || faces.length === 0) return { input: [], output: [] };
    var cx = 0, cy = 0, cz = 0;
    for (var i = 0; i < centers.length; i++) { cx += centers[i].x; cy += centers[i].y; cz += centers[i].z; }
    cx /= centers.length; cy /= centers.length; cz /= centers.length;
    var varX = 0, varY = 0, varZ = 0;
    for (var i2 = 0; i2 < centers.length; i2++) {
      varX += Math.pow(centers[i2].x - cx, 2);
      varY += Math.pow(centers[i2].y - cy, 2);
      varZ += Math.pow(centers[i2].z - cz, 2);
    }
    var axisIdx = (varX >= varY && varX >= varZ) ? 0 : (varY >= varZ ? 1 : 2);
    var axisVals = centers.map(function(c) { return [c.x, c.y, c.z][axisIdx]; });
    var minVal = Math.min.apply(null, axisVals);
    var maxVal = Math.max.apply(null, axisVals);
    var threshold = (maxVal - minVal) * 0.05;
    var endGroups = { min: [], max: [] };
    for (var i3 = 0; i3 < faces.length; i3++) {
      var n = normals[i3];
      var axisComp = Math.abs([n.x, n.y, n.z][axisIdx]);
      if (axisComp < 0.7) continue;
      var val = [centers[i3].x, centers[i3].y, centers[i3].z][axisIdx];
      if (Math.abs(val - minVal) < threshold) endGroups.min.push(i3);
      else if (Math.abs(val - maxVal) < threshold) endGroups.max.push(i3);
    }
    // Input = min end (z=0, where LED is placed); Output = max end (far end)
    // For parametric geometry, input is always at the lower axis value
    var input  = endGroups.min;
    var output = endGroups.max;
    return { input: input, output: output };
  }

  static expandPlanar(faces, normals, centers, adjacency, seedIdx, angleThreshold, distThreshold) {
    angleThreshold = angleThreshold || 22;
    distThreshold  = distThreshold  || 0.08;
    var seedNormal = normals[seedIdx];
    var seedCenter = centers[seedIdx];
    var seedPlaneD = seedNormal.dot(seedCenter);

    var maxDim = 0;
    for (var i = 0; i < centers.length; i++) {
      maxDim = Math.max(maxDim, Math.abs(centers[i].x), Math.abs(centers[i].y), Math.abs(centers[i].z));
    }
    var distLimit = maxDim * distThreshold;

    var visited = new Set([seedIdx]);
    var queue = [seedIdx];
    var result = [seedIdx];
    while (queue.length > 0) {
      var curr = queue.shift();
      var neighbors = adjacency.get(curr) || [];
      for (var i2 = 0; i2 < neighbors.length; i2++) {
        var nb = neighbors[i2];
        if (visited.has(nb)) continue;
        visited.add(nb);
        var dot = seedNormal.dot(normals[nb]);
        var angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
        var planeDist = Math.abs(seedNormal.dot(centers[nb]) - seedPlaneD);
        if (angle < angleThreshold && planeDist < distLimit) {
          result.push(nb);
          queue.push(nb);
        }
      }
    }
    return result;
  }

  static buildAdjacency(faces) {
    var adjacency = new Map();
    var vertexMap = new Map();
    for (var i = 0; i < faces.length; i++) {
      var f = faces[i];
      var verts = [f.a, f.b, f.c];
      for (var vi = 0; vi < verts.length; vi++) {
        var key = verts[vi].x.toFixed(5) + ',' + verts[vi].y.toFixed(5) + ',' + verts[vi].z.toFixed(5);
        if (!vertexMap.has(key)) vertexMap.set(key, []);
        vertexMap.get(key).push(i);
      }
    }
    vertexMap.forEach(function(faceIndices, key) {
      for (var i = 0; i < faceIndices.length; i++) {
        for (var j = i + 1; j < faceIndices.length; j++) {
          var a = faceIndices[i], b = faceIndices[j];
          if (!adjacency.has(a)) adjacency.set(a, []);
          if (!adjacency.has(b)) adjacency.set(b, []);
          if (adjacency.get(a).indexOf(b) === -1) adjacency.get(a).push(b);
          if (adjacency.get(b).indexOf(a) === -1) adjacency.get(b).push(a);
        }
      }
    });
    return adjacency;
  }

  /**
   * 曲面洪水填充（平滑扩展）：以种子面为起点，沿网格邻接传播，
   * 相邻两面法线夹角小于 angleThreshold（默认30°）即并入同一选择集。
   * 与 expandPlanar 的区别：法线对比对象是"当前遍历面"而非种子面，
   * 因此可沿曲面连续扩展（一次点选选中整个球面/穹顶），
   * 而尖锐边（相邻法线突变）会自然阻断扩散。
   */
  static expandSmooth(faces, normals, adjacency, seedIdx, angleThreshold) {
    angleThreshold = angleThreshold || 30;
    // 加「与种子面法线的全局方向约束」，避免链式蔓延越过折痕（例如圆柱端面与圆柱侧面交界处）
    // 这正是用户点中间圆弧却带选到两侧小截面面的根因
    var globalWindow = 45;
    var seedNormal = normals[seedIdx];
    var visited = new Set([seedIdx]);
    var queue = [seedIdx];
    var result = [seedIdx];
    while (queue.length > 0) {
      var curr = queue.shift();
      var cn = normals[curr];
      var neighbors = adjacency.get(curr) || [];
      for (var i = 0; i < neighbors.length; i++) {
        var nb = neighbors[i];
        if (visited.has(nb)) continue;
        visited.add(nb);
        // 局部：与相邻面法线夹角 < 阈值；不再使用 abs——方向相反的面本来就不该并入
        var dot = cn.x * normals[nb].x + cn.y * normals[nb].y + cn.z * normals[nb].z;
        var angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
        if (angle >= angleThreshold) continue;
        // 全局：与种子面法线夹角必须在窗口内（防止链式穿越折痕带到侧面小面）
        var seedDot = seedNormal.x * normals[nb].x + seedNormal.y * normals[nb].y + seedNormal.z * normals[nb].z;
        var seedAngle = Math.acos(Math.max(-1, Math.min(1, seedDot))) * 180 / Math.PI;
        if (seedAngle >= globalWindow) continue;
        result.push(nb); queue.push(nb);
      }
    }
    return result;
  }

  /**
   * 自动选面扩展（点选入口）：
   * 先以种子面局部探针面片（链式生长 ≤96 面、且法线偏离种子法线 <45° 窗口内）
   * 做法线协方差 PCA，判断种子处曲率结构：
   *  - 双曲率结构（半球穹顶等，法线沿两个方向散布，λ2/λ1>0.15）：
   *    回退初始版本逻辑 expandPlanar（邻面法线与种子法线夹角<22°，不链式扩展），
   *    避免穹顶与圆柱侧壁切向连续交界（折痕角仅几度）被链式扩展越过、连带误选；
   *  - 单曲率/平面（圆柱、圆锥、凹槽弧面等，法线一维散布）：
   *    保持链式平滑扩展 expandSmooth，行为与之前一致。
   */
  static expandAuto(faces, normals, centers, adjacency, seedIdx, angleThreshold) {
    angleThreshold = angleThreshold || 30;
    // ---- 探针面片：链式生长（步进<30°）+ 种子法线 45° 窗口，最多 96 面 ----
    var PROBE_MAX = 96;
    var seedN = normals[seedIdx];
    var patch = [seedIdx];
    var seen = new Set([seedIdx]);
    var queue = [seedIdx];
    while (queue.length > 0 && patch.length < PROBE_MAX) {
      var cur = queue.shift();
      var cn = normals[cur];
      var nbs = adjacency.get(cur) || [];
      for (var i = 0; i < nbs.length; i++) {
        var nb = nbs[i];
        if (seen.has(nb)) continue;
        seen.add(nb);
        var n2 = normals[nb];
        var d = Math.abs(cn.x * n2.x + cn.y * n2.y + cn.z * n2.z);
        var ang = Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
        if (ang >= 30) continue;
        var ds = Math.abs(seedN.x * n2.x + seedN.y * n2.y + seedN.z * n2.z);
        var angs = Math.acos(Math.max(-1, Math.min(1, ds))) * 180 / Math.PI;
        if (angs < 45) { patch.push(nb); queue.push(nb); }
      }
    }
    // ---- 法线协方差 PCA：λ2/λ1 判断散布维度（>0.15 = 双曲率） ----
    if (patch.length >= 6) {
      var mx = 0, my = 0, mz = 0;
      for (var a = 0; a < patch.length; a++) {
        var n0 = normals[patch[a]];
        mx += n0.x; my += n0.y; mz += n0.z;
      }
      mx /= patch.length; my /= patch.length; mz /= patch.length;
      var m11 = 0, m12 = 0, m13 = 0, m22 = 0, m23 = 0, m33 = 0;
      for (var b = 0; b < patch.length; b++) {
        var n1 = normals[patch[b]];
        var dx = n1.x - mx, dy = n1.y - my, dz = n1.z - mz;
        m11 += dx * dx; m12 += dx * dy; m13 += dx * dz;
        m22 += dy * dy; m23 += dy * dz; m33 += dz * dz;
      }
      var v = [1, 0.3, 0.2];
      for (var it = 0; it < 14; it++) {
        var x = m11 * v[0] + m12 * v[1] + m13 * v[2];
        var y = m12 * v[0] + m22 * v[1] + m23 * v[2];
        var z = m13 * v[0] + m23 * v[1] + m33 * v[2];
        var l = Math.sqrt(x * x + y * y + z * z) || 1;
        v = [x / l, y / l, z / l];
      }
      var l1 = v[0] * (m11 * v[0] + m12 * v[1] + m13 * v[2]) +
               v[1] * (m12 * v[0] + m22 * v[1] + m23 * v[2]) +
               v[2] * (m13 * v[0] + m23 * v[1] + m33 * v[2]);
      var m11b = m11 - l1 * v[0] * v[0], m12b = m12 - l1 * v[0] * v[1], m13b = m13 - l1 * v[0] * v[2];
      var m22b = m22 - l1 * v[1] * v[1], m23b = m23 - l1 * v[1] * v[2];
      var m33b = m33 - l1 * v[2] * v[2];
      var u = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      for (var it2 = 0; it2 < 14; it2++) {
        var x2 = m11b * u[0] + m12b * u[1] + m13b * u[2];
        var y2 = m12b * u[0] + m22b * u[1] + m23b * u[2];
        var z2 = m13b * u[0] + m23b * u[1] + m33b * u[2];
        var lq = Math.sqrt(x2 * x2 + y2 * y2 + z2 * z2) || 1;
        u = [x2 / lq, y2 / lq, z2 / lq];
      }
      var l2 = u[0] * (m11b * u[0] + m12b * u[1] + m13b * u[2]) +
               u[1] * (m12b * u[0] + m22b * u[1] + m23b * u[2]) +
               u[2] * (m13b * u[0] + m23b * u[1] + m33b * u[2]);
      if (l1 > 1e-8 && l2 / l1 > 0.15) {
        // 双曲率（半球穹顶等）：初始版本行为——法线对种子面，不做链式范围扩展
        return RayTracer.expandPlanar(faces, normals, centers, adjacency, seedIdx);
      }
    }
    // 单曲率/平面：保持链式平滑扩展
    return RayTracer.expandSmooth(faces, normals, adjacency, seedIdx, angleThreshold);
  }

  /**
   * 网格修复（导入模型用），三步：
   *  1) 焊接重复顶点：STL 三角面片 soup → 共享索引，消除裂缝并保证邻接完整；
   *  2) 统一三角形绕向：BFS 沿共享边传播，绕向与邻居一致的邻面就地翻转（修复法线朝向混乱）；
   *  3) 全局朝向校正：以最大面积面的法线是否背离网格质心为准，必要时整体翻转。
   * 返回 { positions, indices, welded, flipped, inverted }。
   */
  static fixWinding(positions, indices) {
    var nTri = indices ? indices.length / 3 : positions.length / 9;
    if (nTri === 0) return { positions: positions, indices: indices, welded: 0, flipped: 0, inverted: false };

    // -- 1) 焊接重复顶点 --
    var keyMap = new Map();
    var uniq = [];
    var refCount = indices ? indices.length : positions.length / 3;
    var remap = new Uint32Array(refCount);
    for (var r = 0; r < refCount; r++) {
      var vi = indices ? indices[r] : r;
      var k = positions[vi * 3].toFixed(4) + ',' + positions[vi * 3 + 1].toFixed(4) + ',' + positions[vi * 3 + 2].toFixed(4);
      var u = keyMap.get(k);
      if (u === undefined) {
        u = uniq.length / 3; keyMap.set(k, u);
        uniq.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
      }
      remap[r] = u;
    }
    var welded = refCount - uniq.length / 3;
    var newIndices = new Uint32Array(nTri * 3);
    for (var t = 0; t < nTri * 3; t++) newIndices[t] = remap[t];
    var P = new Float32Array(uniq);

    // -- 2) 统一绕向（边表 + BFS 传播） --
    var edgeMap = new Map(); // 无向边 key 'a_b' -> [faceIdx, ...]
    for (var t2 = 0; t2 < nTri; t2++) {
      var a = newIndices[t2 * 3], b = newIndices[t2 * 3 + 1], c = newIndices[t2 * 3 + 2];
      if (a === b || b === c || a === c) continue; // 退化三角形不参与
      var es = [a, b, c];
      for (var ei = 0; ei < 3; ei++) {
        var x = es[ei], y = es[(ei + 1) % 3];
        var key = x < y ? x + '_' + y : y + '_' + x;
        if (!edgeMap.has(key)) edgeMap.set(key, []);
        edgeMap.get(key).push(t2);
      }
    }
    // 查询面 f 当前绕向下边 (x,y) 的方向
    function forwardOf(f, x, y) {
      var fa = newIndices[f * 3], fb = newIndices[f * 3 + 1], fc = newIndices[f * 3 + 2];
      if (fa === x && fb === y) return true;
      if (fa === y && fb === x) return false;
      if (fb === x && fc === y) return true;
      if (fb === y && fc === x) return false;
      if (fc === x && fa === y) return true;
      if (fc === y && fa === x) return false;
      return null;
    }
    var visited = new Uint8Array(nTri);
    var flipped = 0;
    for (var s = 0; s < nTri; s++) {
      if (visited[s] || newIndices[s * 3] === newIndices[s * 3 + 1]) continue;
      visited[s] = 1;
      var queue = [s];
      while (queue.length) {
        var f = queue.pop();
        var fa2 = newIndices[f * 3], fb2 = newIndices[f * 3 + 1], fc2 = newIndices[f * 3 + 2];
        var fe = [fa2, fb2, fc2];
        for (var ei2 = 0; ei2 < 3; ei2++) {
          var x2 = fe[ei2], y2 = fe[(ei2 + 1) % 3];
          var key2 = x2 < y2 ? x2 + '_' + y2 : y2 + '_' + x2;
          var list = edgeMap.get(key2);
          if (!list || list.length !== 2) continue; // 边界边/非流形边：不传播
          var other = list[0] === f ? list[1] : list[0];
          var otherForward = forwardOf(other, x2, y2);
          if (otherForward === null) continue;
          if (otherForward === true) { // 与当前面方向相同 → 翻转邻居绕向
            var o3 = other * 3;
            var tmp = newIndices[o3 + 1]; newIndices[o3 + 1] = newIndices[o3 + 2]; newIndices[o3 + 2] = tmp;
            flipped++;
          }
          if (!visited[other]) { visited[other] = 1; queue.push(other); }
        }
      }
    }

    // -- 3) 全局朝向：最大面积面法线应背离质心 --
    var vn = P.length / 3, cx = 0, cy = 0, cz = 0;
    for (var v = 0; v < vn; v++) { cx += P[v * 3]; cy += P[v * 3 + 1]; cz += P[v * 3 + 2]; }
    cx /= vn; cy /= vn; cz /= vn;
    var bestA = -1, bestF = -1;
    for (var t3 = 0; t3 < nTri; t3++) {
      var a3 = newIndices[t3 * 3], b3 = newIndices[t3 * 3 + 1], c3 = newIndices[t3 * 3 + 2];
      if (a3 === b3 || b3 === c3 || a3 === c3) continue;
      var e1x = P[b3 * 3] - P[a3 * 3], e1y = P[b3 * 3 + 1] - P[a3 * 3 + 1], e1z = P[b3 * 3 + 2] - P[a3 * 3 + 2];
      var e2x = P[c3 * 3] - P[a3 * 3], e2y = P[c3 * 3 + 1] - P[a3 * 3 + 1], e2z = P[c3 * 3 + 2] - P[a3 * 3 + 2];
      var area2 = Math.sqrt(
        (e1y * e2z - e1z * e2y) * (e1y * e2z - e1z * e2y) +
        (e1z * e2x - e1x * e2z) * (e1z * e2x - e1x * e2z) +
        (e1x * e2y - e1y * e2x) * (e1x * e2y - e1y * e2x));
      if (area2 > bestA) { bestA = area2; bestF = t3; }
    }
    var inverted = false;
    if (bestF >= 0) {
      var a4 = newIndices[bestF * 3], b4 = newIndices[bestF * 3 + 1], c4 = newIndices[bestF * 3 + 2];
      var mx = (P[a4 * 3] + P[b4 * 3] + P[c4 * 3]) / 3 - cx;
      var my = (P[a4 * 3 + 1] + P[b4 * 3 + 1] + P[c4 * 3 + 1]) / 3 - cy;
      var mz = (P[a4 * 3 + 2] + P[b4 * 3 + 2] + P[c4 * 3 + 2]) / 3 - cz;
      var e1x2 = P[b4 * 3] - P[a4 * 3], e1y2 = P[b4 * 3 + 1] - P[a4 * 3 + 1], e1z2 = P[b4 * 3 + 2] - P[a4 * 3 + 2];
      var e2x2 = P[c4 * 3] - P[a4 * 3], e2y2 = P[c4 * 3 + 1] - P[a4 * 3 + 1], e2z2 = P[c4 * 3 + 2] - P[a4 * 3 + 2];
      var nx2 = e1y2 * e2z2 - e1z2 * e2y2, ny2 = e1z2 * e2x2 - e1x2 * e2z2, nz2 = e1x2 * e2y2 - e1y2 * e2x2;
      if (nx2 * mx + ny2 * my + nz2 * mz < 0) {
        for (var t4 = 0; t4 < nTri; t4++) {
          var o4 = t4 * 3;
          var tmp2 = newIndices[o4 + 1]; newIndices[o4 + 1] = newIndices[o4 + 2]; newIndices[o4 + 2] = tmp2;
        }
        inverted = true;
      }
    }
    return { positions: P, indices: newIndices, welded: welded, flipped: flipped + (inverted ? nTri : 0), inverted: inverted };
  }

  /**
   * 出射光斑截面投影（3D 预览虚拟探测屏，与光斑分析页同一物理口径）：
   * 出射命中点沿各自出射方向 dExit 传播到出射端面前方 d mm 的虚拟屏，
   * 按 p98 半径 ×1.12 定稳健视野，高斯溅射（探测器 PSF，σ=2.4 格，核权重归一）
   * 把离散光点展宽为连续辐照度场；网格能量 + 视野外 + 核裁剪 = 投影总能量（三方记账）。
   * @param {Array}  hits 出射命中点 [{p, i, dExit, lam}]
   * @param {Object} opts { center:[3](出射端面中心), axis:[3](出射法线), d:屏距mm, res, flux:lm, numRays }
   * @returns {Object|null} { res, half, E(res², W/m²), Emax, center(屏心mm), on, uv, vv,
   *                          outsidePow, clipPow, conserve }；无有效命中返回 null
   */
  static projectSpotGrid(hits, opts) {
    opts = opts || {};
    var center = opts.center, on = opts.axis;
    if (!hits || !hits.length || !center || !on) return null;
    var d = (opts.d != null) ? opts.d : 2;
    var res = Math.max(16, opts.res || 64);
    var nl = Math.sqrt(on[0] * on[0] + on[1] * on[1] + on[2] * on[2]) || 1;
    on = [on[0] / nl, on[1] / nl, on[2] / nl];
    // 屏面正交基（与光斑分析页相同构造）
    var up = Math.abs(on[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    var uvx = up[1] * on[2] - up[2] * on[1], uvy = up[2] * on[0] - up[0] * on[2], uvz = up[0] * on[1] - up[1] * on[0];
    var ul = Math.sqrt(uvx * uvx + uvy * uvy + uvz * uvz) || 1;
    var uv = [uvx / ul, uvy / ul, uvz / ul];
    var vv = [on[1] * uv[2] - on[2] * uv[1], on[2] * uv[0] - on[0] * uv[2], on[0] * uv[1] - on[1] * uv[0]];

    var numRays = opts.numRays || hits.length;
    var perRayW = ((opts.flux || 1) / 683) / numRays;
    var us = [], vs = [], ws = [], sumI = 0;
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!h.dExit || !h.p) continue;
      var de = h.dExit;
      var dl = Math.sqrt(de[0] * de[0] + de[1] * de[1] + de[2] * de[2]) || 1;
      var denom = (de[0] * on[0] + de[1] * on[1] + de[2] * on[2]) / dl;
      if (!isFinite(denom) || Math.abs(denom) < 1e-3) continue;   // 掠出射/反向：无法到达屏
      var t = d / denom;
      var rx = h.p[0] - center[0], ry = h.p[1] - center[1], rz = h.p[2] - center[2];
      var u = (rx * uv[0] + ry * uv[1] + rz * uv[2]) + t * (de[0] * uv[0] + de[1] * uv[1] + de[2] * uv[2]) / dl;
      var v = (rx * vv[0] + ry * vv[1] + rz * vv[2]) + t * (de[0] * vv[0] + de[1] * vv[1] + de[2] * vv[2]) / dl;
      if (!isFinite(u) || !isFinite(v) || Math.abs(u) > 1e6 || Math.abs(v) > 1e6) continue;
      us.push(u); vs.push(v); ws.push(h.i || 0); sumI += (h.i || 0);
    }
    if (!us.length) return null;

    // p98 稳健视野（避免个别大角度光线把视野撑大稀释光斑）
    var rr = new Array(us.length);
    for (var ri = 0; ri < us.length; ri++) rr[ri] = Math.max(Math.abs(us[ri]), Math.abs(vs[ri]));
    rr.sort(function (a, b) { return a - b; });
    var p98 = rr[Math.min(rr.length - 1, Math.floor(0.98 * (rr.length - 1)))];
    var half = Math.max(p98 * 1.12, 1e-3);
    var cellMM = 2 * half / res;
    var Acell = Math.pow(cellMM / 1000, 2);   // m²

    // 高斯溅射核（探测器 PSF，权重归一 → 能量守恒）
    var sigmaC = 2.4, kr = Math.max(2, Math.ceil(sigmaC * 2.5));
    var kern = [], ksum = 0;
    for (var ky0 = -kr; ky0 <= kr; ky0++) for (var kx0 = -kr; kx0 <= kr; kx0++) {
      var kw = Math.exp(-(kx0 * kx0 + ky0 * ky0) / (2 * sigmaC * sigmaC));
      kern.push(kw); ksum += kw;
    }
    for (var kn = 0; kn < kern.length; kn++) kern[kn] /= ksum;

    var cells = res * res;
    var Ptot = new Float64Array(cells);
    var outsidePow = 0, clipPow = 0;
    for (var m = 0; m < us.length; m++) {
      var uu = us[m], v2 = vs[m], pw = perRayW * ws[m];
      if (uu < -half || uu >= half || v2 < -half || v2 >= half) { outsidePow += pw; continue; }
      var ix = Math.round((uu + half) / (2 * half) * res - 0.5);
      var iy = Math.round((v2 + half) / (2 * half) * res - 0.5);
      var ki = 0, added = 0;
      for (var ky = -kr; ky <= kr; ky++) {
        var yy = iy + ky;
        for (var kx = -kr; kx <= kr; kx++, ki++) {
          var xx = ix + kx;
          if (xx < 0 || xx >= res || yy < 0 || yy >= res) continue;
          Ptot[yy * res + xx] += pw * kern[ki]; added += kern[ki];
        }
      }
      clipPow += pw * (1 - added);
    }
    var E = new Float64Array(cells), Emax = 0, tot = 0;
    for (var c = 0; c < cells; c++) { E[c] = Ptot[c] / Acell; if (E[c] > Emax) Emax = E[c]; tot += Ptot[c]; }
    var expect = perRayW * sumI;
    return {
      res: res, half: half, E: E, Emax: Emax, d: d,
      center: [center[0] + on[0] * d, center[1] + on[1] * d, center[2] + on[2] * d],
      on: on, uv: uv, vv: vv,
      outsidePow: outsidePow, clipPow: clipPow,
      conserve: expect > 0 ? Math.abs(tot + outsidePow + clipPow - expect) / expect : 0
    };
  }
}

if (typeof self !== 'undefined') self.RayTracer = RayTracer;
else globalThis.RayTracer = RayTracer;

// LED 恒等位姿：局部坐标 = mm 世界坐标（参数化圆柱默认场景，入射端面 z=0、+Z 轴向）
RayTracer.IDENTITY_LED_POSE = Object.freeze({
  pos: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1]
});
