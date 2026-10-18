function archiveOldAppointments() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("appointment");
  var archiveSheet = ss.getSheetByName("appointment_archive");

  // If archive sheet doesn’t exist, create it and copy headers
  if (!archiveSheet) {
    archiveSheet = ss.insertSheet("appointment_archive");
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    archiveSheet.appendRow(headers);
  }

  var dataRange = sheet.getDataRange();
  var data = dataRange.getValues();
  var headers = data.shift(); // remove header row
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var rowsToArchive = [];

  // Identify rows to archive
  for (var i = 0; i < data.length; i++) {
    var cell = data[i][1]; // column B (zero-based index 1)
    if (cell instanceof Date) {
      var apptDate = new Date(cell);
      apptDate.setHours(0, 0, 0, 0);
      if (apptDate <= today) {
        rowsToArchive.push({ index: i + 2, values: data[i] });
      }
    }
  }

  // Move rows to archive sheet
  rowsToArchive.forEach(function (row) {
    archiveSheet.appendRow(row.values);
  });

  // Delete rows from bottom to top
  for (var j = rowsToArchive.length - 1; j >= 0; j--) {
    sheet.deleteRow(rowsToArchive[j].index);
  }

  // Now fix duplicates
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var idRange = sheet.getRange(2, 1, lastRow - 1, 1);
    var idValues = idRange.getValues();
    var seen = {}; // track every ID that ends up in the sheet

    for (var k = 0; k < idValues.length; k++) {
      var original = idValues[k][0];
      // first time: just record it
      if (!seen[original]) {
        seen[original] = true;
        continue;
      }

      // on any further duplicate, build a unique suffix
      var newId, suffix;
      do {
        suffix = ("0000" + Math.floor(Math.random() * 10000)).slice(-4);
        newId = original + "_" + suffix;
      } while (seen[newId]);

      // record and write back
      seen[newId] = true;
      idValues[k][0] = newId;
    }

    idRange.setValues(idValues);
  }
}
