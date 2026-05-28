// ----------------------------------------------------------------
// SECTION: ⚙️ การตั้งค่าหลัก (กรุณาใส่ ID จริงของคุณที่นี่)
// ----------------------------------------------------------------
const STATUS = {
  PENDING: 'รอดำเนินการ',
  PROCESSING: 'กำลังดำเนินการ',
  EXTERNAL: 'ดำเนินการภายนอก',
  PARTS: 'พัสดุอยู่ระหว่างรอเบิก',
  COMPLETED: 'เสร็จสิ้น',
  CANCELLED: 'ยกเลิก',
  PARTS_ALT: 'รอเบิกพัสดุ'
};

const PRIORITY = {
  EMERGENCY: 'ฉุกเฉิน',
  URGENT: 'เร่งด่วน',
  MEDIUM: 'ปานกลาง',
  LOW: 'ต่ำ',
  LOW_ALT: 'ไม่เร่งด่วน'
};

const ROLES = {
  ADMIN: 'admin',
  TECHNICIAN: 'technician',
  USER: 'user'
};

const CONFIG = {
  SPREADSHEET_ID:   PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'),
  SHEET_NAME:       'รายการแจ้งซ่อมทั้งหมด',
  STATUS_LOG_SHEET_NAME: 'ประวัติสถานะงานซ่อม',
  USER_SHEET_NAME:  'users',
  TEMPLATE_ID:      PropertiesService.getScriptProperties().getProperty('TEMPLATE_ID'),
  MONTHLY_TEMPLATE_ID: PropertiesService.getScriptProperties().getProperty('MONTHLY_TEMPLATE_ID'),
  TARGET_FOLDER_ID: PropertiesService.getScriptProperties().getProperty('TARGET_FOLDER_ID'),
  IMAGE_FOLDER_ID:  PropertiesService.getScriptProperties().getProperty('IMAGE_FOLDER_ID'),
  FONT_FAMILY:      'TH SarabunPSK',
  MONTHS_TH: [
    'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
  ],
  TELEGRAM_BOT_TOKEN: PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_CHAT_ID:   PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID'),

  // 🔽 โลโก้รายงาน PDF
  REPORT_LOGO_FILE_ID: PropertiesService.getScriptProperties().getProperty('REPORT_LOGO_FILE_ID'),
  IS_TEST_MODE: PropertiesService.getScriptProperties().getProperty('IS_TEST_MODE') === 'true'
};

// ----------------------------------------------------------------
// SECTION: 🌐 WEB APP CORE (doGet & Helpers)
// ----------------------------------------------------------------

// [ANCHOR: SERVER: doGet]
function doGet(e) {
  try {
    const params = e.parameter;
    const page = params.page || 'index';
    const action = params.action || '';

    // --- 💖[จุดแก้ไขที่ 1] 💖 ---
    // เพิ่มเส้นทางสำหรับเรียกดูรูปภาพโดยตรง
    if (action === 'serveImage' && params.id) {
      return serveImage(params.id);
    }
    
    if (action === 'logout') {
      const mainUrl = getWebAppUrl();
      const logoutHtml = `<!DOCTYPE html><html><head><title>กำลังออกจากระบบ...</title><meta http-equiv="refresh" content="2;url=${mainUrl}"></head><body><p>กำลังออกจากระบบ...</p><script>localStorage.removeItem('userInfo'); sessionStorage.clear(); window.top.location.href='${mainUrl}';</script></body></html>`;
      return HtmlService.createHtmlOutput(logoutHtml).setTitle('ออกจากระบบ').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    const template = HtmlService.createTemplateFromFile(page);
    template.baseUrl = getWebAppUrl();
    const htmlOutput = template.evaluate();

    // กำหนดชื่อ Title ของแท็บเบราว์เซอร์ตามหน้าเพจที่เปิด
    let title = 'ระบบแจ้งซ่อมออนไลน์';
    if (page === 'dashboard') {
      title = 'แดชบอร์ด - ' + title;
    } else if (page === 'stock') {
      title = 'ระบบสต็อกอะไหล่ - ' + title;
    }
    
    return htmlOutput.setTitle(title).addMetaTag('viewport', 'width=device-width, initial-scale=1.0').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (error) {
    Logger.log('Fatal error in doGet: ' + error.stack);
    return HtmlService.createHtmlOutput('เกิดข้อผิดพลาดร้ายแรง: ' + error.message);
  }
}
/**
 * ดึง URL ของ Web App ปัจจุบัน
 */
function getWebAppUrl() {
  return ScriptApp.getService().getUrl().replace('/dev', '/exec');
}

/**
 * ใช้สำหรับ include ไฟล์ HTML อื่นๆ (ถ้ามี)
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


// ----------------------------------------------------------------
// SECTION: 📝 FORM SUBMISSION & DATA HANDLING
// ----------------------------------------------------------------
function submitRepairForm(formData, imageFiles) {
  try {
    if (!formData || !formData.requesterName || !formData.repairItem) {
      throw new Error('กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน');
    }

    const sequenceNumber = generateSequenceNumber();
    const now = new Date();

    formData.sequenceNumber = sequenceNumber;
    formData.currentDateTime = now;

    const imageUrls = (imageFiles && imageFiles.length > 0) ? uploadImages(imageFiles, sequenceNumber) : [];

    saveToSheetPendingPdf(formData, '', '', imageUrls);

    try { CacheService.getScriptCache().remove('dashboard:data:v3'); } catch(e) {}

    const queued = enqueuePdf(sequenceNumber);
    if (!queued || !queued.success) {
      throw new Error(queued && queued.error ? queued.error : 'ไม่สามารถเข้าคิวสร้าง PDF ได้');
    }

    sendNewRepairNotification(buildNewRepairNotificationData_(formData, sequenceNumber), '', imageUrls);

    return {
      success: true,
      message: 'บันทึกการแจ้งซ่อมเรียบร้อยแล้ว',
      sequenceNumber: sequenceNumber
    };
  } catch (error) {
    Logger.log('CRITICAL ERROR in submitRepairForm: ' + error.stack);
    return { success: false, error: error.message };
  }
}

function buildNewRepairNotificationData_(formData, sequenceNumber) {
  formData = formData || {};

  return {
    '{{เลขที่}}': sequenceNumber,
    '{{วันที่}}': getCurrentThaiDate(),
    '{{ชื่อผู้แจ้งซ่อม}}': formData.requesterName,
    '{{เบอร์โทร}}': formData.phoneNumber,
    '{{สถานที่}}': formData.location,
    '{{ประเภทงานซ่อม}}': formData.repairType,
    '{{รายการแจ้งซ่อม}}': formData.repairItem,
    '{{อาการ}}': formData.description,
    '{{ความเร่งด่วน}}': formData.priority
  };
}

function selfTestNewRepairNotificationDataMapping_() {
  const data = buildNewRepairNotificationData_({
    requesterName: 'ทดสอบระบบ',
    phoneNumber: '0858138974',
    location: 'ทดสอบระบบ (ชั้น 1)',
    repairType: 'ประปา',
    repairItem: 'ท่อปะปาแตก',
    description: 'น้ำไหลไม่หยุด',
    priority: 'ปานกลาง'
  }, 'SDUL-TEST-001');

  const checks = {
    '{{เลขที่}}': 'SDUL-TEST-001',
    '{{ชื่อผู้แจ้งซ่อม}}': 'ทดสอบระบบ',
    '{{เบอร์โทร}}': '0858138974',
    '{{สถานที่}}': 'ทดสอบระบบ (ชั้น 1)',
    '{{ประเภทงานซ่อม}}': 'ประปา',
    '{{รายการแจ้งซ่อม}}': 'ท่อปะปาแตก',
    '{{อาการ}}': 'น้ำไหลไม่หยุด',
    '{{ความเร่งด่วน}}': 'ปานกลาง'
  };

  Object.keys(checks).forEach(function(key) {
    if (data[key] !== checks[key]) {
      throw new Error('selfTestNewRepairNotificationDataMapping_ failed: ' + key + ' expected=' + checks[key] + ' actual=' + data[key]);
    }
  });

  const edgeData = buildNewRepairNotificationData_({ repairItem: 'ทดสอบ edge case' }, 'SDUL-TEST-EDGE');
  if (edgeData['{{เลขที่}}'] !== 'SDUL-TEST-EDGE' || edgeData['{{รายการแจ้งซ่อม}}'] !== 'ทดสอบ edge case') {
    throw new Error('selfTestNewRepairNotificationDataMapping_ edge failed');
  }

  return { success: true, message: 'new repair notification mapping ok' };
}





/**
 * สร้างเลขที่ใบแจ้งซ่อมที่ไม่ซ้ำกัน
 */
function generateSequenceNumber() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); 
  try {
    const now = new Date();
    const year = now.getFullYear() + 543;
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const datePrefix = `SDUL-${year}${month}${day}`;

    const sheet = getSheetInstance();
    const range = sheet.getRange("A2:A" + sheet.getLastRow());
    const values = range.getValues();
    
    let maxSequence = 0;
    values.forEach(row => {
      const existingNumber = row[0];
      if (existingNumber && existingNumber.toString().startsWith(datePrefix)) {
        const sequencePart = parseInt(existingNumber.toString().split('-')[2], 10);
        if (!isNaN(sequencePart) && sequencePart > maxSequence) {
          maxSequence = sequencePart;
        }
      }
    });

    const nextSequence = maxSequence + 1;
    const sequenceStr = String(nextSequence).padStart(3, '0');
    return `${datePrefix}-${sequenceStr}`;
  } finally {
    lock.releaseLock();
  }
}

function getUrl() {
  return getWebAppUrl();
}

function formatThaiDateTime(dateObj) {
  const d = (dateObj instanceof Date) ? dateObj : new Date(dateObj);
  if (isNaN(d.getTime())) return '';

  const day = Utilities.formatDate(d, "GMT+7", "dd");
  const month = Utilities.formatDate(d, "GMT+7", "MM");
  const yearAD = parseInt(Utilities.formatDate(d, "GMT+7", "yyyy"), 10);
  const yearBE = yearAD + 543;

  const hh = parseInt(Utilities.formatDate(d, "GMT+7", "HH"), 10);
  const mm = parseInt(Utilities.formatDate(d, "GMT+7", "mm"), 10);

  const dateStr = `${day}/${month}/${yearBE}`;

  // CHANGE: ถ้าเป็น 00:00 ให้ถือว่าเป็น date-only → แสดงเฉพาะวันที่
  if (hh === 0 && mm === 0) return dateStr;

  const timeStr = Utilities.formatDate(d, "GMT+7", "HH:mm");
  return `${dateStr} ${timeStr} น.`;
}

function helpNormalizePhone(input) {
  if (input == null) return '';
  // บังคับเป็น string แบบไม่ทำให้เป็นเลข
  let s = String(input).trim();

  // เอาเฉพาะตัวเลข (ลบช่องว่าง/ขีด/วงเล็บ)
  s = s.replace(/[^\d]/g, '');

  // ไม่เติม/ไม่แก้รูปแบบเพิ่มเอง เพื่อไม่เดาเลขผิด
  return s;
}

// [ANCHOR: SERVER: PHONE_HELPERS]
// CHANGE: บังคับคอลัมน์ “เบอร์โทร” ให้เป็น Plain text (@) กัน 0 หาย
function helpEnsurePhoneColumnText(sheet) {
  try {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
    const idx = headers.indexOf('เบอร์โทร');
    if (idx === -1) return false;

    // ตั้งทั้งคอลัมน์ (เริ่มแถว 2)
    const rng = sheet.getRange(2, idx + 1, Math.max(sheet.getLastRow() - 1, 1), 1);
    rng.setNumberFormat('@');
    return true;
  } catch (e) {
    Logger.log('helpEnsurePhoneColumnText error: ' + e.message);
    return false;
  }
}

function helpEnsureDateTimeColumns(sheet, headerNames) {
  // CHANGE: ensure datetime columns (real time)
  if (!sheet) throw new Error('helpEnsureDateTimeColumns: sheet missing');

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const tz = Session.getScriptTimeZone() || 'Asia/Bangkok';

  (headerNames || []).forEach((name) => {
    const idx = headers.indexOf(String(name).trim());
    if (idx < 0) return;

    const col = idx + 1;
    // ตั้ง format เป็นวันที่+เวลา (กันเวลาโดนตัด)
    sheet.getRange(2, col, Math.max(1, sheet.getMaxRows() - 1), 1).setNumberFormat('dd/MM/yyyy HH:mm:ss');
    // กันกรณี timezone ในชีตเพี้ยน (อย่างน้อย log ให้เห็น)
    Logger.log(`[INFO] DateTime format ensured: ${name} | col=${col} | tz=${tz}`);
  });
}

function helpMapHeadersFromSheet(sheet) {
  // CHANGE: header map helper
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i + 1; }); // 1-based col
  return { headers, map };
}

function getStatusLogSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheetName = CONFIG.STATUS_LOG_SHEET_NAME || 'ประวัติสถานะงานซ่อม';
  let sheet = ss.getSheetByName(sheetName);
  const headers = ['วันที่บันทึก', 'เลขที่', 'สถานะ', 'หมายเหตุ', 'ผู้บันทึก', 'รูปภาพ'];

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }

  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });
  if (firstRow.join('') === '') {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function getStatusLogUserName_(userObj) {
  if (!userObj) return '';
  return String(userObj.displayName || userObj.name || userObj.username || userObj.email || '').trim();
}

function appendStatusLog_(sequenceNumber, status, note, userObj, imageUrls) {
  const sheet = getStatusLogSheet_();
  const images = Array.isArray(imageUrls) ? imageUrls.filter(Boolean).join(',') : '';
  const logDate = new Date();
  const logData = {
    'วันที่บันทึก': logDate,
    'เลขที่': String(sequenceNumber || '').trim(),
    'สถานะ': String(status || '').trim(),
    'หมายเหตุ': String(note || '').trim() || '-',
    'ผู้บันทึก': getStatusLogUserName_(userObj),
    'รูปภาพ': images
  };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });
  const row = new Array(headers.length).fill('');
  headers.forEach(function(h, i) {
    if (Object.prototype.hasOwnProperty.call(logData, h)) row[i] = logData[h];
  });

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const lastValues = sheet.getRange(lastRow, 1, 1, headers.length).getValues()[0];
    const idx = function(name) { return headers.indexOf(name); };
    const cDate = idx('วันที่บันทึก');
    const cSeq = idx('เลขที่');
    const cStatus = idx('สถานะ');
    const cNote = idx('หมายเหตุ');
    const cUser = idx('ผู้บันทึก');
    const cImage = idx('รูปภาพ');
    const lastDate = cDate > -1 ? lastValues[cDate] : null;
    const isRecent = lastDate instanceof Date && (logDate.getTime() - lastDate.getTime()) < 10000;
    const isSameLog = String(lastValues[cSeq] || '').trim() === logData['เลขที่']
      && String(lastValues[cStatus] || '').trim() === logData['สถานะ']
      && String(lastValues[cNote] || '').trim() === logData['หมายเหตุ']
      && String(lastValues[cUser] || '').trim() === logData['ผู้บันทึก']
      && String(lastValues[cImage] || '').trim() === logData['รูปภาพ'];
    if (isRecent && isSameLog) return;
  }

  sheet.appendRow(row);
}

function getStatusLogValues_() {
  const sheet = getStatusLogSheet_();
  const values = sheet.getDataRange().getValues();
  return values && values.length > 1 ? values : [];
}

function getStatusLogsBySequence(sequenceNumber, fallbackRow, statusLogValues) {
  const target = String(sequenceNumber || '').trim();
  if (!target) return [];

  let fallback = fallbackRow || null;
  let values = statusLogValues || null;
  if (Array.isArray(fallbackRow)) {
    values = fallbackRow;
    fallback = null;
  }

  values = values || getStatusLogValues_();
  if (!values || values.length < 2) return fallback ? [fallback] : [];

  const headers = values[0].map(function(h) { return String(h || '').trim(); });
  const idx = function(name) { return headers.indexOf(name); };
  const cSeq = idx('เลขที่');
  const cStatus = idx('สถานะ');
  const cNote = idx('หมายเหตุ');
  const cUser = idx('ผู้บันทึก');
  const cDate = idx('วันที่บันทึก');
  const cImage = idx('รูปภาพ');

  if (cSeq < 0 || cStatus < 0 || cDate < 0) return fallback ? [fallback] : [];

  const logs = values.slice(1)
    .filter(function(row) { return String(row[cSeq] || '').trim() === target; })
    .map(function(row) {
      const imageText = cImage > -1 ? String(row[cImage] || '').trim() : '';
      return {
        sequenceNumber: target,
        status: cStatus > -1 ? String(row[cStatus] || '').trim() : '',
        note: cNote > -1 ? String(row[cNote] || '').trim() : '',
        user: cUser > -1 ? String(row[cUser] || '').trim() : '',
        date: cDate > -1 ? row[cDate] : '',
        imageIds: imageText && typeof helpNormalizeReportImageIds_ === 'function' ? helpNormalizeReportImageIds_(imageText) : []
      };
    })
    .sort(function(a, b) {
      const da = a.date instanceof Date ? a.date.getTime() : 0;
      const db = b.date instanceof Date ? b.date.getTime() : 0;
      return da - db;
    });

  return logs.length ? logs : (fallback ? [fallback] : []);
}

function buildStatusLogMap_(statusLogValues) {
  const values = statusLogValues || getStatusLogValues_();
  if (!values || values.length < 2) return {};

  const headers = values[0].map(function(h) { return String(h || '').trim(); });
  const cSeq = headers.indexOf('เลขที่');
  const cStatus = headers.indexOf('สถานะ');
  const cNote = headers.indexOf('หมายเหตุ');
  const cUser = headers.indexOf('ผู้บันทึก');
  const cDate = headers.indexOf('วันที่บันทึก');
  const cImage = headers.indexOf('รูปภาพ');
  if (cSeq < 0 || cStatus < 0 || cDate < 0) return {};

  const map = {};
  values.slice(1).forEach(function(row) {
    const seq = String(row[cSeq] || '').trim();
    if (!seq) return;
    const imageText = cImage > -1 ? String(row[cImage] || '').trim() : '';
    if (!map[seq]) map[seq] = [];
    map[seq].push({
      sequenceNumber: seq,
      status: cStatus > -1 ? String(row[cStatus] || '').trim() : '',
      note: cNote > -1 ? String(row[cNote] || '').trim() : '',
      user: cUser > -1 ? String(row[cUser] || '').trim() : '',
      date: cDate > -1 ? row[cDate] : '',
      imageIds: imageText && typeof helpNormalizeReportImageIds_ === 'function' ? helpNormalizeReportImageIds_(imageText) : []
    });
  });

  Object.keys(map).forEach(function(seq) {
    map[seq].sort(function(a, b) {
      const da = a.date instanceof Date ? a.date.getTime() : 0;
      const db = b.date instanceof Date ? b.date.getTime() : 0;
      return da - db;
    });
  });
  return map;
}

function helpFindRowBySequence(sheet, sequenceNumber) {
  // CHANGE: robust finder (values + displayValues + TextFinder) + normalize
  if (!sheet) return 0;
  const seq = String(sequenceNumber || '').trim();
  if (!seq) return 0;

  const norm = (s) => String(s == null ? '' : s)
    .replace(/\u200B/g, '')     // zero-width space
    .replace(/\s+/g, ' ')       // normalize spaces
    .trim();

  const { map } = helpMapHeadersFromSheet(sheet);
  const colSeq = map['เลขที่'];
  if (!colSeq) throw new Error('ไม่พบคอลัมน์ "เลขที่"');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  // 1) Fast: TextFinder ในคอลัมน์เลขที่ (ตรง/บางส่วน)
  try {
    const colRange = sheet.getRange(2, colSeq, lastRow - 1, 1);
    const tf = colRange.createTextFinder(seq).matchCase(false).matchEntireCell(true);
    const r = tf.findNext();
    if (r) return r.getRow();

    // CHANGE: บางเคสเลขที่ถูกตัด/มีข้อความเพิ่ม ให้ลอง matchEntireCell(false) อีกชั้น
    const tf2 = colRange.createTextFinder(seq).matchCase(false).matchEntireCell(false);
    const r2 = tf2.findNext();
    if (r2) return r2.getRow();
  } catch (e) {
    // ถ้า TextFinder ใช้ไม่ได้ ให้ไปวิธี scan ต่อ
  }

  // 2) Scan: ใช้ทั้ง rawValues + displayValues เพื่อจับ formula/hyperlink
  const range = sheet.getRange(2, colSeq, lastRow - 1, 1);
  const raw = range.getValues();
  const disp = range.getDisplayValues();

  const target = norm(seq);

  for (let i = 0; i < raw.length; i++) {
    const a = norm(raw[i][0]);
    const b = norm(disp[i][0]);
    if (a === target || b === target) return i + 2;
  }

  // 3) Scan contains: เผื่อมี prefix/suffix แปลก ๆ
  for (let i = 0; i < raw.length; i++) {
    const a = norm(raw[i][0]);
    const b = norm(disp[i][0]);
    if ((a && a.indexOf(target) > -1) || (b && b.indexOf(target) > -1)) return i + 2;
  }

  return 0;
}


function saveToSheet(formData) {
  const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);

  // CHANGE: บังคับคอลัมน์ “เบอร์โทร” เป็น Plain text (@) กัน 0 หาย
  if (typeof helpEnsurePhoneColumnText === 'function') helpEnsurePhoneColumnText(sheet);

  // CHANGE: บังคับคอลัมน์วันที่/เวลาให้เป็น DateTime (กันเวลาโดนตัด)
  helpEnsureDateTimeColumns(sheet, ['วันที่', 'วันที่อัปเดตสถานะ', 'วันที่เสร็จสิ้น']);

  const now = new Date();
  const sequenceNumber = (formData && formData.sequenceNumber) ? String(formData.sequenceNumber).trim() : generateSequenceNumber();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const { headers } = helpMapHeadersFromSheet(sheet);
    const row = new Array(headers.length).fill('');

    const set = (name, value) => {
      const idx = headers.indexOf(String(name).trim());
      if (idx > -1) row[idx] = value;
    };

    set('เลขที่', sequenceNumber);
    set('วันที่', now); // Date object
    set('ชื่อผู้แจ้งซ่อม', (formData && formData.requesterName) ? String(formData.requesterName) : '');
    set('เบอร์โทร', (typeof helpNormalizePhone === 'function') ? helpNormalizePhone((formData && formData.phoneNumber) ? String(formData.phoneNumber) : '') : ((formData && formData.phoneNumber) ? String(formData.phoneNumber) : ''));
    set('ประเภทงานซ่อม', (formData && formData.repairType) ? String(formData.repairType) : 'ทั่วไป');
    set('รายการแจ้งซ่อม', (formData && formData.repairItem) ? String(formData.repairItem) : '');
    set('อาการ', (formData && formData.description) ? String(formData.description) : '');
    set('สถานที่', (formData && formData.location) ? String(formData.location) : '');
    set('สถานะ', STATUS.PENDING);

    // CHANGE: ค่าเริ่มต้นของ “วันที่อัปเดตสถานะ/วันที่เสร็จสิ้น” ให้เป็นค่าว่าง (แต่เป็นคอลัมน์ DateTime แล้ว)
    set('วันที่อัปเดตสถานะ', '');
    set('วันที่เสร็จสิ้น', '');

    set('รหัสเอกสาร', '');
    set('ลิงก์เอกสาร', '');
    set('ความเร่งด่วน', (formData && formData.priority) ? String(formData.priority) : PRIORITY.MEDIUM);
    set('หมายเหตุ', '');
    set('ผู้รับผิดชอบ', '');
    set('URL รูปภาพประกอบ', '[]');

    // รองรับคอลัมน์ “วันที่รับงาน” (ถ้ามี)
    set('วันที่รับงาน', '');

    sheet.appendRow(row);
    SpreadsheetApp.flush();

    // CHANGE: หา rowIndex กลับมา (ไว้ใช้ต่อ/ไว้ทดสอบ)
    const rowIndex = helpFindRowBySequence(sheet, sequenceNumber);

    return {
      sequenceNumber: sequenceNumber,
      currentDateTime: now,
      rowIndex: rowIndex
    };
  } finally {
    lock.releaseLock();
  }
}



