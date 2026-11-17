/**
 * LG.Modules.simulate — 仿真计算页
 * 左栏：端面设定（逐颗灯珠配置：增加/移除/拾取入射面+出射面 / 自动检测 / 交换 / 清除）+ 仿真选项；右侧：3D 视图 + 进度 + 结果浮动面板（含能量账本）
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var LEDGER_COLORS = {
    output:   { color: '#22c55e', key: 'sim.ledger.output' },
    side:     { color: '#f59e0b', key: 'sim.ledger.side' },
    absorbed: { color: '#94a3b8', key: 'sim.ledger.absorbed' },
    residual: { color: '#ef4444', key: 'sim.ledger.residual' }
  };

  function render(el) {
    var dead = false;      // 路由切换后不再触碰 DOM
    var running = false;
    var pickBtn = null;
    // 仿真模式：quick = 快速预览（秒级光路），precise = 精确评估（定量报告）
    var simMode = localStorage.getItem('lgv.simMode') === 'precise' ? 'precise' : 'quick';
    // 快速预览的采样块：光线数越少，出射端光斑的蒙特卡洛颗粒越重、与精准评估差异越大。
    // 1600 条 + 40 次反弹在保持秒级响应的同时，让预览光斑形态与精准评估基本一致
    // （低样本时 spot.js 另有 sqrt(NREF/N) 自适应平滑）。
    var QUICK_RAYS = 1600, QUICK_BOUNCES = 40;
    var tolOn = localStorage.getItem('lgv.simTol') !== '0';

    el.innerHTML =
      '<div class="page-title">' + LG.t('sim.title') + '</div>' +
      '<div class="layout">' +
        '<div>' +
          '<div class="card">' +
            '<div class="card-title">' + LG.t('sim.mode.card') + '</div>' +
            '<div class="seg-tabs" style="margin-bottom:10px">' +
              '<button class="seg-tab" data-sim-mode="quick">' + LG.t('sim.mode.quick') + '</button>' +
              '<button class="seg-tab" data-sim-mode="precise">' + LG.t('sim.mode.precise') + '</button>' +
            '</div>' +
            '<div class="hint" id="s-mode-hint"></div>' +
            '<div class="checkline" style="margin-top:12px"><input type="checkbox" id="s-tol">' +
              '<label for="s-tol" style="margin:0">' + LG.t('sim.tol') + '</label></div>' +
            '<div class="hint" id="s-tol-hint"></div>' +
            '<button id="s-run" class="btn btn-primary btn-block" style="margin-top:12px">' + LG.t('sim.start') + '</button>' +
            '<div id="s-progress-wrap" style="display:none;margin-top:10px">' +
              '<div class="progress"><div id="s-progress-bar"></div></div>' +
              '<div class="hint" id="s-progress-txt"></div>' +
            '</div>' +
          '</div>' +
          '<div class="card">' +
            '<div class="card-title">' + LG.t('sim.faces') + '</div>' +
            '<div class="hint" style="margin:0 0 10px">' + LG.t('sim.beadHint') + '</div>' +
            '<div id="s-bead-list"></div>' +
            '<button id="s-add-bead" class="btn btn-ghost btn-sm btn-block" style="margin-top:8px">' + LG.t('sim.addBead') + '</button>' +
            '<div class="btn-row" style="margin-top:8px">' +
              '<button id="s-auto" class="btn btn-ghost btn-sm">' + LG.t('c.autoFaces') + '</button>' +
              '<button id="s-swap" class="btn btn-ghost btn-sm">' + LG.t('c.swap') + '</button>' +
            '</div>' +
            '<button id="s-clear" class="btn btn-danger btn-sm btn-block" style="margin-top:8px">' + LG.t('c.clearSel') + '</button>' +
            '<div class="hint" id="s-face-status" style="margin-top:10px;font-weight:600;color:var(--ink)"></div>' +
          '</div>' +
          '<div class="card collapsed" data-reset="simopt">' +
            '<div class="card-title">' + LG.t('sim.adv') + '</div>' +
            '<div class="field"><label>' + LG.t('model.src.rays') + '</label>' +
              '<div class="input-slider"><input type="range" id="s-rays-r" min="10" max="20000" step="10">' +
              '<input type="number" id="s-rays" min="10" max="200000" step="100"></div></div>' +
            '<div class="checkline" style="margin-top:2px"><input type="checkbox" id="s-spotsec">' +
              '<label for="s-spotsec" style="margin:0">' + LG.t('sim.spotSec') + '</label></div>' +
            '<div class="hint" style="margin-top:6px">' + LG.t('sim.spotSec.hint') + '</div>' +
            '<div class="hint" id="s-opt-hint"></div>' +
          '</div>' +
        '</div>' +
        '<div class="stage">' +
          '<div class="viewer-slot" id="sim-viewer"></div>' +
          '<div class="stage-badge" id="s-mode-badge"></div>' +
          '<div class="results-float" id="s-results" style="display:none"></div>' +
        '</div>' +
      '</div>';

    // ---- 初始化控件 ----
    // 仿真模式 / 公差扫参
    el.querySelectorAll('[data-sim-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        simMode = b.getAttribute('data-sim-mode');
        localStorage.setItem('lgv.simMode', simMode);
        syncModeUI();
      });
    });
    $('s-tol').checked = tolOn;
    $('s-tol').addEventListener('change', function () {
      tolOn = $('s-tol').checked;
      localStorage.setItem('lgv.simTol', tolOn ? '1' : '0');
      syncModeUI();
    });
    syncModeUI();

    // 出射光斑截面开关（探测屏固定在导光柱出射端端面，屏距与网格不可调，
    // 与「光斑分析」页、报告截图共用同一口径，避免调参改变投影影响判断）
    $('s-spotsec').checked = (localStorage.getItem('lgv.spotSec') !== '0');
    $('s-spotsec').addEventListener('change', function () {
      localStorage.setItem('lgv.spotSec', $('s-spotsec').checked ? '1' : '0');
      if (!$('s-spotsec').checked) LG.Viewer.clearSpotSection();
      else showSpotSectionFrom();
    });
    // 光线数控件：调整后实时保存并自动重跑（debounce）
    var rays0 = LG.state.project.source.numRays || 1000;
    $('s-rays').value = rays0; $('s-rays-r').value = Math.min(20000, rays0);
    var raysTimer = null;
    function onRaysInput(fromRange) {
      if (fromRange) $('s-rays').value = $('s-rays-r').value;
      else $('s-rays-r').value = Math.min(20000, Math.max(10, parseInt($('s-rays').value) || 10));
      var v = Math.max(10, parseInt($('s-rays').value) || 1000);
      LG.Store.updateActive({ source: Object.assign({}, LG.state.project.source, { numRays: v }) });
      updateOptHint();
      clearTimeout(raysTimer);
      raysTimer = setTimeout(function () {
        if (!dead && LG.state.mesh && LG.Viewer.hasGeometry() &&
            LG.state.project.faces.input.length && LG.state.project.faces.output.length) {
          runSim();
        }
      }, 700);
    }
    $('s-rays-r').addEventListener('input', function () { onRaysInput(true); });
    $('s-rays').addEventListener('input', function () { onRaysInput(false); });
    updateOptHint();
    renderBeadList();
    updateFaceStatus();

    // ---- 卡片可收起 + 恢复默认 ----
    (function enhanceCards() {
      el.querySelectorAll('.card').forEach(function (card) {
        var title = card.querySelector(':scope > .card-title');
        if (!title) return;
        var body = document.createElement('div');
        body.className = 'card-body';
        while (title.nextSibling) body.appendChild(title.nextSibling);
        card.appendChild(body);
        var chev = document.createElement('span');
        chev.className = 'chev';
        title.appendChild(chev);
        title.addEventListener('click', function () { card.classList.toggle('collapsed'); });
        if (card.getAttribute('data-reset') === 'simopt') {
          var foot = document.createElement('div');
          foot.className = 'card-foot';
          var btn = document.createElement('button');
          btn.className = 'reset-btn';
          btn.textContent = '↺ ' + LG.t('c.resetDefault');
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            $('s-rays').value = 1000; $('s-rays-r').value = 1000;
            LG.Store.updateActive({ source: Object.assign({}, LG.state.project.source, { numRays: 1000 }) });
            updateOptHint();
            LG.status('✓ ' + LG.t('c.resetDefault'));
          });
          foot.appendChild(btn);
          body.appendChild(foot);
        }
      });
    })();

    // ---- 3D 视图 ----
    LG.Viewer.mount($('sim-viewer'));
    var p0 = LG.state.project;
    if (LG.Viewer.hasGeometry()) {
      var uf = unionFaces('input'), of = unionFaces('output');
      LG.Viewer.setFaceHighlights(uf, of);
    }
    if (LG.state.lastRun) { showResults(LG.state.lastRun); showSpotSectionFrom(); }

    // ---- 灯珠增减 ----
    $('s-add-bead').addEventListener('click', function () {
      var beads = getBeads();
      beads.push({ input: [], output: [] });
      saveBeads(beads);
      renderBeadList();
      updateFaceStatus();
    });
    // bead 移除按钮（事件委托）
    $('s-bead-list').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-remove-bead]');
      if (!btn) return;
      var idx = +btn.getAttribute('data-remove-bead');
      var beads = getBeads();
      if (beads.length <= 1) return; // 至少保留 1 颗
      beads.splice(idx, 1);
      saveBeads(beads);
      // 退出可能正在进行的拾取
      LG.Viewer.setPick(null);
      setPickBtn(null);
      renderBeadList();
      syncUnionFaces();
      LG.Engine.refreshLEDPose();
      updateFaceStatus();
    });
    // bead 拾取按钮（事件委托）
    $('s-bead-list').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pick]');
      if (!btn) return;
      var parts = btn.getAttribute('data-pick').split(':');
      var beadIdx = +parts[0], role = parts[1];
      // 再次点击已激活的拾取按钮 → 退出拾取模式
      if (pickBtn === btn) { LG.Viewer.setPick(null); setPickBtn(null); return; }
      startPick(beadIdx, role, btn);
    });

    // ---- 端面事件 ----
    $('s-auto').addEventListener('click', function () {
      if (!LG.Viewer.hasGeometry()) { LG.status(LG.t('c.needGeometry')); return; }
      var auto = LG.Viewer.autoEndCaps();
      // 自动检测 → 写入第 1 颗灯珠
      var beads = getBeads();
      beads[0] = { input: auto.input, output: auto.output };
      saveBeads(beads);
      LG.Viewer.setFaceHighlights(auto.input, auto.output);
      LG.Engine.refreshLEDPose();
      renderBeadList();
      updateFaceStatus();
      LG.status(LG.t('c.facesSet', auto.input.length, auto.output.length));
    });
    $('s-swap').addEventListener('click', function () {
      var beads = getBeads();
      // 交换所有灯珠的 input/output
      beads = beads.map(function (b) { return { input: b.output.slice(), output: b.input.slice() }; });
      saveBeads(beads);
      syncUnionFaces();
      LG.Engine.refreshLEDPose();
      renderBeadList();
      updateFaceStatus();
    });
    $('s-clear').addEventListener('click', function () {
      // 重置为 1 颗空灯珠
      saveBeads([{ input: [], output: [] }]);
      LG.Viewer.setFaceHighlights([], []);
      LG.Viewer.setPick(null);
      setPickBtn(null);
      LG.Engine.refreshLEDPose();
      LG.Viewer.clearRays();
      LG.Viewer.clearSpotSection();
      var rb = $('s-results');
      if (rb) rb.style.display = 'none';
      renderBeadList();
      updateFaceStatus();
    });
    // Esc 退出拾取模式
    function onKeyDown(e) {
      if (e.key === 'Escape' && pickBtn) { LG.Viewer.setPick(null); setPickBtn(null); }
    }
    document.addEventListener('keydown', onKeyDown);

    // ---- 运行 ----
    $('s-run').addEventListener('click', runSim);

    return function cleanup() {
      dead = true;
      document.removeEventListener('keydown', onKeyDown);
      LG.Viewer.setPick(null);
      LG.Viewer.unmount();
    };

    // ================= functions =================

    // ---- beads 读写辅助 ----
    function getBeads() {
      var p = LG.state.project;
      if (p.beads && p.beads.length) return p.beads.map(function (b) { return { input: (b.input||[]).slice(), output: (b.output||[]).slice() }; });
      // 兼容旧数据：faces → beads[0]
      return [{ input: (p.faces.input||[]).slice(), output: (p.faces.output||[]).slice() }];
    }
    function saveBeads(beads) {
      LG.Store.updateActive({ beads: beads, faces: { input: unionBeads(beads, 'input'), output: unionBeads(beads, 'output') } });
    }
    function unionBeads(beads, key) {
      var s = new Set(), out = [];
      beads.forEach(function (b) { (b[key]||[]).forEach(function (id) { if (!s.has(id)) { s.add(id); out.push(id); } }); });
      return out;
    }
    function unionFaces(role) {
      return unionBeads(getBeads(), role);
    }
    function syncUnionFaces() {
      var beads = getBeads();
      LG.Store.updateActive({ faces: { input: unionBeads(beads, 'input'), output: unionBeads(beads, 'output') } });
      LG.Viewer.setFaceHighlights(unionBeads(beads, 'input'), unionBeads(beads, 'output'));
    }

    // ---- 灯珠列表渲染 ----
    function renderBeadList() {
      var beads = getBeads();
      var html = '';
      beads.forEach(function (b, i) {
        var inTxt = b.input.length ? LG.t('sim.beadInputStatus', b.input.length) : LG.t('sim.beadInputEmpty');
        var outTxt = b.output.length ? LG.t('sim.beadOutputStatus', b.output.length) : LG.t('sim.beadOutputEmpty');
        html += '<div class="bead-card">' +
          '<div class="bead-head"><b>' + LG.t('sim.bead', i + 1) + '</b>' +
          (beads.length > 1 ? '<button class="btn btn-danger btn-sm bead-rm" data-remove-bead="' + i + '">' + LG.t('sim.removeBead') + '</button>' : '') +
          '</div>' +
          '<div class="bead-status"><span>' + inTxt + '</span><span>' + outTxt + '</span></div>' +
          '<div class="btn-row bead-pick-row">' +
            '<button class="btn btn-ghost btn-sm" data-pick="' + i + ':input">' + LG.t('c.pickInput') + '</button>' +
            '<button class="btn btn-ghost btn-sm" data-pick="' + i + ':output">' + LG.t('c.pickOutput') + '</button>' +
          '</div>' +
        '</div>';
      });
      $('s-bead-list').innerHTML = html;
    }

    function updateOptHint() {
      var src = LG.state.project.source;
      var mode = src.mode === 'gauss' ? LG.t('model.src.mode.gauss') : LG.t('model.src.mode.lambert');
      $('s-opt-hint').textContent =
        LG.t('model.src.rays') + ': ' + src.numRays +
        ' · ' + LG.t('model.src.bounces') + ': ' + src.maxBounces +
        ' · ' + mode;
    }
    function updateFaceStatus() {
      var beads = getBeads();
      var uf = unionBeads(beads, 'input'), of = unionBeads(beads, 'output');
      var text = LG.t('sim.status', uf.length, of.length);
      var led = LG.state.project.led;
      if (led && led.enabled) {
        text += ' · ' + LG.t('sim.ledCount', beads.length);
      }
      $('s-face-status').textContent = text;
    }
    function setPickBtn(role) {
      if (pickBtn) pickBtn.classList.remove('active');
      pickBtn = null;
    }
    function startPick(beadIdx, role, btn) {
      if (!LG.Viewer.hasGeometry()) { LG.status(LG.t('c.needGeometry')); return; }
      if (pickBtn) pickBtn.classList.remove('active');
      pickBtn = btn;
      pickBtn.classList.add('active');
      LG.Viewer.setPick(role, function (pickedRole, ids, meta) { onPick(beadIdx, pickedRole, ids, meta); });
    }
    function onPick(beadIdx, role, ids, meta) {
      var beads = getBeads();
      var existing = role === 'input' ? (beads[beadIdx].input || []) : (beads[beadIdx].output || []);
      var next = LG.Viewer.computeFacePickUpdate(existing, ids, meta || {});
      beads[beadIdx][role] = next;
      saveBeads(beads);
      var uf = unionBeads(beads, 'input'), of = unionBeads(beads, 'output');
      LG.Viewer.setFaceHighlights(uf, of);
      LG.Engine.refreshLEDPose();
      renderBeadList();
      updateFaceStatus();
      LG.status(LG.t('c.facesSet', uf.length, of.length));
      // 拾取模式保持激活：可继续 Shift+点击累加 / 再点已选面取消
      // 重新绑定 pick callback（renderBeadList 重建了 DOM，需要恢复 active 状态）
      var newBtn = $('s-bead-list').querySelector('[data-pick="' + beadIdx + ':' + role + '"]');
      if (newBtn) { pickBtn = newBtn; pickBtn.classList.add('active'); }
    }

    /** 仿真模式 / 公差扫参提示 */
    function syncModeUI() {
      el.querySelectorAll('[data-sim-mode]').forEach(function (b) {
        b.classList.toggle('is-on', b.getAttribute('data-sim-mode') === simMode);
      });
      var src = LG.state.project.source;
      var hint = LG.t(simMode === 'quick' ? 'sim.mode.quick.d' : 'sim.mode.precise.d');
      if (simMode === 'quick') hint += ' · ' + LG.t('sim.mode.quick.rays', Math.min(QUICK_RAYS, src.numRays));
      $('s-mode-hint').textContent = hint;
      var ledOn = !!(LG.state.project.led && LG.state.project.led.enabled);
      $('s-tol-hint').textContent = (tolOn && !ledOn) ? LG.t('sim.tol.needLed') : LG.t('sim.tol.hint');
    }

    function runSim() {
      if (running) return;
      var p = LG.state.project;
      if (!LG.state.mesh || !LG.Viewer.hasGeometry()) { LG.status(LG.t('c.needGeometry')); return; }
      if (!p.faces.input.length || !p.faces.output.length) { LG.status(LG.t('c.needFaces')); return; }

      var src = p.source;
      var quick = simMode === 'quick';
      // 快速预览：限制光线数与反弹次数，秒级出光路；精确评估：使用完整参数。
      // 热图网格固定（预览 32 / 精确 64），不开放调节——调节会改变投影观感、影响判断。
      var effRays = quick ? Math.min(QUICK_RAYS, src.numRays) : src.numRays;
      var effRes = quick ? 32 : 64;
      var effBounces = quick ? Math.min(src.maxBounces, QUICK_BOUNCES) : src.maxBounces;

      running = true;
      $('s-run').disabled = true;
      $('s-progress-wrap').style.display = '';
      $('s-progress-bar').style.width = '0%';
      $('s-progress-txt').textContent = LG.t('sim.progress', 0, effRays);

      var options = {
        n: p.material.n,
        alpha: p.material.alpha,
        // 体散射（扩散粉匀光）：工程档位 → 散射系数 μs（1/mm）。
        // 标定依据：30mm 柱内 μs=0.15 时几乎所有光线至少散射一次，侧面漏光达 73%，
        // 过于激进；按“弱/中/强 = 平均散射约 0.3 / 1.2 / 3 次”重设为 0.01 / 0.04 / 0.10。
        muS: ({ none: 0, light: 0.01, mid: 0.04, high: 0.10 })[(p.material && p.material.diffusion) || 'none'] || 0,
        hgG: 0.55,
        maxBounces: effBounces,
        numRays: effRays,
        angleSigma: src.angleSigma,
        posSigma: src.posSigma,
        srcDist: src.srcDist || 0,
        visRays: quick ? Math.min(500, effRays) : 800,  // 3D 预览采集轨迹的光线数（统计指标始终基于全部光线）
        emissionMode: src.mode,
        sourceType: src.type || 'surface',
        // 灯珠装配偏心：只平移灯珠发光面（引擎沿位姿局部 X/Y 偏移），导光柱几何不动
        led: p.led ? Object.assign({}, p.led, {
          offsetX: (p.eng && p.eng.offsetX) || 0,
          offsetY: (p.eng && p.eng.offsetY) || 0
        }) : null,
        inputFaceIds: p.faces.input,
        outputFaceIds: p.faces.output,
        // 表面咬花/雾面：按面组的散射半角 σ（deg）。σ=0 即镜面（旧行为）。
        surfaceTexture: (function () {
          var sf = (p.geometry && p.geometry.surface) || {};
          return {
            input:  Math.max(0, +sf.inputSigma  || 0),
            output: Math.max(0, +sf.outputSigma || 0),
            side:   Math.max(0, +sf.sideSigma   || 0)
          };
        })(),
        heatmapRes: effRes,
        axisBins: 64,
        angleBinDeg: 2,
        returnSegments: true,
        returnSpot: true,   // 出射命中点恒回传：3D 截面与「光斑分析」页共用本次仿真数据，避免二次仿真偏差
        onProgress: function (done, total) {
          if (dead) return;
          var pct = total > 0 ? Math.round(done / total * 100) : 0;
          $('s-progress-bar').style.width = pct + '%';
          $('s-progress-txt').textContent = LG.t('sim.progress', done, total);
        }
      };

      LG.Engine.run({ positions: LG.state.mesh.positions, indices: LG.state.mesh.indices }, options)
        .then(function (payload) { onDone(payload, options); })
        .catch(function (err) {
          console.error('simulate failed', err);
          if (!dead) {
            LG.status('Error: ' + err.message);
            resetRunUI();
          }
        });

      function onDone(payload, opts) {
        payload.mode = LG.Engine.mode();
        payload.simMode = simMode;
        payload.quality = { numRays: opts.numRays, heatRes: opts.heatmapRes };
        payload.params = paramsSnapshot(opts);
        LG.state.lastRun = payload;
        if (!dead) {
          showResults(payload);
          if (payload.segments && payload.segments.length) LG.Viewer.showRays(payload.segments);
          showSpotSectionFrom();
        }
        // 公差扫参：额外运行 0.1 / 0.2 / 0.3mm 偏移，结果供结果页画衰减曲线
        var wantTol = tolOn && p.led && p.led.enabled && LG.state.mesh;
        var chain = wantTol ? runTolerance(payload, opts) : Promise.resolve(null);
        chain.then(function (arr) {
          if (arr && arr.length) payload.tolerance = arr;
          finish(payload);
        });
      }
      function runTolerance(base, opts) {
        var offsets = [0.1, 0.2, 0.3];
        var out = [];
        var baseVal = base.avgOutputIntensity || 0;
        var idx = 0;
        function step() {
          if (dead || idx >= offsets.length) return Promise.resolve(out);
          var dx = offsets[idx];
          if (!dead) $('s-progress-txt').textContent = LG.t('sim.tol.running', idx + 1, offsets.length);
          var positions = new Float32Array(LG.state.mesh.positions);
          for (var k = 0; k < positions.length; k += 3) positions[k] += dx; // 导光柱相对 LED 平移 = 装配偏位
          var o = Object.assign({}, opts, {
            numRays: Math.min(opts.numRays, 400), heatmapRes: 24,
            returnSegments: false, returnSpot: false, visRays: 0, onProgress: null
          });
          return LG.Engine.run({ positions: positions, indices: LG.state.mesh.indices }, o)
            .then(function (r) {
              var v = r.avgOutputIntensity || 0;
              out.push({ offset: dx, brightness: v, drop: baseVal > 0 ? Math.max(0, (baseVal - v) / baseVal * 100) : 0 });
              idx++; return step();
            })
            .catch(function () { idx++; return step(); });
        }
        return step();
      }
      function finish(payload) {
        // 仿真完成后捕获 3D 缩略图（含光线轨迹），保存到记录中
        var thumb = null;
        if (!dead) {
          try { if (LG.Viewer.hasGeometry()) thumb = LG.Viewer.screenshot(240, 180); } catch (e) {}
        }
        LG.Store.addRecord(recordFrom(payload, thumb));
        resetRunUI();
        if (!dead) {
          LG.status(LG.t('sim.hintDone', payload.successRate, payload.success, payload.total,
            payload.elapsedMs != null ? payload.elapsedMs : '-') +
            (payload.tolerance ? ' · ' + LG.t('sim.tol.done') : '') + ' · ' + LG.t('sim.saved'));
        }
      }
      function resetRunUI() {
        running = false;
        if (dead) return;
        $('s-run').disabled = false;
        $('s-progress-wrap').style.display = 'none';
      }
    }

    function paramsSnapshot(opts) {
      var p = LG.state.project;
      var sp = p.source.spectrum;
      var multi = !!(sp && sp.enabled && sp.wavelengths && sp.wavelengths.length);
      return {
        geometryName: LG.state.mesh.name,
        isParametric: !!LG.state.mesh.isParametric,
        geometry: JSON.parse(JSON.stringify(p.geometry)),
        n: p.material.n, abbe: p.material.abbe || 0, alpha: p.material.alpha, materialPreset: p.material.preset,
        emissionMode: opts.emissionMode, sourceType: opts.sourceType, flux: p.source.flux, wavelength: p.source.wavelength,
        angleSigma: opts.angleSigma, posSigma: opts.posSigma, srcDist: opts.srcDist,
        spectrum: multi ? sp.wavelengths.map(function (w) { return { nm: w.nm, weight: w.weight }; }) : null,
        led: p.led && p.led.enabled ? JSON.parse(JSON.stringify(p.led)) : null,
        numRays: opts.numRays, maxBounces: opts.maxBounces,
        simMode: simMode, srcRays: p.source.numRays,
        diffusion: (p.material && p.material.diffusion) || 'none',
        heatmapRes: opts.heatmapRes,
        inputCount: p.faces.input.length, outputCount: p.faces.output.length
      };
    }

    function recordFrom(payload, thumb) {
      return {
        params: payload.params,
        summary: {
          total: payload.total, success: payload.success,
          escaped: payload.escaped, exhausted: payload.exhausted,
          successRate: payload.successRate,
          avgOutputIntensity: payload.avgOutputIntensity,
          maxBounces: payload.maxBounces,
          elapsedMs: payload.elapsedMs, mode: payload.mode
        },
        ledger: payload.ledger,
        agg: payload.agg,
        tolerance: payload.tolerance || null,
        simMode: payload.simMode || null,
        thumb: thumb || null
      };
    }

    // ---- 结果面板 ----
    function showResults(payload) {
      var box = $('s-results');
      var s = payload;
      var html =
        '<h4>' + LG.t('sim.result') + '</h4>' +
        kv(LG.t('sim.total'), s.total) +
        kv(LG.t('sim.success'), s.success) +
        kv(LG.t('sim.escaped'), s.escaped) +
        kv(LG.t('sim.exhausted'), s.exhausted) +
        kv(LG.t('sim.rate'), (typeof s.successRate === 'number' ? s.successRate.toFixed(1) : s.successRate) + '%') +
        kv(LG.t('sim.avg'), s.avgOutputIntensity) +
        kv(LG.t('sim.bounces'), s.maxBounces) +
        kv(LG.t('sim.elapsed'), (s.elapsedMs != null ? s.elapsedMs : '-') + ' ms') +
        kv(LG.t('sim.quality'), LG.t('sim.mode.badge.' + (s.simMode || 'precise')) + ' · ' +
          (s.quality ? s.quality.numRays + ' rays / ' + s.quality.heatRes + ' px' : s.total + ' rays')) +
        kv(LG.t('sim.visRays'), (s.visRays != null ? s.visRays : s.total) + ' / ' + s.total) +
        '<h4 style="margin-top:12px">' + LG.t('sim.ledger') + '</h4>' +
        '<div class="ledger-bar">';

      var L = payload.ledger || {};
      var sum = (L.output || 0) + (L.side || 0) + (L.absorbed || 0) + (L.residual || 0) || 1;
      var order = ['output', 'side', 'absorbed', 'residual'];
      var legend = '';
      for (var i = 0; i < order.length; i++) {
        var k = order[i];
        var pct = (L[k] || 0) / sum * 100;
        if (pct > 0.05) html += '<div style="width:' + pct.toFixed(2) + '%;background:' + LEDGER_COLORS[k].color + '"></div>';
        legend += '<span><i style="background:' + LEDGER_COLORS[k].color + '"></i>' +
          LG.t(LEDGER_COLORS[k].key) + ' ' + pct.toFixed(1) + '%</span>';
      }
      html += '</div><div class="legend">' + legend + '</div>';
      html += '<div class="hint" style="margin-top:8px">' +
        (payload.mode === 'worker' ? LG.t('sim.mode.worker') : LG.t('sim.mode.main')) + '</div>';

      box.innerHTML = html;
      box.style.display = '';
      $('s-mode-badge').textContent = LG.t('sim.rayCount') + ': ' + s.total + ' · ' +
        LG.t('sim.mode.badge.' + (s.simMode || 'precise')) + ' · ' +
        (payload.mode === 'worker' ? LG.t('sim.mode.worker') : LG.t('sim.mode.main'));
    }
    function kv(k, v) {
      return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + LG.esc(v) + '</span></div>';
    }

    // ---- 出射端面光斑截面（探测屏贴住出射端端面；与「光斑分析」页同一投影函数） ----
    function showSpotSectionFrom() {
      var on = $('s-spotsec') && $('s-spotsec').checked;
      var proj = (on && LG.state.lastRun && LG.Modules.spot && LG.Modules.spot.projectLastRun)
        ? LG.Modules.spot.projectLastRun() : null;
      if (proj) LG.Viewer.showSpotSection(proj);
      else LG.Viewer.clearSpotSection();
    }
  }

  window.LG = window.LG || {};
  LG.Modules = LG.Modules || {};
  LG.Modules.simulate = { render: render };
})();
