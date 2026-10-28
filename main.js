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
const panelEl = document.querySelector('main.ui');
const btnTogglePanel = document.getElementById('btn-toggle-panel');

// ---------- 状态 ----------
// tension：手掌张开度，0=握拳，1=全开；spread：绽放程度，0=花苞，1=全开
// 逐层 spread：下标 0=花心内层，1=内圈，2=中圈，3=外圈，各层独立缓动
let tensionSmooth = 0;
let targetSpread = 0;
let currentSpread = 0;
let layerCurrents = [0, 0, 0, 0];
let prevOverallSpread = 0;
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
    uSpread0: { value: 0 },
    uSpread1: { value: 0 },
    uSpread2: { value: 0 },
    uSpread3: { value: 0 },
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
    attribute float aLayer;
    uniform float uSpread0;
    uniform float uSpread1;
    uniform float uSpread2;
    uniform float uSpread3;
    uniform float uTime;
    uniform float uPixelRatio;
    uniform float uSway;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      // 逐层插值：每颗粒子按自己的层级取对应的 spread，花苞位置 -> 绽放位置
      // 全部在顶点着色器里做，保证性能；不是整朵花统一缩放。
      float layerSpread = uSpread0;
      if (aLayer > 0.5 && aLayer < 1.5) layerSpread = uSpread1;
      else if (aLayer >= 1.5 && aLayer < 2.5) layerSpread = uSpread2;
      else if (aLayer >= 2.5) layerSpread = uSpread3;
      vec3 pos = mix(aClosed, aOpen, layerSpread);
      // 绽放后带一点呼吸和摆动，握拳时几乎不动
      float flutter = sin(uTime * 2.0 + aSeed * 20.0) * 0.06 * layerSpread;
      pos.x += flutter + sin(uTime * 1.3 + aSeed * 13.0) * uSway;
      pos.y += cos(uTime * 1.7 + aSeed * 17.0) * 0.05 * layerSpread;
      vColor = aColor;
      // 每个粒子透明度略有不同，避免成千上万个点叠加时全变成一片白
      vAlpha = 0.55 + 0.45 * aSeed;
      vec4 mv = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mv;
      // 手机上单个点约 5~10 像素，花苞时再缩小 30%，才能看清单颗粒子。
      gl_PointSize = aSize * uPixelRatio * (18.0 / -mv.z) * (0.7 + 0.3 * layerSpread);
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

// ---------- 生成粒子花朵（2026-10-28 重瓣牡丹版） ----------
// 目标：饱满的重瓣牡丹 / 重瓣山茶花，不是空心粒子球，也不是薄壳。
// 结构：4 层，每层 12 片，共 48 片花瓣 + 花心。
//   第 0 层 花心内层：最短、最密、最卷曲，长度 1.05，紧紧包围中心
//   第 1 层 内圈：长度 1.75，朝向中心略弯，互相交叠成紧实内部
//   第 2 层 中圈：长度 2.45，明显变宽变长，圆润扇形/椭圆形
//   第 3 层 外圈：长度 3.05，最大最宽，向外舒展，边缘起伏卷曲
// 每层有独立的半径、角度偏移、深度、宽度、长度、弯曲、颜色，
// 相邻层角度错开、每片长度/宽度/倾角带随机扰动，避免排成机械圆环。
//
// 花瓣几何：每片是独立的三维弯曲曲面，不是薄壳。
//   沿瓣方向 u（0=根部，1=尖部），横向半宽 halfW(u) = W * sin(pi * u^1.10)^0.8，
//   根部收窄、中部最宽、尖部圆收；横向采样 v' = sign(v)*v^2，中心密、边缘稀。
//   曲面：中间隆起（sin(pi*u)*隆起）、横向二次杯状弯曲、每瓣倾角和起伏。
//   厚度：在曲面法向（近似 z 向）上加 [-thickness, +thickness] 的随机偏移，
//   让花瓣从侧面看也有体积，而不是一张薄网。
//   穹顶：整朵花是半球形穹顶，中心向前凸、外缘向后收，
//   每层的基础深度 + 尖部深度变化（内层尖部向前、外层尖部向后 droop）叠加而成。
//
// 花心饱满：不再是空心球。花心由三部分填满：
//   (a) 金色/暖白球形花心核；(b) 花蕊探出点；(c) 第 0 层短小卷曲花瓣紧密包围。
//   从花心向外到内圈、中圈、外圈是连续过渡，正面和斜侧面都不留黑色空洞。
//
// 颜色（层级区分，但不靠颜色代替几何）：
//   外层：玫红、桃粉、洋红、紫粉；中层：粉紫、蓝紫、樱花粉、淡紫；
//   内层：明亮粉色、奶油白、少量金色；花心内层：亮粉、奶油白、金色花蕊。
//   每片内部按 u 做根部->尖部渐变，边缘向奶油白提亮，中心线略亮。
const ROSE = [0.93, 0.20, 0.45];
const MAGENTA = [0.88, 0.18, 0.62];
const CHERRY = [1.00, 0.55, 0.70];
const PEACH = [1.00, 0.65, 0.55];
const VIOLET = [0.62, 0.35, 0.95];
const LILAC = [0.78, 0.62, 1.00];
const BLUEPURPLE = [0.45, 0.40, 0.95];
const ICEBLUE = [0.60, 0.85, 1.00];
const CREAM = [1.00, 0.97, 0.88];
const WARMWHITE = [1.00, 0.98, 0.92];

