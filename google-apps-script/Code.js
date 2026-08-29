var SHEET_ID         = '15-XKZxNEVEf60scgGw3HNhWSPd5l663E1jQw7CsWQlI';
var SQUARE_TOKEN     = PropertiesService.getScriptProperties().getProperty('SQUARE_TOKEN');
var WAIVER_FOLDER_ID = '1iSuxU2UoKCZzm4R-s_sNiVY10Ni7wkEL';
var TEAM_EMAIL_TO    = 'admin@powerhousearmwrestling.com.au';
var TEAM_EMAIL_CC    = 'president@powerhousearmwrestling.com.au';
var CASH_APPROVER_EMAILS = ['ethevejay@gmail.com', 'admin@powerhousearmwrestling.com.au'];
var PENDING_CASH_SHEET = 'Pending Cash';

var IS_SANDBOX = false;
var SQ_BASE    = IS_SANDBOX
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

/* SERVER-SIDE PRICING (source of truth - frontend amount is never trusted) */
var PRICES               = { yearly: 19200 };
var TSHIRT_PRICE         = 5000;
var ALLOWED_TSHIRT_SIZES = ['Small', 'Medium', 'Large', 'XL', 'XXL', 'XXXL', 'XXXXL'];
var EXPECTED_LOCATION_ID = 'LRE1Q97A62XVE';


function computeServerPrice(data) {
  if (data.membership_type === 'test') {
    throw new Error('Test membership type is not accepted.');
  }
  var baseAmount = PRICES[data.membership_type];
  if (baseAmount === undefined) {
    throw new Error('Invalid membership_type: ' + data.membership_type);
  }
  var tshirtAmount = 0;
  if (data.join_type === 'renewing' && data.tshirt_size) {
    tshirtAmount = TSHIRT_PRICE;
  }
  return { baseAmount: baseAmount, tshirtAmount: tshirtAmount, total: baseAmount + tshirtAmount };
}

var MEMBER_HEADERS = [
  'Timestamp',
  'First Name',
  'Last Name',
  'Email',
  'Phone',
  'DOB',
  'Join Type',
  'Membership',
  'T-Shirt Size',
  'EC Name',
  'EC Phone',
  'Payment ID',
  'Amount',
  'Member Signed',
  'EC Signed',
  'Marketing Opt-In',
  'Payment Method',
  'Application ID'
];

var PENDING_CASH_HEADERS = [
  'Application ID', 'Submitted', 'Status', 'Cash Received', 'Confirmed At',
  'Member Row', 'PDF ID', 'Member Email Sent', 'Team Email Sent', 'Signature File ID',
  'First Name', 'Last Name', 'Email', 'Phone', 'DOB', 'Join Type', 'Membership',
  'T-Shirt Size', 'EC First Name', 'EC Last Name', 'EC Phone', 'Amount Due',
  'Date Signed', 'Member Signed', 'Marketing Opt-In', 'Last Error'
];

/* HELPERS */

function fmtDate(isoDate) {
  if (!isoDate) return '';
  var p = isoDate.toString().split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : isoDate;
}

function fmtPhone(phone) {
  if (!phone) return '';
  var p = phone.toString().replace(/\s/g, '');
  return p.charAt(0) !== '0' ? '0' + p : p;
}

function fmtAmount(amountCents) {
  return '$' + (Number(amountCents || 0) / 100).toFixed(2);
}

function yesNo(value) {
  return value ? 'Yes' : 'No';
}

function fullName(first, last) {
  return ((first || '') + ' ' + (last || '')).trim();
}

function logError(context, err, extra) {
  var msg = 'ERROR in ' + context + ': ' + (err && err.message ? err.message : String(err));
  Logger.log(msg);
  if (err && err.stack) Logger.log(err.stack);
  if (extra) {
    try { Logger.log('Context: ' + JSON.stringify(extra)); } catch (e) {}
  }
  console.error(msg);
}

function runStep(name, fn, warnings) {
  try {
    fn();
  } catch (err) {
    logError(name, err);
    warnings.push(name + ' failed: ' + (err && err.message ? err.message : String(err)));
  }
}

function cleanEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function res(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ENDPOINTS */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Missing POST body.');
    }

    var data = JSON.parse(e.postData.contents);

    if (data.request_type === 'cash_application' || data.payment_method === 'cash') {
      return res(processCashApplication(data));
    }

    if (!SQUARE_TOKEN) {
      throw new Error('SQUARE_TOKEN not configured in Script Properties.');
    }

    // Location ID guard - must match our Square location
    if (data.location_id !== EXPECTED_LOCATION_ID) {
      Logger.log('LOCATION MISMATCH: received ' + data.location_id);
      return res({ success: false, error: 'Invalid location. Please refresh and try again.' });
    }

    if (data.request_type === 'donation') {
      return res(processDonation(data));
    }

    // join_type guard
    if (data.join_type !== 'new' && data.join_type !== 'renewing') {
      Logger.log('INVALID JOIN TYPE: received ' + data.join_type);
      return res({ success: false, error: 'Invalid join type. Please refresh and try again.' });
    }

    var pricing      = computeServerPrice(data);
    var serverAmount = pricing.total;

    if (Number(data.amount_cents) !== serverAmount) {
      Logger.log('PRICE MISMATCH: frontend sent ' + data.amount_cents + ', server computed ' + serverAmount);
      return res({ success: false, error: 'The payment amount changed. Please refresh and try again.' });
    }

    // T-shirt size validation
    if (data.join_type === 'new') {
      if (!data.tshirt_size) {
        return res({ success: false, error: 'T-shirt size is required for new members.' });
      }
      if (ALLOWED_TSHIRT_SIZES.indexOf(data.tshirt_size) === -1) {
        return res({ success: false, error: 'Invalid t-shirt size.' });
      }
    }
    if (data.join_type === 'renewing' && data.tshirt_size) {
      if (ALLOWED_TSHIRT_SIZES.indexOf(data.tshirt_size) === -1) {
        return res({ success: false, error: 'Invalid t-shirt size.' });
      }
    }

    var payResult = chargeSquare(
      data.nonce,
      serverAmount,
      data.idempotency_key,
      data.location_id
    );

    if (!payResult.success) {
      return res({ success: false, error: payResult.error });
    }

    var warnings = [];

    // writeToSheet is critical - failure triggers urgent admin alert
    try {
      writeToSheet(data, payResult.payment_id);
    } catch (sheetErr) {
      logError('writeToSheet', sheetErr);
      try {
        MailApp.sendEmail({
          to:      TEAM_EMAIL_TO,
          cc:      TEAM_EMAIL_CC,
          subject: 'URGENT: Payment succeeded but Sheet write failed - ' + fullName(data.first_name, data.last_name),
          body:
            'PAYMENT SUCCEEDED BUT SHEET WRITE FAILED\n\n' +
            'Square has charged the member. The row was NOT written to the Google Sheet.\n' +
            'You must add this member manually.\n\n' +
            'Name:       ' + fullName(data.first_name, data.last_name) + '\n' +
            'Email:      ' + (data.email || '') + '\n' +
            'Phone:      ' + fmtPhone(data.phone) + '\n' +
            'Amount:     ' + fmtAmount(data.amount_cents) + '\n' +
            'Payment ID: ' + payResult.payment_id + '\n' +
            'Error:      ' + (sheetErr && sheetErr.message ? sheetErr.message : String(sheetErr)) + '\n\n' +
            'Powerhouse Armwrestling Club',
          name: 'Powerhouse Memberships'
        });
      } catch (alertErr) {
        logError('sheetFailAlert', alertErr);
      }
      warnings.push('writeToSheet failed: ' + (sheetErr && sheetErr.message ? sheetErr.message : String(sheetErr)));
    }

    runStep('notifyMember',       function () { notifyMember(data, payResult.payment_id); },       warnings);
    runStep('generateAndSavePDF', function () { generateAndSavePDF(data, payResult.payment_id); }, warnings);
    runStep('notifyTeam',         function () { notifyTeam(data, payResult.payment_id); },         warnings);

    return res({ success: true, payment_id: payResult.payment_id, warnings: warnings });

  } catch (err) {
    logError('doPost', err);
    return res({ success: false, error: err && err.message ? err.message : String(err) });
  }
}

function doGet(e) {
  try {
    var sheet     = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    var hasHeader = !sheet.getRange(1, 1).isBlank();
    var count     = hasHeader ? Math.max(0, sheet.getLastRow() - 1) : 0;
    return res({ count: count });
  } catch (err) {
    logError('doGet', err);
    return res({ count: 0, error: err && err.message ? err.message : String(err) });
  }
}

/* CASH APPLICATIONS
   A cash application is deliberately stored outside the Members sheet. It only
   becomes an active membership after an authorised person ticks Cash Received. */

function validateMembershipSubmission(data) {
  if (data.join_type !== 'new' && data.join_type !== 'renewing') {
    throw new Error('Invalid join type. Please refresh and try again.');
  }
  ['first_name', 'last_name', 'email', 'phone', 'dob', 'sig_date', 'ec_first_name', 'ec_last_name', 'ec_phone'].forEach(function (field) {
    if (!String(data[field] || '').trim()) throw new Error('Missing required membership field: ' + field + '.');
  });
  if (!data.member_signed || !data.member_sig_png || data.member_sig_png.indexOf('data:image/png;base64,') !== 0) {
    throw new Error('A signed waiver is required.');
  }
  var pricing = computeServerPrice(data);
  if (Number(data.amount_cents) !== pricing.total) {
    throw new Error('The membership amount changed. Please refresh and try again.');
  }
  if ((data.join_type === 'new' || data.tshirt_size) && ALLOWED_TSHIRT_SIZES.indexOf(data.tshirt_size) === -1) {
    throw new Error('A valid T-shirt size is required.');
  }
  return pricing;
}

