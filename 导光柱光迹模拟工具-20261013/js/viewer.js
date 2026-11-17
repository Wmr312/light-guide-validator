/**
 * LG.Viewer — 共享 3D 视图单例（Three.js r137）
 * mount(slot) 可在多个路由间移动同一 renderer；几何以 mm 原始数据接入（引擎用），
 * 显示时仅做视觉归一化；提供端面高亮 / 平面拾取 / 光线可视化 / 截图。
 */
(function () {
  'use strict';
  var inited = false;
  var scene, camera, renderer, controls;
  var mesh = null, meshGeometry = null;
  var raw = { positions: null, indices: null, name: '' };
  var faces = [], faceNormals = [], faceCenters = [], faceAreas = [];
  var adjacency = new Map();
  var highlights = { input: null, output: null };
  var rayLines = null;
  var spotPlane = null;   // 出射光斑截面（虚拟探测屏）
  var lastSpotProj = null; // 最近一次光斑投影数据：零件位姿变化后按新位姿重建截面
  var ledMesh = null;
  var ledParams = null;
  var gridHelper = null;   // 单盘模式的地面网格；多盘铺开后由各盘自带的网格纹理取代
  // ---- 零件选中与操作模式 ----
  var partBBox = null;            // 选中边界框（白框，挂 mesh 下）
  var partSelected = false;       // 当前 mesh 是否被选中
  var opMode = '';                // 当前操作模式：'' | 'move' | 'rotate' | 'place'
  var opGroup = null;             // 操作 gizmo 组（挂 mesh 下，随 mesh 变换）
  var opMoveArrows = null;        // 移动模式：XYZ 轴向箭头
  var opRotateRings = null;       // 旋转模式：XYZ 圆环
  var opRotateMidline = null;     // 旋转模式：米字线（8 个方向）
  var opRotateAxis = null;        // 旋转模式：当前激活的旋转轴 'x'|'y'|'z'
  var opPlaceFaces = null;        // 放置模式：6 个透明仿真面
  var opPlaceSelected = -1;       // 放置模式：当前高亮的面索引（-1=未选）
  // 交互状态：拖拽进行中
  var dragState = null;
  /** mm→display 归一化变换（setGeometryData 中设置，showRays 中使用） */
  var xform = { cx: 0, cy: 0, cz: 0, scale: 1 };
  var raycaster = new THREE.Raycaster();
  var mouse = new THREE.Vector2();
  var pickRole = null, onPick = null;
  // ---- 盘（Plate）：3D 主窗口内直接铺开的多盘布局 ----
  // 每行最多 4 块盘，超出后换行向下排布；盘间距要容纳盘右侧的快捷控件列，避免相互压叠
  var PLATE_W = 50, PLATE_D = 50, PLATE_GAP = 12, PLATE_COLS = 4;
  var plateLayer = null, plates = [], plateActiveId = null, platePickCb = null;
  // 同盘其它零件的示意网格（供点击切换项目）
  var platePartMeshes = [];
  // ---- 文件拖放导入（STL/OBJ/STEP 直接拖到盘面上）----
  var fileDropCb = null;
  var dropHost = null, dropOverlay = null, dropDepth = 0;
  // 盘面（底板）实际高度：放置模式贴合时用它，而不是写死的 y=0
  var plateFloorY = 0;
  // 最近一次 setPlates 的参数：几何体晚于盘面加载时需要重排（否则盘面高度仍按空场景算，
  // 会把零件下半截埋进深色盘面里，看上去零件发黑）
  var lastPlateArgs = null;
  var plateUIHost = null, plateLab = {}, plateTips = null;
  var plateToolCb = null;
  var plateTex = { light: null, dark: null };
  // 盘面快捷控件（删除/朝向/锁定/前后位置）改用 3D Sprite：
  // 世界尺寸与盘面同一比例，相机缩放时按钮与盘同比例放大缩小（不再固定 CSS 像素）。
  var PLATE_BTN = 3.4, PLATE_BTN_STEP = 3.9;
  var plateBtnTex = {};        // key: act|active|disabled → CanvasTexture（跨盘复用）
  var plateBtnSprites = [];    // 供 Raycaster 命中测试
  var plateTipEl = null, plateHoverKey = '';

  function ensure() {
    if (inited) return;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xE7F0F9);
    camera = new THREE.PerspectiveCamera(50, 1, 0.01, 5000);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    var d1 = new THREE.DirectionalLight(0xffffff, 0.7); d1.position.set(5, 10, 7); scene.add(d1);
    var d2 = new THREE.DirectionalLight(0x88aaff, 0.25); d2.position.set(-5, -3, -5); scene.add(d2);
    gridHelper = new THREE.GridHelper(20, 40, 0xB9CADD, 0xD2DFEC);
    gridHelper.position.y = -0.02; scene.add(gridHelper);

    // 拖拽旋转视角时不触发拾取：记录按下位置，click 位移超过阈值则忽略
    var downX = 0, downY = 0;
    renderer.domElement.addEventListener('pointerdown', function (e) { downX = e.clientX; downY = e.clientY; });
    renderer.domElement.addEventListener('click', function (e) {
      if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5) return;
      var rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      // 盘面快捷控件（3D Sprite）优先命中：命中即派发，且吞掉本次点击避免误切盘
      if (plateBtnSprites.length) {
        var bt = raycaster.intersectObjects(plateBtnSprites, false);
        if (bt.length > 0) {
          var bud = bt[0].object.userData || {};
          if (bud.pid && !bud.disabled && plateToolCb) plateToolCb(bud.pid, bud.act, spriteAnchor(bt[0].object));
          return;
        }
      }
      if (pickRole && mesh) {
        var hits = raycaster.intersectObject(mesh, false);
        if (hits.length > 0) {
          var faceIdx = hits[0].faceIndex;
          // 洪水填充：expandAuto 按种子局部曲率结构自动分流——
          // 双曲率（半球穹顶）走初始版本逻辑（法线对种子面<22°，不链式扩展，切向交界不连带圆柱面）；
          // 单曲率/平面（圆柱/圆锥/凹槽弧面）保持链式平滑扩展（相邻法线夹角<30°并入）
          var expanded = RayTracer.expandAuto(faces, faceNormals, faceCenters, adjacency, faceIdx, 30);
          // meta.shiftKey：按住 Shift 累加多面；meta.faceIndex：种子面（用于「再次点击已选面 → 取消」判定）
          if (onPick) onPick(pickRole, expanded, { shiftKey: !!e.shiftKey, faceIndex: faceIdx });
          return;
        }
      }
      // 放置模式：先检测透明面命中（优先级高于 mesh 本身）
      if (opMode === 'place' && opPlaceFaces) {
        var pfHits = raycaster.intersectObjects(opPlaceFaces.children, false);
        if (pfHits.length > 0) {
          var pidx = pfHits[0].object.userData.faceIndex;
          highlightPlaceFace(pidx);
          return;
        }
        // 放置模式：命中盘面 → 把选中的透明面贴合盘垂直放置
        if (opPlaceSelected >= 0 && plates.length) {
          var boardsPlace = [];
          for (var i = 0; i < plates.length; i++) boardsPlace.push(plates[i].board);
          var phPlace = raycaster.intersectObjects(boardsPlace, false);
          if (phPlace.length > 0) {
            doPlaceOnPlate();
            return;
          }
        }
        // 放置模式点空白：取消高亮
        if (opPlaceSelected >= 0) { highlightPlaceFace(-1); return; }
      }
      // 零件（mesh）命中 → 选中/取消选中（优先级高于盘面，因为零件摆在盘面上）
      if (mesh) {
        var mh = raycaster.intersectObject(mesh, true);
        if (mh.length > 0) {
          selectMesh();
          return;
        }
      }
      // 点击同盘其它零件的示意网格 → 切换到该项目（须在盘面拾取之前判定）
      if (platePartMeshes.length) {
        var pp = raycaster.intersectObjects(platePartMeshes, true);
        if (pp.length > 0) {
          var ppid = pidOf(pp[0].object);
          if (ppid && ppid !== plateActiveId && platePickCb) platePickCb(ppid);
          if (ppid) return;
        }
      }
      // 点击 3D 场景中的其它盘面（且未命中零件）→ 切换当前盘
      if (plates.length && platePickCb) {
        var boards = [];
        for (var i = 0; i < plates.length; i++) boards.push(plates[i].board);
        var ph = raycaster.intersectObjects(boards, false);
        if (ph.length > 0) {
          var pid = ph[0].object.userData.pid;
          if (pid && pid !== plateActiveId) platePickCb(pid);
        }
        return;
      }
      // 空白区域 → 取消选中
      deselectMesh();
    });

    // 悬停盘面快捷控件：光标变为手型并显示中文/英文提示（Sprite 无原生 title）
    renderer.domElement.addEventListener('pointermove', function (e) {
      if (!plateBtnSprites.length) { setPlateHover(null, null, e); return; }
      var rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      var h = raycaster.intersectObjects(plateBtnSprites, false);
      setPlateHover(h.length ? h[0].object : null, rect, e);
    });

    window.addEventListener('resize', function () {
      var el = renderer.domElement.parentNode;
      if (el) resize(el.clientWidth, el.clientHeight);
    });

    bindDragEvents();

    (function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      updateGizmo();
      updatePlateUI();
    })();
    inited = true;
  }

  // ---- XYZ 坐标随动指示器（左下角，随相机旋转同步） ----
  var gizmoEl = null, gizmoParts = null;
  function ensureGizmo(slot) {
    if (!gizmoEl) {
      gizmoEl = document.createElement('div');
      gizmoEl.className = 'axes-gizmo';
      gizmoEl.innerHTML =
        '<svg viewBox="0 0 72 72">' +
          '<line id="ag-x" class="axis-line" stroke="#E5484D" x1="36" y1="36" x2="58" y2="36"/>' +
          '<line id="ag-y" class="axis-line" stroke="#46A758" x1="36" y1="36" x2="36" y2="14"/>' +
          '<line id="ag-z" class="axis-line" stroke="#3E8FEA" x1="36" y1="36" x2="22" y2="50"/>' +
          '<text id="ag-xt" class="axis-label" fill="#E5484D" x="60" y="39">X</text>' +
          '<text id="ag-yt" class="axis-label" fill="#46A758" x="33" y="11">Y</text>' +
          '<text id="ag-zt" class="axis-label" fill="#3E8FEA" x="12" y="58">Z</text>' +
        '</svg>';
      gizmoParts = {
        x: gizmoEl.querySelector('#ag-x'), y: gizmoEl.querySelector('#ag-y'), z: gizmoEl.querySelector('#ag-z'),
        xt: gizmoEl.querySelector('#ag-xt'), yt: gizmoEl.querySelector('#ag-yt'), zt: gizmoEl.querySelector('#ag-zt')
      };
    }
    var host = slot.parentNode || slot;
    // gizmo 为 absolute 定位：宿主若无定位上下文（如报告页卡片）会锚定到页面导致漂移
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    if (gizmoEl.parentNode !== host) host.appendChild(gizmoEl);
  }
  var _gq = null;
  function updateGizmo() {
    if (!gizmoParts || !camera) return;
    if (!_gq) _gq = new THREE.Quaternion();
    _gq.copy(camera.quaternion).invert();
    setAxis(gizmoParts.x, gizmoParts.xt, new THREE.Vector3(1, 0, 0).applyQuaternion(_gq));
    setAxis(gizmoParts.y, gizmoParts.yt, new THREE.Vector3(0, 1, 0).applyQuaternion(_gq));
    setAxis(gizmoParts.z, gizmoParts.zt, new THREE.Vector3(0, 0, 1).applyQuaternion(_gq));
  }
  function setAxis(line, label, v) {
    var ex = 36 + v.x * 22, ey = 36 - v.y * 22;
    line.setAttribute('x2', ex.toFixed(1));
    line.setAttribute('y2', ey.toFixed(1));
    label.setAttribute('x', (36 + v.x * 30 - 3).toFixed(1));
    label.setAttribute('y', (36 - v.y * 30 + 4).toFixed(1));
  }

  function mount(slot) {
    ensure();
    slot.appendChild(renderer.domElement);
    ensureGizmo(slot);
    ensurePlateUI(slot);
    bindFileDrop(slot);
    resize(slot.clientWidth, slot.clientHeight);
  }
  function unmount() {
    if (renderer && renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
    unbindFileDrop();
    // 盘只属于「模型配置」页：离开该页时回到单件视图
    clearPlates();
  }
  function resize(w, h) {
    if (!renderer || w < 10 || h < 10) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  /** positions/indices 为 mm 原始数据（引擎直接使用），显示归一化仅作用于 THREE 几何 */
  function setGeometryData(positions, indices, name) {
    clearRays();
    clearSpotSection();
    clearFaceHighlights();
    raw = { positions: positions, indices: indices, name: name || '' };

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (indices) geo.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
    // 导入的网格（STL/OBJ）通常没有法线；Phong 材质缺 normal 会渲染成黑色，
    // 因此缺失时补算一次法线（已有法线则保留原样）
    if (!geo.hasAttribute('normal')) geo.computeVertexNormals();
    geo.computeBoundingBox();
    var center = new THREE.Vector3();
    geo.boundingBox.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z);
    var size = new THREE.Vector3();
    geo.boundingBox.getSize(size);
    var maxDim = Math.max(size.x, size.y, size.z, 0.001);
    var scale = 4 / maxDim;
    geo.scale(scale, scale, scale);
    // 存储变换参数，showRays 需要将 mm 原始坐标变换到同一显示空间
    xform = { cx: center.x, cy: center.y, cz: center.z, scale: scale };

    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
    // OrcaSlicer 风格：零件统一为 #218D83（R33 G141 B131），半透明 50%
    // （选中后加白边界框 + 坐标轴）
    var material = new THREE.MeshPhongMaterial({
      color: 0x218D83, transparent: true, opacity: 0.5, depthWrite: false,
      side: THREE.DoubleSide, shininess: 45, specular: 0x0A0A0A
    });
    mesh = new THREE.Mesh(geo, material);
    var wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 8),
      new THREE.LineBasicMaterial({ color: 0x136B63, transparent: true, opacity: 0.55, depthTest: false })
    );
    mesh.add(wire);
    // 零件属于「后绘制」层：底板固定为 -10，零件必须画在底板之后，
    // 避免两者都在透明队列时按距离排序导致零件被底板盖住
    mesh.renderOrder = 1;
    scene.add(mesh);
    meshGeometry = geo;

    // 选中边界框（默认隐藏，selectMesh 时显示）
    // BoxHelper 内部顶点是世界坐标（setFromObject 用 worldMatrix），
    // 必须加到 scene（不能加到 mesh 下），否则会与 mesh.worldMatrix 双重变换！
    var bbox = new THREE.BoxHelper(mesh, 0xFFFFFF);
    bbox.material.depthTest = false; bbox.material.transparent = true;
    bbox.visible = false;
    bbox.name = 'partBBox';
    scene.add(bbox);
    partBBox = bbox;

    buildFaceData();
    fitView();
    applyLED();
    var tr = (LG.state && LG.state.project && LG.state.project.geometry && LG.state.project.geometry.transform) || null;
    if (tr) setTransform(tr);
    // 盘面高度依赖零件最低点：几何体晚于盘面加载时重排一次，
    // 否则盘面仍停在空场景高度，会盖住零件下半截（视觉上零件发黑）
    if (plateLayer && lastPlateArgs) {
      setPlates(lastPlateArgs.items, lastPlateArgs.activeId, lastPlateArgs.tips);
    } else {
      syncFloorGuide();
    }
  }

  /** 清空当前几何：切换盘到「导入模型」盘时使用（导入网格只存在于内存，不持久） */
  function clearGeometry() {
    clearRays();
    clearSpotSection();
    clearFaceHighlights();
    // 选中状态 & gizmo 一并清理
    partSelected = false;
    opMode = '';
    clearGizmo();
    // 边界框从 scene 移除（之前挂 scene 而非 mesh）
    if (partBBox && partBBox.parent) {
      partBBox.parent.remove(partBBox);
      if (partBBox.geometry) partBBox.geometry.dispose();
      if (partBBox.material) partBBox.material.dispose();
    }
    partBBox = null;
    if (onSelectChange) onSelectChange(false);
    if (onModeChange) onModeChange('', null);
    if (mesh) {
      scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      mesh = null;
    }
    meshGeometry = null;
    raw = { positions: null, indices: null, name: '' };
    faces = []; faceNormals = []; faceCenters = []; faceAreas = [];
    adjacency = new Map();
    xform = { cx: 0, cy: 0, cz: 0, scale: 1 };
  }

  function buildFaceData() {
    var pos = meshGeometry.attributes.position;
    var idx = meshGeometry.index;
    faces = []; faceNormals = []; faceCenters = []; faceAreas = [];
    var vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    var e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
    var count = idx ? idx.count / 3 : pos.count / 3;
    for (var i = 0; i < count; i++) {
      var a = idx ? idx.getX(i * 3) : i * 3;
      var b = idx ? idx.getX(i * 3 + 1) : i * 3 + 1;
      var c = idx ? idx.getX(i * 3 + 2) : i * 3 + 2;
      vA.fromBufferAttribute(pos, a); vB.fromBufferAttribute(pos, b); vC.fromBufferAttribute(pos, c);
      e1.subVectors(vB, vA); e2.subVectors(vC, vA);
      n.crossVectors(e1, e2);
      var area = n.length() * 0.5; n.normalize();
      faces.push({ a: vA.clone(), b: vB.clone(), c: vC.clone() });
      faceNormals.push(n.clone());
      faceCenters.push(new THREE.Vector3().add(vA).add(vB).add(vC).multiplyScalar(1 / 3));
      faceAreas.push(area);
    }
    adjacency = RayTracer.buildAdjacency(faces);
  }

  function autoEndCaps() {
    if (faces.length === 0) return { input: [], output: [] };
    return RayTracer.autoDetectEndCaps(faces, faceNormals, faceCenters, faceAreas);
  }
  function faceCount() { return faces.length; }

  function createHighlight(ids, color) {
    var arr = [];
    for (var i = 0; i < ids.length; i++) {
      var f = faces[ids[i]];
      if (!f) continue;
      arr.push(f.a.x, f.a.y, f.a.z, f.b.x, f.b.y, f.b.z, f.c.x, f.c.y, f.c.z);
    }
    if (arr.length === 0) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    // 端面高亮：选中后必须「不透明 + 盖在零件之上」才明显。
    // 注意必须留在透明队列（否则透明度为①的不透明材质会先于半透明零件绘制，
    // 反而被零件盖住冲淡），靠 renderOrder=3 保证在零件之后绘制。
    var hl = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: color, transparent: true, opacity: 1, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1
    }));
    hl.renderOrder = 3;
    return hl;
  }
  function setFaceHighlights(inputIds, outputIds) {
    clearFaceHighlights();
    if (!mesh) return;
    // 高亮坐标来自 faces（mesh 本地归一化坐标），必须挂到 mesh 下才能继承
    // mesh 的 position / rotation；否则用户调整零件位姿时，黄/蓝端面方块不会跟随。
    if (inputIds && inputIds.length) {
      highlights.input = createHighlight(inputIds, 0x3b82f6);
      if (highlights.input) mesh.add(highlights.input);
    }
    if (outputIds && outputIds.length) {
      highlights.output = createHighlight(outputIds, 0xeab308);
      if (highlights.output) mesh.add(highlights.output);
    }
  }
  function clearFaceHighlights() {
    for (var k in highlights) {
      var h = highlights[k];
      if (h) {
        if (h.parent) h.parent.remove(h);
        highlights[k] = null;
      }
    }
  }
  function setPick(role, cb) { pickRole = role; onPick = cb; }

  function setTransform(tr) {
    if (!mesh) return;
    tr = tr || {};
    var px = (tr.posX || 0) * xform.scale;
    var py = (tr.posY || 0) * xform.scale;
    var pz = (tr.posZ || 0) * xform.scale;
    mesh.position.set(px, py, pz);
    mesh.rotation.set(
      (tr.rotX || 0) * Math.PI / 180,
      (tr.rotY || 0) * Math.PI / 180,
      (tr.rotZ || 0) * Math.PI / 180
    );
    // gizmo（移动箭头/旋转圆环/放置面）挂 mesh 下，自动跟随变换；
    // 选中框 BoxHelper 也挂 mesh 下，自动更新包围盒
    if (partBBox) partBBox.update();
    if (ledMesh) applyLED();
    if (spotPlane && lastSpotProj) showSpotSection(lastSpotProj);
    syncFloorGuide();
  }

  /**
   * 当前 mesh 的 mm 位姿（pos/rot），返回给页面层面板显示 / 编辑
   * posX/Y/Z：mesh.position / scale → mm
   * rotX/Y/Z：mesh.rotation → deg
   */
  function getTransform() {
    if (!mesh) return { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 };
    var s = xform.scale || 1;
    return {
      posX: mesh.position.x / s,
      posY: mesh.position.y / s,
      posZ: mesh.position.z / s,
      rotX: mesh.rotation.x * 180 / Math.PI,
      rotY: mesh.rotation.y * 180 / Math.PI,
      rotZ: mesh.rotation.z * 180 / Math.PI
    };
  }

  // ================= 选中 / 取消选中 =================
  function selectMesh() {
    if (!mesh || partSelected) return;
    partSelected = true;
    if (partBBox) partBBox.visible = true;
    // 默认进入 move 模式
    setMode(opMode || 'move');
    if (onSelectChange) onSelectChange(true);
  }
  function deselectMesh() {
    if (!partSelected) return;
    partSelected = false;
    if (partBBox) partBBox.visible = false;
    setMode('');
    if (onSelectChange) onSelectChange(false);
  }

  // ================= 操作模式切换 =================
  function setMode(mode) {
    if (!mesh) return;
    opMode = mode || '';
    opRotateAxis = null;
    opPlaceSelected = -1;
    clearGizmo();
    if (!mode || !partSelected) {
      if (onModeChange) onModeChange(mode || '', null);
      return;
    }
    opGroup = new THREE.Group();
    mesh.add(opGroup);
    if (mode === 'move') buildMoveGizmo();
    else if (mode === 'rotate') buildRotateGizmo();
    else if (mode === 'place') buildPlaceGizmo();
    if (onModeChange) onModeChange(mode, null);
  }
  function clearGizmo() {
    if (opGroup && opGroup.parent) opGroup.parent.remove(opGroup);
    opGroup = null; opMoveArrows = null; opRotateRings = null;
    opRotateMidline = null; opPlaceFaces = null;
    opPlaceSelected = -1; opRotateAxis = null;
    dragState = null;
  }

  // ---- 移动模式：XYZ 轴向箭头（红 X / 绿 Y / 蓝 Z） ----
  function buildMoveGizmo() {
    if (!opGroup) return;
    var s = 1.0;   // 箭头长度（显示空间）
    var coneR = 0.16, coneH = 0.38;
    var shaftR = 0.022;   // 轴杆半径（原 0.035 → 更细）
    var axes = [
      { name: 'x', color: 0xE5484D, dir: new THREE.Vector3(1, 0, 0) },
      { name: 'y', color: 0x46A758, dir: new THREE.Vector3(0, 1, 0) },
      { name: 'z', color: 0x3E8FEA, dir: new THREE.Vector3(0, 0, 1) }
    ];
    opMoveArrows = {};
    for (var i = 0; i < axes.length; i++) {
      var ax = axes[i];
      var grp = new THREE.Group();
      // 杆
      var sh = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, s - coneH, 12),
        new THREE.MeshBasicMaterial({ color: ax.color, depthTest: false }));
      // 默认沿 Y，旋转到目标轴
      if (ax.name === 'x') sh.rotation.z = -Math.PI / 2;
      else if (ax.name === 'z') sh.rotation.x = Math.PI / 2;
      sh.position.copy(ax.dir.clone().multiplyScalar((s - coneH) / 2));
      sh.renderOrder = 10; sh.depthTest = false;
      grp.add(sh);
      // 锥
      var cone = new THREE.Mesh(new THREE.ConeGeometry(coneR, coneH, 16),
        new THREE.MeshBasicMaterial({ color: ax.color, depthTest: false }));
      if (ax.name === 'x') cone.rotation.z = -Math.PI / 2;
      else if (ax.name === 'z') cone.rotation.x = Math.PI / 2;
      cone.position.copy(ax.dir.clone().multiplyScalar(s - coneH / 2));
      cone.renderOrder = 10; cone.depthTest = false;
      grp.add(cone);
      // 整体让 arrow 可以被命中
      grp.traverse(function (o) { o.renderOrder = 10; });
      grp.userData.axis = ax.name;
      grp.position.set(0, 0, 0);
      opGroup.add(grp);
      opMoveArrows[ax.name] = grp;
    }
  }

  // ---- 旋转模式：XYZ 三个正交圆环 + 环上「正方体 + 左右双锥」方向指示 ----
  // 环平面必须与旋转轴垂直：
  //   绕 X 旋转 → 环在 YZ 平面（法线 X）→ Torus 绕 Y 轴转 90°
  //   绕 Y 旋转 → 环在 XZ 平面（法线 Y）→ Torus 绕 X 轴转 -90°
  //   绕 Z 旋转 → 环在 XY 平面（法线 Z）→ Torus 默认朝向
  function buildRotateGizmo() {
    if (!opGroup) return;
    var R = 1.3;    // 圆环半径（显示空间）
    var axes = [
      { name: 'x', color: 0xE5484D, rot: new THREE.Euler(0, Math.PI / 2, 0), handleAng: 0 },
      { name: 'y', color: 0x46A758, rot: new THREE.Euler(-Math.PI / 2, 0, 0), handleAng: 0 },
      { name: 'z', color: 0x3E8FEA, rot: new THREE.Euler(0, 0, 0), handleAng: Math.PI / 2 }
    ];
    opRotateRings = {};
    for (var i = 0; i < axes.length; i++) {
      var ax = axes[i];
      var rg = new THREE.Group();
      rg.rotation.copy(ax.rot);
      rg.userData.axis = ax.name;

      var torus = new THREE.Mesh(
        new THREE.TorusGeometry(R, 0.028, 12, 96),
        new THREE.MeshBasicMaterial({ color: ax.color, depthTest: false, transparent: true, opacity: 0.9 })
      );
      torus.userData.axis = ax.name;
      torus.renderOrder = 10;
      rg.add(torus);
      rg.userData.torus = torus;

      // 环上的方向指示：正方体 + 左右两个锥形箭头（指向切线正/负方向）
      rg.userData.handle = buildRingHandle(rg, ax.color, R, ax.handleAng);
      rg.userData.handleBaseAng = ax.handleAng;

      rg.traverse(function (o) { o.renderOrder = 10; });
      opGroup.add(rg);
      opRotateRings[ax.name] = rg;
    }
  }

  /** 在环上 ang 处放一个正方体，两侧各一个锥形箭头，指向环的切线正负方向 */
  function buildRingHandle(parent, color, R, ang) {
    var g = new THREE.Group();
    var mat = new THREE.MeshBasicMaterial({ color: color, depthTest: false, transparent: true, opacity: 1 });
    var boxSize = 0.17;
    var box = new THREE.Mesh(new THREE.BoxGeometry(boxSize, boxSize, boxSize), mat);
    g.add(box);
    // 锥形：几何默认锥尖朝 +Y，旋转后分别朝 ±X（切线方向）
    var coneGeo = new THREE.ConeGeometry(0.085, 0.24, 12);
    var off = boxSize * 0.5 + 0.13;
    var c1 = new THREE.Mesh(coneGeo, mat);
    c1.position.set(off, 0, 0);
    c1.rotation.z = -Math.PI / 2;
    g.add(c1);
    var c2 = new THREE.Mesh(coneGeo, mat);
    c2.position.set(-off, 0, 0);
    c2.rotation.z = Math.PI / 2;
    g.add(c2);
    // 放到环上 ang 处，并让局部 +X 对齐该点的切线方向 (-sin, cos)
    g.position.set(Math.cos(ang) * R, Math.sin(ang) * R, 0);
    g.rotation.z = ang + Math.PI / 2;
    g.traverse(function (o) { o.renderOrder = 12; });
    parent.add(g);
    return g;
  }

  /** 选中某一旋转轴 → 隐藏另外 2 环 + 精度刻度线（每 10°）+ 8 方向高亮 + 外圈方向箭头 */
  function showRotateMidline(axis) {
    clearRotateMidline();
    opRotateAxis = axis;
    if (!opGroup || !opRotateRings) return;
    var R = 1.3;
    var ROuter = 1.6;   // 方向箭头环半径
    var RMidTick = 1.42; // 中间刻度起点
    var ROuterTick = 1.58;
    var colorMap = { x: 0xE5484D, y: 0x46A758, z: 0x3E8FEA };
    // 刻度/箭头必须与选中环同平面（与 buildRotateGizmo 的 rot 一致）
    var axDefMap = {
      x: { rot: new THREE.Euler(0, Math.PI / 2, 0) },   // 绕 X → 环在 YZ 平面
      y: { rot: new THREE.Euler(-Math.PI / 2, 0, 0) },  // 绕 Y → 环在 XZ 平面
      z: { rot: new THREE.Euler(0, 0, 0) }              // 绕 Z → 环在 XY 平面
    };

    // 1) 隐藏另外 2 环，当前轴加粗加亮
    Object.keys(opRotateRings).forEach(function (k) {
      var ringGroup = opRotateRings[k];
      var torus = ringGroup.userData.torus;
      if (k === axis) {
        ringGroup.visible = true;
        if (torus) {
          torus.geometry.dispose();
          torus.geometry = new THREE.TorusGeometry(R, 0.072, 16, 96);
          torus.material.opacity = 1.0;
        }
      } else {
        ringGroup.visible = false;
      }
    });

    // 2) 精度刻度组（挂在 opGroup 里，旋转平面对齐后添加）
    var tickGroup = new THREE.Group();
    // 3) 方向箭头组（外圈蓝色）
    var arrowGroup = new THREE.Group();

    // 刻度：每 10° 一条；45° 吸附位置（米字）加粗加亮
    for (var deg = 0; deg < 360; deg += 10) {
      var ang = deg * Math.PI / 180;
      var cosA = Math.cos(ang), sinA = Math.sin(ang);
      var is45 = (deg % 45 === 0);
      var is30 = (deg % 30 === 0);
      var innerR = is45 ? R + 0.02 : (is30 ? RMidTick - 0.02 : RMidTick - 0.05);
      var outerR = is45 ? ROuter + 0.04 : (is30 ? ROuterTick : RMidTick + 0.04);
      var pts = [
        new THREE.Vector3(cosA * innerR, sinA * innerR, 0),
        new THREE.Vector3(cosA * outerR, sinA * outerR, 0)
      ];
      var line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: colorMap[axis],
          depthTest: false, transparent: true,
          opacity: is45 ? 0.95 : (is30 ? 0.65 : 0.35)
        })
      );
      tickGroup.add(line);

      // 45° 吸附点画一个小圆点（视觉焦点；与更细的圆环协调，从 0.04 缩到 0.03）
      if (is45) {
        var dot = new THREE.Mesh(
          new THREE.CircleGeometry(0.03, 16),
          new THREE.MeshBasicMaterial({ color: colorMap[axis], depthTest: false })
        );
        dot.position.set(cosA * (R + 0.08), sinA * (R + 0.08), 0);
        tickGroup.add(dot);
      }
    }

    // 3) 外圈方向箭头（8 个，每 45° 一个；指向逆时针旋转方向，蓝色高亮）
    for (var a2 = 0; a2 < 360; a2 += 45) {
      var ang2 = a2 * Math.PI / 180;
      var cos2 = Math.cos(ang2), sin2 = Math.sin(ang2);
      // 箭头主体：三角形，位于 ROuter 处，指向切线方向（逆时针 = 切线方向为 [-sin, cos]）
      var tx = -sin2, ty = cos2;   // 逆时针切线
      var cx = cos2 * ROuter, cy = sin2 * ROuter;
      var halfArrowLen = 0.18;
      var halfArrowWid = 0.10;
      var ptsA = new THREE.BufferGeometry();
      var v1 = new THREE.Vector3(cx, cy, 0);                                // 箭头尖端
      var v2 = new THREE.Vector3(cx - tx * halfArrowLen + ty * halfArrowWid,
                                 cy - ty * halfArrowLen - tx * halfArrowWid, 0);
      var v3 = new THREE.Vector3(cx - tx * halfArrowLen - ty * halfArrowWid,
                                 cy - ty * halfArrowLen + tx * halfArrowWid, 0);
      ptsA.setAttribute('position', new THREE.Float32BufferAttribute(
        [v1.x, v1.y, v1.z, v2.x, v2.y, v2.z, v3.x, v3.y, v3.z], 3));
      var arrow = new THREE.Mesh(ptsA, new THREE.MeshBasicMaterial({
        color: 0x22D3EE,   // cyan-400 青蓝色
        depthTest: false, transparent: true, opacity: 0.85, side: THREE.DoubleSide
      }));
      arrowGroup.add(arrow);
    }

    // 对齐旋转平面到选中轴
    tickGroup.rotation.copy(axDefMap[axis].rot);
    arrowGroup.rotation.copy(axDefMap[axis].rot);
    tickGroup.traverse(function (o) { o.depthTest = false; o.renderOrder = 11; });
    arrowGroup.traverse(function (o) { o.depthTest = false; o.renderOrder = 11; });

    // 统一挂到一个组里再入 opGroup（关键：不能先 add 到 opGroup 再 reparent，
    // 否则第二次 add 会把它们从 opGroup 摘下，挂到未入场景的孤立组，导致刻度/箭头永不渲染）
    opRotateMidline = new THREE.Group();
    opRotateMidline.add(tickGroup);
    opRotateMidline.add(arrowGroup);
    opGroup.add(opRotateMidline);
  }
  function clearRotateMidline() {
    // 恢复所有环可见 + 恢复原始粗细
    if (opRotateRings) {
      Object.keys(opRotateRings).forEach(function (k) {
        var ringGroup = opRotateRings[k];
        var torus = ringGroup.userData.torus;
        ringGroup.visible = true;
        if (torus && torus.geometry.parameters && torus.geometry.parameters.tube !== 0.045) {
          torus.geometry.dispose();
          torus.geometry = new THREE.TorusGeometry(1.3, 0.045, 12, 64);
          torus.material.opacity = 0.9;
        }
      });
    }
    if (opRotateMidline && opRotateMidline.parent) {
      opRotateMidline.parent.remove(opRotateMidline);
    }
    opRotateMidline = null;
    opRotateAxis = null;
  }

  // ---- 放置模式：AABB 6 个面的透明仿真面 ----
  function buildPlaceGizmo() {
    if (!opGroup || !meshGeometry) return;
    // 用 mesh 的包围盒生成 6 个面
    meshGeometry.computeBoundingBox();
    var bb = meshGeometry.boundingBox.clone();
    // 给 gizmo 加 padding，避免与模型表面完全重合导致 z-fighting
    bb.min.addScalar(-0.01); bb.max.addScalar(0.01);
    var size = new THREE.Vector3(), center = new THREE.Vector3();
    bb.getSize(size); bb.getCenter(center);

    opPlaceFaces = new THREE.Group();
    // 6 个面：法线向外
    var facesDef = [
      { axis: 'x', sign: +1, normal: new THREE.Vector3( 1, 0, 0), w: size.y, h: size.z, c: new THREE.Vector3( bb.max.x, center.y, center.z) },
      { axis: 'x', sign: -1, normal: new THREE.Vector3(-1, 0, 0), w: size.y, h: size.z, c: new THREE.Vector3( bb.min.x, center.y, center.z) },
      { axis: 'y', sign: +1, normal: new THREE.Vector3(0,  1, 0), w: size.x, h: size.z, c: new THREE.Vector3( center.x, bb.max.y, center.z) },
      { axis: 'y', sign: -1, normal: new THREE.Vector3(0, -1, 0), w: size.x, h: size.z, c: new THREE.Vector3( center.x, bb.min.y, center.z) },
      { axis: 'z', sign: +1, normal: new THREE.Vector3(0, 0,  1), w: size.x, h: size.y, c: new THREE.Vector3( center.x, center.y, bb.max.z) },
      { axis: 'z', sign: -1, normal: new THREE.Vector3(0, 0, -1), w: size.x, h: size.y, c: new THREE.Vector3( center.x, center.y, bb.min.z) }
    ];
    for (var i = 0; i < facesDef.length; i++) {
      var fd = facesDef[i];
      var pl = new THREE.Mesh(
        new THREE.PlaneGeometry(fd.w, fd.h),
        new THREE.MeshPhongMaterial({
          color: 0x2DD4BF, transparent: true, opacity: 0.25, side: THREE.DoubleSide,
          depthTest: false, shininess: 20
        })
      );
      pl.position.copy(fd.c);
      // PlaneGeometry 默认在 XY 平面，法线 +Z；旋转使法线对齐
      var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fd.normal);
      pl.quaternion.copy(q);
      pl.userData.faceIndex = i;
      pl.userData.faceDef = fd;
      pl.renderOrder = 8; pl.depthTest = false;
      opPlaceFaces.add(pl);
      // 面边框
      var wire = new THREE.LineSegments(
        new THREE.EdgesGeometry(pl.geometry),
        new THREE.LineBasicMaterial({ color: 0x0D9488, transparent: true, opacity: 0.6, depthTest: false })
      );
      wire.renderOrder = 9;
      pl.add(wire);
    }
    opGroup.add(opPlaceFaces);
  }
  function highlightPlaceFace(idx) {
    if (!opPlaceFaces) return;
    opPlaceSelected = idx;
    var color = new THREE.Color(0x2DD4BF);
    var hi = new THREE.Color(0xFFA500);
    for (var i = 0; i < opPlaceFaces.children.length; i++) {
      var c = opPlaceFaces.children[i];
      if (!c.isMesh) continue;
      c.material.color.copy(i === idx ? hi : color);
      c.material.opacity = (i === idx ? 0.55 : 0.22);
    }
  }
  /**
   * 放置：把 opPlaceSelected 对应的面贴合盘面。
   * 关键：
   *   1) 面的法线要先变换到「世界坐标」再和 (0,-1,0) 求旋转差，否则零件已有旋转时结果会错；
   *   2) 落点用底板真实高度 plateFloorY，而不是写死的 y=0。
   */
  function doPlaceOnPlate() {
    if (!mesh || !meshGeometry || opPlaceSelected < 0) return;
    var faceMesh = opPlaceFaces.children[opPlaceSelected];
    if (!faceMesh) return;
    var fd = faceMesh.userData.faceDef;

    // 1) 本地法线 → 世界法线
    mesh.updateMatrixWorld(true);
    var localNormal = fd.normal.clone().normalize();
    var worldNormal = localNormal.clone().applyQuaternion(mesh.quaternion).normalize();
    // 2) 世界法线旋转到「朝下」（贴盘面），在父空间左乘
    var targetNormal = new THREE.Vector3(0, -1, 0);
    var q = new THREE.Quaternion().setFromUnitVectors(worldNormal, targetNormal);
    var qMesh = mesh.quaternion.clone().premultiply(q);
    mesh.quaternion.copy(qMesh);

    // 3) 让零件最低点刚好落在底板表面
    mesh.updateMatrixWorld(true);
    meshGeometry.computeBoundingBox();
    var bbWorld = meshGeometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    if (isFinite(bbWorld.min.y)) mesh.position.y += (plateFloorY - bbWorld.min.y);

    if (partBBox) partBBox.update();
    if (onTransformChange) onTransformChange(getTransform());
    if (ledMesh) applyLED();
    if (spotPlane && lastSpotProj) showSpotSection(lastSpotProj);
    syncFloorGuide();
    // 放置完成后退出 place 模式，回到 move 模式
    setMode('move');
  }

  // ================= 旋转拖拽交互（沿环拖拽 + 45° 吸附） =================
  // 核心：把鼠标射线与「选中环所在平面」求交，用交点绕轴的角度变化驱动旋转。
  // 这样拖动方向与环的左右箭头方向一致（沿着环走），而不是绕环心翻滚。
  function startRotateDrag(axis, e) {
    if (!mesh) return;
    showRotateMidline(axis);

    // 环平面的世界法线 = mesh 的该局部轴方向（环与旋转轴垂直）
    var normal = new THREE.Vector3(
      axis === 'x' ? 1 : 0,
      axis === 'y' ? 1 : 0,
      axis === 'z' ? 1 : 0
    ).applyQuaternion(mesh.quaternion).normalize();

    var center = new THREE.Vector3();
    mesh.getWorldPosition(center);

    // 平面内正交基 u / v，满足 u × v = normal（右手系，保证 atan2 增量为正角度）
    var u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(normal.dot(u)) > 0.9) u.set(0, 1, 0);
    u.crossVectors(normal, u).normalize();
    var v = new THREE.Vector3().crossVectors(normal, u).normalize();

    var st = {
      mode: 'rotate',
      axis: axis,
      normal: normal,
      center: center,
      u: u,
      v: v,
      startQuat: mesh.quaternion.clone(),
      delta: 0,
      prevAngle: 0
    };
    var a0 = rotateDragAngle(e, st);
    if (a0 === null) return;
    st.prevAngle = a0;
    dragState = st;
  }

  /** 鼠标射线与环平面求交，返回交点相对环心的角度（弧度，绕 normal 右手方向为正） */
  function rotateDragAngle(e, st) {
    var rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    var plane = new THREE.Plane().setFromNormalAndCoplanarPoint(st.normal, st.center);
    var hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    hit.sub(st.center);
    return Math.atan2(hit.dot(st.v), hit.dot(st.u));
  }

  // ================= 移动拖拽交互 =================
  function startMoveDrag(axis, e) {
    if (!mesh) return;
    dragState = {
      mode: 'move',
      axis: axis,
      startPos: mesh.position.clone(),
      startX: e.clientX,
      startY: e.clientY
    };
  }

  // ================= pointer 事件绑定（拖拽） =================
  // 统一在 ensure 里绑定 pointerdown，判断命中的 gizmo 轴；pointermove/up 全局
  function bindDragEvents() {
    var el = renderer.domElement;
    el.addEventListener('pointerdown', function (e) {
      if (!partSelected || !opMode || dragState) return;
      var rect = el.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      // move 模式：命中某一箭头
      if (opMode === 'move' && opGroup) {
        var hits = raycaster.intersectObjects(opGroup.children, true);
        if (hits.length > 0) {
          var ud = hits[0].object.userData;
          // 向上找含 axis 的 parent
          var o = hits[0].object;
          while (o && !o.userData.axis && o.parent) o = o.parent;
          if (o && o.userData.axis) {
            startMoveDrag(o.userData.axis, e);
            e.stopPropagation();
            controls.enabled = false;
          }
        }
      }
      // rotate 模式：命中某一环（含环上的正方体 / 锥形指示，递归拾取后向上找 axis）
      if (opMode === 'rotate' && opRotateRings) {
        var rings = [];
        Object.keys(opRotateRings).forEach(function (k) { rings.push(opRotateRings[k]); });
        var rh = raycaster.intersectObjects(rings, true);
        if (rh.length > 0) {
          var ro = rh[0].object;
          while (ro && !ro.userData.axis && ro.parent) ro = ro.parent;
          if (ro && ro.userData.axis) {
            startRotateDrag(ro.userData.axis, e);
            e.stopPropagation();
            controls.enabled = false;
          }
        }
      }
    });
    window.addEventListener('pointermove', function (e) {
      if (!dragState) return;
      if (dragState.mode === 'rotate') handleRotateDrag(e);
      else if (dragState.mode === 'move') handleMoveDrag(e);
    });
    window.addEventListener('pointerup', function () {
      if (dragState) {
        dragState = null;
        controls.enabled = true;
        if (onTransformChange) onTransformChange(getTransform());
        syncFloorGuide();
      }
    });
  }

  // ================= 文件拖放导入 =================
  /** 页面层回调：fileDropCb(files, projectId)；projectId 为落点所在盘的代表项目，盘外为 null */
  function onFilesDrop(cb) { fileDropCb = cb || null; }

  function dragHasFiles(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    if (!t) return false;
    if (t.indexOf) return t.indexOf('Files') !== -1;
    for (var i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
    return false;
  }

  function showDropOverlay(show) {
    if (!dropOverlay) return;
    dropOverlay.style.display = show ? 'flex' : 'none';
    if (show) {
      var box = dropOverlay.querySelector('.file-drop-box');
      if (box) box.textContent = LG.t('drop.hint');
    }
  }

  /** 覆盖层：绝对定位 + 虚线框，纯内联样式（无外链资源）；pointer-events:none 不挡拾取 */
  function ensureDropOverlay(host) {
    if (!dropOverlay) {
      dropOverlay = document.createElement('div');
      dropOverlay.className = 'file-drop-ov';
      dropOverlay.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;display:none;' +
        'z-index:40;pointer-events:none;align-items:center;justify-content:center;' +
        'background:rgba(33,141,131,0.10);';
      var box = document.createElement('div');
      box.className = 'file-drop-box';
      box.style.cssText = 'border:2px dashed #218D83;border-radius:12px;padding:18px 28px;' +
        'max-width:80%;text-align:center;background:rgba(255,255,255,0.94);color:#1E6F68;' +
        'font-size:14px;font-weight:600;box-shadow:0 6px 24px rgba(16,60,56,0.16);';
      dropOverlay.appendChild(box);
    }
    if (dropOverlay.parentNode !== host) host.appendChild(dropOverlay);
  }

  function bindFileDrop(host) {
    if (!host) return;
    if (dropHost === host && dropOverlay && dropOverlay.parentNode === host) return;
    unbindFileDrop();
    dropHost = host;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    ensureDropOverlay(host);
    host.addEventListener('dragenter', onDragEnter);
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('dragleave', onDragLeave);
    host.addEventListener('drop', onDropFiles);
  }

  function unbindFileDrop() {
    if (dropHost) {
      dropHost.removeEventListener('dragenter', onDragEnter);
      dropHost.removeEventListener('dragover', onDragOver);
      dropHost.removeEventListener('dragleave', onDragLeave);
      dropHost.removeEventListener('drop', onDropFiles);
    }
    if (dropOverlay && dropOverlay.parentNode) dropOverlay.parentNode.removeChild(dropOverlay);
    dropHost = null; dropOverlay = null; dropDepth = 0;
  }

  function onDragEnter(e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (!plates.length) return;         // 盘未铺开（非模型配置页）时不显示提示，但仍吞掉默认行为
    dropDepth++;
    showDropOverlay(true);
  }
  function onDragOver(e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (plates.length) showDropOverlay(true);
  }
  function onDragLeave(e) {
    if (!dragHasFiles(e)) return;
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0) showDropOverlay(false);
  }
  function onDropFiles(e) {
    if (!e.dataTransfer) return;
    // 盘未铺开（非模型配置页）时不接管，避免误让浏览器打开文件
    e.preventDefault();
    dropDepth = 0;
    showDropOverlay(false);
    if (!plates.length) return;
    var files = e.dataTransfer.files;
    if (!files || !files.length) return;
    if (fileDropCb) fileDropCb(files, dropPlatePid(e));
  }

  /** 落点拾取：只对盘板做 raycast；拿不到（拖到盘外）返回 null */
  function dropPlatePid(e) {
    if (!plateLayer || !plates.length || !renderer || !camera) return null;
    var rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    var boards = [];
    for (var i = 0; i < plates.length; i++) boards.push(plates[i].board);
    var hit = raycaster.intersectObjects(boards, false);
    return hit.length ? (hit[0].object.userData.pid || null) : null;
  }

  /** 从命中对象向上找到带 pid 的节点（示意零件的格子/线框都可能被命中） */
  function pidOf(obj) {
    var o = obj;
    while (o) {
      if (o.userData && o.userData.pid) return o.userData.pid;
      o = o.parent;
    }
    return null;
  }

  // 旋转：沿环拖拽 → 累加绕轴角度增量；接近 45° 的整数倍时吸附锁定
  function handleRotateDrag(e) {
    var st = dragState;
    var a = rotateDragAngle(e, st);
    if (a === null) return;

    // 角度增量（处理 ±π 跨越）
    var d = a - st.prevAngle;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    st.prevAngle = a;
    st.delta += d;

    // 绕环的世界法线旋转（等价于绕零件的该局部轴旋转）
    var q = new THREE.Quaternion().setFromAxisAngle(st.normal, st.delta);
    mesh.quaternion.copy(st.startQuat).premultiply(q);

    // 45° 吸附：该轴欧拉角接近 45° 倍数（±3°）时锁定
    var deg = mesh.rotation[st.axis] * 180 / Math.PI;
    var snapped = Math.round(deg / 45) * 45;
    if (Math.abs(deg - snapped) < 3) {
      mesh.rotation[st.axis] = snapped * Math.PI / 180;
    }

    // 环上的「正方体 + 双锥」反向自转，使指示器在屏幕上保持不动（不跟着环跑）
    var rg = opRotateRings && opRotateRings[st.axis];
    if (rg && rg.userData.handle) {
      rg.userData.handle.rotation.z = rg.userData.handleBaseAng + Math.PI / 2 - st.delta;
    }

    if (partBBox) partBBox.update();
    if (ledMesh) applyLED();
    if (spotPlane && lastSpotProj) showSpotSection(lastSpotProj);
  }

  // 移动：沿选中轴平移（屏幕像素 × axis 在屏幕上的投影向量 → 世界位移）
  function handleMoveDrag(e) {
    var rect = renderer.domElement.getBoundingClientRect();
    var ndcX0 = ((dragState.startX - rect.left) / rect.width) * 2 - 1;
    var ndcY0 = -((dragState.startY - rect.top) / rect.height) * 2 + 1;
    var ndcX1 = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    var ndcY1 = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    var sdx = ndcX1 - ndcX0, sdy = ndcY1 - ndcY0;
    // 选中轴的世界方向 → 投影到屏幕（2D）→ 取与 sdx/sdy 点积作为实际位移
    var axisWorld = new THREE.Vector3(
      dragState.axis === 'x' ? 1 : 0,
      dragState.axis === 'y' ? 1 : 0,
      dragState.axis === 'z' ? 1 : 0
    ).applyQuaternion(mesh.quaternion);
    // 把 axisWorld 的两个端点投影到屏幕得到方向向量
    var origin = mesh.position.clone();
    var end = origin.clone().add(axisWorld);
    var p0 = origin.clone().project(camera);
    var p1 = end.clone().project(camera);
    var dir2 = new THREE.Vector2(p1.x - p0.x, p1.y - p0.y);
    if (dir2.lengthSq() < 1e-8) return;
    dir2.normalize();
    var delta2 = new THREE.Vector2(sdx, sdy);
    var t = delta2.dot(dir2);    // 单位：NDC（-1..1）在轴方向上的分量
    // NDC 位移 → 世界位移：用相机的 view 空间比例换算
    // 屏幕上 1 NDC = 世界距离：相机距离 × 2 tan(fov/2) × |cos(angle between axis and view normal)|
    var dist = camera.position.distanceTo(origin);
    var perNDCY = 2 * dist * Math.tan(camera.fov * Math.PI / 360);
    // fov 是垂直方向，所以 X 方向要按 aspect 修正
    var perNDCX = perNDCY * camera.aspect;
    // 轴投影 = dir2.x * perNDCX + dir2.y * perNDCY
    var worldPerNDC = Math.abs(dir2.x) * perNDCX + Math.abs(dir2.y) * perNDCY;
    var worldDelta = t * worldPerNDC;
    mesh.position.copy(dragState.startPos).add(axisWorld.multiplyScalar(worldDelta));
    if (partBBox) partBBox.update();
    if (ledMesh) applyLED();
    if (spotPlane && lastSpotProj) showSpotSection(lastSpotProj);
  }

  // 页面层回调（选中变化 / 模式变化 / 位姿变化 → 更新侧栏坐标面板）
  var onSelectChange = null, onModeChange = null, onTransformChange = null;
  function setSelectCb(cb) { onSelectChange = cb; }
  function setModeCb(cb) { onModeChange = cb; }
  function setTransformCb(cb) { onTransformChange = cb; }

  /** mm 原始坐标 → 显示坐标（含几何归一化 + mesh 变换） */
  function tx(v) { return (v - xform.cx) * xform.scale; }
  function tx3(arr) {
    // 先做几何归一化（与 setGeometryData 中的 translate+scale 一致）
    var vx = (arr[0] - xform.cx) * xform.scale;
    var vy = (arr[1] - xform.cy) * xform.scale;
    var vz = (arr[2] - xform.cz) * xform.scale;
    // 再叠加 mesh 的 position/rotation（与 setTransform 一致）
    if (mesh) {
      var v = new THREE.Vector3(vx, vy, vz);
      v.applyEuler(mesh.rotation);
      v.add(mesh.position);
      return [v.x, v.y, v.z];
    }
    return [vx, vy, vz];
  }

  /** 光线可视化：按 type 分色、强度映射亮度（段坐标从 mm 空间变换到显示空间） */
  function showRays(segments) {
    clearRays();
    var colors = { success: 0xdc143c, 'in-body': 0x4b0082, escape: 0xff8c00 };
    var buckets = { success: [], 'in-body': [], escape: [] };
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      (buckets[s.type] || (buckets[s.type] = [])).push(s);
    }
    rayLines = new THREE.Group();
    Object.keys(buckets).forEach(function (type) {
      var segs = buckets[type];
      if (!segs.length) return;
      var base = new THREE.Color(colors[type]);
      var posArr = [], colArr = [];
      for (var k = 0; k < segs.length; k++) {
        var sg = segs[k];
        // 将 mm 坐标变换到与 mesh 相同的显示空间
        var st = tx3(sg.start), en = tx3(sg.end);
        posArr.push(st[0], st[1], st[2], en[0], en[1], en[2]);
        var it = Math.max(0, Math.min(1, sg.intensity != null ? sg.intensity : 1));
        var br = 0.15 + 0.85 * it;
        colArr.push(base.r * br, base.g * br, base.b * br, base.r * br, base.g * br, base.b * br);
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
      rayLines.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true,
        opacity: type === 'success' ? 0.9 : 0.75,
        // 深度剔除统一关闭：此前仅 in-body 关闭、success/escape 保留，导致到达出射端的
        // 红色 success 线段与侧壁泄漏的 escape 线段在柱体内部被遮挡而不显示，
        // 视觉上表现为“光线在导光柱内部提前截断、几乎没有光线到出射端”。
        depthTest: false
      })));
    });
    scene.add(rayLines);
  }
  function clearRays() {
    if (rayLines) {
      scene.remove(rayLines);
      rayLines.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      rayLines = null;
    }
  }

  // ================= 出射光斑截面（虚拟探测屏，ZEMAX 式探测器视图） =================
  /**
   * 在出射端面前方 d mm 处显示光斑截面（jet 伪彩辐照度纹理平面）。
   * proj 来自 RayTracer.projectSpotGrid：{ res, half(mm), E(res²), Emax,
   *   center(屏心mm), on(屏法线), uv, vv(面内基) }；
   * 位姿叠加 mesh 旋转/平移（与 LED/光线同一显示空间）。
   */
  function showSpotSection(proj) {
    clearSpotSection();
    lastSpotProj = proj || null;
    // 优先使用显示网格（256×256，仅渲染用），回退到指标网格（64×64）
    var src = proj && proj.disp ? proj.disp : proj;
    var Earr = src && (src.E || src.Etot);
    if (!proj || !Earr || !meshGeometry) return;
    var res = src.res, Emax = (src.Emax > 0 ? src.Emax : (proj.Emax || 1));
    // 离屏画布生成 jet 伪彩纹理（整面填充，E=0 处为 jet 深蓝底色，还原探测器观测观感）
    var cv = document.createElement('canvas');
    cv.width = res; cv.height = res;
    var cctx = cv.getContext('2d');
    var img = cctx.createImageData(res, res);
    var data = img.data;
    for (var iy = 0; iy < res; iy++) {
      var row = res - 1 - iy;   // 网格 v 向上 → 图像行向下（CanvasTexture flipY 后与平面 +Y 对齐）
      for (var ix = 0; ix < res; ix++) {
        var col = LG.Charts.jetRGB(Earr[iy * res + ix] / Emax);
        var pxi = (row * res + ix) * 4;
        data[pxi] = col[0]; data[pxi + 1] = col[1]; data[pxi + 2] = col[2]; data[pxi + 3] = 255;
      }
    }
    cctx.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.LinearFilter;   // 双线性放大 → 平滑光晕过渡
    tex.minFilter = THREE.LinearFilter;

    var group = new THREE.Group();
    var geo = new THREE.PlaneGeometry(1, 1);
    var plane = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: tex, side: THREE.DoubleSide, transparent: true, opacity: 0.98,
      // 与端面三角面共面 → 靠 polygonOffset + 沿法线微移避免 z-fighting 被端面遮住
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    }));
    group.add(plane);
    group.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.7 })
    ));

    // 位姿：屏法线 = on，面内 +X = uv、+Y = vv；再叠加 mesh 旋转（同 LED 位姿处理）
    var basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(proj.uv[0], proj.uv[1], proj.uv[2]),
      new THREE.Vector3(proj.vv[0], proj.vv[1], proj.vv[2]),
      new THREE.Vector3(proj.on[0], proj.on[1], proj.on[2]));
    var q = new THREE.Quaternion().setFromRotationMatrix(basis);
    if (mesh) q.premultiply(mesh.quaternion);
    group.quaternion.copy(q);
    var pw = tx3(proj.center);
    var sc = 2 * proj.half * xform.scale;
    // 沿世界法线外移 0.5% 屏宽：视觉上仍贴合出射端面，但不会与端面共面被遮住
    var nrm = new THREE.Vector3(proj.on[0], proj.on[1], proj.on[2]).applyQuaternion(mesh ? mesh.quaternion : new THREE.Quaternion());
    var off = Math.max(sc * 0.005, 1e-4);
    group.position.set(pw[0] + nrm.x * off, pw[1] + nrm.y * off, pw[2] + nrm.z * off);
    group.scale.set(sc, sc, sc);
    // 光斑图必须画在零件（renderOrder=1）和端面高亮（renderOrder=3）之后，
    // 否则透明队列里会被端面高亮盖住，用户看到的就是「光斑被出射端选择面挡住」
    group.traverse(function (o) { o.renderOrder = 5; });
    spotPlane = group;
    scene.add(group);
  }
  function clearSpotSection() {
    lastSpotProj = null;
    if (spotPlane) {
      scene.remove(spotPlane);
      spotPlane.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      });
      spotPlane = null;
    }
  }

  // ================= LED 灯珠可视化 =================
  /** 设置 LED 参数并立即渲染（mm 原始坐标 → 经 xform 变换到显示空间） */
  function setLED(params) {
    ledParams = params || null;
    applyLED();
  }
  function clearLED() {
    if (ledMesh) {
      scene.remove(ledMesh);
      ledMesh.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      ledMesh = null;
    }
  }
  /** 依据 ledParams + 当前 xform 重建 LED mesh */
  function applyLED() {
    clearLED();
    if (!ledParams || !ledParams.enabled || !meshGeometry) return;

    var p = ledParams;
    var type = p.type || 'rectangle';
    // pget: 0 是有效值，不能被 || 吞掉
    function pget(v, def) { return (v != null && !isNaN(+v)) ? +v : def; }
    var L = Math.max(0.3, pget(p.length, 3));
    var W = Math.max(0.3, pget(p.width, 2));
    var H = Math.max(0.3, pget(p.height, 1.5));
    var gap = Math.max(0, pget(p.gap, 0.5));
    var concaveDepth = Math.min(Math.max(0.1, pget(p.concaveDepth, 0.4)), H * 0.7);
    var convexRadius = Math.max(0.2, pget(p.convexRadius, 0.6));

    var group = new THREE.Group();
    var ledMat = new THREE.MeshPhongMaterial({
      color: 0xFFB800, transparent: true, opacity: 0.52,
      depthWrite: false, side: THREE.DoubleSide, shininess: 40, specular: 0x444444
    });
    var wireMat = new THREE.LineBasicMaterial({
      color: 0xD97706, transparent: true, opacity: 0.5, depthTest: false
    });
    function addPart(geo) {
      var m = new THREE.Mesh(geo, ledMat);
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 15), wireMat));
      group.add(m);
    }

    // LED 坐标系：z=0 为入射端面，LED 位于 z<0 侧；发光面（最靠近 z=0 的面）在 z=-gap
    if (type === 'rectangle' || type === 'square') {
      var boxGeo = new THREE.BoxGeometry(L, W, H);
      boxGeo.translate(0, 0, -gap - H / 2);     // 发光面(+Z)在 z=-gap
      addPart(boxGeo);
    } else if (type === 'concave') {
      var r = W / 2;
      var bodyH = Math.max(0.2, H - concaveDepth);
      var cylGeo = new THREE.CylinderGeometry(r, r, bodyH, 32, 1, true);
      cylGeo.rotateX(Math.PI / 2);               // 轴对齐 Z
      cylGeo.translate(0, 0, -gap - concaveDepth - bodyH / 2);
      addPart(cylGeo);
      // 底盖（CircleGeometry 已在 XY 平面，垂直于 Z 轴，无需旋转）
      var botGeo = new THREE.CircleGeometry(r, 32);
      botGeo.translate(0, 0, -gap - H);
      addPart(botGeo);
      // 凹面球冠：球心在 z=sphereCenterZ，取 theta∈[phiRim, π] 段
      var R = (r * r + concaveDepth * concaveDepth) / (2 * concaveDepth);
      var sphereCenterZ = -gap - concaveDepth + R;
      var cosRim = Math.max(-1, Math.min(1, (concaveDepth - R) / R));
      var phiRim = Math.acos(cosRim);
      var sphGeo = new THREE.SphereGeometry(R, 32, 12, 0, Math.PI * 2, phiRim, Math.PI - phiRim);
      sphGeo.rotateX(Math.PI / 2);               // 北极→+Z
      sphGeo.translate(0, 0, sphereCenterZ);
      addPart(sphGeo);
    } else if (type === 'convex') {
      var r2 = W / 2;
      var domeR = Math.max(convexRadius, r2);    // 确保 R≥r，球冠可解
      var domeH = (domeR >= r2) ? (domeR - Math.sqrt(Math.max(0, domeR * domeR - r2 * r2))) : r2;
      var bodyH2 = Math.max(0.2, H - domeH);
      var cylGeo2 = new THREE.CylinderGeometry(r2, r2, bodyH2, 32, 1, true);
      cylGeo2.rotateX(Math.PI / 2);
      cylGeo2.translate(0, 0, -gap - domeH - bodyH2 / 2);
      addPart(cylGeo2);
      // 底盖（无需旋转，已在 XY 平面）
      var botGeo2 = new THREE.CircleGeometry(r2, 32);
      botGeo2.translate(0, 0, -gap - H);
      addPart(botGeo2);
      // 凸面球冠：球心在 z=-gap-domeR，取 theta∈[0, phiBase] 段（朝 +Z）
      var cosBase = Math.max(-1, Math.min(1, 1 - domeH / domeR));
      var phiBase = Math.acos(cosBase);
      var domeGeo = new THREE.SphereGeometry(domeR, 32, 12, 0, Math.PI * 2, 0, phiBase);
      domeGeo.rotateX(Math.PI / 2);              // 北极→+Z
      domeGeo.translate(0, 0, -gap - domeR);
      addPart(domeGeo);
    }

    // 应用位姿 + 与导光柱相同的归一化变换：
    // 显示坐标 = R·(s·local) + T，其中 R = mesh旋转 × 位姿基（无位姿时=mesh旋转，与 tx3 光线一致），
    // T = tx3(位姿平移)（恒等位姿时 = mesh 旋转后的 -c·s，即旧版默认位置）。
    // 多灯珠：ledParams.poses 数组（每个入射平面一颗，RayTracer.computeLEDPoses 生成），
    // 灯珠沿入射面法向放置在入射面前方，发射方向与法向对齐；
    // 兼容旧版单 ledParams.pose；参数化圆柱无位姿 → [null] 保持默认坐标。
    var poseList = (ledParams.poses && ledParams.poses.length) ? ledParams.poses
                 : (ledParams.pose ? [ledParams.pose] : [null]);
    var container = new THREE.Group();
    for (var pi = 0; pi < poseList.length; pi++) {
      var g = (pi === 0) ? group : group.clone();   // 克隆共享几何/材质，开销极小
      var pose = poseList[pi];
      var posMM = pose ? pose.pos : [0, 0, 0];
      // 装配偏移公差：仅移动 LED 灯珠，不影响导光柱本体位姿
      if (pose && LG.state && LG.state.project && LG.state.project.eng) {
        var ox = LG.state.project.eng.offsetX || 0;
        var oy = LG.state.project.eng.offsetY || 0;
        if (ox || oy) {
          posMM = [
            posMM[0] + ox * pose.x[0] + oy * pose.y[0],
            posMM[1] + ox * pose.x[1] + oy * pose.y[1],
            posMM[2] + ox * pose.x[2] + oy * pose.y[2]
          ];
        }
      }
      var basis = new THREE.Matrix4();
      if (pose) {
        basis.makeBasis(
          new THREE.Vector3(pose.x[0], pose.x[1], pose.x[2]),
          new THREE.Vector3(pose.y[0], pose.y[1], pose.y[2]),
          new THREE.Vector3(pose.z[0], pose.z[1], pose.z[2]));
      } else {
        basis.identity();
      }
      var q = new THREE.Quaternion().setFromRotationMatrix(basis);
      if (mesh) q.premultiply(mesh.quaternion);
      g.quaternion.copy(q);
      var pw = tx3(posMM);
      g.position.set(pw[0], pw[1], pw[2]);
      g.scale.set(xform.scale, xform.scale, xform.scale);
      container.add(g);
    }

    ledMesh = container;
    scene.add(ledMesh);
  }

  // ================= 盘（Plate）：3D 主窗口内直接铺开的多盘 =================
  // 每个项目 = 一个 3D 盘面，每行 4 块、超出换行纵向排布；当前盘落在世界原点并加深盘面 +
  // 青色边框，其余盘为浅色；盘名 / 序号 / 快捷控件是 HTML 浮层，按 3D 投影跟随盘面。

  // 盘网格纹理：两级网格（细格 + 每 5 格一条主线），分辨率提高后拉升到 50 单位盘面才清晰。
  // 配色参考 OrcaSlicer：浅盘灰底深灰线，当前盘深炭灰底 + 半透明白线。
  var PLATE_CELLS = 25;
  function plateGridTexture(dark) {
    var S = 1024;
    var cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    var c = cv.getContext('2d');
    c.fillStyle = dark ? '#33383B' : '#E4E4E4';
    c.fillRect(0, 0, S, S);
    var fine = dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
    var major = dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.20)';
    for (var i = 0; i <= PLATE_CELLS; i++) {
      var t = i * S / PLATE_CELLS;
      var isMajor = i % 5 === 0;
      c.strokeStyle = isMajor ? major : fine;
      c.lineWidth = isMajor ? 3 : 2;
      c.beginPath(); c.moveTo(t, 0); c.lineTo(t, S); c.stroke();
      c.beginPath(); c.moveTo(0, t); c.lineTo(S, t); c.stroke();
    }
    var tex = new THREE.CanvasTexture(cv);
    // 斜视角下网格线容易被各向异性过滤糊掉，开到硬件上限
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  // ---- 盘面快捷控件：矢量图标 → Canvas 纹理 → Sprite（随盘同比例缩放） ----
  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /** 生成按钮纹理：act = del|orient|lock|unlock|order；active 当前盘变色；disabled 锁定盘置灰 */
  function plateBtnTexture(act, active, disabled) {
    var key = act + '|' + (active ? 1 : 0) + '|' + (disabled ? 1 : 0);
    if (plateBtnTex[key]) return plateBtnTex[key];
    var S = 128;
    var cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    var c = cv.getContext('2d');
    var pad = 8;
    roundRectPath(c, pad, pad, S - pad * 2, S - pad * 2, 26);
    c.fillStyle = disabled ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.94)';
    c.fill();
    c.lineWidth = 5;
    c.strokeStyle = disabled ? 'rgba(180,196,208,0.7)'
                  : (act === 'del' ? 'rgba(229,72,77,0.55)' : (active ? 'rgba(47,191,168,0.95)' : 'rgba(28,114,147,0.32)'));
    c.stroke();

    var ink = disabled ? 'rgba(71,105,126,0.32)' : (act === 'del' ? '#C0362C' : '#2C5B72');
    c.strokeStyle = ink; c.fillStyle = ink;
    c.lineWidth = 8; c.lineCap = 'round'; c.lineJoin = 'round';
    var m = S / 2, r = S * 0.17;
    if (act === 'del') {
      c.beginPath(); c.moveTo(m - r, m - r); c.lineTo(m + r, m + r); c.stroke();
      c.beginPath(); c.moveTo(m + r, m - r); c.lineTo(m - r, m + r); c.stroke();
    } else if (act === 'orient') {
      c.beginPath();
      c.moveTo(m, m - r * 1.15); c.lineTo(m + r * 1.15, m);
      c.lineTo(m, m + r * 1.15); c.lineTo(m - r * 1.15, m);
      c.closePath(); c.stroke();
    } else if (act === 'lock' || act === 'unlock') {
      // 锁体
      var bw = S * 0.30, bh = S * 0.24;
      roundRectPath(c, m - bw / 2, m - bh * 0.15, bw, bh, 7);
      c.fill();
      // 锁梁：锁定=完整圆弧；解锁=向右侧开口
      c.lineWidth = 8;
      c.beginPath();
      if (act === 'lock') {
        c.arc(m, m - bh * 0.15, S * 0.135, Math.PI, 0);
      } else {
        c.arc(m + S * 0.055, m - bh * 0.15, S * 0.135, Math.PI * 0.98, Math.PI * 0.12, false);
      }
      c.stroke();
    } else if (act === 'order') {
      // 上下双箭头
      var aw = S * 0.115, ah = S * 0.135;
      c.beginPath();
      c.moveTo(m, m - r * 1.25); c.lineTo(m + aw, m - r * 1.25 + ah); c.lineTo(m - aw, m - r * 1.25 + ah);
      c.closePath(); c.fill();
      c.beginPath();
      c.moveTo(m, m + r * 1.25); c.lineTo(m + aw, m + r * 1.25 - ah); c.lineTo(m - aw, m + r * 1.25 - ah);
      c.closePath(); c.fill();
    }
    var tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    plateBtnTex[key] = tex;
    return tex;
  }

  /** 为一块盘创建竖排 Sprite 按钮列：贴盘右侧边、自盘上角向下排列（世界坐标与盘同比例） */
  function buildPlateSprites(it, on, grp, hw, hd) {
    // act 是派发给页面层的动作（lock 恒为切换锁定）；icon 只决定图标外观
    var acts = [
      { act: 'del', icon: 'del' },
      { act: 'orient', icon: 'orient' },
      { act: 'lock', icon: it.locked ? 'unlock' : 'lock' },
      { act: 'order', icon: 'order' }
    ];
    for (var k = 0; k < acts.length; k++) {
      var act = acts[k].act, icon = acts[k].icon;
      var disabled = it.locked && act !== 'lock';
      var spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: plateBtnTexture(icon, on, disabled),
        transparent: true, depthTest: false, depthWrite: false
      }));
      spr.scale.set(PLATE_BTN, PLATE_BTN, 1);
      spr.position.set(
        hw + PLATE_BTN * 0.72,
        PLATE_BTN * 0.62,                                   // 略高于盘面，避免与网格纹理互压
        -hd + PLATE_BTN * 0.72 + k * PLATE_BTN_STEP         // 自盘上角（-Z 边）向下竖排
      );
      spr.renderOrder = 20;
      spr.userData = { pid: it.id, act: act, icon: icon, disabled: disabled };
      grp.add(spr);
      plateBtnSprites.push(spr);
    }
  }

  /** Sprite → DOM 风格锚点：把按钮的屏幕位置/像素尺寸暴露给弹出层（model 页沿用 getBoundingClientRect） */
  function spriteAnchor(spr) {
    return {
      getBoundingClientRect: function () {
        var rect = renderer.domElement.getBoundingClientRect();
        var wp = spr.getWorldPosition(new THREE.Vector3());
        var ndc = wp.clone().project(camera);
        var cx = rect.left + (ndc.x * 0.5 + 0.5) * rect.width;
        var cy = rect.top + (-ndc.y * 0.5 + 0.5) * rect.height;
        var dist = camera.position.distanceTo(wp);
        var px = spr.scale.y / (2 * Math.max(dist, 1e-6) * Math.tan(camera.fov * Math.PI / 360)) * rect.height;
        return {
          left: cx - px / 2, right: cx + px / 2, top: cy - px / 2, bottom: cy + px / 2,
          width: px, height: px, x: cx - px / 2, y: cy - px / 2
        };
      }
    };
  }

  /** 悬停提示：Sprite 没有原生 title，用浮层跟随鼠标显示当前按钮说明 */
  function setPlateHover(spr, rect, e) {
    if (!renderer) return;
    var ud = spr && spr.userData;
    renderer.domElement.style.cursor = (ud && !ud.disabled) ? 'pointer' : '';
    if (!plateTipEl) return;
    if (!ud) { plateTipEl.style.display = 'none'; plateHoverKey = ''; return; }
    var key = ud.pid + '|' + ud.act + '|' + ud.icon;
    if (key !== plateHoverKey) {
      plateHoverKey = key;
      var map = plateTips || {};
      var txt = (ud.act === 'lock')
        ? (ud.icon === 'unlock' ? map.unlock : map.lock)
        : map[ud.act];
      plateTipEl.textContent = txt || '';
      plateTipEl.style.display = txt ? '' : 'none';
    }
    if (plateTipEl.style.display !== 'none' && rect) {
      plateTipEl.style.left = (e.clientX - rect.left + 14) + 'px';
      plateTipEl.style.top = (e.clientY - rect.top - 28) + 'px';
    }
  }

  function ensurePlateUI(slot) {
    if (!slot) return;
    var host = slot.parentNode || slot;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    if (!plateUIHost) {
      plateUIHost = document.createElement('div');
      plateUIHost.className = 'plate-ov';
      // 快捷控件已改为 3D Sprite（见 buildPlateSprites），浮层只保留盘名/盘号与悬停提示
      plateTipEl = document.createElement('div');
      plateTipEl.className = 'plate-tip';
      plateTipEl.style.display = 'none';
      plateUIHost.appendChild(plateTipEl);
    }
    if (plateUIHost.parentNode !== host) host.appendChild(plateUIHost);
  }

  function clearPlates() {
    lastPlateArgs = null;
    if (plateLayer) {
      scene.remove(plateLayer);
      plateLayer.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();   // 网格纹理 plateTex / 按钮纹理 plateBtnTex 全局复用，不随材质销毁
      });
      plateLayer = null;
    }
    plates = []; plateActiveId = null; plateLab = {};
    platePartMeshes = [];
    plateBtnSprites = []; plateHoverKey = '';
    if (plateTipEl) plateTipEl.style.display = 'none';
    if (plateUIHost && plateUIHost.parentNode) plateUIHost.parentNode.removeChild(plateUIHost);
    plateUIHost = null; plateTipEl = null;
    if (gridHelper) gridHelper.visible = true;
    syncFloorGuide();
  }

  /** 参考网格（无盘页面等同「盘面」）跟随零件最低点：
   *  否则网格固定在 y=-0.02，而零件几何中心被归一到原点，零件会一半穿到网格下面。
   *  与 setPlates 的盘面高度规则保持同一口径（零件最低点 - 0.02）。 */
  function syncFloorGuide() {
    if (!gridHelper || gridHelper.visible === false) return;
    var y = -0.02;
    if (mesh && mesh.geometry) {
      mesh.updateMatrixWorld(true);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) {
        var bb = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
        if (isFinite(bb.min.y)) y = bb.min.y - 0.02;
      }
    }
    gridHelper.position.y = y;
  }

  /** 轻量「零件」示意网格：把 mm 几何归一化到盘面尺度，并让底面正好坐在盘面上 */
  function buildPlatePart(positions, indices) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (indices) g.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
    if (!g.hasAttribute('normal')) g.computeVertexNormals();
    g.computeBoundingBox();
    var size = new THREE.Vector3(), center = new THREE.Vector3();
    g.boundingBox.getSize(size); g.boundingBox.getCenter(center);
    var k = 4.2 / Math.max(size.x, size.y, size.z, 0.001);
    g.translate(-center.x, -g.boundingBox.min.y, -center.z);
    g.scale(k, k, k);
    var m = new THREE.Mesh(g, new THREE.MeshPhongMaterial({
      color: 0x218D83, transparent: true, opacity: 0.5, depthWrite: false,
      side: THREE.DoubleSide, shininess: 20
    }));
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 8),
      new THREE.LineBasicMaterial({ color: 0x136B63, transparent: true, opacity: 0.5, depthTest: false })));
    return m;
  }

  /**
   * 铺开多盘：items = [{id,name,locked,positions,indices,parts}]（无 positions 则该盘为空盘）
   * 一盘多零件时用 parts:[{id,name,positions,indices}]；旧结构没有 parts 时自动包成单零件。
   * tips = {del,orient,lock,unlock,order} 快捷控件的中英文提示（由页面层提供）
   * 当前盘固定落在世界原点，其余盘按 3 列网格环绕，零件 / 光线 / 灯珠坐标保持不变。
   */
  function setPlates(items, activeId, tips) {
    ensure();
    clearPlates();
    plateActiveId = activeId || null;
    plateTips = tips || null;
    items = items || [];
    lastPlateArgs = { items: items, activeId: activeId, tips: tips };
    if (!items.length) return;

    if (!plateTex.light) plateTex.light = plateGridTexture(false);
    if (!plateTex.dark) plateTex.dark = plateGridTexture(true);

    plateLayer = new THREE.Group();
    scene.add(plateLayer);
    if (gridHelper) gridHelper.visible = false;

    // 当前盘判定：盘的 parts 里包含当前项目，或盘的代表项目就是当前项目
    var activeIdx = 0;
    for (var i = 0; i < items.length; i++) {
      var hitActive = items[i].id === plateActiveId;
      if (!hitActive && items[i].parts) {
        for (var pi = 0; pi < items[i].parts.length; pi++) {
          if (items[i].parts[pi].id === plateActiveId) { hitActive = true; break; }
        }
      }
      if (hitActive) { activeIdx = i; break; }
    }
    var ax = (activeIdx % PLATE_COLS - (PLATE_COLS - 1) / 2) * (PLATE_W + PLATE_GAP);
    var az = Math.floor(activeIdx / PLATE_COLS) * (PLATE_D + PLATE_GAP);

    // 盘面高度 = 当前零件的最低点，使零件像 OrcaSlicer 一样「摆在」盘面上（不被盘面遮挡）
    // 注意：只按零件几何体的世界包围盒计算，避免被挂在其下的灯珠/高亮等辅助对象影响
    var floorY = -0.02;
    if (mesh && mesh.geometry) {
      mesh.updateMatrixWorld(true);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) {
        var bb = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
        if (isFinite(bb.min.y)) floorY = bb.min.y - 0.02;
      }
    }
    plateFloorY = floorY;

    for (i = 0; i < items.length; i++) {
      var it = items[i], on = i === activeIdx;
      var grp = new THREE.Group();
      grp.position.set(
        (i % PLATE_COLS - (PLATE_COLS - 1) / 2) * (PLATE_W + PLATE_GAP) - ax,
        floorY,
        Math.floor(i / PLATE_COLS) * (PLATE_D + PLATE_GAP) - az
      );

      var board = new THREE.Mesh(new THREE.PlaneGeometry(PLATE_W, PLATE_D),
        new THREE.MeshBasicMaterial({
          map: on ? plateTex.dark : plateTex.light,
          transparent: true, opacity: on ? 0.98 : 0.9, side: THREE.DoubleSide
        }));
      board.rotation.x = -Math.PI / 2;
      board.userData.pid = it.id;
      // 底板是「近乎不透明的大平面」，必须固定排在最前面绘制：
      // 否则它会和半透明零件一起按距离排序，某些视角下后绘制把零件整块盖住（零件时隐时现）
      board.renderOrder = -10;
      grp.add(board);

      var hw = PLATE_W / 2, hd = PLATE_D / 2;
      var bgeo = new THREE.BufferGeometry();
      // 只给 LineLoop 4 个角点，让它自动首尾闭合；一旦 setIndex([0,1,2,0,2,3])
      // 就会额外画出 0→2 的对角线（盘面上的斜线 bug）
      bgeo.setAttribute('position', new THREE.Float32BufferAttribute(
        [-hw, 0.004, -hd, hw, 0.004, -hd, hw, 0.004, hd, -hw, 0.004, hd], 3));
      grp.add(new THREE.LineLoop(bgeo, new THREE.LineBasicMaterial({
        color: on ? 0x2FBFA8 : 0xC2CCD5, transparent: true, opacity: on ? 1 : 0.85
      })));

      // 盘上的零件：兼容旧结构（无 parts 时自动包成单零件）
      //  - 当前盘：真实网格保持原位，同盘其它零件摆到右侧（x = +4.6、+9.2…）
      //  - 非当前盘：全部零件按槽位居中排开
      var parts = (it.parts && it.parts.length) ? it.parts
        : [{ id: it.id, name: it.name, positions: it.positions, indices: it.indices }];
      var slot = 0;
      for (var q = 0; q < parts.length; q++) {
        var pt = parts[q] || {};
        if (on && pt.id === plateActiveId) continue;   // 当前零件由真实 mesh 呈现
        if (!pt.positions || !pt.positions.length) continue;
        if (on) slot++;
        var pm = buildPlatePart(pt.positions, pt.indices);
        pm.position.x = on ? 4.6 * slot : (q - (parts.length - 1) / 2) * 4.6;
        pm.userData = pm.userData || {};
        pm.userData.pid = pt.id;
        grp.add(pm);
        platePartMeshes.push(pm);
      }

      // 快捷控件：3D Sprite（与盘同比例缩放，随相机缩放一并变化）
      buildPlateSprites(it, on, grp, hw, hd);

      plateLayer.add(grp);
      plates.push({ id: it.id, name: it.name, locked: !!it.locked, group: grp, board: board });
    }

    ensurePlateUI(renderer.domElement.parentNode);
    buildPlateLabels(items);
  }

  function buildPlateLabels(items) {
    if (!plateUIHost) return;
    plateUIHost.innerHTML = '';
    // innerHTML 清空会移除提示浮层，重建（快捷控件本身是 3D Sprite，不在此浮层内）
    plateTipEl = document.createElement('div');
    plateTipEl.className = 'plate-tip';
    plateTipEl.style.display = 'none';
    plateUIHost.appendChild(plateTipEl);
    plateLab = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      // 与 setPlates 同一口径：盘内任一零件是当前项目即视为当前盘
      var on = it.id === plateActiveId;
      if (!on && it.parts) {
        for (var q = 0; q < it.parts.length; q++) {
          if (it.parts[q].id === plateActiveId) { on = true; break; }
        }
      }
      var tag = document.createElement('div');
      tag.className = 'plate-tag' + (on ? ' is-active' : '');
      // 一盘多零件时在盘名后标注件数（如「导光柱 A · 2 件」）
      var pn = (it.parts && it.parts.length) || 0;
      tag.textContent = (it.locked ? '🔒 ' : '') + (it.name || '') +
        (pn > 1 ? ' · ' + LG.t('plate.parts', pn) : '');
      var num = document.createElement('div');
      num.className = 'plate-num';
      num.textContent = String(i + 1);
      plateUIHost.appendChild(tag);
      plateUIHost.appendChild(num);
      plateLab[it.id] = { tag: tag, num: num };
    }
  }

  function plateWorldPos(idx) {
    var g = plates[idx].group;
    return {
      x: g.position.x + plateLayer.position.x,
      y: g.position.y + plateLayer.position.y,
      z: g.position.z + plateLayer.position.z
    };
  }

  /** 相机框住全部盘面：按盘组八个角的实际投影反复收敛，任意视口宽高比下都尽量铺满且不出框 */
  function fitPlates() {
    if (!plates.length) return false;
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (var i = 0; i < plates.length; i++) {
      var w = plateWorldPos(i);
      minX = Math.min(minX, w.x - PLATE_W / 2); maxX = Math.max(maxX, w.x + PLATE_W / 2);
      minZ = Math.min(minZ, w.z - PLATE_D / 2); maxZ = Math.max(maxZ, w.z + PLATE_D / 2);
      y0 = Math.min(y0, w.y); y1 = Math.max(y1, w.y);
    }
    var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, cy = (y0 + y1) / 2 + 2;
    var corners = [];
    for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++) for (var c = 0; c < 2; c++) {
      corners.push(new THREE.Vector3(a ? maxX : minX, (b ? y1 : y0) + 4, c ? maxZ : minZ));
    }
    var dir = new THREE.Vector3(0.62, 0.66, 0.8).normalize();
    var span = Math.max(maxX - minX, maxZ - minZ, 4);
    var d = span / 2 / Math.tan(camera.fov * Math.PI / 360) * 1.1;
    controls.target.set(cx, cy, cz);
    for (var k = 0; k < 5; k++) {
      camera.position.set(cx + dir.x * d, cy + dir.y * d, cz + dir.z * d);
      camera.lookAt(cx, cy, cz);
      camera.updateMatrixWorld(true);
      var mx = 0;
      for (var j = 0; j < corners.length; j++) {
        var p = corners[j].clone().project(camera);
        mx = Math.max(mx, Math.abs(p.x), Math.abs(p.y));
      }
      if (!(mx > 0.001)) break;
      var nd = d * (mx / 0.82);      // 盘组占视口约 82%，余量留给盘名与右侧按钮列
      var settled = Math.abs(nd - d) / d < 0.015;
      d = nd;
      if (settled) break;
    }
    camera.position.set(cx + dir.x * d, cy + dir.y * d, cz + dir.z * d);
    camera.near = Math.max(d * 0.002, 0.01); camera.far = d * 20;
    camera.updateProjectionMatrix();
    controls.update();
    return true;
  }

  var _pv = null;
  function projectPt(x, y, z) {
    if (!_pv) _pv = new THREE.Vector3();
    _pv.set(x, y, z).project(camera);
    var el = renderer.domElement;
    return {
      x: (_pv.x * 0.5 + 0.5) * el.clientWidth,
      y: (-_pv.y * 0.5 + 0.5) * el.clientHeight,
      ok: _pv.z > -1 && _pv.z < 1
    };
  }

  function placeAt(el, pt) {
    if (!el) return;
    el.style.left = pt.x.toFixed(1) + 'px';
    el.style.top = pt.y.toFixed(1) + 'px';
    el.style.display = pt.ok ? '' : 'none';
  }

  /** 每帧把盘名 / 序号按 3D 投影贴到屏幕上（快捷控件是 3D Sprite，由 WebGL 直接渲染，无需逐帧定位） */
  function updatePlateUI() {
    if (!plateUIHost || !plates.length || !renderer) return;
    camera.updateMatrixWorld();
    var hw = PLATE_W / 2, hd = PLATE_D / 2;
    for (var i = 0; i < plates.length; i++) {
      var p = plates[i], lab = plateLab[p.id];
      if (!lab) continue;
      var w = plateWorldPos(i);
      placeAt(lab.tag, projectPt(w.x - hw + 2, w.y, w.z - hd + 2));
      placeAt(lab.num, projectPt(w.x + hw - 1.2, w.y, w.z + hd - 1.2));
    }
  }

  function onPlatePick(cb) { platePickCb = cb || null; }
  function onPlateTool(cb) { plateToolCb = cb || null; }
  /** 测试用：按盘 id 触发切盘回调（等价于点击该盘盘面） */
  function _pickPlate(id) { if (platePickCb) platePickCb(id); }

  function fitView() {
    if (plates.length) return fitPlates();
    if (!meshGeometry) return;
    meshGeometry.computeBoundingBox();
    var center = new THREE.Vector3(), size = new THREE.Vector3();
    meshGeometry.boundingBox.getCenter(center);
    meshGeometry.boundingBox.getSize(size);
    var maxDim = Math.max(size.x, size.y, size.z) || 1;
    controls.target.copy(center);
    camera.position.set(center.x + maxDim * 1.4, center.y + maxDim * 0.9, center.z + maxDim * 1.4);
    camera.near = maxDim * 0.01; camera.far = maxDim * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function screenshot(w, h) {
    renderer.render(scene, camera);
    var src = renderer.domElement;
    if (w && h && (w !== src.width || h !== src.height)) {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var ctx = c.getContext('2d');
      ctx.drawImage(src, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.72);
    }
    return src.toDataURL('image/png');
  }
  function hasGeometry() { return !!meshGeometry; }
  /** 3D 场景是否已初始化（未 mount 过时为 false，页面外不应调用 setGeometryData） */
  function isReady() { return !!renderer; }

  /**
   * 拾取结果合并纯函数（simulate 页与单元测试共用）：
   *  - 普通点击未选面 → 单选替换为该平面组；
   *  - Shift+点击未选面 → 累加到当前选择；
   *  - 点击已选中的面（种子面已在选择集内）→ 取消该整面的选择。
   * 返回新的 id 数组。
   */
  function computeFacePickUpdate(existingIds, groupIds, opts) {
    opts = opts || {};
    var existing = (existingIds || []).slice();
    var group = groupIds || [];
    var seedIn = (opts.faceIndex != null)
      ? existing.indexOf(opts.faceIndex) !== -1
      : group.some(function (g) { return existing.indexOf(g) !== -1; });
    if (seedIn) {
      return existing.filter(function (id) { return group.indexOf(id) === -1; });
    }
    if (opts.shiftKey) {
      var out = existing.slice();
      for (var i = 0; i < group.length; i++) if (out.indexOf(group[i]) === -1) out.push(group[i]);
      return out;
    }
    return group.slice();
  }

  window.LG = window.LG || {};
  LG.Viewer = {
    mount: mount, unmount: unmount, resize: resize,
    setGeometryData: setGeometryData, clearGeometry: clearGeometry, hasGeometry: hasGeometry,
    isReady: isReady, faceCount: faceCount,
    autoEndCaps: autoEndCaps, setFaceHighlights: setFaceHighlights, clearFaceHighlights: clearFaceHighlights,
    setPick: setPick, setTransform: setTransform, showRays: showRays, clearRays: clearRays, fitView: fitView,
    showSpotSection: showSpotSection, clearSpotSection: clearSpotSection,
    /** 测试用：返回当前 3D 光斑截面组（THREE.Group 或 null） */
    _spotSection: function () { return spotPlane; },
    setLED: setLED, clearLED: clearLED, computeFacePickUpdate: computeFacePickUpdate,
    setPlates: setPlates, clearPlates: clearPlates, onPlatePick: onPlatePick,
    onPlateTool: onPlateTool, fitPlates: fitPlates,
    /** 页面层：注册文件拖放回调 (files, projectId) → 导入零件 */
    onFilesDrop: onFilesDrop,
    /** 零件选中 / 取消选中（可程序化调用；鼠标 click 也会自动触发） */
    selectMesh: selectMesh, deselectMesh: deselectMesh,
    /** 是否当前 mesh 被选中 */
    isSelected: function () { return !!partSelected; },
    /** 切换操作模式：'' | 'move' | 'rotate' | 'place' */
    setMode: setMode,
    /** 当前模式 */
    getMode: function () { return opMode; },
    /** 当前 mesh 的 mm 位姿（pos/rot） */
    getTransform: getTransform,
    /** 页面层回调：选中变化 / 模式变化 / 位姿变化 */
    onSelectChange: setSelectCb, onModeChange: setModeCb, onTransformChange: setTransformCb,
    /** 测试用：按盘 id 触发切盘（等价点击盘面） */
    _pickPlate: _pickPlate,
    /** 测试用：返回全部盘面 Sprite 快捷控件 */
    _plateButtons: function () { return plateBtnSprites.slice(); },
    /** 测试用：第 i 个按钮的屏幕像素高度（验证随相机缩放同比例变化） */
    _plateBtnScreenSize: function (i) {
      var spr = plateBtnSprites[i || 0];
      if (!spr || !camera || !renderer) return 0;
      var wp = spr.getWorldPosition(new THREE.Vector3());
      var dist = camera.position.distanceTo(wp);
      return spr.scale.y / (2 * Math.max(dist, 1e-6) * Math.tan(camera.fov * Math.PI / 360)) * renderer.domElement.clientHeight;
    },
    /** 测试用：第 i 个按钮的屏幕矩形（CSS 像素，相对视口） */
    _plateBtnRect: function (i) {
      var spr = plateBtnSprites[i || 0];
      return spr ? spriteAnchor(spr).getBoundingClientRect() : null;
    },
    screenshot: screenshot,
    raw: function () { return raw; },
    /** 测试用：返回第一颗 LED 灯珠的位姿组（THREE.Group 或 null） */
    _ledMesh: function () { return (ledMesh && ledMesh.children.length) ? ledMesh.children[0] : null; },
    /** 测试用：返回全部 LED 灯珠位姿组数组（多灯珠场景） */
    _ledMeshes: function () { return ledMesh ? ledMesh.children.slice() : []; },
    /** 测试用：返回当前 xform 变换参数 */
    _xform: function () { return { cx: xform.cx, cy: xform.cy, cz: xform.cz, scale: xform.scale }; },
    /** 测试用：返回端面高亮及其父级，用于验证高亮是否跟随 mesh 位姿 */
    _highlights: function () {
      return {
        input: highlights.input, output: highlights.output,
        inputParent: highlights.input && highlights.input.parent === mesh,
        outputParent: highlights.output && highlights.output.parent === mesh
      };
    },
    /** 测试用：返回光线段的变换后顶点数组，无光线时返回 null */
    _rayPositions: function () {
      if (!rayLines) return null;
      var all = [];
      rayLines.children.forEach(function (line) {
        var pos = line.geometry.attributes.position;
        if (pos) for (var i = 0; i < pos.array.length; i++) all.push(pos.array[i]);
      });
      return all.length ? all : null;
    }
  };
})();
