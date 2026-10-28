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
const optWidth = document.getElementById('opt-width');
const optEdge = document.getElementById('opt-edge');
const optWidthValue = document.getElementById('opt-width-value');
const optEdgeValue = document.getElementById('opt-edge-value');
const optLockFull = document.getElementById('opt-lock-full');
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
// 调试滑块：花瓣宽度系数（默认 1.0）、边缘粒子占比（默认 0.65），改动时重建花朵
let petalWidthCoeff = 1.0;
let edgeRatio = 0.65;
// 调试开关：固定全开，勾选后 spread 锁 1，不改手势、演示、摄像头本身
let lockFull = false;
let demoMode = false;
let demoStart = 0;
let cameraOn = false;
let lastHandTime = 0;
let sending = false;
let hands = null;
// 摄像头恢复用：当前流、识别循环是否已在跑，避免重复点“开启摄像头”产生两个流、两个循环互相抢。
let currentStream = null;
let cameraLoopStarted = false;
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
  blending: THREE.NormalBlending,
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
    attribute float aPetalPhase;
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
      // 每片花瓣整体摆动：同一瓣所有粒子用同一个 aPetalPhase，幅度 ≤0.03，
      // 不再用每个粒子独立的 aSeed 做偏移，花瓣形状不会被吹散。
      pos.x += sin(uTime * 1.5 + aPetalPhase) * 0.03 * layerSpread;
      pos.x += sin(uTime * 1.3 + aPetalPhase) * uSway;
      pos.y += cos(uTime * 1.2 + aPetalPhase) * 0.03 * layerSpread;
      vColor = aColor;
      // 透明度 0.75~0.95：aSeed 0~1 映射到 0.75~0.95
      vAlpha = 0.75 + 0.20 * aSeed;
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
      // 较硬的圆点，不再做光晕式柔边；NormalBlending 下不再叠加成纯白
      float d = length(gl_PointCoord - vec2(0.5));
      float alpha = smoothstep(0.5, 0.35, d) * vAlpha;
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(vColor * 0.95, alpha);
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

// ---------- 生成粒子花朵（2026-10-28 边界清晰版） ----------
// 只按最新 10 点规格改：NormalBlending 在材质里改；这里只负责几何与采样。
// 结构：4 层，每层 12/12/14/16 片，共 54 片 + 花心。
//   第 0 层 花心内层：长度 1.05，z 0.85（最靠前）
//   第 1 层 内圈：长度 1.75，z 0.55，层间 z 差 0.30
//   第 2 层 中圈：长度 2.45，z 0.15，层间 z 差 0.40
//   第 3 层 外圈：长度 3.05，z -0.35，层间 z 差 0.50，根部 30% 暗化 0.55
// 层间角度：相邻层偏移固定为半个步长，内层花瓣落在外层两片的缝里。
//   偏移：0 层 0，1 层 0.2618（12 片半步），2 层 0.4862，3 层 0.6825。
// 花瓣宽度：halfW ≤ 0.32 * 2π * r / count，其中 r = u * length，
//   即全宽 ≤ 该处弧长间隔的约 65%，相邻花瓣始终留缝。
// 角度扰动只 ±5% 步长，长度/宽度随机只 ±6%。
// 奇偶颜色对比：偶数瓣亮度 1.10，奇数瓣 0.90（差约 22%），再加 ±2% 微扰。
// 粒子分配：默认 40000，花心 8%，其余按花瓣面积分配，每片不少于 600（40000 时）。
//   分配方法：先给每片 600 保底，剩余按面积（长度 × 中部 capped 宽度）加权分配；
//   总数不足 54×600 时按面积比例分配。
// 采样：边缘 65%（调试滑块可调，默认 0.65），叶脉 6%，其余内部。
//   边缘：沿轮廓带采样，向内指数分布平均 0.08，不向外散逸；
//   内部：均匀采样，亮度 ×0.75；边缘：亮度 ×1.25、尺寸 ×1.15。
//   叶脉：沿中心线 lateral=0，u 0.10~0.95，颜色提亮 30%。
// 尺寸：基础 aSize 整体 ×0.65。
// 每瓣整体相位：aPetalPhase 同瓣一致，着色器里用它做整体摆动，幅度 ≤0.03。
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

