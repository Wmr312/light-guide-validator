// light-guide-validator 导光柱光学仿真验证平台 — 课题演示 PPT 生成脚本
// Ocean Gradient 主题：深海蓝 #065A82 / 青绿 #1C7293 / 午夜蓝 #21295C
const pptxgen = require("pptxgenjs");
const pres = new pptxgen();

// ============================================================
// SLIDE DIMENSIONS
// ============================================================
pres.layout = "LAYOUT_16x9";
const SLIDE_W = 10;
const SLIDE_H = 5.625;
const MARGIN = 0.5;
const CONTENT_X = MARGIN;
const CONTENT_Y = MARGIN;
const CONTENT_W = SLIDE_W - 2 * MARGIN;
const CONTENT_H = SLIDE_H - 2 * MARGIN;
const CENTER_X = SLIDE_W / 2;
const CENTER_Y = SLIDE_H / 2;

// ============================================================
// COLOR PALETTE — Ocean Gradient
// ============================================================
const C = {
  primary: "065A82",
  secondary: "1C7293",
  accent: "21295C",
  bg: "F0F7FA",
  light: "E8F4F8",
  white: "FFFFFF",
  text: "1A2744",
  muted: "64748B",
  red: "E5484D",
  green: "22C55E",
  amber: "D97706",
};

// ============================================================
// CONTAINER SYSTEM
// ============================================================
function parseImageDimensions(path) {
  const m = path.match(/_(\d+)x(\d+)\.(png|jpg|jpeg|gif|webp)$/i);
  return m ? { width: +m[1], height: +m[2] } : null;
}
function calcImg(opts) {
  const { path, w: tW, h: tH, x = 0, y = 0, ...rest } = opts;
  if (!path || !tW || !tH) return opts;
  const d = parseImageDimensions(path);
  if (!d) return opts;
  const ia = d.width / d.height, ta = tW / tH;
  let sW, sH, oX = 0, oY = 0;
  if (ia > ta) { sW = tW; sH = tW / ia; oY = (tH - sH) / 2; }
  else { sH = tH; sW = tH * ia; oX = (tW - sW) / 2; }
  return { path, x: x + oX, y: y + oY, w: sW, h: sH, ...rest };
}
function createNode(type, data, pX = 0, pY = 0) {
  const o = data.opts || {};
  const n = { type, data, absX: pX + (o.x || 0), absY: pY + (o.y || 0), w: o.w || 0, h: o.h || 0, children: [] };
  n.addShape = function (st, opts = {}) { const c = createNode("shape", { shapeType: st, opts }, n.absX, n.absY); n.children.push(c); return c; };
  n.addText = function (t, opts = {}) { const c = createNode("text", { text: t, opts: { fit: "shrink", ...opts } }, n.absX, n.absY); n.children.push(c); return c; };
  n.addImage = function (opts = {}) { const c = createNode("image", { opts: calcImg(opts) }, n.absX, n.absY); n.children.push(c); return c; };
  n.addTable = function (td, opts = {}) { const c = createNode("table", { tableData: td, opts }, n.absX, n.absY); n.children.push(c); return c; };
  return n;
}
function flatten(node, real) {
  const o = { ...node.data.opts, x: node.absX, y: node.absY };
  if (node.type === "shape") real.addShape(node.data.shapeType, o);
  else if (node.type === "text") real.addText(node.data.text, o);
  else if (node.type === "image") real.addImage(o);
  else if (node.type === "table") real.addTable(node.data.tableData, o);
  node.children.forEach(c => flatten(c, real));
}
const origAdd = pres.addSlide.bind(pres);
pres.addSlide = function (opts) {
  const real = origAdd(opts);
  const vs = { children: [], _real: real,
    set background(v) { real.background = v; }, get background() { return real.background; },
    addShape: function (st, o = {}) { const n = createNode("shape", { shapeType: st, opts: o }, 0, 0); this.children.push(n); return n; },
    addText: function (t, o = {}) { const n = createNode("text", { text: t, opts: { fit: "shrink", ...o } }, 0, 0); this.children.push(n); return n; },
    addImage: function (o = {}) { const n = createNode("image", { opts: calcImg(o) }, 0, 0); this.children.push(n); return n; },
    addTable: function (td, o = {}) { const n = createNode("table", { tableData: td, opts: o }, 0, 0); this.children.push(n); return n; },
    addChart: function (ct, d, o = {}) { real.addChart(ct, d, o); },
    render: function () { this.children.forEach(c => flatten(c, real)); }
  };
  return vs;
};