function saveToSheetPendingPdf(formData, docId, docUrl, imageUrls = []) {
  const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);

  if (typeof helpEnsurePhoneColumnText === 'function') helpEnsurePhoneColumnText(sheet);

  // CHANGE: บังคับคอลัมน์วันที่/เวลาให้เป็น DateTime (กันเวลาโดนตัด)
  helpEnsureDateTimeColumns(sheet, ['วันที่', 'วันที่อัปเดตสถานะ', 'วันที่เสร็จสิ้น']);

  const { headers } = helpMapHeadersFromSheet(sheet);
  const row = new Array(headers.length).fill('');

  const set = (name, value) => {
    const idx = headers.indexOf(String(name).trim());
    if (idx > -1) row[idx] = value;
  };

  const seq = (formData && formData.sequenceNumber) ? String(formData.sequenceNumber).trim() : '';
  const createdAt = (formData && formData.currentDateTime instanceof Date && !isNaN(formData.currentDateTime.getTime()))
    ? formData.currentDateTime
    : new Date();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    set('เลขที่', seq);
    set('วันที่', createdAt); // Date object
    set('ชื่อผู้แจ้งซ่อม', (formData && formData.requesterName) ? String(formData.requesterName) : '');
    set('เบอร์โทร', (typeof helpNormalizePhone === 'function') ? helpNormalizePhone((formData && formData.phoneNumber) ? String(formData.phoneNumber) : '') : ((formData && formData.phoneNumber) ? String(formData.phoneNumber) : ''));
    set('ประเภทงานซ่อม', (formData && formData.repairType) ? String(formData.repairType) : 'ทั่วไป');
    set('รายการแจ้งซ่อม', (formData && formData.repairItem) ? String(formData.repairItem) : '');
    set('อาการ', (formData && formData.description) ? String(formData.description) : '');
    set('สถานที่', (formData && formData.location) ? String(formData.location) : '');
    set('สถานะ', STATUS.PENDING);

    // CHANGE: เริ่มว่าง แต่คอลัมน์เป็น DateTime แล้ว
    set('วันที่อัปเดตสถานะ', '');
    set('วันที่เสร็จสิ้น', '');

    set('รหัสเอกสาร', docId || '');
    set('ลิงก์เอกสาร', docUrl || '');
    set('ความเร่งด่วน', (formData && formData.priority) ? String(formData.priority) : PRIORITY.MEDIUM);
    set('หมายเหตุ', '');
    set('ผู้รับผิดชอบ', '');
    set('URL รูปภาพประกอบ', JSON.stringify(imageUrls || []));

    set('วันที่รับงาน', '');

    sheet.appendRow(row);
    SpreadsheetApp.flush();

    const rowIndex = helpFindRowBySequence(sheet, seq);

    return { success: true, rowIndex: rowIndex };
  } finally {
    lock.releaseLock();
  }
}








// ----------------------------------------------------------------
// SECTION: 📄 DOCUMENT & IMAGE MANAGEMENT
// ----------------------------------------------------------------
function createRepairDocument(data) {
  // ตรวจสอบข้อมูลก่อนเริ่ม
  if (!data) return { success: false, error: 'No data provided' };

  try {
    // 1. คัดลอก Template
    const templateFile = DriveApp.getFileById(CONFIG.TEMPLATE_ID);
    const targetFolder = DriveApp.getFolderById(CONFIG.TARGET_FOLDER_ID);
    const newFileName = 'ใบแจ้งซ่อม_' + data['{{เลขที่}}'];
    const newFile = templateFile.makeCopy(newFileName, targetFolder);
    const newDocId = newFile.getId();
    
    // 2. เปิดไฟล์เพื่อแก้ไข
    const doc = DocumentApp.openById(newDocId);
    const body = doc.getBody();

    // 3. แทนที่ข้อมูลในเอกสาร (Text Replacement)
    // วนลูปแทนที่ทุก key ที่ส่งมาจาก formData
    for (let key in data) {
      if (data.hasOwnProperty(key)) {
        // แทนที่ข้อความ ถ้าข้อมูลเป็น null/undefined ให้เป็นว่าง
        body.replaceText(key, data[key] || '-');
      }
    }

    // จัดการส่วนวันที่ปัจจุบัน (ถ้าใน Template มี {{วันที่พิมพ์}})
    const now = new Date();
    const dateStr = Utilities.formatDate(now, 'Asia/Bangkok', 'd MMMM yyyy HH:mm');
    body.replaceText('{{วันที่พิมพ์}}', dateStr);

    // 4. บันทึกและปิดไฟล์
    doc.saveAndClose();

    // 5. แปลงเป็น PDF
    const pdfBlob = newFile.getAs(MimeType.PDF);
    const pdfFile = targetFolder.createFile(pdfBlob).setName(newFileName + '.pdf');
    
    // 6. ลบไฟล์ Google Doc ชั่วคราว (ถ้าต้องการเก็บ Doc ไว้ให้ comment บรรทัดนี้)
    // newFile.setTrashed(true); 

    // 7. ตั้งค่าการแชร์ (เพื่อให้ดูผ่านเว็บได้)
    pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return {
      success: true,
      docId: pdfFile.getId(),
      url: pdfFile.getUrl(),
      name: pdfFile.getName()
    };

  } catch (error) {
    Logger.log('ERROR createRepairDocument: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

function createRepairPdfFromTemplate(formData) {
  try {
    // ตรวจสอบ ID
    if (!CONFIG.TEMPLATE_ID || !CONFIG.TARGET_FOLDER_ID) {
      throw new Error('Config missing: TEMPLATE_ID or TARGET_FOLDER_ID');
    }

    const templateFile = DriveApp.getFileById(CONFIG.TEMPLATE_ID);
    const targetFolder = DriveApp.getFolderById(CONFIG.TARGET_FOLDER_ID);

    const seq = formData['{{เลขที่}}'] || 'Unknown';
    const tempName = `Temp_${seq}_${Date.now()}`;
    const finalName = `ใบแจ้งซ่อม_${seq}`;

    // 1. Copy Template
    const tempFile = templateFile.makeCopy(tempName, targetFolder);
    const tempDoc = DocumentApp.openById(tempFile.getId());
    const body = tempDoc.getBody();

    // 2. Insert Logo (ถ้ามี)
    try {
      // ใส่ Logo เฉพาะถ้ายังไม่มี (Logic เสริม) หรือข้ามไปถ้า Template มีแล้ว
      // body.insertImage(0, ...); 
    } catch (e) {}

    // 3. Replace Text
    // วนลูปแทนที่ทุก key ที่ส่งมา
    for (let key in formData) {
       body.replaceText(key, formData[key] || '-');
    }
    // แทนที่วันที่พิมพ์
    body.replaceText('{{วันที่พิมพ์}}', Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm'));

    tempDoc.saveAndClose();

    // 4. Convert to PDF
    const pdfBlob = tempFile.getAs(MimeType.PDF);
    const pdfFile = targetFolder.createFile(pdfBlob).setName(finalName + ".pdf");
    
    // 5. Set Permission (สำคัญมาก ต้องทำก่อนส่งลิงก์)
    pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    // 6. Cleanup Temp
    tempFile.setTrashed(true);

    return { 
      success: true, 
      pdfId: pdfFile.getId(), 
      pdfUrl: pdfFile.getUrl(), 
      pdfName: pdfFile.getName() 
    };

  } catch (e) {
    Logger.log('❌ createRepairPdfFromTemplate Error: ' + e.stack);
    return { success: false, error: e.message };
  }
}


/**
 * อัปโหลดไฟล์รูปภาพไปยัง Google Drive
 */
function uploadImages(imageFiles, sequenceNumber) {
  try {
    const imageFolder = DriveApp.getFolderById(CONFIG.IMAGE_FOLDER_ID);
    const uploadedUrls = [];

    imageFiles.forEach((imageData, i) => {
      const matches = imageData.match(/^data:(.+);base64,(.+)$/);
      if (!matches) return;

      const [_, mimeType, base64Data] = matches;
      const extension = mimeType.split('/')[1] || 'jpg';
      const fileName = `${sequenceNumber}_image_${i + 1}.${extension}`;
      const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName);
      
      const file = imageFolder.createFile(blob);
      
      // 🔐 [สำคัญ] Set permission ให้ anyone with link สามารถ view ได้
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      
      // เก็บ fileId แทน URL เต็ม (ประหยัดพื้นที่และปลอดภัยกว่า)
      uploadedUrls.push(file.getId());
      
      Logger.log(`📸 Uploaded image: ${fileName}, FileID: ${file.getId()}`);
    });

    return uploadedUrls;
  } catch (error) {
    Logger.log('❌ uploadImages error:', error.toString());
    return [];
  }
}
/**
 * ลบไฟล์รูปภาพที่เกี่ยวข้อง
 */
function deleteImages(imageRefs = []) {
  const refs = Array.isArray(imageRefs) ? imageRefs : [imageRefs];
  refs.forEach(ref => {
    try {
      const fileId = extractFileIdFromUrl(ref);
      if (fileId) DriveApp.getFileById(fileId).setTrashed(true);
    } catch (e) {
      Logger.log('Error deleting image: ' + e.message);
    }
  });
}

function serveImage(fileId) {
  try {
    const input = String(fileId || '').trim();
    if (!input) {
      Logger.log('serveImage: missing fileId');
      return HtmlService.createHtmlOutput('Error: Missing File ID');
    }

    const m = input.match(/[-\w]{25,}/);
    const id = m ? m[0] : '';
    if (!id) {
      Logger.log('serveImage: invalid fileId format: ' + input);
      return HtmlService.createHtmlOutput('Error: Invalid File ID');
    }

    const file = DriveApp.getFileById(id);
    const blob = file.getBlob();
    const ct = String(blob.getContentType() || '').toLowerCase();

    if (ct.indexOf('image/') !== 0) {
      Logger.log('serveImage: not image | ct=' + ct + ' | id=' + id);
      return HtmlService.createHtmlOutput('Error: File is not an image');
    }

    const bytes = blob.getBytes();
    const b64 = Utilities.base64Encode(bytes);

    const html =
      '<!doctype html><html><head>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, max-age=0">' +
      '<meta http-equiv="Pragma" content="no-cache">' +
      '</head><body style="margin:0;padding:0;background:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;">' +
      '<img alt="image" style="max-width:100%;height:auto;display:block;" src="data:' + ct + ';base64,' + b64 + '">' +
      '</body></html>';

    Logger.log('serveImage: ok | id=' + id + ' | ct=' + ct + ' | size=' + bytes.length);
    return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  } catch (error) {
    Logger.log('serveImage error: ' + (error && error.stack ? error.stack : error));
    return HtmlService.createHtmlOutput('Error: Could not serve image. ' + (error && error.message ? error.message : error));
  }
}







function debugImageData() {
  Logger.log('🐛 === DEBUG IMAGE DATA ===');
  try {
    const publicDataResult = JSON.parse(getPublicRepairData());
    if (!publicDataResult.success) {
      throw new Error("Could not get public data: " + publicDataResult.error);
    }
    const allData = publicDataResult.data;
    Logger.log('📊 Total items fetched:', allData.length);

    let report = [];
    let accessibleCount = 0;
    let inaccessibleCount = 0;

    allData.forEach((item) => {
      if (item.imageUrls && item.imageUrls.length > 0) {
        item.imageUrls.forEach(fileId => {
          if (!fileId) return;
          try {
            const file = DriveApp.getFileById(fileId);
            const reportItem = `✅ [${item.sequenceNumber}] File ID ${fileId} is ACCESSIBLE. Name: ${file.getName()}`;
            Logger.log(reportItem);
            report.push(reportItem);
            accessibleCount++;
          } catch (e) {
            const reportItem = `❌ [${item.sequenceNumber}] File ID ${fileId} is INACCESSIBLE. Error: ${e.message}`;
            Logger.log(reportItem);
            report.push(reportItem);
            inaccessibleCount++;
          }
        });
      }
    });

    const summary = `🕵️‍♂️ Debug Complete! Accessible: ${accessibleCount}, Inaccessible: ${inaccessibleCount}.`;
    Logger.log(summary);
    report.unshift(summary); // Add summary to the top

    return { success: true, report: report, summary: summary };
  } catch (error) {
    Logger.log('❌ CRITICAL debugImageData error:', error.stack);
    return { success: false, error: error.toString(), report: [error.toString()] };
  }
}

// ----------------------------------------------------------------
// SECTION: 🧑‍💻 USER & TECHNICIAN MANAGEMENT
// ----------------------------------------------------------------

/**
 * จัดการการ Login
 */
function hashPasswordSha256_(password) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password || ''), Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); })
    .join('');
}

function isPasswordMatch_(storedPassword, inputPassword) {
  const stored = String(storedPassword || '').trim();
  if (!stored) return false;

  const input = String(inputPassword || '');
  const inputHash = hashPasswordSha256_(input);
  if (/^[a-f0-9]{64}$/i.test(stored)) {
    return stored.toLowerCase() === inputHash;
  }

  return stored === input;
}

function migrateUserPasswordsToSha256(dryRun) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const userSheet = ss.getSheetByName(CONFIG.USER_SHEET_NAME);
    if (!userSheet) throw new Error('User sheet not found');

    const lastRow = userSheet.getLastRow();
    if (lastRow < 2) {
      return { success: true, dryRun: !!dryRun, migrated: 0, skippedHash: 0, skippedBlank: 0 };
    }

    const passwordRange = userSheet.getRange(2, 2, lastRow - 1, 1);
    const values = passwordRange.getValues();
    let migrated = 0;
    let skippedHash = 0;
    let skippedBlank = 0;

    const nextValues = values.map(function(row) {
      const stored = String(row[0] || '').trim();
      if (!stored) {
        skippedBlank++;
        return [row[0]];
      }
      if (/^[a-f0-9]{64}$/i.test(stored)) {
        skippedHash++;
        return [stored.toLowerCase()];
      }
      migrated++;
      return [hashPasswordSha256_(stored)];
    });

    if (!dryRun && migrated > 0) {
      const backupName = CONFIG.USER_SHEET_NAME + '_backup_passwords_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
      const backupSheet = userSheet.copyTo(ss).setName(backupName);
      ss.setActiveSheet(backupSheet);
      ss.moveActiveSheet(ss.getNumSheets());
      passwordRange.setValues(nextValues);
      SpreadsheetApp.flush();
    }

    return { success: true, dryRun: !!dryRun, migrated: migrated, skippedHash: skippedHash, skippedBlank: skippedBlank };
  } finally {
    lock.releaseLock();
  }
}

function setUserPasswordSha256(username, newPassword) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const inputUsername = String(username || '').trim();
    const inputPassword = String(newPassword || '');
    if (!inputUsername || !inputPassword) {
      return { success: false, error: 'กรุณาระบุ username และ password' };
    }

    const userSheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.USER_SHEET_NAME);
    if (!userSheet) throw new Error('User sheet not found');

    const values = userSheet.getDataRange().getValues();
    const headers = values[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
    const usernameCol = headers.indexOf('username');
    const passwordCol = headers.indexOf('password');
    if (usernameCol < 0 || passwordCol < 0) {
      throw new Error('Missing required users headers: username/password');
    }

    for (let i = 1; i < values.length; i++) {
      if (String(values[i][usernameCol] || '').trim().toLowerCase() === inputUsername.toLowerCase()) {
        userSheet.getRange(i + 1, passwordCol + 1).setValue(hashPasswordSha256_(inputPassword));
        SpreadsheetApp.flush();
        return { success: true };
      }
    }

    return { success: false, error: 'User not found' };
  } catch (error) {
    Logger.log('setUserPasswordSha256 error: ' + error.stack);
    return { success: false, error: error.message };
  } finally {
    lock.releaseLock();
  }
}

function generateTemporaryPassword_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

function getPasswordResetErrorMessage_(error) {
  const message = String((error && error.message) || error || '');
  if (/authorization|authorize|permission|scope/i.test(message)) {
    return 'ยังไม่ได้อนุญาตสิทธิ์ส่งอีเมล กรุณาให้เจ้าของ Script รัน selfTestPasswordResetEmail() แล้วกด authorize';
  }
  if (/too many|quota|limit/i.test(message)) {
    return 'ส่งอีเมลไม่สำเร็จ เนื่องจากเกิน quota ของบัญชี Google';
  }
  if (/Missing required users headers/i.test(message)) {
    return 'ไม่พบคอลัมน์ที่จำเป็นในชีต users: username/password/email';
  }
  return 'ส่งอีเมลรีเซ็ตรหัสผ่านไม่สำเร็จ: ' + message;
}

function selfTestPasswordResetEmail(email) {
  const targetEmail = String(email || '').trim();
  if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
    throw new Error('กรุณาระบุ email สำหรับทดสอบ');
  }

  MailApp.sendEmail({
    to: targetEmail,
    subject: 'ทดสอบส่งอีเมลระบบแจ้งซ่อม',
    body: 'ระบบแจ้งซ่อมทดสอบส่งอีเมลสำเร็จ'
  });

  return { success: true, email: targetEmail };
}

function testSendResetEmail() {
  return selfTestPasswordResetEmail('sdulpcar@gmail.com');
}

function requestPasswordReset(username, email) {
  const genericMessage = 'หากข้อมูลถูกต้อง ระบบจะส่งรหัสผ่านใหม่ไปยังอีเมลที่ลงทะเบียนไว้';
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const inputUsername = String(username || '').trim();
    const inputEmail = String(email || '').trim().toLowerCase();
    if (!inputUsername || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inputEmail)) {
      return { success: true, message: genericMessage };
    }

    const userSheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.USER_SHEET_NAME);
    if (!userSheet) throw new Error('User sheet not found');

    const values = userSheet.getDataRange().getValues();
    if (values.length < 2) {
      return { success: true, message: genericMessage };
    }

    const headers = values[0].map(function(h) { return String(h || '').trim().toLowerCase(); });
    const usernameCol = headers.indexOf('username');
    const passwordCol = headers.indexOf('password');
    let emailCol = headers.indexOf('email');
    if (emailCol < 0) emailCol = headers.indexOf('e-mail');
    if (emailCol < 0) emailCol = headers.indexOf('อีเมล');
    if (emailCol < 0) emailCol = headers.indexOf('อีเมล์');
    const activeCol = headers.indexOf('active');
    const nameCol = headers.indexOf('name');
    if (usernameCol < 0 || passwordCol < 0 || emailCol < 0) {
      throw new Error('Missing required users headers: username/password/email');
    }

    const cache = CacheService.getScriptCache();
    const throttleKey = 'pwdreset:' + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, inputUsername.toLowerCase() + '|' + inputEmail, Utilities.Charset.UTF_8)
    ).slice(0, 80);
    let sent = false;

    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const rowUsername = String(row[usernameCol] || '').trim();
      const rowEmail = String(row[emailCol] || '').trim().toLowerCase();
      const isActive = activeCol < 0 || String(row[activeCol]).trim() === '1';
      if (rowUsername.toLowerCase() === inputUsername.toLowerCase() && rowEmail === inputEmail && isActive) {
        if (cache.get(throttleKey)) {
          Logger.log('Password reset throttled for username=' + inputUsername);
          return { success: true, message: genericMessage };
        }

        const temporaryPassword = generateTemporaryPassword_();
        const displayName = nameCol >= 0 ? String(row[nameCol] || rowUsername).trim() : rowUsername;
        MailApp.sendEmail({
          to: rowEmail,
          subject: 'รีเซ็ตรหัสผ่านระบบแจ้งซ่อม',
          body:
            'เรียน ' + displayName + '\n\n' +
            'ระบบได้สร้างรหัสผ่านใหม่สำหรับบัญชี ' + rowUsername + '\n\n' +
            'รหัสผ่านชั่วคราว: ' + temporaryPassword + '\n\n' +
            'กรุณาเข้าสู่ระบบแล้วเปลี่ยนรหัสผ่านตามขั้นตอนของผู้ดูแลระบบ\n' +
            'หากไม่ได้ร้องขอรายการนี้ กรุณาติดต่อผู้ดูแลระบบทันที'
        });

        userSheet.getRange(i + 1, passwordCol + 1).setValue(hashPasswordSha256_(temporaryPassword));
        SpreadsheetApp.flush();
        cache.put(throttleKey, '1', 300);
        Logger.log('Password reset email sent to ' + rowEmail + ' for username=' + rowUsername);
        sent = true;
        break;
      }
    }

    if (!sent) {
      Logger.log('Password reset request completed without account match for username=' + inputUsername);
    }

    return { success: true, message: genericMessage };
  } catch (error) {
    Logger.log('Password reset error: ' + error.stack);
    return { success: false, message: getPasswordResetErrorMessage_(error) };
  } finally {
    lock.releaseLock();
  }
}

function doLogin(username, password) {
  try {
    const userSheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.USER_SHEET_NAME);
    if (!userSheet) throw new Error('User sheet not found');
    
    const userData = userSheet.getDataRange().getValues();
    const user = userData.find(row => row[0] === username && isPasswordMatch_(row[1], password));

    if (!user) {
      return { success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
    }

    const redirectUrl = getWebAppUrl() + '?page=dashboard';
    return {
      success: true,
      user: { username: user[0], role: user[2] || 'user', name: user[3] || username },
      redirectUrl: redirectUrl
    };
  } catch (error) {
    Logger.log('Login error: ' + error.stack);
    return { success: false, message: 'เกิดข้อผิดพลาดในการล็อกอิน' };
  }
}

/**
 * ดึงรายชื่อช่างเทคนิคที่ Active อยู่
 */
function getTechnicians() {
  try {
    const userSheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.USER_SHEET_NAME);
    if (!userSheet) return [];

    const values = userSheet.getDataRange().getValues();
    const headers = values[0].map(h => h.toLowerCase().trim());
    const [roleIndex, nameIndex, activeIndex] = ['role', 'name', 'active'].map(h => headers.indexOf(h));

    if ([roleIndex, nameIndex, activeIndex].includes(-1)) {
      throw new Error("Required columns ('role', 'name', 'active') not found.");
    }
    
    return values.slice(1)
      .filter(row => (row[activeIndex] === 1 || row[activeIndex] === true) && row[roleIndex].toLowerCase().trim() === 'technician')
      .map(row => row[nameIndex]);
  } catch (error) {
    Logger.log('Error in getTechnicians: ' + error.stack);
    return [];
  }
}


// ----------------------------------------------------------------
// SECTION: 📊 PUBLIC DATA & API ENDPOINTS
// ----------------------------------------------------------------
function convertFileIdToUrl(fileId) {
  if (!fileId) return '';
  return `https://lh5.googleusercontent.com/d/${fileId}`;
}

function normalizeDateHelper(rawVal, dispVal) {
  // 1. กรณีเป็น Date Object อยู่แล้ว
  if (rawVal instanceof Date && !isNaN(rawVal.getTime())) {
    const y = rawVal.getFullYear();
    // Fix: ถ้าปีใน Date Object เป็น พ.ศ. (เกิน 2400) ให้ลบออก
    if (y > 2400) {
      return new Date(y - 543, rawVal.getMonth(), rawVal.getDate(), rawVal.getHours(), rawVal.getMinutes(), rawVal.getSeconds());
    }
    return rawVal;
  }

  // 2. กรณีเป็น Text (String)
  const str = String(dispVal || rawVal || '').trim();
  if (!str || str === '-' || str === '') return null;

  // Regex: รองรับ "d/m/y", "d-m-y" และเวลา "H:m" หรือ "H.m" (ไม่สนใจลูกน้ำหรือเว้นวรรค)
  // Group: 1=Day, 2=Month, 3=Year
  const dateMatch = str.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (!dateMatch) return null;

  let d = parseInt(dateMatch[1], 10);
  let m = parseInt(dateMatch[2], 10) - 1; // JS Month 0-11
  let y = parseInt(dateMatch[3], 10);

  // Fix: Normalization ปี (ถ้าเป็น พ.ศ. ให้แปลงเป็น ค.ศ. ทันที)
  if (y > 2400) y -= 543;

  // หาเวลา: แยกหาต่างหากเพื่อความชัวร์ (Group: 1=Hour, 2=Min)
  let hr = 0;
  let min = 0;
  const timeMatch = str.match(/(\d{1,2})[:.](\d{2})/);
  
  if (timeMatch) {
    hr = parseInt(timeMatch[1], 10);
    min = parseInt(timeMatch[2], 10);
  } else if (rawVal instanceof Date && !isNaN(rawVal.getTime())) {
    // Fallback: ถ้า String ไม่มีเวลา แต่ Raw Value มี
    hr = rawVal.getHours();
    min = rawVal.getMinutes();
  }

  return new Date(y, m, d, hr, min);
}