function getPendingCashSheet() {
  var book = SpreadsheetApp.openById(SHEET_ID);
  var sheet = book.getSheetByName(PENDING_CASH_SHEET) || book.insertSheet(PENDING_CASH_SHEET);
  if (sheet.getRange(1, 1).isBlank()) {
    sheet.getRange(1, 1, 1, PENDING_CASH_HEADERS.length).setValues([PENDING_CASH_HEADERS]);
    sheet.getRange(1, 1, 1, PENDING_CASH_HEADERS.length)
      .setFontWeight('bold').setBackground('#1c1a16').setFontColor('#C9A234');
    sheet.setFrozenRows(1);
    sheet.getRange(2, 4, Math.max(sheet.getMaxRows() - 1, 1), 1).insertCheckboxes();
  }
  return sheet;
}

function findCashApplicationRow(sheet, applicationId) {
  if (sheet.getLastRow() < 2) return 0;
  var match = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(applicationId)).matchEntireCell(true).findNext();
  return match ? match.getRow() : 0;
}

function savePendingSignature(data) {
  var b64 = data.member_sig_png.replace(/^data:image\/png;base64,/, '');
  var blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/png', 'cash-' + data.application_id + '-signature.png');
  return DriveApp.getFolderById(WAIVER_FOLDER_ID).createFile(blob).getId();
}

function processCashApplication(data) {
  validateMembershipSubmission(data);
  if (!/^[A-Za-z0-9-]{12,80}$/.test(String(data.application_id || ''))) {
    throw new Error('Invalid cash application ID. Please refresh and try again.');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getPendingCashSheet();
    var existingRow = findCashApplicationRow(sheet, data.application_id);
    if (existingRow) {
      return { success: true, pending: true, application_id: data.application_id };
    }

    var signatureFileId = savePendingSignature(data);
    var row = [
      data.application_id,
      Utilities.formatDate(new Date(), 'Australia/Brisbane', 'dd/MM/yyyy HH:mm'),
      'Pending cash payment', false, '', '', '', false, false, signatureFileId,
      data.first_name, data.last_name, cleanEmail(data.email), fmtPhone(data.phone), data.dob,
      data.join_type, data.membership_type, data.tshirt_size || '', data.ec_first_name,
      data.ec_last_name, fmtPhone(data.ec_phone), Number(data.amount_cents), data.sig_date,
      true, Boolean(data.marketing_opt_in), ''
    ];
    sheet.appendRow(row);
    var warnings = [];
    runStep('notifyCashApplicationMember', function () { notifyCashApplicationMember(data); }, warnings);
    runStep('notifyCashApplicationTeam', function () { notifyCashApplicationTeam(data, sheet.getLastRow()); }, warnings);
    return { success: true, pending: true, application_id: data.application_id, warnings: warnings };
  } finally {
    lock.releaseLock();
  }
}

function notifyCashApplicationMember(data) {
  MailApp.sendEmail({
    to: cleanEmail(data.email),
    subject: 'Powerhouse cash membership application received',
    body:
      'Hi ' + data.first_name + ',\n\n' +
      'We have saved your signed membership application. Your membership is still pending.\n\n' +
      'Amount due in cash: ' + fmtAmount(data.amount_cents) + '\n' +
      'Please pay Jay or an authorised Powerhouse club officer at training. After the club verifies the cash payment, we will activate your membership and send your final confirmation.\n\n' +
      'Powerhouse Armwrestling Club',
    name: 'Powerhouse Armwrestling Club',
    replyTo: TEAM_EMAIL_TO
  });
}

function notifyCashApplicationTeam(data, rowNumber) {
  MailApp.sendEmail({
    to: TEAM_EMAIL_TO,
    cc: TEAM_EMAIL_CC,
    subject: 'Cash membership awaiting payment: ' + fullName(data.first_name, data.last_name),
    body:
      'A signed cash membership application is waiting for verification.\n\n' +
      'Name: ' + fullName(data.first_name, data.last_name) + '\n' +
      'Amount due: ' + fmtAmount(data.amount_cents) + '\n' +
      'T-shirt size: ' + (data.tshirt_size || 'N/A') + '\n' +
      'Pending Cash sheet row: ' + rowNumber + '\n\n' +
      'Only tick Cash Received after the money has actually been received.',
    name: 'Powerhouse Memberships'
  });
}

function pendingRowToData(values) {
  return {
    application_id: values[0], first_name: values[10], last_name: values[11], email: values[12],
    phone: values[13], dob: values[14], join_type: values[15], membership_type: values[16],
    tshirt_size: values[17], ec_first_name: values[18], ec_last_name: values[19], ec_phone: values[20],
    amount_cents: Number(values[21]), sig_date: values[22], member_signed: Boolean(values[23]),
    ec_signed: false, marketing_opt_in: Boolean(values[24]), payment_method: 'cash'
  };
}

function loadPendingSignature(fileId) {
  var blob = DriveApp.getFileById(fileId).getBlob();
  return 'data:image/png;base64,' + Utilities.base64Encode(blob.getBytes());
}