// 层定义：count、长度、宽度、基础深度、尖部深度变化、隆起、厚度、角度偏移
const PETAL_LAYERS = [
  {
    layer: 0, count: 12, length: 1.05, width: 0.55, z: 0.85, tipZ: 0.35, bulge: 0.22, thickness: 0.07, offset: 0.00,
    gradients: [
      [CREAM, CHERRY], [WARMWHITE, ROSE], [CREAM, PEACH], [GOLD, CHERRY],
      [CREAM, ROSE], [WARMWHITE, CHERRY], [CREAM, PEACH], [GOLD, ROSE],
      [CREAM, CHERRY], [WARMWHITE, PEACH], [CREAM, ROSE], [GOLD, CHERRY],
    ],
  },
  {
    layer: 1, count: 12, length: 1.75, width: 0.78, z: 0.55, tipZ: 0.22, bulge: 0.28, thickness: 0.09, offset: 0.26,
    gradients: [
      [CREAM, CHERRY], [PEACH, ROSE], [CREAM, MAGENTA], [WARMWHITE, CHERRY],
      [PEACH, ROSE], [CREAM, CHERRY], [WARMWHITE, MAGENTA], [PEACH, CHERRY],
      [CREAM, ROSE], [WARMWHITE, CHERRY], [PEACH, MAGENTA], [CREAM, CHERRY],
    ],
  },
  {
    layer: 2, count: 12, length: 2.45, width: 0.92, z: 0.15, tipZ: -0.08, bulge: 0.32, thickness: 0.11, offset: 0.52,
    gradients: [
      [LILAC, VIOLET], [CHERRY, BLUEPURPLE], [PEACH, VIOLET], [LILAC, CHERRY],
      [ICEBLUE, VIOLET], [CHERRY, LILAC], [LILAC, BLUEPURPLE], [PEACH, VIOLET],
      [CHERRY, VIOLET], [LILAC, CHERRY], [ICEBLUE, BLUEPURPLE], [PEACH, LILAC],
    ],
  },
  {
    layer: 3, count: 12, length: 3.05, width: 1.02, z: -0.35, tipZ: -0.48, bulge: 0.30, thickness: 0.13, offset: 0.13,
    gradients: [
      [PEACH, ROSE], [CHERRY, MAGENTA], [PEACH, MAGENTA], [CREAM, ROSE],
      [CHERRY, ROSE], [PEACH, MAGENTA], [CREAM, MAGENTA], [CHERRY, ROSE],
      [PEACH, ROSE], [CREAM, MAGENTA], [CHERRY, MAGENTA], [PEACH, ROSE],
    ],
  },
];
const PETALS = [];
for (const layer of PETAL_LAYERS) {
  for (let k = 0; k < layer.count; k++) {
    // 每片独立扰动：长度/宽度 ±12%，角度在步长内错开，避免机械圆环
    const step = (Math.PI * 2) / layer.count;
    PETALS.push({
      layer: layer.layer,
      length: layer.length * (0.85 + Math.random() * 0.30),
      width: layer.width * (0.85 + Math.random() * 0.30),
      // 每片独立亮度：相邻花瓣亮度差 0.85~1.07，靠亮度差也能分清分界
      brightness: 0.85 + Math.random() * 0.22,
      z: layer.z,
      tipZ: layer.tipZ,
      bulge: layer.bulge,
      thickness: layer.thickness,
      angle: layer.offset + k * step + (Math.random() - 0.5) * step * 0.55,
      tilt: (Math.random() - 0.5) * 0.34,
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
  const layers = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const r = Math.random();
    let cx, cy, cz, ox, oy, oz, col, size, seed, layerIndex;
    seed = Math.random();

    if (r < 0.14) {
      // ---- 花心核 + 花蕊：实心填满，不留空洞 ----
      layerIndex = 0;
      const isStamen = Math.random() < 0.38;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      // 球体内部均匀采样（半径开立方），不是只在球壳上
      const rr = isStamen
        ? 0.45 + Math.random() * 0.30
        : 0.50 * Math.cbrt(Math.random());
      ox = Math.sin(ph) * Math.cos(th) * rr;
      oy = Math.sin(ph) * Math.sin(th) * rr;
      oz = 0.55 + Math.cos(ph) * rr * 0.7;
      cx = ox * 0.70;
      cy = oy * 0.70;
      cz = 0.35;
      const t = Math.random();
      col = mixColor(GOLD, WARMWHITE, t);
      if (isStamen && Math.random() < 0.30) col = WARMWHITE;
      size = isStamen ? 0.7 + Math.random() * 0.5 : 0.9 + Math.random() * 0.6;
    } else {
      // ---- 花瓣：单片独立采样，边缘密集、内部稀疏 ----
      // 关键：这不是只调透明度，而是真正的采样概率/空间分布。
      //   边缘组（约 55%）：粒子沿单片花瓣的轮廓带采样——
      //     70% 沿两侧边缘：u 均匀，横向在轮廓内侧按指数分布向内散开，
      //       平均向内约 0.16 个单位，带宽很窄，所以单位面积密度很高；
      //     20% 沿尖部弧线：u 在 0.90~1.00，横向铺满尖部；
      //     10% 沿根部：u 在 0~0.10，与花心衔接；
      //     另有约 12% 的侧缘粒子允许向外散逸最多 0.07，形成轻盈感，但不破坏轮廓。
      //   内部组（约 45%）：u、横向都均匀采样在 0.08~0.92、-0.85~0.85 范围内，
      //     不再向中心线集中，所以内部单位面积密度明显低于边缘带，
      //     但仍有粒子填满整片，不会变成空心的轮廓线。
      // 边缘距离：sideDist = 到侧缘的横向距离，tipDist = 到尖部的纵向距离，
      //   baseDist = 到根部的纵向距离，edgeDist = 三者最小值（世界单位）。
      //   亮度和大小也随 edgeDist 变化：越靠近边缘越亮、稍大，内部较暗、较小，
      //   但这只是对采样密度的加强，不是代替采样密度。
      const petal = pickPetal();
      layerIndex = petal.layer;
      const isEdge = Math.random() < 0.55;
      let u, lateral, halfW, edgeDist;
      const halfWAt = (uu) => petal.width * Math.pow(Math.sin(Math.PI * Math.pow(uu, 1.10)), 0.8);
      if (isEdge) {
        const seg = Math.random();
        if (seg < 0.70) {
          u = 0.08 + Math.random() * 0.84;
          halfW = halfWAt(u);
          const side = Math.random() < 0.5 ? -1 : 1;
          if (Math.random() < 0.12) {
            lateral = side * (halfW + Math.random() * 0.07); // 少量向外散逸
            edgeDist = 0;
          } else {
            const inward = -Math.log(1 - Math.random() * 0.95) * 0.16;
            lateral = side * Math.max(0, halfW - inward);
            edgeDist = Math.min(inward, halfW);
          }
        } else if (seg < 0.90) {
          u = 0.90 + Math.random() * 0.10;
          halfW = halfWAt(u);
          const vv = Math.random() * 2 - 1;
          lateral = vv * halfW * (0.90 + Math.random() * 0.15);
          edgeDist = Math.min((1 - u) * petal.length, (1 - Math.abs(vv)) * halfW);
        } else {
          u = Math.random() * 0.10;
          halfW = halfWAt(u);
          const vv = Math.random() * 2 - 1;
          lateral = vv * halfW;
          edgeDist = Math.min(u * petal.length, (1 - Math.abs(vv)) * halfW);
        }
      } else {
        u = 0.08 + Math.random() * 0.84;
        halfW = halfWAt(u);
        const vv = (Math.random() * 2 - 1) * 0.85;
        lateral = vv * halfW;
        edgeDist = Math.min((1 - Math.abs(vv)) * halfW, u * petal.length, (1 - u) * petal.length);
      }
      // 下面 open/closed 都用同一组 (u, lateral)，边缘和内部粒子都附着在
      // 各自花瓣的局部坐标上，随花瓣折叠一起变形，不会脱离花瓣。
      const radial = u * petal.length;
      // 曲面：基础深度 + 尖部深度变化 + 中间隆起 + 横向杯状弯曲 + 起伏
      let localZ = petal.z
        + u * petal.tipZ
        + Math.sin(Math.PI * u) * petal.bulge
        + lateral * lateral * 0.22
        + Math.sin(u * 5.0 + petal.wobble) * 0.07;
      // 厚度：沿法向（近似 z 向）随机偏移，让花瓣有体积感
      localZ += (Math.random() * 2 - 1) * petal.thickness;
      const cosT = Math.cos(petal.tilt), sinT = Math.sin(petal.tilt);
      const lat2 = lateral * cosT - localZ * sinT * 0.35;
      const z2 = lateral * sinT * 0.35 + localZ;
      const cosA = Math.cos(petal.angle), sinA = Math.sin(petal.angle);
      ox = cosA * radial - sinA * lat2;
      oy = sinA * radial + cosA * lat2;
      oz = z2;

      // ---- 花苞：花瓣折叠收拢（逐层参数在着色器外由层级 spread 控制） ----
      // 折叠角随 u 增大：根部基本不动，尖部向前折；内层折得更紧、外层折得更开，
      // 这样花苞仍是圆润饱满的盘面，而不是竖线或整体缩放。
      const foldBase = 1.05 - petal.layer * 0.12; // 内层约 60 度，外层约 42 度
      const fold = u * foldBase;
      const cosF = Math.cos(fold), sinF = Math.sin(fold);
      const radialClosed = radial * cosF * 0.80 + 0.12;
      const lateralClosed = lat2 * (0.35 + 0.65 * cosF);
      const cxRaw = cosA * radialClosed - sinA * lateralClosed;
      const cyRaw = sinA * radialClosed + cosA * lateralClosed;
      cx = cxRaw * 0.88;
      cy = cyRaw * 1.10 + 0.05;
      cz = petal.z * 0.3 + radial * sinF * 0.45 + 0.25;

      const tt = u * u * (3 - 2 * u);
      col = mixColor(petal.inner, petal.outer, tt);
      // 亮度梯度：edgeDist 越小（越靠近轮廓）越亮；内部较暗、较小。
      // 这只是加强，不是代替采样密度——密度差已经由上面的边缘/内部分组决定。
      // edgeDist 0~0.35 个单位内从亮到暗平滑过渡，超过 0.35 按内部处理。
      const edgeBright = Math.max(0, 1 - edgeDist / 0.35);
      col = mixColor(col, CREAM, edgeBright * 0.28);
      col = mixColor(col, WARMWHITE, edgeBright * 0.10);
      // 每片独立亮度，让相邻花瓣即使颜色相近也能靠亮度分清
      col = [col[0] * petal.brightness, col[1] * petal.brightness, col[2] * petal.brightness];
      if (isEdge) {
        size = 1.10 + Math.random() * 0.50;
        seed = 0.85 + Math.random() * 0.15; // 边缘粒子在着色器里透明度更高
      } else {
        size = 0.80 + Math.random() * 0.35;
        seed = 0.30 + Math.random() * 0.40; // 内部粒子较细、较淡，但数量仍在
      }
      if (Math.random() < 0.05) {
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
    layers[i] = layerIndex;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(open, 3)); // 占位，真实位置在着色器里算
  geo.setAttribute('aClosed', new THREE.BufferAttribute(closed, 3));
  geo.setAttribute('aOpen', new THREE.BufferAttribute(open, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geo.setAttribute('aLayer', new THREE.BufferAttribute(layers, 1));
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
// ---------- 控制面板显示 / 隐藏 ----------
// 只改界面显示：不重置粒子、不关摄像头、不停手势、不改任何参数。
// 默认显示；按钮在面板之外、固定右下角，隐藏后也不会消失。
let panelVisible = true;
function setPanelVisible(visible) {
  panelVisible = visible;
  if (panelEl) panelEl.classList.toggle('panel-hidden', !visible);
  if (btnTogglePanel) {
    const icon = btnTogglePanel.querySelector('.panel-toggle-icon');
    if (icon) icon.textContent = visible ? '‹' : '☰';
    btnTogglePanel.setAttribute('aria-label', visible ? '隐藏控制面板' : '显示控制面板');
    btnTogglePanel.title = visible ? '隐藏控制面板' : '显示控制面板';
  }
}
if (btnTogglePanel) {
  btnTogglePanel.addEventListener('click', () => setPanelVisible(!panelVisible));
}
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
    // 演示：张开度在 0~1 之间缓慢正弦变化，花朵位置也轻轻画圈。
    // 上一轮演示周期太快（过渡约 5 秒），逐层顺序看不出来，这里放慢到约 14 秒一轮，
    // 让内层到外层的依次展开有时间被眼睛跟上。
    tensionSmooth = Math.sin(t * 0.45) * 0.5 + 0.5;
    targetSpread = tensionToSpread(tensionSmooth);
    flowerTarget.set(Math.sin(t * 0.5) * 0.8, Math.cos(t * 0.4) * 0.5, 0);
  }
  // 逐层绽放 / 收拢：整体进度 targetSpread 先映射到每层的窗口，
  // 再按方向给不同的缓动速率，避免所有花瓣同时缩放。
  // 窗口刻意拉开、重叠只留一小段（上一轮窗口重叠太多，实测看起来像整体同步）：
  //   花心内层 0.00~0.40，内圈 0.20~0.60，中圈 0.45~0.80，外圈 0.70~1.00
  // 张开时：花心先松开，内圈、中圈、外圈依次展开；
  // 握拳时 p 下降，同一窗口自然反向：外圈先合拢，花心最后保持紧凑。
  // 速率再按方向区分：张开时内层快、外层慢；收拢时外层快、内层慢，
  // 这样手势快速变化时顺序仍然成立，且每层都是平滑跟随、不跳变。
  const layerWindows = [[0.00, 0.40], [0.20, 0.60], [0.45, 0.80], [0.70, 1.00]];
  const opening = targetSpread >= prevOverallSpread;
  const rates = opening ? [0.20, 0.15, 0.10, 0.05] : [0.05, 0.10, 0.15, 0.20];
  for (let li = 0; li < 4; li++) {
    const [w0, w1] = layerWindows[li];
    const x = Math.min(1, Math.max(0, (targetSpread - w0) / (w1 - w0)));
    const layerTarget = x * x * (3 - 2 * x);
    layerCurrents[li] += (layerTarget - layerCurrents[li]) * rates[li];
  }
  prevOverallSpread = targetSpread;
  // 界面上的 spread 显示用四层平均，仍保留整体缓动的直观读数
  currentSpread = (layerCurrents[0] + layerCurrents[1] + layerCurrents[2] + layerCurrents[3]) / 4;
  // 花朵位置轻微跟随，同样做平滑，避免抖动
  flowerPos.lerp(flowerTarget, 0.08);
  flowerGroup.position.copy(flowerPos);
  flowerGroup.rotation.z = Math.sin(t * 0.3) * 0.05;
  // 轻微的持续摆动：让固定俯视也能偶尔看到侧面，穹顶和厚度才看得出来，
  // 幅度只有约 10 度，不会把花转歪。
  flowerGroup.rotation.y = flowerPos.x * 0.18 + Math.sin(t * 0.25) * 0.18;
  flowerGroup.rotation.x = -flowerPos.y * 0.12 + Math.cos(t * 0.20) * 0.12;
  const breathe = 1 + Math.sin(t * 1.2) * 0.02 + currentSpread * 0.05;
  flowerGroup.scale.setScalar(breathe * fitScale);
  sway *= 0.92;

  flowerMaterial.uniforms.uSpread0.value = layerCurrents[0];
  flowerMaterial.uniforms.uSpread1.value = layerCurrents[1];
  flowerMaterial.uniforms.uSpread2.value = layerCurrents[2];
  flowerMaterial.uniforms.uSpread3.value = layerCurrents[3];
  flowerMaterial.uniforms.uTime.value = t;
  flowerMaterial.uniforms.uSway.value = sway;

  tensionValueEl.textContent = tensionSmooth.toFixed(2);
  spreadValueEl.textContent = currentSpread.toFixed(2);
  tensionBarEl.style.width = (tensionSmooth * 100) + '%';
  spreadBarEl.style.width = (currentSpread * 100) + '%';
  flowerStateEl.textContent = flowerStateText(tensionSmooth);

  renderer.render(scene, camera);
});