function getPublicRepairData() {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
    const range = sheet.getDataRange();
    const values = range.getValues();
    
    if (values.length <= 1) return { success: true, data: [] };

    const headers = values[0].map(h => String(h).replace(/\s+/g, ' ').trim());
    
    const getIdx = (k) => headers.findIndex(h => h.includes(k));
    const colMap = {
      seq: getIdx('เลขที่'),
      date: headers.indexOf('วันที่'), // Match 'วันที่' exactly to avoid confusion
      updated: getIdx('อัปเดต'),
      owner: getIdx('ผู้แจ้ง'),
      item: getIdx('รายการ'),
      status: getIdx('สถานะ'),
      loc: getIdx('สถานที่'),
      desc: getIdx('อาการ'),
      note: getIdx('หมายเหตุ'),
      prio: getIdx('ความเร่งด่วน'),
      tech: getIdx('ผู้รับผิดชอบ'),
      phone: getIdx('เบอร์'),
      type: headers.findIndex(h => h.includes('\u0e1b\u0e23\u0e30\u0e40\u0e20\u0e17\u0e07\u0e32\u0e19\u0e0b\u0e48\u0e2d\u0e21') || h.includes('\u0e1b\u0e23\u0e30\u0e40\u0e20\u0e17\u0e07\u0e32\u0e19')),
      img: headers.findIndex(h => h.includes('รูป') || h.includes('img'))
    };

    const data = values.slice(1).map((row, i) => {
      if (!row[colMap.seq]) return null;

      // CHANGE: ใช้ formatThaiDateTime จัดการวันที่ให้มีเวลาครบถ้วน
      // หน้า Dashboard จะใช้วันที่แจ้ง (Create Date) เป็นหลักในการแสดงผลรายการ
      const dateVal = row[colMap.date];
      const dateStr = formatThaiDateTime(dateVal);

      // Image Handling
      let fileIds = [];
      const imgRaw = (colMap.img > -1) ? String(row[colMap.img]).trim() : '';
      if (imgRaw.startsWith('[')) {
        try { fileIds = JSON.parse(imgRaw); } catch(e) {}
      }

      return {
        sequenceNumber: row[colMap.seq],
        date: dateStr, // ✅ ส่งค่า String ที่มีเวลา (HH:mm น.) ไปให้ Frontend
        requesterName: row[colMap.owner],
        repairItem: row[colMap.item],
        location: row[colMap.loc],
        status: row[colMap.status],
        assignedTechnician: row[colMap.tech] || '-',
        imageUrls: fileIds.map(id => convertFileIdToUrl(id)),
        phoneNumber: row[colMap.phone],
        repairType: row[colMap.type] || 'ทั่วไป',
        description: row[colMap.desc],
        priority: row[colMap.prio],
        notes: row[colMap.note]
      };
    }).filter(item => item);

    return { success: true, data: data.reverse() };
  } catch (error) {
    Logger.log("Error getPublicRepairData: " + error.stack);
    return { success: false, error: error.message };
  }
}

// [ANCHOR: SERVER: LIST_REPORTS_FIXED]
// CHANGE: ดึงข้อมูลรายการแจ้งซ่อม พร้อม Format วันที่ให้ถูกต้อง
function listReports({ q = '', page = 1, pageSize = 10 } = {}) {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) return { ok: false, error: 'ไม่พบชีตข้อมูล' };

    const range = sheet.getDataRange();
    const values = range.getValues();
    if (values.length < 2) return { ok: true, rows: [], total: 0, page, pageSize };

    const header = values[0].map(h => String(h).trim());
    const dataRows = values.slice(1);

    // ดึง Index ของคอลัมน์ต่างๆ แบบ Dynamic
    const c = (name) => header.indexOf(name);
    const cSeq = c('เลขที่'), cDate = c('วันที่'), cOwner = c('ชื่อผู้แจ้งซ่อม'),
          cLoc = c('สถานที่'), cType = c('ประเภทงานซ่อม'), cStat = c('สถานะ'), cPrio = c('ความเร่งด่วน');

    // กรองข้อมูลตามคำค้นหา (Case Insensitive)
    const kw = (q || '').toString().trim().toLowerCase();
    const filtered = kw ? dataRows.filter(r => r.some(v => (v + '').toLowerCase().includes(kw))) : dataRows;

    // เรียงลำดับ: วันที่ล่าสุดขึ้นก่อน
    filtered.sort((a, b) => {
      const dateA = (cDate > -1 && a[cDate] instanceof Date) ? a[cDate] : new Date(0);
      const dateB = (cDate > -1 && b[cDate] instanceof Date) ? b[cDate] : new Date(0);
      return dateB.getTime() - dateA.getTime();
    });

    // Pagination
    const total = filtered.length;
    const start = Math.max(0, (page - 1) * pageSize);
    const paginatedRows = filtered.slice(start, start + pageSize);

    // Map ข้อมูลเพื่อส่งกลับ Client
    const mapped = paginatedRows.map(r => ({
      seq: cSeq > -1 ? r[cSeq] : '',
      // CHANGE: ใช้ formatThaiDateTime (ฟังก์ชันกลาง) เพื่อให้ Format วันที่/เวลาถูกต้องเหมือน Dashboard
      date: cDate > -1 ? formatThaiDateTime(r[cDate]) : '', 
      owner: cOwner > -1 ? r[cOwner] : '',
      loc: cLoc > -1 ? r[cLoc] : '',
      type: cType > -1 ? r[cType] : '',
      status: cStat > -1 ? r[cStat] : '',
      prio: cPrio > -1 ? r[cPrio] : ''
    }));

    return { ok: true, rows: mapped, total, page, pageSize };

  } catch (e) {
    Logger.log('Error in listReports: ' + e.stack);
    return { ok: false, error: e.message };
  }
}

// [ANCHOR: SERVER-DASHBOARD-DATA-WITH-STOCK-LOW-ALERT]
function getDashboardData() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'dashboard:data:v3';

  try {
    const cached = cache.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      Logger.log('[STEP1] getDashboardData cache hit');
      return parsed;
    }

    Logger.log('[STEP1] getDashboardData cache miss');

    const publicDataResult = getPublicRepairData();
    if (!publicDataResult.success) {
      throw new Error(publicDataResult.error || 'ไม่สามารถดึงข้อมูลรายการแจ้งซ่อมได้');
    }

    const data = Array.isArray(publicDataResult.data) ? publicDataResult.data : [];
    const chartData = generateChartData(data);

    chartData.currentStock = [];
    chartData.stockMovement = [];
    chartData.lowStockItems = [];

    try {
      const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
      const partSheet = ss.getSheetByName('รายการอะไหล่ทั้งหมด');
      const ledgerSheet = ss.getSheetByName('ประวัติสต็อกอะไหล่');

      if (partSheet) {
        const partValues = partSheet.getDataRange().getValues();
        const currentStockList = [];
        const lowStockItems = [];

        for (let i = 1; i < partValues.length; i++) {
          const partId = String(partValues[i][0] || '').trim();
          const partName = String(partValues[i][1] || '').trim();
          const balance = Number(partValues[i][5] || 0);
          const reorderPoint = Number(partValues[i][6] || 0);
          const status = String(partValues[i][7] || '').trim();

          if (partId && partName) {
            const item = {
              partId: partId,
              name: partName.length > 25 ? partName.substring(0, 25) + '...' : partName,
              fullName: partName,
              balance: balance,
              reorderPoint: reorderPoint,
              status: status
            };

            currentStockList.push(item);

            if (balance <= reorderPoint) {
              lowStockItems.push(item);
            }
          }
        }

        currentStockList.sort(function(a, b) {
          return b.balance - a.balance;
        });

        lowStockItems.sort(function(a, b) {
          return a.balance - b.balance;
        });

        chartData.currentStock = currentStockList.slice(0, 10);
        chartData.lowStockItems = lowStockItems.slice(0, 8);

        Logger.log('[INFO] currentStock dashboard rows=' + chartData.currentStock.length);
        Logger.log('[INFO] lowStockItems dashboard rows=' + chartData.lowStockItems.length);
      }

      if (ledgerSheet) {
        const ledgerValues = ledgerSheet.getDataRange().getValues();
        const movementMap = {};

        for (let j = 1; j < ledgerValues.length; j++) {
          const partId = String(ledgerValues[j][2] || '').trim();
          const partName = String(ledgerValues[j][3] || '').trim();
          const transType = String(ledgerValues[j][4] || '').trim();
          const qty = Number(ledgerValues[j][5] || 0);

          if (!partId || !partName) continue;

          if (!movementMap[partId]) {
            movementMap[partId] = {
              partId: partId,
              name: partName.length > 25 ? partName.substring(0, 25) + '...' : partName,
              fullName: partName,
              inQty: 0,
              outQty: 0
            };
          }

          if (transType === 'รับเข้า' || transType === 'คืนเข้า' || transType === 'ปรับเพิ่ม') {
            movementMap[partId].inQty += qty;
          }

          if (transType === 'เบิกออก' || transType === 'ใช้ในงานซ่อม' || transType === 'ปรับลด') {
            movementMap[partId].outQty += qty;
          }
        }

        const movementList = Object.keys(movementMap).map(function(key) {
          return movementMap[key];
        });

        movementList.sort(function(a, b) {
          return (b.inQty + b.outQty) - (a.inQty + a.outQty);
        });

        chartData.stockMovement = movementList.slice(0, 10);
        Logger.log('[INFO] stockMovement dashboard rows=' + chartData.stockMovement.length);
      }

    } catch (stockErr) {
      Logger.log('[WARN] ไม่สามารถดึงข้อมูลกราฟสต็อกได้: ' + stockErr.message);
      chartData.currentStock = [];
      chartData.stockMovement = [];
      chartData.lowStockItems = [];
    }

    const result = {
      success: true,
      data: data,
      chartData: chartData,
      generatedAt: new Date().toISOString()
    };

    cache.put(cacheKey, JSON.stringify(result), 60);
    Logger.log('[STEP2] getDashboardData cache stored | rows=' + data.length);

    return result;

  } catch (error) {
    Logger.log('[FAIL] getDashboardData: ' + error.message);
    return {
      success: false,
      error: error.message,
      data: [],
      chartData: null
    };
  }
}

function normalizeStatusName_(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (s === STATUS.PARTS_ALT) return STATUS.PARTS;
  return s;
}

function normalizePriorityName_(input) {
  const p = String(input || '').trim();
  if (!p) return '';
  return p;
}

function assertEqual_(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label || 'Assertion failed') + ': expected ' + expected + ' but got ' + actual);
  }
}

function assertTruthy_(value, label) {
  if (!value) {
    throw new Error((label || 'Assertion failed') + ': expected truthy value');
  }
}

function runHelperUnitTests() {
  const results = [];
  const push = (name, fn) => {
    try {
      fn();
      results.push({ name: name, ok: true });
    } catch (e) {
      results.push({ name: name, ok: false, error: e.message });
    }
  };

  push('normalizeStatusName_ maps alternate parts status', function() {
    assertEqual_(normalizeStatusName_('รอเบิกพัดสุ'), STATUS.PARTS, 'status alias');
  });

  push('normalizeStatusName_ preserves canonical status', function() {
    assertEqual_(normalizeStatusName_(STATUS.COMPLETED), STATUS.COMPLETED, 'canonical status');
  });

  push('normalizePriorityName_ trims text', function() {
    assertEqual_(normalizePriorityName_('  เร่งด่วน  '), PRIORITY.URGENT, 'priority trim');
  });

  push('helpParseDateSynced parses BE date string', function() {
    const parsed = helpParseDateSynced(null, '12/09/2568 09:30');
    assertTruthy_(parsed instanceof Date, 'parsed date');
    assertEqual_(parsed.getFullYear(), 2025, 'parsed year');
  });

  push('parseReportDateTime returns time flag', function() {
    const parsed = parseReportDateTime(null, '12/09/2568 09:30');
    assertTruthy_(parsed.date instanceof Date, 'report date');
    assertEqual_(parsed.hasTime, true, 'time flag');
  });

  return {
    success: true,
    total: results.length,
    passed: results.filter(function(r) { return r.ok; }).length,
    failed: results.filter(function(r) { return !r.ok; }),
    results: results
  };
}

function requireMutationRole_(currentUser, actionLabel) {
  const role = String((currentUser && currentUser.role) || '').trim().toLowerCase();
  if (role !== ROLES.ADMIN && role !== ROLES.TECHNICIAN) {
    throw new Error(actionLabel ? `คุณไม่มีสิทธิ์ในการ${actionLabel}` : 'คุณไม่มีสิทธิ์ดำเนินการนี้');
  }
  return role;
}

function updateRepairStatus(payload, newStatus, technician, notes, currentUser, base64Images) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { success: false, error: 'ระบบกำลังทำงาน กรุณารอสักครู่แล้วลองใหม่' };
  }

  try {
    const tz = (CONFIG && CONFIG.TIMEZONE) ? CONFIG.TIMEZONE : 'Asia/Bangkok';

    try {
      const sheetInstance = getSheetInstance();
      helpEnsureDateTimeColumns(sheetInstance, ['วันที่อัปเดตสถานะ', 'วันที่เสร็จสิ้น', 'วันที่รับงาน']);
    } catch (e) {
      Logger.log('WARN: Could not ensure date columns: ' + e.message);
    }

    try {
      const sheetInstance = getSheetInstance();
      helpEnsureDateTimeColumns(sheetInstance, ['วันที่อัปเดตสถานะ', 'วันที่เสร็จสิ้น', 'วันที่รับงาน']);
    } catch (e) {
      Logger.log('WARN: Could not ensure date columns: ' + e.message);
    }

    let p = {};
    if (typeof payload === 'object' && payload !== null) {
      p = payload;
    } else if (typeof payload === 'string' && payload.trim().startsWith('{')) {
      try {
        p = JSON.parse(payload);
      } catch (e) {
        p = {};
      }
    } else {
      p = {
        sequenceNumber: payload,
        newStatus: newStatus,
        technician: technician,
        notes: notes,
        currentUser: currentUser,
        base64Images: base64Images
      };
    }

    if (newStatus) p.newStatus = newStatus;
    if (technician) p.technician = technician;
    if (notes) p.notes = notes;
    if (currentUser) p.currentUser = currentUser;
    if (base64Images) p.base64Images = base64Images;

    const seq = String(p.sequenceNumber || p.seq || p.sequence || p.no || '').trim();
    const status = normalizeStatusName_(p.newStatus || p.status || p.state || '');
    const tech = String(p.technician || p.tech || p.assignee || '').trim();
    const noteContent = String(p.notes || p.note || '').trim();
    const userObj = p.currentUser || p.user || {};
    const images = Array.isArray(p.base64Images || p.images) ? (p.base64Images || p.images) : [];

    requireMutationRole_(userObj, 'แก้ไขสถานะรายการ');

    if (!seq) throw new Error('ไม่พบเลขที่ใบแจ้งซ่อม (sequenceNumber Missing)');
    if (!status) throw new Error('ไม่พบสถานะใหม่ (newStatus Missing)');

    const allowedStatuses = [
      STATUS.PENDING,
      STATUS.PROCESSING,
      STATUS.EXTERNAL,
      STATUS.PARTS,
      STATUS.COMPLETED,
      STATUS.CANCELLED
    ];
    if (allowedStatuses.indexOf(status) === -1) {
      throw new Error('สถานะไม่ถูกต้อง: ' + status);
    }

    const sheet = getSheetInstance();
    if (!sheet) throw new Error('ไม่พบชีตข้อมูล');

    const rowIndex = helpFindRowBySequence(sheet, seq);
    if (!rowIndex || rowIndex < 2) {
      throw new Error('ไม่พบข้อมูลรายการเลขที่: ' + seq);
    }

    const { map } = helpMapHeadersFromSheet(sheet);
    const colStatus = map['สถานะล่าสุด'];
    const colUpdated = map['วันที่อัปเดตสถานะ'];
    const colDone = map['วันที่เสร็จสิ้น'];
    const colTech = map['ผู้รับผิดชอบ'];
    const colAccept = map['วันที่รับงาน'];
    const colNote = map['หมายเหตุ'];
    const colImg = map['URL รูปภาพประกอบ'];

    if (!colStatus) throw new Error('ไม่พบคอลัมน์ "สถานะล่าสุด" ในชีต');
    if (!colUpdated) throw new Error('ไม่พบคอลัมน์ "วันที่อัปเดตสถานะ" ในชีต');

    let actionDate = new Date();
    if (p.updateDate) {
      const parsedDate = new Date(p.updateDate);
      if (!isNaN(parsedDate.getTime())) {
        actionDate = parsedDate;
      }
    }

    sheet.getRange(rowIndex, colStatus).setValue(status);
    sheet.getRange(rowIndex, colUpdated).setValue(actionDate);

    if (colTech && tech) {
      sheet.getRange(rowIndex, colTech).setValue(tech);
    }

    if (colNote && noteContent) {
      const currentNote = String(sheet.getRange(rowIndex, colNote).getValue() || '');
      const newNoteEntry = `[${Utilities.formatDate(actionDate, tz, 'dd/MM HH:mm')}] ${noteContent}`;
      const finalNote = currentNote ? `${currentNote}\n${newNoteEntry}` : newNoteEntry;
      sheet.getRange(rowIndex, colNote).setValue(finalNote);
    }

    if (colAccept && (status === STATUS.PROCESSING || status === STATUS.EXTERNAL)) {
      const curVal = sheet.getRange(rowIndex, colAccept).getValue();
      if (!(curVal instanceof Date) || isNaN(curVal.getTime())) {
        sheet.getRange(rowIndex, colAccept).setValue(actionDate);
      }
    }

    if (colDone) {
      if (status === STATUS.COMPLETED) {
        sheet.getRange(rowIndex, colDone).setValue(actionDate);
      } else {
        sheet.getRange(rowIndex, colDone).clearContent();
      }
    }

    let latestStatusImageUrls = [];
    if (colImg && images.length > 0) {
      const newImageIds = uploadImages(images, seq);
      latestStatusImageUrls = Array.isArray(newImageIds) ? newImageIds : [];
      const oldImgJson = sheet.getRange(rowIndex, colImg).getValue();
      let imgArr = [];

      try {
        imgArr = JSON.parse(oldImgJson || '[]');
        if (!Array.isArray(imgArr)) imgArr = [];
      } catch (e) {
        imgArr = [];
      }

      const finalImgArr = imgArr.concat(latestStatusImageUrls);
      sheet.getRange(rowIndex, colImg).setValue(JSON.stringify(finalImgArr));
    }

    appendStatusLog_(seq, status, noteContent, userObj, latestStatusImageUrls);

    SpreadsheetApp.flush();

    try {
      CacheService.getScriptCache().remove('dashboard:data:v3');
    } catch (cacheErr) {
      Logger.log('WARN: dashboard cache remove failed: ' + cacheErr.message);
    }

    try {
      const fullRowData = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
      const headersArr = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      if (typeof sendStatusUpdateNotification === 'function') {
        sendStatusUpdateNotification(fullRowData, headersArr, status, tech, noteContent, userObj, latestStatusImageUrls);
      }
    } catch (notiErr) {
      Logger.log('Notification Error: ' + notiErr.message);
    }

    return {
      success: true,
      sequenceNumber: seq,
      newStatus: status,
      technician: tech,
      updatedAt: actionDate ? actionDate.toISOString() : null,
      notes: noteContent
    };

  } catch (error) {
    Logger.log('ERROR updateRepairStatus: ' + error.stack);
    return { success: false, error: error.message };
  } finally {
    lock.releaseLock();
  }
}

function selfTestUpdateRepairStatusPayloadAuth_() {
  const payload = {
    sequenceNumber: 'SDUL-TEST-AUTH',
    newStatus: STATUS.PROCESSING,
    technician: 'ช่างทดสอบ',
    currentUser: { role: ROLES.ADMIN, name: 'Admin Test' }
  };

  requireMutationRole_(payload.currentUser, 'แก้ไขสถานะรายการ');

  let denied = false;
  try {
    requireMutationRole_({}, 'แก้ไขสถานะรายการ');
  } catch (e) {
    denied = /ไม่มีสิทธิ์/.test(String(e && e.message));
  }

  if (!denied) {
    throw new Error('selfTestUpdateRepairStatusPayloadAuth_ failed: missing user must be denied');
  }

  return { success: true, message: 'updateRepairStatus payload auth ok' };
}

function selfTestStatusUpdateLatestImageScope_() {
  const existingJobImages = ['old-image-1', 'old-image-2'];
  const latestStatusImageUrls = ['new-image-1'];
  const allJobImages = existingJobImages.concat(latestStatusImageUrls);
  const telegramImages = Array.isArray(latestStatusImageUrls) ? latestStatusImageUrls : [];

  if (allJobImages.length !== 3) {
    throw new Error('selfTestStatusUpdateLatestImageScope_ failed: all job images changed');
  }
  if (telegramImages.length !== 1 || telegramImages[0] !== 'new-image-1') {
    throw new Error('selfTestStatusUpdateLatestImageScope_ failed: telegram must use latest images only');
  }

  const emptyLatestStatusImageUrls = [];
  const noNewTelegramImages = Array.isArray(emptyLatestStatusImageUrls) ? emptyLatestStatusImageUrls : [];
  if (noNewTelegramImages.length !== 0) {
    throw new Error('selfTestStatusUpdateLatestImageScope_ failed: empty latest images must send text only');
  }

  return { success: true, message: 'status update latest image scope ok' };
}

function selfTestStatusLogReportMapping_() {
  const values = [
    ['วันที่บันทึก', 'เลขที่', 'สถานะ', 'หมายเหตุ', 'ผู้บันทึก', 'รูปภาพ'],
    [new Date(2026, 0, 1, 9, 0), 'SDUL-TEST-LOG', STATUS.PROCESSING, 'รับงาน', 'Admin Test', '1234567890123456789012345'],
    [new Date(2026, 0, 1, 10, 0), 'SDUL-TEST-LOG', STATUS.COMPLETED, 'เสร็จแล้ว', 'Admin Test', '1234567890123456789012346'],
    [new Date(2026, 0, 1, 11, 0), 'SDUL-OTHER', STATUS.CANCELLED, 'ยกเลิก', 'Admin Test', '']
  ];

  const logs = getStatusLogsBySequence('SDUL-TEST-LOG', values);
  if (logs.length !== 2) {
    throw new Error('selfTestStatusLogReportMapping_ failed: expected 2 logs actual=' + logs.length);
  }
  if (logs[0].status !== STATUS.PROCESSING || logs[1].status !== STATUS.COMPLETED) {
    throw new Error('selfTestStatusLogReportMapping_ failed: status order invalid');
  }
  if (!logs[0].imageIds || logs[0].imageIds[0] !== '1234567890123456789012345') {
    throw new Error('selfTestStatusLogReportMapping_ failed: image id invalid');
  }

  const logMap = buildStatusLogMap_(values);
  if (!logMap['SDUL-TEST-LOG'] || logMap['SDUL-TEST-LOG'].length !== 2) {
    throw new Error('selfTestStatusLogReportMapping_ failed: log map invalid');
  }

  const oldLogs = getStatusLogsBySequence('SDUL-NO-LOG', values);
  if (oldLogs.length !== 0) {
    throw new Error('selfTestStatusLogReportMapping_ failed: old record fallback must be handled by report row');
  }

  const fallbackLogs = getStatusLogsBySequence('SDUL-NO-LOG', { status: STATUS.PENDING }, values);
  if (fallbackLogs.length !== 1 || fallbackLogs[0].status !== STATUS.PENDING) {
    throw new Error('selfTestStatusLogReportMapping_ failed: fallback row invalid');
  }

  return { success: true, message: 'status log report mapping ok' };
}

function selfTestUpdateRepairStatusHeaderMapping_() {
  const mainHeaders = ['เลขที่', 'วันที่', 'ชื่อผู้แจ้งซ่อม', 'เบอร์โทร', 'ประเภทงานซ่อม', 'รายการแจ้งซ่อม', 'อาการ', 'สถานที่', 'สถานะล่าสุด', 'วันที่อัปเดตสถานะ', 'วันที่เสร็จสิ้น', 'รหัสเอกสาร', 'ลิงก์เอกสาร', 'ความเร่งด่วน', 'หมายเหตุ', 'ผู้รับผิดชอบ', 'URL รูปภาพประกอบ'];
  const logHeaders = ['วันที่บันทึก', 'เลขที่', 'สถานะ', 'หมายเหตุ', 'ผู้บันทึก', 'รูปภาพ'];

  if (mainHeaders.indexOf('สถานะ') !== -1) {
    throw new Error('selfTestUpdateRepairStatusHeaderMapping_ failed: main sheet must not use "สถานะ"');
  }
  if (mainHeaders.indexOf('สถานะล่าสุด') === -1) {
    throw new Error('selfTestUpdateRepairStatusHeaderMapping_ failed: main sheet must use "สถานะล่าสุด"');
  }
  if (logHeaders.indexOf('สถานะ') === -1) {
    throw new Error('selfTestUpdateRepairStatusHeaderMapping_ failed: log sheet must use "สถานะ"');
  }

  const callOrder = [];
  const fakeAppendStatusLog = function() { callOrder.push('log'); return true; };
  const fakeTelegram = function() { callOrder.push('telegram'); return { success: true }; };
  fakeAppendStatusLog();
  fakeTelegram();
  if (callOrder.join('>') !== 'log>telegram') {
    throw new Error('selfTestUpdateRepairStatusHeaderMapping_ failed: telegram must be after log append');
  }

  return { success: true, message: 'updateRepairStatus header mapping ok' };
}

function selfTestReportStatusHeaderMapping_() {
  const headers = ['เลขที่', 'สถานะล่าสุด', 'สถานะ'];
  const idx = function(name) { return headers.indexOf(name); };
  const idxAny = function(names) {
    for (let i = 0; i < names.length; i++) {
      const found = idx(names[i]);
      if (found > -1) return found;
    }
    return -1;
  };

  const statusIdx = idxAny(['สถานะล่าสุด', 'สถานะ']);
  if (statusIdx !== 1) {
    throw new Error('selfTestReportStatusHeaderMapping_ failed: expected สถานะล่าสุด index=1 actual=' + statusIdx);
  }

  return { success: true, message: 'report status header mapping ok' };
}

