/**
 * LG.Router — hash 路由 (#/model 等)。模块注册 { render(el) -> cleanupFn|undefined }
 */
(function () {
  'use strict';
  var routes = {};
  var cleanup = null;
  var current = 'model';

  function register(name, mod) { routes[name] = mod; }

  function navigate() {
    var h = (location.hash || '').replace(/^#\/?/, '') || 'model';
    var name = h.split('?')[0];
    var mod = routes[name] || routes.model;
    current = routes[name] ? name : 'model';
    if (cleanup) { try { cleanup(); } catch (e) { console.warn('route cleanup', e); } }
    cleanup = null;
    var view = document.getElementById('view');
    view.innerHTML = '';
    var items = document.querySelectorAll('#main-nav .nav-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].getAttribute('href') === '#/' + current);
    }
    try {
      cleanup = mod.render(view) || null;
    } catch (err) {
      console.error('route render failed:', err);
      view.innerHTML = '<div class="card" style="margin:24px"><div class="card-title">Error</div><p>' + err.message + '</p></div>';
    }
  }

  function init() {
    window.addEventListener('hashchange', navigate);
    navigate();
  }

  /** 语言切换时重渲染当前路由（保持 hash 不变） */
  function rerender() { navigate(); }

  window.LG = window.LG || {};
  LG.Router = { register: register, init: init, current: function () { return current; }, rerender: rerender };
})();
