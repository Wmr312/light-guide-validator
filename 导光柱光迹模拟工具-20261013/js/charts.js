/**
 * LG.Charts — Canvas 图表绘制（无依赖）
 *   drawHeatmap   出射端面伪彩照度图（jet 色带 + 色标条）
 *   computeMetrics  按阈值重算均匀性指标（avg/uniformity/cv/passRatio）
 *   drawLineChart   沿轴分布折线/柱状
 *   drawPolar       配光曲线（半极坐标，0°=法线方向）
 */
(function () {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /** jet 伪彩：t∈[0,1] → 'rgb(r,g,b)' */
  function jet(t) {
    t = clamp(t, 0, 1);
    var r = Math.round(255 * clamp(1.5 - Math.abs(4 * t - 3), 0, 1));
    var g = Math.round(255 * clamp(1.5 - Math.abs(4 * t - 2), 0, 1));
    var b = Math.round(255 * clamp(1.5 - Math.abs(4 * t - 1), 0, 1));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function setup(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || canvas.parentNode.clientWidth || 600;
    var h = canvas.clientHeight || 260;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  // ============ 指标计算（阈值可调） ============
  // 单元值取「累计能量」cells = Σ 该单元所有出射光线的强度（∝ 单元面积上的照度）。
  //
  // 为什么不能直接在 64×64 细格上取 min/avg：
  //   采样密度只有 ~1 条光线/单元，光斑边缘和内部空洞单元只被零星光线擦过，
  //   其 cells 恒等于单根光线强度（≈1），会把 Emin 死死钉在这个下限上
  //   → uniformity ≈ 常数/平均亮度，出现"出射越亮反而越不均匀"的假结论，
  //   与热图观感完全相反（用户实测：0.570 对应斑驳光斑，0.313 对应均匀光斑）。
  //
  // 修正：先把细格按照射区包围盒聚合成 N×N 块（等效真实探测器像元的面积积分，
  // 消除单光线量化噪声），再对块掩膜腐蚀 1 圈去掉光斑边缘"部分照射"块，
  // 最后在块上统计 Emin/Eavg、CV —— 这才是"出射面光线分布是否均匀"的度量。
  // 与 raytracer.js aggregate 内部的 metrics 计算完全同口径。
  function erodeMask(mask, res, iterations) {
    var cur = mask;
    for (var it = 0; it < iterations; it++) {
      var next = new Uint8Array(res * res);
      for (var r = 0; r < res; r++) {
        for (var c = 0; c < res; c++) {
          var i = r * res + c;
          if (!cur[i]) continue;
          if (r > 0 && !cur[i - res]) continue;
          if (r < res - 1 && !cur[i + res]) continue;
          if (c > 0 && !cur[i - 1]) continue;
          if (c < res - 1 && !cur[i + 1]) continue;
          next[i] = 1;
        }
      }
      cur = next;
    }
    return cur;
  }

  function computeMetrics(heat, threshold) {
    threshold = (threshold != null) ? threshold : 0.8;
    var res = heat.res, cells = heat.cells, counts = heat.counts;

    // 1) 照射区包围盒 + 有效单元数（同时统计细格口径的 平均/峰值，供"最亮点亮度"等指标使用）
    var rMin = res, rMax = -1, cMin = res, cMax = -1, lit = 0;
    var fSum = 0, fMin = Infinity, fMax = -Infinity;
    for (var r = 0; r < res; r++) {
      var base = r * res;
      for (var c = 0; c < res; c++) {
        if (counts[base + c] > 0) {
          lit++;
          var vFine = cells[base + c];
          fSum += vFine;
          if (vFine < fMin) fMin = vFine;
          if (vFine > fMax) fMax = vFine;
          if (r < rMin) rMin = r;
          if (r > rMax) rMax = r;
          if (c < cMin) cMin = c;
          if (c > cMax) cMax = c;
        }
      }
    }
    if (!lit) return { n: 0, nCore: 0, avg: 0, min: 0, max: 0, cv: 0, uniformity: 0, passRatio: 0 };

    // 2) 聚合块：约 3 个细格/块（64 网格下 ≈0.26mm），块数夹在 6~16
    var bw = cMax - cMin + 1, bh = rMax - rMin + 1;
    var nb = Math.round(Math.min(bw, bh) / 3);
    if (nb < 6) nb = 6;
    if (nb > 16) nb = 16;
    // 块边界取整（保证每块面积精确、互不重叠）
    var cEdge = [], rEdge = [], q;
    for (q = 0; q <= nb; q++) cEdge.push(cMin + Math.floor(q * bw / nb));
    for (q = 0; q <= nb; q++) rEdge.push(rMin + Math.floor(q * bh / nb));

    var bE = new Float64Array(nb * nb), bI = new Float64Array(nb * nb), bArea = new Int32Array(nb * nb);
    var b0, iMax = 0;
    for (var br = 0; br < nb; br++) {
      for (var bc = 0; bc < nb; bc++) {
        var r0 = rEdge[br], r1 = rEdge[br + 1], c0 = cEdge[bc], c1 = cEdge[bc + 1];
        var e = 0;
        for (var r3 = r0; r3 < r1; r3++) {
          for (var c3 = c0; c3 < c1; c3++) {
            var i3 = r3 * res + c3;
            if (counts[i3] > 0) e += cells[i3];
          }
        }
        var bi0 = br * nb + bc;
        bE[bi0] = e;
        bArea[bi0] = (r1 - r0) * (c1 - c0) || 1;
        bI[bi0] = bE[bi0] / bArea[bi0];   // 块照度 = 块能量 / 块面积
        if (bI[bi0] > iMax) iMax = bI[bi0];
      }
    }

    // 3) 有效块掩膜：照度 ≥5% 峰值（剔除零星单光线形成的杂散块，保留光斑内真实暗区）
    //    + 腐蚀 1 圈（去掉光斑边缘只被部分照射的块）
    var mask = new Uint8Array(nb * nb), mCnt = 0;
    for (b0 = 0; b0 < nb * nb; b0++) {
      if (iMax > 0 && bI[b0] >= 0.05 * iMax) { mask[b0] = 1; mCnt++; }
    }
    var core = mask;
    var e1 = erodeMask(mask, nb, 1), eCnt = 0;
    for (b0 = 0; b0 < nb * nb; b0++) { if (e1[b0]) eCnt++; }
    if (eCnt >= Math.max(4, Math.round(mCnt * 0.3))) core = e1;

    // 4) 统计：均匀性/CV/达标率取「块照度」分布；avg/min/max 仍保持细格口径（供其他指标与色带使用）
    var vals = [];
    for (b0 = 0; b0 < nb * nb; b0++) { if (core[b0]) vals.push(bI[b0]); }
    if (vals.length === 0) vals.push(0);
    var n = vals.length;
    var bAvg = 0, bMin = Infinity, bStd = 0, bPass = 0;
    for (var j = 0; j < n; j++) {
      bAvg += vals[j];
      if (vals[j] < bMin) bMin = vals[j];
    }
    bAvg /= n;
    for (var k = 0; k < n; k++) {
      bStd += (vals[k] - bAvg) * (vals[k] - bAvg);
      if (vals[k] >= threshold * bAvg) bPass++;
    }
    bStd = Math.sqrt(bStd / n);
    return {
      n: lit, nCore: n,
      avg: fSum / lit, min: fMin, max: fMax,
      avgBlk: bAvg, minBlk: bMin,
      cv: bAvg > 0 ? bStd / bAvg : 0,
      uniformity: bAvg > 0 ? bMin / bAvg : 0,
      passRatio: bPass / n
    };
  }

  // ============ 热图（增强版：等高线带 + 热点/暗区标注 + 均值参考线） ============
  function drawHeatmap(canvas, heat, metrics) {
    var s = setup(canvas), ctx = s.ctx, W = s.w, H = s.h;
    var res = heat.res;
    var padL = 46, padB = 30, padT = 10, barW = 14, barGap = 12;
    var pw = Math.max(40, W - padL - barW - barGap - 14);
    var ph = Math.max(40, H - padT - padB);
    var size = Math.min(pw, ph);
    var ox = padL + (pw - size) / 2, oy = padT + (ph - size) / 2;

    // 找最大值 + 计算均值（空单元跳过）
    // 用 cells（累计能量 = 面上照度 × 单元面积），让视觉热图反映能量分布，与 computeMetrics 保持一致。
    var vmax = 0, vsum = 0, vcount = 0;
    for (var i = 0; i < heat.cells.length; i++) {
      if (heat.counts[i] > 0) {
        var v0 = heat.cells[i];  // ✅ 累计能量 cells
        if (v0 > vmax) vmax = v0;
        vsum += v0; vcount++;
      }
    }
    if (vmax <= 0) vmax = 1;
    var vavg = vcount > 0 ? vsum / vcount : 0;
    // 如果外部传入了 metrics，使用其 avg（更精确）
    if (metrics && metrics.avg) vavg = metrics.avg;

    // 构建网格值表（方便等高线判断）
    var grid = [];
    for (var r0 = 0; r0 < res; r0++) {
      grid[r0] = [];
      for (var c0 = 0; c0 < res; c0++) {
        var idx0 = r0 * res + c0;
        grid[r0][c0] = heat.counts[idx0] > 0 ? heat.cells[idx0] : -1;
      }
    }

    // 背景（空单元）
    ctx.fillStyle = '#F1F5F9';
    ctx.fillRect(ox, oy, size, size);

    var cw = size / res;

    // 1. 绘制彩色色块
    for (var r = 0; r < res; r++) {
      for (var c = 0; c < res; c++) {
        var idx = r * res + c;
        if (heat.counts[idx] <= 0) continue;
        var val = heat.cells[idx];
        ctx.fillStyle = jet(val / vmax);
        ctx.fillRect(ox + c * cw, oy + (res - 1 - r) * cw, cw + 0.5, cw + 0.5);
      }
    }

    // 2. 等高线带：在均值±15%范围的单元上绘制白色半透明边框（可视化"均值等值区"）
    if (vavg > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      for (var r2 = 0; r2 < res; r2++) {
        for (var c2 = 0; c2 < res; c2++) {
          if (grid[r2][c2] < 0) continue;
          var inBand = grid[r2][c2] >= vavg * 0.85 && grid[r2][c2] <= vavg * 1.15;
          if (!inBand) continue;
          // 检查是否有邻居不在均值带内（边缘单元）
          var neighbors = [
            r2 > 0 ? grid[r2-1][c2] : -1,
            r2 < res-1 ? grid[r2+1][c2] : -1,
            c2 > 0 ? grid[r2][c2-1] : -1,
            c2 < res-1 ? grid[r2][c2+1] : -1
          ];
          var isEdge = false;
          for (var ni = 0; ni < 4; ni++) {
            if (neighbors[ni] >= 0 && (neighbors[ni] < vavg * 0.85 || neighbors[ni] > vavg * 1.15)) {
              isEdge = true; break;
            }
          }
          if (isEdge) {
            ctx.strokeRect(ox + c2 * cw, oy + (res - 1 - r2) * cw, cw, cw);
          }
        }
      }
      ctx.lineWidth = 1;
    }

    // 3. 热点标注：照度 > 1.5×均值的单元标记红色 ▲
    if (vavg > 0) {
      ctx.fillStyle = 'rgba(220,38,38,0.85)';
      ctx.font = (cw > 14 ? 10 : 8) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var hotCount = 0;
      for (var r3 = 0; r3 < res; r3++) {
        for (var c3 = 0; c3 < res; c3++) {
          if (grid[r3][c3] < 0) continue;
          if (grid[r3][c3] > vavg * 1.5) {
            var hx = ox + c3 * cw + cw / 2;
            var hy = oy + (res - 1 - r3) * cw + cw / 2;
            ctx.fillText('▲', hx, hy);
            hotCount++;
          }
        }
      }
      ctx.textBaseline = 'alphabetic';
    }

    // 4. 暗区标注：照度 < 0.3×均值的单元标记蓝色 ●
    if (vavg > 0) {
      ctx.fillStyle = 'rgba(37,99,235,0.8)';
      ctx.font = (cw > 14 ? 10 : 8) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (var r4 = 0; r4 < res; r4++) {
        for (var c4 = 0; c4 < res; c4++) {
          if (grid[r4][c4] < 0) continue;
          if (grid[r4][c4] < vavg * 0.3) {
            var dx = ox + c4 * cw + cw / 2;
            var dy = oy + (res - 1 - r4) * cw + cw / 2;
            ctx.beginPath();
            ctx.arc(dx, dy, cw > 14 ? 2.5 : 1.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.textBaseline = 'alphabetic';
    }

    ctx.strokeStyle = '#CBD5E1';
    ctx.strokeRect(ox + 0.5, oy + 0.5, size, size);

    // 5. 色标条 + 均值参考线
    var bx = ox + size + barGap, bh = size;
    for (var y = 0; y < bh; y++) {
      ctx.fillStyle = jet(1 - y / bh);
      ctx.fillRect(bx, oy + y, barW, 1.5);
    }
    ctx.strokeStyle = '#CBD5E1';
    ctx.strokeRect(bx + 0.5, oy + 0.5, barW, bh);
    ctx.fillStyle = '#64748B';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(vmax.toFixed(2), bx + barW + 3, oy + 8);
    ctx.fillText('0', bx + barW + 3, oy + bh);
    // 均值参考线（白色三角 + AVG 标注）
    if (vavg > 0) {
      var avgY = oy + bh - (vavg / vmax) * bh;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bx - 3, avgY); ctx.lineTo(bx + barW + 3, avgY);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = '#1E2A38';
      ctx.font = 'bold 9px system-ui, sans-serif';
      ctx.fillText('AVG', bx + barW + 3, avgY + 3);
      ctx.fillText(vavg.toFixed(3), bx + barW + 3, avgY + 12);
    }

    // 坐标标注（mm）
    ctx.textAlign = 'center';
    ctx.fillText(fmtMM(heat.u0), ox, oy + size + 14);
    ctx.fillText(fmtMM(heat.u1), ox + size, oy + size + 14);
    ctx.textAlign = 'left';
    ctx.fillText(fmtMM(heat.v1), ox - 6, oy + 10);
    ctx.fillText(fmtMM(heat.v0), ox - 6, oy + size);

    // 6. 图例
    ctx.fillStyle = '#64748B';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    var lx = ox, ly = oy + size + 26;
    ctx.fillStyle = 'rgba(220,38,38,0.85)';
    ctx.fillText('▲ 热点(>1.5×均值)', lx, ly);
    ctx.fillStyle = 'rgba(37,99,235,0.8)';
    ctx.fillText('● 暗区(<0.3×均值)', lx + 120, ly);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('━ 均值等值线', lx + 240, ly);

    function fmtMM(v) { return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1); }
  }

  // ============ 折线 / 柱状（增强：均值参考线 + 均匀性目标带 + 峰谷标注） ============
  function drawLineChart(canvas, values, opts) {
    opts = opts || {};
    var s = setup(canvas), ctx = s.ctx, W = s.w, H = s.h;
    var padL = 48, padR = 14, padT = 14, padB = 36;
    var pw = W - padL - padR, ph = H - padT - padB;
    var n = values.length;
    if (n === 0 || pw <= 0 || ph <= 0) return { avg: 0, peaks: [], valleys: [] };

    var vmax = 0, vsum = 0;
    for (var i = 0; i < n; i++) { if (values[i] > vmax) vmax = values[i]; vsum += values[i]; }
    if (vmax <= 0) vmax = 1;
    var vavg = vsum / n;

    var x0 = opts.min != null ? opts.min : 0;
    var x1 = opts.max != null ? opts.max : n - 1;

    // 1. 均匀性目标带（均值±15% = 绿色半透明带）
    var bandHi = vavg * 1.15, bandLo = vavg * 0.85;
    var bandYHi = padT + ph - ph * bandHi / vmax;
    var bandYLo = padT + ph - ph * bandLo / vmax;
    ctx.fillStyle = 'rgba(22,163,74,0.08)';
    ctx.fillRect(padL, bandYHi, pw, bandYLo - bandYHi);

    // 2. 网格 + Y 轴
    ctx.strokeStyle = '#E2E8F0';
    ctx.fillStyle = '#64748B';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + ph - ph * g / 4;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
      ctx.fillText((vmax * g / 4).toFixed(2), padL - 6, gy + 3);
    }

    // 3. 柱 + 折线
    var bw = pw / n;
    ctx.fillStyle = 'rgba(2,132,199,0.35)';
    for (var b = 0; b < n; b++) {
      var bh2 = ph * values[b] / vmax;
      if (bh2 > 0) ctx.fillRect(padL + b * bw, padT + ph - bh2, Math.max(1, bw - 0.6), bh2);
    }
    ctx.strokeStyle = '#0284C7';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (var k = 0; k < n; k++) {
      var px = padL + (k + 0.5) * bw;
      var py = padT + ph - ph * values[k] / vmax;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.lineWidth = 1;

    // 4. 均值参考线（虚线）
    var avgY = padT + ph - ph * vavg / vmax;
    ctx.strokeStyle = 'rgba(22,163,74,0.7)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(padL, avgY); ctx.lineTo(W - padR, avgY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#16A34A';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('AVG ' + vavg.toFixed(3), W - padR - 72, avgY - 4);

    // 5. 峰谷标注
    var peaks = [], valleys = [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var p = 0; p < n; p++) {
      var val = values[p];
      if (val > vavg * 1.3) {
        // 峰值 ▲
        var pxx = padL + (p + 0.5) * bw;
        var pyy = padT + ph - ph * val / vmax;
        ctx.fillStyle = 'rgba(220,38,38,0.85)';
        ctx.font = '9px sans-serif';
        ctx.fillText('▲', pxx, pyy - 8);
        peaks.push({ idx: p, val: val });
      } else if (val < vavg * 0.5 && val > 0) {
        // 谷值 ▼
        var vxx = padL + (p + 0.5) * bw;
        var vyy = padT + ph - ph * val / vmax;
        ctx.fillStyle = 'rgba(37,99,235,0.8)';
        ctx.font = '9px sans-serif';
        ctx.fillText('▼', vxx, vyy + 10);
        valleys.push({ idx: p, val: val });
      }
    }
    ctx.textBaseline = 'alphabetic';

    // 6. X 轴刻度
    ctx.fillStyle = '#64748B';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    var ticks = Math.min(6, n);
    for (var t = 0; t < ticks; t++) {
      var xv = x0 + (x1 - x0) * t / (ticks - 1 || 1);
      var tx = padL + pw * t / (ticks - 1 || 1);
      ctx.fillText(xv.toFixed(1), tx, H - 22);
    }
    if (opts.xLabel) ctx.fillText(opts.xLabel, padL + pw / 2, H - 10);
    if (opts.yLabel) {
      ctx.textAlign = 'left';
      ctx.fillText(opts.yLabel, padL, 10);
    }

    // 7. 图例
    ctx.textAlign = 'left';
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(220,38,38,0.85)';
    ctx.fillText('▲ 峰值(>1.3×均值)', padL, H - 4);
    ctx.fillStyle = 'rgba(37,99,235,0.8)';
    ctx.fillText('▼ 谷值(<0.5×均值)', padL + 110, H - 4);
    ctx.fillStyle = 'rgba(22,163,74,0.7)';
    ctx.fillText('━ 均值参考线 ■ 均匀性目标带', padL + 220, H - 4);

    return { avg: vavg, peaks: peaks, valleys: valleys };
  }

  // ============ 配光曲线（增强：半功率角 + 理想参考圆 + 光束角数值 + 方向标注） ============
  function drawPolar(canvas, angle) {
    var s = setup(canvas), ctx = s.ctx, W = s.w, H = s.h;
    var cx = W / 2, cy = H - 30;
    var R = Math.min(W / 2 - 56, H - 60);
    if (R < 40) R = Math.min(W / 2 - 38, H - 48);
    if (R < 30) return { beamAngle: 0 };

    var vmax = 0;
    for (var i = 0; i < angle.values.length; i++) if (angle.values[i] > vmax) vmax = angle.values[i];
    if (vmax <= 0) vmax = 1;

    // 计算半功率角（光强降到 50% vmax 时的角度 = 光束角 FWHM/2）
    var halfPower = vmax * 0.5;
    var beamAngle = 90;
    for (var bi = 0; bi < angle.bins; bi++) {
      if (angle.values[bi] < halfPower) {
        beamAngle = (bi + 0.5) * angle.binDeg;
        break;
      }
    }

    // 1. 同心网格
    ctx.strokeStyle = '#E2E8F0';
    ctx.fillStyle = '#94A3B8';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    for (var g = 1; g <= 4; g++) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * g / 4, Math.PI, 0);
      ctx.stroke();
      ctx.fillText((g / 4).toFixed(2), cx + 4, cy - R * g / 4 + 10);
    }

    // 2. 半功率角参考圆（红色虚线，50% vmax）
    var halfR = R * 0.5;
    ctx.strokeStyle = 'rgba(220,38,38,0.5)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, halfR, Math.PI, 0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#DC2626';
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.fillText('50% 光强', cx + halfR + 4, cy - halfR + 4);

    // 3. 径向线 + 角度标注
    ctx.textAlign = 'center';
    ctx.font = '9px system-ui, sans-serif';
    for (var a = 0; a <= 90; a += 30) {
      var rad = a * Math.PI / 180;
      var sx = Math.sin(rad), cyy = -Math.cos(rad);
      ctx.strokeStyle = '#E2E8F0';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + sx * R, cy + cyy * R);
      ctx.stroke();
      ctx.fillStyle = '#64748B';
      ctx.fillText(a + '°', cx + sx * (R + 12), cy + cyy * (R + 12) + 3);
    }

    // 4. 曲线 + 填充
    ctx.beginPath();
    for (var b = 0; b < angle.bins; b++) {
      var th = (b + 0.5) * angle.binDeg * Math.PI / 180;
      var r = R * angle.values[b] / vmax;
      var px = cx + Math.sin(th) * r, py = cy - Math.cos(th) * r;
      if (b === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.lineTo(cx + R, cy);
    ctx.lineTo(cx, cy);
    ctx.closePath();
    ctx.fillStyle = 'rgba(2,132,199,0.15)';
    ctx.fill();
    ctx.strokeStyle = '#0284C7';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.lineWidth = 1;

    // 5. 半功率角标注线（从中心到 beamAngle 方向的红色虚线）
    var beamRad = beamAngle * Math.PI / 180;
    ctx.strokeStyle = 'rgba(220,38,38,0.7)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(beamRad) * halfR, cy - Math.cos(beamRad) * halfR);
    ctx.stroke();
    ctx.setLineDash([]);
    // 标注光束角数值
    ctx.fillStyle = '#DC2626';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('光束角 ' + beamAngle.toFixed(0) + '°', cx + Math.sin(beamRad) * (halfR + 8), cy - Math.cos(beamRad) * (halfR + 8));

    // 6. 方向标注
    ctx.fillStyle = '#64748B';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('正前方 (0°)', cx, cy - R - 18);

    // 7. 图例
    ctx.textAlign = 'left';
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = '#0284C7';
    ctx.fillText('━ 配光曲线', 4, H - 16);
    ctx.fillStyle = 'rgba(220,38,38,0.7)';
    ctx.fillText('━ 半功率角(50%)', 70, H - 16);
    ctx.fillStyle = '#64748B';
    ctx.fillText('光束角越小→准直性越好，越大→发散越大', 4, H - 4);

    return { beamAngle: beamAngle };
  }

  // ============ 光斑伪彩云图（jet 伪彩 / 真彩合成）============
  /** jet 伪彩 → [r,g,b] 整数三元组 */
  function jetRGB(t) {
    t = clamp(t, 0, 1);
    return [
      Math.round(255 * clamp(1.5 - Math.abs(4 * t - 3), 0, 1)),
      Math.round(255 * clamp(1.5 - Math.abs(4 * t - 2), 0, 1)),
      Math.round(255 * clamp(1.5 - Math.abs(4 * t - 1), 0, 1))
    ];
  }

  /**
   * 探测屏辐照度云图。
   * spot = { res, half(mm), E:Array(res*res)，索引 iy*res+ix，iy 随 v 增大而增大, Emax(W/m²) }
   * opts = { mode:'jet'|'color', rgbCells:[[r,g,b]...], unit }
   * 返回布局 { ox, oy, size, res, half }（供悬停读数映射）。
   */
  function drawSpotCloud(canvas, spot, opts) {
    opts = opts || {};
    var s = setup(canvas), ctx = s.ctx, W = s.w, H = s.h;
    var res = spot.res;
    var padL = 46, padT = 12, padB = 30, padR = 64;
    var pw = Math.max(40, W - padL - padR), ph = Math.max(40, H - padT - padB);
    var size = Math.min(pw, ph);
    var ox = padL + (pw - size) / 2, oy = padT + (ph - size) / 2;
    var half = spot.half || 1;
    var Emax = spot.Emax > 0 ? spot.Emax : 1;

    ctx.fillStyle = '#F1F5F9';
    ctx.fillRect(ox, oy, size, size);

    var off = document.createElement('canvas');
    off.width = res; off.height = res;
    var octx = off.getContext('2d');
    var img = octx.createImageData(res, res);
    var d = img.data;
    for (var iy = 0; iy < res; iy++) {
      var imgRow = res - 1 - iy;                 // 网格 v 向上 → ImageData 行向下
      for (var ix = 0; ix < res; ix++) {
        var gIdx = iy * res + ix;
        var px = (imgRow * res + ix) * 4;
        if (opts.mode === 'color' && opts.rgbCells) {
          var rgb = opts.rgbCells[gIdx] || [30, 41, 59];
          d[px] = rgb[0]; d[px + 1] = rgb[1]; d[px + 2] = rgb[2]; d[px + 3] = 255;
        } else {
          var col = jetRGB(spot.E[gIdx] / Emax);
          d[px] = col[0]; d[px + 1] = col[1]; d[px + 2] = col[2]; d[px + 3] = 255;
        }
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, res, res, ox, oy, size, size);

    // 中心十字（光轴位置）
    var cxp = ox + size / 2, cyp = oy + size / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cxp - 6, cyp); ctx.lineTo(cxp + 6, cyp);
    ctx.moveTo(cxp, cyp - 6); ctx.lineTo(cxp, cyp + 6);
    ctx.stroke();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.arc(cxp, cyp, size / 2 - 6, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#CBD5E1';
    ctx.strokeRect(ox + 0.5, oy + 0.5, size, size);

    // 坐标（mm）
    ctx.fillStyle = '#64748B';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(-half.toFixed(0), ox, oy + size + 14);
    ctx.fillText('0', cxp, oy + size + 14);
    ctx.fillText('+' + half.toFixed(0), ox + size, oy + size + 14);
    ctx.fillText('探测屏坐标 (mm)', cxp, oy + size + 27);
    ctx.textAlign = 'right';
    ctx.fillText('+' + half.toFixed(0), ox - 4, oy + 10);
    ctx.fillText('0', ox - 4, cyp + 3);
    ctx.fillText('-' + half.toFixed(0), ox - 4, oy + size - 2);

    // 色标条（jet 模式）
    if (opts.mode !== 'color') {
      var barW = 14, barX = ox + size + 14;
      for (var y = 0; y < size; y++) {
        ctx.fillStyle = jet(1 - y / size);
        ctx.fillRect(barX, oy + y, barW, 1.5);
      }
      ctx.strokeStyle = '#CBD5E1';
      ctx.strokeRect(barX + 0.5, oy + 0.5, barW, size);
      ctx.fillStyle = '#64748B';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(Emax.toExponential(2), barX + barW + 3, oy + 8);
      ctx.fillText('0', barX + barW + 3, oy + size);
      ctx.fillText(opts.unit || 'W/m²', barX + barW + 3, oy + size / 2);
    } else {
      ctx.fillStyle = '#64748B';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('真彩合成', ox + size + 14, oy + 12);
      ctx.fillText('(按 λ 着色)', ox + size + 14, oy + 26);
    }

    return { ox: ox, oy: oy, size: size, res: res, half: half };
  }

  // ============ 径向分布曲线（含 D86 环绕能量直径）============
  /** radial = { r:[mm], e:[W/m²], r86:number, rFwhm:number } */
  function drawRadial(canvas, radial, opts) {
    opts = opts || {};
    var s = setup(canvas), ctx = s.ctx, W = s.w, H = s.h;
    var padL = 50, padR = 16, padT = 14, padB = 40;
    var pw = W - padL - padR, ph = H - padT - padB;
    var n = radial.r.length;
    if (n < 2 || pw <= 0 || ph <= 0) return null;
    var vmax = 0;
    for (var i = 0; i < n; i++) if (radial.e[i] > vmax) vmax = radial.e[i];
    if (vmax <= 0) vmax = 1;
    var rmax = radial.r[n - 1] || 1;

    function X(r) { return padL + pw * r / rmax; }
    function Y(e) { return padT + ph - ph * e / vmax; }

    // 网格
    ctx.strokeStyle = '#E2E8F0';
    ctx.fillStyle = '#64748B';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + ph - ph * g / 4;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
      ctx.fillText((vmax * g / 4).toExponential(1), padL - 5, gy + 3);
    }

    // D86 区域着色
    if (radial.r86 > 0) {
      ctx.fillStyle = 'rgba(22,163,74,0.10)';
      ctx.fillRect(padL, padT, X(Math.min(radial.r86, rmax)) - padL, ph);
    }

    // 曲线
    ctx.strokeStyle = '#0284C7';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (var k = 0; k < n; k++) {
      var px = X(radial.r[k]), py = Y(radial.e[k]);
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.lineWidth = 1;

    // D86 直径标注（半径线）
    if (radial.r86 > 0) {
      var x86 = X(Math.min(radial.r86, rmax));
      ctx.strokeStyle = 'rgba(22,163,74,0.85)';
      ctx.lineWidth = 1.4; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x86, padT); ctx.lineTo(x86, padT + ph); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1;
      ctx.fillStyle = '#16A34A';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('r86 = ' + radial.r86.toFixed(2) + 'mm', Math.min(x86 + 4, W - padR - 90), padT + 12);
    }
    if (radial.rFwhm > 0) {
      var xf = X(Math.min(radial.rFwhm, rmax));
      ctx.strokeStyle = 'rgba(220,38,38,0.8)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(xf, padT); ctx.lineTo(xf, padT + ph); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#DC2626';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillText('FWHM r = ' + radial.rFwhm.toFixed(2) + 'mm', Math.min(xf + 4, W - padR - 96), padT + 26);
    }

    // X 轴
    ctx.fillStyle = '#64748B';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (var t = 0; t <= 4; t++) {
      var rv = rmax * t / 4;
      ctx.fillText(rv.toFixed(1), X(rv), H - 22);
    }
    ctx.fillText(opts.xLabel || '径向半径 r (mm)', padL + pw / 2, H - 6);
    ctx.textAlign = 'left';
    ctx.fillText(opts.yLabel || '径向平均辐照度 (W/m²)', padL, 10);
    return { peak: vmax, r86: radial.r86, rFwhm: radial.rFwhm };
  }

  // ============ 辐照度统计直方图 ============
  /** hist = { counts:[], min, max, mean, peakE, peakCount } */
  function drawHistogram(canvas, hist, opts) {
    opts = opts || {};
    var s = setup(canvas), ctx = s.ctx, W = s.w, H = s.h;
    var padL = 40, padR = 16, padT = 14, padB = 40;
    var pw = W - padL - padR, ph = H - padT - padB;
    var n = hist.counts.length;
    if (n === 0 || pw <= 0 || ph <= 0) return null;
    var cmax = 0;
    for (var i = 0; i < n; i++) if (hist.counts[i] > cmax) cmax = hist.counts[i];
    if (cmax <= 0) cmax = 1;
    var span = (hist.max - hist.min) || 1;

    ctx.strokeStyle = '#E2E8F0';
    ctx.fillStyle = '#64748B';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + ph - ph * g / 4;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
      ctx.fillText(String(Math.round(cmax * g / 4)), padL - 5, gy + 3);
    }

    var bw = pw / n;
    for (var b = 0; b < n; b++) {
      var bh = ph * hist.counts[b] / cmax;
      var eMid = hist.min + span * (b + 0.5) / n;
      ctx.fillStyle = jet(eMid / (hist.max || 1));
      ctx.globalAlpha = 0.85;
      ctx.fillRect(padL + b * bw, padT + ph - bh, Math.max(1, bw - 0.6), bh);
      ctx.globalAlpha = 1;
    }

    // 均值线
    if (hist.mean > 0) {
      var mx = padL + pw * (hist.mean - hist.min) / span;
      ctx.strokeStyle = 'rgba(22,163,74,0.9)';
      ctx.lineWidth = 1.4; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(mx, padT); ctx.lineTo(mx, padT + ph); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1;
      ctx.fillStyle = '#16A34A';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('mean ' + hist.mean.toExponential(2), Math.min(mx + 4, W - padR - 96), padT + 12);
    }

    ctx.fillStyle = '#64748B';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(hist.min.toExponential(1), padL, H - 22);
    ctx.fillText(((hist.min + hist.max) / 2).toExponential(1), padL + pw / 2, H - 22);
    ctx.fillText(hist.max.toExponential(1), padL + pw, H - 22);
    ctx.fillText(opts.xLabel || '单元辐照度 (W/m²)', padL + pw / 2, H - 6);
    ctx.textAlign = 'left';
    ctx.fillText(opts.yLabel || '单元数', padL, 10);
    return { peakCount: cmax, mean: hist.mean };
  }

  window.LG = window.LG || {};
  LG.Charts = {
    jet: jet,
    jetRGB: jetRGB,
    setup: setup,
    computeMetrics: computeMetrics,
    drawHeatmap: drawHeatmap,
    drawLineChart: drawLineChart,
    drawPolar: drawPolar,
    drawSpotCloud: drawSpotCloud,
    drawRadial: drawRadial,
    drawHistogram: drawHistogram
  };
})();
