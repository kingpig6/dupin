/* ============================================================
 *  互動式彩繪模擬器 — 設定檔 (唯一需要業主維護的檔案)
 *  改主體 / 改價 / 換素材 / 換字型，都只動這個檔。
 * ============================================================ */
const CONFIG = {
  // 標題與品牌
  brand: '獨品工坊 · 安全帽彩繪模擬器',

  // 主畫布尺寸（建議與素材 PNG 尺寸一致）
  canvas: { width: 1200, height: 900 },

  /* 不變色底圖：面罩、通風口、Arai logo，以及 b1（固定圖騰貼片）。
     放在最底層。若檔案不存在，引擎會自動產生佔位圖。 */
  baseLayer: 'assets/b1.png',

  /* 可變色部位：只有 b2、b3（b1 固定，當底圖）。
     素材命名（業主提供）：
       一般色(霧面) 灰階圖 → b2.png / b3.png
       金屬色       灰階圖 → c1.png / c2.png
     每個部位需明確指定兩種材質的檔名：
       matteSrc : 一般漆灰階圖
       metalSrc : 金屬漆灰階圖
     ※ 配對為假設值，請業主確認 c1/c2 各對應哪個部位。
     key      : 用於 URL 參數的識別碼
     name     : UI 顯示名稱
     z        : 疊圖順序（數字小 = 底層）
     default  : 預設顏色 (HEX)
     material : 預設材質 'metal' | 'matte' */
  parts: [
    { key: 'b2', name: '圖騰 A', z: 1, default: '#C0C0C0', material: 'matte',
      matteSrc: 'assets/b2.png', metalSrc: 'assets/c1.png' },
    { key: 'b3', name: '圖騰 B', z: 2, default: '#1A1A1A', material: 'matte',
      matteSrc: 'assets/b3.png', metalSrc: 'assets/c2.png' },
  ],

  // 風格快選調色盤
  palette: [
    '#E53935', '#FB8C00', '#FDD835', '#43A047', '#1E88E5',
    '#5E35B1', '#000000', '#FFFFFF', '#C0C0C0', '#B71C1C',
  ],

  // Apps Script 部署網址（部署後填入）
  apiUrl: 'YOUR_APPS_SCRIPT_URL_HERE',

  // 下單表單分店選項
  stores: ['台中總店', '台北店', '高雄店'],
};