const PETAL_LAYERS = [
  {
    layer: 0, count: 12, length: 1.05, width: 0.55, z: 0.85, tipZ: 0.35, bulge: 0.22, thickness: 0.07, offset: 0.0000,
    gradients: [
      [CREAM, CHERRY], [WARMWHITE, ROSE], [CREAM, PEACH], [GOLD, CHERRY],
      [CREAM, ROSE], [WARMWHITE, CHERRY], [CREAM, PEACH], [GOLD, ROSE],
      [CREAM, CHERRY], [WARMWHITE, PEACH], [CREAM, ROSE], [GOLD, CHERRY],
    ],
  },
  {
    layer: 1, count: 12, length: 1.75, width: 0.78, z: 0.55, tipZ: 0.22, bulge: 0.28, thickness: 0.09, offset: 0.2618,
    gradients: [
      [CREAM, CHERRY], [PEACH, ROSE], [CREAM, MAGENTA], [WARMWHITE, CHERRY],
      [PEACH, ROSE], [CREAM, CHERRY], [WARMWHITE, MAGENTA], [PEACH, CHERRY],
      [CREAM, ROSE], [WARMWHITE, CHERRY], [PEACH, MAGENTA], [CREAM, CHERRY],
    ],
  },
  {
    layer: 2, count: 14, length: 2.45, width: 0.92, z: 0.15, tipZ: -0.08, bulge: 0.32, thickness: 0.11, offset: 0.4862,
    gradients: [
      [LILAC, VIOLET], [CHERRY, BLUEPURPLE], [PEACH, VIOLET], [LILAC, CHERRY],
      [ICEBLUE, VIOLET], [CHERRY, LILAC], [LILAC, BLUEPURPLE], [PEACH, VIOLET],
      [CHERRY, VIOLET], [LILAC, CHERRY], [ICEBLUE, BLUEPURPLE], [PEACH, LILAC],
      [LILAC, VIOLET], [CHERRY, BLUEPURPLE],
    ],
  },
  {
    layer: 3, count: 16, length: 3.05, width: 1.02, z: -0.35, tipZ: -0.48, bulge: 0.30, thickness: 0.13, offset: 0.6825,
    gradients: [
      [PEACH, ROSE], [CHERRY, MAGENTA], [PEACH, MAGENTA], [CREAM, ROSE],
      [CHERRY, ROSE], [PEACH, MAGENTA], [CREAM, MAGENTA], [CHERRY, ROSE],
      [PEACH, ROSE], [CREAM, MAGENTA], [CHERRY, MAGENTA], [PEACH, ROSE],
      [PEACH, MAGENTA], [CHERRY, ROSE], [CREAM, MAGENTA], [PEACH, ROSE],
    ],
  },
];
const PETALS = [];
for (const layer of PETAL_LAYERS) {
  for (let k = 0; k < layer.count; k++) {
    const step = (Math.PI * 2) / layer.count;
    const midR = 0.53 * layer.length;
    const capMid = 0.32 * 2 * Math.PI * midR / layer.count;
    PETALS.push({
      layer: layer.layer,
      count: layer.count,
      // 长度/宽度随机只 ±6%
      length: layer.length * (0.94 + Math.random() * 0.12),
      width: layer.width * (0.94 + Math.random() * 0.12),
      // 奇偶对比：偶数 1.10，奇数 0.90，差约 22%，再加 ±2% 微扰
      brightness: (k % 2 === 0 ? 1.10 : 0.90) * (0.98 + Math.random() * 0.04),
      phase: Math.random() * Math.PI * 2,
      z: layer.z,
      tipZ: layer.tipZ,
      bulge: layer.bulge,
      thickness: layer.thickness,
      // 角度扰动只 ±5% 步长
      angle: layer.offset + k * step + (Math.random() - 0.5) * step * 0.10,
      tilt: (Math.random() - 0.5) * 0.34,
      wobble: Math.random() * Math.PI * 2,
      inner: layer.gradients[k % layer.gradients.length][0],
      outer: layer.gradients[k % layer.gradients.length][1],
      // 面积权重：用 capped 后的中部宽度估算，分配粒子时用
      weight: layer.length * capMid,
    });
  }
}
const PETAL_TOTAL_WEIGHT = PETALS.reduce((s, p) => s + p.weight, 0);

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
  const phases = new Float32Array(count);
  let idx = 0;

  function writeParticle(cx, cy, cz, ox, oy, oz, col, size, seed, layerIndex, phase) {
    closed[idx * 3] = cx; closed[idx * 3 + 1] = cy; closed[idx * 3 + 2] = cz;
    open[idx * 3] = ox; open[idx * 3 + 1] = oy; open[idx * 3 + 2] = oz;
    colors[idx * 3] = col[0]; colors[idx * 3 + 1] = col[1]; colors[idx * 3 + 2] = col[2];
    sizes[idx] = size; seeds[idx] = seed; layers[idx] = layerIndex; phases[idx] = phase;
    idx++;
  }

  // ---- 花心：8% ----
  const centerCount = Math.round(count * 0.08);
  for (let i = 0; i < centerCount && idx < count; i++) {
    const isStamen = Math.random() < 0.38;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    const rr = isStamen ? 0.45 + Math.random() * 0.30 : 0.50 * Math.cbrt(Math.random());
    const ox = Math.sin(ph) * Math.cos(th) * rr;
    const oy = Math.sin(ph) * Math.sin(th) * rr;
    const oz = 0.55 + Math.cos(ph) * rr * 0.7;
    let col = mixColor(GOLD, WARMWHITE, Math.random());
    if (isStamen && Math.random() < 0.30) col = WARMWHITE;
    const size = (isStamen ? 0.7 + Math.random() * 0.5 : 0.9 + Math.random() * 0.6) * 0.65;
    writeParticle(ox * 0.70, oy * 0.70, 0.35, ox, oy, oz, col, size, Math.random(), 0, 0);
  }

  // ---- 花瓣粒子数分配：每片不少于 600（总数够时） ----
  const petalTotal = count - centerCount;
  const petalCounts = new Array(PETALS.length).fill(0);
  if (petalTotal >= PETALS.length * 600) {
    let remaining = petalTotal - PETALS.length * 600;
    for (let p = 0; p < PETALS.length; p++) petalCounts[p] = 600;
    // 剩余按面积加权分配，用最大余数法保证总数精确
    const raw = PETALS.map((p) => remaining * p.weight / PETAL_TOTAL_WEIGHT);
    let assigned = 0;
    for (let p = 0; p < PETALS.length; p++) {
      const f = Math.floor(raw[p]);
      petalCounts[p] += f; assigned += f;
    }
    let left = remaining - assigned;
    const order = PETALS.map((p, i) => [raw[i] - Math.floor(raw[i]), i]).sort((a, b) => b[0] - a[0]);
    for (let j = 0; j < left && j < order.length; j++) petalCounts[order[j][1]]++;
  } else {
    const raw = PETALS.map((p) => petalTotal * p.weight / PETAL_TOTAL_WEIGHT);
    let assigned = 0;
    for (let p = 0; p < PETALS.length; p++) {
      const f = Math.floor(raw[p]);
      petalCounts[p] = f; assigned += f;
    }
    let left = petalTotal - assigned;
    const order = PETALS.map((p, i) => [raw[i] - Math.floor(raw[i]), i]).sort((a, b) => b[0] - a[0]);
    for (let j = 0; j < left && j < order.length; j++) petalCounts[order[j][1]]++;
  }

  // ---- 每片独立生成 ----
  for (let pi = 0; pi < PETALS.length; pi++) {
    const petal = PETALS[pi];
    const n = petalCounts[pi];
    // 宽度函数：先按原始轮廓算，再按角间隔 cap，最后乘调试宽度系数
    const halfWAt = (uu) => {
      const rawW = petal.width * Math.pow(Math.sin(Math.PI * Math.pow(uu, 1.10)), 0.8);
      const cap = 0.32 * 2 * Math.PI * (uu * petal.length) / petal.count;
      return Math.min(rawW, cap) * petalWidthCoeff;
    };
    for (let j = 0; j < n && idx < count; j++) {
      // 类型：边缘 edgeRatio（默认 0.65），叶脉 6%，其余内部
      const typeRoll = Math.random();
      const isVein = typeRoll < 0.06;
      const isEdge = !isVein && typeRoll < 0.06 + edgeRatio;
      let u, lateral, halfW, edgeDist = 1;
      if (isVein) {
        // 叶脉：沿中心线，u 0.10~0.95，横向几乎为 0
        u = 0.10 + Math.random() * 0.85;
        halfW = halfWAt(u);
        lateral = (Math.random() * 2 - 1) * 0.02 * halfW;
        edgeDist = 0.5;
      } else if (isEdge) {
        const seg = Math.random();
        if (seg < 0.70) {
          u = 0.08 + Math.random() * 0.84;
          halfW = halfWAt(u);
          const side = Math.random() < 0.5 ? -1 : 1;
          // 向内指数分布，平均 0.08，不向外散逸
          const inward = -Math.log(1 - Math.random() * 0.95) * 0.08;
          lateral = side * Math.max(0, halfW - inward);
          edgeDist = Math.min(inward, halfW);
        } else if (seg < 0.90) {
          u = 0.90 + Math.random() * 0.10;
          halfW = halfWAt(u);
          const vv = Math.random() * 2 - 1;
          lateral = vv * halfW * (0.90 + Math.random() * 0.10);
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
      const radial = u * petal.length;
      let localZ = petal.z
        + u * petal.tipZ
        + Math.sin(Math.PI * u) * petal.bulge
        + lateral * lateral * 0.22
        + Math.sin(u * 5.0 + petal.wobble) * 0.07;
      localZ += (Math.random() * 2 - 1) * petal.thickness;
      const cosT = Math.cos(petal.tilt), sinT = Math.sin(petal.tilt);
      const lat2 = lateral * cosT - localZ * sinT * 0.35;
      const z2 = lateral * sinT * 0.35 + localZ;
      const cosA = Math.cos(petal.angle), sinA = Math.sin(petal.angle);
      const ox = cosA * radial - sinA * lat2;
      const oy = sinA * radial + cosA * lat2;
      const oz = z2;
      const foldBase = 1.05 - petal.layer * 0.12;
      const fold = u * foldBase;
      const cosF = Math.cos(fold), sinF = Math.sin(fold);
      const radialClosed = radial * cosF * 0.80 + 0.12;
      const lateralClosed = lat2 * (0.35 + 0.65 * cosF);
      const cxRaw = cosA * radialClosed - sinA * lateralClosed;
      const cyRaw = sinA * radialClosed + cosA * lateralClosed;
      const cx = cxRaw * 0.88;
      const cy = cyRaw * 1.10 + 0.05;
      const cz = petal.z * 0.3 + radial * sinF * 0.45 + 0.25;

      const tt = u * u * (3 - 2 * u);
      let col = mixColor(petal.inner, petal.outer, tt);
      // 外层根部 30% 暗化，模拟被内层遮挡的阴影
      if (petal.layer === 3 && u < 0.30) {
        col = [col[0] * 0.55, col[1] * 0.55, col[2] * 0.55];
      }
      // 奇偶亮度对比（已在 petal.brightness 里）
      col = [col[0] * petal.brightness, col[1] * petal.brightness, col[2] * petal.brightness];
      let size, seed;
      if (isVein) {
        // 叶脉：比本色提亮 30%，尺寸略大
        col = [Math.min(1, col[0] * 1.30), Math.min(1, col[1] * 1.30), Math.min(1, col[2] * 1.30)];
        size = (0.90 + Math.random() * 0.30) * 0.65 * 1.20;
        seed = 0.90 + Math.random() * 0.10;
      } else if (isEdge) {
        const edgeBright = Math.max(0, 1 - edgeDist / 0.35);
        col = mixColor(col, CREAM, edgeBright * 0.15);
        // 边缘亮度 ×1.25、尺寸 ×1.15（相对内部基准）
        col = [Math.min(1, col[0] * 1.25), Math.min(1, col[1] * 1.25), Math.min(1, col[2] * 1.25)];
        size = (0.85 + Math.random() * 0.30) * 0.65 * 1.15;
        seed = 0.85 + Math.random() * 0.15;
      } else {
        // 内部亮度 ×0.75
        col = [col[0] * 0.75, col[1] * 0.75, col[2] * 0.75];
        size = (0.85 + Math.random() * 0.30) * 0.65;
        seed = 0.30 + Math.random() * 0.40;
      }
      writeParticle(cx, cy, cz, ox, oy, oz, col, size, seed, petal.layer, petal.phase);
    }
  }

  // ---- 排序：按盛开 z 从后到前画，NormalBlending 下内层（靠前）才能自然遮住外层根部 ----
  // depthWrite 保持 false，所以不能靠深度缓冲遮挡，只能靠绘制顺序。
  const order = new Array(idx);
  for (let i = 0; i < idx; i++) order[i] = i;
  order.sort((a, b) => open[a * 3 + 2] - open[b * 3 + 2]);
  function reorder(src, itemSize) {
    const out = new Float32Array(idx * itemSize);
    for (let i = 0; i < idx; i++) {
      const s = order[i];
      for (let k = 0; k < itemSize; k++) out[i * itemSize + k] = src[s * itemSize + k];
    }
    return out;
  }
  const closedS = reorder(closed, 3);
  const openS = reorder(open, 3);
  const colorsS = reorder(colors, 3);
  const sizesS = reorder(sizes, 1);
  const seedsS = reorder(seeds, 1);
  const layersS = reorder(layers, 1);
  const phasesS = reorder(phases, 1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(openS, 3)); // 占位，真实位置在着色器里算
  geo.setAttribute('aClosed', new THREE.BufferAttribute(closedS, 3));
  geo.setAttribute('aOpen', new THREE.BufferAttribute(openS, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colorsS, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizesS, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seedsS, 1));
  geo.setAttribute('aLayer', new THREE.BufferAttribute(layersS, 1));
  geo.setAttribute('aPetalPhase', new THREE.BufferAttribute(phasesS, 1));
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
  // 已经开着就不要再申请一次新流：安卓上第二次 getUserMedia 很容易被旧流自己占住而失败，
  // 失败后又不报错、只剩“未检测到手”，这就是“第一次可以、后面不行”最常见的一种。
  // 已经开着时只做恢复播放和补启动循环。
  if (cameraOn && currentStream && videoEl.srcObject) {
    try { await videoEl.play(); } catch (_) { /* 播放失败走下面提示 */ }
    if (!videoEl.paused) {
      // 演示开着时手部结果会被演示的目标覆盖，花看起来像“识别不上”：开摄像头就默认关演示。
      if (demoMode) setDemo(false);
      statusEl.textContent = '摄像头已开启，正在识别手部…';
      statusEl.className = 'pill ok';
      startCameraLoop();
      return;
    }
  }
  // 旧流先停掉再申请新流，避免旧流占着摄像头导致新流 NotReadableError。
  if (currentStream) {
    currentStream.getTracks().forEach((track) => { try { track.stop(); } catch (_) {} });
    currentStream = null;
  }
  cameraOn = false;
  cameraLoopStarted = false;
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
    currentStream = stream;
    // 流一旦被系统、切后台或其他应用中断，之前是静默失效：只剩“未检测到手”，没有任何提示。
    // 现在监听轨道结束，明确告诉用户画面中断了、点“重新尝试”才能恢复。
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener('ended', () => {
        cameraOn = false;
        cameraLoopStarted = false;
        currentStream = null;
        statusEl.textContent = '摄像头画面中断了';
        statusEl.className = 'pill warn';
        btnCamera.textContent = '开启摄像头';
        showError('摄像头画面中断了（可能是切后台、锁屏或被其他应用抢占）：请点“重新尝试”重新开启摄像头。');
      });
    }
    videoEl.srcObject = stream;
    await videoEl.play();
    cameraOn = true;
    // 演示开着时手部结果会被演示的目标覆盖，花看起来像“识别不上”：开摄像头就默认关演示。
    if (demoMode) setDemo(false);
    statusEl.textContent = '摄像头已开启，正在识别手部…';
    statusEl.className = 'pill ok';
    btnCamera.textContent = '摄像头已开启';
    startCameraLoop();
  } catch (e) {
    cameraOn = false;
    cameraLoopStarted = false;
    currentStream = null;
    statusEl.textContent = '摄像头未开启';
    statusEl.className = 'pill warn';
    showError(cameraErrorMessage(e));
  }
}

