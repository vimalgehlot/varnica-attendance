// ============================================================
// VARNICA JEWELS — Master Control Script v2.0
// Google Apps Script
// Developer: Vimal Gehlot
// 
// Sheet Name: MASTER_CONTROL
// Columns: TOOL_ID | TOOL_NAME | STATUS | EXPIRY | NOTES
// ============================================================

function doGet(e) {
  try {
    var toolId = e.parameter.tool;
    
    if (!toolId) {
      return ContentService
        .createTextOutput(JSON.stringify({ 
          status: 'error', 
          message: 'No tool parameter provided' 
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    var sheet = SpreadsheetApp
      .getActiveSpreadsheet()
      .getSheetByName('Sheet1');
    
    if (!sheet) {
      return ContentService
        .createTextOutput(JSON.stringify({ 
          status: 'error', 
          message: 'Sheet1 not found' 
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    var data = sheet.getDataRange().getValues();
    
    // Loop through rows (skip header rows)
    for (var i = 1; i < data.length; i++) {
      var rowToolId   = String(data[i][0]).trim();
      var rowToolName = String(data[i][1]).trim();
      var rowStatus   = String(data[i][2]).trim().toLowerCase();
      var rowExpiry   = data[i][3];
      var rowNotes    = String(data[i][4]).trim();
      
      // Match by TOOL_ID or TOOL_NAME
      if (rowToolId === toolId || rowToolName === toolId) {
        
        // Check expiry date
        var expiryStr = '';
        var isExpired = false;
        
        if (rowExpiry instanceof Date) {
          expiryStr = rowExpiry.toISOString().split('T')[0]; // YYYY-MM-DD
          isExpired = rowExpiry < new Date();
        } else {
          expiryStr = String(rowExpiry);
        }
        
        // Final status check
        var finalStatus = rowStatus;
        if (isExpired) {
          finalStatus = 'expired';
        }
        
        var result = {
          tool_id:   rowToolId,
          tool_name: rowToolName,
          status:    finalStatus,
          expiry:    expiryStr,
          notes:     rowNotes,
          checked:   new Date().toISOString()
        };
        
        return ContentService
          .createTextOutput(JSON.stringify(result))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
    
    // Tool not found
    return ContentService
      .createTextOutput(JSON.stringify({ 
        status: 'not_found',
        message: 'Tool not found: ' + toolId
      }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ 
        status: 'error', 
        message: err.toString() 
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// TEST FUNCTION — Run this manually to test
// ============================================================
function testLicenseCheck() {
  var mockEvent = { parameter: { tool: 'varnica-attendance' } };
  var result = doGet(mockEvent);
  Logger.log(result.getContent());
}
