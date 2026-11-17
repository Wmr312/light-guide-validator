/**
 * LG.Options — 顶栏「选项」：模型配置卡片显隐 + 参数帮助开关 + 使用说明入口。
 * 偏好存 localStorage（lgv.ui.*），模型页渲染时通过 afterRender() 应用。
 */
(function () {
  'use strict';
  var K_HIDE = 'lgv.ui.hiddenSections';
  var K_TIPS = 'lgv.ui.showTips';

  // 模型配置页的 6 张设置卡片（id 与 model.js 中 data-sec 一致）
  var SECTIONS = [
    { id: 'build',   key: 'model.file.title' },
    { id: 'mat',     key: 'model.matlib' },
    { id: 'surface', key: 'model.surface' },
    { id: 'led',     key: 'model.ledlib' },
    { id: 'env',     key: 'model.env' },
    { id: 'goals',   key: 'model.goals' }
  ];

  // 控件 id → help.* 文案（含义 / 目的 / 建议）
  var HELP_MAP = {
    'm-file-btn': 'help.import',
    'm-asm-gap': 'help.ledGap',
    'm-ledlib': 'help.ledlib',
    'm-led-level': 'help.ledLevel',
    'm-led-offx': 'help.ledOff',
    'm-led-offy': 'help.ledOff',
    'm-preset': 'help.preset', 'm-n': 'help.n', 'm-alpha': 'help.alpha',
    'm-led-en': 'help.ledEn', 'm-led-type': 'help.ledType',
    'm-led-len': 'help.ledLen', 'm-led-wid': 'help.ledWid', 'm-led-hgt': 'help.ledHgt',
    'm-led-cd': 'help.ledCd', 'm-led-cr': 'help.ledCr',
    'm-stex-in': 'help.texEn', 'm-stex-out': 'help.texEn', 'm-stex-side': 'help.texEn',
    'm-rays': 'help.rays', 'm-bounces': 'help.bounces'
  };

  function getHidden() {
    try { var v = JSON.parse(localStorage.getItem(K_HIDE)); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function setHidden(arr) {
    try { localStorage.setItem(K_HIDE, JSON.stringify(arr)); } catch (e) { /* quota */ }
  }
  function tipsOn() {
    var v = localStorage.getItem(K_TIPS);
    return v === null ? true : v === '1';
  }
  function setTips(on) {
    try { localStorage.setItem(K_TIPS, on ? '1' : '0'); } catch (e) { /* quota */ }
  }

  // ---- 参数帮助：给字段 label 挂 data-tip 与 ? 图标 ----
  function applyTips(root) {
    var fields = root.querySelectorAll('.card .field, .card .checkline');
    fields.forEach(function (f) {
      var ctl = f.querySelector('input, select');
      if (!ctl || !ctl.id) return;
      var hk = HELP_MAP[ctl.id];
      if (!hk) return;
      var label = f.querySelector('label');
      if (!label || label.getAttribute('data-tip')) return;
      var txt = LG.t(hk);
      label.setAttribute('data-tip', txt);
      if (tipsOn() && !label.querySelector('.tip-q')) {
        var q = document.createElement('span');
        q.className = 'tip-q';
        q.textContent = '?';
        label.appendChild(q);
      }
    });
  }
  function clearTips(root) {
    root.querySelectorAll('.tip-q').forEach(function (q) { q.remove(); });
    root.querySelectorAll('label[data-tip]').forEach(function (l) { l.removeAttribute('data-tip'); });
  }

  // ---- 模型页每次渲染后调用：应用隐藏卡片 + 帮助提示 ----
  function afterRender(el) {
    var hidden = getHidden();
    el.querySelectorAll('.card[data-sec]').forEach(function (card) {
      card.style.display = (hidden.indexOf(card.getAttribute('data-sec')) >= 0) ? 'none' : '';
    });
    clearTips(el);
    if (tipsOn()) applyTips(el);
  }

  // ---- 选项弹窗 ----
  var mask = null;
  function onEsc(e) { if (e.key === 'Escape') close(); }

  function build() {
    mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.id = 'opts-mask';
    var hidden = getHidden();
    var h = '<div class="modal" role="dialog" aria-modal="true" aria-label="' + LG.t('opts.title') + '">';
    h += '<div class="modal-head"><b>' + LG.t('opts.title') + '</b><button class="modal-x" id="opts-x" title="' + LG.t('c.close') + '">✕</button></div>';
    h += '<div class="modal-sec-t">' + LG.t('opts.modelSecs') + '</div>';
    h += '<div class="hint">' + LG.t('opts.modelSecsHint') + '</div>';
    h += '<div class="opts-list">';
    SECTIONS.forEach(function (s) {
      var on = hidden.indexOf(s.id) === -1;
      h += '<label class="opts-row"><input type="checkbox" data-sec="' + s.id + '"' + (on ? ' checked' : '') + '><span>' + LG.t(s.key) + '</span></label>';
    });
    h += '</div>';
    h += '<div class="modal-sec-t">' + LG.t('opts.tips') + '</div>';
    h += '<label class="opts-row"><input type="checkbox" id="opts-tips"' + (tipsOn() ? ' checked' : '') + '><span>' + LG.t('opts.tipsHint') + '</span></label>';
    h += '<div class="modal-foot">';
    h += '<button class="btn btn-ghost btn-sm" id="opts-manual">📖 ' + LG.t('opts.manual') + '</button>';
    h += '<button class="btn btn-primary btn-sm" id="opts-close">' + LG.t('c.close') + '</button>';
    h += '</div></div>';
    mask.innerHTML = h;
    document.body.appendChild(mask);

    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    mask.querySelector('#opts-x').addEventListener('click', close);
    mask.querySelector('#opts-close').addEventListener('click', close);
    mask.querySelector('#opts-manual').addEventListener('click', function () {
      window.open('docs/user-guide.html', '_blank');
    });
    mask.querySelectorAll('input[data-sec]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var next = [];
        mask.querySelectorAll('input[data-sec]').forEach(function (c2) {
          if (!c2.checked) next.push(c2.getAttribute('data-sec'));
        });
        setHidden(next);
        applyToModelPage();
      });
    });
    mask.querySelector('#opts-tips').addEventListener('change', function () {
      setTips(this.checked);
      applyToModelPage();
    });
    document.addEventListener('keydown', onEsc);
  }

  function applyToModelPage() {
    if (location.hash.indexOf('#/model') === 0 && LG.Router && LG.Router.rerender) LG.Router.rerender();
  }

  function open() {
    if (!mask) build();
    mask.classList.add('show');
  }
  function close() {
    if (mask) mask.classList.remove('show');
  }

  function init() {
    var btn = document.getElementById('opts-btn');
    if (btn) btn.addEventListener('click', open);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  LG.Options = {
    getHidden: getHidden, setHidden: setHidden,
    tipsOn: tipsOn, setTips: setTips,
    afterRender: afterRender,
    open: open, close: close
  };
})();
