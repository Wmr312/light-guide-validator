﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿/**
 * RayTracer Worker 入口
 * 主线程发送：{ meshData:{positions,indices}, options:{...仿真参数, heatmapRes, axisBins, angleBinDeg, returnSegments} }
 * 返回：汇总 + ledger + agg(热图/轴向/角度) + elapsedMs (+segments 当 returnSegments)
 */
importScripts('raytracer.js?v=30');
// 注意：raytracer.js 顶层的 class RayTracer 在 worker 全局作用域形成词法绑定，
// 此处不能再用 var RayTracer 重复声明（会触发 SyntaxError: already been declared），
// 直接使用全局类名即可。

self.onmessage = function(e) {
  var msg = e.data || {};
  if (msg.type === 'ping') { self.postMessage({ type: 'pong' }); return; }
  if (!msg.meshData) { self.postMessage({ error: 'missing meshData' }); return; }

  var tracer;
  try {
    tracer = new RayTracer(msg.meshData, msg.options || {});
  } catch (err) {
    self.postMessage({ error: 'RayTracer init failed: ' + err.message + '\n' + err.stack });
    return;
  }

  var start = Date.now();
  var results;
  try {
    results = tracer.simulate(function(done, total) {
      self.postMessage({ type: 'progress', done: done, total: total });
    });
    var agg = tracer.aggregate(results, {
      heatmapRes: msg.options.heatmapRes,
      axisBins: msg.options.axisBins,
      angleBinDeg: msg.options.angleBinDeg
    });
  } catch (err) {
    self.postMessage({ error: 'simulate failed: ' + err.message + '\n' + err.stack });
    return;
  }

  var payload = {
    total: results.total, success: results.success, escaped: results.escaped,
    exhausted: results.exhausted, successRate: results.successRate,
    avgOutputIntensity: results.avgOutputIntensity, maxBounces: results.maxBounces,
    ledger: results.ledger, agg: agg, elapsedMs: Date.now() - start,
    visRays: results.visRays
  };
  // 引擎已按 visRays 配额限制轨迹采集（默认等间隔抽取 800 条），不再需要 6000 段静默丢弃上限
  if (msg.options.returnSegments) {
    payload.segments = results.segments;
  }
  // 光斑分析：回传出射命中点（含出射方向 dExit 与波长 lam），供主线程投影到虚拟探测屏
  if (msg.options.returnSpot) {
    payload.hits = results.outputHits;
  }
  self.postMessage(payload);
};
