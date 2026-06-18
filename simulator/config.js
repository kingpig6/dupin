/* ============================================================
 *  互動式彩繪模擬器 — 設定檔 (唯一需要業主維護的檔案)
 *  改主體 / 改價 / 換素材 / 換字型，都只動這個檔。
 * ============================================================ */
const CONFIG = {
  // 標題與品牌
  brand: '獨品工坊 · 安全帽彩繪模擬器',

  // 主畫布尺寸：務必與素材 PNG 尺寸一致（你的素材是正方形 1200×1200）
  canvas: { width: 1200, height: 1200 },

  // 帽體顯示縮放（畫布內置中放大，1 = 原始；1.1 = 放大 10%）
  zoom: 1.1,

  /* 不變色底圖：面罩、通風口、Arai logo 等固定部分（a1）。
     放在最底層。若檔案不存在，引擎會自動產生佔位圖。 */
  baseLayer: 'assets/a1.png',

  /* 可變色部位：兩個部件，各有「一般色」與「金屬色」兩張灰階圖。
       部件1：一般色 b1.png / 金屬色 c1.png
       部件2：一般色 b2.png / 金屬色 c2.png
     每個部位需明確指定兩種材質的檔名：
       matteSrc : 一般漆(霧面)灰階圖
       metalSrc : 金屬漆灰階圖
     key      : 用於 URL 參數的識別碼
     name     : UI 顯示名稱
     z        : 疊圖順序（數字小 = 底層）
     default  : 預設顏色 (HEX)
     material : 預設材質 'metal' | 'matte' */
  parts: [
    { key: 'p1', name: '部件 1', z: 1, default: '#C0C0C0', material: 'matte',
      matteSrc: 'assets/b1.png', metalSrc: 'assets/c1.png' },
    { key: 'p2', name: '部件 2', z: 2, default: '#1A1A1A', material: 'matte',
      matteSrc: 'assets/b2.png', metalSrc: 'assets/c2.png' },
  ],

  // 風格快選調色盤
  palette: [
    '#E53935', '#FB8C00', '#FDD835', '#43A047', '#1E88E5',
    '#5E35B1', '#000000', '#FFFFFF', '#C0C0C0', '#B71C1C',
  ],

  // Apps Script 部署網址（部署後填入）
  apiUrl: 'YOUR_APPS_SCRIPT_URL_HERE',

  // 下單表單選項
  product: 'RX-7X',                                  // 品名（固定）
  sizes: ['S', 'M', 'L', 'XL'],                      // 尺寸下拉
  stores: ['新竹哈客部品', '高雄哈客部品', '林儒部品'],  // 指定店家（對應 AppSheet 客戶）
};
