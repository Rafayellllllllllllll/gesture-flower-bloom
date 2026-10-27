import * as THREE from 'three';

// ---------- 页面元素 ----------
const videoEl = document.getElementById('camera');
const sceneCanvas = document.getElementById('scene');
const skeletonCanvas = document.getElementById('skeleton');
const skeletonCtx = skeletonCanvas.getContext('2d');
const statusEl = document.getElementById('status');
const handStateEl = document.getElementById('hand-state');
const tensionValueEl = document.getElementById('tension-value');
const spreadValueEl = document.getElementById('spread-value');
const tensionBarEl = document.getElementById('tension-bar');
const spreadBarEl = document.getElementById('spread-bar');
const flowerStateEl = document.getElementById('flower-state');
const errorEl = document.getElementById('error');
const btnCamera = document.getElementById('btn-camera');
const btnDemo = document.getElementById('btn-demo');
const btnRetry = document.getElementById('btn-retry');
const optSkeleton = document.getElementById('opt-skeleton');
const optVideo = document.getElementById('opt-video');
const optMirror = document.getElementById('opt-mirror');
const optCount = document.getElementById('opt-count');
const optDim = document.getElementById('opt-dim');
const videoDimEl = document.getElementById('video-dim');

// ---------- 状态 ----------
// tension：手掌张开度，0=握拳，1=全开；spread：绽放程度，0=花苞，1=全开
let tensionSmooth = 0;
let targetSpread = 0;
let currentSpread = 0;
let demoMode = false;
let demoStart = 0;
let cameraOn = false;
let lastHandTime = 0;
let sending = false;
let hands = null;
let sway = 0;
let lastPalm = null;

const flowerTarget = new THREE.Vector3(0, 0, 0);
const flowerPos = new THREE.Vector3(0, 0, 0);

// ---------- Three.js 场景 ----------
const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 7);

const flowerGroup = new THREE.Group();
scene.add(flowerGroup);

const flowerMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uSpread: { value: 0 },
    uTime: { value: 0 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    uSway: { value: 0 },
  },
  vertexShader: `
    attribute vec3 aClosed;
    attribute vec3 aOpen;
    attribute vec3 aColor;
    attribute float aSize;
    attribute float aSeed;
    uniform float uSpread;
    uniform float uTime;
    uniform float uPixelRatio;
    uniform float uSway;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      // 核心插值：花苞位置 -> 绽放位置，全部在顶点着色器里做，保证性能
      vec3 pos = mix(aClosed, aOpen, uSpread);
      // 绽放后带一点呼吸和摆动，握拳时几乎不动
      float flutter = sin(uTime * 2.0 + aSeed * 20.0) * 0.06 * uSpread;
      pos.x += flutter + sin(uTime * 1.3 + aSeed * 13.0) * uSway;
      pos.y += cos(uTime * 1.7 + aSeed * 17.0) * 0.05 * uSpread;
      vColor = aColor;
      // 每个粒子透明度略有不同，避免成千上万个点叠加时全变成一片白
      vAlpha = 0.55 + 0.45 * aSeed;
      vec4 mv = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mv;
      // 修复前这里是 260.0 / 距离：手机上单个点能到 200~300 像素，
      // 12000 个点叠加后只能看到一个大白块。现在按 18.0 / 距离算，
      // 手机上单个点约 5~10 像素，花苞时再缩小 30%，才能看清单颗粒子。
      gl_PointSize = aSize * uPixelRatio * (18.0 / -mv.z) * (0.7 + 0.3 * uSpread);
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      // 圆形柔边 + 光晕：越靠近圆心越亮，但亮度上限压低，不再叠加成纯白
      float d = length(gl_PointCoord - vec2(0.5));
      float alpha = smoothstep(0.5, 0.10, d) * vAlpha * 0.9;
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(vColor * (0.55 + 0.45 * (1.0 - d * 2.0)), alpha);
    }
  `,
});

let flowerPoints = null;

// 颜色工具：线性插值
function mixColor(c1, c2, t) {
  return [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t];
}
const GOLD = [1.0, 0.82, 0.40];
const PINK = [1.0, 0.36, 0.56];
const PURPLE = [0.70, 0.53, 1.0];
const LIGHT = [1.0, 0.78, 0.87];