// 识别循环只启动一份：重复启动会在 sending 标志上互相抢，导致送帧时断时续。
function startCameraLoop() {
  if (cameraLoopStarted) return;
  cameraLoopStarted = true;
  const loop = async () => {
    if (!cameraOn) { cameraLoopStarted = false; return; }
    if (!sending && videoEl.readyState >= 2 && !videoEl.paused) {
      sending = true;
      try { await hands.send({ image: videoEl }); } catch (_) { /* 单帧失败不中断 */ }
      sending = false;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// 切回前台时视频常被浏览器暂停，之前循环会一直跳过送帧、只剩“未检测到手”。
// 回到前台且摄像头本应开着时，尝试恢复播放。
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && cameraOn && currentStream && videoEl.paused) {
    videoEl.play().catch(() => {});
  }
});

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
// 调试滑块：只改重建用的宽度系数 / 边缘占比，不重置手势、spread、摄像头和任何参数。
// input 时只更新读数，change（松开滑块）时才重建，避免拖动过程中反复生成 40000 个粒子卡顿。
if (optWidth) {
  optWidth.addEventListener('input', () => {
    petalWidthCoeff = parseFloat(optWidth.value);
    if (optWidthValue) optWidthValue.textContent = petalWidthCoeff.toFixed(2);
  });
  optWidth.addEventListener('change', () => buildFlower(parseInt(optCount.value, 10)));
}
if (optEdge) {
  optEdge.addEventListener('input', () => {
    edgeRatio = parseFloat(optEdge.value);
    if (optEdgeValue) optEdgeValue.textContent = Math.round(edgeRatio * 100) + '%';
  });
  optEdge.addEventListener('change', () => buildFlower(parseInt(optCount.value, 10)));
}
// 固定全开：只改目标 spread，不重建花朵、不重置手势、演示和摄像头。
if (optLockFull) {
  optLockFull.addEventListener('change', () => {
    lockFull = optLockFull.checked;
  });
}

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
buildFlower(40000);
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
  // 固定全开调试：勾选时目标 spread 强制为 1，覆盖演示和手势的目标，
  // 各层按原窗口和速率向 1 靠拢，松开后立即恢复正常目标，不用重建。
  if (lockFull) targetSpread = 1;
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
  // 固定全开时状态按 spread 说，避免 tension 还在正弦变化时显示成花苞、和 spread 1.00 矛盾。
  flowerStateEl.textContent = lockFull ? '现在是：绽放（固定全开）' : flowerStateText(tensionSmooth);

  renderer.render(scene, camera);
});
