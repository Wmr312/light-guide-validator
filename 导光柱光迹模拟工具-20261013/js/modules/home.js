/**
 * LG.Modules.home — Home / 启动页
 * 项目列表（新建 / 打开 / 重命名 / 删除 / 导出 / 导入 JSON）
 * 入口：顶部导航 Home 或 hash #/home
 */
(function () {
  'use strict';

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    var y = d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '-';
    return y + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ---- 3D 实物预览：共享离屏 WebGLRenderer + Three.js 真实渲染 ----
  // 参数化项目：LG.Geometry.build → BufferGeometry → 归一化 → MeshPhongMaterial + 边线
  // 导入模型：退化到 canvas 2D 简化方块 + 文件名（home 页不重新解析 STEP/STL）
  var offRenderer = null, offScene = null, offCamera = null, offMesh = null;

  function ensureOffscreen() {
    if (offRenderer) return;
    var TH = window.THREE;
    if (!TH) return;
    offRenderer = new TH.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    offRenderer.setPixelRatio(1);  // 低分辨率即可（卡片 canvas 本身就小）
    offScene = new TH.Scene();
    offScene.background = new TH.Color(0x0d1b2a);
    // 斜视角相机（偏右上 45° 俯视）
    offCamera = new TH.PerspectiveCamera(45, 1, 0.01, 1000);
    offCamera.position.set(3.2, 2.6, 3.2);
    offCamera.lookAt(0, 0, 0);
    // 灯光：跟主 viewer 一致
    offScene.add(new TH.AmbientLight(0xffffff, 0.7));
    var d1 = new TH.DirectionalLight(0xffffff, 0.8); d1.position.set(5, 10, 7); offScene.add(d1);
    var d2 = new TH.DirectionalLight(0x88aaff, 0.3); d2.position.set(-4, -2, -4); offScene.add(d2);
  }

  function disposeOffscreen() {
    if (offMesh) { offScene.remove(offMesh); offMesh.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); offMesh = null; }
  }

  // 参数化几何体 → THREE.BufferGeometry（从 mm 轴向 Z：0→L 归一化到世界中心，旋转 Z 轴对齐水平）
  function buildParametricMesh(g) {
    var TH = window.THREE;
    var d1 = Math.max(0.4, +g.d1 || 3);
    var d2 = Math.max(0.4, +g.d2 || d1);
    var L = Math.max(1, +g.length || 30);

    // 按最短边（直径）缩放，确保圆柱粗细在画面里有足够像素
    var maxCross = Math.max(d1, d2);
    var scaleByDia = 0.9 / maxCross;   // 直径缩放到 ~0.9 单位
    var scaleByLen = 2.0 / L;          // 长度缩放到 ~2.0 单位
    var scale = Math.min(scaleByDia, scaleByLen);
    if (scale > 1.5) scale = 1.5;
    if (scale < 0.01) scale = 0.01;

    // 标准 CylinderGeometry（绕 Y 轴）→ 旋转到 Z 轴（LG.Geometry 默认轴向）
    var geo = new TH.CylinderGeometry(d1 / 2 * scale, d2 / 2 * scale, L * scale, 48, 1, false);
    geo.rotateX(Math.PI / 2);          // Y → Z
    geo.computeBoundingBox();

    // 居中
    var size = new TH.Vector3(); var center = new TH.Vector3();
    geo.boundingBox.getSize(size); geo.boundingBox.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z);

    // 旋转：Z(长度) → X(水平)，再绕 Z 倾斜 30°，让长度在画面里斜向展开，两端端面可见
    geo.rotateY(-Math.PI / 2);
    geo.rotateZ(Math.PI / 6);

    // 材质：跟主 viewer 统一（半透明青绿色）
    var mat = new TH.MeshPhongMaterial({
      color: 0x218D83, transparent: true, opacity: 0.5, depthWrite: false,
      side: TH.DoubleSide, shininess: 45, specular: 0x0A0A0A
    });
    var mesh = new TH.Mesh(geo, mat);
    // 边线
    var wire = new TH.LineSegments(
      new TH.EdgesGeometry(geo, 8),
      new TH.LineBasicMaterial({ color: 0x136B63, transparent: true, opacity: 0.75, depthTest: false })
    );
    mesh.add(wire);
    mesh.renderOrder = 1;
    return mesh;
  }

  // 导入模型：用真实网格（如果 meshCache 或 geometry._mesh 可用）渲染 3D，
  // 否则退化为 canvas 2D 简化方块占位。
  function buildImportedMesh(proj) {
    var TH = window.THREE;
    // 优先取内存缓存（已反序列化好的 TypedArray），否则从持久化 geometry._mesh 反序列化
    var cached = LG.state.meshCache[proj.id];
    if (!cached || !cached.positions || !cached.positions.length) {
      if (LG.restoreMeshFromProject) LG.restoreMeshFromProject(proj);
      cached = LG.state.meshCache[proj.id];
    }
    if (!cached || !cached.positions || !cached.positions.length) return null;

    var geo = new TH.BufferGeometry();
    geo.setAttribute('position', new TH.BufferAttribute(cached.positions, 3));
    if (cached.indices && cached.indices.length) geo.setIndex(new TH.BufferAttribute(cached.indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    // 归一化到 ~2.0 单位立方体内，确保 home 预览里大小一致
    var bb = geo.boundingBox;
    var size = new TH.Vector3(); bb.getSize(size);
    var maxDim = Math.max(size.x, size.y, size.z, 0.01);
    var scale = 2.0 / maxDim;
    var center = new TH.Vector3(); bb.getCenter(center);
    geo.translate(-center.x * scale, -center.y * scale, -center.z * scale);
    geo.scale(scale, scale, scale);
    geo.computeBoundingBox();

    // 旋转：Z(长度) → X(水平)，再绕 Z 倾斜 30°
    var bb2 = new TH.Box3().setFromBufferAttribute(geo.attributes.position);
    var size2 = new TH.Vector3(); bb2.getSize(size2);
    // 让 mesh 的最长轴对齐 X 轴
    var rotY = 0;
    if (size2.z > size2.x) rotY = -Math.PI / 2;
    if (rotY) geo.rotateY(rotY);
    geo.rotateZ(Math.PI / 6);
    geo.computeBoundingBox();

    var mat = new TH.MeshPhongMaterial({
      color: 0x218D83, transparent: true, opacity: 0.5, depthWrite: false,
      side: TH.DoubleSide, shininess: 45, specular: 0x0A0A0A
    });
    var mesh = new TH.Mesh(geo, mat);
    var wire = new TH.LineSegments(
      new TH.EdgesGeometry(geo, 15),
      new TH.LineBasicMaterial({ color: 0x136B63, transparent: true, opacity: 0.75, depthTest: false })
    );
    mesh.add(wire);
    mesh.renderOrder = 1;
    return mesh;
  }

  // canvas 2D 简化方块占位（持久化网格不可用时的兜底）
  function drawImportedPlaceholder(canvas, fileName) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#0d1b2a'); grad.addColorStop(1, '#1b263b');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

    var cx = W / 2, cy = H / 2 + 4;
    var bw = Math.min(W, H) * 0.36; var bh = bw * 0.68;
    ctx.lineWidth = 1.5;
    ctx.fillStyle = '#136B63'; ctx.strokeStyle = '#06C864';
    ctx.beginPath(); ctx.moveTo(cx - bw, cy - bh); ctx.lineTo(cx - bw * 1.3, cy - bh + bw * 0.45);
    ctx.lineTo(cx - bw * 0.3, cy + bw * 0.45); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#15998B';
    ctx.beginPath(); ctx.moveTo(cx - bw, cy - bh); ctx.lineTo(cx - bw * 1.3, cy - bh + bw * 0.45);
    ctx.lineTo(cx + bw * 0.7, cy - bh + bw * 0.45); ctx.lineTo(cx, cy - bh); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#0E584F';
    ctx.beginPath(); ctx.moveTo(cx, cy - bh); ctx.lineTo(cx + bw * 0.7, cy - bh + bw * 0.45);
    ctx.lineTo(cx + bw * 0.7, cy + bw * 0.45); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill(); ctx.stroke();

    var base = (fileName || '').replace(/\\/g, '/');
    var short = base.split('/').pop() || 'model';
    if (short.length > 16) short = short.slice(-14);
    ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.fillText(short, cx, H - 6);
  }

  // 真正的入口：为每张卡片 canvas 渲染 3D 实物
  function renderPreview(canvas, project) {
    var TH = window.THREE;
    if (!TH) { drawImportedPlaceholder(canvas, (project.geometry || {}).fileName); return; }

    var g = project.geometry || {};
    ensureOffscreen();
    if (!offRenderer) { drawImportedPlaceholder(canvas, g.fileName); return; }

    var mesh = null;
    if (g.fileName) {
      // 导入模型：优先用真实网格，不可用时才退化为占位图
      try { mesh = buildImportedMesh(project); } catch (e) { mesh = null; }
      if (!mesh) { drawImportedPlaceholder(canvas, g.fileName); return; }
    } else {
      // 参数化模型：直接构建
      try { mesh = buildParametricMesh(g); } catch (e) { mesh = null; }
      if (!mesh) { drawImportedPlaceholder(canvas, ''); return; }
    }

    try {
      disposeOffscreen();
      offMesh = mesh;
      offScene.add(offMesh);

      var W = canvas.width, H = canvas.height;
      offRenderer.setSize(W, H, false);
      var bb = new TH.Box3().setFromObject(offMesh);
      var size = new TH.Vector3(); bb.getSize(size);
      var maxDim = Math.max(size.x, size.y, size.z, 0.1);
      var camDist = maxDim * 2.2;
      offCamera.position.set(camDist * 0.85, camDist * 0.95, camDist * 0.55);
      offCamera.lookAt(0, 0, 0);
      offCamera.fov = 50;
      offCamera.aspect = W / H;
      offCamera.updateProjectionMatrix();
      offRenderer.render(offScene, offCamera);

      var cardCtx = canvas.getContext('2d');
      cardCtx.clearRect(0, 0, W, H);
      cardCtx.drawImage(offRenderer.domElement, 0, 0);
    } catch (e) {
      console.warn('[home] 预览渲染失败', e);
      drawImportedPlaceholder(canvas, g.fileName || '');
    } finally {
      disposeOffscreen();
    }
  }

  function t(key, fallback) {
    var fn = (window.LG && LG.i18n && LG.i18n.t) ? LG.i18n.t : null;
    return fn ? fn(key) : (fallback || key);
  }

  function refreshProjectIntoView() {
    if (window.LG && LG.state) LG.state.project = LG.Store.active();
  }

  function render() {
    refreshProjectIntoView();
    var list = LG.Store.list();
    var active = LG.Store.active();

    var html = '<section class="home-page">'
      + '<div class="home-hero">'
      + '<h1>' + t('home.title', '导光柱验证平台') + '</h1>'
      + '<p class="home-sub">' + t('home.sub', '管理你的导光板设计项目，选择一个项目继续，或新建一个') + '</p>'
      + '<div class="home-actions">'
      + '<button id="home-new" class="btn btn-primary">+ ' + t('home.new', '新建项目') + '</button>'
      + '<button id="home-import" class="btn">' + t('home.import', '导入文件') + '</button>'
      + '<button id="home-export-all" class="btn">' + t('home.exportAll', '全部导出') + '</button>'
      + '</div>'
      + '</div>';

    if (!list.length) {
      html += '<div class="home-empty">'
        + '<div class="home-empty-icon">📁</div>'
        + '<p>' + t('home.empty', '还没有项目，点击上方按钮创建第一个项目') + '</p>'
        + '</div>';
    } else {
      html += '<div class="home-grid">';
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var isActive = active && active.id === p.id;
        html += '<div class="home-card' + (isActive ? ' is-active' : '') + '" data-id="' + p.id + '">'
          + '<div class="home-card-head">'
          + '<span class="home-card-lock" title="' + t('home.lockedTip', '已锁定') + '">' + (p.locked ? '🔒' : '') + '</span>'
          + '<span class="home-card-name">' + (p.name || t('home.untitled', '未命名项目')) + '</span>'
          + (isActive ? '<span class="home-card-badge">' + t('home.current', '当前') + '</span>' : '')
          + '</div>'
          + '<div class="home-card-meta">'
          + '<span>📐 ' + (p.geometry && p.geometry.fileName ? p.geometry.fileName : (
              (p.geometry && p.geometry.shape) ? ('param:' + p.geometry.shape) : '-')) + '</span>'
          + '<span>📊 ' + ((p.records && p.records.length) || 0) + ' ' + t('home.runs', '次仿真') + '</span>'
          + '</div>'
          + '<div class="home-card-time">' + fmtTime(p.updatedAt || p.createdAt) + '</div>'
          + '<div class="home-card-actions">'
          + '<button class="home-act home-act-open" data-act="open">' + t('home.open', '打开') + '</button>'
          + '<button class="home-act home-act-rename" data-act="rename">' + t('home.rename', '重命名') + '</button>'
          + '<button class="home-act home-act-export" data-act="export">' + t('home.export', '导出') + '</button>'
          + '<button class="home-act home-act-del" data-act="del" ' + (p.locked ? 'disabled' : '') + '>' + t('home.delete', '删除') + '</button>'
          + '</div>'
          + '<canvas class="home-preview" width="240" height="90" data-id="' + p.id + '"></canvas>'
          + '</div>';
      }
      html += '</div>';
    }
    html += '</section>';

    document.getElementById('view').innerHTML = html;
    bind(list);
  }

  function bind(list) {
    var $ = function (id) { return document.getElementById(id); };

    $('home-new').addEventListener('click', function () {
      var name = prompt(t('home.newName', '输入新项目名称'), '');
      if (name === null) return;
      var p = LG.Store.create(name && name.trim() ? name.trim() : undefined);
      refreshProjectIntoView();
      location.hash = '#/model';
    });

    $('home-import').addEventListener('click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var n = LG.Store.importJSON(reader.result);
            refreshProjectIntoView();
            alert(t('home.importOk', '已导入 {n} 个项目').replace('{n}', n));
            render();
          } catch (e) {
            alert(t('home.importFail', '导入失败：') + e.message);
          }
        };
        reader.readAsText(f);
      });
      input.click();
    });

    $('home-export-all').addEventListener('click', function () {
      if (!LG.Store.list().length) { alert(t('home.empty', '还没有项目')); return; }
      LG.Store.exportJSON();
    });

    // 卡片点击
    var cards = document.querySelectorAll('.home-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener('click', function (e) {
        var actBtn = e.target.closest('.home-act');
        var id = this.getAttribute('data-id');
        if (actBtn) {
          e.stopPropagation();
          var act = actBtn.getAttribute('data-act');
          handleCardAct(id, act);
          return;
        }
        openProject(id);
      });
    }

    // 渲染卡片 3D 预览（canvas 2D）
    var previews = document.querySelectorAll('.home-preview');
    for (var pi = 0; pi < previews.length; pi++) {
      var cv = previews[pi];
      var pid = cv.getAttribute('data-id');
      var proj = LG.Store.get(pid);
      if (proj) renderPreview(cv, proj);
    }
  }

  function openProject(id) {
    LG.Store.setActive(id);
    refreshProjectIntoView();
    location.hash = '#/model';
  }

  function handleCardAct(id, act) {
    var p = LG.Store.get(id);
    if (!p) return;
    if (act === 'open') {
      openProject(id);
    } else if (act === 'rename') {
      var name = prompt(t('home.renameName', '重命名项目'), p.name || '');
      if (name === null) return;
      name = name.trim();
      if (!name) return;
      LG.Store.rename(id, name);
      render();
    } else if (act === 'export') {
      // 导出单个项目：临时抽出 projects=[p] 调 exportJSON，再还原
      var blobP = { app: 'light-guide-validator', version: 1, projects: [p] };
      var blob = new Blob([JSON.stringify(blobP, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (p.name || 'project') + '.lgv.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    } else if (act === 'del') {
      if (p.locked) { alert(t('home.lockedDel', '项目已锁定，无法删除')); return; }
      if (!confirm(t('home.delConfirm', '确定删除「{name}」吗？此操作无法撤销').replace('{name}', p.name || ''))) return;
      LG.Store.remove(id);
      refreshProjectIntoView();
      render();
    }
  }

  window.LG = window.LG || {};
  LG.Modules = LG.Modules || {};
  LG.Modules.home = { render: render };
})();
