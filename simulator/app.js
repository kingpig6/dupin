/* ============================================================
 *  UI 互動 / URL 參數 / 下單表單 / Email 發送
 *  （已移除：高光閃爍、客製文字、價格計算）
 * ============================================================ */
(() => {
  let activeKey = CONFIG.parts[0].key;   // 目前選取的部位

  const $ = (id) => document.getElementById(id);

  /* ---------------- 初始化 ---------------- */
  async function start() {
    document.title = CONFIG.brand;
    $('brand').textContent = CONFIG.brand;

    const canvas = $('helmetCanvas');
    await Engine.init(canvas);

    applyUrlParams();          // 先套用網址參數（無參數 → 維持預設）
    buildPartTabs();
    buildPalette();
    bindColorControls();
    bindCanvasClick(canvas);
    bindStoreOptions();
    syncControlsToActive();

    // 行動端：頁眉預設收起摺疊
    if (window.matchMedia('(max-width: 880px)').matches) {
      $('appHeader').classList.add('collapsed');
    }

    Engine.render();
  }

  function toggleHeader() {
    $('appHeader').classList.toggle('collapsed');
  }

  /* ---------------- 部位切換頁籤 ---------------- */
  function buildPartTabs() {
    const wrap = $('partTabs');
    wrap.innerHTML = '';
    CONFIG.parts.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'part-tab';
      b.textContent = p.name;
      b.dataset.key = p.key;
      b.onclick = () => setActive(p.key);
      wrap.appendChild(b);
    });
    highlightActiveTab();
  }

  function setActive(key) {
    activeKey = key;
    highlightActiveTab();
    syncControlsToActive();
  }

  function highlightActiveTab() {
    document.querySelectorAll('.part-tab').forEach((b) =>
      b.classList.toggle('active', b.dataset.key === activeKey));
  }

  /* ---------------- 調色盤 ---------------- */
  function buildPalette() {
    const wrap = $('palette');
    wrap.innerHTML = '';
    CONFIG.palette.forEach((c) => {
      const label = `${c.name} ${c.code}`;
      const sw = document.createElement('button');
      sw.className = 'swatch';
      sw.style.background = c.hex;
      sw.title = label;                       // 桌機滑鼠移上去顯示
      sw.onclick = () => { applyColor(c.hex); showSwatchLabel(label); };
      wrap.appendChild(sw);
    });
  }

  // 點選色票時，於下方顯示色名+色號（方便客戶溝通）
  function showSwatchLabel(text) {
    const el = $('swatchLabel');
    if (el) el.textContent = text;
  }

  /* ---------------- 選色 / 材質控制 ---------------- */
  function bindColorControls() {
    $('colorPicker').addEventListener('input', (e) => applyColor(e.target.value));
    $('hexInput').addEventListener('change', (e) => {
      let v = e.target.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9a-fA-F]{6}$/.test(v)) applyColor(v);
    });
    $('matMetal').addEventListener('click', () => applyMaterial('metal'));
    $('matMatte').addEventListener('click', () => applyMaterial('matte'));
  }

  function applyColor(hex) {
    Engine.setColor(activeKey, hex);
    syncControlsToActive();
    updateUrl();
  }

  function applyMaterial(material) {
    Engine.setMaterial(activeKey, material);
    syncControlsToActive();
    updateUrl();
  }

  // 將目前選取部位的狀態同步回 UI 控制項
  function syncControlsToActive() {
    const st = Engine.getState()[activeKey];
    $('colorPicker').value = st.color;
    $('hexInput').value = st.color.toUpperCase();
    $('matMetal').classList.toggle('active', st.material === 'metal');
    $('matMatte').classList.toggle('active', st.material === 'matte');
  }

  /* ---------------- 點擊畫布選部位 ---------------- */
  function bindCanvasClick(canvas) {
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const px = Math.round((e.clientX - rect.left) / rect.width * CONFIG.canvas.width);
      const py = Math.round((e.clientY - rect.top) / rect.height * CONFIG.canvas.height);
      const key = Engine.hitTest(px, py);
      if (key) setActive(key);
    });
  }

  /* ---------------- URL 參數：?b2=C0C0C0_M&b3=1A1A1A_N ---------------- */
  function applyUrlParams() {
    const params = new URLSearchParams(location.search);
    CONFIG.parts.forEach((p) => {
      const raw = params.get(p.key);
      if (!raw) return;                       // 無參數 → 維持 config 預設
      const [hex, mat] = raw.split('_');
      if (/^[0-9a-fA-F]{6}$/.test(hex)) Engine.setColor(p.key, '#' + hex);
      if (mat === 'M') Engine.setMaterial(p.key, 'metal');
      if (mat === 'N') Engine.setMaterial(p.key, 'matte');
    });
  }

  function buildParamString() {
    const st = Engine.getState();
    return CONFIG.parts.map((p) => {
      const s = st[p.key];
      const mat = s.material === 'metal' ? 'M' : 'N';
      return `${p.key}=${s.color.replace('#', '')}_${mat}`;
    }).join('&');
  }

  function updateUrl() {
    // 即時把目前設計寫進網址（不新增歷史紀錄）
    history.replaceState(null, '', '?' + buildParamString());
  }

  function shareUrl() {
    const url = location.origin + location.pathname + '?' + buildParamString();
    navigator.clipboard.writeText(url)
      .then(() => toast('分享網址已複製！'))
      .catch(() => prompt('複製此網址分享：', url));
  }

  /* ---------------- 下單表單 ---------------- */
  function bindStoreOptions() {
    const fill = (sel, items) => items.forEach((s) => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s; sel.appendChild(o);
    });
    fill($('fStore'), CONFIG.stores);
    fill($('fSize'), CONFIG.sizes);
    $('fProduct').value = CONFIG.product;   // 品名固定
  }

  function openOrder() { $('orderModal').classList.add('show'); }
  function closeOrder() { $('orderModal').classList.remove('show'); }

  async function submitOrder(e) {
    e.preventDefault();

    // 尚未設定 Apps Script 寄信網址時，不硬送，給友善提示
    if (!CONFIG.apiUrl || CONFIG.apiUrl === 'YOUR_APPS_SCRIPT_URL_HERE') {
      toast('下單功能尚未啟用，請先聯繫門市');
      return;
    }

    const btn = $('submitBtn');
    btn.disabled = true; btn.textContent = '傳送中…';

    const designImage = $('helmetCanvas').toDataURL('image/png');
    const payload = {
      action: 'order',
      product: $('fProduct').value,
      size: $('fSize').value,
      store: $('fStore').value,
      staff: $('fStaff').value,
      note: $('fNote').value,
      params: buildParamString(),
      shareUrl: location.origin + location.pathname + '?' + buildParamString(),
      image: designImage,
    };

    try {
      // 沿用既有 app 對 Apps Script 的呼叫模式：text/plain 避免 CORS preflight
      await fetch(CONFIG.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
      });
      toast('訂單已送出！我們會盡快處理');
      closeOrder();
      e.target.reset();
      $('fProduct').value = CONFIG.product;   // reset 後復原固定品名
    } catch (err) {
      toast('傳送失敗，請稍後再試');
    } finally {
      btn.disabled = false; btn.textContent = '送出訂單';
    }
  }

  /* ---------------- 小工具 ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // 對外暴露給 HTML onclick 使用
  window.SimUI = { shareUrl, openOrder, closeOrder, submitOrder, toggleHeader };

  window.addEventListener('DOMContentLoaded', start);
})();