function findActiveMemberRowByApplicationId(applicationId) {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  ensureHeaders(sheet);
  if (sheet.getLastRow() < 2) return 0;
  var match = sheet.getRange(2, 18, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(applicationId)).matchEntireCell(true).findNext();
  return match ? match.getRow() : 0;
}

function handleCashApprovalEdit(e) {
  if (!e || !e.range || e.range.getSheet().getName() !== PENDING_CASH_SHEET ||
      e.range.getColumn() !== 4 || e.range.getRow() < 2 || e.value !== 'TRUE') return;
  var actor = e.user && e.user.getEmail ? cleanEmail(e.user.getEmail()) : '';
  if (actor && CASH_APPROVER_EMAILS.indexOf(actor) === -1) {
    e.range.setValue(false);
    throw new Error('This account is not authorised to confirm cash payments.');
  }
  approveCashApplication(e.range.getRow());
}

function approveCashApplication(rowNumber) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var sheet = getPendingCashSheet();
  try {
    var range = sheet.getRange(rowNumber, 1, 1, PENDING_CASH_HEADERS.length);
    var values = range.getValues()[0];
    if (!values[0]) throw new Error('No cash application exists on row ' + rowNumber + '.');
    if (values[2] === 'Complete') return;
    sheet.getRange(rowNumber, 3).setValue('Processing');
    sheet.getRange(rowNumber, 26).clearContent();

    var data = pendingRowToData(values);
    data.member_sig_png = loadPendingSignature(values[9]);
    var paymentId = 'CASH-' + data.application_id;

    if (!values[5]) {
      values[5] = findActiveMemberRowByApplicationId(data.application_id) || writeToSheet(data, paymentId);
      sheet.getRange(rowNumber, 6).setValue(values[5]);
    }
    if (!values[6]) {
      values[6] = generateAndSavePDF(data, paymentId);
      sheet.getRange(rowNumber, 7).setValue(values[6]);
    }
    if (!values[7]) {
      notifyMember(data, paymentId);
      sheet.getRange(rowNumber, 8).setValue(true);
    }
    if (!values[8]) {
      notifyTeam(data, paymentId);
      sheet.getRange(rowNumber, 9).setValue(true);
    }

    sheet.getRange(rowNumber, 3).setValue('Complete');
    sheet.getRange(rowNumber, 5).setValue(Utilities.formatDate(new Date(), 'Australia/Brisbane', 'dd/MM/yyyy HH:mm'));
  } catch (err) {
    sheet.getRange(rowNumber, 3).setValue('Approval error');
    sheet.getRange(rowNumber, 26).setValue(err.message || String(err));
    logError('approveCashApplication', err, { rowNumber: rowNumber });
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function setupCashWorkflow() {
  var sheet = getPendingCashSheet();
  var protection = sheet.getRange('D:D').protect().setDescription('Cash confirmation - authorised approvers only');
  protection.setWarningOnly(false);
  CASH_APPROVER_EMAILS.forEach(function (email) {
    try { protection.addEditor(email); } catch (err) { logError('add cash approver ' + email, err); }
  });
  if (protection.canDomainEdit()) protection.setDomainEdit(false);

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'handleCashApprovalEdit') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('handleCashApprovalEdit')
    .forSpreadsheet(SpreadsheetApp.openById(SHEET_ID))
    .onEdit()
    .create();
  Logger.log('Cash workflow ready. Tick column D only after cash has been received.');
}