// ============================================================
// HELPER: Section number badge
// ============================================================
function sectionBadge(slide, num, label) {
  const badge = slide.addShape(pres.shapes.OVAL, { x: CONTENT_X, y: CONTENT_Y, w: 0.42, h: 0.42, fill: { color: C.primary }, line: { color: C.primary } });
  badge.addText(num, { x: 0, y: 0, w: 0.42, h: 0.42, align: "center", valign: "middle", fontSize: 13, color: C.white, bold: true });
  slide.addText(label, { x: CONTENT_X + 0.52, y: CONTENT_Y + 0.02, w: CONTENT_W - 0.52, h: 0.4, fontSize: 22, bold: true, color: C.accent, fontFace: "Georgia", charSpacing: 1.5 });
}

// ============================================================
// SLIDE 1: Cover
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.accent };
  // Decorative gradient bar
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: SLIDE_H - 1.3, w: SLIDE_W, h: 1.3, fill: { type: "solid", color: C.primary } });
  // Title
  s.addText("light-guide-validator", { x: 0.8, y: 1.0, w: 8.4, h: 0.9, fontSize: 36, bold: true, color: C.white, fontFace: "Georgia", charSpacing: 2.5 });
  s.addText("导光柱光学仿真验证平台", { x: 0.8, y: 1.85, w: 8.4, h: 0.5, fontSize: 20, color: C.light, fontFace: "Georgia", charSpacing: 1.5 });
  // Subtitle
  s.addText("以蒙特卡洛光线追迹替代物理试错，驱动导光柱从结构设计到出光品质的全流程革新", { x: 0.8, y: 2.5, w: 7.5, h: 0.6, fontSize: 13, color: C.light, italic: true });
  // Bottom info
  s.addText("课题方向 · 光学工程 / 结构设计", { x: 0.8, y: SLIDE_H - 0.95, w: 5, h: 0.35, fontSize: 12, color: C.white });
  s.addText("2026 年 10 月", { x: SLIDE_W - 2.8, y: SLIDE_H - 0.95, w: 2, h: 0.35, fontSize: 12, color: C.light, align: "right" });
  s.render();
}