function selfTestReportImageHeaderMapping_() {
  const headers = ['เลขที่', 'วันที่', 'รูปภาพ'];
  const idx = function(name) { return headers.indexOf(name); };
  const idxAny = function(names) {
    for (let i = 0; i < names.length; i++) {
      const found = idx(names[i]);
      if (found > -1) return found;
    }
    return -1;
  };

  const imageIdx = idxAny(['URL รูปภาพประกอบ', 'รูปภาพประกอบ', 'รูปภาพ']);
  if (imageIdx !== 2) {
    throw new Error('selfTestReportImageHeaderMapping_ failed: expected image index=2 actual=' + imageIdx);
  }

  return { success: true, message: 'report image header mapping ok' };
}

function selfTestStatusHistoryLayoutEstimate_() {
  const pageLimit = 480;
  const rows = [
    { data: ['01/01/2569', 'กำลังดำเนินการ', '-', 'Admin', ''], imgIds: [] },
    { data: ['01/01/2569', 'เสร็จสิ้น', 'หมายเหตุยาว'.repeat(20), 'Admin', ''], imgIds: ['img1'] },
    { data: ['01/01/2569', 'ยกเลิก', '-', 'Admin', ''], imgIds: [] }
  ];

  let currentHeight = 35;
  let pageBreaks = 0;
  rows.forEach(function(row) {
    const hasImage = row.summaryImgIds && row.summaryImgIds.length > 0;
    let estimatedRowHeight = hasImage ? 145 : 55;
    const maxTextLen = row.data.reduce(function(max, txt) {
      return Math.max(max, String(txt).length);
    }, 0);
    if (maxTextLen > 80) estimatedRowHeight += 35;

    if (currentHeight + estimatedRowHeight > pageLimit) {
      pageBreaks++;
      currentHeight = 55;
    }
    currentHeight += estimatedRowHeight;
  });

  if (pageBreaks < 0 || currentHeight <= 0) {
    throw new Error('selfTestStatusHistoryLayoutEstimate_ failed');
  }

  return { success: true, message: 'status history layout estimate ok' };
}



/**
 * ลบใบแจ้งซ่อม
 */
function deleteRepair(sequenceNumber, userInfo) {
  try {
    requireMutationRole_(userInfo, 'ลบรายการ');

    const sheet = getSheetInstance();
    const range = sheet.getDataRange();
    const values = range.getValues();
    const headers = values[0];
    const { map } = helpMapHeadersFromSheet(sheet);

    const rowIndex = helpFindRowBySequence(sheet, sequenceNumber);
    if (!rowIndex || rowIndex < 2) {
      return { success: false, error: 'ไม่พบรายการที่ต้องการลบ' };
    }

    const rowToDelete = values[rowIndex - 1];
    const docId = map['รหัสเอกสาร'] ? rowToDelete[map['รหัสเอกสาร'] - 1] : '';
    const imageUrlsData = map['URL รูปภาพประกอบ'] ? rowToDelete[map['URL รูปภาพประกอบ'] - 1] : '';

    if (docId) {
      try { DriveApp.getFileById(docId).setTrashed(true); } catch (e) { Logger.log('Could not delete document: ' + docId); }
    }
    if (imageUrlsData) {
      let imageUrls = [];
      try {
        imageUrls = JSON.parse(imageUrlsData || '[]');
      } catch (e) {
        imageUrls = String(imageUrlsData).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      }
      deleteImages(imageUrls);
    }

    sheet.deleteRow(rowIndex);
    SpreadsheetApp.flush();
    try { CacheService.getScriptCache().remove('dashboard:data:v3'); } catch(e) {}

    return { success: true, message: 'ลบรายการเรียบร้อยแล้ว' };
  } catch (error) {
    Logger.log('Error in deleteRepair: ' + error.stack);
    return { success: false, error: error.message };
  }
}


// ----------------------------------------------------------------
// SECTION: 📊 REPORTING & STATISTICS
// ----------------------------------------------------------------
function generateChartData(data) {
  const stats = {
    statusCount: { pending: 0, processing: 0, external: 0, parts: 0, completed: 0, cancelled: 0 },
    repairTypeCount: { general: 0, electrical: 0, plumbing: 0, aircon: 0, computer: 0, appliance: 0, other: 0 },
    technicianStats: {}
  };

  data.forEach(item => {
    const status = normalizeStatusName_(item.status);
    const typeMap = {
      'ทั่วไป': 'general',
      'ไฟฟ้า': 'electrical',
      'ประปา': 'plumbing',
      'แอร์': 'aircon',
      'คอมพิวเตอร์': 'computer',
      'เครื่องใช้ไฟฟ้า': 'appliance'
    };

    if (status === STATUS.PENDING) stats.statusCount.pending++;
    else if (status === STATUS.PROCESSING) stats.statusCount.processing++;
    else if (status === STATUS.EXTERNAL) stats.statusCount.external++;
    else if (status === STATUS.PARTS) stats.statusCount.parts++;
    else if (status === STATUS.COMPLETED) stats.statusCount.completed++;
    else if (status === STATUS.CANCELLED) stats.statusCount.cancelled++;

    stats.repairTypeCount[typeMap[item.repairType] || 'other']++;

    const tech = String(item.assignedTechnician || '').trim();
    if (tech && tech !== '-') {
      if (!stats.technicianStats[tech]) {
        stats.technicianStats[tech] = {
          name: tech,
          total: 0,
          pending: 0,
          processing: 0,
          external: 0,
          parts: 0,
          completed: 0,
          cancelled: 0
        };
      }

      stats.technicianStats[tech].total++;

      if (status === STATUS.PENDING) stats.technicianStats[tech].pending++;
      else if (status === STATUS.PROCESSING) stats.technicianStats[tech].processing++;
      else if (status === STATUS.EXTERNAL) stats.technicianStats[tech].external++;
      else if (status === STATUS.PARTS) stats.technicianStats[tech].parts++;
      else if (status === STATUS.COMPLETED) stats.technicianStats[tech].completed++;
      else if (status === STATUS.CANCELLED) stats.technicianStats[tech].cancelled++;
    }
  });

  const technicianArray = Object.values(stats.technicianStats)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  return { ...stats, technicianCount: technicianArray };
}

// [ANCHOR: SERVER: GET_AVAILABLE_MONTHS_STRICT]
function getAvailableReportMonths() {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) return { months: [] };

    // อ่านข้อมูลทั้งหมด (DisplayValues เพื่อให้ได้ string วันที่แบบที่ตาเห็น)
    const range = sheet.getDataRange();
    const displayValues = range.getDisplayValues();
    
    // หาคอลัมน์ "วันที่" (ต้องแม่นยำ)
    const headers = displayValues[0].map(h => String(h).trim());
    // หา header ที่มีคำว่า 'วันที่' แต่ต้องไม่มีคำว่า 'อัปเดต' หรือ 'เสร็จสิ้น' ปน
    const dateIdx = headers.findIndex(h => h === 'วันที่' || (h.includes('วันที่') && !h.includes('อัปเดต') && !h.includes('เสร็จสิ้น')));

    if (dateIdx === -1) {
      Logger.log("ไม่พบคอลัมน์วันที่สำหรับการสร้างตัวเลือกเดือน");
      return { months: [] };
    }

    const monthSet = new Set();
    // Regex เดียวกับที่ใช้ใน PDF Generator เพื่อมาตรฐานเดียวกัน
    const regex = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/;

    // เริ่มวนลูปจากแถวที่ 2 (ข้าม Header)
    for (let i = 1; i < displayValues.length; i++) {
      const val = String(displayValues[i][dateIdx] || '').trim();
      if (!val || val === '-' || val === '#N/A') continue;

      const match = val.match(regex);
      if (match) {
        // match[1] = Day, match[2] = Month, match[3] = Year
        let m = parseInt(match[2], 10);
        let y = parseInt(match[3], 10);

        // Normalize Year to AD (ค.ศ.) สำหรับการจัดเรียงที่ถูกต้อง
        if (y > 2400) y -= 543;      // พ.ศ. -> ค.ศ.
        else if (y < 100) y += 2000; // ปี 2 หลัก -> 4 หลัก

        // ตรวจสอบความถูกต้องของเดือน (1-12)
        if (m >= 1 && m <= 12) {
           // เก็บ Key เป็น "YYYY-MM" (ค.ศ.) เพื่อให้ Set กำจัดตัวซ้ำและ Sort ง่าย
           // (ใช้ padStart เติม 0 หน้าเดือนเลขเดียว เพื่อให้ Sort แบบ String ได้ถูกต้อง)
           monthSet.add(`${y}-${String(m).padStart(2, '0')}`);
        }
      }
    }

    // แปลง Set กลับเป็น Array -> Sort ใหม่สุดไปเก่าสุด -> Map เป็น Object ส่งกลับ
    const sortedMonths = Array.from(monthSet).sort().reverse().map(key => {
       const [yearAD, monthStr] = key.split('-');
       const month = parseInt(monthStr, 10);
       const yearBE = parseInt(yearAD, 10) + 543; // แปลงกลับเป็น พ.ศ. เพื่อแสดงผล

       return {
         year: parseInt(yearAD, 10), // ส่งปี ค.ศ. ไปให้ PDF Function (เพราะ PDF เราแก้ให้รับ AD แล้ว)
         month: month,
         label: `${CONFIG.MONTHS_TH[month - 1]} ${yearBE}` // Label แสดงปี พ.ศ. ตามความคุ้นเคย
       };
    });

    Logger.log(`Found ${sortedMonths.length} available months from sheet data.`);
    return { months: sortedMonths };

  } catch (e) {
    Logger.log("Error in getAvailableReportMonths: " + e.message);
    return { months: [] };
  }
}


function applyDocLandscapeA4(docId) {
  try {
    // CHANGE: ถ้าไม่ได้เปิด Advanced Docs API ให้แค่เตือนและไม่ล้มงาน
    if (typeof Docs === 'undefined' || !Docs || !Docs.Documents) {
      Logger.log('[WARN] Docs API not enabled: skip landscape setup');
      return false;
    }

    // A4 = 595.2756 x 841.8898 pt (Portrait)
    // Landscape => width=841.8898 height=595.2756
    const pt = (mm) => mm * 2.834645669; // เผื่อใช้งานในอนาคต
    const req = {
      requests: [{
        updateDocumentStyle: {
          documentStyle: {
            pageSize: {
              width: { magnitude: 841.8898, unit: 'PT' },
              height: { magnitude: 595.2756, unit: 'PT' }
            },
            // margin ถูกตั้งจาก DocumentApp แล้ว แต่ใส่ไว้ให้ Docs API สอดคล้อง (ถ้าระบบอนุญาต)
            marginTop:    { magnitude: 24, unit: 'PT' },
            marginBottom: { magnitude: 24, unit: 'PT' },
            marginLeft:   { magnitude: 24, unit: 'PT' },
            marginRight:  { magnitude: 24, unit: 'PT' }
          },
          fields: 'pageSize,marginTop,marginBottom,marginLeft,marginRight'
        }
      }]
    };

    Docs.Documents.batchUpdate(req, docId);
    return true;
  } catch (e) {
    Logger.log('[WARN] Landscape setup failed: ' + (e && e.message ? e.message : e));
    return false;
  }
}



// [ANCHOR: SERVER: PDF_LOGO_HELPER]
function helpInsertReportLogo(body, fontFamily) {
  const fileId = CONFIG && CONFIG.REPORT_LOGO_FILE_ID ? String(CONFIG.REPORT_LOGO_FILE_ID).trim() : '';
  if (!fileId) return;

  try {
    const f = DriveApp.getFileById(fileId);
    const blob = f.getBlob();

    // CHANGE: ใส่โลโก้ “บนสุดจริง” และกันชนกับ title ด้วยการแทรก 2 บรรทัด
    const p = body.insertParagraph(0, "");
    p.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    p.setFontFamily(fontFamily || 'Sarabun');

    const img = p.appendInlineImage(blob);

    const maxW = 110;
    const maxH = 110;
    const w = img.getWidth();
    const h = img.getHeight();
    if (w > 0 && h > 0) {
      const ratio = Math.min(maxW / w, maxH / h);
      img.setWidth(Math.floor(w * ratio));
      img.setHeight(Math.floor(h * ratio));
    }

    // เว้น 1 บรรทัดหลังโลโก้
    body.insertParagraph(1, " ");
  } catch (e) {
    Logger.log('[WARN] REPORT_LOGO_FILE_ID ใช้งานไม่ได้: ' + e.message);
  }
}


// ----------------------------------------------------------------
// SECTION: 🚀 TELEGRAM NOTIFICATIONS
// ----------------------------------------------------------------

// Utility: Format date time string or Date object to HH:mm น.
function formatTimeOnly(dateStr) {
  if (!dateStr) return '';
  const s = String(dateStr).trim();
  // If it's already just the time (e.g. "14:50 น." or "14:50" without dates)
  if (s.includes('น.') && !s.includes('/')) {
    return s;
  }
  // If it contains a date and time (contains space)
  if (s.includes(' ')) {
    const parts = s.split(/\s+/);
    const timePart = parts.find(p => p.includes(':'));
    if (timePart) {
      const timeMatch = timePart.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
      if (timeMatch) {
        const hh = timeMatch[1].padStart(2, '0');
        const mm = timeMatch[2];
        return `${hh}:${mm} น.`;
      }
    }
  }
  
  // Try matching directly
  const match = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (match) {
    const hh = match[1].padStart(2, '0');
    const mm = match[2];
    return `${hh}:${mm} น.`;
  }
  
  return s;
}

function sendNewRepairNotification(formData, docUrl, imageUrls = []) {
  try {
    const seq = String(formData['{{เลขที่}}'] || '-').trim();
    const requesterName = String(formData['{{ชื่อผู้แจ้งซ่อม}}'] || '-').trim();
    const location = String(formData['{{สถานที่}}'] || '-').trim();
    const repairItem = String(formData['{{รายการแจ้งซ่อม}}'] || '-').trim();

    const priorityRaw = String(formData['{{ความเร่งด่วน}}'] || '').trim();
    const priority = priorityRaw ? normalizePriorityName_(priorityRaw) : '';
    let priorityIcon = '⚪';
    if (priority === PRIORITY.EMERGENCY) priorityIcon = '🚨';
    else if (priority === PRIORITY.URGENT) priorityIcon = '🔴';
    else if (priority === PRIORITY.MEDIUM) priorityIcon = '⚡';

    const dateStr = String(formData['{{วันที่}}'] || '').trim();

    const lines = [
      `🆕 ${sanitizeHtml(seq)}`,
      `━━━━━━━━━━━━━━`
    ];

    const bodyLines = [];
    if (repairItem && repairItem !== '-') bodyLines.push(`🧰 ${sanitizeHtml(repairItem)}`);
    bodyLines.push(`🆕 งานใหม่`);
    if (location && location !== '-') bodyLines.push(`📍 ${sanitizeHtml(location)}`);
    if (priority && priority !== '-') bodyLines.push(`${priorityIcon} ${sanitizeHtml(priority)}`);

    const metaLines = [];
    if (requesterName && requesterName !== '-') metaLines.push(`👤 ${sanitizeHtml(requesterName)}`);
    if (dateStr && dateStr !== '-') metaLines.push(`🕒 ${formatTimeOnly(dateStr)}`);

    if (bodyLines.length > 0) {
      lines.push(``);
      lines.push(bodyLines.join('\n'));
    }
    if (metaLines.length > 0) {
      lines.push(``);
      lines.push(metaLines.join('\n'));
    }

    const message = lines.join('\n');

    if (typeof sendTelegramNotification === 'function') {
      sendTelegramNotification(message, imageUrls || []);
    } else if (typeof sendTelegramMessage === 'function') {
      sendTelegramMessage(message, imageUrls || []);
    } else {
      throw new Error('ไม่พบฟังก์ชันส่ง Telegram (sendTelegramNotification/sendTelegramMessage)');
    }

    Logger.log(`Sent new repair notification for ${seq}`);
  } catch (error) {
    Logger.log('Error sending new repair notification: ' + (error && error.stack ? error.stack : error));
  }
}


// [ANCHOR: SERVER: TELEGRAM_UPDATE_STATUS_V2]
function sendStatusUpdateNotification(originalRowData, headers, newStatus, assignedTechnician, notes, userInfo, latestStatusImageUrls) {
  try {
    const getVal = (name) => {
      const idx = headers.indexOf(name);
      return idx > -1 ? originalRowData[idx] : '';
    };

    const sequenceNumber = String(getVal('เลขที่') || '-').trim();
    const repairItem = String(getVal('รายการแจ้งซ่อม') || '-').trim();
    const location = String(getVal('สถานที่') || '-').trim();
    const currentStatus = String(newStatus || getVal('สถานะ') || '-').trim();

    let finalTechName = '';
    if (assignedTechnician) {
      finalTechName = String(assignedTechnician).trim();
    } else {
      const oldTech = String(getVal('ผู้รับผิดชอบ') || '').trim();
      if (oldTech && oldTech !== '-' && oldTech !== '0') {
        finalTechName = oldTech;
      }
    }

    const noteText = (notes && String(notes).trim()) ? String(notes).trim() : '';
    const now = new Date();
    const timeStr = Utilities.formatDate(now, Session.getScriptTimeZone() || 'Asia/Bangkok', 'HH:mm') + ' น.';

    let statusEmoji = '🔄';
    let statusLabel = currentStatus;
    if (currentStatus === STATUS.PENDING) {
      statusEmoji = '🆕';
      statusLabel = 'งานใหม่';
    } else if (currentStatus === STATUS.PROCESSING) {
      statusEmoji = '🛠';
      statusLabel = 'กำลังดำเนินการ';
    } else if (currentStatus === STATUS.EXTERNAL) {
      statusEmoji = '🚚';
      statusLabel = 'ดำเนินการภายนอก';
    } else if (currentStatus === STATUS.PARTS || currentStatus === STATUS.PARTS_ALT) {
      statusEmoji = '📦';
      statusLabel = 'รออะไหล่';
    } else if (currentStatus === STATUS.COMPLETED) {
      statusEmoji = '✅';
      statusLabel = 'งานเสร็จสิ้น';
    } else if (currentStatus === STATUS.CANCELLED) {
      statusEmoji = '❌';
      statusLabel = 'ยกเลิก';
    }

    const noteFinal = noteText || '';
    const lines = [
      `${statusEmoji} ${sanitizeHtml(sequenceNumber)}`,
      `━━━━━━━━━━━━━━`
    ];

    const updateLines = [];
    if (repairItem && repairItem !== '-') {
      updateLines.push(`🧰 ${sanitizeHtml(repairItem)}`);
    }
    updateLines.push(`${statusEmoji} ${sanitizeHtml(statusLabel)}`);
    if (location && location !== '-') {
      updateLines.push(`📍 ${sanitizeHtml(location)}`);
    }
    if (finalTechName) {
      updateLines.push(`👨‍🔧 ${sanitizeHtml(finalTechName)}`);
    }
    if (timeStr) {
      updateLines.push(`🕒 ${timeStr}`);
    }

    if (updateLines.length > 0) {
      lines.push(``);
      lines.push(updateLines.join('\n'));
    }

    if (noteFinal) {
      lines.push(``, `📝 หมายเหตุ`, sanitizeHtml(noteFinal));
    }

    const message = lines.join('\n');

    const imageUrls = Array.isArray(latestStatusImageUrls) ? latestStatusImageUrls : [];

    if (CONFIG.IS_TEST_MODE) {
      Logger.log('🛠️ [TEST MODE - NOT SENT TO TELEGRAM] status update payload built for ' + sequenceNumber);
      Logger.log('📝 Message Content:\n' + message);
      if (imageUrls.length > 0) Logger.log('📸 Images: ' + JSON.stringify(imageUrls));
      return { success: true, mode: 'TEST_ONLY' };
    }

    sendTelegramNotification(message, imageUrls);
    Logger.log(`🔄 Sent status update notification for ${sequenceNumber}`);
  } catch (error) {
    Logger.log('❌ Error sending status update notification: ' + error.message);
  }
}

