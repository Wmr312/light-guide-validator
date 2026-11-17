/**
 * LG.Geometry — 参数化导光柱几何生成（单位 mm，轴向 Z：0=入射端 → L=出射端）
 * 支持：直圆柱 / 圆锥台；侧棱镜微齿（全环 V 形齿，齿角沿轴向线性渐变 —— SPEOS 参数体系）；
 *       端面球冠曲面（入射/出射面 平面/凸面/凹面，曲率半径 R）；
 *       侧面轮廓曲率（直线 / 鼓形 / 收腰，抛物线轮廓 Δr）
 * 输出：{ positions:Float32Array, indices:Uint32Array|null(非索引), meta }
 */
(function () {
  'use strict';

  function build(g) {
    var L = Math.max(0.5, +g.length || 30);
    var r1 = Math.max(0.05, (+g.d1 || 3) / 2);
    var r2 = Math.max(0.05, (+g.d2 || g.d1 || 3) / 2);
    var N = Math.min(128, Math.max(12, +g.radialSeg || 48));
    var surf = g.surface || {};
    var prof = surf.sideProfile || 'straight';
    var dAmt = Math.max(0, +surf.sideDeltaR || 0);
    var positions = [], indices = [];

    function baseR(z) {
      var r = r1 + (r2 - r1) * (z / L);
      if ((prof === 'bulge' || prof === 'waist') && dAmt > 0) {
        var bump = 4 * dAmt * (z / L) * (1 - z / L);   // 抛物线轮廓：中段最大、两端为 0
        r = (prof === 'bulge') ? r + bump : r - bump;
      }
      return Math.max(0.05, r);
    }

    // ---------- 端盖（平面扇形）----------
    function addCap(z, r, faceUp) {
      var cBase = positions.length / 3;
      positions.push(0, 0, z);
      var ringBase = positions.length / 3;
      for (var j = 0; j < N; j++) {
        var a = j * 2 * Math.PI / N;
        positions.push(r * Math.cos(a), r * Math.sin(a), z);
      }
      for (var j2 = 0; j2 < N; j2++) {
        var p0 = cBase, pA = ringBase + j2, pB = ringBase + (j2 + 1) % N;
        if (faceUp) indices.push(p0, pA, pB);      // 法线 +Z
        else        indices.push(p0, pB, pA);      // 法线 -Z
      }
    }

    // ---------- 端盖（球冠曲面）----------
    // curve: 'convex' 凸面（朝外鼓出）/ 'concave' 凹面（朝内凹陷）；R 为球半径（mm）。
    // 矢高 h = R − √(R²−r²)；R 被钳制 ≥ 2r，保证边缘法线与轴向夹角 ≤ 30°，
    // 端面自动侦测（axisComp ≥ 0.7）仍把曲面端盖整体归入 入射/出射面。
    // z(ρ) = zEnd + outSign · curveSign · (h − s(ρ))，s(ρ) = R − √(R²−ρ²)，
    // outSign：入射端（z=0，外法向 −Z）= −1；出射端（z=L，外法向 +Z）= +1。
    function addCapCurved(zEnd, r, faceUp, curve, R) {
      var outSign = faceUp ? 1 : -1;
      var curveSign = (curve === 'convex') ? 1 : -1;
      R = Math.max(+R || 0, 2 * r + 0.001);
      var h = R - Math.sqrt(R * R - r * r);
      var K = 10;                                     // 径向环带数（10×N 三角面，曲率分辨足够）
      function zAt(rho) {
        var s = R - Math.sqrt(Math.max(0, R * R - rho * rho));
        return zEnd + outSign * curveSign * (h - s);
      }
      var cBase = positions.length / 3;
      positions.push(0, 0, zAt(0));                   // 顶点（极点）
      var ringStart = [];
      for (var k = 1; k <= K; k++) {
        ringStart.push(positions.length / 3);
        var rho = r * k / K;
        for (var j = 0; j < N; j++) {
          var a = j * 2 * Math.PI / N;
          positions.push(rho * Math.cos(a), rho * Math.sin(a), zAt(rho));
        }
      }
      // 中心扇（顶点 → 第 1 环）
      for (var f = 0; f < N; f++) {
        var fn = (f + 1) % N;
        if (faceUp) indices.push(cBase, ringStart[0] + f, ringStart[0] + fn);
        else        indices.push(cBase, ringStart[0] + fn, ringStart[0] + f);
      }
      // 环带间四边形（环 k 与环 k+1）
      for (var k2 = 0; k2 < K - 1; k2++) {
        var rA = ringStart[k2], rB = ringStart[k2 + 1];
        for (var q = 0; q < N; q++) {
          var qn = (q + 1) % N;
          var p00 = rA + q, p01 = rA + qn, p10 = rB + q, p11 = rB + qn;
          if (faceUp) { indices.push(p00, p10, p01); indices.push(p01, p10, p11); }
          else        { indices.push(p00, p01, p10); indices.push(p01, p11, p10); }
        }
      }
    }

    // 端盖入口：平面 / 曲面分发
    function addCapExt(z, r, faceUp, curve, R) {
      if ((curve === 'convex' || curve === 'concave') && +R > 0) addCapCurved(z, r, faceUp, curve, R);
      else addCap(z, r, faceUp);
    }

    // ---------- 侧带（两 station 之间的圆台面）----------
    function addBand(z0, r0, z1, r1_) {
      var b0 = positions.length / 3;
      for (var j = 0; j < N; j++) {
        var a = j * 2 * Math.PI / N;
        positions.push(r0 * Math.cos(a), r0 * Math.sin(a), z0);
      }
      var b1 = positions.length / 3;
      for (var j2 = 0; j2 < N; j2++) {
        var a2 = j2 * 2 * Math.PI / N;
        positions.push(r1_ * Math.cos(a2), r1_ * Math.sin(a2), z1);
      }
      for (var j3 = 0; j3 < N; j3++) {
        var jn = (j3 + 1) % N;
        var p00 = b0 + j3, p01 = b0 + jn, p10 = b1 + j3, p11 = b1 + jn;
        // 外法线朝外（见推导）：(p00,p01,p10) 与 (p01,p11,p10)
        indices.push(p00, p01, p10);
        indices.push(p01, p11, p10);
      }
    }

    // ---------- station 序列 ----------
    var stations = [];
    var teeth = g.teeth;
    var toothCount = 0;
    if (teeth && teeth.enabled) {
      var step = Math.max(0.2, +teeth.step || 1);
      var tw = Math.min(Math.max(0.1, +teeth.width || step * 0.8), step * 0.95);
      var off = Math.min(Math.max(0, +teeth.offset || 0), L * 0.5);
      var aS = Math.min(89, Math.max(2, +teeth.aStart || 85));
      var aE = Math.min(89, Math.max(2, +teeth.aEnd || 10));
      var half = tw / 2;
      if (off > 0.01) stations.push({ z: 0, r: r1 }, { z: off, r: baseR(off) });
      else stations.push({ z: 0, r: r1 });
      var z = off;
      while (z + step <= L - 0.01 && toothCount < 400) {
        var th = aS + (aE - aS) * ((z + half) / L);        // 齿中心角线性渐变
        var phi = (90 - th) * Math.PI / 180;                // 齿面相对径向的倾角
        var d = half * Math.tan(phi);
        var rCap = 0.45 * Math.min(r1, baseR(z + half));
        if (d > rCap) d = rCap;
        var rm = baseR(z + half) - d;
        if (rm < 0.15 * r1) rm = 0.15 * r1;
        stations.push({ z: z, r: baseR(z) }, { z: z + half, r: rm }, { z: z + tw, r: baseR(z + tw) });
        toothCount++;
        z += step;
      }
      stations.push({ z: L, r: r2 });
    } else if (prof !== 'straight' && dAmt > 0) {
      // 鼓形/收腰：沿轴向采样 24 站以逼近抛物线轮廓
      var M = 24;
      for (var si = 0; si <= M; si++) stations.push({ z: L * si / M, r: baseR(L * si / M) });
    } else {
      stations.push({ z: 0, r: r1 }, { z: L, r: r2 });
    }

    // 侧带
    for (var s = 0; s < stations.length - 1; s++) {
      addBand(stations[s].z, stations[s].r, stations[s + 1].z, stations[s + 1].r);
    }
    // 端盖（0 端面 -Z，L 端面 +Z；支持 平面/凸面/凹面 球冠）
    addCapExt(0, baseR(0), false, surf.inputCurve, surf.inputCurveR);
    addCapExt(L, baseR(L), true, surf.outputCurve, surf.outputCurveR);

    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      meta: { stations: stations.length, teeth: toothCount, faces: indices.length / 3 }
    };
  }

  window.LG = window.LG || {};
  LG.Geometry = { build: build };
})();
