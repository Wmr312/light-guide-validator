/**
 * LG.Modules.model — 模型与参数配置页
 * 左栏：几何 / 侧棱镜微齿 / 文件导入 / 材料 / 光源；右侧：3D 预览（共享 Viewer）
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // 多波长光谱预设（nm / 相对权重）：供「光源参数」卡的多波长配置使用
  var SPEC_PRESETS = {
    rgb:      [{ nm: 450, weight: 1 }, { nm: 550, weight: 1 }, { nm: 650, weight: 1 }],
    rgbw:     [{ nm: 450, weight: 1 }, { nm: 530, weight: 1 }, { nm: 620, weight: 1 }, { nm: 650, weight: 1 }],
    ledwhite: [{ nm: 450, weight: 0.8 }, { nm: 550, weight: 1 }, { nm: 650, weight: 0.9 }]
  };

  // ---- 工程化预设库：把光学底层参数藏在这里，界面只暴露工程选项 ----
  // 材料库 → 光学预设 "n,alpha"。pc_diffuse 为扩散料，选中时同时把「匀光」档位
  // 设为中档（若用户尚未手动设过），交给体散射模型计算端面均匀度。
  var MATERIAL_LIB = {
    pmma:       { preset: '1.49,0.0005' },
    pc:         { preset: '1.586,0.002' },
    pc_diffuse: { preset: '1.586,0.002', diffuse: true },
    ms:         { preset: '1.59,0.0015' }
  };

  // 咬花/雾面预设 → 散射半角 σ（deg）。对应常见模具咬花等级的统计粗糙度量级。
  // 定义在模块顶部：render 填充阶段就会调用 texSigmaOf（var 赋值不提升，放后面会 undefined）。
  var TEX_SIGMA = { polished: 0, fine: 2, mid: 5, coarse: 10 };
  function texSigmaOf(preset, customSigma) {
    if (preset === 'custom') return Math.min(25, Math.max(0, parseFloat(customSigma) || 0));
    return TEX_SIGMA[preset] != null ? TEX_SIGMA[preset] : 0;
  }

  // LED 型号库 → 发光面尺寸 / 光通量 / 发光角（3C 常见封装典型值）
  var LED_LIB = {
    '0402': { length: 1.0, width: 0.5, height: 0.6, flux: 5,  angle: 120 },
    '0603': { length: 1.6, width: 0.8, height: 0.8, flux: 10, angle: 120 },
    '2835': { length: 3.5, width: 2.8, height: 0.8, flux: 40, angle: 120 },
    '3528': { length: 3.5, width: 2.8, height: 1.9, flux: 30, angle: 120 },
    'top':  { length: 3.0, width: 3.0, height: 1.2, flux: 60, angle: 120 },
    'side': { length: 3.0, width: 1.0, height: 1.4, flux: 25, angle: 120 }
  };
  var LED_LEVEL = { low: 0.6, typ: 1, high: 1.6 };

  var GOAL_KEYS = ['brightness', 'uniformity', 'leak', 'tolerance', 'bendLoss', 'crosstalk', 'molding'];

  function goalLine(k) {
    return '<div class="checkline"><input type="checkbox" id="m-goal-' + k + '"><label for="m-goal-' + k + '" style="margin:0">' + LG.t('goal.' + k) + '</label></div>';
  }

  function render(el) {
    var p = LG.state.project;
    var g = p.geometry, m = p.material, s = p.source;

    el.innerHTML =
      '<div class="page-title">' + LG.t('model.title') + '</div>' +
      '<div class="layout">' +
        '<div>' +
          '<button id="m-collapse-all" class="collapse-all"><span class="arr">▲</span><span id="m-collapse-txt">' + LG.t('c.collapseAll') + '</span></button>' +
          '<div class="card" data-reset="geo" data-sec="build">' +
            '<div class="card-title">' + LG.t('model.file.title') + '</div>' +
            '<button id="m-file-btn" class="btn btn-ghost btn-block">' + LG.t('model.file.import') + '</button>' +
            '<input type="file" id="m-file" accept=".stl,.obj,.step,.stp" hidden>' +
            '<div class="hint" id="m-file-info"></div>' +
            '<div class="hint">' + LG.t('model.file.hint') + '</div>' +
            '<div class="field" style="margin-top:10px"><label>' + LG.t('model.asmGap') + ' (mm)</label><input type="number" id="m-asm-gap" step="0.01" min="0" max="2"></div>' +
          '</div>' +
          '<div class="card" data-reset="mat" data-sec="mat">' +
            '<div class="card-title">' + LG.t('model.matlib') + '</div>' +
            '<div class="hint">' + LG.t('model.matlib.hint') + '</div>' +
            '<div class="field"><label>' + LG.t('model.mat.preset') + '</label>' +
              '<select id="m-matlib">' +
                '<option value="pmma">' + LG.t('matlib.pmma') + '</option>' +
                '<option value="pc">' + LG.t('matlib.pc') + '</option>' +
                '<option value="pc_diffuse">' + LG.t('matlib.pc_diffuse') + '</option>' +
                '<option value="ms">' + LG.t('matlib.ms') + '</option>' +
                '<option value="custom">' + LG.t('matlib.custom') + '</option>' +
              '</select></div>' +
            '<div class="hint" id="m-matlib-desc"></div>' +
            // 匀光（扩散粉）：直接决定出射端面均匀度，是最有效的“让光斑更匀”手段
            '<div class="field" style="margin-top:8px"><label>' + LG.t('model.mat.diff') + '</label>' +
              '<select id="m-diff">' +
                '<option value="none">' + LG.t('model.mat.diff.none') + '</option>' +
                '<option value="light">' + LG.t('model.mat.diff.light') + '</option>' +
                '<option value="mid">' + LG.t('model.mat.diff.mid') + '</option>' +
                '<option value="high">' + LG.t('model.mat.diff.high') + '</option>' +
              '</select></div>' +
            '<div class="hint" id="m-diff-desc"></div>' +
            // 光学底层参数默认收起：结构工程师只看材料名，光学人员需要时再展开
            '<details style="margin-top:8px"><summary class="adv-sum">' + LG.t('matlib.custom') + '</summary>' +
              '<div class="field" style="margin-top:8px"><label>' + LG.t('model.mat.preset') + '</label>' +
                '<select id="m-preset">' +
                  '<option value="custom">Custom / 自定义</option>' +
                  '<option value="1.586,0.002">' + LG.t('model.mat.preset.pc') + '</option>' +
                  '<option value="1.49,0.0005">' + LG.t('model.mat.preset.pmma') + '</option>' +
                  '<option value="1.59,0.0015">' + LG.t('model.mat.preset.ps') + '</option>' +
                  '<option value="1.575,0.0018">' + LG.t('model.mat.preset.pet') + '</option>' +
                  '<option value="1.533,0.0004">' + LG.t('model.mat.preset.coc') + '</option>' +
                  '<option value="1.517,0.00005">' + LG.t('model.mat.preset.bk7') + '</option>' +
                '</select></div>' +
              '<div class="row2">' +
                '<div class="field"><label>' + LG.t('model.mat.n') + '</label><input type="number" id="m-n" step="0.001" min="1" max="3"></div>' +
                '<div class="field"><label>' + LG.t('model.mat.alpha') + '</label><input type="number" id="m-alpha" step="0.0001" min="0" max="0.01"></div>' +
              '</div>' +
              '<div class="field"><label>' + LG.t('model.mat.abbe') + '</label><input type="number" id="m-abbe" step="0.1" min="0" max="200"></div>' +
            '</details>' +
          '</div>' +
          // ---- 表面处理与曲面：咬花/雾面（散射半角 σ）按 入射/出射/侧面 分组 + 端面球冠 + 侧面轮廓 ----
          '<div class="card" data-reset="surface" data-sec="surface">' +
            '<div class="card-title">' + LG.t('model.surface') + '</div>' +
            '<div class="hint">' + LG.t('model.surface.hint') + '</div>' +
            // 入射面
            '<div class="surf-grp">' + LG.t('model.surf.in') + '</div>' +
            '<div class="row2">' +
              '<div class="field"><label>' + LG.t('model.surf.tex') + '</label>' +
                '<select id="m-stex-in">' +
                  '<option value="polished">' + LG.t('model.surf.tex.polished') + '</option>' +
                  '<option value="fine">' + LG.t('model.surf.tex.fine') + '</option>' +
                  '<option value="mid">' + LG.t('model.surf.tex.mid') + '</option>' +
                  '<option value="coarse">' + LG.t('model.surf.tex.coarse') + '</option>' +
                  '<option value="custom">' + LG.t('model.surf.tex.custom') + '</option>' +
                '</select></div>' +
              '<div class="field"><label>' + LG.t('model.surf.sigma') + '</label><input type="number" id="m-ssig-in" step="0.5" min="0" max="25"></div>' +
            '</div>' +
            '<div class="row2">' +
              '<div class="field"><label>' + LG.t('model.surf.curve') + '</label>' +
                '<select id="m-scurve-in">' +
                  '<option value="flat">' + LG.t('model.surf.curve.flat') + '</option>' +
                  '<option value="convex">' + LG.t('model.surf.curve.convex') + '</option>' +
                  '<option value="concave">' + LG.t('model.surf.curve.concave') + '</option>' +
                '</select></div>' +
              '<div class="field"><label>' + LG.t('model.surf.curveR') + '</label><input type="number" id="m-scr-in" step="1" min="1"></div>' +
            '</div>' +
            // 出射面
            '<div class="surf-grp">' + LG.t('model.surf.out') + '</div>' +
            '<div class="row2">' +
              '<div class="field"><label>' + LG.t('model.surf.tex') + '</label>' +
                '<select id="m-stex-out">' +
                  '<option value="polished">' + LG.t('model.surf.tex.polished') + '</option>' +
                  '<option value="fine">' + LG.t('model.surf.tex.fine') + '</option>' +
                  '<option value="mid">' + LG.t('model.surf.tex.mid') + '</option>' +
                  '<option value="coarse">' + LG.t('model.surf.tex.coarse') + '</option>' +
                  '<option value="custom">' + LG.t('model.surf.tex.custom') + '</option>' +
                '</select></div>' +
              '<div class="field"><label>' + LG.t('model.surf.sigma') + '</label><input type="number" id="m-ssig-out" step="0.5" min="0" max="25"></div>' +
            '</div>' +
            '<div class="row2">' +
              '<div class="field"><label>' + LG.t('model.surf.curve') + '</label>' +
                '<select id="m-scurve-out">' +
                  '<option value="flat">' + LG.t('model.surf.curve.flat') + '</option>' +
                  '<option value="convex">' + LG.t('model.surf.curve.convex') + '</option>' +
                  '<option value="concave">' + LG.t('model.surf.curve.concave') + '</option>' +
                '</select></div>' +
              '<div class="field"><label>' + LG.t('model.surf.curveR') + '</label><input type="number" id="m-scr-out" step="1" min="1"></div>' +
            '</div>' +
            // 侧面
            '<div class="surf-grp">' + LG.t('model.surf.side') + '</div>' +
            '<div class="row2">' +
              '<div class="field"><label>' + LG.t('model.surf.tex') + '</label>' +
                '<select id="m-stex-side">' +
                  '<option value="polished">' + LG.t('model.surf.tex.polished') + '</option>' +
                  '<option value="fine">' + LG.t('model.surf.tex.fine') + '</option>' +
                  '<option value="mid">' + LG.t('model.surf.tex.mid') + '</option>' +
                  '<option value="coarse">' + LG.t('model.surf.tex.coarse') + '</option>' +
                  '<option value="custom">' + LG.t('model.surf.tex.custom') + '</option>' +
                '</select></div>' +
              '<div class="field"><label>' + LG.t('model.surf.sigma') + '</label><input type="number" id="m-ssig-side" step="0.5" min="0" max="25"></div>' +
            '</div>' +
            '<div class="row2">' +
              '<div class="field"><label>' + LG.t('model.surf.profile') + '</label>' +
                '<select id="m-sprof">' +
                  '<option value="straight">' + LG.t('model.surf.profile.straight') + '</option>' +
                  '<option value="bulge">' + LG.t('model.surf.profile.bulge') + '</option>' +
                  '<option value="waist">' + LG.t('model.surf.profile.waist') + '</option>' +
                '</select></div>' +
              '<div class="field"><label>' + LG.t('model.surf.dr') + '</label><input type="number" id="m-sdr" step="0.05" min="0" max="2"></div>' +
            '</div>' +
            '<div class="hint">' + LG.t('model.surf.note') + '</div>' +
          '</div>' +
          '<div class="card" data-reset="led" data-sec="led">' +
            '<div class="card-title">' + LG.t('model.ledlib') + '</div>' +
            '<div class="checkline" style="margin:10px 0 12px"><input type="checkbox" id="m-led-en"><label for="m-led-en" style="margin:0;font-weight:600">' + LG.t('model.led.enable') + '</label></div>' +
            '<div class="hint">' + LG.t('model.ledlib.hint') + '</div>' +
            '<div class="field"><label>' + LG.t('model.ledlib') + '</label>' +
              '<select id="m-ledlib">' +
                '<option value="none">' + LG.t('ledlib.none') + '</option>' +
                '<option value="0402">' + LG.t('ledlib.0402') + '</option>' +
                '<option value="0603">' + LG.t('ledlib.0603') + '</option>' +
                '<option value="2835">' + LG.t('ledlib.2835') + '</option>' +
                '<option value="3528">' + LG.t('ledlib.3528') + '</option>' +
                '<option value="top">' + LG.t('ledlib.top') + '</option>' +
                '<option value="side">' + LG.t('ledlib.side') + '</option>' +
              '</select></div>' +
            '<div class="field"><label>' + LG.t('model.ledlib.level') + '</label>' +
              '<select id="m-led-level">' +
                '<option value="low">' + LG.t('ledlevel.low') + '</option>' +
                '<option value="typ">' + LG.t('ledlevel.typ') + '</option>' +
                '<option value="high">' + LG.t('ledlevel.high') + '</option>' +
              '</select></div>' +
            '<div class="row2">' +
              '<div class="field"><label>' + LG.t('model.ledlib.offx') + ' (mm)</label><input type="number" id="m-led-offx" step="0.05" min="-2" max="2"></div>' +
              '<div class="field"><label>' + LG.t('model.ledlib.offy') + ' (mm)</label><input type="number" id="m-led-offy" step="0.05" min="-2" max="2"></div>' +
            '</div>' +
            '<div class="hint">' + LG.t('model.ledlib.offset.hint') + '</div>' +
            '<div id="m-led-body">' +
              '<div class="field"><label>' + LG.t('model.led.type') + '</label>' +
                '<select id="m-led-type">' +
                  '<option value="rectangle">' + LG.t('model.led.type.rect') + '</option>' +
                  '<option value="square">' + LG.t('model.led.type.square') + '</option>' +
                  '<option value="concave">' + LG.t('model.led.type.concave') + '</option>' +
                  '<option value="convex">' + LG.t('model.led.type.convex') + '</option>' +
                '</select></div>' +
              '<div class="row2">' +
                '<div class="field"><label>' + LG.t('model.led.length') + ' (mm)</label><input type="number" id="m-led-len" step="0.1" min="0.3" max="20"></div>' +
                '<div class="field" id="m-led-w-wrap"><label>' + LG.t('model.led.width') + ' (mm)</label><input type="number" id="m-led-wid" step="0.1" min="0.3" max="20"></div>' +
              '</div>' +
              '<div class="field"><label>' + LG.t('model.led.height') + ' (mm)</label><input type="number" id="m-led-hgt" step="0.1" min="0.3" max="10"></div>' +
              '<div class="field" id="m-led-concave-wrap" style="display:none"><label>' + LG.t('model.led.concaveDepth') + ' (mm)</label><input type="number" id="m-led-cd" step="0.05" min="0.1" max="1.0"></div>' +
              '<div class="field" id="m-led-convex-wrap" style="display:none"><label>' + LG.t('model.led.convexRadius') + ' (mm)</label><input type="number" id="m-led-cr" step="0.1" min="0.2" max="5.0"></div>' +
            '</div>' +
            '<div class="hint">' + LG.t('model.led.hint') + '</div>' +
          '</div>' +
          '<div class="card" data-sec="env">' +
            '<div class="card-title">' + LG.t('model.env') + '</div>' +
            '<div class="hint">' + LG.t('model.env.hint') + '</div>' +
            '<div class="field"><label>' + LG.t('model.env.housing') + '</label>' +
              '<select id="m-housing">' +
                '<option value="black">' + LG.t('env.housing.black') + '</option>' +
                '<option value="white">' + LG.t('env.housing.white') + '</option>' +
              '</select></div>' +
            '<div class="checkline"><input type="checkbox" id="m-foam"><label for="m-foam" style="margin:0">' + LG.t('model.env.foam') + '</label></div>' +
            '<div class="checkline"><input type="checkbox" id="m-reflector"><label for="m-reflector" style="margin:0">' + LG.t('model.env.reflector') + '</label></div>' +
          '</div>' +
          '<div class="card" data-sec="goals">' +
            '<div class="card-title">' + LG.t('model.goals') + '</div>' +
            '<div class="hint">' + LG.t('model.goals.hint') + '</div>' +
            goalLine('brightness') + goalLine('uniformity') + goalLine('leak') + goalLine('tolerance') +
            goalLine('bendLoss') + goalLine('crosstalk') + goalLine('molding') +
          '</div>' +
        '</div>' +
        '<div class="stage">' +
          '<div class="viewer-slot" id="model-viewer"></div>' +
          '<div class="stage-toolbar">' +
            '<button id="plate-add" type="button" class="btn btn-ghost btn-sm plate-add-btn" title="' + LG.t('plate.add') + '">＋ ' + LG.t('plate.add') + '</button>' +
            '<span class="plate-count-pill" id="plate-count"></span>' +
          '</div>' +
          '<div class="stage-badge" id="model-badge">' + LG.t('model.viewer') + '</div>' +
          // 操作模式工具条：固定到 3D 窗口中间底部（参考 OrcaSlicer 图 8 位置）
          '<div class="op-toolbar" id="op-toolbar">' +
            '<div class="op-hint" id="op-hint">' + LG.t('op.hint') + '</div>' +
            '<div class="op-btns" id="op-btns">' +
              '<button type="button" class="op-btn" data-op="move" id="op-move" title="' + LG.t('op.move.tip') + '">' +
                '<svg viewBox="0 0 32 32"><g stroke="#E5484D" stroke-width="2" fill="none"><line x1="16" y1="16" x2="28" y2="16"/><polygon points="28,16 22,12 22,20" fill="#E5484D"/></g><g stroke="#46A758" stroke-width="2" fill="none"><line x1="16" y1="16" x2="16" y2="4"/><polygon points="16,4 12,10 20,10" fill="#46A758"/></g><g stroke="#3E8FEA" stroke-width="2" fill="none"><line x1="16" y1="16" x2="4" y2="28"/><polygon points="4,28 10,28 10,22" fill="#3E8FEA"/></g></svg>' +
                '<span>' + LG.t('op.move') + '</span></button>' +
              '<button type="button" class="op-btn" data-op="rotate" id="op-rotate" title="' + LG.t('op.rotate.tip') + '">' +
                '<svg viewBox="0 0 32 32"><g stroke="#46A758" stroke-width="2" fill="none"><circle cx="16" cy="16" r="10"/></g><g stroke="#E5484D" stroke-width="2" fill="none"><circle cx="16" cy="16" r="14"/></g><path d="M6 6 L10 6 L10 10" stroke="#E5484D" stroke-width="2" fill="none"/></svg>' +
                '<span>' + LG.t('op.rotate') + '</span></button>' +
              '<button type="button" class="op-btn" data-op="place" id="op-place" title="' + LG.t('op.place.tip') + '">' +
                '<svg viewBox="0 0 32 32"><g stroke="#2DD4BF" stroke-width="2" fill="none"><rect x="6" y="6" width="20" height="20"/></g><line x1="6" y1="16" x2="26" y2="16" stroke="#3E8FEA" stroke-width="1.5"/><line x1="16" y1="6" x2="16" y2="26" stroke="#3E8FEA" stroke-width="1.5"/><polygon points="16,28 12,22 20,22" fill="#E5484D"/></svg>' +
                '<span>' + LG.t('op.place') + '</span></button>' +
            '</div>' +
            '<div class="op-panel" id="op-panel" style="display:none">' +
              '<div class="op-panel-section">' +
                '<div class="op-panel-title">Pos (mm)</div>' +
                '<div class="op-row"><span class="op-ax x">X</span><input type="number" step="0.1" id="op-px"><span class="op-ax y">Y</span><input type="number" step="0.1" id="op-py"><span class="op-ax z">Z</span><input type="number" step="0.1" id="op-pz"></div>' +
              '</div>' +
              '<div class="op-panel-section">' +
                '<div class="op-panel-title">Rot (°)</div>' +
                '<div class="op-row"><span class="op-ax x">X</span><input type="number" step="1" id="op-rx"><span class="op-ax y">Y</span><input type="number" step="1" id="op-ry"><span class="op-ax z">Z</span><input type="number" step="1" id="op-rz"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="stage-precheck-pop" id="m-precheck" style="display:none">' +
            '<div class="sp-head"><span>' + LG.t('model.precheck.title') + '</span><button id="m-precheck-close" type="button" class="sp-close" title="' + LG.t('c.close') + '">×</button></div>' +
            '<div id="m-precheck-body"></div>' +
          '</div>' +
          '<button id="m-apply" class="btn btn-primary stage-apply-btn">' + LG.t('model.precheck') + '</button>' +
        '</div>' +
      '</div>';

    // ---- 填充当前值 ----
    var en = p.eng || {};
    $('m-asm-gap').value = (en.assemblyGap != null) ? en.assemblyGap : (p.led && p.led.gap != null ? p.led.gap : 0.1);
    // 材料库
    $('m-matlib').value = en.material || 'pmma';
    // LED 型号库
    $('m-ledlib').value = en.ledModel || '0603';
    $('m-led-level').value = en.ledLevel || 'typ';
    $('m-led-offx').value = en.offsetX || 0;
    $('m-led-offy').value = en.offsetY || 0;
    // 周边结构
    $('m-housing').value = en.housing || 'black';
    $('m-foam').checked = en.foam !== false;
    $('m-reflector').checked = !!en.reflector;
    // 评估目标
    var tg = en.targets || {};
    GOAL_KEYS.forEach(function (k) { $('m-goal-' + k).checked = !!tg[k]; });
    // 表面处理与曲面
    var sf = g.surface || {};
    $('m-stex-in').value = sf.inputTex || 'polished';
    $('m-ssig-in').value = sf.inputSigma != null ? sf.inputSigma : 0;
    $('m-scurve-in').value = sf.inputCurve || 'flat';
    $('m-scr-in').value = sf.inputCurveR != null ? sf.inputCurveR : 20;
    $('m-stex-out').value = sf.outputTex || 'polished';
    $('m-ssig-out').value = sf.outputSigma != null ? sf.outputSigma : 0;
    $('m-scurve-out').value = sf.outputCurve || 'flat';
    $('m-scr-out').value = sf.outputCurveR != null ? sf.outputCurveR : 20;
    $('m-stex-side').value = sf.sideTex || 'polished';
    $('m-ssig-side').value = sf.sideSigma != null ? sf.sideSigma : 0;
    $('m-sprof').value = sf.sideProfile || 'straight';
    $('m-sdr').value = sf.sideDeltaR != null ? sf.sideDeltaR : 0.3;
    $('m-preset').value = m.preset || 'custom';
    $('m-n').value = m.n; $('m-alpha').value = m.alpha;
    $('m-abbe').value = (m.abbe != null) ? m.abbe : LG.Store.defaultAbbe(m.preset);
    $('m-diff').value = m.diffusion || 'none';
    syncDiffUI();
    // source / transform 由 store 默认值和项目历史值管理，UI 层已隐藏，不再填充 DOM
    $('m-file-info').textContent = g.fileName || '';
    syncSurfaceUI();
    // ---- LED 填充 ----
    var led = p.led || {};
    $('m-led-en').checked = !!led.enabled;
    $('m-led-type').value = led.type || 'rectangle';
    $('m-led-len').value = led.length != null ? led.length : 3;
    $('m-led-wid').value = led.width != null ? led.width : 2;
    $('m-led-hgt').value = led.height != null ? led.height : 1.5;
    $('m-led-cd').value = led.concaveDepth != null ? led.concaveDepth : 0.4;
    $('m-led-cr').value = led.convexRadius != null ? led.convexRadius : 0.6;
    syncLEDUI();
    // transform DOM 已隐藏，不再填充
    syncMatLibUI();
    syncLedLibUI();

    // ---- 事件 ----
    // ---- 表面处理与曲面事件：咬花/雾面只影响仿真（不必重建几何）；曲面/轮廓需重建网格 ----
    ['m-stex-in', 'm-ssig-in', 'm-stex-out', 'm-ssig-out', 'm-stex-side', 'm-ssig-side'].forEach(function (id) {
      $(id).addEventListener('change', function () { syncSurfaceUI(); saveSurface(); });
    });
    ['m-scurve-in', 'm-scr-in', 'm-scurve-out', 'm-scr-out', 'm-sprof', 'm-sdr'].forEach(function (id) {
      $(id).addEventListener('change', function () { syncSurfaceUI(); saveSurface(); });
    });
    // source / transform / 多波长光谱 DOM 已隐藏，事件绑定全部删除
    $('m-preset').addEventListener('change', function () {
      var v = $('m-preset').value;
      if (v !== 'custom') {
        var parts = v.split(',');
        $('m-n').value = parseFloat(parts[0]).toFixed(3);
        $('m-alpha').value = parseFloat(parts[1]);
        $('m-abbe').value = LG.Store.defaultAbbe(v);
      }
      saveMaterial();
    });
    $('m-n').addEventListener('change', function () { $('m-preset').value = 'custom'; saveMaterial(); });
    $('m-alpha').addEventListener('change', function () { $('m-preset').value = 'custom'; saveMaterial(); });
    $('m-abbe').addEventListener('change', saveMaterial);
    $('m-diff').addEventListener('change', function () { syncDiffUI(); saveMaterial(); });
    // ---- LED 事件（实时同步）----
    $('m-led-en').addEventListener('change', function () { syncLEDUI(); saveLED(); });
    $('m-led-type').addEventListener('change', function () { syncLEDUI(); saveLED(); });
    $('m-led-len').addEventListener('input', function () {
      if ($('m-led-type').value === 'square') { $('m-led-wid').value = $('m-led-len').value; }
      saveLED();
    });
    ['m-led-wid', 'm-led-hgt', 'm-led-cd', 'm-led-cr'].forEach(function (id) {
      $(id).addEventListener('input', saveLED);
    });

    // ---- 装配间隙 ----
    $('m-asm-gap').addEventListener('input', syncGapToLED);
    // ---- 材料库 / LED 型号库 ----
    $('m-matlib').addEventListener('change', function () {
      if ($('m-matlib').value === 'custom') { syncMatLibUI(); saveEng({ material: 'custom' }); return; }
      syncMatLibUI(); applyMatLib($('m-matlib').value);
    });
    $('m-ledlib').addEventListener('change', function () { syncLedLibUI(); applyLedLib($('m-ledlib').value); });
    $('m-led-level').addEventListener('change', function () { applyLedLib($('m-ledlib').value); });
    $('m-led-offx').addEventListener('input', saveEngOffset);
    $('m-led-offy').addEventListener('input', saveEngOffset);
    // ---- 周边结构 / 评估目标 ----
    $('m-housing').addEventListener('change', function () { saveEng({ housing: $('m-housing').value }); });
    $('m-foam').addEventListener('change', function () { saveEng({ foam: $('m-foam').checked }); });
    $('m-reflector').addEventListener('change', function () { saveEng({ reflector: $('m-reflector').checked }); });
    GOAL_KEYS.forEach(function (k) {
      $('m-goal-' + k).addEventListener('change', function () { saveEng({ targets: readGoals() }); });
    });

    // transform DOM 已隐藏，事件绑定全部删除

    $('m-apply').addEventListener('click', function () {
      runPrecheck();
    });
    $('m-precheck-close').addEventListener('click', function () {
      $('m-precheck').style.display = 'none';
    });
    $('m-file-btn').addEventListener('click', function () { $('m-file').click(); });
    $('m-file').addEventListener('change', function (e) {
      if (e.target.files.length > 0) loadFile(e.target.files[0]);
      e.target.value = '';
    });

    // ---- 盘（每个盘 = 一个项目，直接铺在 3D 主窗口里）----
    LG.Viewer.mount($('model-viewer'));
    LG.Viewer.onPlatePick(switchPlate);
    LG.Viewer.onPlateTool(onPlateTool);
    bindPlateToolbar();

    // ---- 零件操作模式工具条（Move / Rotate / Place）----
    var opToolbar = $('op-toolbar');
    var opHint = $('op-hint');
    var opPanel = $('op-panel');
    var opBtns = document.querySelectorAll('.op-btn');

    function updateOpBtns(active) {
      for (var i = 0; i < opBtns.length; i++) {
        opBtns[i].classList.toggle('is-on', opBtns[i].getAttribute('data-op') === active);
      }
    }
    function showOpPanel(show) {
      opPanel.style.display = show ? '' : 'none';
      opHint.style.display = show ? 'none' : '';
    }
    function syncOpPanel() {
      if (!LG.Viewer.isSelected()) { showOpPanel(false); return; }
      var tr = LG.Viewer.getTransform();
      $('op-px').value = tr.posX.toFixed(2);
      $('op-py').value = tr.posY.toFixed(2);
      $('op-pz').value = tr.posZ.toFixed(2);
      $('op-rx').value = tr.rotX.toFixed(1);
      $('op-ry').value = tr.rotY.toFixed(1);
      $('op-rz').value = tr.rotZ.toFixed(1);
    }

    LG.Viewer.onSelectChange(function (sel) {
      if (!sel) {
        updateOpBtns('');
        showOpPanel(false);
      } else {
        showOpPanel(true);
        syncOpPanel();
      }
    });
    LG.Viewer.onModeChange(function (mode) {
      updateOpBtns(mode);
      if (mode) showOpPanel(true);
    });
    LG.Viewer.onTransformChange(function () {
      syncOpPanel();
      // transform DOM 面板已隐藏，直接把 mesh 当前 transform 写入 store
      var tr = LG.Viewer.getTransform();
      var g2 = LG.state.project.geometry;
      var cur = { posX: tr.posX, posY: tr.posY, posZ: tr.posZ, rotX: tr.rotX, rotY: tr.rotY, rotZ: tr.rotZ };
      LG.Store.updateActive({ geometry: Object.assign({}, g2, { transform: cur }) });
    });

    for (var i = 0; i < opBtns.length; i++) {
      opBtns[i].addEventListener('click', function () {
        var mode = this.getAttribute('data-op');
        // 点击已激活按钮 → 取消选中（退出模式）
        if (this.classList.contains('is-on')) {
          LG.Viewer.deselectMesh();
          return;
        }
        if (!LG.Viewer.isSelected()) LG.Viewer.selectMesh();
        LG.Viewer.setMode(mode);
      });
    }
    // 坐标输入框：用户手动输入 → 同步到 3D
    function bindOpInput(id, apply) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('input', function () {
        var v = parseFloat(this.value);
        if (isNaN(v)) return;
        apply(v);
      });
    }
    bindOpInput('op-px', function (v) {
      var tr = LG.Viewer.getTransform(); tr.posX = v; LG.Viewer.setTransform(tr);
    });
    bindOpInput('op-py', function (v) {
      var tr = LG.Viewer.getTransform(); tr.posY = v; LG.Viewer.setTransform(tr);
    });
    bindOpInput('op-pz', function (v) {
      var tr = LG.Viewer.getTransform(); tr.posZ = v; LG.Viewer.setTransform(tr);
    });
    bindOpInput('op-rx', function (v) {
      var tr = LG.Viewer.getTransform(); tr.rotX = v; LG.Viewer.setTransform(tr);
    });
    bindOpInput('op-ry', function (v) {
      var tr = LG.Viewer.getTransform(); tr.rotY = v; LG.Viewer.setTransform(tr);
    });
    bindOpInput('op-rz', function (v) {
      var tr = LG.Viewer.getTransform(); tr.rotZ = v; LG.Viewer.setTransform(tr);
    });
    // ESC 取消选中；Delete 删除选中的零件（仅移除模型，盘与参数保留）
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && LG.Viewer.isSelected()) { LG.Viewer.deselectMesh(); return; }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      var t = e.target || {};
      var tag = (t.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
      if (!LG.Viewer.isSelected() || !LG.Viewer.hasGeometry()) return;
      e.preventDefault();
      removeSelectedPart();
    });

    // ---- 3D 预览 ----
    if (g.fileName && !LG.Viewer.hasGeometry()) {
      // 先尝试用内存缓存恢复导入的网格（切换盘位后仍可还原）
      if (!restoreCachedMesh(p.id)) {
        // 刷新页面后网格缓存已丢失：提示重新导入，不伪造参数化几何
        $('model-badge').textContent = LG.t('plate.needReimport', g.fileName);
      }
    } else if (!LG.Viewer.hasGeometry()) {
      // 无导入模型、无缓存：提示用户导入（不再自动生成参数化几何）
      $('model-badge').textContent = LG.t('model.needImport');
    } else {
      LG.Viewer.setFaceHighlights(p.faces.input, p.faces.output);
      updateBadge();
    }
    LG.Viewer.setLED(p.led);

    // ---- 铺盘 ----
    // 顺序：零件先就位 → 盘面高度按零件最低点确定，零件「摆」在盘面上 → 再框相机
    LG.Viewer.setPlates(plateItems(), p.id, plateTips());
    syncPlateToolbar();
    if (p.locked) el.querySelector('.layout').classList.add('plate-locked');
    LG.Viewer.fitView();

    // ---- 恢复默认（与 store.js defaults 一致）----
    var resets = {
      geo: function () {
        $('m-asm-gap').value = 0.1;
        syncGapToLED();
        LG.status('✓ ' + LG.t('c.resetDefault'));
      },
      mat: function () {
        $('m-matlib').value = 'pmma';
        syncMatLibUI(); applyMatLib('pmma');
        LG.status('✓ ' + LG.t('c.resetDefault'));
      },
      led: function () {
        $('m-ledlib').value = 'none'; $('m-led-level').value = 'typ';
        $('m-led-offx').value = 0; $('m-led-offy').value = 0;
        syncLedLibUI(); applyLedLib('none'); saveEngOffset();
        LG.status('✓ ' + LG.t('c.resetDefault'));
      }
    };

    // ---- 一键折叠/展开全部 + 卡片可收起 ----
    enhanceCards(resets);
    // 「选项」：应用卡片显隐偏好 + 参数帮助提示
    if (LG.Options && LG.Options.afterRender) LG.Options.afterRender(el);
    var allCollapsed = false;
    $('m-collapse-all').addEventListener('click', function () {
      allCollapsed = !allCollapsed;
      el.querySelectorAll('.card').forEach(function (c) {
        c.classList.toggle('collapsed', allCollapsed);
      });
      this.classList.toggle('closed', allCollapsed);
      $('m-collapse-txt').textContent = LG.t(allCollapsed ? 'c.expandAll' : 'c.collapseAll');
    });

    return function cleanup() {
      closePlatePop();
      document.removeEventListener('mousedown', onPlateDocDown, true);
      LG.Viewer.unmount();
    };

    // ================= functions =================

    // ---------- 盘（Plate）----------
    // 每个盘对应 Store 中的一个项目（一套几何/材料/光源/端面配置），盘面直接铺在 3D 主窗口里，
    // 当前盘居中并加深盘面 + 青色边框，其余盘用归一化示意零件展示；快捷控件悬浮在当前盘右侧。

    var platePop = null;

    function normDeg(v) { v = (v || 0) % 360; return v < 0 ? v + 360 : v; }

    /** 把项目列表整理成 3D 盘的输入：按 plateId 分组，一块盘可并排多个零件（各自独立项目） */
    function plateItems() {
      var list = LG.Store.list();
      var activeId = LG.state.project && LG.state.project.id;
      var groups = [], byKey = {};
      for (var i = 0; i < list.length; i++) {
        var key = LG.Store.plateIdOf(list[i]);
        var grp = byKey[key];
        if (!grp) { grp = { key: key, projects: [] }; byKey[key] = grp; groups.push(grp); }
        grp.projects.push(list[i]);
      }
      return groups.map(function (grp) {
        var ps = grp.projects;
        // 盘的代表项目：优先当前项目（决定点击盘面/盘工具作用的项目），否则取该盘第一个项目
        var rep = ps[0];
        for (var j = 0; j < ps.length; j++) if (ps[j].id === activeId) { rep = ps[j]; break; }
        var it = { id: rep.id, name: rep.name, locked: !!rep.locked, parts: [] };
        for (j = 0; j < ps.length; j++) {
          var part = { id: ps[j].id, name: ps[j].name };
          fillPartMesh(ps[j], part);
          it.parts.push(part);
        }
        // 兼容旧的单零件结构：Viewer 里没有 parts 时会自动包成单零件
        if (ps.length === 1) {
          it.positions = it.parts[0].positions;
          it.indices = it.parts[0].indices;
        }
        return it;
      });
    }

    /** 取单个零件用于示意绘制的网格：参数化几何现算，导入模型用内存缓存 */
    function fillPartMesh(proj, part) {
      var g = proj.geometry || {};
      if (!g.fileName) {
        try {
          var b = LG.Geometry.build(g);
          part.positions = b.positions; part.indices = b.indices;
        } catch (e) { /* 几何非法时该零件留空 */ }
      } else {
        var cached = LG.state.meshCache[proj.id];
        if (cached && cached.positions && cached.positions.length) {
          part.positions = cached.positions; part.indices = cached.indices;
        }
      }
    }

    /**
     * 恢复当前盘的导入模型。优先级：
     *   1. LG.state.meshCache[pid] —— 内存缓存（同一会话内切换盘位）
     *   2. proj.geometry._mesh      —— 持久化网格（刷新页面后兜底，由 importIntoProject 写入）
     * 返回 true 表示恢复成功。
     */
    function restoreCachedMesh(pid) {
      var proj = LG.Store.get(pid);
      if (!proj) return false;

      var cached = LG.state.meshCache[pid];
      if (!cached || !cached.positions || !cached.positions.length) {
        // 内存缓存没有，尝试从持久化 geometry._mesh 反序列化
        if (LG.restoreMeshFromProject) {
          LG.restoreMeshFromProject(proj);
        }
        cached = LG.state.meshCache[pid];
      }
      if (!cached || !cached.positions || !cached.positions.length) return false;

      LG.Viewer.setGeometryData(cached.positions, cached.indices, cached.name);
      var auto = LG.Viewer.autoEndCaps();
      // 端面优先沿用该盘已保存的选择，缺失时用自动识别结果
      var fin = (proj.faces && proj.faces.input && proj.faces.input.length) ? proj.faces.input : auto.input;
      var fout = (proj.faces && proj.faces.output && proj.faces.output.length) ? proj.faces.output : auto.output;
      // 端面缺失（如刚拖入的零件）时持久化自动识别结果，切过去即可直接跑仿真
      if (!(proj.faces && proj.faces.input && proj.faces.input.length) ||
          !(proj.faces && proj.faces.output && proj.faces.output.length)) {
        LG.Store.update(proj.id, { faces: { input: fin, output: fout } });
      }
      LG.state.mesh = {
        positions: cached.positions, indices: cached.indices,
        faceCount: LG.Viewer.faceCount(), name: cached.name, isParametric: false
      };
      LG.Viewer.setFaceHighlights(fin, fout);
      var tr = (proj.geometry && proj.geometry.transform) || { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 };
      LG.Viewer.setTransform(tr);
      LG.Viewer.setLED(proj.led);
      LG.Engine.refreshLEDPose();
      updateBadge();
      return true;
    }

    /** 盘结构变化后重建 3D 盘面（不改动相机，避免视角跳回） */
    function refreshPlates() {
      LG.Viewer.setPlates(plateItems(), p.id, plateTips());
      syncPlateToolbar();
    }

    /** 快捷控件的中英文提示（Viewer 只负责排版，不持有文案） */
    function plateTips() {
      return {
        del: LG.t('plate.del'), orient: LG.t('plate.orient'),
        lock: LG.t('plate.lock'), unlock: LG.t('plate.unlock'), order: LG.t('plate.order')
      };
    }

    function bindPlateToolbar() {
      $('plate-add').addEventListener('click', addPlate);
    }

    /** 顶部「共 N 盘」计数：按唯一 plateId 统计（一块盘可含多个零件） */
    function syncPlateToolbar() {
      var cnt = $('plate-count');
      if (!cnt) return;
      var keys = {}, n = 0, list = LG.Store.list();
      for (var i = 0; i < list.length; i++) {
        var k = LG.Store.plateIdOf(list[i]);
        if (!keys[k]) { keys[k] = 1; n++; }
      }
      cnt.textContent = LG.t('plate.count', n);
    }

    /** 盘右上角快捷控件：删除 / 调整朝向 / 锁定 / 前后位置（可作用于任意盘） */
    function onPlateTool(pid, act, btn) {
      if (!pid) return;
      if (act === 'del') deletePlate(pid);
      else if (act === 'lock') lockPlate(pid);
      else if (act === 'orient') openPlatePop(btn, orientPopHTML(), pid);
      else if (act === 'order') openPlatePop(btn, orderPopHTML(), pid);
    }

    function addPlate() {
      var name = prompt(LG.t('plate.add'), 'Project-' + new Date().toISOString().slice(5, 16).replace('T', ' '));
      if (name == null) return;
      var np = LG.Store.create(name.trim() || undefined);
      LG.state.project = np;
      prepareProjectView(np);
      LG.Router.rerender();
      LG.status(LG.t('plate.added', np.name));
    }

    function switchPlate(pid) {
      if (!pid || pid === p.id) return;
      LG.Store.setActive(pid);
      var proj = LG.Store.active();
      if (!proj) return;
      LG.state.project = proj;
      prepareProjectView(proj);
      LG.Router.rerender();
      LG.status(LG.t('plate.switched', proj.name));
    }

    /** 切盘后把该盘的几何同步到共享 Viewer（导入模型优先从内存缓存恢复） */
    function prepareProjectView(proj) {
      var g = proj.geometry || {};
      if (g.fileName) {
        if (LG.Viewer.clearGeometry) LG.Viewer.clearGeometry();
        LG.state.mesh = null;
        restoreCachedMesh(proj.id);
        return;
      }
      var built = LG.Geometry.build(g);
      LG.Viewer.setGeometryData(built.positions, built.indices, 'Parametric: ' + g.shape);
      var auto = LG.Viewer.autoEndCaps();
      LG.Store.updateActive({ faces: { input: auto.input, output: auto.output } });
      LG.state.mesh = {
        positions: built.positions, indices: built.indices,
        faceCount: LG.Viewer.faceCount(), name: 'Parametric: ' + g.shape, isParametric: true
      };
      LG.Viewer.setFaceHighlights(auto.input, auto.output);
      LG.Viewer.setTransform(g.transform || { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 });
      LG.Viewer.setLED(proj.led);
    }

    function deletePlate(pid) {
      var proj = LG.Store.get(pid);
      if (!proj) return;
      if (proj.locked) { LG.status(LG.t('plate.lockedHint')); return; }
      if (LG.Store.list().length <= 1) { LG.status(LG.t('plate.lastOne')); return; }
      if (!confirm(LG.t('plate.confirmDel', proj.name))) return;
      var wasActive = pid === p.id;
      LG.Store.remove(pid);
      delete LG.state.meshCache[pid];   // 盘删除后不再保留其导入网格
      if (wasActive) {
        var np = LG.Store.active();
        if (np) { LG.state.project = np; prepareProjectView(np); }
        LG.Viewer.clearRays();
      }
      LG.Router.rerender();
      LG.status(LG.t('plate.deleted', proj.name));
    }

    function lockPlate(pid) {
      var lk = LG.Store.toggleLock(pid);
      if (lk == null) return;
      var proj = LG.Store.get(pid);
      LG.status(lk ? LG.t('plate.locked', proj.name) : LG.t('plate.unlocked', proj.name));
      refreshPlates();
      if (pid === p.id) {
        var lay = document.querySelector('.layout');
        if (lay) lay.classList.toggle('plate-locked', !!lk);
      }
    }

    function applyOrient(pid, kind) {
      var proj = LG.Store.get(pid);
      if (!proj || proj.locked) return;
      var g = proj.geometry || (proj.geometry = LG.Store.defaults().geometry);
      var tr = Object.assign({ posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 }, g.transform || {});
      if (kind === 'reset') {
        tr.rotX = 0; tr.rotY = 0; tr.rotZ = 0;
      } else if (kind === 'flip') {
        tr.rotY = normDeg((tr.rotY || 0) + 180);
      } else {
        tr['rot' + kind] = normDeg((tr['rot' + kind] || 0) + 90);
      }
      g.transform = tr;
      LG.Store.update(pid, { geometry: g });
      if (pid === p.id) {
        p.geometry = g;
        LG.Viewer.setTransform(tr);
      }
      refreshPlates();
      LG.status(LG.t('plate.rotated', tr.rotX, tr.rotY, tr.rotZ));
    }

    function applyOrder(pid, kind) {
      var list = LG.Store.list(), idx = -1;
      for (var i = 0; i < list.length; i++) if (list[i].id === pid) { idx = i; break; }
      if (idx < 0) return;
      var to = idx;
      if (kind === 'up') to = idx - 1;
      else if (kind === 'down') to = idx + 1;
      else if (kind === 'top') to = 0;
      else if (kind === 'bottom') to = list.length - 1;
      if (LG.Store.move(pid, to)) {
        refreshPlates();
        LG.Viewer.fitView();
        LG.status(LG.t('plate.moved', LG.Store.get(pid).name, to + 1));
      }
    }

    function orientPopHTML() {
      return '<div class="pp-title">' + LG.t('plate.orient') + '</div>' +
        '<div class="pp-hint">' + LG.t('plate.orient.hint') + '</div>' +
        '<div class="pp-grid">' +
          '<button type="button" data-rot="X">' + LG.t('plate.rotX') + '</button>' +
          '<button type="button" data-rot="Y">' + LG.t('plate.rotY') + '</button>' +
          '<button type="button" data-rot="Z">' + LG.t('plate.rotZ') + '</button>' +
          '<button type="button" data-rot="flip">' + LG.t('plate.flip') + '</button>' +
          '<button type="button" data-rot="reset" class="pp-wide">' + LG.t('plate.reset') + '</button>' +
        '</div>';
    }
    function orderPopHTML() {
      return '<div class="pp-title">' + LG.t('plate.order') + '</div>' +
        '<div class="pp-grid">' +
          '<button type="button" data-order="up">↑ ' + LG.t('plate.order.up') + '</button>' +
          '<button type="button" data-order="down">↓ ' + LG.t('plate.order.down') + '</button>' +
          '<button type="button" data-order="top">' + LG.t('plate.order.top') + '</button>' +
          '<button type="button" data-order="bottom">' + LG.t('plate.order.bottom') + '</button>' +
        '</div>';
    }

    function openPlatePop(anchor, html, pid) {
      closePlatePop();
      var pop = document.createElement('div');
      pop.className = 'plate-pop';
      pop.setAttribute('data-pid', pid);
      pop.innerHTML = html;
      document.body.appendChild(pop);

      var r = anchor.getBoundingClientRect();
      var pw = pop.offsetWidth, ph = pop.offsetHeight;
      var left = r.right + 8;
      if (left + pw > window.innerWidth - 8) left = r.left - pw - 8;
      var top = r.top;
      if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
      pop.style.left = Math.max(8, left) + 'px';
      pop.style.top = Math.max(8, top) + 'px';

      pop.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.hasAttribute('data-rot')) applyOrient(pid, b.getAttribute('data-rot'));
        else if (b.hasAttribute('data-order')) applyOrder(pid, b.getAttribute('data-order'));
        closePlatePop();
        document.removeEventListener('mousedown', onPlateDocDown, true);
      });
      platePop = pop;
      setTimeout(function () { document.addEventListener('mousedown', onPlateDocDown, true); }, 0);
    }
    function closePlatePop() {
      if (platePop && platePop.parentNode) platePop.parentNode.removeChild(platePop);
      platePop = null;
    }
    function onPlateDocDown(e) {
      if (platePop && !platePop.contains(e.target)) {
        closePlatePop();
        document.removeEventListener('mousedown', onPlateDocDown, true);
      }
    }

    function renderSpecList(wl) {
      var host = $('m-spec-list');
      if (!host) return;
      var html = '';
      for (var i = 0; i < wl.length; i++) {
        var w = wl[i] || {};
        html += '<div class="spec-row" style="display:flex;gap:6px;align-items:center;margin-top:6px">' +
          '<input type="number" class="spec-nm" step="1" min="380" max="780" value="' + (w.nm != null ? w.nm : 550) + '" style="flex:1;min-width:0" title="' + LG.t('model.src.spec.nm') + '">' +
          '<input type="number" class="spec-w" step="0.1" min="0" value="' + (w.weight != null ? w.weight : 1) + '" style="flex:1;min-width:0" title="' + LG.t('model.src.spec.weight') + '">' +
          '<button class="btn btn-danger btn-sm" data-spec-del="' + i + '" type="button">✕</button>' +
          '</div>';
      }
      host.innerHTML = html;
    }
    function readSpecRows() {
      var rows = $('m-spec-list') ? $('m-spec-list').querySelectorAll('.spec-row') : [];
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        out.push({
          nm: parseFloat(rows[i].querySelector('.spec-nm').value) || 0,
          weight: Math.max(0, parseFloat(rows[i].querySelector('.spec-w').value) || 0)
        });
      }
      return out;
    }
    function syncSpecUI() {
      // 光谱 DOM 已隐藏，早返回
      if (!$('m-spec-en')) return;
      var on = $('m-spec-en').checked;
      var body = $('m-spec-body');
      if (body) { body.style.opacity = on ? 1 : 0.45; body.style.pointerEvents = on ? 'auto' : 'none'; }
    }

    function syncSrcTypeUI() {
      // 光源参数 DOM 已隐藏，早返回
      if (!$('m-stype')) return;
      var t = $('m-stype').value;
      var ledOn = $('m-led-en') && $('m-led-en').checked;
      $('m-stype-hint').textContent = LG.t('model.src.type.hint.' + t);
      var isPoint = (t === 'point');
      var modeField = $('m-mode').closest('.field');
      var angleField = $('m-angle').closest('.field');
      var posField = $('m-pos').closest('.field');
      var distField = $('m-sdist-field');
      var stypeField = $('m-stype').closest('.field');
      var ledHint = $('m-src-led-hint');
      if (ledOn) {
        if (ledHint) ledHint.style.display = '';
        $('m-stype-hint').style.display = 'none';
        stypeField.style.opacity = 0.45;
        $('m-stype').disabled = true;
        modeField.style.display = '';
        angleField.style.opacity = 1;
        posField.style.display = '';
        posField.style.opacity = 0.45;
        $('m-pos').disabled = true;
        $('m-pos-r').disabled = true;
        distField.style.opacity = 0.45;
        $('m-sdist').disabled = true;
        $('m-sdist-r').disabled = true;
      } else {
        if (ledHint) ledHint.style.display = 'none';
        $('m-stype-hint').style.display = '';
        stypeField.style.opacity = 1;
        $('m-stype').disabled = false;
        $('m-pos').disabled = false;
        $('m-pos-r').disabled = false;
        distField.style.opacity = 1;
        $('m-sdist').disabled = false;
        $('m-sdist-r').disabled = false;
        modeField.style.display = isPoint ? '' : 'none';
        angleField.style.opacity = isPoint ? 1 : 0.45;
        posField.style.display = isPoint ? 'none' : '';
        posField.style.opacity = 1;
      }
    }

    // ---- 卡片可收起：把 card-title 之后的内容包进 .card-body，标题加 chevron ----
    function enhanceCards(resets) {
      var cards = el.querySelectorAll('.card');
      cards.forEach(function (card) {
        var title = card.querySelector(':scope > .card-title');
        if (!title) return;
        // 包 body
        var body = document.createElement('div');
        body.className = 'card-body';
        while (title.nextSibling) body.appendChild(title.nextSibling);
        card.appendChild(body);
        // chevron
        var chev = document.createElement('span');
        chev.className = 'chev';
        title.appendChild(chev);
        title.addEventListener('click', function () { card.classList.toggle('collapsed'); });
        // 恢复默认
        var key = card.getAttribute('data-reset');
        if (key && resets[key]) {
          var foot = document.createElement('div');
          foot.className = 'card-foot';
          var btn = document.createElement('button');
          btn.className = 'reset-btn';
          btn.textContent = '↺ ' + LG.t('c.resetDefault');
          btn.addEventListener('click', function (e) { e.stopPropagation(); resets[key](); });
          foot.appendChild(btn);
          body.appendChild(foot);
        }
      });
    }

    // 表面处理与曲面：从表单读取并存入 geometry.surface（σ 已按预设解析为数值）
    function saveSurface() {
      var g2 = LG.state.project.geometry;
      var dIn = Math.max(0.2, parseFloat(g2.d1) || 3);
      var dOut = Math.max(0.2, parseFloat(g2.d2) || 3);
      var curveIn = $('m-scurve-in').value, curveOut = $('m-scurve-out').value;
      var surface = {
        inputTex: $('m-stex-in').value,
        inputSigma: texSigmaOf($('m-stex-in').value, $('m-ssig-in').value),
        inputCurve: curveIn,
        // R 钳制 ≥ 端面直径（边缘法线倾角 ≤30°，端面侦测与网格质量前提）
        inputCurveR: (curveIn === 'flat') ? (parseFloat($('m-scr-in').value) || 20) : Math.max(dIn, parseFloat($('m-scr-in').value) || dIn),
        outputTex: $('m-stex-out').value,
        outputSigma: texSigmaOf($('m-stex-out').value, $('m-ssig-out').value),
        outputCurve: curveOut,
        outputCurveR: (curveOut === 'flat') ? (parseFloat($('m-scr-out').value) || 20) : Math.max(dOut, parseFloat($('m-scr-out').value) || dOut),
        sideTex: $('m-stex-side').value,
        sideSigma: texSigmaOf($('m-stex-side').value, $('m-ssig-side').value),
        sideProfile: $('m-sprof').value,
        sideDeltaR: Math.min(2, Math.max(0, parseFloat($('m-sdr').value) || 0))
      };
      LG.Store.updateActive({ geometry: Object.assign({}, g2, { surface: surface }) });
    }
    function syncSurfaceUI() {
      // σ 仅在自定义时可编辑；R 仅在非平面时可编辑；Δr 仅在非直线轮廓时可编辑
      $('m-ssig-in').disabled = ($('m-stex-in').value !== 'custom');
      $('m-ssig-out').disabled = ($('m-stex-out').value !== 'custom');
      $('m-ssig-side').disabled = ($('m-stex-side').value !== 'custom');
      $('m-scr-in').disabled = ($('m-scurve-in').value === 'flat');
      $('m-scr-out').disabled = ($('m-scurve-out').value === 'flat');
      $('m-sdr').disabled = ($('m-sprof').value === 'straight');
      // 非自定义时把预设 σ 回填到输入框便于查看
      if ($('m-stex-in').value !== 'custom') $('m-ssig-in').value = texSigmaOf($('m-stex-in').value);
      if ($('m-stex-out').value !== 'custom') $('m-ssig-out').value = texSigmaOf($('m-stex-out').value);
      if ($('m-stex-side').value !== 'custom') $('m-ssig-side').value = texSigmaOf($('m-stex-side').value);
      // 导入网格：曲面/轮廓控件禁用（网格本身已含形状），咬花/雾面仍可用
      var hasFile = !!(LG.state.project.geometry && LG.state.project.geometry.fileName);
      ['m-scurve-in', 'm-scr-in', 'm-scurve-out', 'm-scr-out', 'm-sprof', 'm-sdr'].forEach(function (id) {
        var elx = $(id);
        if (!hasFile) elx.disabled = true;
      });
    }
    function syncLEDUI() {
      var on = $('m-led-en').checked;
      var body = $('m-led-body');
      if (body) { body.style.opacity = on ? 1 : 0.4; body.style.pointerEvents = on ? 'auto' : 'none'; }
      var type = $('m-led-type').value;
      // 正方形：隐藏宽度（宽度=长度）
      $('m-led-w-wrap').style.display = (type === 'square') ? 'none' : '';
      if (type === 'square') $('m-led-wid').value = $('m-led-len').value;
      // 凹面/凸面条件参数
      $('m-led-concave-wrap').style.display = (type === 'concave') ? '' : 'none';
      $('m-led-convex-wrap').style.display = (type === 'convex') ? '' : 'none';
      // LED 启用状态影响光源卡字段有效性（LED 接管时光源类型/位置 σ 失效）
      syncSrcTypeUI();
    }

    function syncMatLibUI() {
      var k = $('m-matlib').value;
      var d = $('m-matlib-desc');
      if (d) d.textContent = LG.t('matlib.' + k + '.d');
    }

    /** 材料库 → 光学预设（用户看不到 n / α） */
    function applyMatLib(key) {
      var lib = MATERIAL_LIB[key];
      if (!lib) return;                      // custom：保留用户手填值
      var parts = lib.preset.split(',');
      $('m-preset').value = lib.preset;
      $('m-n').value = parseFloat(parts[0]).toFixed(3);
      $('m-alpha').value = parseFloat(parts[1]);
      $('m-abbe').value = LG.Store.defaultAbbe(lib.preset);
      // 扩散料默认配中档匀光；用户已手动选过其它档位则不覆盖
      if (lib.diffuse && $('m-diff').value === 'none') { $('m-diff').value = 'mid'; syncDiffUI(); }
      saveMaterial();
      saveEng({ material: key });
    }

    function syncLedLibUI() {
      var k = $('m-ledlib').value;
      var dis = (k === 'none');
      $('m-led-level').disabled = dis;
      $('m-led-offx').disabled = dis;
      $('m-led-offy').disabled = dis;
    }

    /** LED 型号库 → 发光面尺寸 / 光通量（按亮度档位缩放）→ 灯珠模型 + 光源光通量 */
    function applyLedLib(key) {
      var lib = LED_LIB[key];
      var lv = LED_LEVEL[$('m-led-level').value] || 1;
      if (!lib) {
        $('m-led-en').checked = false;
        syncLEDUI(); saveLED();
        saveEng({ ledModel: key });
        return;
      }
      $('m-led-en').checked = true;
      $('m-led-type').value = 'rectangle';
      $('m-led-len').value = lib.length;
      $('m-led-wid').value = lib.width;
      $('m-led-hgt').value = lib.height;
      $('m-led-cr').value = $('m-led-cr').value || 0.6;
      syncLEDUI();
      saveLED();
      // 先保存 ledModel/ledLevel —— 即便后续 m-flux 等 DOM 已隐藏导致 saveSource 崩溃，选型也不丢
      saveEng({ ledModel: key, ledLevel: $('m-led-level').value });
      // 光通量：封装典型值 × 亮度档位（线性近似，用于亮度对比）。
      // m-flux DOM 已从 UI 移除（光源卡已隐藏），需先判空，避免 TypeError 中断后续保存。
      var fluxEl = $('m-flux');
      if (fluxEl) fluxEl.value = Math.round(lib.flux * lv * 10) / 10;
      saveSource();
    }

    /** 装配间隙 → led.gap（同一个物理量，界面只出现一次） */
    function syncGapToLED() {
      var gap = Math.max(0, Math.min(2, parseFloat($('m-asm-gap').value) || 0));
      saveEng({ assemblyGap: gap });
      saveLED();   // saveLED 内部已改从 m-asm-gap 读 gap
    }

    /** XY 偏移 → 只移动 LED 灯珠（沿入射面切线方向），不影响导光柱本体位姿 */
    function saveEngOffset() {
      var ox = Math.max(-2, Math.min(2, parseFloat($('m-led-offx').value) || 0));
      var oy = Math.max(-2, Math.min(2, parseFloat($('m-led-offy').value) || 0));
      saveEng({ offsetX: ox, offsetY: oy });
      // 只刷新 LED 位姿（导光柱几何不动）
      LG.Engine.refreshLEDPose();
      LG.Viewer.setLED(LG.state.project.led);
      // 偏移已变，旧光线轨迹失效（否则会看到光线停在原位、不跟随灯珠）
      LG.Viewer.clearRays();
    }

    function readGoals() {
      var t = {};
      GOAL_KEYS.forEach(function (k) { t[k] = $('m-goal-' + k).checked; });
      return t;
    }

    function saveEng(patch) {
      var cur = LG.state.project.eng || {};
      LG.Store.updateActive({ eng: Object.assign({}, cur, patch) });
    }

    /** 结构预审：在跑正式仿真之前，用当前结构参数给出可执行的工程预警 */
    function runPrecheck() {
      var p2 = LG.state.project;
      var g2 = p2.geometry || {}, sc2 = p2.scheme || {}, en2 = p2.eng || {};
      var d1 = Math.max(0.05, +g2.d1 || 3);
      var d2 = Math.max(0.05, +g2.d2 || 3);
      var L = Math.max(0.5, +g2.length || 30);
      var lib = LED_LIB[en2.ledModel];
      var scheme = sc2.type || 'straight';
      var items = [];

      if (!g2.fileName) {
        items.push({ lv: 'info', t: LG.t('pc.needImport') });
      }
      if (lib) {
        var emit = Math.max(lib.length, lib.width);
        if (d1 < emit) items.push({ lv: 'warn', t: LG.t('pc.ledTooBig', d1.toFixed(2), emit.toFixed(1)) });
      }

      var ratio = d2 / d1;
      if (ratio > 1.5 || ratio < 0.667) items.push({ lv: 'warn', t: LG.t('pc.taperBig', ratio.toFixed(2)) });

      if (scheme === 'bent') {
        var R = +sc2.bendR || 3;
        if (R < d1) items.push({ lv: 'warn', t: LG.t('pc.bendR', R.toFixed(1)) });
      }
      if (scheme !== 'plate') {
        var dr = +sc2.draftAngle;
        if (!(dr >= 1)) items.push({ lv: 'warn', t: LG.t('pc.draft', (dr || 0).toFixed(1)) });
        var sl = L / d1;
        if (sl > 15) items.push({ lv: 'warn', t: LG.t('pc.slender', sl.toFixed(1)) });
      }
      // 侧壁漏光仅对多灯珠 / 多根导光柱判断；单根导光柱不判断漏光
      var multiGuide = ((p2.beads || []).length > 1) || LG.Store.list().length > 1;
      if (multiGuide && en2.housing === 'black' && !en2.foam) items.push({ lv: 'warn', t: LG.t('pc.leak') });
      if (en2.housing === 'white' && en2.targets && en2.targets.crosstalk) items.push({ lv: 'warn', t: LG.t('pc.whiteCross') });

      var warns = 0;
      var html = '';
      for (var i = 0; i < items.length; i++) if (items[i].lv === 'warn') warns++;
      html += warns
        ? '<div class="pc-sum">⚠ ' + LG.t('model.precheck.risk', warns) + '</div>'
        : '<div class="pc-ok">✓ ' + LG.t('model.precheck.pass') + '</div>';
      for (var j = 0; j < items.length; j++) {
        html += '<div class="pc-item ' + items[j].lv + '"><span class="pc-dot">' + (items[j].lv === 'warn' ? '!' : 'i') + '</span><span>' + items[j].t + '</span></div>';
      }
      $('m-precheck-body').innerHTML = html;
      $('m-precheck').style.display = '';
      saveEng({ checkedAt: Date.now() });
      LG.status(LG.t('model.precheck.title') + ' · ' + (warns ? (warns + ' ⚠') : '✓'));
    }
    function saveTransform() {
      // transform DOM 已隐藏，早返回（onTransformChange 里直接写 store）
      if (!$('m-px')) return;
      var tr = {
        posX: parseFloat($('m-px').value) || 0,
        posY: parseFloat($('m-py').value) || 0,
        posZ: parseFloat($('m-pz').value) || 0,
        rotX: parseFloat($('m-rx').value) || 0,
        rotY: parseFloat($('m-ry').value) || 0,
        rotZ: parseFloat($('m-rz').value) || 0
      };
      var g2 = LG.state.project.geometry;
      LG.Store.updateActive({ geometry: Object.assign({}, g2, { transform: tr }) });
      LG.Viewer.setTransform(tr);
    }
    function saveLED() {
      var type = $('m-led-type').value;
      var len = Math.max(0.3, parseFloat($('m-led-len').value) || 3);
      var wid = (type === 'square') ? len : Math.max(0.3, parseFloat($('m-led-wid').value) || 2);
      var led = {
        enabled: $('m-led-en').checked,
        type: type,
        length: len,
        width: wid,
        height: Math.max(0.3, parseFloat($('m-led-hgt').value) || 1.5),
        gap: Math.max(0, parseFloat($('m-asm-gap').value) || 0.1),
        concaveDepth: Math.min(Math.max(0.1, parseFloat($('m-led-cd').value) || 0.4), 1.0),
        convexRadius: Math.min(Math.max(0.2, parseFloat($('m-led-cr').value) || 0.6), 5.0)
      };
      LG.Store.updateActive({ led: led });
      // LED 启用状态/参数变化后刷新位姿（导入模型 + 启用时按入射面重算，否则回退默认）
      LG.Engine.refreshLEDPose();
    }
    // 匀光档位说明：直接告诉结构工程师“更匀”的代价（总光效/侧漏）
    function syncDiffUI() {
      var d = $('m-diff').value, el = $('m-diff-desc');
      if (el) el.textContent = LG.t('model.mat.diff.' + d + '.d');
    }
    function saveMaterial() {
      LG.Store.updateActive({
        material: {
          preset: $('m-preset').value,
          n: parseFloat($('m-n').value) || 1.49,
          alpha: Math.max(0, parseFloat($('m-alpha').value) || 0),
          abbe: Math.max(0, parseFloat($('m-abbe').value) || 0),
          diffusion: $('m-diff').value
        }
      });
    }
    function saveSource() {
      // source DOM 已隐藏，早返回
      if (!$('m-stype')) return;
      LG.Store.updateActive({
        source: {
          type: $('m-stype').value,
          mode: $('m-mode').value,
          flux: parseFloat($('m-flux').value) || 0,
          wavelength: parseFloat($('m-wl').value) || 555,
          angleSigma: parseFloat($('m-angle').value) || 0,
          posSigma: parseFloat($('m-pos').value) || 0,
          srcDist: Math.min(50, Math.max(0, parseFloat($('m-sdist').value) || 0)),
          numRays: Math.max(10, parseInt($('m-rays').value) || 1000),
          maxBounces: Math.max(3, parseInt($('m-bounces').value) || 30),
          spectrum: {
            enabled: $('m-spec-en').checked,
            preset: $('m-spec-preset').value,
            wavelengths: readSpecRows().filter(function (w) { return w.nm > 0; })
          }
        }
      });
    }
    function updateBadge() {
      var p2 = LG.state.project;
      $('model-badge').textContent = LG.t('c.facesSet', (p2.faces.input || []).length, (p2.faces.output || []).length);
    }
    /** 删除当前盘上的零件：清空 3D 网格与几何记录，盘与其它参数保留 */
    function removeSelectedPart() {
      var p = LG.state.project;
      if (!p) return;
      if (p.locked) { LG.status(LG.t('plate.lockedHint')); return; }
      LG.Viewer.clearGeometry();
      LG.state.mesh = null;
      if (p.id != null && LG.state.meshCache) delete LG.state.meshCache[p.id];
      LG.Store.updateActive({
        geometry: Object.assign({}, p.geometry, { fileName: '' }),
        faces: { input: [], output: [] }
      });
      if ($('m-file-info')) $('m-file-info').textContent = '';
      if ($('model-badge')) $('model-badge').textContent = LG.t('model.needImport');
      LG.status(LG.t('model.msg.removed'));
    }

    // ---- 文件导入（解析与落库统一走 app.js 的 LG.parsePartFile / LG.importIntoProject）----
    function loadFile(file) {
      LG.status('Loading ' + file.name + ' ...');
      LG.parsePartFile(file, function (err, parsed) {
        if (err || !parsed) {
          LG.status(LG.t('model.msg.fail') + (err && err.message ? ': ' + err.message : ''));
          return;
        }
        applyImported(parsed);
      });
    }
    function applyImported(parsed) {
      $('m-file-info').textContent = parsed.name;
      LG.importIntoProject(LG.state.project.id, parsed);
      updateBadge();
      LG.status(LG.t('model.msg.loaded', parsed.name, LG.Viewer.faceCount()));
    }
  }

  window.LG = window.LG || {};
  LG.Modules = LG.Modules || {};
  LG.LED_LIB = LED_LIB; // 供报告 / 项目对比复用 LED 型号尺寸
  LG.Modules.model = { render: render };
})();
