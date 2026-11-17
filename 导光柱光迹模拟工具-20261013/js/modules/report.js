/**
 * LG.Modules.report — 报告生成页
 * 记录多选 + 3D 截图 + 报告语言（跟随界面/zh/en）→ 独立可打印 HTML（内嵌 iframe 预览 + 下载）
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var lastHtml = null;

  function render(el) {
    var p = LG.state.project;

    el.innerHTML =
      '<div class="page-title">' + LG.t('rpt.title') + '</div>' +
      '<div class="layout">' +
        '<div>' +
          '<div class="card">' +
            '<div class="card-title">' + LG.t('rpt.opt') + '</div>' +
            '<div class="card-body card-open">' +
              '<div class="field"><label>' + LG.t('rpt.opt.records') + '</label>' +
                '<div class="item-list" id="rp-recs" style="max-height:220px;overflow:auto"></div></div>' +
              '<div class="checkline"><input type="checkbox" id="rp-shot"><label for="rp-shot" style="margin:0">' + LG.t('rpt.opt.shot') + '</label></div>' +
              '<div class="field"><label>' + LG.t('rpt.opt.tpl') + '</label>' +
                '<select id="rp-tpl">' +
                  '<option value="dfm">' + LG.t('rpt.tpl.dfm') + '</option>' +
                  '<option value="optical">' + LG.t('rpt.tpl.optical') + '</option>' +
                '</select>' +
                '<div class="hint" id="rp-tpl-desc"></div></div>' +
              '<div class="field" style="margin-bottom:0"><label>' + LG.t('rpt.opt.lang') + '</label>' +
                '<select id="rp-lang">' +
                  '<option value="follow">' + LG.t('rpt.opt.follow') + '</option>' +
                  '<option value="zh">简体中文</option>' +
                  '<option value="en">English</option>' +
                '</select></div>' +
            '</div>' +
          '</div>' +
          '<div class="card">' +
            '<div class="card-title">' + LG.t('model.viewer') + '</div>' +
            '<div class="card-body card-open">' +
              '<div class="viewer-slot" id="rp-viewer" style="height:220px"></div>' +
              '<div class="hint" id="rp-geo-hint"></div>' +
            '</div>' +
          '</div>' +
          '<div class="btn-row" style="margin-bottom:16px">' +
            '<button id="rp-gen" class="btn btn-primary">' + LG.t('rpt.generate') + '</button>' +
            '<button id="rp-dl" class="btn btn-ghost" disabled>' + LG.t('rpt.download') + '</button>' +
            '<button id="rp-print" class="btn btn-ghost" disabled>' + LG.t('c.print') + '</button>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div class="card" style="height:calc(100vh - 150px);display:flex;flex-direction:column">' +
            '<div class="card-title">' + LG.t('rpt.generate') + '</div>' +
            '<div class="card-body card-open" style="flex:1;max-height:none;overflow:hidden;display:flex">' +
              '<iframe id="rp-frame" style="flex:1;width:100%;border:1px solid var(--line);border-radius:10px;background:#fff"></iframe>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="card" style="margin-top:4px">' +
        '<div class="card-title">' + LG.t('rpt.history') +
          '<button id="rp-hist-delall" class="btn btn-danger btn-sm" style="margin-left:auto;padding:4px 12px;font-size:12px">' + LG.t('rpt.history.delAll') + '</button>' +
        '</div>' +
        '<div class="card-body card-open">' +
          '<div id="rp-hist"></div>' +
        '</div>' +
      '</div>';

    // ---- 记录多选 ----
    var box = $('rp-recs');
    var recs = p.records;
    if (!recs.length) {
      box.innerHTML = '<div class="hint">' + LG.t('prj.rec.empty') + '</div>';
    } else {
      var html = '';
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        html += '<label class="item" style="justify-content:flex-start;cursor:pointer">' +
          '<input type="checkbox" class="rp-rec-cb" value="' + r.id + '"' + (i === 0 ? ' checked' : '') + ' style="flex:none">' +
          '<div style="flex:1"><div class="name">' + recordLabel(r) + '</div></div></label>';
      }
      box.innerHTML = html;
    }

    // ---- 报告模板 ----
    function syncTplDesc() {
      var v = $('rp-tpl').value;
      $('rp-tpl-desc').textContent = LG.t(v === 'dfm' ? 'rpt.tpl.desc.dfm' : 'rpt.tpl.desc.optical');
    }
    $('rp-tpl').addEventListener('change', syncTplDesc);
    syncTplDesc();

    // ---- 3D 视图（截图用） ----
    if (LG.Viewer.hasGeometry()) {
      LG.Viewer.mount($('rp-viewer'));
      LG.Viewer.setFaceHighlights(p.faces.input, p.faces.output);
    } else {
      $('rp-shot').disabled = true;
      $('rp-geo-hint').textContent = LG.t('c.needGeometry');
    }

    $('rp-gen').addEventListener('click', generate);
    $('rp-dl').addEventListener('click', function () {
      if (lastHtml) LG.download('light-guide-report-' + new Date().toISOString().slice(0, 10) + '.html', lastHtml);
    });
    $('rp-print').addEventListener('click', function () {
      var f = $('rp-frame');
      try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { LG.status('Print blocked'); }
    });

    // ---- 任务历史 ----
    renderHistory();
    $('rp-hist-delall').addEventListener('click', function () {
      if (!p.records.length) return;
      if (!confirm(LG.t('rpt.history.confirmDelAll'))) return;
      // 逐条删除（不直接清空数组，走 Store 接口以持久化）
      var ids = p.records.map(function (r) { return r.id; });
      ids.forEach(function (id) { LG.Store.removeRecord(id); });
      p.records = [];
      renderHistory();
      rerenderRecs();
      LG.status(LG.t('rpt.history.delAll') + ' OK');
    });
    $('rp-hist').addEventListener('click', function (e) {
      var del = e.target.closest('[data-hist-del]');
      if (del) {
        if (!confirm(LG.t('rpt.history.confirmDel'))) return;
        LG.Store.removeRecord(del.getAttribute('data-hist-del'));
        p.records = LG.state.project.records;
        renderHistory();
        rerenderRecs();
      }
    });

    function rerenderRecs() {
      // 同步刷新报告选项中的记录多选列表
      var box2 = $('rp-recs');
      var recs2 = p.records;
      if (!recs2.length) {
        box2.innerHTML = '<div class="hint">' + LG.t('prj.rec.empty') + '</div>';
      } else {
        var h2 = '';
        for (var i = 0; i < recs2.length; i++) {
          var r2 = recs2[i];
          h2 += '<label class="item" style="justify-content:flex-start;cursor:pointer">' +
            '<input type="checkbox" class="rp-rec-cb" value="' + r2.id + '"' + (i === 0 ? ' checked' : '') + ' style="flex:none">' +
            '<div style="flex:1"><div class="name">' + recordLabel(r2) + '</div></div></label>';
        }
        box2.innerHTML = h2;
      }
    }

    function renderHistory() {
      var hist = $('rp-hist');
      var recs = p.records;
      if (!recs.length) {
        hist.innerHTML = '<div class="hint" style="text-align:center;padding:24px 0">' + LG.t('rpt.history.empty') + '</div>';
        return;
      }
      var h = '<div class="hist-grid">';
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        var d = new Date(r.time);
        var pad = function (x) { return (x < 10 ? '0' : '') + x; };
        var timeStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
          ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        var dur = r.summary.elapsedMs != null ? r.summary.elapsedMs : '-';
        var thumbHtml = r.thumb
          ? '<img src="' + r.thumb + '" class="hist-thumb-img" alt="preview">'
          : '<div class="hist-thumb-empty">' + LG.t('rpt.history.noThumb') + '</div>';
        h += '<div class="hist-item">' +
          '<div class="hist-thumb">' + thumbHtml + '</div>' +
          '<div class="hist-meta">' +
            '<div class="hist-time">' + timeStr + '</div>' +
            '<div class="hist-stats">' +
              '<span>' + LG.t('rpt.history.rays', r.summary.total) + '</span>' +
              '<span>' + LG.t('rpt.history.rate', r.summary.successRate) + '</span>' +
              '<span>' + LG.t('rpt.history.duration', dur) + '</span>' +
            '</div>' +
          '</div>' +
          '<button class="btn btn-danger btn-sm hist-del" data-hist-del="' + r.id + '" title="' + LG.t('c.delete') + '">✕</button>' +
        '</div>';
      }
      h += '</div>';
      hist.innerHTML = h;
    }

    return function cleanup() {
      if (LG.Viewer.hasGeometry()) LG.Viewer.unmount();
    };

    // ================= functions =================
    function recordLabel(rec) {
      var d = new Date(rec.time);
      var pad = function (x) { return (x < 10 ? '0' : '') + x; };
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) +
        ' · ' + rec.summary.total + ' rays · ' + rec.summary.successRate + '%';
    }

    function selectedRecords() {
      var cbs = document.querySelectorAll('.rp-rec-cb:checked');
      var out = [];
      for (var i = 0; i < cbs.length; i++) {
        var r = LG.Store.getRecord(cbs[i].value);
        if (r) out.push(r);
      }
      return out;
    }

    function generate() {
      var list = selectedRecords();
      if (!list.length) { LG.status(LG.t('rpt.noRec')); return; }

      var langOpt = $('rp-lang').value;
      var tr = langOpt === 'follow' ? LG.t : LG.I18N.tFor(langOpt);
      var tpl = $('rp-tpl').value;
      var wantShot = $('rp-shot').checked && LG.Viewer.hasGeometry();
      var shotData = wantShot ? LG.Viewer.screenshot() : null;

      // 离屏 canvas 渲染图表
      var holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(holder);
      function chartCanvas(w, h) {
        var c = document.createElement('canvas');
        c.style.width = w + 'px'; c.style.height = h + 'px';
        holder.appendChild(c);
        return c;
      }

      var p0 = LG.state.project;
      var today = new Date().toISOString().slice(0, 10);
      var H = [];
      H.push('<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(tr('rpt.doc.title')) + '</title>');
      H.push('<style>' + reportCSS() + '</style></head><body><div class="doc">');
      H.push('<div class="doc-head"><h1>' + esc(tr('rpt.doc.title')) + '</h1>' +
        '<div class="sub">' + esc(today) + '</div></div>');

      // 项目信息
      H.push('<h2>' + esc(tr('rpt.doc.info')) + '</h2><table>');
      H.push(row(tr('rpt.doc.project'), esc(p0.name)));
      H.push(row(tr('rpt.doc.date'), today));
      H.push(row(tr('rpt.doc.geometry'), esc(geoText(list[0].params, tr))));
      H.push(row(tr('rpt.doc.material'),
        esc(materialName(list[0].params, tr)) + ' · ' + esc(tr('rpt.doc.n')) + ' ' + list[0].params.n +
        ' · ' + esc(tr('rpt.doc.alpha')) + ' ' + list[0].params.alpha));
      H.push(row(tr('rpt.doc.source'),
        esc(tr('model.src.mode.' + list[0].params.emissionMode)) + ' · ' +
        esc(tr('rpt.doc.flux')) + ' ' + list[0].params.flux + ' · ' +
        esc(tr('rpt.doc.rays')) + ' ' + list[0].params.numRays));
      if (tpl === 'dfm') {
        var sc = p0.scheme || {}, en = p0.eng || {};
        H.push(row(tr('rpt.doc.scheme'), esc(tr('model.scheme.' + (sc.type || 'straight'))) +
          (sc.type === 'bent' ? ' · ' + esc(tr('model.scheme.bendAngle')) + ' ' + (sc.bendAngle || 90) + '° / R' + (sc.bendR || 3) + 'mm' : '')));
        H.push(row(tr('rpt.doc.ledModel'), esc(tr('ledlib.' + (en.ledModel || 'none'))) +
          (en.ledLevel ? ' · ' + esc(tr('ledlevel.' + en.ledLevel)) : '')));
        H.push(row(tr('rpt.doc.gap'), ((en.assemblyGap != null ? en.assemblyGap : 0)).toFixed(2) + ' mm'));
        H.push(row(tr('rpt.doc.materialLib'), esc(tr('matlib.' + (en.material || 'pmma')))));
        H.push(row(tr('rpt.doc.env'), esc(tr('env.housing.' + (en.housing || 'black'))) +
          (en.foam ? ' · ' + esc(tr('model.env.foam')) : '')));
      }
      H.push('</table>');

      if (shotData) {
        H.push('<h2>3D</h2><img src="' + shotData + '">');
      }

      if (tpl === 'dfm') {
        // 风险清单（项目级结构预审）
        H.push('<h2>' + esc(tr('rpt.doc.risk')) + '</h2>');
        var risks = dfmRisks(p0, tr);
        H.push(risks.length
          ? '<ul>' + risks.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
          : '<p>' + esc(tr('rpt.risk.none')) + '</p>');
      }

      // 光斑云图：跟随第一条所选记录（最新记录用完整出射光线云图，历史记录仅存端面热图，退化为热图）
      var firstRec = list[0];
      var lr = LG.state.lastRun;
      var isLatest = !!(lr && firstRec.agg && firstRec.agg === lr.agg);
      if (isLatest && LG.Modules.spot && LG.Modules.spot.capture) {
        var spotC = chartCanvas(640, 460);
        var spotProj = LG.Modules.spot.capture(spotC);
        if (spotProj) {
          H.push('<h2>' + esc(tr('rpt.doc.spot')) + '</h2>');
          H.push('<img src="' + spotC.toDataURL('image/png') + '">');
          var uniL = spotProj.metrics.uniformity >= 0.70 ? 'ok' : (spotProj.metrics.uniformity >= 0.50 ? 'warn' : 'bad');
          H.push('<table>' +
            row(tr('spot.plane'), tr('spot.plane.exit')) +
            row(tr('spot.v.uni'), tr('spot.v.uni.' + uniL)) +
            row(tr('spot.v.pass'), (spotProj.metrics.passRatio * 100).toFixed(1) + '%') +
            row(tr('spot.v.util'), (spotProj.util * 100).toFixed(1) + '%') +
            row(tr('spot.v.bright'), spotProj.outLm.toFixed(1) + ' lm') +
            '</table>');
        }
      } else if (firstRec.agg && firstRec.agg.heatmap) {
        var spotC = chartCanvas(640, 360);
        LG.Charts.drawHeatmap(spotC, firstRec.agg.heatmap);
        var spotM = LG.Charts.computeMetrics(firstRec.agg.heatmap, 0.8);
        var spotL = firstRec.ledger || {};
        var spotSum = (spotL.output || 0) + (spotL.side || 0) + (spotL.absorbed || 0) + (spotL.residual || 0) || 1;
        var spotUtil = (spotL.output || 0) / spotSum;
        var spotFlux = (firstRec.params && firstRec.params.flux) || (p0.source && p0.source.flux) || 683;
        H.push('<h2>' + esc(tr('rpt.doc.spot')) + '</h2>');
        H.push('<img src="' + spotC.toDataURL('image/png') + '">');
        var uniL2 = spotM.uniformity >= 0.70 ? 'ok' : (spotM.uniformity >= 0.50 ? 'warn' : 'bad');
        H.push('<table>' +
          row(tr('spot.plane'), tr('spot.plane.exit')) +
          row(tr('spot.v.uni'), tr('spot.v.uni.' + uniL2)) +
          row(tr('spot.v.pass'), (spotM.passRatio * 100).toFixed(1) + '%') +
          row(tr('spot.v.util'), (spotUtil * 100).toFixed(1) + '%') +
          row(tr('spot.v.bright'), (spotFlux * spotUtil).toFixed(1) + ' lm') +
          '</table>');
      }

      // 每条记录
      for (var k = 0; k < list.length; k++) {
        var rec = list[k];
        var s = rec.summary;
        var m = LG.Charts.computeMetrics(rec.agg.heatmap, 0.8);
        var st = LG.Modules.analysis.engStats(rec, m, p0);
        H.push('<h2>#' + (k + 1) + ' · ' + esc(recordLabel(rec)) + '</h2>');

        var L = rec.ledger || {};
        var sum = (L.output || 0) + (L.side || 0) + (L.absorbed || 0) + (L.residual || 0) || 1;
        var util = (L.output || 0) / sum;
        var flux = (rec.params && rec.params.flux) || p0.source.flux || 683;

        if (tpl === 'dfm') {
          // 工程指标（结构语言）
          H.push('<h3>' + esc(tr('rpt.doc.metrics')) + '</h3><table>');
          H.push(row(tr('ana.e.flux'), (util * 100).toFixed(1) + '%'));
          H.push(row(tr('ana.e.uni'), m.uniformity.toFixed(3)));
          H.push(row(tr('ana.e.peak'), m.max.toFixed(3)));
          H.push(row(tr('ana.e.total'), (flux * util).toFixed(1) + ' lm'));
          H.push('</table>');
          // 公差建议
          H.push('<h3>' + esc(tr('rpt.doc.tol')) + '</h3>' + toleranceTable(rec, tr));
          // 结论（与结果分析页完全同口径）
          H.push('<h3>' + esc(tr('rpt.doc.conclusion')) + '</h3>' +
            LG.Modules.analysis.buildConclusion(rec, st, p0, tr));
        } else {
          // 能量账本
          H.push('<h3>' + esc(tr('rpt.doc.ledger')) + '</h3><table>');
          H.push(row(tr('sim.ledger.output'), pct(L.output, sum)));
          H.push(row(tr('sim.ledger.side'), pct(L.side, sum)));
          H.push(row(tr('sim.ledger.absorbed'), pct(L.absorbed, sum)));
          H.push(row(tr('sim.ledger.residual'), pct(L.residual, sum)));
          H.push('</table>');

          // 指标
          H.push('<h3>' + esc(tr('rpt.doc.metrics')) + '</h3><table>');
          H.push(row(tr('sim.total'), s.total));
          H.push(row(tr('sim.success'), s.success));
          H.push(row(tr('sim.rate'), s.successRate + '%'));
          H.push(row(tr('sim.avg'), s.avgOutputIntensity));
          H.push(row(tr('ana.m.uni'), m.uniformity.toFixed(3)));
          H.push(row(tr('ana.m.cv'), m.cv.toFixed(3)));
          H.push(row(tr('ana.m.pass'), (m.passRatio * 100).toFixed(1) + '%'));
          H.push('</table>');

          // 图表
          H.push('<h3>' + esc(tr('rpt.doc.charts')) + '</h3>');
          var c1 = chartCanvas(640, 360);
          LG.Charts.drawHeatmap(c1, rec.agg.heatmap);
          H.push('<h4>' + esc(tr('rpt.doc.heat')) + '</h4><img src="' + c1.toDataURL('image/png') + '">');
          var c2 = chartCanvas(520, 260);
          LG.Charts.drawLineChart(c2, rec.agg.axis.values,
            { min: rec.agg.axis.min, max: rec.agg.axis.max, xLabel: tr('ana.axisPos'), yLabel: tr('ana.energy') });
          H.push('<h4>' + esc(tr('rpt.doc.axis')) + '</h4><img src="' + c2.toDataURL('image/png') + '">');
          var c3 = chartCanvas(420, 300);
          LG.Charts.drawPolar(c3, rec.agg.angle);
          H.push('<h4>' + esc(tr('rpt.doc.polar')) + '</h4><img src="' + c3.toDataURL('image/png') + '">');

          // 结论（与结果分析页完全同口径）
          H.push('<h3>' + esc(tr('rpt.doc.conclusion')) + '</h3>' +
            LG.Modules.analysis.buildConclusion(rec, st, p0, tr));
        }
      }

      H.push('<p class="print-hint">' + esc(tr('rpt.doc.printHint')) + '</p>');
      H.push('</div></body></html>');
      document.body.removeChild(holder);

      lastHtml = H.join('\n');
      $('rp-frame').srcdoc = lastHtml;
      $('rp-dl').disabled = false;
      $('rp-print').disabled = false;
      LG.status(LG.t('rpt.generate') + ' OK');
    }

    /** 结构风险清单：与模型页「生成几何 + 预检查」同口径 */
    function dfmRisks(p0, tr) {
      var g = p0.geometry || {}, sc = p0.scheme || {}, en = p0.eng || {};
      var d1 = Math.max(0.05, +g.d1 || 3), d2 = Math.max(0.05, +g.d2 || 3);
      var L = Math.max(0.5, +g.length || 30);
      var lib = (LG.LED_LIB || {})[en.ledModel];
      var scheme = sc.type || 'straight';
      var out = [];
      if ((scheme === 'bent' || scheme === 'plate') && !g.fileName) out.push(tr('pc.needImport'));
      if (lib) {
        var emit = Math.max(lib.length, lib.width);
        if (d1 < emit) out.push(tr('pc.ledTooBig', d1.toFixed(2), emit.toFixed(1)));
      }
      var ratio = d2 / d1;
      if (ratio > 1.5 || ratio < 0.667) out.push(tr('pc.taperBig', ratio.toFixed(2)));
      if (scheme === 'bent') {
        var R = +sc.bendR || 3;
        if (R < d1) out.push(tr('pc.bendR', R.toFixed(1)));
      }
      if (scheme !== 'plate') {
        var dr = +sc.draftAngle;
        if (!(dr >= 1)) out.push(tr('pc.draft', (dr || 0).toFixed(1)));
        var sl = L / d1;
        if (sl > 15) out.push(tr('pc.slender', sl.toFixed(1)));
      }
      // 侧壁漏光仅对多灯珠 / 多根导光柱判断；单根导光柱不判断漏光
      var multiGuide = ((p0.beads || []).length > 1) || LG.Store.list().length > 1;
      if (multiGuide && en.housing === 'black' && !en.foam) out.push(tr('pc.leak'));
      if (en.housing === 'white' && en.targets && en.targets.crosstalk) out.push(tr('pc.whiteCross'));
      return out;
    }

    /** 公差-亮度衰减表 + CTQ 建议 */
    function toleranceTable(rec, tr) {
      var arr = rec.tolerance;
      if (!arr || !arr.length) return '<p class="concl">' + esc(tr('rpt.tol.none')) + '</p>';
      var h = '<table><tr><th>' + esc(tr('rpt.tol.offset')) + '</th><th>' +
        esc(tr('rpt.tol.bright')) + '</th><th>' + esc(tr('rpt.tol.drop')) + '</th></tr>';
      var accept = null;
      for (var i = 0; i < arr.length; i++) {
        var bv = Number(arr[i].brightness);
        h += '<tr><td>' + Number(arr[i].offset).toFixed(1) + '</td><td>' +
          (arr[i].brightness != null && isFinite(bv) ? bv.toFixed(2) : '—') + '</td><td>−' +
          Number(arr[i].drop).toFixed(0) + '%</td></tr>';
        if (arr[i].drop <= 30) accept = arr[i];
      }
      h += '</table>';
      h += '<p class="concl">' + esc(accept
        ? tr('rpt.tol.ok', Number(accept.offset).toFixed(1))
        : tr('rpt.tol.bad', Number(arr[0].offset).toFixed(1), Number(arr[0].drop).toFixed(0))) + '</p>';
      return h;
    }

    /** 结构语言结论：按亮度 / 均匀性 / 漏光取最差等级 */
    function dfmVerdict(rec, util, m, tr) {
      var lvB = util >= 0.30 ? 'ok' : (util >= 0.18 ? 'warn' : 'bad');
      var lvU = m.uniformity >= 0.70 ? 'ok' : (m.uniformity >= 0.50 ? 'warn' : 'bad');
      var leak = 1 - util;
      var lvL = leak <= 0.05 ? 'ok' : (leak <= 0.15 ? 'warn' : 'bad');
      var proj = LG.state.project || {};
      // 侧壁漏光仅对多灯珠 / 多根导光柱判断；单根导光柱不判断漏光
      var multi = ((proj.beads || []).length > 1) || LG.Store.list().length > 1;
      var rank = { ok: 0, warn: 1, bad: 2 };
      var lv = 'ok';
      var levels = [lvB];
      // 「明显暗斑」不展示结论、参数与建议
      if (lvU !== 'bad') levels.push(lvU);
      if (multi) levels.push(lvL);
      levels.forEach(function (x) { if (rank[x] > rank[lv]) lv = x; });
      var parts = [
        tr('ana.cl.bright.' + lvB, (util * 100).toFixed(1), Math.max(0, (util / 0.3 - 1) * 100).toFixed(0))
      ];
      if (lvU !== 'bad') parts.push(tr('ana.cl.uni.' + lvU, m.uniformity.toFixed(3)));
      if (multi) parts.push(tr('ana.cl.leak.' + lvL, (leak * 100).toFixed(1)));
      return tr('ana.cl.sum.' + lv) + ' · ' + parts.join('；') + '。';
    }

    function geoText(params, tr) {
      var g = params.geometry || {};
      var txt;
      if (g.fileName) txt = tr('rpt.doc.geo.file', g.fileName);
      else if (g.shape === 'cone') txt = tr('rpt.doc.geo.cone', g.d1, g.d2, g.length);
      else txt = tr('rpt.doc.geo.cyl', g.d1, g.length);
      if (g.teeth && g.teeth.enabled) txt += tr('rpt.doc.geo.teeth');
      return txt;
    }
    /** 材质显示名：优先用记录中的 preset，老记录按 n/α 反查预设表 */
    function materialName(params, tr) {
      var byPreset = { '1.586,0.40': 'pc', '1.49,0.10': 'pmma', '1.59,0.30': 'ps', '1.575,0.35': 'pet', '1.533,0.08': 'coc', '1.517,0.01': 'bk7' };
      var key = byPreset[params.materialPreset];
      if (!key) {
        var byNA = { '1.586,0.4': 'pc', '1.49,0.1': 'pmma', '1.59,0.3': 'ps', '1.575,0.35': 'pet', '1.533,0.08': 'coc', '1.517,0.01': 'bk7' };
        key = byNA[params.n + ',' + params.alpha] || 'custom';
      }
      return tr('model.mat.name.' + key);
    }
    function pct(v, sum) {
      return ((v || 0) / sum * 100).toFixed(1) + '%';
    }
    function row(k, v) {
      return '<tr><th style="width:32%">' + k + '</th><td>' + v + '</td></tr>';
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function reportCSS() {
      return 'body{font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#1e293b;margin:0;background:#fff}' +
        '.doc{max-width:820px;margin:0 auto;padding:32px 24px;font-size:13.5px;line-height:1.55}' +
        '.doc-head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid #0284C7;padding-bottom:10px}' +
        'h1{font-size:22px;margin:0}h2{font-size:16px;margin:26px 0 10px;padding-bottom:6px;border-bottom:2px solid #0284C7}' +
        'h3{font-size:14px;margin:16px 0 6px}h4{font-size:12.5px;margin:12px 0 4px;color:#475569}' +
        '.sub{color:#64748B;font-size:13px}' +
        'table{width:100%;border-collapse:collapse;margin:8px 0}' +
        'th,td{border:1px solid #E2E8F0;padding:6px 10px;text-align:left}' +
        'th{background:#E0F2FE;font-weight:600}' +
        'img{max-width:100%;border:1px solid #E2E8F0;border-radius:8px;margin:4px 0}' +
        '.concl{background:#F8FAFC;border-left:3px solid #0284C7;padding:10px 14px;border-radius:0 8px 8px 0}' +
        '.verdict-card{display:flex;gap:14px;align-items:center;border-radius:12px;padding:14px 18px;margin:8px 0 14px;border:1px solid}' +
        '.verdict-ok{background:rgba(22,163,74,.08);border-color:rgba(22,163,74,.35)}' +
        '.verdict-warn{background:rgba(217,119,6,.08);border-color:rgba(217,119,6,.35)}' +
        '.verdict-bad{background:rgba(220,38,38,.08);border-color:rgba(220,38,38,.35)}' +
        '.verdict-badge{flex:none;width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;text-align:center;line-height:1.2}' +
        '.verdict-ok .verdict-badge{background:#16A34A}.verdict-warn .verdict-badge{background:#D97706}.verdict-bad .verdict-badge{background:#DC2626}' +
        '.verdict-body{flex:1;min-width:0}.verdict-items{display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:6px}' +
        '.vi{font-size:12.5px;display:inline-flex;align-items:center;gap:4px}.vi b{font-size:14px}' +
        '.vi-ok{color:#16A34A}.vi-warn{color:#D97706}.vi-bad{color:#DC2626}' +
        '.verdict-advice{font-size:12.5px;color:#1e293b;line-height:1.6}' +
        '.print-hint{color:#94A3B8;font-size:12px;margin-top:28px;border-top:1px solid #E2E8F0;padding-top:8px}' +
        '@media print{.print-hint{display:none}body{margin:0}.doc{padding:0}}';
    }
  }

  window.LG = window.LG || {};
  LG.Modules = LG.Modules || {};
  LG.Modules.report = { render: render };
})();