// ============================================================
// SLIDE 2: Table of Contents
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addText("CONTENTS · 课题框架", { x: CONTENT_X, y: CONTENT_Y, w: CONTENT_W, h: 0.5, fontSize: 24, bold: true, color: C.accent, fontFace: "Georgia", charSpacing: 1.5 });
  s.addText("从物理试错到数字迭代 — light-guide-validator 全流程框架", { x: CONTENT_X, y: CONTENT_Y + 0.5, w: CONTENT_W, h: 0.35, fontSize: 13, color: C.muted, italic: true });

  const items = [
    { num: "01", title: "行业痛点", desc: "研华工程师面临：反复开模、周期长、成本高、出光不可控" },
    { num: "02", title: "软件概览", desc: "解决方案：自研轻量蒙特卡洛光追平台，纯前端、零部署、浏览器即用" },
    { num: "03", title: "核心能力", desc: "参数化建模、多灯珠自动放置、实时 3D 可视化、实测对比" },
    { num: "04", title: "关键参数", desc: "棱镜角度、周期、折射率、LED 耦合等核心优化变量" },
    { num: "05", title: "对比优势", desc: "传统试错 vs 数字仿真：成本、周期、良率三维对比" },
    { num: "06", title: "落地路径", desc: "试点验证 → 模板沉淀 → 自动优化闭环的三步实施计划" },
  ];

  const cardW = (CONTENT_W - 0.3) / 2;
  const cardH = 0.65;
  const gapY = 0.72;
  const startY = CONTENT_Y + 1.0;
  items.forEach((item, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = CONTENT_X + col * (cardW + 0.3);
    const y = startY + row * gapY;
    const card = s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cardW, h: cardH, fill: { color: C.white }, line: { color: C.light, width: 1 } });
    card.addShape(pres.shapes.OVAL, { x: 0.12, y: 0.13, w: 0.4, h: 0.4, fill: { color: C.primary } }).addText(item.num, { x: 0, y: 0, w: 0.4, h: 0.4, align: "center", valign: "middle", fontSize: 11, color: C.white, bold: true });
    card.addText(item.title, { x: 0.62, y: 0.08, w: cardW - 0.7, h: 0.28, fontSize: 13, bold: true, color: C.accent });
    card.addText(item.desc, { x: 0.62, y: 0.33, w: cardW - 0.75, h: 0.28, fontSize: 9.5, color: C.muted });
  });
  s.render();
}

// ============================================================
// SLIDE 3: 行业痛点
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  sectionBadge(s, "01", "行业痛点");
  s.addText("研华工程师在导光柱开发中面临四大核心痛点", { x: CONTENT_X, y: CONTENT_Y + 0.5, w: CONTENT_W, h: 0.35, fontSize: 13, color: C.muted });

  const pains = [
    { icon: "①", title: "反复开模打样", desc: "单次周期 1–2 周，一个项目 3–5 轮才能收敛，模具费累计数万至数十万元", color: C.red },
    { icon: "②", title: "出光效果靠经验", desc: "棱镜角度、周期全凭老师傅感觉，热点暗斑频发，无法在设计阶段预知", color: C.amber },
    { icon: "③", title: "侧壁漏光难定位", desc: "全反射临界角外的大角度光线从侧壁泄漏，整机装配后才发现壳体透光", color: C.amber },
    { icon: "④", title: "设计变更成本高", desc: "客户一改外观形状，整套光学验证推倒重来，项目进度被严重拖累", color: C.red },
  ];

  const cardW = (CONTENT_W - 0.45) / 2;
  const cardH = 1.25;
  pains.forEach((p, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = CONTENT_X + col * (cardW + 0.45);
    const y = CONTENT_Y + 1.0 + row * (cardH + 0.2);
    const card = s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cardW, h: cardH, fill: { color: C.white }, line: { color: C.light, width: 1, dashType: "solid" } });
    card.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0, y: 0, w: 0.06, h: cardH, fill: { color: p.color }, line: { type: "none" } });
    card.addText(p.icon, { x: 0.2, y: 0.15, w: 0.35, h: 0.35, fontSize: 16, bold: true, color: p.color });
    card.addText(p.title, { x: 0.6, y: 0.15, w: cardW - 0.8, h: 0.3, fontSize: 14, bold: true, color: C.accent });
    card.addText(p.desc, { x: 0.6, y: 0.5, w: cardW - 0.85, h: 0.65, fontSize: 11, color: C.text, lineSpacingMultiple: 1.4 });
  });

  // Bottom bar
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: CONTENT_X, y: SLIDE_H - 0.6, w: CONTENT_W, h: 0.42, fill: { color: C.light }, line: { type: "none" } })
    .addText("传统开发流程：结构设计 → 开模打样 → 点亮测量 → 发现问题 → 修模/改结构 — 一轮循环 1–2 周，3–5 轮才能收敛", { x: 0.2, y: 0, w: CONTENT_W - 0.4, h: 0.42, fontSize: 10, color: C.accent, italic: true, valign: "middle" });
  s.render();
}

