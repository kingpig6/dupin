/* ============================================================
 *  渲染引擎 — 雙軌灰階圖層混合 (Canvas 2D)
 *  - 每個可變色部位有 metal / matte 兩張灰階 PNG
 *  - 使用者選色時，用 globalCompositeOperation 把 RGB 疊到灰階上，
 *    保留原圖的陰影與高光，並用原圖 alpha 重新遮罩避免染到透明區。
 *  - 找不到素材檔時，自動產生程式化佔位灰階圖，確保系統可運作。
 * ============================================================ */
const Engine = (() => {
  const W = CONFIG.canvas.width;
  const H = CONFIG.canvas.height;

  let mainCtx = null;
  const images = { base: null, parts: {} };   // parts[key] = { metal, matte }
  const cache = {};                            // 每部位上色後的離屏 canvas 快取

  // 部位目前狀態：{ color, material }
  const state = {};

  /* ---------- 載入素材（缺檔自動產生佔位圖） ---------- */
  function loadImage(src, fallbackDraw) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(makePlaceholder(fallbackDraw)); // 缺檔 → 佔位
      img.src = src;
    });
  }

  // 以離屏 canvas 畫出灰階佔位圖（回傳可當 drawImage 來源的 canvas）
  function makePlaceholder(drawFn) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    drawFn(x);
    return c;
  }

  // base 佔位：帽體輪廓 + 面罩
  function drawBasePlaceholder(x) {
    x.clearRect(0, 0, W, H);
    const g = x.createRadialGradient(W * 0.45, H * 0.4, 80, W * 0.5, H * 0.5, W * 0.55);
    g.addColorStop(0, '#3a3a3a'); g.addColorStop(1, '#101010');
    x.fillStyle = g;
    x.beginPath();
    x.ellipse(W * 0.5, H * 0.48, W * 0.34, H * 0.40, 0, 0, Math.PI * 2);
    x.fill();
    // 面罩（透明灰）
    x.fillStyle = 'rgba(180,200,220,0.35)';
    x.beginPath();
    x.ellipse(W * 0.42, H * 0.46, W * 0.20, H * 0.22, -0.1, 0, Math.PI * 2);
    x.fill();
  }

  // part 灰階佔位：用不同形狀 + 灰階漸層，metal 對比較高
  function drawPartPlaceholder(part, material) {
    return (x) => {
      x.clearRect(0, 0, W, H);
      const cx = W * 0.5, cy = H * 0.44;
      const seed = part.key.charCodeAt(part.key.length - 1);
      const g = x.createLinearGradient(cx - 300, cy - 200, cx + 300, cy + 200);
      if (material === 'metal') {
        g.addColorStop(0, '#fafafa'); g.addColorStop(0.5, '#8a8a8a'); g.addColorStop(1, '#ffffff');
      } else {
        g.addColorStop(0, '#b5b5b5'); g.addColorStop(0.5, '#6f6f6f'); g.addColorStop(1, '#9a9a9a');
      }
      x.fillStyle = g;
      x.beginPath();
      // 依 seed 畫不同角度的條帶狀圖騰
      const rot = (seed % 5) * 0.4;
      x.translate(cx, cy);
      x.rotate(rot);
      x.fillRect(-260, -40 - (seed % 3) * 60, 520, 70);
      x.fillRect(-200, 60, 400, 50);
      x.setTransform(1, 0, 0, 1, 0, 0);
    };
  }

  async function load() {
    images.base = await loadImage(CONFIG.baseLayer, drawBasePlaceholder);
    for (const part of CONFIG.parts) {
      images.parts[part.key] = {
        metal: await loadImage(part.metalSrc, drawPartPlaceholder(part, 'metal')),
        matte: await loadImage(part.matteSrc, drawPartPlaceholder(part, 'matte')),
      };
      state[part.key] = { color: part.default, material: part.material };
    }
  }

  /* ---------- 單部位上色（標準 tinting 配方） ---------- */
  function tintPart(key) {
    const part = CONFIG.parts.find(p => p.key === key);
    const st = state[key];
    const gray = images.parts[key][st.material];   // 依材質選 metal / matte 灰階層

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');

    // 1) 畫灰階層
    x.drawImage(gray, 0, 0, W, H);

    // 2) 疊色：先用 multiply 上飽和顏色（保留陰影）
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = st.color;
    x.fillRect(0, 0, W, H);

    // 3) 用 lighten 把灰階的亮部「補回來」，
    //    這樣即使選純黑/深色，高光與立體細節也不會被吃掉。
    //    金屬色補得更強（更亮、折射感）；一般色補得柔和（霧面但有細節）。
    x.globalCompositeOperation = 'lighten';
    x.globalAlpha = (st.material === 'metal') ? 0.55 : 0.32;
    x.drawImage(gray, 0, 0, W, H);
    x.globalAlpha = 1;

    // 4) 金屬色再補一層 overlay 提高對比與亮度
    if (st.material === 'metal') {
      x.globalCompositeOperation = 'overlay';
      x.fillStyle = st.color;
      x.globalAlpha = 0.35;
      x.fillRect(0, 0, W, H);
      x.globalAlpha = 1;
    }

    // 5) 用原圖 alpha 重新遮罩，避免染到透明區
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(gray, 0, 0, W, H);

    x.globalCompositeOperation = 'source-over';
    cache[key] = c;
    return c;
  }

  /* ---------- 合成到主畫布 ---------- */
  function render() {
    mainCtx.clearRect(0, 0, W, H);
    mainCtx.drawImage(images.base, 0, 0, W, H);            // 底圖
    const ordered = [...CONFIG.parts].sort((a, b) => a.z - b.z);
    for (const part of ordered) {
      const layer = cache[part.key] || tintPart(part.key);
      mainCtx.drawImage(layer, 0, 0, W, H);
    }
  }

  // 改色 / 換材質 → 只重算該部位 → 重繪
  function setColor(key, color)       { state[key].color = color; tintPart(key); render(); }
  function setMaterial(key, material) { state[key].material = material; tintPart(key); render(); }

  function getState() { return JSON.parse(JSON.stringify(state)); }

  async function init(canvasEl) {
    mainCtx = canvasEl.getContext('2d');
    canvasEl.width = W; canvasEl.height = H;
    await load();
    CONFIG.parts.forEach(p => tintPart(p.key));
    render();
  }

  // 提供命中偵測：回傳點擊座標落在哪個部位（用該部位灰階 alpha 判斷，由上層往下找）
  function hitTest(px, py) {
    const ordered = [...CONFIG.parts].sort((a, b) => b.z - a.z); // 由頂層往下
    for (const part of ordered) {
      const layer = cache[part.key];
      if (!layer) continue;
      const x = layer.getContext('2d');
      const alpha = x.getImageData(px, py, 1, 1).data[3];
      if (alpha > 20) return part.key;
    }
    return null;
  }

  return { init, setColor, setMaterial, getState, hitTest, render };
})();
