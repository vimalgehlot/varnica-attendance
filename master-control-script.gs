// ═══════════════════════════════════════════════════════
// VARNICA JEWELS — MASTER CONTROL SCRIPT
// Developer: Vimal Gehlot
// Deploy this in your PRIVATE Google Sheet
// ═══════════════════════════════════════════════════════

function doGet(e) {
  const toolId = e.parameter.tool || '';
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Initialize sheet if needed
  initSheet(ss);
  
  const sh = ss.getSheetByName('MASTER_CONTROL');
  const data = sh.getDataRange().getValues();
  
  // Find tool row (skip header)
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === toolId) {
      const status = data[i][2]; // Column C: Status
      const expiry = data[i][3]; // Column D: Expiry Date
      const clientName = data[i][1]; // Column B: Client
      
      const today = new Date();
      const expiryDate = new Date(expiry);
      
      // Check if expired
      if (status !== 'ACTIVE') {
        return jsonResponse({ status: 'INACTIVE', message: 'Tool is inactive. Contact Vimal Gehlot.' });
      }
      
      if (expiryDate < today) {
        // Auto-update status to EXPIRED
        sh.getRange(i+1, 3).setValue('EXPIRED');
        return jsonResponse({ status: 'EXPIRED', message: 'License expired on ' + formatDate(expiryDate) + '. Contact Vimal Gehlot to renew.' });
      }
      
      // Log access
      logAccess(ss, toolId, clientName);
      
      return jsonResponse({
        status: 'ACTIVE',
        client: clientName,
        expiry: formatDate(expiryDate),
        daysLeft: Math.ceil((expiryDate - today) / 86400000)
      });
    }
  }
  
  return jsonResponse({ status: 'NOT_FOUND', message: 'Tool not registered. Contact Vimal Gehlot.' });
}

function doPost(e) {
  // Handle attendance data sync from tool
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    
    if (data.action === 'punch') {
      const sh = ss.getSheetByName('LIVE_ATTENDANCE') || ss.insertSheet('LIVE_ATTENDANCE');
      
      // Add headers if empty
      if (sh.getLastRow() === 0) {
        sh.getRange(1,1,1,9).setValues([['Date','Staff Name','IN Time','OUT Time','Status','Hours','Method','Reason','Absent Reason']]);
        sh.getRange(1,1,1,9).setFontWeight('bold').setBackground('#F2E4DA');
      }
      
      // Check if record exists (update) or add new
      const existing = sh.getDataRange().getValues();
      let foundRow = -1;
      for (let i = 1; i < existing.length; i++) {
        if (existing[i][0] === data.date && existing[i][1] === data.staffName) {
          foundRow = i + 1; break;
        }
      }
      
      const row = [data.date, data.staffName, data.inTime||'', data.outTime||'', data.status, data.hours||0, data.method||'face', data.reason||'', data.absentReason||''];
      
      if (foundRow > 0) {
        sh.getRange(foundRow, 1, 1, 9).setValues([row]);
      } else {
        sh.appendRow(row);
        foundRow = sh.getLastRow();
      }
      
      // Color code by status
      colorRow(sh, foundRow, data.status);
    }
    
    if (data.action === 'staff_sync') {
      const sh = ss.getSheetByName('STAFF_MASTER') || ss.insertSheet('STAFF_MASTER');
      sh.clearContents();
      sh.getRange(1,1,1,5).setValues([['Name','Role','Shift IN','Shift OUT','Face Registered']]);
      sh.getRange(1,1,1,5).setFontWeight('bold').setBackground('#F2E4DA');
      data.staff.forEach(s => sh.appendRow([s.name, s.role||'', s.shiftIn, s.shiftOut, s.hasFace?'Yes':'No']));
    }
    
    return ContentService.createTextOutput(JSON.stringify({success:true})).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({success:false,error:err.toString()})).setMimeType(ContentService.MimeType.JSON);
  }
}