function processDonation(data) {
  var amount = Number(data.amount_cents);
  if (!isFinite(amount) || Math.floor(amount) !== amount || amount < 100 || amount > 700000) {
    throw new Error('Donation amount must be between $1 and $7,000.');
  }
  if (!data.nonce || !data.idempotency_key) throw new Error('Missing secure payment details.');

  var payResult = chargeSquare(
    data.nonce,
    amount,
    data.idempotency_key,
    data.location_id,
    'Powerhouse Armwrestling - Donation'
  );
  if (!payResult.success) return { success: false, error: payResult.error };

  var warnings = [];
  runStep('writeDonationToSheet', function () {
    var book = SpreadsheetApp.openById(SHEET_ID);
    var sheet = book.getSheetByName('Donations') || book.insertSheet('Donations');
    var headers = ['Timestamp', 'Name', 'Email', 'Amount', 'Payment ID', 'Message'];
    if (sheet.getRange(1, 1).isBlank()) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1c1a16').setFontColor('#C9A234');
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([
      Utilities.formatDate(new Date(), 'Australia/Brisbane', 'dd/MM/yyyy HH:mm'),
      String(data.donor_name || '').slice(0, 120), cleanEmail(data.donor_email),
      fmtAmount(amount), payResult.payment_id, String(data.message || '').slice(0, 500)
    ]);
  }, warnings);

  var donorEmail = cleanEmail(data.donor_email);
  if (donorEmail) {
    runStep('notifyDonor', function () {
      MailApp.sendEmail({
        to: donorEmail,
        subject: 'Thank you for supporting Powerhouse Armwrestling',
        body:
          'Hi ' + (String(data.donor_name || '').trim() || 'there') + ',\n\n' +
          'Thank you for your contribution of ' + fmtAmount(amount) + ' to Powerhouse Armwrestling Club. Your support helps us fund equipment, events and opportunities for the armwrestling community.\n\n' +
          'Payment reference: ' + payResult.payment_id + '\n\n' +
          'This acknowledgement is not a tax-deductible gift receipt.\n\n' +
          'Powerhouse Armwrestling Club',
        name: 'Powerhouse Armwrestling Club', replyTo: TEAM_EMAIL_TO
      });
    }, warnings);
  }

  runStep('notifyDonationTeam', function () {
    MailApp.sendEmail({
      to: TEAM_EMAIL_TO, cc: TEAM_EMAIL_CC,
      subject: 'New Powerhouse contribution: ' + fmtAmount(amount),
      body:
        'A contribution has been received.\n\n' +
        'Name: ' + (data.donor_name || 'Not supplied') + '\n' +
        'Email: ' + (donorEmail || 'Not supplied') + '\n' +
        'Amount: ' + fmtAmount(amount) + '\n' +
        'Payment ID: ' + payResult.payment_id + '\n' +
        'Message: ' + (data.message || 'None'),
      name: 'Powerhouse Donations'
    });
  }, warnings);

  return { success: true, payment_id: payResult.payment_id, warnings: warnings };
}

/* SQUARE */

function chargeSquare(nonce, amountCents, idempotencyKey, locationId, note) {
  var resp = UrlFetchApp.fetch(SQ_BASE + '/v2/payments', {
    method:  'POST',
    headers: {
      'Authorization':  'Bearer ' + SQUARE_TOKEN,
      'Content-Type':   'application/json',
      'Square-Version': '2025-01-23'
    },
    payload: JSON.stringify({
      source_id:       nonce,
      idempotency_key: idempotencyKey,
      location_id:     locationId,
      amount_money:    { amount: Number(amountCents), currency: 'AUD' },
      note:            note || 'Powerhouse Armwrestling - Membership'
    }),
    muteHttpExceptions: true
  });

  var statusCode = resp.getResponseCode();
  var result;
  try {
    result = JSON.parse(resp.getContentText());
  } catch (err) {
    throw new Error('Square returned invalid JSON. HTTP ' + statusCode);
  }

  if (result.payment && result.payment.status === 'COMPLETED') {
    return { success: true, payment_id: result.payment.id };
  }

  var msg = result.errors && result.errors.length
    ? result.errors[0].detail
    : 'Payment declined. HTTP ' + statusCode;
  return { success: false, error: msg };
}

/* GOOGLE SHEET */

function buildMemberRow(data, paymentId) {
  return [
    Utilities.formatDate(new Date(), 'Australia/Brisbane', 'dd/MM/yyyy HH:mm'),
    data.first_name || '',
    data.last_name  || '',
    data.email      || '',
    fmtPhone(data.phone),
    fmtDate(data.dob),
    data.join_type === 'renewing' ? 'Renewing' : 'New',
    data.membership_type || '',
    data.tshirt_size     || '',
    fullName(data.ec_first_name, data.ec_last_name),
    fmtPhone(data.ec_phone),
    paymentId,
    fmtAmount(data.amount_cents),
    yesNo(data.member_signed),
    yesNo(data.ec_signed),
    yesNo(data.marketing_opt_in),
    data.payment_method === 'cash' ? 'Cash' : 'Card',
    data.application_id || ''
  ];
}

function styleHeaderRow(sheet) {
  var r = sheet.getRange(1, 1, 1, MEMBER_HEADERS.length);
  r.setFontWeight('bold')
   .setFontSize(10)
   .setBackground('#1c1a16')
   .setFontColor('#C9A234')
   .setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 36);
  sheet.getRange('E:E').setNumberFormat('@');
  sheet.getRange('K:K').setNumberFormat('@');
}

function ensureHeaders(sheet) {
  if (sheet.getRange(1, 1).isBlank()) {
    sheet.getRange(1, 1, 1, MEMBER_HEADERS.length).setValues([MEMBER_HEADERS]);
    styleHeaderRow(sheet);
    Logger.log('Headers written to Members sheet.');
    return;
  }
  var current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  MEMBER_HEADERS.forEach(function (header, index) {
    if (current[index] !== header) {
      if (!current[index]) {
        sheet.getRange(1, index + 1).setValue(header);
      } else {
        throw new Error('Members sheet header mismatch at column ' + (index + 1) + ': expected "' + header + '".');
      }
    }
  });
  if (current.length < MEMBER_HEADERS.length) {
    styleHeaderRow(sheet);
  }
}