// ---------- 生成粒子花朵（2026-10-28 重做版） ----------
// 目标：第一眼就是一朵花，不是光柱、烟雾或喷泉。
// 做法：用参数化三维花瓣曲面，在曲面内部采样粒子，而不是只画几条线。
//
// 结构：3 层、共 12 片花瓣，呈放射状交错排列
//   后层 5 片：最长、最宽、位置最靠后（z 负），颜色偏蓝紫/冰蓝
//   中层 4 片：居中，颜色偏桃红/紫罗兰
//   前层 3 片：最短、最靠前（z 正）、杯状弯曲最大，颜色偏玫红/樱花粉/奶油白
// 每片花瓣是椭圆形/水滴形曲面：沿瓣方向 u（0=根部，1=尖部），
// 横向半宽 halfW(u) = W * sin(pi * u^1.15)^0.8，根部收窄、中部最宽、尖部圆收。
// 花瓣曲面还有杯状弯曲（z 随 u 拱起、横向二次弯曲）和每瓣独立的
// 小倾角、起伏，让花瓣不在同一平面，有真实的前后纵深。
//
// 花心：15% 的粒子。60% 构成金色球形花心，40% 是向外探出的花蕊点，
// 颜色在明亮金黄与暖白之间过渡，盛开时在花瓣前方、花苞时被包在里面。
//
// 颜色：每片花瓣有自己的“根部色 -> 尖部色”渐变，同一片内按 u 平滑过渡，
// 边缘再向奶油白提亮一点，形成柔和轮廓。配色覆盖玫红、樱花粉、桃红、
// 紫罗兰、淡紫、蓝紫、冰蓝、青色、奶油白和少量金色，不再只有粉+金。
//
// 密度：横向采样用带符号平方 v' = sign(v)*v^2，让粒子向花瓣中心线集中、
// 边缘逐渐稀疏；u 接近均匀采样，保证整片花瓣都被填满，不是只有边缘。
const ROSE = [0.93, 0.20, 0.45];
const CHERRY = [1.00, 0.55, 0.70];
const PEACH = [1.00, 0.65, 0.55];
const VIOLET = [0.62, 0.35, 0.95];
const LILAC = [0.78, 0.62, 1.00];
const BLUEPURPLE = [0.45, 0.40, 0.95];
const ICEBLUE = [0.60, 0.85, 1.00];
const CYAN = [0.40, 0.90, 0.90];
const CREAM = [1.00, 0.97, 0.88];
const WARMWHITE = [1.00, 0.98, 0.92];

// 每层：片数、长度、宽度、深度、杯状弯曲、每片的渐变（根部->尖部）
const PETAL_LAYERS = [
  {
    count: 5, length: 3.00, width: 0.98, z: -0.55, curl: 0.20, offset: 0,
    gradients: [
      [LILAC, BLUEPURPLE], [ICEBLUE, VIOLET], [LILAC, BLUEPURPLE],
      [CYAN, BLUEPURPLE], [ICEBLUE, VIOLET],
    ],
  },
  {
    count: 4, length: 2.65, width: 0.90, z: -0.10, curl: 0.35, offset: 0.78,
    gradients: [
      [PEACH, VIOLET], [CHERRY, ROSE], [LILAC, VIOLET], [PEACH, CHERRY],
    ],
  },
  {
    count: 3, length: 2.15, width: 0.82, z: 0.40, curl: 0.50, offset: 0.35,
    gradients: [
      [CREAM, ROSE], [CREAM, CHERRY], [PEACH, ROSE],
    ],
  },
];
// 展平成一片花瓣的清单，带每瓣的倾角（绕瓣长轴的小旋转）和起伏相位
const PETALS = [];
for (const layer of PETAL_LAYERS) {
  for (let k = 0; k < layer.count; k++) {
    PETALS.push({
      length: layer.length,
      width: layer.width,
      z: layer.z,
      curl: layer.curl,
      angle: layer.offset + (k / layer.count) * Math.PI * 2,
      tilt: (Math.random() - 0.5) * 0.30,
      wobble: Math.random() * Math.PI * 2,
      inner: layer.gradients[k % layer.gradients.length][0],
      outer: layer.gradients[k % layer.gradients.length][1],
      weight: layer.length * layer.width,
    });
  }
}
const PETAL_TOTAL_WEIGHT = PETALS.reduce((s, p) => s + p.weight, 0);
function pickPetal() {
  let r = Math.random() * PETAL_TOTAL_WEIGHT;
  for (const p of PETALS) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return PETALS[PETALS.length - 1];
}