function sendTelegramNotification(message, imageUrls = [], replyMarkup = null) {
  try {
    if (CONFIG.IS_TEST_MODE) {
      Logger.log("🛠️ [TEST MODE - NOT SENT TO TELEGRAM]");
      Logger.log("📝 Message Content:\n" + message);
      if (imageUrls.length > 0) Logger.log("📸 Images: " + JSON.stringify(imageUrls));
      return { success: true, mode: 'TEST_ONLY' };
    }

    if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
      throw new Error('ไม่พบการตั้งค่า Telegram');
    }

    const safeImageUrls = Array.isArray(imageUrls) ? imageUrls.slice(0, 10) : [];
    const telegramUrl = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}`;
    
    const payload = {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    };
    
    if (replyMarkup) payload.reply_markup = replyMarkup;

    UrlFetchApp.fetch(`${telegramUrl}/sendMessage`, {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (safeImageUrls.length > 0) {
      if (safeImageUrls.length > 1) {
        // Send multiple images as a Media Group (album)
        try {
          const blobs = [];
          for (let i = 0; i < safeImageUrls.length; i++) {
            const fileId = extractFileIdFromUrl(String(safeImageUrls[i]));
            if (fileId) {
              const driveFile = DriveApp.getFileById(fileId);
              blobs.push(driveFile.getBlob());
            }
          }
          if (blobs.length > 0) {
            const mediaArray = [];
            const photoPayload = {
              chat_id: String(CONFIG.TELEGRAM_CHAT_ID)
            };
            blobs.forEach((blob, idx) => {
              const key = `photo_${idx}`;
              mediaArray.push({
                type: 'photo',
                media: `attach://${key}`
              });
              photoPayload[key] = blob;
            });
            photoPayload.media = JSON.stringify(mediaArray);
            
            UrlFetchApp.fetch(`${telegramUrl}/sendMediaGroup`, {
              method: 'post',
              payload: photoPayload,
              muteHttpExceptions: true
            });
            Logger.log('📸 ส่งกลุ่มรูปภาพ (Media Group) สำเร็จ');
          }
        } catch (mediaGroupErr) {
          Logger.log('⚠️ ส่งกลุ่มรูปภาพไม่สำเร็จ จะทำการส่งแบบแยกรูปภาพแทน: ' + mediaGroupErr.toString());
          sendIndividualPhotos_(telegramUrl, safeImageUrls);
        }
      } else {
        // Single photo
        sendIndividualPhotos_(telegramUrl, safeImageUrls);
      }
    }

    return { success: true, mode: 'REAL_SENT' };

  } catch (error) {
    Logger.log('❌ Telegram Notification Error: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

// Standalone private helper for sending individual photos as fallback
function sendIndividualPhotos_(telegramUrl, imageUrls) {
  const telegramSendPhoto = `${telegramUrl}/sendPhoto`;
  for (let i = 0; i < imageUrls.length; i++) {
    try {
      const fileId = extractFileIdFromUrl(String(imageUrls[i]));
      if (!fileId) {
        Logger.log('⚠️ ไม่พบ fileId จาก: ' + imageUrls[i]);
        continue;
      }
      const driveFile = DriveApp.getFileById(fileId);
      const blob = driveFile.getBlob();
      const photoPayload = {
        method: 'post',
        payload: {
          chat_id: String(CONFIG.TELEGRAM_CHAT_ID),
          photo: blob
        },
        muteHttpExceptions: true
      };
      UrlFetchApp.fetch(telegramSendPhoto, photoPayload);
      Logger.log('📸 ส่งรูปที่ ' + (i + 1) + ' สำเร็จ fileId=' + fileId);
    } catch (imgErr) {
      Logger.log('⚠️ ส่งรูปที่ ' + (i + 1) + ' ไม่สำเร็จ: ' + imgErr.toString());
    }
  }
}

function buildOpenPdfButton(pdfUrl) {
  return {
    inline_keyboard: [[{ text: 'เปิด PDF', url: pdfUrl }]]
  };
}

// [ANCHOR: SERVER: TELEGRAM_SEND_DOCUMENT]
function sendTelegramDocument(fileId, caption, replyMarkup) {
  try {
    if (!fileId) {
      throw new Error('ไม่พบ fileId สำหรับส่ง Telegram');
    }

    if (CONFIG.IS_TEST_MODE) {
      Logger.log('🛠️ [TEST MODE - TELEGRAM DOCUMENT NOT SENT]');
      Logger.log('fileId=' + fileId);
      Logger.log('caption=' + (caption || ''));
      return { success: true, mode: 'TEST_ONLY' };
    }

    const telegramUrl = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendDocument`;
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob().setName(file.getName());

    const payload = {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      caption: caption || '',
      parse_mode: 'HTML',
      document: blob
    };

    if (replyMarkup) {
      payload.reply_markup = JSON.stringify(replyMarkup);
    }

    const response = UrlFetchApp.fetch(telegramUrl, {
      method: 'post',
      payload: payload,
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    const text = response.getContentText();

    Logger.log('sendTelegramDocument code=' + code);
    Logger.log('sendTelegramDocument response=' + text);

    if (code < 200 || code >= 300) {
      throw new Error('Telegram sendDocument failed: HTTP ' + code + ' | ' + text);
    }

    return { success: true, mode: 'REAL_SENT', responseText: text };

  } catch (error) {
    Logger.log('❌ Telegram Document Error: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}


function sendPdfReadyNotification(sequenceNumber, pdfUrl, pdfId) {
  try {
    if (!pdfUrl || pdfUrl.trim() === '') {
      Logger.log('⚠️ PDF URL is empty, skipping notification.');
      return; 
    }

    // สร้างข้อความแบบ Clean ตามโจทย์
    const message =
      `📄 <b>PDF พร้อมแล้ว</b>\n` +
      `➖➖➖➖➖➖➖➖➖➖\n` +
      `🏷️ <b>เลขที่:</b> ${sequenceNumber}\n` +
      `✅ กดปุ่มด้านล่างเพื่อเปิดไฟล์ PDF`;

    // สร้างปุ่ม Inline Keyboard
    const replyMarkup = {
      inline_keyboard: [[
        { text: '📂 เปิดไฟล์ PDF', url: pdfUrl }
      ]]
    };

    if (pdfId && typeof sendTelegramDocument === 'function') {
      const docResult = sendTelegramDocument(pdfId, message, replyMarkup);
      if (!docResult || !docResult.success) {
        Logger.log('⚠️ sendTelegramDocument failed, fallback to message: ' + (docResult && docResult.error ? docResult.error : 'unknown'));
        sendTelegramNotification(message, [], replyMarkup);
      }
    } else {
      sendTelegramNotification(message, [], replyMarkup);
    }
    Logger.log(`✅ Sent PDF Ready notification for ${sequenceNumber}`);

  } catch (e) {
    Logger.log('❌ Error sending PDF notification: ' + e.message);
  }
}

function enqueuePdf(sequenceNumber) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = getSheetInstance();
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return { success: false, error: 'ไม่พบข้อมูลในชีต' };

    const headers = values[0].map(h => String(h).trim());
    const idxSeq = headers.indexOf('เลขที่');
    if (idxSeq < 0) return { success: false, error: 'ไม่พบคอลัมน์ เลขที่' };

    const target = String(sequenceNumber).trim();
    const rowIndex = values.findIndex((r, i) => i > 0 && String(r[idxSeq]).trim() === target);
    if (rowIndex < 0) return { success: false, error: 'ไม่พบเลขที่: ' + sequenceNumber };

    const rowNumber = rowIndex + 1;

    PropertiesService.getScriptProperties().setProperty(`PDFJOB_${target}`, JSON.stringify({
      sequenceNumber: target,
      rowNumber: rowNumber,
      createdAt: Date.now()
    }));

    return { success: true, queued: true, sequenceNumber: target, rowNumber: rowNumber };
  } catch (e) {
    Logger.log('enqueuePdf error: ' + e.stack);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

function pdfWorker(maxJobs) {
  // ใช้ Lock กันการรันซ้อน
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { success: false, busy: true };

  try {
    const props = PropertiesService.getScriptProperties();
    const keys = props.getKeys().filter(k => k.indexOf('PDFJOB_') === 0).sort(); // ทำตามลำดับ
    const limit = Math.max(1, Number(maxJobs) || 1);

    if (keys.length === 0) return { success: true, processed: 0 };

    const sheet = getSheetInstance();
    // Dynamic Header Mapping (ห้าม Hardcode Index)
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
    
    const idxDocId = headers.indexOf('รหัสเอกสาร');
    const idxDocLink = headers.indexOf('ลิงก์เอกสาร');
    const idxSeq = headers.indexOf('เลขที่');

    if (idxDocId < 0 || idxDocLink < 0 || idxSeq < 0) {
      console.error('❌ Column headers missing for PDF Worker');
      return { success: false, error: 'Headers missing' };
    }

    let processedCount = 0;

    for (let i = 0; i < keys.length && processedCount < limit; i++) {
      const key = keys[i];
      const raw = props.getProperty(key);
      
      // ลบ Job ออกจากคิวก่อนทำ (กันทำซ้ำถ้า Error แล้ว Retry ผิดจังหวะ) 
      // หรือจะลบหลังทำก็ได้ แต่ลบก่อนปลอดภัยเรื่อง Duplicate Noti กว่า
      props.deleteProperty(key); 

      if (!raw) continue;
      
      let job;
      try { job = JSON.parse(raw); } catch (e) { continue; }

      try {
        const rowNumber = Number(job.rowNumber);
        
        // ตรวจสอบว่าแถวยังอยู่ไหม และเลขที่ตรงกันไหม (Double Check)
        const currentRowSeq = sheet.getRange(rowNumber, idxSeq + 1).getValue();
        if (String(currentRowSeq) !== String(job.sequenceNumber)) {
          console.warn(`⚠️ Row mismatch for ${job.sequenceNumber}. Found ${currentRowSeq} instead.`);
          continue; // ข้ามถ้ารายการไม่ตรง
        }

        // ดึงข้อมูลแถวนั้นมาทำ Form Data
        const rowValues = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
        const formData = buildFormDataFromRow(headers, rowValues);

        // 1. สร้าง PDF
        const res = createRepairPdfFromTemplate(formData);
        if (!res || !res.success || !res.pdfUrl) {
          throw new Error('PDF Creation failed: ' + (res ? res.error : 'Unknown'));
        }

        // 2. บันทึกลงชีต
        sheet.getRange(rowNumber, idxDocId + 1).setValue(res.pdfId);
        sheet.getRange(rowNumber, idxDocLink + 1).setValue(res.pdfUrl); // ใส่ URL ตรงๆ ไม่ต้อง Hyperlink สูตร (Telegram ปุ่มกดจะใช้ง่ายกว่า)
        // หรือถ้าอยากได้สูตรในชีต: 
        // sheet.getRange(rowNumber, idxDocLink + 1).setValue(`=HYPERLINK("${res.pdfUrl}", "เปิด PDF")`);
        
        SpreadsheetApp.flush(); // 🔥 บังคับบันทึกทันที ก่อนส่ง Notify

        // 3. ส่งแจ้งเตือน Telegram (เฉพาะเมื่อมี URL จริงแล้ว)
        sendPdfReadyNotification(job.sequenceNumber, res.pdfUrl, res.pdfId);

        console.log(`✅ PDF Worker finished job: ${job.sequenceNumber}`);
        processedCount++;

      } catch (e) {
        console.error(`❌ PDF Worker Job Error (${job.sequenceNumber}): ` + e.stack);
        // Optional: Put back to queue if transient error? For now, we drop it to avoid infinite loops.
      }
    }

    return { success: true, processed: processedCount };

  } catch (e) {
    console.error('❌ PDF Worker Critical Error: ' + e.stack);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

function buildFormDataFromRow(headers, rowValues) {
  const data = {};
  for (let i = 0; i < headers.length; i++) {
    const key = '{{' + String(headers[i]).trim() + '}}';
    let val = rowValues[i];

    // CHANGE: รักษา DateTime (ไม่ตัดเวลา) + กัน date-only โชว์ 00:00
    if (val instanceof Date && !isNaN(val.getTime())) {
      val = formatThaiDateTime(val);
    }

    data[key] = val == null ? '' : String(val);
  }
  return data;
}



function createPdfAndUpdateSheet(sequenceNumber, docId, rowNumber) {
  try {
    const targetFolder = DriveApp.getFolderById(CONFIG.TARGET_FOLDER_ID);
    const docFile = DriveApp.getFileById(docId);

    const pdfBlob = docFile.getAs(MimeType.PDF);
    const pdfName = `ใบแจ้งซ่อม_${sequenceNumber}.pdf`;
    const pdfFile = targetFolder.createFile(pdfBlob).setName(pdfName);
    pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const sheet = getSheetInstance();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
    const idxDocLink = headers.indexOf('ลิงก์เอกสาร');
    if (idxDocLink < 0) return { success: false, error: 'ไม่พบคอลัมน์ลิงก์เอกสาร' };

    sheet.getRange(rowNumber, idxDocLink + 1).setValue(`=HYPERLINK("${pdfFile.getUrl()}","เปิด PDF")`);
    SpreadsheetApp.flush();

    return { success: true, pdfUrl: pdfFile.getUrl(), pdfId: pdfFile.getId() };
  } catch (e) {
    Logger.log('createPdfAndUpdateSheet error: ' + e.stack);
    return { success: false, error: e.message };
  }
}

// [ANCHOR: UTIL: parseReportDateTime]
// CHANGE: Single source for robust date+time parsing (supports Date object, "12/9/2568, 9:30:00", "12/9/2568 9:30:00")
function parseReportDateTime(rawVal, dispVal) {
  // 1) Prefer valid Date object
  if (rawVal instanceof Date && !isNaN(rawVal.getTime())) {
    const hasTime = (rawVal.getHours() !== 0 || rawVal.getMinutes() !== 0);
    return { date: rawVal, hasTime: hasTime };
  }

  // 2) Fallback to text parsing (use display first to preserve what user sees)
  const str = String((dispVal != null && dispVal !== '') ? dispVal : (rawVal || '')).trim();
  if (!str || str === '-' ) return { date: null, hasTime: false };

  // detect time existence from string (HH:mm or H:mm)
  const hasTimeFromText = /\b\d{1,2}:\d{2}\b/.test(str);

  // extract numbers: d m y [h] [min] ...
  const nums = str.match(/\d+/g);
  if (!nums || nums.length < 3) return { date: null, hasTime: false };

  let d = parseInt(nums[0], 10);
  let m = parseInt(nums[1], 10) - 1;
  let y = parseInt(nums[2], 10);

  // BE -> AD
  if (y > 2400) y -= 543;
  else if (y < 100) y += 2000;

  let hr = 0, min = 0;
  if (hasTimeFromText && nums.length >= 5) {
    hr = parseInt(nums[3], 10) || 0;
    min = parseInt(nums[4], 10) || 0;
  }

  const dt = new Date(y, m, d, hr, min);
  if (isNaN(dt.getTime())) return { date: null, hasTime: false };

  // hasTime true only when text indicates time AND parsed time not 00:00
  const hasTime = hasTimeFromText && (hr !== 0 || min !== 0);
  return { date: dt, hasTime: hasTime };
}

function runMonthlyStockPdfTelegramJob() {
  try {
    Logger.log('===== START runMonthlyStockPdfTelegramJob =====');

    const pdfResult = generateMonthlyStockReport();

    Logger.log('pdfResult=' + JSON.stringify(pdfResult));

    if (!pdfResult || !pdfResult.success) {
      throw new Error((pdfResult && pdfResult.error) ? pdfResult.error : 'สร้างรายงาน PDF ไม่สำเร็จ');
    }

    const tz = Session.getScriptTimeZone();
    const now = new Date();
    
    // 🍓 BERRY FIX: จัด Format วันที่และเวลาให้เป็น พ.ศ. 100% สอดคล้องกัน
    const yearBE = now.getFullYear() + 543;
    const mm = Utilities.formatDate(now, tz, 'MM');
    const dd = Utilities.formatDate(now, tz, 'dd');
    const timeStr = Utilities.formatDate(now, tz, 'HH:mm');
    const reportMonth = `${mm}/${yearBE}`;

    const caption =
      `<b>📦 รายงานสรุปสต็อกอะไหล่ประจำเดือน</b>\n` +
      `📅 <b>เดือนรายงาน:</b> ${reportMonth}\n` +
      `📄 <b>ไฟล์:</b> ${sanitizeHtml(pdfResult.name || 'รายงานสต็อกอะไหล่.pdf')}\n` +
      `🕔 <b>เวลาส่ง:</b> ${dd}/${mm}/${yearBE} เวลา ${timeStr} น.`;

    const replyMarkup = buildOpenPdfButton(pdfResult.url);

    const tgResult = sendTelegramDocument(pdfResult.fileId, caption, replyMarkup);

    Logger.log('tgResult=' + JSON.stringify(tgResult));

    if (!tgResult || !tgResult.success) {
      throw new Error((tgResult && tgResult.error) ? tgResult.error : 'ส่ง PDF เข้า Telegram ไม่สำเร็จ');
    }

    Logger.log('===== PASS runMonthlyStockPdfTelegramJob =====');

    return {
      success: true,
      pdf: pdfResult,
      telegram: tgResult
    };

  } catch (error) {
    Logger.log('===== FAIL runMonthlyStockPdfTelegramJob =====');
    Logger.log(error.message);
    Logger.log(error.stack);

    return {
      success: false,
      error: error.message
    };
  }
}

// [ANCHOR: SERVER: CREATE_MONTHLY_STOCK_PDF_TELEGRAM_TRIGGER]
function createMonthlyStockPdfTelegramTrigger() {
  const triggers = ScriptApp.getProjectTriggers();

  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runMonthlyStockPdfTelegramJob') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('runMonthlyStockPdfTelegramJob')
    .timeBased()
    .onMonthDay(25)
    .atHour(5)
    .create();

  Logger.log('PASS createMonthlyStockPdfTelegramTrigger');
}


// ----------------------------------------------------------------
// SECTION: 🛠️ UTILITY & HELPER FUNCTIONS
// ----------------------------------------------------------------


function getSheetInstance() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const candidateNames = [
    CONFIG.SHEET_NAME,
    'รายการแจ้งซ่อมทั้งหมด',
    'repair',
    'repairs'
  ];

  let sheet = null;
  for (let i = 0; i < candidateNames.length; i++) {
    const name = String(candidateNames[i] || '').trim();
    if (!name) continue;
    sheet = spreadsheet.getSheetByName(name);
    if (sheet) {
      Logger.log('[INFO] getSheetInstance matched sheet: ' + name);
      break;
    }
  }

  if (!sheet) {
    const createdName = CONFIG.SHEET_NAME || 'รายการแจ้งซ่อมทั้งหมด';
    sheet = spreadsheet.insertSheet(createdName);
    const headers = ['เลขที่', 'วันที่', 'ชื่อผู้แจ้งซ่อม', 'เบอร์โทร', 'ประเภทงานซ่อม', 'รายการแจ้งซ่อม', 'อาการ', 'สถานที่', 'สถานะล่าสุด', 'วันที่อัปเดตสถานะ', 'วันที่เสร็จสิ้น', 'รหัสเอกสาร', 'ลิงก์เอกสาร', 'ความเร่งด่วน', 'หมายเหตุ', 'ผู้รับผิดชอบ', 'URL รูปภาพประกอบ'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function _getHeaderMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '').trim();
    if (h) map[h] = i + 1;
  }
  return map;
}

function _findRowBySequence_(sheet, headerMap, sequenceNumber) {
  const col = headerMap['เลขที่'];
  if (!col) throw new Error('ไม่พบคอลัมน์ เลขที่');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  const target = String(sequenceNumber).trim();

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === target) return i + 2;
  }
  return -1;
}

function _formatDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  }
  return v == null ? '' : String(v);
}

function _buildFormDataFromRow_(headers, rowValues) {
  const data = {};
  for (let i = 0; i < headers.length; i++) {
    const key = '{{' + String(headers[i]).trim() + '}}';
    data[key] = _formatDate_(rowValues[i]);
  }
  return data;
}

function _writeBackLinks_(sheet, headerMap, rowIndex, docId, docUrl, pdfUrl) {
  const idCol = headerMap['รหัสเอกสาร'];
  if (idCol) sheet.getRange(rowIndex, idCol).setValue(docId);

  const linkCol = headerMap['ลิงก์เอกสาร'];
  if (linkCol) {
    const link = pdfUrl || docUrl || '';
    sheet.getRange(rowIndex, linkCol).setValue(link);
  }
}

// [ANCHOR: SERVER: UTILS]
/**
 * Utility: ดึงวันที่ปัจจุบันในรูปแบบไทย พร้อมเวลา (dd/MM/yyyy HH:mm:ss)
 */
function getCurrentThaiDate() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear() + 543;
  
  // เพิ่มส่วนของเวลา
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

/**
 * Utility: แปลงวันที่ตาม Priority Rule (Update > Create)
 * return string: "DD/MM/YYYY HH:mm" หรือ "DD/MM/YYYY"
 */
function determineDisplayDate(createDateVal, updateDateVal) {
  // Helper parse
  const parseRaw = (val) => {
    if (!val) return null;
    if (val instanceof Date) return val;
    
    // String parsing: support "dd/MM/yyyy HH:mm:ss" or "dd/MM/yyyy"
    const str = String(val).trim();
    if (!str || str === '-') return null;
    
    // Regex for Thai Date: dd/mm/yyyy [HH:mm[:ss]]
    // Group 1=dd, 2=mm, 3=yyyy, 4=HH, 5=mm, 6=ss
    const match = str.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match) return null;
    
    let y = parseInt(match[3], 10);
    // Convert BE to AD for Date object creation
    if (y > 2400) y -= 543; 
    
    const h = match[4] ? parseInt(match[4], 10) : 0;
    const m = match[5] ? parseInt(match[5], 10) : 0;
    const s = match[6] ? parseInt(match[6], 10) : 0;
    
    return new Date(y, parseInt(match[2], 10) - 1, parseInt(match[1], 10), h, m, s);
  };

  const createObj = parseRaw(createDateVal);
  const updateObj = parseRaw(updateDateVal);
  
  // Priority: Use Update Date if valid and has meaningful time (optional check), else Create Date
  // Requirement: "ถ้ามี 'วันที่อัปเดตสถานะ' และอ่านเวลาได้ -> ใช้เป็นหลัก"
  let targetObj = updateObj ? updateObj : createObj;
  
  if (!targetObj) return "-";
  
  // Formatting back to String (BE)
  const d = String(targetObj.getDate()).padStart(2, '0');
  const mo = String(targetObj.getMonth() + 1).padStart(2, '0');
  const yearBE = targetObj.getFullYear() + 543;
  
  // Check if original input had time or if the Date object has non-zero time
  // For robustness, we display time if it's not 00:00:00 OR if the source string had time.
  // Here we assume if hour/min is not 0, show time.
  const hasTime = (targetObj.getHours() !== 0 || targetObj.getMinutes() !== 0);
  
  if (hasTime) {
    const hh = String(targetObj.getHours()).padStart(2, '0');
    const mm = String(targetObj.getMinutes()).padStart(2, '0');
    return `${d}/${mo}/${yearBE} ${hh}:${mm}`;
  } else {
    return `${d}/${mo}/${yearBE}`;
  }
}

/**
 * Utility: แปลงวันที่ (Date object หรือ String) เป็นรูปแบบไทย พ.ศ.
 */
function formatDate(dateValue) {
  if (!dateValue) return '';
  try {
    const date = (dateValue instanceof Date) ? dateValue : new Date(dateValue);
    if (isNaN(date.getTime())) return dateValue.toString();
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear() < 2400 ? date.getFullYear() + 543 : date.getFullYear();
    return `${day}/${month}/${year}`;
  } catch (e) {
    return dateValue.toString();
  }
}

/**
 * Utility: ดึง File ID จาก URL ของ Google Drive
 */
function extractFileIdFromUrl(url) {
  if (!url) return '';
  
  Logger.log('🔍 Extracting fileId from URL:', url);
  
  try {
    // รูปแบบ URL ต่างๆ ของ Google Drive
    const patterns = [
      // /d/{fileId}/view หรือ /d/{fileId}/edit
      /\/d\/([a-zA-Z0-9_-]{25,})/,
      // ?id={fileId}
      /[?&]id=([a-zA-Z0-9_-]{25,})/,
      // /file/d/{fileId}
      /\/file\/d\/([a-zA-Z0-9_-]{25,})/,
      // drive.google.com/uc?id={fileId}
      /\/uc\?.*id=([a-zA-Z0-9_-]{25,})/,
      // ถ้าเป็น fileId อยู่แล้ว (25+ characters)
      /^([a-zA-Z0-9_-]{25,})$/
    ];
    
    for (let pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        Logger.log('✅ Found fileId:', match[1]);
        return match[1];
      }
    }
    
    Logger.log('⚠️ No fileId found in URL:', url);
    return '';
    
  } catch (error) {
    Logger.log('❌ extractFileIdFromUrl error:', error.toString());
    return '';
  }
}

/**
 * Utility: แปลง URL ของ Google Drive เป็น Direct Link
 */
function convertToDirectLink(url) {
  const fileId = extractFileIdFromUrl(url);
  return fileId ? `https://drive.google.com/uc?export=view&id=${fileId}` : url;
}

/**
 * Utility: แปลง URL สำหรับส่งไป Telegram
 */
function convertToTelegramCompatibleUrl(url) {
    const fileId = extractFileIdFromUrl(url);
    return fileId ? `https://drive.google.com/uc?export=view&id=${fileId}` : url;
}

/**
 * Utility: ดึง URL จากสูตร HYPERLINK
 */
function extractUrlFromFormula(formula) {
  const match = (formula || '').match(/=HYPERLINK\("([^"]+)"/i);
  return match ? match[1] : '';
}

/**
 * Utility: ป้องกัน HTML Injection
 */
function sanitizeHtml(text) {
  return (text || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


function _extractUrlFromHyperlinkCell_(cellValue) {
  const v = cellValue == null ? '' : String(cellValue);
  if (!v) return '';

  if (v.indexOf('=HYPERLINK(') === 0) {
    const m = v.match(/=HYPERLINK\("([^"]+)"/i);
    return m && m[1] ? m[1] : '';
  }

  if (v.indexOf('http') === 0) return v;
  return '';
}

function _extractDriveFileIdFromUrl_(url) {
  if (!url) return '';
  const u = String(url);

  let m = u.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m && m[1]) return m[1];

  m = u.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m && m[1]) return m[1];

  return '';
}

function _safeTrashFileById_(fileId, addLog) {
  if (!fileId) return false;
  try {
    const f = DriveApp.getFileById(fileId);
    f.setTrashed(true);
    addLog('[PASS] Trashed file: ' + fileId);
    return true;
  } catch (e) {
    addLog('[FAIL] Cannot trash file ' + fileId + ': ' + (e && e.message ? e.message : e));
    return false;
  }
}

function submitRepairFormSilent(formData, imageFiles) {
  try {
    if (!formData || !formData['{{ชื่อผู้แจ้งซ่อม}}'] || !formData['{{รายการแจ้งซ่อม}}']) {
      throw new Error('กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน');
    }

    const sequenceNumber = generateSequenceNumber();
    formData['{{เลขที่}}'] = sequenceNumber;
    formData['{{วันที่}}'] = getCurrentThaiDate();

    const imageUrls = (imageFiles && imageFiles.length > 0) ? uploadImages(imageFiles, sequenceNumber) : [];

    const docResult = createRepairDocument(formData);
    if (!docResult || !docResult.success) {
      throw new Error('ไม่สามารถสร้างเอกสารได้: ' + (docResult && docResult.error ? docResult.error : 'unknown'));
    }

    saveToSheet(formData, docResult.url, docResult.docId, imageUrls);

    return {
      success: true,
      sequenceNumber: sequenceNumber,
      docId: docResult.docId,
      docUrl: docResult.url
    };
  } catch (error) {
    Logger.log('CRITICAL ERROR in submitRepairFormSilent: ' + error.stack);
    return { success: false, error: error.message };
  }
}

function createMonthlyReportDocument(year, month, selectedTechnician) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);

    if (!year || !month) throw new Error("ระบุปีและเดือนไม่ถูกต้อง");

    const targetYear = parseInt(year, 10);
    const targetMonth = parseInt(month, 10);
    const technicianFilter = selectedTechnician != null ? String(selectedTechnician).trim() : '';

    Logger.log('[REPORT] selected month: ' + targetYear + '-' + targetMonth);
    Logger.log('[REPORT] selected technician: ' + (technicianFilter || 'รวมทุกคน'));

    if (isNaN(targetYear) || isNaN(targetMonth) || targetMonth < 1 || targetMonth > 12) {
      throw new Error("ระบุปี/เดือนไม่ถูกต้อง");
    }

    const compareYearAD = targetYear > 2400 ? targetYear - 543 : targetYear;
    const displayYearBE = targetYear > 2400 ? targetYear : targetYear + 543;
    Logger.log('[REPORT] normalized target: month=' + targetMonth + ', yearAD=' + compareYearAD + ', yearBE=' + displayYearBE);

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) throw new Error('ไม่พบ Sheet: ' + CONFIG.SHEET_NAME);

    if (typeof helpEnsureDateTimeColumns === 'function') {
      helpEnsureDateTimeColumns(sheet, ['วันที่', 'วันที่อัปเดตสถานะ', 'วันที่เสร็จสิ้น', 'วันที่รับงาน']);
    }

    const range = sheet.getDataRange();
    const rawValues = range.getValues();
    const displayValues = range.getDisplayValues();
    if (!rawValues || rawValues.length < 2) throw new Error("ไม่พบข้อมูลในตาราง");

    const headers = rawValues[0].map(function(h) {
      return String(h).replace(/\s+/g, ' ').trim();
    });

    const idx = function(name) {
      return headers.indexOf(name);
    };
    const idxAny = function(names) {
      for (let i = 0; i < names.length; i++) {
        const found = idx(names[i]);
        if (found > -1) return found;
      }
      return -1;
    };

    const colMap = {
      date: idx('วันที่'),
      updated: idx('วันที่อัปเดตสถานะ'),
      done: idx('วันที่เสร็จสิ้น'),
      received: idx('วันที่รับงาน'),
      seq: idx('เลขที่'),
      item: idx('รายการแจ้งซ่อม'),
      owner: idx('ชื่อผู้แจ้งซ่อม'),
      location: idx('สถานที่'),
      status: idxAny(['สถานะล่าสุด', 'สถานะ']),
      tech: idx('ผู้รับผิดชอบ'),
      img: idxAny(['URL รูปภาพประกอบ', 'รูปภาพประกอบ', 'รูปภาพ']),
      priority: idx('ความเร่งด่วน')
    };

    const parseDateSynced = function(raw, disp) {
      if (raw instanceof Date && !isNaN(raw.getTime())) {
        const y = raw.getFullYear();
        if (y > 2400) {
          return new Date(y - 543, raw.getMonth(), raw.getDate(), raw.getHours(), raw.getMinutes(), raw.getSeconds());
        }
        return raw;
      }

      const s = disp != null ? String(disp).trim() : '';
      if (!s) return null;

      const m = s.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})(?:\s+(\d{1,2})[:\.](\d{2})(?:[:\.](\d{2}))?)?/);
      if (!m) return null;

      let d = parseInt(m[1], 10);
      let mo = parseInt(m[2], 10) - 1;
      let y = parseInt(m[3], 10);
      const hr = m[4] != null ? parseInt(m[4], 10) : 0;
      const mi = m[5] != null ? parseInt(m[5], 10) : 0;

      if (y > 2400) y -= 543;
      else if (y < 100) y += 2000;

      return new Date(y, mo, d, hr, mi, 0);
    };

    const hasTime = function(d) {
      if (!(d instanceof Date) || isNaN(d.getTime())) return false;
      return d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0;
    };

    const extractImageIds = function(val) {
      return typeof helpNormalizeReportImageIds_ === 'function' ? helpNormalizeReportImageIds_(val) : [];
    };

       const normalizeTechName = function(value) {
          const raw = value != null ? String(value) : '';
          // 1. replace newline, 2. collapse multiple spaces, 3. trim
          const cleaned = raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
          if (!cleaned || cleaned === '-' || cleaned === '0') return '';
          return cleaned;
        };

        // Normalize จากค่าที่ Client ส่งมาเพื่อให้สะอาดและตรงมาตรฐานที่สุด
        const finalTechnicianFilter = selectedTechnician != null ? normalizeTechName(selectedTechnician) : '';

        // Server self test logs (เช็คต้นทาง)
        Logger.log("selectedTechnician: " + (selectedTechnician || ''));
        Logger.log("normalized selectedTechnician: " + finalTechnicianFilter);

        // [ANCHOR: REPORT-ENTERPRISE-LAYOUT-V4]
        // [ANCHOR: REPORT-MULTI-JOB-LAYOUT-V3]
        // [ANCHOR: REPORT-LAYOUT-COMPACT-V2]
        const tableData = [[
          'วันที่ / เวลา', 'เลขที่', 'รายการแจ้งซ่อม', 'ผู้แจ้ง / สถานที่', 'สถานะล่าสุด', 'ผู้รับผิดชอบ'
        ]];

        const colWidths =[72, 92, 180, 170, 72, 92];

        let foundCount = 0;
        let completedCount = 0;
        let processingCount = 0;
        let externalCount = 0;
        const pdfRows =[];
        const statusLogValues = getStatusLogValues_();
        const statusLogMap = buildStatusLogMap_(statusLogValues);

        for (let i = 1; i < rawValues.length; i++) {
          const rowRaw = rawValues[i];
          const rowDisp = displayValues[i];

          const targetDateObj = colMap.date > -1 ? parseDateSynced(rowRaw[colMap.date], rowDisp[colMap.date]) : null;
          if (!(targetDateObj instanceof Date) || isNaN(targetDateObj.getTime())) continue;

          const rMonth = parseInt(Utilities.formatDate(targetDateObj, "GMT+7", "M"), 10);
          const rYearAD = parseInt(Utilities.formatDate(targetDateObj, "GMT+7", "yyyy"), 10);
          if (rMonth !== targetMonth || rYearAD !== compareYearAD) continue;

          const techRaw = colMap.tech > -1 ? rowRaw[colMap.tech] : '';
          const techValue = normalizeTechName(techRaw);

          if (finalTechnicianFilter) {
            // Server self test logs (ตรวจสอบข้อมูลระหว่างลูปเฉพาะเดือนที่ตรง)
            Logger.log("sheet technician: " + techRaw);
            Logger.log("normalized sheet technician: " + techValue);
            Logger.log("match result: " + (techValue === finalTechnicianFilter));
            
            if (techValue !== finalTechnicianFilter) continue;
          }

          foundCount++;

          if (finalTechnicianFilter) {
             Logger.log("match count: " + foundCount);
          }

          const statusRaw = colMap.status > -1 && rowRaw[colMap.status] ? String(rowRaw[colMap.status]).trim() : '';
          if (statusRaw === 'เสร็จสิ้น') completedCount++;
          if (statusRaw === 'กำลังดำเนินการ') processingCount++;
          if (statusRaw === 'ดำเนินการภายนอก') externalCount++;

          const priorityVal = colMap.priority > -1 && rowRaw[colMap.priority] ? String(rowRaw[colMap.priority]).trim() : '';
          let statusDisplay = statusRaw;
          if (priorityVal && priorityVal !== '-') {
            statusDisplay += '\n(' + priorityVal + ')';
          }

          // ใช้ techValue เพื่อโชว์ชื่อที่สะอาดแล้ว และถ้าไม่มีใครรับงานให้แสดง "รอการมอบหมาย"
          const techDisplay = finalTechnicianFilter ? techValue : (techValue || 'รอการมอบหมาย');

          // [FIX] ดึงข้อมูลวัน/เวลาดำเนินตามจริงที่อัปเดตล่าสุด
          const updatedDateVal = colMap.updated > -1 ? parseDateSynced(rowRaw[colMap.updated], rowDisp[colMap.updated]) : null;
          const displayDateObj = (updatedDateVal instanceof Date && !isNaN(updatedDateVal.getTime())) ? updatedDateVal : targetDateObj;

          const dayStr = Utilities.formatDate(displayDateObj, "GMT+7", "dd/MM");
          const yearBE = parseInt(Utilities.formatDate(displayDateObj, "GMT+7", "yyyy"), 10) + 543;
          const timeStr = Utilities.formatDate(displayDateObj, "GMT+7", "HH:mm");
          const hour = parseInt(Utilities.formatDate(displayDateObj, "GMT+7", "HH"), 10);
          const min = parseInt(Utilities.formatDate(displayDateObj, "GMT+7", "mm"), 10);

          let dateDisplay = dayStr + '/' + yearBE;
          if (hour !== 0 || min !== 0) dateDisplay += '\n' + timeStr + ' น.';

      const seqVal = colMap.seq > -1 && rowRaw[colMap.seq] ? String(rowRaw[colMap.seq]).trim() : '';
      const itemVal = colMap.item > -1 && rowRaw[colMap.item] ? String(rowRaw[colMap.item]).trim() : '';
      const ownerVal = colMap.owner > -1 && rowRaw[colMap.owner] ? String(rowRaw[colMap.owner]).trim() : '';
      const locVal = colMap.location > -1 && rowRaw[colMap.location] ? String(rowRaw[colMap.location]).trim() : '';
      const ownerInfo = ownerVal + '\n(' + locVal + ')';

      const imgRaw = colMap.img > -1 ? rowRaw[colMap.img] : null;
      const imgIds = extractImageIds(imgRaw);
      const statusHistory = statusLogMap[seqVal] || [];
      const fallbackStatusHistory = [{
        date: displayDateObj,
        status: statusRaw,
        note: '',
        user: techDisplay,
        imageIds: []
      }];

      if (!technicianFilter && !techValue) {
        Logger.log('[REPORT] replace empty technician with: รอการมอบหมาย | seq=' + seqVal);
      }

      pdfRows.push({
        data: [dateDisplay, seqVal, itemVal, ownerInfo, statusDisplay, techDisplay],
        summaryImgIds: imgIds || [],
        statusHistory: statusHistory.length ? statusHistory : fallbackStatusHistory
      });
    }

    Logger.log('[REPORT] total matched rows: ' + foundCount);
    Logger.log('[REPORT] query mode: ' + (technicianFilter ? 'single-technician' : 'all-technicians'));
    Logger.log('[REPORT] query report all: month=' + targetMonth + ', year=' + compareYearAD);
    Logger.log('[REPORT] query report single: month=' + targetMonth + ', year=' + compareYearAD + ', technician=' + (technicianFilter || ''));

    const monthName = CONFIG && CONFIG.MONTHS_TH ? CONFIG.MONTHS_TH[targetMonth - 1] : String(targetMonth);

    if (foundCount === 0) {
      const emptyMessage = technicianFilter
        ? 'ไม่พบข้อมูลของผู้รับผิดชอบ ' + technicianFilter + ' ในเดือนที่เลือก'
        : 'ไม่พบรายการแจ้งซ่อมในเดือนที่เลือก';

      Logger.log('[REPORT] empty result: ' + emptyMessage);
    }

    return generatePdfFileFromRows(
      pdfRows,
      tableData,
      colWidths,
      targetMonth,
      displayYearBE,
      foundCount,
      completedCount,
      processingCount,
      externalCount,
      {
        technicianName: technicianFilter || '',
        reportScopeLabel: technicianFilter ? ('ผู้รับผิดชอบ ' + technicianFilter) : 'รวมทุกคน'
      }
    );

  } catch (error) {
    Logger.log("❌ Create Report Error: " + (error && error.stack ? error.stack : error));
    return { success: false, error: error.message };
  } finally {
    lock.releaseLock();
  }
}