function writeToSheet(data, paymentId) {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  ensureHeaders(sheet);

  var row = buildMemberRow(data, paymentId);

  if (row.length !== MEMBER_HEADERS.length) {
    throw new Error(
      'Row/header length mismatch - headers: ' + MEMBER_HEADERS.length +
      ', row: ' + row.length
    );
  }

  var nextRow = sheet.getLastRow() + 1;
  sheet.getRange(nextRow, 1, 1, MEMBER_HEADERS.length).setValues([row]);
  sheet.getRange(nextRow, 5).setNumberFormat('@').setValue(row[4]);
  sheet.getRange(nextRow, 11).setNumberFormat('@').setValue(row[10]);

  Logger.log('Member row written. Row ' + nextRow + ' | Payment ID: ' + paymentId);
  return nextRow;
}

/* PDF GENERATION */

function generateAndSavePDF(data, paymentId) {
  var docId;
  var savedPdfId;
  try {
    var memberName = fullName(data.first_name, data.last_name) || 'Unnamed Member';
    var ecName     = fullName(data.ec_first_name, data.ec_last_name);
    var docName    = memberName + ' - ' +
      Utilities.formatDate(new Date(), 'Australia/Brisbane', 'dd-MM-yyyy');

    var folder = DriveApp.getFolderById(WAIVER_FOLDER_ID);
    var doc    = DocumentApp.create(docName);
    docId      = doc.getId();
    var body   = doc.getBody();

    body.setMarginTop(40);
    body.setMarginBottom(40);
    body.setMarginLeft(56);
    body.setMarginRight(56);

    var h1 = body.appendParagraph('POWERHOUSE ARMWRESTLING CLUB');
    h1.setHeading(DocumentApp.ParagraphHeading.HEADING1);
    h1.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    h1.editAsText().setFontSize(18).setBold(true);

    var sub = body.appendParagraph('Membership Application & Signed Waiver');
    sub.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    sub.editAsText().setFontSize(11).setItalic(true);

    body.appendParagraph('');
    body.appendHorizontalRule();

    var mh = body.appendParagraph('MEMBER DETAILS');
    mh.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    mh.editAsText().setFontSize(13).setBold(true);

    var details = [
      ['Full Name',       memberName],
      ['Date of Birth',   fmtDate(data.dob)],
      ['Phone',           fmtPhone(data.phone)],
      ['Email',           data.email || ''],
      ['Join Type',       data.join_type === 'renewing' ? 'Renewing Member' : 'New Member'],
      ['Membership Type', data.membership_type || ''],
      ['Amount Paid',     fmtAmount(data.amount_cents)],
      ['T-Shirt Size',    data.tshirt_size || 'N/A'],
      ['Date Signed',     fmtDate(data.sig_date)],
      ['Payment ID',      paymentId]
    ];

    details.forEach(function (pair) {
      body.appendParagraph(pair[0] + ':  ' + pair[1]).editAsText().setFontSize(10);
    });

    body.appendParagraph('');
    body.appendHorizontalRule();

    var wh = body.appendParagraph('WAIVER AGREEMENT');
    wh.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    wh.editAsText().setFontSize(13).setBold(true);

    body.appendParagraph(
      'The member read, understood, and agreed to the Powerhouse Armwrestling Club ' +
      'Release and Waiver of Liability, including: full acknowledgment of the risks and ' +
      'dangers of arm wrestling; indemnity and release of landowners, organisers, and ' +
      'officials; declaration of medical fitness; consent to emergency medical treatment; ' +
      'consent to collection and use of personal information in accordance with the ' +
      'Privacy Act 1988 (Cth); and consent to use of photographs and media for ' +
      'promotional purposes.'
    ).editAsText().setFontSize(10);

    body.appendParagraph('');
    body.appendHorizontalRule();

    var msh = body.appendParagraph('MEMBER SIGNATURE');
    msh.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    msh.editAsText().setFontSize(13).setBold(true);

    body.appendParagraph('Name:  ' + memberName).editAsText().setFontSize(10);
    body.appendParagraph('Date:  ' + fmtDate(data.sig_date)).editAsText().setFontSize(10);
    body.appendParagraph('');

    if (data.member_sig_png) {
      try {
        var b64  = data.member_sig_png.replace(/^data:image\/png;base64,/, '');
        var blob = Utilities.newBlob(
          Utilities.base64Decode(b64),
          'image/png',
          'member_sig.png'
        );
        body.appendImage(blob).setWidth(260);
      } catch (sigErr) {
        logError('generateAndSavePDF - member sig image', sigErr);
        body.appendParagraph('[Member signature image unavailable]').editAsText().setFontSize(10);
      }
    } else {
      body.appendParagraph('[No member signature submitted]').editAsText().setFontSize(10);
    }

    body.appendParagraph('');
    body.appendHorizontalRule();

    var ech = body.appendParagraph('EMERGENCY CONTACT');
    ech.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    ech.editAsText().setFontSize(13).setBold(true);

    body.appendParagraph('Name:   ' + ecName).editAsText().setFontSize(10);
    body.appendParagraph('Phone:  ' + fmtPhone(data.ec_phone)).editAsText().setFontSize(10);

    body.appendParagraph('');
    body.appendHorizontalRule();

    var footer = body.appendParagraph(
      'Generated automatically on ' +
      Utilities.formatDate(new Date(), 'Australia/Brisbane', 'dd/MM/yyyy HH:mm') +
      ' AEST - Powerhouse Armwrestling Club Inc.'
    );
    footer.editAsText().setFontSize(9).setItalic(true);
    footer.setAlignment(DocumentApp.HorizontalAlignment.CENTER);

    doc.saveAndClose();

    var pdfBlob = DriveApp.getFileById(docId).getAs(MimeType.PDF).setName(docName + '.pdf');
    var saved   = folder.createFile(pdfBlob);
    savedPdfId  = saved.getId();
    Logger.log('PDF saved: ' + saved.getName() + ' | ID: ' + saved.getId());

  } catch (err) {
    logError('generateAndSavePDF', err, { paymentId: paymentId });
    throw err;
  } finally {
    if (docId) {
      try {
        DriveApp.getFileById(docId).setTrashed(true);
        Logger.log('Temp Doc trashed: ' + docId);
      } catch (trashErr) {
        logError('generateAndSavePDF - trash temp doc', trashErr, { docId: docId });
      }
    }
  }
  return savedPdfId;
}