function buildFlower(count) {
  if (flowerPoints) {
    flowerGroup.remove(flowerPoints);
    flowerPoints.geometry.dispose();
  }
  const closed = new Float32Array(count * 3);
  const open = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const r = Math.random();
    let cx, cy, cz, ox, oy, oz, col, size, seed;
    seed = Math.random();

    if (r < 0.15) {
      // ---- 花心 / 花蕊 ----
      const isStamen = Math.random() < 0.40;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const rr = isStamen
        ? 0.42 + Math.random() * 0.28
        : 0.42 * Math.cbrt(Math.random());
      ox = Math.sin(ph) * Math.cos(th) * rr;
      oy = Math.sin(ph) * Math.sin(th) * rr;
      oz = 0.35 + Math.cos(ph) * rr * 0.6;
      // 花苞时花心收得更小、藏得更靠后，让折叠的花瓣包住它
      cx = ox * 0.65;
      cy = oy * 0.65;
      cz = 0.15;
      const t = Math.random();
      col = mixColor(GOLD, WARMWHITE, t);
      if (isStamen && Math.random() < 0.25) col = WARMWHITE; // 花蕊尖端亮点
      size = isStamen ? 0.7 + Math.random() * 0.5 : 0.9 + Math.random() * 0.6;
    } else {
      // ---- 花瓣：在曲面内部采样 ----
      const petal = pickPetal();
      const u = Math.pow(Math.random(), 0.90); // 沿瓣方向，接近均匀，整片填满
      const vRaw = Math.random() * 2 - 1;
      const v = Math.sign(vRaw) * vRaw * vRaw; // 向中心线集中，边缘稀疏
      const halfW = petal.width * Math.pow(Math.sin(Math.PI * Math.pow(u, 1.15)), 0.8);
      const radial = u * petal.length;
      const lateral = v * halfW;
      // 杯状弯曲 + 起伏：花瓣不是平板，中间拱起、边缘带一点波浪
      let localZ = petal.z
        + Math.sin(Math.PI * u) * petal.curl
        + lateral * lateral * 0.28
        + Math.sin(u * 5.0 + petal.wobble) * 0.07;
      // 每瓣独立倾角：绕瓣长轴旋转一点，横向和深度互换一小部分
      const cosT = Math.cos(petal.tilt), sinT = Math.sin(petal.tilt);
      const lat2 = lateral * cosT - localZ * sinT * 0.4;
      const z2 = lateral * sinT * 0.4 + localZ;
      // 从瓣局部坐标转到整朵花的放射坐标
      const cosA = Math.cos(petal.angle), sinA = Math.sin(petal.angle);
      ox = cosA * radial - sinA * lat2;
      oy = sinA * radial + cosA * lat2;
      oz = z2;

      // ---- 花苞：花瓣“折叠”，不是整体缩放，也不是竖直光柱 ----
      // 折叠角随 u 增大：根部基本不动，尖部向前折约 66 度。
      // 这样尖部径向缩短、向前探出、横向收窄，花瓣由平面变成包拢的杯状，
      // 在正视图里仍是一个圆润的花苞盘面，而不是几条向下延伸的线。
      const fold = u * 1.15;
      const cosF = Math.cos(fold), sinF = Math.sin(fold);
      const radialClosed = radial * cosF * 0.85 + 0.10;
      const lateralClosed = lat2 * (0.30 + 0.70 * cosF);
      const cxRaw = cosA * radialClosed - sinA * lateralClosed;
      const cyRaw = sinA * radialClosed + cosA * lateralClosed;
      // 花苞盘面略呈竖椭圆，像一颗含苞的蓓蕾，而不是正圆盘
      cx = cxRaw * 0.85;
      cy = cyRaw * 1.12 + 0.05;
      cz = petal.z * 0.3 + radial * sinF * 0.50 + 0.20;

      // ---- 颜色：瓣内渐变 + 边缘提亮 ----
      const tt = u * u * (3 - 2 * u);
      col = mixColor(petal.inner, petal.outer, tt);
      // 越靠近边缘越向奶油白靠，轮廓柔和但不发虚
      const edge = Math.abs(v);
      col = mixColor(col, CREAM, edge * edge * 0.22);
      // 中心线略亮，像花瓣受光的脊
      col = mixColor(col, WARMWHITE, (1 - edge) * 0.08);
      size = 0.9 + Math.random() * 0.7;
      // 约 6% 是高光粒子：奶油白、稍大、更亮，点缀花瓣表面
      if (Math.random() < 0.06) {
        col = CREAM;
        size = 1.4 + Math.random() * 0.8;
        seed = 0.95 + Math.random() * 0.05;
      }
    }

    closed[i * 3] = cx; closed[i * 3 + 1] = cy; closed[i * 3 + 2] = cz;
    open[i * 3] = ox; open[i * 3 + 1] = oy; open[i * 3 + 2] = oz;
    colors[i * 3] = col[0]; colors[i * 3 + 1] = col[1]; colors[i * 3 + 2] = col[2];
    sizes[i] = size;
    seeds[i] = seed;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(open, 3)); // 占位，真实位置在着色器里算
  geo.setAttribute('aClosed', new THREE.BufferAttribute(closed, 3));
  geo.setAttribute('aOpen', new THREE.BufferAttribute(open, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  flowerPoints = new THREE.Points(geo, flowerMaterial);
  flowerPoints.frustumCulled = false;
  flowerGroup.add(flowerPoints);
}


// ---------- 张开度 tension ----------
// 手腕 0；指尖 8、12、16、20；指根关节 5、9、13、17
function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function computeTension(landmarks) {
  const wrist = landmarks[0];
  const tips = [8, 12, 16, 20].map((k) => landmarks[k]);
  const mcps = [5, 9, 13, 17].map((k) => landmarks[k]);
  const dTip = tips.reduce((s, p) => s + dist(wrist, p), 0) / tips.length;
  const dMcp = mcps.reduce((s, p) => s + dist(wrist, p), 0) / mcps.length;
  if (!dMcp) return 0;
  const ratio = dTip / dMcp;
  // 标定：握拳 ratio 约 1.25，张开约 1.95，线性归一化到 0~1
  const raw = Math.min(1, Math.max(0, (ratio - 1.25) / (1.95 - 1.25)));
  return raw;
}
// tension -> spread：小于 0.32 花苞，大于 0.66 全开，中间 smoothstep 平滑
function tensionToSpread(t) {
  const x = Math.min(1, Math.max(0, (t - 0.32) / (0.66 - 0.32)));
  return x * x * (3 - 2 * x);
}
function flowerStateText(t) {
  if (t < 0.32) return '现在是：花苞（聚合中）';
  if (t > 0.66) return '现在是：绽放（扩散中）';
  return '现在是：过渡（正在打开）';
}

// ---------- 手部骨架 ----------
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
function drawSkeleton(landmarks) {
  skeletonCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
  if (!optSkeleton.checked || !landmarks) return;
  const w = skeletonCanvas.width, h = skeletonCanvas.height;
  const px = (p) => {
    const x = optMirror.checked ? (1 - p.x) : p.x;
    return [x * w, p.y * h];
  };
  skeletonCtx.lineWidth = 2;
  skeletonCtx.strokeStyle = 'rgba(255, 209, 102, 0.9)';
  skeletonCtx.fillStyle = '#ff5d8f';
  for (const [a, b] of HAND_CONNECTIONS) {
    const [x1, y1] = px(landmarks[a]);
    const [x2, y2] = px(landmarks[b]);
    skeletonCtx.beginPath(); skeletonCtx.moveTo(x1, y1); skeletonCtx.lineTo(x2, y2); skeletonCtx.stroke();
  }
  for (const p of landmarks) {
    const [x, y] = px(p);
    skeletonCtx.beginPath(); skeletonCtx.arc(x, y, 4, 0, Math.PI * 2); skeletonCtx.fill();
  }
}

// ---------- 识别回调 ----------
function onHandResults(results) {
  const list = results && results.multiHandLandmarks;
  if (list && list.length > 0) {
    const lm = list[0];
    lastHandTime = performance.now();
    handStateEl.textContent = '已检测到手';
    handStateEl.className = 'pill ok';
    // 手掌跟随：用中指指根（9）作手掌中心，映射到画面，幅度打 6~7 折，只做轻微跟随
    const palm = lm[9];
    const nx = optMirror.checked ? (1 - palm.x * 2) : (palm.x * 2 - 1);
    const ny = 1 - palm.y * 2;
    if (lastPalm) {
      const speed = Math.hypot(palm.x - lastPalm.x, palm.y - lastPalm.y);
      sway = Math.min(0.25, speed * 4);
    }
    lastPalm = { x: palm.x, y: palm.y };
    flowerTarget.set(nx * 1.1, ny * 0.8, 0);
    if (!demoMode) {
      const raw = computeTension(lm);
      tensionSmooth += (raw - tensionSmooth) * 0.25;
      targetSpread = tensionToSpread(tensionSmooth);
    }
    drawSkeleton(lm);
  } else {
    if (performance.now() - lastHandTime > 1200) {
      handStateEl.textContent = '未检测到手';
      handStateEl.className = 'pill soft';
      skeletonCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
      if (!demoMode) targetSpread = 0; // 长时间没手，花朵慢慢回落成花苞
    }
  }
}

// ---------- 摄像头 ----------
function showError(msg) {
  errorEl.hidden = false;
  errorEl.textContent = msg;
  btnRetry.hidden = false;
}
function hideError() {
  errorEl.hidden = true;
  btnRetry.hidden = true;
}
function cameraErrorMessage(e) {
  const name = (e && e.name) || '';
  if (name === 'NotAllowedError') return '摄像头权限被拒绝了：请在浏览器地址栏旁边点开权限设置，允许使用摄像头，然后点“重新尝试”。注意：摄像头需要在 https 或 localhost 下才能用，直接双击打开文件是不行的。';
  if (name === 'NotFoundError') return '没有找到摄像头：请确认设备有摄像头且没有被其他应用独占，再点“重新尝试”。';
  if (name === 'NotReadableError') return '摄像头被其他应用占用了：请先关闭正在用摄像头的应用（比如视频会议），再点“重新尝试”。';
  if (name === 'SecurityError') return '当前页面不安全，浏览器不允许调用摄像头：请用本地 HTTP 服务打开（比如 python -m http.server），或用 https 访问。';
  if (name === 'OverconstrainedError') return '摄像头不支持请求的清晰度，已尝试降低要求，请再点一次“重新尝试”。';
  return '摄像头启动失败：' + (e && e.message ? e.message : '未知错误') + '。也可以先用“演示模式”看花开花合的效果。';
}

async function startCamera() {
  hideError();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError('这个浏览器不支持调用摄像头：请用较新的 Chrome、Edge 或 Safari 打开，并用本地 HTTP 服务访问。');
    return;
  }
  if (typeof window.Hands === 'undefined') {
    showError('手部识别库没有加载成功（可能是网络问题）：请检查网络后刷新页面，或先用“演示模式”看效果。');
    return;
  }
  statusEl.textContent = '正在请求摄像头权限…';
  statusEl.className = 'pill warn';
  try {
    if (!hands) {
      hands = new window.Hands({
        locateFile: (file) => 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + file,
      });
      hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      hands.onResults(onHandResults);
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    cameraOn = true;
    statusEl.textContent = '摄像头已开启，正在识别手部…';
    statusEl.className = 'pill ok';
    btnCamera.textContent = '摄像头已开启';
    // 自己驱动识别循环：视频有新帧就送一帧，送完再送下一帧
    const loop = async () => {
      if (!cameraOn) return;
      if (!sending && videoEl.readyState >= 2) {
        sending = true;
        try { await hands.send({ image: videoEl }); } catch (_) { /* 单帧失败不中断 */ }
        sending = false;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } catch (e) {
    statusEl.textContent = '摄像头未开启';
    statusEl.className = 'pill warn';
    showError(cameraErrorMessage(e));
  }
}

// ---------- 演示模式 ----------
function setDemo(on) {
  demoMode = on;
  btnDemo.classList.toggle('active', on);
  btnDemo.textContent = on ? '退出演示模式' : '演示模式';
  if (on) {
    demoStart = performance.now();
    statusEl.textContent = '演示模式：用正弦曲线模拟张开度';
    statusEl.className = 'pill';
    handStateEl.textContent = '演示中（无真实手部）';
    handStateEl.className = 'pill soft';
    skeletonCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
  } else if (cameraOn) {
    statusEl.textContent = '摄像头已开启，正在识别手部…';
    statusEl.className = 'pill ok';
  } else {
    statusEl.textContent = '等待开启摄像头…';
    statusEl.className = 'pill';
  }
}

// ---------- 界面事件 ----------
btnCamera.addEventListener('click', startCamera);
btnRetry.addEventListener('click', startCamera);
btnDemo.addEventListener('click', () => setDemo(!demoMode));
optSkeleton.addEventListener('change', () => {
  if (!optSkeleton.checked) skeletonCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
});
optVideo.addEventListener('change', () => {
  videoEl.classList.toggle('video-off', !optVideo.checked);
  videoDimEl.style.display = optVideo.checked ? '' : 'none';
});
optMirror.addEventListener('change', () => {
  videoEl.classList.toggle('no-mirror', !optMirror.checked);
});
optCount.addEventListener('change', () => buildFlower(parseInt(optCount.value, 10)));
optDim.addEventListener('input', () => {
  videoDimEl.style.background = 'rgba(5, 3, 10, ' + (optDim.value / 100) + ')';
});

// ---------- 尺寸 ----------
// 竖屏下花朵直径（约 6 个单位）会超出画面宽度，只剩中间一竖条，
// 看起来就像几束光柱。所以按可视宽高算一个整体缩放，保证整朵花都在画面内。
let fitScale = 1;
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  skeletonCanvas.width = w;
  skeletonCanvas.height = h;
  flowerMaterial.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2);
  const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(25)) * 7;
  const visibleWidth = visibleHeight * camera.aspect;
  fitScale = Math.max(0.35, Math.min(1, visibleWidth * 0.90 / 6.0, visibleHeight * 0.80 / 6.0));
}
window.addEventListener('resize', resize);