function initSheet(ss) {
  let sh = ss.getSheetByName('MASTER_CONTROL');
  if (!sh) {
    sh = ss.insertSheet('MASTER_CONTROL');
    // Headers
    sh.getRange(1,1,1,7).setValues([['Tool ID','Client Name','Status','Expiry Date','Created','Last Accessed','Notes']]);
    sh.getRange(1,1,1,7).setFontWeight('bold').setBackground('#5C4220').setFontColor('#F8EEE8');
    // Add Varnica sample row
    sh.appendRow(['varnica-attendance-v1','Varnica Jewels','ACTIVE',new Date(new Date().getFullYear(), 11, 31),new Date(),'','']);
    sh.getRange(2,1,1,7).setBackground('#EBF5EE');
    sh.setColumnWidths(1, 7, 150);
    sh.setFrozenRows(1);
  }
  
  // Ensure attendance sheet exists
  if (!ss.getSheetByName('LIVE_ATTENDANCE')) ss.insertSheet('LIVE_ATTENDANCE');
  if (!ss.getSheetByName('STAFF_MASTER')) ss.insertSheet('STAFF_MASTER');
  if (!ss.getSheetByName('ACCESS_LOG')) ss.insertSheet('ACCESS_LOG');
}

function logAccess(ss, toolId, client) {
  let sh = ss.getSheetByName('ACCESS_LOG');
  if (!sh) sh = ss.insertSheet('ACCESS_LOG');
  if (sh.getLastRow() === 0) {
    sh.getRange(1,1,1,4).setValues([['Timestamp','Tool ID','Client','IP/Info']]);
    sh.getRange(1,1,1,4).setFontWeight('bold').setBackground('#F2E4DA');
  }
  sh.appendRow([new Date(), toolId, client, 'Web Access']);
  
  // Update last accessed in master
  const master = ss.getSheetByName('MASTER_CONTROL');
  const data = master.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === toolId) {
      master.getRange(i+1, 6).setValue(new Date());
      break;
    }
  }
}

function colorRow(sh, row, status) {
  const colors = {
    'Present': '#EBF5EE', 'Late': '#FEF3E2', 'Absent': '#FCECEA',
    'Half Day': '#FEF3E2', 'Overtime': '#EAF0F8', 'Early Out': '#EAF0F8',
    'Week Off': '#F8EEE8', 'Holiday': '#F8EEE8'
  };
  sh.getRange(row, 1, 1, 9).setBackground(colors[status] || '#FFFFFF');
}

function formatDate(d) {
  return d.toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'});
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════
// MONTHLY REPORT GENERATOR (run manually or on schedule)
// ═══════════════════════════════════════════════════════
function generateMonthlyReport() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const attSh = ss.getSheetByName('LIVE_ATTENDANCE');
  if (!attSh || attSh.getLastRow() < 2) { Logger.log('No attendance data'); return; }
  
  const now = new Date();
  const reportName = 'REPORT_' + now.getFullYear() + '_' + String(now.getMonth()+1).padStart(2,'0');
  
  let reportSh = ss.getSheetByName(reportName);
  if (reportSh) ss.deleteSheet(reportSh);
  reportSh = ss.insertSheet(reportName);
  
  const att = attSh.getDataRange().getValues().slice(1);
  const staffMap = {};
  
  att.forEach(row => {
    const name = row[1], status = row[4];
    if (!staffMap[name]) staffMap[name] = {present:0, absent:0, late:0, halfDay:0, overtime:0, earlyOut:0, totalHrs:0};
    const s = staffMap[name];
    if (status === 'Present') s.present++;
    else if (status === 'Absent') s.absent++;
    else if (status === 'Late') { s.late++; s.present++; }
    else if (status === 'Half Day') s.halfDay++;
    else if (status === 'Overtime') { s.overtime++; s.present++; }
    else if (status === 'Early Out') { s.earlyOut++; s.present++; }
    s.totalHrs += parseFloat(row[5]) || 0;
  });
  
  reportSh.getRange(1,1,1,8).setValues([['Staff Name','Present','Absent','Late','Half Day','Overtime','Early Out','Total Hrs']]);
  reportSh.getRange(1,1,1,8).setFontWeight('bold').setBackground('#5C4220').setFontColor('#F8EEE8');
  
  Object.entries(staffMap).forEach(([name, s]) => {
    reportSh.appendRow([name, s.present, s.absent, s.late, s.halfDay, s.overtime, s.earlyOut, s.totalHrs.toFixed(1)]);
  });
  
  Logger.log('Monthly report generated: ' + reportName);
}