/* TEAM NOTIFICATION EMAIL */

function notifyTeam(data, paymentId) {
  var memberName = fullName(data.first_name, data.last_name);
  var ecName     = fullName(data.ec_first_name, data.ec_last_name);
  var joinLabel  = data.join_type === 'renewing' ? 'Renewing Member' : 'New Member';
  var shirtLine  = data.tshirt_size
    ? 'T-Shirt Size:  ' + data.tshirt_size + '  <- ORDER REQUIRED'
    : 'T-Shirt Size:  N/A';

  var subject = 'New Membership: ' + memberName + ' (' + joinLabel + ')';

  var emailBody =
    'A membership has been submitted and payment confirmed.\n\n' +
    '--- MEMBER -----------------------------------\n' +
    'Name:          ' + memberName + '\n' +
    'Email:         ' + (data.email || '') + '\n' +
    'Phone:         ' + fmtPhone(data.phone) + '\n' +
    'DOB:           ' + fmtDate(data.dob) + '\n' +
    'Join Type:     ' + joinLabel + '\n' +
    'Membership:    ' + (data.membership_type || '') + '\n' +
    'Amount Paid:   ' + fmtAmount(data.amount_cents) + '\n' +
    shirtLine + '\n' +
    'Date Signed:   ' + fmtDate(data.sig_date) + '\n' +
    'Payment ID:    ' + paymentId + '\n\n' +
    '--- EMERGENCY CONTACT ------------------------\n' +
    'Name:          ' + ecName + '\n' +
    'Phone:         ' + fmtPhone(data.ec_phone) + '\n\n' +
    '--- WAIVER -----------------------------------\n' +
    'Signed waiver PDF saved to Google Drive -> Memberships -> Signed Waivers\n\n' +
    'Powerhouse Armwrestling Club';

  Logger.log('Sending notification email. Quota remaining: ' + MailApp.getRemainingDailyQuota());

  MailApp.sendEmail({
    to:      TEAM_EMAIL_TO,
    cc:      TEAM_EMAIL_CC,
    subject: subject,
    body:    emailBody,
    name:    'Powerhouse Memberships'
  });

  Logger.log('Email sent successfully for payment ID: ' + paymentId);
}

function notifyMember(data, paymentId) {
  Logger.log('notifyMember entered');
  var memberEmail = cleanEmail(data.email);
  Logger.log('notifyMember recipient: [' + memberEmail + ']');
  Logger.log('Mail quota: ' + MailApp.getRemainingDailyQuota());

  if (!memberEmail) {
    Logger.log('notifyMember skipped: no member email.');
    return;
  }

  var memberName  = fullName(data.first_name, data.last_name) || 'Member';
  var joinLabel   = data.join_type === 'renewing' ? 'Renewal' : 'New Membership';
  var subject     = 'Welcome to Powerhouse Armwrestling Club!';

  var emailBody =
    'Hi ' + (data.first_name || 'there') + ',\n\n' +
    'Your membership application has been received and your payment of ' +
    fmtAmount(data.amount_cents) + ' has been confirmed.\n\n' +
    '--- YOUR MEMBERSHIP DETAILS ---\n' +
    'Name:        ' + memberName + '\n' +
    'Type:        ' + joinLabel + '\n' +
    'Amount Paid: ' + fmtAmount(data.amount_cents) + '\n' +
    'Payment ID:  ' + paymentId + '\n' +
    'Date:        ' + fmtDate(data.sig_date) + '\n' +
    (data.tshirt_size ? 'T-Shirt Size: ' + data.tshirt_size + '\n' : '') +
    '\n' +
    'Your signed waiver has been saved to our records.\n\n' +
    '--- TRAINING INFO ---\n' +
    'Day:      Saturdays\n' +
    'Time:     9:45am - 12:30pm\n' +
    'Venue:    Pimpama School of Arts Hall\n' +
    '          15 Clark Way, Pimpama QLD 4209\n\n' +
    'We look forward to gripping up with you!\n\n' +
    'Powerhouse Armwrestling Club\n' +
    'president@powerhousearmwrestling.com.au\n' +
    'www.powerhousearmwrestling.com.au';

  MailApp.sendEmail({
    to:      memberEmail,
    subject: subject,
    body:    emailBody,
    name:    'Powerhouse Armwrestling Club',
    replyTo: TEAM_EMAIL_TO
  });

  Logger.log('Member confirmation email sent to: ' + memberEmail);
}

