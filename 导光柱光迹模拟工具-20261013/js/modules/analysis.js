/**
 * LG.Modules.analysis — 结果分析页
 * 数据来源（最近运行 / 历史记录）+ 可调阈值指标 + 热图 / 轴向 / 配光三图 + 仿真 vs 实测对比
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // ---- 模块级共享：工程化统计 + 结论生成（结果分析页与报告页共用，保证同数据同结论） ----
  function engStats(d, m, proj) {
    var L = d.ledger || {};
    var sum = (L.output || 0) + (L.side || 0) + (L.absorbed || 0) + (L.residual || 0) || 1;
    var util = (L.output || 0) / sum;
    var flux = (d.params && d.params.flux) || ((proj && proj.source && proj.source.flux) || 683);
    return { util: util, outLm: flux * util, m: m, flux: flux };
  }

  function isMultiGuide(proj) {
    var nBead = (proj && proj.beads && proj.beads.length) || 1;
    return nBead > 1 || LG.Store.list().length > 1;
  }

  /**
   * 生成工程结论 HTML（与结果分析页完全同口径）。
   * d: 运行数据（ledger / agg / tolerance / params）
   * st: { util, outLm, m, flux }
   * proj: 项目（eng.targets / scheme / beads）
   * tr: 翻译函数（LG.t 或 LG.I18N.tFor(lang)）
   */
  function buildConclusion(d, st, proj, tr) {
    var en = (proj && proj.eng) || {};
    var tg = en.targets || {};
    var m = st.m;
    var items = [];
    var worst = 'ok';

    function push(lv, text) {
      items.push({ lv: lv, text: text });
      if (lv === 'bad') worst = 'bad';
      else if (lv === 'warn' && worst !== 'bad') worst = 'warn';
    }

    if (tg.brightness) {
      var lvB = st.util >= 0.30 ? 'ok' : (st.util >= 0.18 ? 'warn' : 'bad');
      var margin = st.util >= 0.30 ? (st.util / 0.30 - 1) * 100 : 0;
      push(lvB, tr('ana.cl.bright.' + lvB, (st.util * 100).toFixed(1), margin.toFixed(0)));
    }
    if (tg.uniformity) {
      var lvU = m.uniformity >= 0.70 ? 'ok' : (m.uniformity >= 0.50 ? 'warn' : 'bad');
      if (lvU !== 'bad') push(lvU, tr('ana.cl.uni.' + lvU, m.uniformity.toFixed(3)));
    }
    if (tg.leak && isMultiGuide(proj)) {
      var leak = 1 - st.util;
      var lvL = leak <= 0.05 ? 'ok' : (leak <= 0.15 ? 'warn' : 'bad');
      push(lvL, tr('ana.cl.leak.' + lvL, (leak * 100).toFixed(1)));
    }
    if (tg.tolerance) {
      var tol = d.tolerance;
      if (!tol || !tol.length) {
        push('warn', tr('ana.cl.tol.none'));
      } else {
        var worstT = tol[tol.length - 1];
        var accept = null;
        for (var i = 0; i < tol.length; i++) if (tol[i].drop <= 30) accept = tol[i];
        var lvT = worstT.drop <= 30 ? 'ok' : 'warn';
        push(lvT, accept
          ? tr('ana.cl.tol', accept.offset.toFixed(1), accept.drop.toFixed(0))
          : tr('ana.cl.tol.warn', tol[0].offset.toFixed(1), tol[0].drop.toFixed(0)));
      }
    }
    if (tg.bendLoss) {
      var bent = (proj.scheme && proj.scheme.type) === 'bent';
      push(bent ? 'warn' : 'ok', tr(bent ? 'ana.cl.bend' : 'ana.cl.bend.ok',
        (proj.scheme && proj.scheme.bendAngle) || 90, (proj.scheme && proj.scheme.bendR) || 3));
    }
    if (tg.crosstalk) {
      var nBead = (proj.beads && proj.beads.length) || 1;
      var lvC = nBead > 1 ? 'warn' : 'ok';
      push(lvC, nBead > 1 ? tr('ana.cl.cross', nBead) : tr('ana.cl.cross.ok'));
    }
    if (tg.molding) {
      var dr = (proj.scheme && proj.scheme.draftAngle != null) ? +proj.scheme.draftAngle : 1;
      var lvM = dr >= 1 ? 'ok' : 'warn';
      push(lvM, tr(lvM === 'ok' ? 'ana.cl.mold.ok' : 'ana.cl.mold.warn', dr.toFixed(1)));
    }

    var badge = tr('ana.cl.badge.' + worst);
    return '<div class="verdict-card verdict-' + worst + '">' +
      '<div class="verdict-badge">' + badge + '</div>' +
      '<div class="verdict-body">' +
        '<div class="verdict-items">' +
          (items.length
            ? items.map(function (it) {
                var icon = it.lv === 'ok' ? '✓' : (it.lv === 'warn' ? '⚠' : '✗');
                return '<span class="vi vi-' + it.lv + '"><b>' + icon + '</b> ' + LG.esc(it.text) + '</span>';
              }).join('')
            : '<span class="vi">' + tr('ana.cl.notarget') + '</span>') +
        '</div>' +
        '<div class="verdict-advice"><b>' + tr('ana.cl.sum.' + worst) + '</b></div>' +
      '</div>' +
    '</div>';
  }

  function render(el) {
    var p = LG.state.project;
    var hasData = !!LG.state.lastRun || p.records.length > 0;

    if (!hasData) {
      el.innerHTML =
        '<div class="page-title">' + LG.t('ana.title') + '</div>' +
        '<div class="card"><div class="hint" style="font-size:14px;margin:8px 0">' + LG.t('ana.noData') + '</div></div>';
      return null;
    }

    el.innerHTML =
      '<div class="page-title">' + LG.t('ana.title') + '</div>' +
      '<div class="layout">' +
        '<div>' +
          '<div class="card">' +
            '<div class="card-title">' + LG.t('ana.src') + '</div>' +
            '<div class="card-body card-open">' +
              '<div class="field" style="margin-bottom:0"><select id="a-src"></select></div>' +
            '</div>' +
          '</div>' +
          '<div class="card">' +
            '<div class="card-title">' + LG.t('ana.m.th') + '</div>' +
            '<div class="card-body card-open">' +
              '<div class="field"><label id="a-th-label" style="font-size:15px;font-weight:700;color:var(--ink)">0.80</label>' +
                '<div class="input-slider"><input type="range" id="a-th" min="0.5" max="1" step="0.05"></div></div>' +
              '<div class="hint">' + LG.t('ana.m.pass') + ' = I ≥ threshold × Eavg</div>' +
            '</div>' +
          '</div>' +
          '<div class="card">' +
            '<div class="card-title">' + LG.t('ana.compare') + '</div>' +
            '<div class="card-body card-open">' +
              '<div class="field"><label>' + LG.t('ana.cmp.select') + '</label><select id="a-cmp-sel"></select></div>' +
              '<div id="a-cmp-body"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div id="a-concl"></div>' +
          '<div class="card">' +
            '<div class="card-title">' + LG.t('ana.spot') + '</div>' +
            '<div class="card-body card-open">' +
              '<div class="spot-embed-tools">' +
                '<label for="a-spot-mode">' + LG.t('spot.mode') + '</label>' +
                '<select id="a-spot-mode">' +
                  '<option value="jet">' + LG.t('spot.mode.jet') + '</option>' +
                  '<option value="color">' + LG.t('spot.mode.color') + '</option>' +
                  '<option value="sep">' + LG.t('spot.mode.sep') + '</option>' +
                '</select>' +
                '<button id="a-spot-png" class="btn btn-ghost btn-sm">' + LG.t('spot.export.png') + '</button>' +
              '</div>' +
              '<div style="position:relative;margin-top:10px">' +
                '<canvas id="a-spot" style="width:100%;height:420px;border-radius:8px"></canvas>' +
                '<div id="a-spot-hover" class="spot-hover" style="display:none"></div>' +
              '</div>' +
              '<div class="hint" style="margin-top:10px;line-height:1.6" id="a-spot-hint">' + LG.t('ana.spot.desc') + '</div>' +
              '<div id="a-spot-sep" class="spot-sep-grid" style="display:none;margin-top:12px"></div>' +
              '<div id="a-spot-disp" style="margin-top:12px"></div>' +
              '<div id="a-trace" style="margin-top:14px"></div>' +
            '</div>' +
          '</div>' +
          '<div class="metrics" id="a-metrics"></div>' +
          '<div class="hint" style="margin-bottom:10px;line-height:1.6">' + LG.t('ana.metrics.desc') + '</div>' +
          '<div class="card">' +
            '<div class="card-title">' + LG.t('ana.heat') + '</div>' +
            '<div class="card-body card-open">' +
              '<canvas id="a-heat" style="width:100%;height:360px"></canvas>' +
              '<div class="hint" style="margin-top:10px;line-height:1.6">' + LG.t('ana.heat.desc') + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="card" id="a-tol-card">' +
            '<div class="card-title">' + LG.t('ana.tol.title') + '</div>' +
            '<div class="card-body card-open">' +
              '<canvas id="a-tol" style="width:100%;height:230px"></canvas>' +
              '<div id="a-tol-tbl" style="margin-top:12px"></div>' +
              '<div class="hint" id="a-tol-note" style="margin-top:10px;line-height:1.6">' + LG.t('ana.tol.desc') + '</div>' +
            '</div>' +
          '</div>' +
          '<details class="adv-box" style="margin-top:16px">' +
            '<summary>' + LG.t('ana.optical') + '</summary>' +
            '<div id="a-verdict" style="margin-top:12px"></div>' +
            '<div class="chart-grid" style="margin-top:16px">' +
              '<div class="card">' +
                '<div class="card-title">' + LG.t('ana.axis') + '</div>' +
                '<div class="card-body card-open">' +
                  '<canvas id="a-axis" style="width:100%;height:260px"></canvas>' +
                  '<div class="hint" style="margin-top:10px;line-height:1.6">' + LG.t('ana.axis.desc') + '</div>' +
                  '<div id="a-axis-interp" class="chart-interp"></div>' +
                '</div>' +
              '</div>' +
              '<div class="card">' +
                '<div class="card-title">' + LG.t('ana.polar') + '</div>' +
                '<div class="card-body card-open">' +
                  '<canvas id="a-polar" style="width:100%;height:260px"></canvas>' +
                  '<div class="hint" style="margin-top:10px;line-height:1.6">' + LG.t('ana.polar.desc') + '</div>' +
                  '<div id="a-polar-interp" class="chart-interp"></div>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</details>' +
        '</div>' +
      '</div>';

    // ---- 数据源下拉 ----
    var sel = $('a-src');
    var optLast = document.createElement('option');
    optLast.value = 'last';
    optLast.textContent = LG.t('ana.src.last');
    sel.appendChild(optLast);
    var recs = p.records;
    for (var i = 0; i < recs.length; i++) {
      var o = document.createElement('option');
      o.value = recs[i].id;
      o.textContent = recordLabel(recs[i]);
      sel.appendChild(o);
    }
    sel.value = 'last';

    // ---- 实测下拉 ----
    var cmp = $('a-cmp-sel');
    var optNone = document.createElement('option');
    optNone.value = '';
    optNone.textContent = LG.t('ana.cmp.none');
    cmp.appendChild(optNone);
    var meas = p.measurements;
    for (var j = 0; j < meas.length; j++) {
      var om = document.createElement('option');
      om.value = meas[j].id;
      om.textContent = meas[j].sample + (meas[j].device ? ' · ' + meas[j].device : '') +
        (meas[j].date ? ' · ' + meas[j].date : '');
      cmp.appendChild(om);
    }
    cmp.addEventListener('change', refreshCompare);

    // ---- 阈值 ----
    var th = $('a-th');
    th.value = '0.8';
    th.addEventListener('input', function () {
      $('a-th-label').textContent = Number(th.value).toFixed(2);
      refreshAll();
    });
    $('a-th-label').textContent = '0.80';

    // ---- 光斑显示模式 / 导出 / 悬停读数 ----
    var spotMode = $('a-spot-mode');
    spotMode.value = localStorage.getItem('lgv.spot.mode') || 'jet';
    spotMode.addEventListener('change', function () {
      localStorage.setItem('lgv.spot.mode', spotMode.value);
      renderSpot(currentData());
    });
    $('a-spot-png').addEventListener('click', function () {
      var cv = $('a-spot');
      if (!cv) return;
      try {
        var a = document.createElement('a');
        a.href = cv.toDataURL('image/png');
        a.download = 'spot_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.png';
        document.body.appendChild(a); a.click(); a.remove();
      } catch (e) { LG.status('Error: ' + e.message); }
    });
    var cloud = $('a-spot');
    cloud.addEventListener('mousemove', onSpotHover);
    cloud.addEventListener('mouseleave', function () { $('a-spot-hover').style.display = 'none'; });

    sel.addEventListener('change', refreshAll);
    refreshAll();

    return null;

    // ================= functions =================
    function recordLabel(rec) {
      var d = new Date(rec.time);
      var pad = function (x) { return (x < 10 ? '0' : '') + x; };
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) +
        ' · ' + rec.summary.total + ' rays · ' + rec.summary.successRate + '%';
    }
    function currentData() {
      if (sel.value === 'last') return LG.state.lastRun;
      return LG.Store.getRecord(sel.value);
    }
    function threshold() { return parseFloat(th.value) || 0.8; }

    function refreshAll() {
      var d = currentData();
      if (!d || !d.agg) {
        $('a-concl').innerHTML = ''; $('a-metrics').innerHTML = ''; $('a-verdict').innerHTML = '';
        $('a-axis-interp').innerHTML = ''; $('a-polar-interp').innerHTML = ''; $('a-trace').innerHTML = '';
        return;
      }
      var m = LG.Charts.computeMetrics(d.agg.heatmap, threshold());
      lastMetrics = m;
      var st = engStats(d, m, p);
      refreshMetrics(m, st);
      renderConclusion(d, st);
      renderSpot(d);
      renderTrace(d);
      renderTolerance(d);
      renderVerdict(m);
      LG.Charts.drawHeatmap($('a-heat'), d.agg.heatmap, m);
      var axisInfo = LG.Charts.drawLineChart($('a-axis'), d.agg.axis.values,
        { min: d.agg.axis.min, max: d.agg.axis.max, xLabel: LG.t('ana.axisPos'), yLabel: LG.t('ana.energy') });
      var polarInfo = LG.Charts.drawPolar($('a-polar'), d.agg.angle);
      renderAxisInterp(axisInfo, d);
      renderPolarInterp(polarInfo);
      refreshCompare();
    }

    /** 工程结论卡片（委托模块级 buildConclusion，与报告页完全同口径） */
    function renderConclusion(d, st) {
      $('a-concl').innerHTML = buildConclusion(d, st, p, LG.t);
    }

    // ---- 出射端面光斑（原「光斑分析」页内容并入本页） ----
    // 最近一次运行保留了原始出射光线（hits），可切伪彩/真彩/逐λ分离并读色差；
    // 历史记录只存了端面热图，退回伪彩云图。
    var spotLayout = null;
    var spotView = null;

    function renderSpot(d) {
      var cv = $('a-spot');
      if (!cv) return;
      var mode = $('a-spot-mode').value;
      var sepBox = $('a-spot-sep');
      var dispBox = $('a-spot-disp');
      var hint = $('a-spot-hint');
      var view = (sel.value === 'last') ? LG.Modules.spot.buildView(mode) : null;
      spotView = view;

      if (view) {
        spotLayout = LG.Charts.drawSpotCloud(cv, view.cloud, view.opts);
        var cur = view.cur;
        hint.textContent = LG.t('spot.cloudHint', (2 * cur.half).toFixed(1), cur.res,
          cur.metrics.n, cur.skipped + cur.outside);
        if (cur.conserve > 1e-9) hint.textContent += ' · ⚠ ' + LG.t('spot.msg.conserveErr', cur.conserve.toExponential(1));

        // 逐 λ 分离
        if (mode === 'sep' && view.sep.length) {
          sepBox.style.display = '';
          sepBox.innerHTML = '';
          view.sep.forEach(function (it) {
            var wrap = document.createElement('div');
            wrap.className = 'spot-sep-item';
            var c2 = document.createElement('canvas');
            c2.style.width = '100%'; c2.style.height = '240px';
            var cap = document.createElement('div');
            cap.className = 'hint'; cap.style.textAlign = 'center';
            cap.textContent = it.lam + ' nm';
            wrap.appendChild(c2); wrap.appendChild(cap);
            sepBox.appendChild(wrap);
            LG.Charts.drawSpotCloud(c2, { res: view.cloud.res, half: view.cloud.half, E: it.E, Emax: it.Emax }, {});
          });
        } else if (mode === 'sep') {
          // 单波长：没有可分离的波长，给出提示而不是空白
          sepBox.style.display = '';
          sepBox.innerHTML = '<div class="hint">' + LG.t('spot.disp.nomulti') + '</div>';
        } else {
          sepBox.style.display = 'none';
        }
        renderChromaBox(dispBox, cur.chroma);
      } else {
        // 历史记录：按端面热图渲染伪彩云图
        spotLayout = renderSpotFallback(cv, d.agg.heatmap);
        hint.textContent = LG.t('ana.spot.desc');
        sepBox.style.display = 'none';
        dispBox.innerHTML = '';
      }
    }

    /** 历史记录兜底：用 64 网格端面热图绘制伪彩云图 */
    function renderSpotFallback(canvas, heat) {
      if (!heat || !heat.cells || !heat.cells.length) return null;
      var res = heat.res, n = res * res;
      var E = new Float64Array(n), Emax = 0;
      for (var i = 0; i < n; i++) {
        var v = (heat.counts && heat.counts[i] > 0) ? heat.cells[i] : 0;  // ✅ 累计能量 cells，与 drawHeatmap / computeMetrics 一致
        E[i] = v; if (v > Emax) Emax = v;
      }
      if (Emax <= 0) return null;
      var half = Math.max((heat.u1 - heat.u0), (heat.v1 - heat.v0)) / 2;
      if (!(half > 0)) half = 1;
      return LG.Charts.drawSpotCloud(canvas, { res: res, half: half, E: E, Emax: Emax }, {});
    }

    /** 色差量化表（多波长时才输出） */
    function renderChromaBox(box, ch) {
      if (!box) return;
      if (!ch || !ch.multi || !ch.list.length) {
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

    /** 鼠标悬停读取端面坐标与辐照度 */
    function onSpotHover(e) {
      var box = $('a-spot-hover');
      if (!spotLayout || !spotView) { box.style.display = 'none'; return; }
      var cv = $('a-spot');
      var rc = cv.getBoundingClientRect();
      var lay = spotLayout;
      var mx = (e.clientX - rc.left) * ((cv.clientWidth || rc.width) / rc.width);
      var my = (e.clientY - rc.top) * (rc.height ? (cv.clientHeight || rc.height) / rc.height : 1);
      if (mx < lay.ox || mx > lay.ox + lay.size || my < lay.oy || my > lay.oy + lay.size) {
        box.style.display = 'none'; return;
      }
      var d = spotView.cur.disp;
      var ix = Math.max(0, Math.min(d.res - 1, Math.floor((mx - lay.ox) / lay.size * d.res)));
      var iy = Math.max(0, Math.min(d.res - 1, Math.floor((my - lay.oy) / lay.size * d.res)));
      var half = spotView.cloud.half;
      var u = (ix + 0.5) / d.res * 2 * half - half;
      var v = (iy + 0.5) / d.res * 2 * half - half;
      box.style.display = '';
      box.style.left = (mx + 12) + 'px';
      box.style.top = (my + 12) + 'px';
      box.textContent = 'X ' + u.toFixed(2) + ' mm · Y ' + v.toFixed(2) + ' mm · ' +
        (d.Etot[iy * d.res + ix] / d.A_cell).toExponential(2) + ' W/m²';
    }

    /** 光路迹线：复用运行记录中的 3D 截图 */
    function renderTrace(d) {
      var box = $('a-trace');
      if (d.thumb) {
        box.innerHTML = '<div class="hint" style="margin:0 0 6px">' + LG.t('ana.trace') + '</div>' +
          '<img src="' + d.thumb + '" alt="ray paths" style="width:100%;border:1px solid var(--line);border-radius:8px">';
      } else {
        box.innerHTML = '<div class="hint" style="margin:0">' + LG.t('ana.trace.none') + '</div>';
      }
    }

    /** 公差-亮度衰减曲线 */
    function renderTolerance(d) {
      var card = $('a-tol-card');
      var tg = (p.eng && p.eng.targets) || {};
      if (!tg.tolerance) { card.style.display = 'none'; return; }
      card.style.display = '';
      var canvas = $('a-tol');
      var arr = d.tolerance;
      var note = $('a-tol-note');
      var tbl = $('a-tol-tbl');
      if (!arr || !arr.length) {
        note.textContent = LG.t('ana.tol.empty');
        if (tbl) tbl.innerHTML = '';
        var ctx0 = canvas.getContext('2d');
        var w0 = canvas.clientWidth || 600, h0 = canvas.clientHeight || 230;
        var dpr0 = window.devicePixelRatio || 1;
        canvas.width = Math.round(w0 * dpr0); canvas.height = Math.round(h0 * dpr0);
        ctx0.setTransform(dpr0, 0, 0, dpr0, 0, 0);
        ctx0.clearRect(0, 0, w0, h0);
        return;
      }
      note.textContent = LG.t('ana.tol.desc');
      drawTolCurve(canvas, arr);
      if (tbl) {
        var th = '<table class="tbl"><thead><tr>' +
          '<th>' + LG.t('ana.tol.offset') + '</th>' +
          '<th>' + LG.t('ana.tol.bright') + '</th>' +
          '<th>' + LG.t('ana.tol.drop') + '</th></tr></thead><tbody>';
        for (var i = 0; i < arr.length; i++) {
          var bv = Number(arr[i].brightness);
          th += '<tr><td>' + Number(arr[i].offset).toFixed(1) + '</td><td>' +
            (arr[i].brightness != null && isFinite(bv) ? bv.toFixed(2) : '—') + '</td><td>−' +
            Number(arr[i].drop).toFixed(1) + '%</td></tr>';
        }
        tbl.innerHTML = th + '</tbody></table>';
      }
    }

    function drawTolCurve(canvas, arr) {
      var dpr = window.devicePixelRatio || 1;
      var w = canvas.clientWidth || 600, h = canvas.clientHeight || 230;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      var ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var L = 44, R = 16, T = 16, B = 34;
      var pw = w - L - R, ph = h - T - B;
      var maxX = arr[arr.length - 1].offset || 0.3;
      var maxY = Math.max(40, Math.ceil(Math.max.apply(null, arr.map(function (a) { return a.drop; })) / 10) * 10);
      // 网格
      ctx.strokeStyle = '#E2E8F0'; ctx.lineWidth = 1;
      for (var gy = 0; gy <= 4; gy++) {
        var yy = T + ph - ph * gy / 4;
        ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(L + pw, yy); ctx.stroke();
      }
      // 30% 阈值线
      var y30 = T + ph - ph * (30 / maxY);
      ctx.strokeStyle = '#EF4444'; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(L, y30); ctx.lineTo(L + pw, y30); ctx.stroke();
      ctx.setLineDash([]);
      // 曲线（含 0mm 基线）
      var pts = [{ offset: 0, drop: 0 }].concat(arr);
      ctx.strokeStyle = '#2BAA8E'; ctx.lineWidth = 2.5;
      ctx.beginPath();
      pts.forEach(function (pp, i) {
        var x = L + pw * (pp.offset / maxX);
        var y = T + ph - ph * Math.min(maxY, pp.drop) / maxY;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      // 数据点 + 标签
      ctx.fillStyle = '#2BAA8E';
      pts.forEach(function (pp) {
        var x = L + pw * (pp.offset / maxX);
        var y = T + ph - ph * Math.min(maxY, pp.drop) / maxY;
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1E2A38'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(pp.drop.toFixed(0) + '%', x, y - 8);
        ctx.fillStyle = '#2BAA8E';
      });
      // 轴标签
      ctx.fillStyle = '#64748B'; ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      pts.forEach(function (pp) {
        var x = L + pw * (pp.offset / maxX);
        ctx.fillText(pp.offset.toFixed(1), x, h - 12);
      });
      ctx.textAlign = 'left';
      ctx.fillText(LG.t('ana.tol.offset'), L, h - 12);
      ctx.save(); ctx.translate(12, T + ph / 2); ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center'; ctx.fillText(LG.t('ana.tol.drop'), 0, 0); ctx.restore();
    }

    /** 沿轴向侧壁出光分布解读 */
    function renderAxisInterp(info, d) {
      var box = $('a-axis-interp');
      if (!info || !info.avg) { box.innerHTML = ''; return; }
      var parts = [];
      // 峰谷数量判断
      if (info.peaks.length === 0 && info.valleys.length === 0) {
        parts.push('<span class="vi vi-ok"><b>✓</b> 分布均匀，无明显峰谷</span>');
      } else {
        if (info.peaks.length > 0) {
          parts.push('<span class="vi vi-warn"><b>⚠</b> 存在 ' + info.peaks.length + ' 处峰值（局部过亮），可能对应齿结构出光集中区</span>');
        }
        if (info.valleys.length > 0) {
          parts.push('<span class="vi vi-bad"><b>✗</b> 存在 ' + info.valleys.length + ' 处谷值（局部过暗），该区域侧壁出光不足</span>');
        }
      }
      // 均值参考
      parts.push('<span class="vi"><b>≈</b> 平均能量 ' + info.avg.toFixed(3) + '，理想曲线应在绿色目标带内波动</span>');
      // 带齿判断
      var isToothed = d.params && d.params.geometry && d.params.geometry.teeth && d.params.geometry.teeth.enabled;
      if (isToothed && info.peaks.length > 0) {
        parts.push('<span class="vi vi-ok"><b>✓</b> 带齿结构检测到周期性出光峰，齿结构功能正常</span>');
      } else if (!isToothed && info.avg > 0.01) {
        parts.push('<span class="vi vi-warn"><b>⚠</b> 平滑柱体侧壁有较多漏光，建议启用齿结构提升耦合效率</span>');
      }
      box.innerHTML = '<div class="interp-box">' + parts.join('') + '</div>';
    }

    /** 配光曲线解读 */
    function renderPolarInterp(info) {
      var box = $('a-polar-interp');
      if (!info) { box.innerHTML = ''; return; }
      var ba = info.beamAngle || 0;
      var parts = [];
      // 光束角判断
      if (ba <= 30) {
        parts.push('<span class="vi vi-ok"><b>✓</b> 光束角 ' + ba.toFixed(0) + '°，准直性良好，光线集中向前射出</span>');
      } else if (ba <= 60) {
        parts.push('<span class="vi vi-warn"><b>⚠</b> 光束角 ' + ba.toFixed(0) + '°，中等发散，出射光线有一定角度扩散</span>');
      } else {
        parts.push('<span class="vi vi-bad"><b>✗</b> 光束角 ' + ba.toFixed(0) + '°，发散严重，光线分散角度大</span>');
      }
      // 设计建议
      if (ba > 60) {
        parts.push('<span class="vi"><b>→</b> 建议：增大端面曲率半径、减少表面散射或调整光源发散角以收束光线</span>');
      } else if (ba <= 30) {
        parts.push('<span class="vi"><b>→</b> 当前设计准直性满足要求，适合需要定向照明的场景</span>');
      } else {
        parts.push('<span class="vi"><b>→</b> 可接受范围，如需更准直可优化端面几何参数</span>');
      }
      box.innerHTML = '<div class="interp-box">' + parts.join('') + '</div>';
    }

    var lastMetrics = null;

    function refreshMetrics(m, st) {
      var d = currentData();
      if (!d || !d.agg) return;
      if (!m) m = LG.Charts.computeMetrics(d.agg.heatmap, threshold());
      if (!st) st = engStats(d, m, p);
      lastMetrics = m;
      // 工程语言指标：光学原始术语放在 hover 提示中
      $('a-metrics').innerHTML =
        metricRange(LG.t('ana.e.flux'), (st.util * 100).toFixed(1) + '%', 'flux', st.util, [0.18, 0.30], true, LG.t('ana.e.flux.raw')) +
        metricRange(LG.t('ana.e.uni'), m.uniformity.toFixed(3), 'uni', m.uniformity, [0.40, 0.70], true, LG.t('ana.e.uni.raw')) +
        metricRange(LG.t('ana.e.peak'), m.max.toFixed(3), 'peak', null, null, true, LG.t('ana.e.peak.raw')) +
        metricRange(LG.t('ana.e.total'), st.outLm.toFixed(1) + ' lm', 'total', null, null, true, LG.t('ana.e.total.raw'));
    }

    /** 设计评价：综合三项指标给出交通灯评级 + 通俗解读 */
    function renderVerdict(m) {
      if (!m) { $('a-verdict').innerHTML = ''; return; }
      var uni = m.uniformity, cv = m.cv, pass = m.passRatio;
      // 逐项评级
      var uniL = uni >= 0.7 ? 'ok' : (uni >= 0.4 ? 'warn' : 'bad');
      var cvL = cv <= 0.2 ? 'ok' : (cv <= 0.35 ? 'warn' : 'bad');
      var passL = pass >= 0.9 ? 'ok' : (pass >= 0.7 ? 'warn' : 'bad');
      // 综合评级
      var verdict = 'bad';
      if (uniL === 'ok' && cvL === 'ok' && passL === 'ok') verdict = 'ok';
      else if (uniL === 'bad' || cvL === 'bad' || passL === 'bad') verdict = 'warn';
      else verdict = 'warn';
      if (uniL === 'ok' && cvL === 'ok' && passL === 'ok') verdict = 'ok';
      if (uniL === 'bad' || cvL === 'bad' || passL === 'bad') {
        if (uniL === 'bad' && cvL === 'bad' && passL === 'bad') verdict = 'bad';
        else verdict = 'warn';
      }

      var label = verdict === 'ok' ? LG.t('ana.verdict.ok') : (verdict === 'bad' ? LG.t('ana.verdict.bad') : LG.t('ana.verdict.warn'));
      var advice = '';
      if (verdict === 'ok') {
        advice = LG.t('ana.verdict.okAdvice');
      } else {
        var problems = [];
        if (uniL !== 'ok') problems.push(LG.t('ana.verdict.pUni', uni.toFixed(3)));
        if (cvL !== 'ok') problems.push(LG.t('ana.verdict.pCv', cv.toFixed(3)));
        if (passL !== 'ok') problems.push(LG.t('ana.verdict.pPass', (pass * 100).toFixed(1)));
        advice = LG.t('ana.verdict.advice', problems.join('；'));
      }

      var html = '<div class="verdict-card verdict-' + verdict + '">' +
        '<div class="verdict-badge">' + label + '</div>' +
        '<div class="verdict-body">' +
          '<div class="verdict-items">' +
            verdictItem(LG.t('ana.m.uni'), uni.toFixed(3), uniL) +
            verdictItem(LG.t('ana.m.cv'), cv.toFixed(3), cvL) +
            verdictItem(LG.t('ana.m.pass'), (pass * 100).toFixed(1) + '%', passL) +
          '</div>' +
          '<div class="verdict-advice">' + advice + '</div>' +
        '</div>' +
      '</div>';
      $('a-verdict').innerHTML = html;
    }
    function verdictItem(name, val, lvl) {
      var icon = lvl === 'ok' ? '✓' : (lvl === 'warn' ? '⚠' : '✗');
      return '<span class="vi vi-' + lvl + '"><b>' + icon + '</b> ' + name + ' ' + val + '</span>';
    }

    /** 带目标范围条的指标卡 */
    function metricRange(k, v, type, val, thresholds, biggerBetter, title) {
      if (!thresholds) {
        // 无固定范围，只显示值
        return '<div class="metric"' + (title ? ' title="' + LG.esc(title) + '"' : '') + '>' +
          '<div class="mk">' + k + '</div><div class="mv">' + v + '</div></div>';
      }
      var lo = thresholds[0], hi = thresholds[1];
      var pct = biggerBetter ? (val - lo) / (hi - lo) * 100 : (lo - val) / (lo - hi) * 100;
      // 限制在 0-100
      pct = Math.max(0, Math.min(100, pct));
      var pos = biggerBetter ? Math.max(0, Math.min(100, (val - lo) / (hi - lo) * 100 + 50)) : Math.max(0, Math.min(100, 50 + (lo - val) / (lo - hi) * 50));
      // 简化：直接按值在 [0,1] 上的位置映射
      var barPct = biggerBetter
        ? Math.max(0, Math.min(100, val >= hi ? 100 : (val <= lo ? 0 : (val - lo) / (hi - lo) * 100)))
        : Math.max(0, Math.min(100, val <= lo ? 100 : (val >= hi ? 0 : (hi - val) / (hi - lo) * 100)));
      var cls = val >= hi ? 'ok' : (val >= lo ? 'warn' : 'bad');
      if (!biggerBetter) {
        cls = val <= lo ? 'ok' : (val <= hi ? 'warn' : 'bad');
      }
      return '<div class="metric metric-' + cls + '"' + (title ? ' title="' + LG.esc(title) + '"' : '') + '>' +
        '<div class="mk">' + k + '</div>' +
        '<div class="mv ' + cls + '">' + v + '</div>' +
        '<div class="metric-bar">' +
          '<div class="metric-bar-zone bad"></div>' +
          '<div class="metric-bar-zone warn"></div>' +
          '<div class="metric-bar-zone ok"></div>' +
          '<div class="metric-bar-mark" style="left:' + barPct + '%"></div>' +
        '</div></div>';
    }

    /** 值越大越好时 invert=false；uni 用 invert（Emin/Eavg 越大越好） */
    function level(v, warnAt, okAt, biggerBetter) {
      var ok = biggerBetter ? v >= okAt : v <= okAt;
      var warn = biggerBetter ? v >= warnAt : v <= warnAt;
      return ok ? 'ok' : (warn ? 'warn' : 'bad');
    }
    function metric(k, v, cls) {
      return '<div class="metric"><div class="mk">' + k + '</div><div class="mv ' + cls + '">' + v + '</div></div>';
    }

    function refreshCompare() {
      var body = $('a-cmp-body');
      var id = $('a-cmp-sel').value;
      if (!id) { body.innerHTML = '<div class="hint">' + LG.t('ana.cmp.none') + '</div>'; return; }
      var m = null;
      var arr = LG.state.project.measurements;
      for (var i = 0; i < arr.length; i++) if (arr[i].id === id) { m = arr[i]; break; }
      var d = currentData();
      if (!m || !d || !d.agg) { body.innerHTML = '<div class="hint">' + LG.t('ana.cmp.none') + '</div>'; return; }

      var sim = LG.Charts.computeMetrics(d.agg.heatmap, threshold());
      var rows = [
        [LG.t('ana.m.avg'), sim.avg, m.avg],
        [LG.t('ana.m.uni'), sim.uniformity, m.uniformity],
        [LG.t('ana.m.cv'), sim.cv, m.cv]
      ];
      var html = '<table class="tbl"><thead><tr>' +
        '<th>' + LG.t('ana.cmp.metric') + '</th><th>' + LG.t('ana.cmp.sim') + '</th>' +
        '<th>' + LG.t('ana.cmp.meas') + '</th><th>' + LG.t('ana.cmp.dev') + '</th></tr></thead><tbody>';
      for (var r = 0; r < rows.length; r++) {
        var name = rows[r][0], sv = rows[r][1], mv = rows[r][2];
        var dev = (mv != null && mv !== 0) ? ((sv - mv) / Math.abs(mv) * 100) : null;
        html += '<tr><td>' + name + '</td><td class="num">' + fmt(sv) + '</td><td class="num">' + fmt(mv) + '</td>' +
          '<td class="num">' + (dev != null ? (dev > 0 ? '+' : '') + dev.toFixed(1) + '%' : '-') + '</td></tr>';
      }
      html += '</tbody></table>';
      body.innerHTML = html;
    }
    function fmt(v) { return (v == null || isNaN(v)) ? '-' : Number(v).toFixed(3); }
  }

  window.LG = window.LG || {};
  LG.Modules = LG.Modules || {};
  LG.Modules.analysis = { render: render, buildConclusion: buildConclusion, engStats: engStats };
})();