// ============================================================
// SLIDE 4: 软件概览
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  sectionBadge(s, "02", "软件概览");
  s.addText("解决方案 — 自研轻量蒙特卡洛光追验证平台：纯前端 · 零部署 · 浏览器即用", { x: CONTENT_X, y: CONTENT_Y + 0.5, w: CONTENT_W, h: 0.35, fontSize: 14, bold: true, color: C.accent });

  const features = [
    { t: "零安装 · 即开即用", d: "纯 HTML/JS 实现，浏览器打开即可使用，无需 SPEOS/TracePro 授权费" },
    { t: "蒙特卡洛光线追迹", d: "Möller–Trumbore 求交 + Beer-Lambert 吸收 + 空间网格加速 + Web Worker 后台计算" },
    { t: "参数化几何 + STL 导入", d: "参数化直圆柱/圆锥台 + 侧壁微齿 SPEOS 式渐变；矩形导光柱 / LGP 薄板经 STL/OBJ/STEP 导入" },
    { t: "多灯珠自动放置", d: "选取多个入射面自动按平面聚类放置多颗 LED，光线按面积加权分配" },
    { t: "实时 3D 可视化", d: "光线轨迹、出射端热图、轴向分布、配光曲线、光斑伪彩云图与能量账本；结果自动判定「设计合格 / 需优化 / 不合格」" },
    { t: "仿真 vs 实测对比", d: "CSV 批量导入实测数据，仿真与实测指标同表对比，一键生成 HTML 报告" },
  ];

  const cardW = (CONTENT_W - 0.3) / 3;
  const cardH = 1.15;
  features.forEach((f, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = CONTENT_X + col * (cardW + 0.15);
    const y = CONTENT_Y + 1.0 + row * (cardH + 0.15);
    const card = s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cardW, h: cardH, fill: { color: C.white }, line: { color: C.light } });
    card.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0, y: 0, w: cardW, h: 0.06, fill: { color: C.secondary }, line: { type: "none" } });
    card.addText(f.t, { x: 0.15, y: 0.15, w: cardW - 0.3, h: 0.3, fontSize: 11.5, bold: true, color: C.accent });
    card.addText(f.d, { x: 0.15, y: 0.5, w: cardW - 0.3, h: 0.6, fontSize: 9, color: C.text, lineSpacingMultiple: 1.3 });
  });

  // Bottom bar — 物理模型边界
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: CONTENT_X, y: SLIDE_H - 0.6, w: CONTENT_W, h: 0.42, fill: { color: C.light }, line: { type: "none" } })
    .addText("物理模型边界：介质按纯吸收（Beer-Lambert）建模，不含体散射 —— 含扩散粉工艺的出射均匀度按保守下界评估", { x: 0.2, y: 0, w: CONTENT_W - 0.4, h: 0.42, fontSize: 10, color: C.secondary, italic: true, valign: "middle" });
  s.render();
}