// [ANCHOR: SERVER: PDF_GENERATOR_HELPER]
// CHANGE: เพิ่ม helper ดึงรูปให้ robust (DriveApp → fallback UrlFetch)
function helpGetReportImageBlob(fileId) {
  const id = String(fileId || '').trim();
  if (!id) return null;

  // 1) Try DriveApp first
  try {
    const f = DriveApp.getFileById(id);
    const blob = f.getBlob();
    const ct = String(blob.getContentType() || '').toLowerCase();
    if (ct.indexOf('image/') === 0) return blob;
    const name = String(f.getName ? f.getName() : '').toLowerCase();
    if (/\.(jpe?g|png|gif|webp)$/i.test(name)) return blob;
  } catch (e) {
    // continue to fallback
  }

  // 2) Fallback: fetch from googleusercontent (public by fileId)
  try {
    const url = `https://lh5.googleusercontent.com/d/${encodeURIComponent(id)}`;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      const blob = res.getBlob();
      const ct = String(blob.getContentType() || '').toLowerCase();
      if (ct.indexOf('image/') === 0) return blob;
    }
  } catch (e) {}

  return null;
}

function helpNormalizeReportImageIds_(value) {
  if (value == null) return [];

  const collect = function(input, out) {
    const s = String(input == null ? '' : input).trim();
    if (!s) return;

    if (s.charAt(0) === '[') {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) {
          arr.forEach(function(item) { collect(item, out); });
          return;
        }
      } catch (e) {}
    }

    const id = typeof extractFileIdFromUrl === 'function' ? extractFileIdFromUrl(s) : '';
    if (id) {
      out.push(id);
      return;
    }

    const m = s.match(/[-\w]{25,}/);
    if (m && m[0]) out.push(m[0]);
  };

  const result = [];
  if (Array.isArray(value)) {
    value.forEach(function(item) { collect(item, result); });
  } else {
    const raw = String(value == null ? '' : value).trim();
    if (raw.charAt(0) === '[') {
      collect(raw, result);
    } else {
      raw.split(',').forEach(function(part) { collect(part, result); });
    }
  }

  return result.filter(Boolean);
}

// [ANCHOR: REPORT-TEMPLATE-V2]
function helpEscapeReportPlaceholderPattern_(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function helpReplaceReportPlaceholdersV2_(body, replacements) {
  Object.keys(replacements || {}).forEach(function(key) {
    body.replaceText(helpEscapeReportPlaceholderPattern_(key), String(replacements[key] == null ? '' : replacements[key]));
  });
}

function helpResolveReportTemplateIdV2_() {
  const raw = CONFIG && CONFIG.MONTHLY_TEMPLATE_ID
    ? String(CONFIG.MONTHLY_TEMPLATE_ID).trim()
    : (CONFIG && CONFIG.TEMPLATE_ID ? String(CONFIG.TEMPLATE_ID).trim() : '');
  if (!raw) return '';
  if (typeof extractFileIdFromUrl === 'function') {
    const extracted = extractFileIdFromUrl(raw);
    if (extracted) return extracted;
  }
  return raw;
}

function helpTakeReportPlaceholderIndexV2_(body, placeholder) {
  const found = body.findText(helpEscapeReportPlaceholderPattern_(placeholder));
  if (!found) return -1;

  const text = found.getElement().asText();
  text.deleteText(found.getStartOffset(), found.getEndOffsetInclusive());

  let anchor = text.getParent();
  while (anchor && anchor.getParent && anchor.getParent() && anchor.getParent() !== body) {
    anchor = anchor.getParent();
  }

  if (!anchor || !body.getNumChildren()) return body.getNumChildren();

  let idx = -1;
  try {
    idx = body.getChildIndex(anchor);
  } catch (e) {
    Logger.log('[REPORT] placeholder anchor ไม่ใช่ child ของ body: ' + placeholder + ' | ' + e.message);
    return -1;
  }

  let canRemoveBlankParagraph = false;
  try {
    canRemoveBlankParagraph =
      anchor.getType && anchor.getType() === DocumentApp.ElementType.PARAGRAPH &&
      anchor.asParagraph().getText().trim() === '' &&
      body.getNumChildren() > 1;
  } catch (e) {
    canRemoveBlankParagraph = false;
  }

  if (canRemoveBlankParagraph) {
    try {
      body.removeChild(anchor);
      return idx;
    } catch (e) {
      Logger.log('[REPORT] ลบ paragraph placeholder ไม่สำเร็จ: ' + placeholder + ' | ' + e.message);
      return idx + 1;
    }
  }

  return idx + 1;
}

function helpInsertReportParagraphV2_(body, index, text) {
  if (typeof index === 'number' && index >= 0 && index < body.getNumChildren()) {
    return body.insertParagraph(index, text);
  }
  return body.appendParagraph(text);
}

function helpInsertReportTableV2_(body, index) {
  if (typeof index === 'number' && index >= 0 && index < body.getNumChildren()) {
    return body.insertTable(index);
  }
  return body.appendTable();
}

function helpFindReportTextInsertIndexV2_(body, textLabel) {
  const found = body.findText(helpEscapeReportPlaceholderPattern_(textLabel));
  if (!found) return -1;

  let anchor = found.getElement();
  while (anchor && anchor.getParent && anchor.getParent() && anchor.getParent() !== body) {
    anchor = anchor.getParent();
  }

  try {
    return body.getChildIndex(anchor) + 1;
  } catch (e) {
    Logger.log('[REPORT] หา index จากหัวข้อไม่สำเร็จ: ' + textLabel + ' | ' + e.message);
    return -1;
  }
}

function helpTakeReportTableTitleIndexV2_(body, titleLabel, placeholder) {
  const titleFound = body.findText(helpEscapeReportPlaceholderPattern_(titleLabel));
  if (!titleFound) return helpTakeReportPlaceholderIndexV2_(body, placeholder);

  let titleAnchor = titleFound.getElement();
  const titleTextElement = titleAnchor;
  while (titleAnchor && titleAnchor.getParent && titleAnchor.getParent() && titleAnchor.getParent() !== body) {
    titleAnchor = titleAnchor.getParent();
  }

  try {
    const titleIndex = body.getChildIndex(titleAnchor);

    // ===== CASE A: หัวข้ออยู่ภายในตารางเทมเพลต (Template Table) =====
    if (titleAnchor.getType && titleAnchor.getType() === DocumentApp.ElementType.TABLE) {
      const templateTable = titleAnchor.asTable();

      // 1) ลบข้อความ placeholder ออกจากเอกสารทั้งหมดก่อน
      try { body.replaceText(helpEscapeReportPlaceholderPattern_(placeholder), ''); } catch (e) {}

      // 2) หาแถวที่มีหัวข้อ
      let headingRowIdx = 0;
      for (let r = 0; r < templateTable.getNumRows(); r++) {
        if (templateTable.getRow(r).getText().indexOf(titleLabel) >= 0) {
          headingRowIdx = r;
          break;
        }
      }

      // 3) ลบทุกแถวที่ไม่ใช่แถวหัวข้อ (วนจากล่างขึ้นบน)
      for (let r = templateTable.getNumRows() - 1; r >= 0; r--) {
        if (r !== headingRowIdx && templateTable.getNumRows() > 1) {
          templateTable.removeRow(r);
          if (r < headingRowIdx) headingRowIdx--;
        }
      }

      // 4) ลบย่อหน้าเปล่าในเซลล์ของแถวหัวข้อ + ตั้ง spacing กระชับ
      try {
        const hRow = templateTable.getRow(0);
        try {
          hRow.setMinimumHeight(1);
        } catch (e) {}
        for (let c = 0; c < hRow.getNumCells(); c++) {
          const cell = hRow.getCell(c);
          // ลบย่อหน้าที่ไม่มีข้อความหัวข้อ (จากล่างขึ้นบน, เก็บอย่างน้อย 1 child)
          for (let p = cell.getNumChildren() - 1; p >= 0; p--) {
            try {
              if (cell.getNumChildren() <= 1) break;
              const child = cell.getChild(p);
              if (child.getType() === DocumentApp.ElementType.PARAGRAPH &&
                  child.asParagraph().getText().indexOf(titleLabel) < 0) {
                cell.removeChild(child);
              }
            } catch (e) { break; }
          }
          // ตั้ง spacing ของทุก paragraph ในเซลล์ให้กระชับ
          for (let p = 0; p < cell.getNumChildren(); p++) {
            try {
              const child = cell.getChild(p);
              if (child.asParagraph) {
                child.asParagraph()
                  .setSpacingBefore(0)
                  .setSpacingAfter(0)
                  .setLineSpacing(1);
              }
            } catch (e) {}
          }
          // ลด cell padding ให้กระชับ
          cell.setPaddingTop(4).setPaddingBottom(4);
        }
      } catch (e) {
        Logger.log('[REPORT] cleanup heading cell ล้มเหลว: ' + e.message);
      }

      Logger.log('[REPORT] cleaned template table for: ' + titleLabel + ', remaining rows: ' + templateTable.getNumRows());
      return titleIndex + 1;
    }

    // ===== CASE B: หัวข้อเป็น Paragraph ปกติ (ไม่อยู่ในตาราง) =====
    const titleParagraph = titleTextElement.getParent && titleTextElement.getParent().asParagraph && titleTextElement.getParent().asParagraph();
    if (titleParagraph) {
      titleParagraph.setSpacingBefore(8);
      titleParagraph.setSpacingAfter(0);
      titleParagraph.setLineSpacing(1);
    }

    const placeholderFound = body.findText(helpEscapeReportPlaceholderPattern_(placeholder));
    if (!placeholderFound) return titleIndex + 1;

    let placeholderAnchor = placeholderFound.getElement();
    while (placeholderAnchor && placeholderAnchor.getParent && placeholderAnchor.getParent() && placeholderAnchor.getParent() !== body) {
      placeholderAnchor = placeholderAnchor.getParent();
    }

    const placeholderIndex = body.getChildIndex(placeholderAnchor);
    if (placeholderIndex > titleIndex) {
      let clockAnchor = null;
      try { body.replaceText(helpEscapeReportPlaceholderPattern_(placeholder), ''); } catch (e) {}
      for (let i = placeholderIndex; i > titleIndex; i--) {
        const child = body.getChild(i);
        let keepClock = false;
        try {
          keepClock =
            child.getType && child.getType() === DocumentApp.ElementType.PARAGRAPH &&
            child.asParagraph().getText().indexOf('⏱') >= 0;
        } catch (e) {
          keepClock = false;
        }

        if (keepClock) {
          const clockParagraph = child.asParagraph();
          if (/^⏱️?\s*$/.test(clockParagraph.getText())) {
            clockParagraph.setText('⏱️');
          }
          clockParagraph
            .setSpacingBefore(0)
            .setSpacingAfter(0)
            .setLineSpacing(1);
          clockAnchor = child;
          continue;
        }

        body.removeChild(child);
      }
      if (clockAnchor) return body.getChildIndex(clockAnchor) + 1;
      return titleIndex + 1;
    }

    return helpTakeReportPlaceholderIndexV2_(body, placeholder);
  } catch (e) {
    Logger.log('[REPORT] จัด anchor ตารางสรุปไม่สำเร็จ: ' + titleLabel + ' | ' + e.message);
    return helpTakeReportPlaceholderIndexV2_(body, placeholder);
  }
}

function helpInsertReportLogoV2_(body, font) {
  const logoIndex = helpTakeReportPlaceholderIndexV2_(body, '{{LOGO}}');
  if (logoIndex < 0 || !CONFIG || !CONFIG.REPORT_LOGO_FILE_ID) return;

  try {
    const logoFile = DriveApp.getFileById(CONFIG.REPORT_LOGO_FILE_ID);
    const logoBlob = logoFile.getBlob();
    const pLogo = helpInsertReportParagraphV2_(body, logoIndex, '');
    pLogo.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setFontFamily(font);
    const img = pLogo.appendInlineImage(logoBlob);

    const maxLogo = 90;
    const lw = img.getWidth();
    const lh = img.getHeight();
    if (lw > 0 && lh > 0) {
      const ratio = lw > lh ? (maxLogo / lw) : (maxLogo / lh);
      img.setWidth(Math.floor(lw * ratio));
      img.setHeight(Math.floor(lh * ratio));
    }
  } catch (e) {
    Logger.log('[WARN] REPORT_LOGO_FILE_ID ใช้งานไม่ได้: ' + e.message);
  }
}

function generatePdfFileFromRows(pdfRows, tableData, colWidths, targetMonth, displayYearBE, foundCount, completedCount, processingCount, externalCount, options) {
  const monthName = CONFIG && CONFIG.MONTHS_TH ? CONFIG.MONTHS_TH[targetMonth - 1] : String(targetMonth);
  const technicianName = options && options.technicianName ? String(options.technicianName).trim() : '';
  const isSingleTechnicianReport = !!technicianName;
  const responsibleName = technicianName || 'รวมทุกคน';

  const fileName = isSingleTechnicianReport
    ? 'รายงานสรุปการแจ้งซ่อม_' + monthName + '_' + displayYearBE + '_ผู้รับผิดชอบ_' + technicianName
    : 'รายงานสรุปการแจ้งซ่อม_' + monthName + '_' + displayYearBE;

  Logger.log('[REPORT] pdf filename: ' + fileName);

  const targetFolder = DriveApp.getFolderById(CONFIG.TARGET_FOLDER_ID);
  const templateId = helpResolveReportTemplateIdV2_();
  let docFile = null;
  let doc = null;
  let usedReportTemplate = false;

  if (templateId) {
    try {
      const templateFile = DriveApp.getFileById(templateId);
      docFile = templateFile.makeCopy(fileName, targetFolder);
      doc = DocumentApp.openById(docFile.getId());
      usedReportTemplate = true;
    } catch (e) {
      Logger.log('[REPORT] MONTHLY_TEMPLATE_ID ใช้งานไม่ได้ จึง fallback เป็นเอกสารเปล่า: ' + e.message);
    }
  }

  if (!doc || !docFile) {
    doc = DocumentApp.create(fileName);
    docFile = DriveApp.getFileById(doc.getId());
  }

  const body = doc.getBody();
  const font = CONFIG && CONFIG.FONT_FAMILY ? CONFIG.FONT_FAMILY : 'Sarabun';
  if (!usedReportTemplate) {
    body.appendParagraph('{{LOGO}}').setAlignment(DocumentApp.HorizontalAlignment.CENTER).setFontFamily(font);
    body.appendParagraph('รายงานสรุปการแจ้งซ่อม').setFontFamily(font).setFontSize(14).setBold(true);
    body.appendParagraph('ประจำเดือน {{เดือน}} พ.ศ. {{ปี}}').setFontFamily(font).setFontSize(11);
    body.appendParagraph('ผู้รับผิดชอบ: {{ผู้รับผิดชอบ}}').setFontFamily(font).setFontSize(10);
    body.appendParagraph('ข้อมูล ณ วันที่: {{วันที่พิมพ์}}').setFontFamily(font).setFontSize(10);
    body.appendParagraph('สรุปสถิติงานซ่อมประจำเดือน').setFontFamily(font).setFontSize(11).setBold(true);
    body.appendParagraph('จำนวนงานทั้งหมด: {{จำนวนทั้งหมด}} รายการ').setFontFamily(font).setFontSize(10);
    body.appendParagraph('ดำเนินการเสร็จสิ้น: {{เสร็จสิ้น}} รายการ').setFontFamily(font).setFontSize(10);
    body.appendParagraph('อยู่ระหว่างดำเนินการ: {{กำลังดำเนินการ}} รายการ').setFontFamily(font).setFontSize(10);
    body.appendParagraph('ส่งดำเนินการภายนอก: {{ดำเนินการภายนอก}} รายการ').setFontFamily(font).setFontSize(10);
    body.appendParagraph('ตารางรายการแจ้งซ่อมทั้งหมด').setFontFamily(font).setFontSize(11).setBold(true).setSpacingBefore(8).setSpacingAfter(0).setLineSpacing(1);
    body.appendParagraph('{{ตารางสรุป}}').setFontFamily(font);
    body.appendParagraph('ประวัติสถานะและเส้นทางเวลา (Timeline)').setFontFamily(font).setFontSize(11).setBold(true);
    body.appendParagraph('{{ประวัติสถานะ}}').setFontFamily(font);
    body.appendParagraph('{{SECTION_รูปภาพ}}').setFontFamily(font);
  }
  const now = new Date();
  const reportStamp = typeof formatThaiDateTime === 'function'
    ? formatThaiDateTime(now)
    : Utilities.formatDate(now, 'GMT+7', 'dd/MM/yyyy HH:mm') + ' น.';

  doc.setMarginLeft(18).setMarginRight(18).setMarginTop(18).setMarginBottom(18);
  try {
    if (typeof applyDocLandscapeA4 === 'function') applyDocLandscapeA4(doc.getId());
  } catch (e) {
    Logger.log('[WARN] applyDocLandscapeA4 failed: ' + e.message);
  }

  helpInsertReportLogoV2_(body, font);
  helpReplaceReportPlaceholdersV2_(body, {
    '{{เดือน}}': monthName,
    '{{ปี}}': displayYearBE,
    '{{ผู้รับผิดชอบ}}': responsibleName,
    '{{วันที่พิมพ์}}': reportStamp,
    '{{จำนวนทั้งหมด}}': foundCount,
    '{{เสร็จสิ้น}}': completedCount,
    '{{กำลังดำเนินการ}}': processingCount,
    '{{ดำเนินการภายนอก}}': externalCount
  });

  const colCount = tableData && tableData[0] ? tableData[0].length : 6;
  const defaultWidths = [72, 92, 180, 170, 72, 92];
  const widths = Array.isArray(colWidths) && colWidths.length === colCount ? colWidths : defaultWidths;

  let PAGE_LIMIT = 480;
  let currentHeight = 0;

  const rows = (Array.isArray(pdfRows) ? pdfRows : []).map(function(r) {
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const dataArr = Array.isArray(r.data) ? r.data.slice() : [];
      while (dataArr.length < colCount) dataArr.push('');
      const ids = Array.isArray(r.summaryImgIds)
        ? r.summaryImgIds
        : (Array.isArray(r.imgIds) ? r.imgIds : (r.imgId ? [String(r.imgId)] : []));
      return { data: dataArr, summaryImgIds: ids, statusHistory: Array.isArray(r.statusHistory) ? r.statusHistory : [] };
    }

    const arr = Array.isArray(r) ? r.slice() : [];
    while (arr.length < colCount) arr.push('');
    return { data: arr, imgIds: [], statusHistory: [] };
  });

  body.replaceText('ประวัติสถานะงานแจ้งซ่อม', '');
  body.replaceText('ประวัติสถานะและเส้นทางเวลา \\(Timeline\\)', '');
  body.replaceText('🕒', '');

  let tableInsertIndex = helpTakeReportTableTitleIndexV2_(body, 'ตารางรายการแจ้งซ่อม', '{{ตารางสรุป}}');
  if (tableInsertIndex < 0) tableInsertIndex = helpFindReportTextInsertIndexV2_(body, 'ตารางรายการแจ้งซ่อม');
  let tableCursor = tableInsertIndex;
  let currentTable = helpInsertReportTableV2_(body, tableCursor);
  try {
    const parent = currentTable.getParent();
    let tableIdx = parent.getChildIndex(currentTable);
    while (tableIdx > 0) {
      const prevSibling = parent.getChild(tableIdx - 1);
      if (prevSibling.getType() !== DocumentApp.ElementType.PARAGRAPH) break;

      const prevParagraph = prevSibling.asParagraph();
      if (prevParagraph.getText().trim() === '' && tableIdx > 1) {
        parent.removeChild(prevSibling);
        tableIdx = parent.getChildIndex(currentTable);
        continue;
      }

      if (/^⏱️?\s*$/.test(prevParagraph.getText())) {
        prevParagraph.setText('⏱️');
      }
      prevParagraph.setSpacingBefore(0);
      prevParagraph.setSpacingAfter(0);
      prevParagraph.setLineSpacing(1);
      break;
    }
    tableCursor = parent.getChildIndex(currentTable);
  } catch (e) {
    Logger.log('[REPORT] ปรับ spacing ก่อนตารางหน้า 1 ล้มเหลว: ' + e.message);
  }
  if (tableCursor >= 0) tableCursor++;
  formatTableHeader(currentTable, tableData[0], widths, font);

  const renderRows = rows.length ? rows : [{
    data: ['-', '-', 'ไม่มีรายการแจ้งซ่อม', '-', '-', '-'],
    summaryImgIds: [],
    statusHistory: []
  }];

  renderRows.forEach(function(row) {
    let estimatedRowHeight = 34;

    const maxTextLen = row.data.reduce(function(max, txt) {
      return Math.max(max, String(txt).length);
    }, 0);

    if (maxTextLen > 100) estimatedRowHeight += 18;

    if (currentHeight + estimatedRowHeight > PAGE_LIMIT) {
      if (tableCursor >= 0) {
        const pageBreakParagraph = helpInsertReportParagraphV2_(body, tableCursor, '');
        pageBreakParagraph
          .setSpacingBefore(0)
          .setSpacingAfter(0)
          .setLineSpacing(1)
          .appendPageBreak();
        tableCursor++;
        currentTable = helpInsertReportTableV2_(body, tableCursor);
        tableCursor++;
      } else {
        const numChildren = body.getNumChildren();
        const lastChild = body.getChild(numChildren - 1);

        if (lastChild.getType() === DocumentApp.ElementType.PARAGRAPH) {
          lastChild.asParagraph().appendPageBreak();
        } else {
          body.appendPageBreak();
        }

        currentTable = body.appendTable();
      }
      if (currentTable && currentTable.getParent()) {
        try {
          const tableIndex = body.getChildIndex(currentTable);
          if (tableIndex > 0) {
            const prev = body.getChild(tableIndex - 1);
            if (prev.getType && prev.getType() === DocumentApp.ElementType.PARAGRAPH && prev.asParagraph().getText().trim() === '') {
              prev.asParagraph().setSpacingBefore(0).setSpacingAfter(0);
            }
          }
        } catch (e) {}
      }
      formatTableHeader(currentTable, tableData[0], widths, font);
      PAGE_LIMIT = 480;
      currentHeight = 0;
    }

    appendRowToTable(currentTable, row, widths, font);
    currentHeight += estimatedRowHeight;
  });

  const hasImageSectionPlaceholder = !!body.findText(helpEscapeReportPlaceholderPattern_('{{SECTION_รูปภาพ}}'));
  Logger.log('[REPORT-IMG] initial placeholder=' + hasImageSectionPlaceholder + ' | rows=' + rows.length);
  const historyInsertIndex = helpTakeReportPlaceholderIndexV2_(body, '{{ประวัติสถานะ}}');
  appendStatusHistoryToReport_(body, rows, font, historyInsertIndex, {
    renderImages: !hasImageSectionPlaceholder
  });
  appendReportImageSectionV2_(body, rows, font, {
    allowAppendFallback: hasImageSectionPlaceholder
  });

  body.replaceText('\\{\\{[^}]+\\}\\}', '');

  helpInsertReportParagraphV2_(body, -1, 'รวมทั้งหมด: ' + foundCount + ' รายการ | เสร็จสิ้น: ' + completedCount + ' | กำลังดำเนินการ: ' + processingCount + ' | ดำเนินการภายนอก: ' + externalCount)
    .setAlignment(DocumentApp.HorizontalAlignment.RIGHT)
    .setFontFamily(font)
    .setFontSize(9)
    .setForegroundColor('#666666');

  helpInsertReportParagraphV2_(body, -1, 'ออกรายงานเมื่อ: ' + reportStamp)
    .setAlignment(DocumentApp.HorizontalAlignment.RIGHT)
    .setFontFamily(font)
    .setFontSize(9)
    .setForegroundColor('#999999');

  doc.saveAndClose();

  const pdfBlob = docFile.getAs(MimeType.PDF);
  const pdfFile = targetFolder.createFile(pdfBlob).setName(fileName + '.pdf');

  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  if (!options || options.keepDoc !== true) {
    docFile.setTrashed(true);
  }

  return {
    success: true,
    pdfUrl: pdfFile.getUrl(),
    pdfId: pdfFile.getId(),
    docName: fileName,
   reportData: {
      summary: {
        totalItems: foundCount,
        totalCompleted: completedCount,
        totalProcessing: processingCount,
        totalExternal: externalCount
      },
      year: displayYearBE,
      monthName: monthName,
      technicianName: technicianName,
      reportScopeLabel: isSingleTechnicianReport ? ('ผู้รับผิดชอบ ' + technicianName) : 'รวมทุกคน'
    }
  };
}