// ---------- 主循环 ----------
const clock = new THREE.Clock();
buildFlower(12000);
resize();

renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  if (demoMode) {
    // 演示：张开度在 0~1 之间缓慢正弦变化，花朵位置也轻轻画圈
    tensionSmooth = Math.sin(t * 0.6) * 0.5 + 0.5;
    targetSpread = tensionToSpread(tensionSmooth);
    flowerTarget.set(Math.sin(t * 0.5) * 0.8, Math.cos(t * 0.4) * 0.5, 0);
  }
  // 需求里的缓动公式：每帧向目标靠近 10%
  currentSpread += (targetSpread - currentSpread) * 0.1;
  // 花朵位置轻微跟随，同样做平滑，避免抖动
  flowerPos.lerp(flowerTarget, 0.08);
  flowerGroup.position.copy(flowerPos);
  flowerGroup.rotation.z = Math.sin(t * 0.3) * 0.05;
  flowerGroup.rotation.y = flowerPos.x * 0.18;
  flowerGroup.rotation.x = -flowerPos.y * 0.12;
  const breathe = 1 + Math.sin(t * 1.2) * 0.02 + currentSpread * 0.05;
  flowerGroup.scale.setScalar(breathe * fitScale);
  sway *= 0.92;

  flowerMaterial.uniforms.uSpread.value = currentSpread;
  flowerMaterial.uniforms.uTime.value = t;
  flowerMaterial.uniforms.uSway.value = sway;

  tensionValueEl.textContent = tensionSmooth.toFixed(2);
  spreadValueEl.textContent = currentSpread.toFixed(2);
  tensionBarEl.style.width = (tensionSmooth * 100) + '%';
  spreadBarEl.style.width = (currentSpread * 100) + '%';
  flowerStateEl.textContent = flowerStateText(tensionSmooth);

  renderer.render(scene, camera);
});