// ============================================================
// SLIDE 5: 核心能力
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  sectionBadge(s, "03", "核心能力");
  s.addText("从结构设计到出光品质 — 全链路数字化验证", { x: CONTENT_X, y: CONTENT_Y + 0.5, w: CONTENT_W, h: 0.35, fontSize: 13, color: C.muted });

  const caps = [
    { num: "1", t: "参数化几何建模", d: "直圆柱/圆锥台 + 侧壁微齿（SPEOS 式 85°→10° 线性渐变）；径向分段 24–48；齿距/齿宽/偏移精确可控", color: C.primary },
    { num: "2", t: "多灯珠自动放置", d: "拾取入射面后按平面聚类自动放置 LED 灯珠；选择几个入射面放几颗灯珠；光线按面积加权分配", color: C.secondary },
    { num: "3", t: "实时 3D 光线可视化", d: "绿色=到达出射端有效光线；红色=侧壁漏光；出射端 2D 照度热图 + 沿轴分布 + 配光极坐标曲线", color: C.accent },
    { num: "4", t: "能量守恒账本", d: "出射 / 侧面出光 / 吸收 / 残留 — 四象限能量分解，精确定位「光去哪了」", color: C.secondary },
    { num: "5", t: "仿真 vs 实测对比", d: "CSV 批量导入实测照度数据；仿真与实测均匀度/CV/照度均值同表对比；偏差一目了然", color: C.primary },
  ];

  const cardW = CONTENT_W;
  const cardH = 0.62;
  const gap = 0.08;
  caps.forEach((c, i) => {
    const y = CONTENT_Y + 0.95 + i * (cardH + gap);
    const card = s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: CONTENT_X, y, w: cardW, h: cardH, fill: { color: C.white }, line: { color: C.light } });
    card.addShape(pres.shapes.OVAL, { x: 0.12, y: 0.11, w: 0.4, h: 0.4, fill: { color: c.color } }).addText(c.num, { x: 0, y: 0, w: 0.4, h: 0.4, align: "center", valign: "middle", fontSize: 12, color: C.white, bold: true });
    card.addText(c.t, { x: 0.65, y: 0.08, w: 2.2, h: 0.3, fontSize: 12, bold: true, color: C.accent });
    card.addText(c.d, { x: 2.9, y: 0.08, w: cardW - 3.1, h: 0.48, fontSize: 9.5, color: C.text, lineSpacingMultiple: 1.3 });
  });
  s.render();
}

// ============================================================
// SLIDE 6: 关键参数
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  sectionBadge(s, "04", "关键参数");
  s.addText("light-guide-validator 核心参数与优化变量一览", { x: CONTENT_X, y: CONTENT_Y + 0.5, w: CONTENT_W, h: 0.35, fontSize: 13, color: C.muted });

  const rows = [
    [
      { text: "参数类别", options: { bold: true, color: C.white, fill: { color: C.primary }, align: "center", fontSize: 10 } },
      { text: "具体变量", options: { bold: true, color: C.white, fill: { color: C.primary }, fontSize: 10 } },
      { text: "典型取值范围", options: { bold: true, color: C.white, fill: { color: C.primary }, fontSize: 10 } },
      { text: "影响目标", options: { bold: true, color: C.white, fill: { color: C.primary }, fontSize: 10 } },
    ],
    ["几何结构", "导光柱直径、长度、截面形状", "Ø1–3mm / L5–20mm", "耦合效率、出光面积"],
    ["棱镜微结构", "棱镜角度、周期、宽度、偏移", "85°→10° / 1mm / 3mm", "出光均匀度（最敏感）"],
    ["材料光学", "折射率 n、体吸收 α（PC/PMMA/PS/PET/COC/BK7 + 自定义）", "PC 1.586 / PMMA 1.49", "临界角、光效、色偏"],
    ["光源耦合", "LED 功率、发光角、入射位置", "5–20lm / Lambert 120°", "入光效率、出光亮度"],
    ["LED 灯珠", "类型、尺寸、间隙 Gap", "矩形/凹面/凸面 / 0.2–1mm", "耦合精度、发散角"],
    ["仿真设置", "光线数、最大反弹、阈值", "1000–5000 / 30次 / 85%", "收敛精度、计算速度"],
  ];

  const colW = [1.3, 2.8, 2.4, 2.3];
  const tblY = CONTENT_Y + 0.95;
  s.addTable(rows, {
    x: CONTENT_X, y: tblY, w: CONTENT_W,
    colW,
    rowH: [0.35, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42],
    fill: { color: C.white },
    fontFace: "Calibri",
    fontSize: 10,
    color: C.text,
    border: { type: "solid", color: C.light, pt: 1 },
    valign: "middle",
    align: "left",
  });

  s.addText("※ 棱镜角度是影响出光均匀度最敏感的变量 — 85°（入射端，出光弱）→10°（出射端，出光强）的线性渐变是实现均匀出光的核心机制", {
    x: CONTENT_X, y: SLIDE_H - 0.55, w: CONTENT_W, h: 0.4, fontSize: 9, color: C.secondary, italic: true, fill: { color: C.light }
  });
  s.render();
}