/* FORMAT SHEET - run once manually if needed */

function formatSheet() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  ensureHeaders(sheet);
  styleHeaderRow(sheet);

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getBandings().forEach(function (b) { b.remove(); });
    sheet.getRange(2, 1, lastRow - 1, MEMBER_HEADERS.length)
         .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  }

  var widths = [130, 110, 110, 200, 120, 100, 90, 150, 100, 180, 120, 220, 90, 115, 90, 130];
  widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });

  SpreadsheetApp.flush();
  Logger.log('Sheet formatted.');
}

/* MANUAL TEST FUNCTIONS */

function testSystemAccess() {
  Logger.log('Testing Sheets...');
  var ss = SpreadsheetApp.openById(SHEET_ID);
  Logger.log('Sheet: ' + ss.getName());

  Logger.log('Testing Drive folder...');
  var folder = DriveApp.getFolderById(WAIVER_FOLDER_ID);
  Logger.log('Folder: ' + folder.getName());

  Logger.log('Testing Docs and PDF export...');
  var doc = DocumentApp.create('PH Auth Test - delete me');
  doc.getBody().appendParagraph('Auth test.');
  doc.saveAndClose();
  var docFile = DriveApp.getFileById(doc.getId());
  var pdfBlob = docFile.getAs(MimeType.PDF).setName('PH Auth Test.pdf');
  var pdfFile = folder.createFile(pdfBlob);
  docFile.setTrashed(true);
  pdfFile.setTrashed(true);
  Logger.log('PDF test passed.');

  Logger.log('Testing MailApp...');
  Logger.log('Mail quota remaining: ' + MailApp.getRemainingDailyQuota());

  Logger.log('All access tests passed.');
}

function resetMembersSheetHeaders() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  sheet.clear();
  sheet.getRange(1, 1, 1, MEMBER_HEADERS.length).setValues([MEMBER_HEADERS]);
  styleHeaderRow(sheet);
  SpreadsheetApp.flush();
  Logger.log('Members sheet fully reset with clean headers.');
}

function testNotifyTeam() {
  notifyTeam({
    first_name:       'Test',
    last_name:        'Member',
    phone:            '0412345678',
    email:            'test@example.com',
    dob:              '1990-01-15',
    join_type:        'new',
    membership_type:  'Annual Membership - 2025/26',
    amount_cents:     19200,
    tshirt_size:      'L',
    sig_date:         '2026-06-17',
    ec_first_name:    'Emergency',
    ec_last_name:     'Contact',
    ec_phone:         '0499999999',
    member_signed:    true,
    ec_signed:        false,
    marketing_opt_in: true
  }, 'TEST_PAYMENT_ID_001');
}

// FULL END-TO-END TEST (no payment)
// Run this from the Apps Script editor to test sheet writing, PDF generation,
// and email notifications without charging anyone.
function testFullSubmission() {
  var TEST_SIG_PNG = 'data:image/png;base64,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';

  var mockData = {
    first_name:       'Test',
    last_name:        'Member',
    email:            'ethevejay@gmail.com',
    phone:            '0412345678',
    dob:              '1990-06-14',
    join_type:        'new',
    membership_type:  'yearly',
    tshirt_size:      'L',
    ec_first_name:    'Jane',
    ec_last_name:     'Member',
    ec_phone:         '0498765432',
    sig_date:         new Date().toISOString().slice(0, 10),
    member_signed:    true,
    member_sig_png:   TEST_SIG_PNG,
    ec_signed:        false,
    amount_cents:     19200,
    marketing_opt_in: true
  };

  var paymentId = 'TEST-' + Date.now();
  var warnings  = [];

  Logger.log('=== testFullSubmission START === paymentId: ' + paymentId);
  runStep('writeToSheet',      function() { writeToSheet(mockData, paymentId); },      warnings);
  runStep('generateAndSavePDF',function() { generateAndSavePDF(mockData, paymentId); },warnings);
  runStep('notifyTeam',        function() { notifyTeam(mockData, paymentId); },        warnings);
  runStep('notifyMember',      function() { notifyMember(mockData, paymentId); },      warnings);
  Logger.log('=== testFullSubmission DONE === warnings: ' + JSON.stringify(warnings));
}