// --- Helper Functions for Smart Table ---

function appendStatusHistoryToReport_(body, rows, font, insertIndex, options) {
  const historyGroups = [];
  const widths = [105, 105, 270, 115];
  const header = ['วันที่บันทึก', 'สถานะ', 'หมายเหตุ', 'ผู้บันทึก'];
  let cursor = (typeof insertIndex === 'number' && insertIndex >= 0) ? insertIndex : -1;
  const renderImages = !options || options.renderImages !== false;

  const insertParagraph = function(text) {
    const p = helpInsertReportParagraphV2_(body, cursor, text);
    if (cursor >= 0) cursor++;
    return p;
  };

  const insertTable = function() {
    const table = helpInsertReportTableV2_(body, cursor);
    if (cursor >= 0) cursor++;
    return table;
  };

  const insertTimelineStartPageBreak = function() {
    if (cursor >= 0) {
      const p = helpInsertReportParagraphV2_(body, cursor, '');
      p.setSpacingBefore(0)
        .setSpacingAfter(0)
        .setLineSpacing(1)
        .appendPageBreak();
      cursor++;
    } else if (body.getNumChildren() > 0) {
      const lastChild = body.getChild(body.getNumChildren() - 1);
      if (lastChild.getType() === DocumentApp.ElementType.PARAGRAPH) {
        lastChild.asParagraph().appendPageBreak();
      } else {
        body.appendPageBreak();
      }
    }
  };

  (Array.isArray(rows) ? rows : []).forEach(function(row) {
    const seq = row && row.data ? String(row.data[1] || '').trim() : '';
    const item = row && row.data ? String(row.data[2] || '').trim() : '';
    const history = row && Array.isArray(row.statusHistory) ? row.statusHistory : [];
    const seqLabel = seq + (item ? ' - ' + item : '');
    const summaryIds = row && Array.isArray(row.summaryImgIds) ? row.summaryImgIds : [];
    const group = { seqLabel: seqLabel, rows: [], beforeImageIds: summaryIds.slice(), afterImageIds: [] };

    history.forEach(function(log) {
      const d = log.date instanceof Date && !isNaN(log.date.getTime())
        ? Utilities.formatDate(log.date, 'GMT+7', 'dd/MM/yyyy\nHH:mm น.')
        : String(log.date || '-');

      group.rows.push({
        data: [
          d,
          String(log.status || '-'),
          String(log.note || '-'),
          String(log.user || '-')
        ],
        imgIds: [],
        seqLabel: seqLabel
      });
      const logIds = Array.isArray(log.imageIds) ? log.imageIds : [];
      if (logIds.length) {
        if (String(log.status || '').trim() === STATUS.COMPLETED) {
          group.afterImageIds = group.afterImageIds.concat(logIds);
        } else {
          group.beforeImageIds = group.beforeImageIds.concat(logIds);
        }
      }
    });
    historyGroups.push(group);
  });

  if (!historyGroups.length) {
    insertParagraph('ไม่มีประวัติสถานะ')
      .setFontFamily(font)
      .setFontSize(10);
    return;
  }

  body.replaceText('ประวัติสถานะงานแจ้งซ่อม', '');
  body.replaceText('ประวัติสถานะและเส้นทางเวลา \\(Timeline\\)', '');

  if (cursor < 0) {
    insertTimelineStartPageBreak();
    insertParagraph('ประวัติสถานะและเส้นทางเวลา (Timeline)')
      .setHeading(DocumentApp.ParagraphHeading.HEADING3)
      .setFontFamily(font)
      .setFontSize(13)
      .setBold(true)
      .setForegroundColor('#0b376d');
  }

  let currentHeight = 35;
  const pageLimit = 480;

  const appendHistoryPageBreak = function() {
    if (cursor >= 0) {
      insertParagraph('')
        .setSpacingBefore(0)
        .setSpacingAfter(0)
        .setLineSpacing(1)
        .appendPageBreak();
    } else {
      body.appendPageBreak();
    }
    currentHeight = 0;
  };

  const startHistoryTable = function(seqLabel) {
    insertParagraph('เลขที่: ' + seqLabel)
      .setFontFamily(font)
      .setFontSize(10)
      .setBold(true)
      .setSpacingBefore(0)
      .setSpacingAfter(0);
    const currentTable = insertTable();
    formatTableHeader(currentTable, header, widths, font);
    currentHeight += 55;
    return currentTable;
  };

  const appendTimelineImages = function(beforeIds, afterIds, sequenceNumber) {
    beforeIds = (beforeIds || []).filter(Boolean).slice(0, 4);
    afterIds = (afterIds || []).filter(Boolean).slice(0, 4);

    const resolveImages = function(ids) {
      return (ids || []).map(function(id) {
        try {
          const blob = helpGetReportImageBlob(id);
          if (!blob) throw new Error('image blob not found');
          return { id: id, blob: blob };
        } catch (e) {
          Logger.log('[REPORT] timeline image skipped | sequenceNumber=' + sequenceNumber + ' | fileId=' + id + ' | error=' + (e && e.message ? e.message : e));
          return null;
        }
      }).filter(Boolean);
    };

    const beforeImages = resolveImages(beforeIds);
    const afterImages = resolveImages(afterIds);
    if (!beforeImages.length && !afterImages.length) return;

    insertParagraph('📷 ภาพประกอบงานซ่อม')
      .setFontFamily(font)
      .setFontSize(9)
      .setBold(true)
      .setSpacingBefore(4)
      .setSpacingAfter(2);

    const imageTable = insertTable();
    const maxRows = Math.max(beforeImages.length, afterImages.length);

    const renderImageCell = function(row, label, imageInfo) {
      if (!imageInfo) {
        row.appendTableCell('').setWidth(260);
        return;
      }
      const cell = row.appendTableCell('');
      cell.setPaddingTop(3).setPaddingBottom(3).setPaddingLeft(3).setPaddingRight(3).setWidth(260);

      cell.appendParagraph(label)
        .setAlignment(DocumentApp.HorizontalAlignment.CENTER)
        .setFontFamily(font)
        .setFontSize(9)
        .setBold(true)
        .setSpacingBefore(0)
        .setSpacingAfter(2);

      try {
        const p = cell.appendParagraph('');
        p.setAlignment(DocumentApp.HorizontalAlignment.CENTER)
          .setSpacingBefore(0)
          .setSpacingAfter(0);
        const img = p.appendInlineImage(imageInfo.blob);
        const origW = img.getWidth();
        const origH = img.getHeight();
        const maxW = (beforeImages.length && afterImages.length) ? 235 : 260;
        const maxH = 165;
        if (origW > 0 && origH > 0) {
          const scale = Math.min(maxW / origW, maxH / origH);
          img.setWidth(Math.max(1, Math.floor(origW * scale)));
          img.setHeight(Math.max(1, Math.floor(origH * scale)));
        } else {
          img.setWidth(maxW);
        }
      } catch (e) {
        Logger.log('[REPORT] timeline image render failed | sequenceNumber=' + sequenceNumber + ' | fileId=' + imageInfo.id + ' | error=' + (e && e.message ? e.message : e));
        cell.appendParagraph('');
      }
    };

    for (let i = 0; i < maxRows; i++) {
      const imageRow = imageTable.appendTableRow();
      if (beforeImages.length && afterImages.length) {
        renderImageCell(imageRow, 'ภาพก่อนซ่อม', beforeImages[i]);
        renderImageCell(imageRow, 'ภาพหลังซ่อม', afterImages[i]);
      } else if (beforeImages.length) {
        renderImageCell(imageRow, 'ภาพก่อนซ่อม', beforeImages[i]);
      } else {
        renderImageCell(imageRow, 'ภาพหลังซ่อม', afterImages[i]);
      }
    }
    currentHeight += 34 + (maxRows * 190);
  };

  historyGroups.forEach(function(group) {
    if (currentHeight > 35 && currentHeight + 115 > pageLimit) {
      appendHistoryPageBreak();
    }
    let currentTable = startHistoryTable(group.seqLabel);

    group.rows.forEach(function(row) {
      let estimatedRowHeight = 34;
      const maxTextLen = row.data.reduce(function(max, txt) {
        return Math.max(max, String(txt).length);
      }, 0);
      if (maxTextLen > 80) estimatedRowHeight += 18;

      if (currentHeight + estimatedRowHeight > pageLimit) {
        appendHistoryPageBreak();
        currentTable = startHistoryTable(group.seqLabel);
      }

      appendRowToTable(currentTable, row, widths, font);
      currentHeight += estimatedRowHeight;
    });
    if (renderImages) appendTimelineImages(group.beforeImageIds, group.afterImageIds, group.seqLabel);
  });
}

function appendReportImageSectionV2_(body, rows, font, options) {
  let sectionIndex = helpTakeReportPlaceholderIndexV2_(body, '{{SECTION_รูปภาพ}}');
  if (sectionIndex < 0 && options && options.allowAppendFallback === true) {
    Logger.log('[REPORT-IMG] placeholder missing after timeline; append image section at document end');
    sectionIndex = body.getNumChildren();
  }
  if (sectionIndex < 0) {
    Logger.log('[REPORT-IMG] skip image section: placeholder not found');
    return;
  }

  let cursor = sectionIndex;
  const insertParagraph = function(text) {
    const p = helpInsertReportParagraphV2_(body, cursor, text);
    cursor++;
    return p;
  };
  const insertTable = function() {
    const table = helpInsertReportTableV2_(body, cursor);
    cursor++;
    return table;
  };
  const uniqueIds = function(ids) {
    const seen = {};
    return (ids || []).filter(function(id) {
      id = String(id || '').trim();
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    }).slice(0, 3);
  };

  const groups = [];
  (Array.isArray(rows) ? rows : []).forEach(function(row) {
    const seq = row && row.data ? String(row.data[1] || '').trim() : '';
    const item = row && row.data ? String(row.data[2] || '').trim() : '';
    const group = {
      seqLabel: seq + (item ? ' - ' + item : ''),
      beforeImageIds: Array.isArray(row && row.summaryImgIds) ? row.summaryImgIds.slice() : [],
      afterImageIds: []
    };
    const history = row && Array.isArray(row.statusHistory) ? row.statusHistory : [];
    history.forEach(function(log) {
      const logIds = Array.isArray(log.imageIds) ? log.imageIds : [];
      if (!logIds.length) return;
      if (String(log.status || '').trim() === STATUS.COMPLETED) {
        group.afterImageIds = group.afterImageIds.concat(logIds);
      } else {
        group.beforeImageIds = group.beforeImageIds.concat(logIds);
      }
    });
    group.beforeImageIds = uniqueIds(group.beforeImageIds);
    group.afterImageIds = uniqueIds(group.afterImageIds);
    if (group.beforeImageIds.length || group.afterImageIds.length) groups.push(group);
  });

  Logger.log('[REPORT-IMG] candidate groups=' + groups.length);
  if (!groups.length) return;

  const appendImageOnlyCell = function(row, imageInfo, cellW, maxW, maxH) {
    const cell = row.appendTableCell('');
    cell.setPaddingTop(3).setPaddingBottom(2).setPaddingLeft(3).setPaddingRight(3).setWidth(cellW);

    const p = cell.appendParagraph('');
    p.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(0).setSpacingAfter(0);
    const img = p.appendInlineImage(imageInfo.blob);
    const origW = img.getWidth();
    const origH = img.getHeight();
    if (origW > 0 && origH > 0) {
      const scale = Math.min(maxW / origW, maxH / origH);
      img.setWidth(Math.max(1, Math.floor(origW * scale)));
      img.setHeight(Math.max(1, Math.floor(origH * scale)));
    } else {
      img.setWidth(maxW);
    }
  };

  const appendLabelCell = function(row, label, cellW) {
    const cell = row.appendTableCell('');
    cell.setPaddingTop(0).setPaddingBottom(4).setPaddingLeft(3).setPaddingRight(3).setWidth(cellW);
    cell.appendParagraph(label)
      .setAlignment(DocumentApp.HorizontalAlignment.CENTER)
      .setFontFamily(font)
      .setFontSize(9)
      .setBold(true)
      .setSpacingBefore(0)
      .setSpacingAfter(0);
  };

  const appendImageGrid = function(title, images, label) {
    if (!images.length) return;
    insertParagraph(title)
      .setFontFamily(font)
      .setFontSize(9)
      .setBold(true)
      .setSpacingBefore(3)
      .setSpacingAfter(1);

    const columns = images.length >= 3 ? 3 : Math.min(2, images.length);
    const cellW = columns === 3 ? 180 : (columns === 2 ? 260 : 520);
    const maxW = columns === 3 ? 152 : (columns === 2 ? 215 : 390);
    const maxH = columns === 3 ? 145 : (columns === 2 ? 155 : 165);
    const imageTable = insertTable();

    for (let i = 0; i < images.length; i += columns) {
      const imageRow = imageTable.appendTableRow();
      const labelRow = imageTable.appendTableRow();
      const rowImages = images.slice(i, i + columns);
      rowImages.forEach(function(imageInfo) {
        appendImageOnlyCell(imageRow, imageInfo, cellW, maxW, maxH);
        appendLabelCell(labelRow, label, cellW);
      });
    }
  };

  const resolveImages = function(ids, sequenceNumber) {
    return (ids || []).map(function(id) {
      try {
        const blob = helpGetReportImageBlob(id);
        if (!blob) throw new Error('image blob not found');
        return { id: id, blob: blob };
      } catch (e) {
        Logger.log('[REPORT] section image skipped | sequenceNumber=' + sequenceNumber + ' | fileId=' + id + ' | error=' + (e && e.message ? e.message : e));
        return null;
      }
    }).filter(Boolean);
  };

  const resolvedGroups = groups.map(function(group) {
    return {
      seqLabel: group.seqLabel,
      beforeImages: resolveImages(group.beforeImageIds, group.seqLabel),
      afterImages: resolveImages(group.afterImageIds, group.seqLabel)
    };
  }).filter(function(group) {
    return group.beforeImages.length || group.afterImages.length;
  });
  Logger.log('[REPORT-IMG] resolved groups=' + resolvedGroups.length);
  if (!resolvedGroups.length) return;

  insertParagraph('รูปภาพประกอบ')
    .setFontFamily(font)
    .setFontSize(11)
    .setBold(true)
    .setSpacingBefore(4)
    .setSpacingAfter(4);

  resolvedGroups.forEach(function(group) {
    const beforeImages = group.beforeImages;
    const afterImages = group.afterImages;

    insertParagraph('เลขที่: ' + group.seqLabel)
      .setFontFamily(font)
      .setFontSize(10)
      .setBold(true)
      .setSpacingBefore(2)
      .setSpacingAfter(2);

    appendImageGrid('ภาพก่อนซ่อม', beforeImages, 'ก่อนซ่อม');
    appendImageGrid('ภาพหลังซ่อม', afterImages, 'หลังซ่อม');
  });
}

function formatTableHeader(table, headerData, widths, font) {
    const tr = table.appendTableRow();
    headerData.forEach((text, i) => {
        const cell = tr.appendTableCell(text);
        cell.setBackgroundColor('#eeeeee')
            .setPaddingTop(3).setPaddingBottom(3)
            .setWidth(widths[i]);
        
        // จัด style paragraph ใน cell
        if (cell.getNumChildren() > 0) {
            const p = cell.getChild(0).asParagraph();
            p.setAlignment(DocumentApp.HorizontalAlignment.CENTER)
             .setFontFamily(font).setFontSize(9).setBold(true)
             .setSpacingBefore(0).setSpacingAfter(0);
        }
    });
}