// ============================================================
// SLIDE 7: 对比优势
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  sectionBadge(s, "05", "对比优势");
  s.addText("传统物理试错 VS light-guide-validator 数字仿真", { x: CONTENT_X, y: CONTENT_Y + 0.5, w: CONTENT_W, h: 0.35, fontSize: 13, color: C.muted });

  // Left: Traditional
  const leftX = CONTENT_X;
  const colW = (CONTENT_W - 0.4) / 2;
  const leftCard = s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: leftX, y: CONTENT_Y + 1.0, w: colW, h: 2.8, fill: { color: C.white }, line: { color: "FECACA", width: 2 } });
  leftCard.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0, y: 0, w: colW, h: 0.5, fill: { color: "FEF2F2" }, line: { type: "none" } }).addText("传统物理试错", { x: 0.2, y: 0, w: colW - 0.4, h: 0.5, fontSize: 14, bold: true, color: C.red, valign: "middle" });
  const leftItems = ["开模打样 3–5 轮", "项目周期 4–8 周", "均匀度 ≈50%", "模具费累计 10 万+", "热点暗斑频发", "侧壁漏光装配后才发现"];
  leftItems.forEach((t, i) => {
    leftCard.addText("✗ " + t, { x: 0.3, y: 0.6 + i * 0.32, w: colW - 0.5, h: 0.28, fontSize: 11, color: C.red });
  });

  // Right: light-guide-validator
  const rightX = leftX + colW + 0.4;
  const rightCard = s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: rightX, y: CONTENT_Y + 1.0, w: colW, h: 2.8, fill: { color: C.white }, line: { color: C.secondary, width: 2 } });
  rightCard.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0, y: 0, w: colW, h: 0.5, fill: { color: C.light }, line: { type: "none" } }).addText("light-guide-validator 数字仿真", { x: 0.2, y: 0, w: colW - 0.4, h: 0.5, fontSize: 14, bold: true, color: C.secondary, valign: "middle" });
  const rightItems = ["开模打样 1 轮", "项目周期 1–2 周", "均匀度 ≥85%", "模具费降 60%+", "热点在设计阶段消除", "漏光在仿真阶段定位"];
  rightItems.forEach((t, i) => {
    rightCard.addText("✓ " + t, { x: 0.3, y: 0.6 + i * 0.32, w: colW - 0.5, h: 0.28, fontSize: 11, color: C.green, bold: true });
  });

  // Bottom insight
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: CONTENT_X, y: SLIDE_H - 0.55, w: CONTENT_W, h: 0.4, fill: { color: C.accent }, line: { type: "none" } })
    .addText("同样一颗导光柱，仿真前后出光效果与开发成本形成数量级差异", { x: 0.3, y: 0, w: CONTENT_W - 0.6, h: 0.4, fontSize: 11, color: C.white, italic: true, valign: "middle" });
  s.render();
}

// ============================================================
// SLIDE 8: 应用价值
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  sectionBadge(s, "06", "应用价值");
  s.addText("仿真落地后直接解决研华工程师四类工程痛点", { x: CONTENT_X, y: CONTENT_Y + 0.5, w: CONTENT_W, h: 0.35, fontSize: 13, color: C.muted });

  const vals = [
    { pain: "出光面热点 / 暗斑", method: "2D 照度热图 + 棱镜参数扫描", result: "均匀度提升至 85% 以上", color: C.red },
    { pain: "侧壁漏光 / 壳体透光", method: "逐光线路径追踪 + 漏光定量", result: "漏光量下降 90%，免二次遮光", color: C.amber },
    { pain: "开模费用高 / 反复修模", method: "数字样机替代物理样机", result: "模具费用下降 60% 以上", color: C.accent },
    { pain: "项目周期长 / 响应慢", method: "参数化自动批量寻优", result: "开发周期从 4–8 周压缩到 1–2 周", color: C.secondary },
  ];

  const tblRows = [
    [
      { text: "传统痛点", options: { bold: true, color: C.white, fill: { color: C.accent }, fontSize: 10, align: "center" } },
      { text: "仿真手段", options: { bold: true, color: C.white, fill: { color: C.accent }, fontSize: 10, align: "center" } },
      { text: "解决效果", options: { bold: true, color: C.white, fill: { color: C.accent }, fontSize: 10, align: "center" } },
    ],
    ...vals.map(v => [
      { text: v.pain, options: { fontSize: 10.5, color: v.color, bold: true } },
      { text: v.method, options: { fontSize: 10, color: C.text } },
      { text: v.result, options: { fontSize: 10.5, color: C.green, bold: true } },
    ]),
  ];

  s.addTable(tblRows, {
    x: CONTENT_X, y: CONTENT_Y + 1.0, w: CONTENT_W,
    colW: [2.6, 3.0, 3.2],
    rowH: [0.35, 0.5, 0.5, 0.5, 0.5],
    fill: { color: C.white },
    border: { type: "solid", color: C.light, pt: 1 },
    valign: "middle",
    align: "left",
  });

  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: CONTENT_X, y: SLIDE_H - 0.65, w: CONTENT_W, h: 0.5, fill: { color: C.light }, line: { type: "none" } })
    .addText("额外收益：设计方案可沉淀为参数化模板，同类新品导光柱开发直接复用，光学 Know-how 从老师傅经验转为可复用数字资产", { x: 0.2, y: 0, w: CONTENT_W - 0.4, h: 0.5, fontSize: 10, color: C.accent, italic: true, valign: "middle" });
  s.render();
}

// ============================================================
// SLIDE 9: 技术优势
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  sectionBadge(s, "07", "技术优势");
  s.addText("light-guide-validator vs SPEOS / TracePro — 差异化竞争力", { x: CONTENT_X, y: CONTENT_Y + 0.5, w: CONTENT_W, h: 0.35, fontSize: 13, color: C.muted });

  const tblRows = [
    [
      { text: "对比维度", options: { bold: true, color: C.white, fill: { color: C.primary }, fontSize: 10, align: "center" } },
      { text: "SPEOS / TracePro", options: { bold: true, color: C.white, fill: { color: C.primary }, fontSize: 10, align: "center" } },
      { text: "light-guide-validator", options: { bold: true, color: C.white, fill: { color: C.secondary }, fontSize: 10, align: "center" } },
    ],
    ["授权成本", "数万至数十万元/年/座", "零成本，浏览器免安装"],
    ["迭代速度", "参数修改→重跑→分钟级", "参数调整→实时 3D 预览→秒级"],
    ["多灯珠支持", "手动逐颗配置位置与方向", "选取入射面自动放置，按平面聚类"],
    ["实测对比", "需导出数据二次处理", "CSV 导入同表对比，闭环验证"],
    ["报告输出", "需截图+手工排版", "一键生成自包含 HTML 报告"],
    ["使用门槛", "需光学专业培训", "参数帮助提示+使用说明，初次使用者可上手"],
  ];

  s.addTable(tblRows, {
    x: CONTENT_X, y: CONTENT_Y + 0.95, w: CONTENT_W,
    colW: [1.8, 3.3, 3.7],
    rowH: [0.35, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4],
    fill: { color: C.white },
    border: { type: "solid", color: C.light, pt: 1 },
    valign: "middle",
    align: "left",
    fontSize: 10,
    color: C.text,
  });

  s.addText("定位：light-guide-validator 不替代 SPEOS 的精确物理场分析，而是作为前端快速验证工具 — 在开模前用秒级迭代锁定最优参数方案，再交由 SPEOS 做最终验证", {
    x: CONTENT_X, y: SLIDE_H - 0.55, w: CONTENT_W, h: 0.4, fontSize: 9.5, color: C.secondary, italic: true, fill: { color: C.light }
  });
  s.render();
}