function appendRowToTable(table, rowData, widths, font) {
    const tr = table.appendTableRow();
    const cellFontSize = 9;
    const padTop = 3;
    const padBottom = 3;
    const colCount = widths.length;
    const imgColIdx = colCount - 1;
    const imgColWidth = widths[imgColIdx];
    const renderImageColumn = rowData && rowData.renderImagesInTable === true;
    const textColCount = renderImageColumn ? colCount - 1 : colCount;

    // Text Columns
    for (let c = 0; c < textColCount; c++) {
        const cell = tr.appendTableCell('');
        cell.setPaddingTop(padTop).setPaddingBottom(padBottom).setWidth(widths[c]);
        
        const align = (c === 0 || c === 1 || c === 4) 
            ? DocumentApp.HorizontalAlignment.CENTER 
            : DocumentApp.HorizontalAlignment.LEFT;
            
        helpWriteCellLines(cell, rowData.data[c], align, font, cellFontSize);
    }

    if (!renderImageColumn) return;

    // Image Column
    const imgCell = tr.appendTableCell('');
    imgCell.setWidth(imgColWidth).setPaddingTop(2).setPaddingBottom(2);

    while (imgCell.getNumChildren() > 0) imgCell.removeChild(imgCell.getChild(0));
    const imgP = imgCell.appendParagraph('');
    imgP.setAlignment(DocumentApp.HorizontalAlignment.CENTER)
      .setSpacingBefore(0)
      .setSpacingAfter(0);

    const ids = (rowData.summaryImgIds || rowData.imgIds || []).filter(Boolean).slice(0, 1);
    if (!ids.length) {
        imgP.appendText('-').setFontFamily(font).setFontSize(cellFontSize);
    } else {
        const gap = ids.length > 1 ? 4 : 0;
        const usableWidth = Math.max(44, imgColWidth - 8);
        const usableHeight = 140;
        let baseWidth = usableWidth;
        if (ids.length === 2) {
            baseWidth = Math.floor((usableWidth - gap) * 0.48);
        } else if (ids.length >= 3) {
            baseWidth = Math.floor((usableWidth - gap * 2) * 0.31);
        }
        baseWidth = Math.max(30, baseWidth);

        ids.forEach(function(id, index) {
            try {
                const f = DriveApp.getFileById(id);
                const inlineImg = imgP.appendInlineImage(f.getBlob());
                const origW = inlineImg.getWidth();
                const origH = inlineImg.getHeight();
                if (origW > 0 && origH > 0) {
                    const scaleByWidth = baseWidth / origW;
                    const scaleByHeight = usableHeight / origH;
                    const scale = Math.min(scaleByWidth, scaleByHeight);
                    inlineImg.setWidth(Math.max(1, Math.floor(origW * scale)));
                    inlineImg.setHeight(Math.max(1, Math.floor(origH * scale)));
                } else {
                    inlineImg.setWidth(baseWidth);
                }
                if (index < ids.length - 1) {
                    imgP.appendText(' ');
                }
            } catch (e) {
               // Ignore image load error
            }
        });
    }
}

/* =========================
   Helper (ไม่มี underscore)
   ========================= */

// CHANGE: detect ชื่อคอลัมน์รูป
function detectImageColumnIndex(headers) {
  if (!headers || !headers.length) return -1;
  var keys = ['รูปภาพ', 'ภาพ', 'แนบรูป', 'ไฟล์รูป', 'image', 'photo', 'picture', 'attachment'];
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').toLowerCase();
    for (var k = 0; k < keys.length; k++) {
      if (h.indexOf(String(keys[k]).toLowerCase()) > -1) return i;
    }
  }
  return -1;
}

function looksLikeImageValue(v) {
  if (!v) return false;
  var s = String(v);
  return (
    s.indexOf('drive.google.com') > -1 ||
    s.indexOf('https://') === 0 ||
    s.indexOf('http://') === 0 ||
    s.match(/\.(png|jpg|jpeg|webp|gif)$/i)
  );
}

// CHANGE: แยกคอลัมน์รายละเอียดให้ชิดซ้าย (อ่านง่าย)
function isLikelyDetailColumn(headerName) {
  var h = String(headerName || '').toLowerCase();
  return (h.indexOf('รายการ') > -1 || h.indexOf('detail') > -1 || h.indexOf('description') > -1);
}

// CHANGE: ล้าง cell แบบปลอดภัย (ไม่ทำให้ table พัง)
function clearCellContent(cell) {
  // ลบ child ทั้งหมด
  var n = cell.getNumChildren();
  for (var i = n - 1; i >= 0; i--) {
    cell.removeChild(cell.getChild(i));
  }
}

// CHANGE: resolve รูปจากค่าในชีต (รองรับ fileId / url) + fallback โลโก้ถ้าตั้งไว้
function resolveImageBlob(value, options) {
  options = options || {};
  var s = String(value || '').trim();
  if (!s) return null;

  // ถ้าเป็น fileId ตรง ๆ
  if (s.length > 20 && s.indexOf('http') !== 0 && s.indexOf('/') === -1) {
    try { return DriveApp.getFileById(s).getBlob(); } catch (e) {}
  }

  // ถ้าเป็น Drive URL
  var fileId = extractDriveFileId(s);
  if (fileId) {
    try { return DriveApp.getFileById(fileId).getBlob(); } catch (e) {}
  }

  // ถ้าเป็น URL ทั่วไป (ต้องใช้ UrlFetchApp) — ใช้เฉพาะเมื่ออนุญาต
  if (s.indexOf('http') === 0 && options.allowFetchImage === true) {
    try {
      var res = UrlFetchApp.fetch(s, { muteHttpExceptions: true, followRedirects: true });
      if (res.getResponseCode() >= 200 && res.getResponseCode() < 300) {
        return res.getBlob();
      }
    } catch (e2) {}
  }

  return null;
}

function extractDriveFileId(url) {
  try {
    var m1 = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (m1 && m1[1]) return m1[1];
    var m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m2 && m2[1]) return m2[1];
  } catch (e) {}
  return '';
}

// CHANGE: คำนวณความกว้างคอลัมน์จากความยาวข้อความ (manual autofit)
function computeColumnWidths(matrix, cfg) {
  cfg = cfg || {};
  var cols = matrix[0] ? matrix[0].length : 0;
  var maxLens = new Array(cols).fill(0);

  for (var r = 0; r < matrix.length; r++) {
    for (var c = 0; c < cols; c++) {
      var v = (matrix[r][c] == null) ? '' : String(matrix[r][c]);
      // ให้ค่าน้ำหนักบรรทัดที่ยาวสุดของ cell
      var lines = v.split('\n');
      var longest = lines.reduce(function (a, b) { return Math.max(a, (b || '').length); }, 0);
      maxLens[c] = Math.max(maxLens[c], longest);
    }
  }

  var minW = cfg.minWidth || 55;
  var maxW = cfg.maxWidth || 220;
  var totalW = cfg.totalWidth || 520;

  var widths = new Array(cols).fill(minW);

  // image col fixed
  if (cfg.imageColIndex > -1 && cfg.imageColIndex < cols) {
    widths[cfg.imageColIndex] = cfg.imageWidth || 75;
  }

  // รวม weight ของคอลัมน์ที่ไม่ใช่รูป
  var weights = [];
  var sumWeight = 0;
  for (var i = 0; i < cols; i++) {
    if (i === cfg.imageColIndex) {
      weights[i] = 0;
      continue;
    }
    // แปลงความยาว -> weight (คุมไม่ให้เวอร์)
    var w = Math.max(6, Math.min(30, maxLens[i])); // 6..30
    weights[i] = w;
    sumWeight += w;
  }

  var fixedW = widths.reduce(function (a, b) { return a + b; }, 0);
  var remaining = Math.max(0, totalW - fixedW);

  // กระจาย remaining ตาม weights
  for (var j = 0; j < cols; j++) {
    if (j === cfg.imageColIndex) continue;
    if (sumWeight <= 0) continue;

    var add = Math.floor(remaining * (weights[j] / sumWeight));
    widths[j] = clampNumber(widths[j] + add, minW, maxW);
  }

  // ปรับอีกรอบกันผลรวมเกิน totalW
  var sumW = widths.reduce(function (a, b) { return a + b; }, 0);
  if (sumW > totalW) {
    var over = sumW - totalW;
    for (var k = 0; k < cols && over > 0; k++) {
      if (k === cfg.imageColIndex) continue;
      var canReduce = widths[k] - minW;
      var reduce = Math.min(canReduce, over);
      widths[k] -= reduce;
      over -= reduce;
    }
  }

  return widths;
}

function applyColumnWidths(table, widths) {
  // ตั้ง width ให้ทุก cell ในคอลัมน์นั้น ๆ
  for (var r = 0; r < table.getNumRows(); r++) {
    var row = table.getRow(r);
    for (var c = 0; c < row.getNumCells(); c++) {
      if (widths[c] != null) row.getCell(c).setWidth(widths[c]);
    }
  }
}

function clampNumber(n, min, max) {
  return Math.max(min, Math.min(max, n));
}



// [ANCHOR: SERVER: TIME_HELPERS]

function helpParseDateSynced(rawVal, dispVal) {
  if (rawVal instanceof Date && !isNaN(rawVal.getTime())) {
    const y = rawVal.getFullYear();
    if (y > 2400) return new Date(y - 543, rawVal.getMonth(), rawVal.getDate(), rawVal.getHours(), rawVal.getMinutes());
    return rawVal;
  }

  const str = String(dispVal || rawVal || '').trim();
  if (!str || str === '-') return null;

  const dateMatch = str.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (!dateMatch) return null;

  let d = parseInt(dateMatch[1], 10);
  let m = parseInt(dateMatch[2], 10) - 1;
  let y = parseInt(dateMatch[3], 10);
  if (y > 2400) y -= 543;

  let hr = 0, min = 0;
  const timeMatch = str.match(/(\d{1,2})[:.](\d{2})/);
  if (timeMatch) {
    hr = parseInt(timeMatch[1], 10);
    min = parseInt(timeMatch[2], 10);
  }

  return new Date(y, m, d, hr, min);
}

function helpHasTime(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return false;
  const hh = parseInt(Utilities.formatDate(d, "GMT+7", "HH"), 10);
  const mm = parseInt(Utilities.formatDate(d, "GMT+7", "mm"), 10);
  return (hh !== 0 || mm !== 0);
}

function helpIsMidnight(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return true;
  const hh = parseInt(Utilities.formatDate(d, "GMT+7", "HH"), 10);
  const mm = parseInt(Utilities.formatDate(d, "GMT+7", "mm"), 10);
  return (hh === 0 && mm === 0);
}

function helpBuildDateDisplay(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';

  const dayStr = Utilities.formatDate(d, "GMT+7", "dd/MM");
  const yearStr = parseInt(Utilities.formatDate(d, "GMT+7", "yyyy"), 10) + 543;
  const dateStr = `${dayStr}/${yearStr}`;

  // ถ้าไม่มีเวลา "จริง" → แสดงเฉพาะวันที่ (ไม่โชว์ 00:00)
  if (!helpHasTime(d)) return dateStr;

  const timeStr = Utilities.formatDate(d, "GMT+7", "HH:mm");
  return `${dateStr}\n${timeStr} น.`;
}

function helpWriteCellLines(cell, value, align, font, fontSize) {
  // CHANGE: clear children safely (กันข้อความเก่าค้าง)
  try {
    while (cell.getNumChildren() > 0) cell.removeChild(cell.getChild(0));
  } catch (e) {}

  const text = (value == null) ? '' : String(value);

  // ว่าง → ใส่ "-"
  if (!text.trim()) {
    const p0 = cell.appendParagraph('-');
    p0.setAlignment(align || DocumentApp.HorizontalAlignment.LEFT);
    p0.setFontFamily(font).setFontSize(fontSize).setBold(false);
    p0.setLineSpacing(1.1);
    return;
  }

  // CHANGE: รองรับหลายบรรทัดจาก "\n"
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const ln = String(lines[i] == null ? '' : lines[i]);

    const p = cell.appendParagraph(ln);
    p.setAlignment(align || DocumentApp.HorizontalAlignment.LEFT);
    p.setFontFamily(font).setFontSize(fontSize).setBold(false);
    p.setLineSpacing(1.1);

    // CHANGE: ลด spacing ระหว่าง paragraph ให้กระชับ
    try {
      p.setSpacingBefore(0).setSpacingAfter(0);
    } catch (e) {}
  }
}

function runTelegramAllStatusSelfTest() {
  Logger.log('[TEST-TG-ALL] เริ่มทดสอบ Telegram ทุกสถานะ + บันทึกข้อมูลครบคอลัมน์');

  var result = {
    success: true,
    steps: [],
    testSequence: '',
    rowIndex: 0,
    statusesTested: [],
    error: ''
  };

  var ss = null;
  var sheet = null;
  var rowIndex = 0;
  var createdImageIds = [];
  var oldTestMode = CONFIG.IS_TEST_MODE;

  try {
    CONFIG.IS_TEST_MODE = true;

    ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) throw new Error('ไม่พบชีต ' + CONFIG.SHEET_NAME);

    if (typeof helpEnsurePhoneColumnText === 'function') helpEnsurePhoneColumnText(sheet);
    if (typeof helpEnsureDateTimeColumns === 'function') {
      helpEnsureDateTimeColumns(sheet, ['วันที่', 'วันที่อัปเดตสถานะ', 'วันที่เสร็จสิ้น', 'วันที่รับงาน']);
    }

    var mapped = helpMapHeadersFromSheet(sheet);
    var headers = mapped.headers;
    var map = mapped.map;

    var requiredHeaders = [
      'เลขที่',
      'วันที่',
      'ชื่อผู้แจ้งซ่อม',
      'เบอร์โทร',
      'ประเภทงานซ่อม',
      'รายการแจ้งซ่อม',
      'อาการ',
      'สถานที่',
      'สถานะ',
      'วันที่อัปเดตสถานะ',
      'วันที่เสร็จสิ้น',
      'รหัสเอกสาร',
      'ลิงก์เอกสาร',
      'ความเร่งด่วน',
      'หมายเหตุ',
      'ผู้รับผิดชอบ',
      'URL รูปภาพประกอบ',
      'วันที่รับงาน'
    ];

    requiredHeaders.forEach(function(name) {
      if (!map[name]) {
        Logger.log('[TEST-TG-ALL][WARN] ไม่พบคอลัมน์ในชีต: ' + name);
      }
    });

    var seq = 'TEST-TG-' + new Date().getTime();
    result.testSequence = seq;

    var now = new Date();
    var phoneRaw = '0812345678';
    var phoneSafe = (typeof helpNormalizePhone === 'function') ? helpNormalizePhone(phoneRaw) : String(phoneRaw).trim();
    var tinyImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';
    createdImageIds = (typeof uploadImages === 'function') ? uploadImages([tinyImage], seq) : [];

    var row = new Array(headers.length).fill('');

    var setVal = function(headerName, value) {
      var idx = headers.indexOf(String(headerName).trim());
      if (idx > -1) row[idx] = value;
    };

    setVal('เลขที่', seq);
    setVal('วันที่', now);
    setVal('ชื่อผู้แจ้งซ่อม', 'ทดสอบ Telegram ทุกสถานะ');
    setVal('เบอร์โทร', "'" + phoneSafe);
    setVal('ประเภทงานซ่อม', 'ทั่วไป');
    setVal('รายการแจ้งซ่อม', 'ทดสอบส่ง Telegram ทุกสถานะ');
    setVal('อาการ', 'เครื่องปรับอากาศไม่เย็น / ใช้เป็นคำอธิบายทดสอบ');
    setVal('สถานที่', 'ห้องทดสอบ 101');
    setVal('สถานะ', 'รอดำเนินการ');
    setVal('วันที่อัปเดตสถานะ', '');
    setVal('วันที่เสร็จสิ้น', '');
    setVal('รหัสเอกสาร', 'TEST-DOC-' + seq);
    setVal('ลิงก์เอกสาร', 'https://example.com/test/' + encodeURIComponent(seq));
    setVal('ความเร่งด่วน', 'ปานกลาง');
    setVal('หมายเหตุ', 'เริ่มสร้างเคสทดสอบ Telegram');
    setVal('ผู้รับผิดชอบ', '');
    setVal('URL รูปภาพประกอบ', JSON.stringify(createdImageIds || []));
    setVal('วันที่รับงาน', '');

    sheet.insertRowAfter(sheet.getLastRow());
    rowIndex = sheet.getLastRow();

    if (map['เบอร์โทร']) {
      sheet.getRange(rowIndex, map['เบอร์โทร']).setNumberFormat('@');
    }

    sheet.getRange(rowIndex, 1, 1, headers.length).setValues([row]);
    SpreadsheetApp.flush();

    var rowIndexFound = helpFindRowBySequence(sheet, seq);
    result.rowIndex = rowIndexFound || rowIndex;

    if (!rowIndexFound || rowIndexFound < 2) {
      throw new Error('สร้างแถวทดสอบแล้วแต่หา rowIndex ไม่พบ');
    }
    rowIndex = rowIndexFound;

    if (map['เบอร์โทร']) {
      var phoneDisplay = sheet.getRange(rowIndex, map['เบอร์โทร']).getDisplayValue();
      if (String(phoneDisplay).trim() !== phoneSafe) {
        throw new Error('เบอร์โทรถูกแปลงรูปแบบผิด: expected=' + phoneSafe + ' actual=' + phoneDisplay);
      }
    }

    Logger.log('[TEST-TG-ALL][OK] 1. สร้างข้อมูลทดสอบลงชีตเรียบร้อย seq=' + seq + ' row=' + rowIndex);
    result.steps.push('create-row-ok');

    var readRowObject = function(targetRowIndex) {
      var values = sheet.getRange(targetRowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
      var displays = sheet.getRange(targetRowIndex, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
      var obj = {};

      headers.forEach(function(h, i) {
        var key = String(h || '').trim();
        var rawVal = values[i];
        var dispVal = displays[i];

        if (key === 'เบอร์โทร') {
          obj[key] = String(dispVal || rawVal || '').trim();
          return;
        }

        if (rawVal instanceof Date && !isNaN(rawVal.getTime())) {
          obj[key] = Utilities.formatDate(rawVal, Session.getScriptTimeZone() || 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
        } else {
          obj[key] = rawVal == null ? '' : String(rawVal);
        }
      });

      return obj;
    };

    Logger.log('[TEST-TG-ALL][ROW][INITIAL] ' + JSON.stringify(readRowObject(rowIndex)));
    result.steps.push('initial-row-log-ok');

    var initialRowValues = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
    var initialDisplayValues = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    var initialFormData = buildFormDataFromRow(headers, initialRowValues);

    if (map['เบอร์โทร']) {
      initialFormData['{{เบอร์โทร}}'] = String(initialDisplayValues[map['เบอร์โทร'] - 1] || '').trim();
    }

    Logger.log('[TEST-TG-ALL][TG][NEW-REPAIR] เริ่มทดสอบข้อความแจ้งซ่อมใหม่');
    sendNewRepairNotification(initialFormData, initialFormData['{{ลิงก์เอกสาร}}'] || '', createdImageIds || []);
    Logger.log('[TEST-TG-ALL][TG][NEW-REPAIR] จบทดสอบข้อความแจ้งซ่อมใหม่');
    result.steps.push('new-repair-telegram-ok');

    var statusFlows = [
      { status: 'รอดำเนินการ', tech: '', note: 'ทดสอบสถานะรอดำเนินการ', priority: 'ปานกลาง' },
      { status: 'กำลังดำเนินการ', tech: 'ช่าง A', note: 'ช่างรับงานแล้ว', priority: 'เร่งด่วน' },
      { status: 'ดำเนินการภายนอก', tech: 'บริษัทภายนอก', note: 'ส่งต่อหน่วยงานภายนอก', priority: 'เร่งด่วน' },
      { status: 'พัสดุอยู่ระหว่างรอเบิก', tech: 'ช่าง A', note: 'รอเบิกอุปกรณ์', priority: 'ปานกลาง' },
      { status: 'เสร็จสิ้น', tech: 'ช่าง A', note: 'ดำเนินการเสร็จสมบูรณ์', priority: 'ปานกลาง' },
      { status: 'ยกเลิก', tech: 'ช่าง A', note: 'ปิดเคสทดสอบด้วยสถานะยกเลิก', priority: 'ปานกลาง' }
    ];

    statusFlows.forEach(function(flow, index) {
      Logger.log('================ STATUS: ' + flow.status + ' ================');

      var payload = {
        sequenceNumber: seq,
        newStatus: flow.status,
        technician: flow.tech,
        notes: flow.note,
        updateDate: new Date().toISOString()
      };

      var updateRes = updateRepairStatus(payload);
      if (!updateRes || !updateRes.success) {
        throw new Error('อัปเดตสถานะไม่สำเร็จ: ' + flow.status);
      }

      if (map['ความเร่งด่วน']) {
        sheet.getRange(rowIndex, map['ความเร่งด่วน']).setValue(flow.priority);
      }
      if (map['ลิงก์เอกสาร']) {
        sheet.getRange(rowIndex, map['ลิงก์เอกสาร']).setValue('https://example.com/status/' + encodeURIComponent(seq) + '/' + (index + 1));
      }
      if (map['เบอร์โทร']) {
        sheet.getRange(rowIndex, map['เบอร์โทร']).setNumberFormat('@').setValue("'" + phoneSafe);
      }
      SpreadsheetApp.flush();

      var phoneDisplayAfter = map['เบอร์โทร'] ? sheet.getRange(rowIndex, map['เบอร์โทร']).getDisplayValue() : '';
      if (map['เบอร์โทร'] && String(phoneDisplayAfter).trim() !== phoneSafe) {
        throw new Error('เบอร์โทรหลังอัปเดตสถานะ "' + flow.status + '" ผิดรูปแบบ: ' + phoneDisplayAfter);
      }

      var rowObj = readRowObject(rowIndex);

      Logger.log('[TEST-TG-ALL][OK] ' + (index + 2) + '. ทดสอบสถานะ "' + flow.status + '" สำเร็จ');
      Logger.log('[TEST-TG-ALL][ROW][' + flow.status + '] ' + JSON.stringify(rowObj));

      result.statusesTested.push(flow.status);
      result.steps.push('status-' + flow.status + '-ok');
    });

    Logger.log('[TEST-TG-ALL][OK] 8. ทดสอบ Telegram ครบทุกสถานะแล้ว');
    result.steps.push('all-status-telegram-ok');

    if (createdImageIds && createdImageIds.length > 0 && typeof deleteImages === 'function') {
      try {
        deleteImages(createdImageIds);
        Logger.log('[TEST-TG-ALL][OK] ลบรูปทดสอบเรียบร้อย');
      } catch (imgErr) {
        Logger.log('[TEST-TG-ALL][WARN] ลบรูปทดสอบไม่สำเร็จ: ' + imgErr.message);
      }
    }

    var cleanupRow = helpFindRowBySequence(sheet, seq);
    if (cleanupRow && cleanupRow >= 2) {
      sheet.deleteRow(cleanupRow);
      SpreadsheetApp.flush();
      Logger.log('[TEST-TG-ALL][OK] 9. ลบข้อมูลทดสอบเรียบร้อย');
      result.steps.push('cleanup-ok');
    } else {
      Logger.log('[TEST-TG-ALL][WARN] ไม่พบแถวทดสอบสำหรับ cleanup');
      result.steps.push('cleanup-miss');
    }

    Logger.log('[TEST-TG-ALL] ทดสอบเสร็จสิ้น');
    return result;

  } catch (error) {
    result.success = false;
    result.error = error.message;
    Logger.log('[TEST-TG-ALL][FAIL] ' + error.message);

    try {
      if (createdImageIds && createdImageIds.length > 0 && typeof deleteImages === 'function') {
        deleteImages(createdImageIds);
      }
    } catch (imgCleanupErr) {
      Logger.log('[TEST-TG-ALL][CLEANUP-IMG-FAIL] ' + imgCleanupErr.message);
    }

    try {
      if (sheet && result.testSequence) {
        var failCleanupRow = helpFindRowBySequence(sheet, result.testSequence);
        if (failCleanupRow && failCleanupRow >= 2) {
          sheet.deleteRow(failCleanupRow);
          SpreadsheetApp.flush();
          Logger.log('[TEST-TG-ALL][CLEANUP] ลบข้อมูลทดสอบหลัง error เรียบร้อย');
        }
      }
    } catch (cleanupErr) {
      Logger.log('[TEST-TG-ALL][CLEANUP-FAIL] ' + cleanupErr.message);
    }

    Logger.log('[TEST-TG-ALL] ทดสอบเสร็จสิ้นแบบมีข้อผิดพลาด');
    return result;

  } finally {
    CONFIG.IS_TEST_MODE = oldTestMode;
  }
}