// ============================================================
// SLIDE 10: 落地路径与展望
// ============================================================
{
  const s = pres.addSlide();
  s.background = { color: C.accent };
  s.addText("实施路径与展望", { x: CONTENT_X, y: CONTENT_Y, w: CONTENT_W, h: 0.5, fontSize: 24, bold: true, color: C.white, fontFace: "Georgia", charSpacing: 1.5 });
  s.addText("分三步落地，把光学仿真沉淀为团队核心能力", { x: CONTENT_X, y: CONTENT_Y + 0.5, w: CONTENT_W, h: 0.35, fontSize: 13, color: C.light, italic: true });

  const phases = [
    { phase: "近期", time: "1–2 月", title: "单项目试点验证", desc: "选 1 款现有 3C 导光柱产品，用 light-guide-validator 复现仿真，与实测结果对标，建立仿真精度基线", color: C.secondary },
    { phase: "中期", time: "3–6 月", title: "参数化模板库", desc: "沉淀直筒、L 型、环形三类导光柱参数化模板，配套棱镜角度 DOE 优化脚本，新项目直接调用", color: C.primary },
    { phase: "远期", time: "6–12 月", title: "自动优化闭环", desc: "打通 CAD 参数 → 仿真 → 结果读取 → 自动寻优全链路，输入外观尺寸即可自动输出最优棱镜方案", color: C.secondary },
  ];

  const cardW = (CONTENT_W - 0.6) / 3;
  phases.forEach((p, i) => {
    const x = CONTENT_X + i * (cardW + 0.3);
    const y = CONTENT_Y + 1.1;
    const card = s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cardW, h: 2.2, fill: { color: C.white }, line: { type: "none" } });
    card.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0, y: 0, w: cardW, h: 0.5, fill: { color: p.color }, line: { type: "none" } }).addText(p.phase + " · " + p.time, { x: 0.15, y: 0, w: cardW - 0.3, h: 0.5, fontSize: 12, bold: true, color: C.white, valign: "middle" });
    card.addText(p.title, { x: 0.2, y: 0.6, w: cardW - 0.4, h: 0.35, fontSize: 13, bold: true, color: C.accent });
    card.addText(p.desc, { x: 0.2, y: 1.0, w: cardW - 0.4, h: 1.1, fontSize: 10, color: C.text, lineSpacingMultiple: 1.4 });
  });

  // Expected ROI
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: CONTENT_X, y: SLIDE_H - 0.85, w: CONTENT_W, h: 0.55, fill: { color: C.primary }, line: { type: "none" } })
    .addText("预期收益：单次项目模具费用下降 60%+ · 光学开发周期从月级压缩到周级 · 出光均匀度良率提升至 95%+", { x: 0.2, y: 0, w: CONTENT_W - 0.4, h: 0.55, fontSize: 11, color: C.white, valign: "middle", bold: true });

  s.addText("light-guide-validator 导光柱光学仿真验证平台 · 2026.10", { x: CONTENT_X, y: SLIDE_H - 0.3, w: CONTENT_W, h: 0.25, fontSize: 9, color: C.light, align: "center" });
  s.render();
}

// ============================================================
// SAVE
// ============================================================
const outPath = "c:\\Users\\maorong.wu\\Downloads\\light-guide-validator-presentation.pptx";
pres.writeFile({ fileName: outPath }).then(() => {
  console.log("PPT saved to: " + outPath);
}).catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
