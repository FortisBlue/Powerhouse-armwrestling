const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// In-memory Sheets, mail and payment adapters: no production writes or messages.
function sheet(rows, maxColumns = 26) {
  return {
    rows, maxColumns,
    getMaxColumns() { return this.maxColumns; },
    insertColumnsAfter(_, count) { this.maxColumns += count; },
    getLastRow() { return rows.length; },
    getLastColumn() { return Math.max(...rows.map(r => r.length)); },
    setFrozenRows() {}, setRowHeight() {}, setColumnWidth() {},
    appendRow(row) { rows.push(row.map(literal)); },
    getRange(r, c, nr = 1, nc = 1) {
      if (typeof r === 'string') return { setNumberFormat() {} };
      assert.ok(c + nc - 1 <= this.maxColumns, 'range fits sheet columns');
      const range = {
        getValues() { return Array.from({length:nr}, (_, y) => Array.from({length:nc}, (_, x) => rows[r+y-1]?.[c+x-1] ?? '')); },
        getValue() { return this.getValues()[0][0]; },
        isBlank() { return this.getValue() === ''; },
        setValues(values) { values.forEach((row,y) => row.forEach((value,x) => { rows[r+y-1] ||= []; rows[r+y-1][c+x-1] = literal(value); })); return this; },
        setValue(value) { return this.setValues([[value]]); },
        clearContent() { return this.setValue(''); },
        insertCheckboxes() { assert.equal(nr, 1, 'no prefilled empty cash rows'); return this.setValue(false); },
        createTextFinder(value) { return { matchEntireCell() { return this; }, findNext() { for(let y=r-1;y<r+nr-1;y++) if(rows[y]?.[c-1] === value) return {getRow:()=>y+1}; return null; } }; }
      };
      for (const method of ['setFontWeight','setFontSize','setBackground','setFontColor','setVerticalAlignment','setNumberFormat']) range[method] = function() { return this; };
      return range;
    }
  };
}
function literal(value) { return typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value; }
function environment() {
  const emails = [], pdfs = [], charges = [];
  const members = sheet([[]]), pending = sheet([[]]);
  const ctx = vm.createContext({
    PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'mock-token'})},
    SpreadsheetApp:{openById:()=>({getSheets:()=>[members],getSheetByName:()=>pending}),flush(){}},
    LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
    Utilities:{formatDate:()=> '14/09/2026 09:00',base64EncodeWebSafe:s=>Buffer.from(s).toString('base64url'),Charset:{UTF_8:'UTF-8'}},
    HtmlService:{createHtmlOutput:s=>s}, Logger:{log(){}},console:{error(){}},
    MailApp:{sendEmail:msg=>emails.push(msg),getRemainingDailyQuota:()=>100}
  });
  vm.runInContext(fs.readFileSync('google-apps-script/Code.js','utf8'),ctx);
  ctx.chargeSquare = (...args) => { charges.push(args); return {success:true,payment_id:'MOCK-CARD'}; };
  ctx.savePendingSignature = () => 'mock-signature';
  ctx.loadPendingSignature = () => 'data:image/png;base64,mock';
  ctx.generateAndSavePDF = data => { pdfs.push({...data}); return 'mock-pdf'; };
  const post = data => JSON.parse(Buffer.from(ctx.doPost({postData:{contents:JSON.stringify(data)}}).slice(8),'base64url'));
  return {ctx, members, pending, emails, pdfs, charges, post};
}
function application(extra = {}) {
  return {first_name:'Test',last_name:'Surname',email:'test@example.invalid',phone:'0400000000',dob:'1990-01-01',sig_date:'2026-09-14',ec_first_name:'EC',ec_last_name:'Test',ec_phone:'0400000001',member_signed:true,member_sig_png:'data:image/png;base64,mock',join_type:'new',membership_type:'yearly',tshirt_size:'Large',amount_cents:19200,location_id:'LRE1Q97A62XVE',application_id:'mock-application-123',...extra};
}

test('card: custom name reaches sheet, club/member emails and PDF data', () => {
  const e = environment();
  assert.equal(e.post(application({tshirt_custom_name:'  The   Hammer  '})).success,true);
  assert.equal(e.charges.length,1);
  assert.equal(e.members.rows[1][18],'The Hammer');
  assert.equal(e.members.rows[1][2],'Surname');
  assert.equal(e.pdfs[0].tshirt_custom_name,'The Hammer');
  assert.equal(e.emails.length,2);
  e.emails.forEach(mail=>assert.match(mail.body,/Name on back: +The Hammer/));
});

test('cash: stores print name, preserves approval columns and carries name through approval once', () => {
  const e = environment();
  e.ctx.setupTshirtNameColumns();
  assert.equal(e.pending.maxColumns,27);
  assert.equal(e.post(application({payment_method:'cash',tshirt_custom_name:"O’Neil"})).success,true);
  assert.equal(e.charges.length,0);
  assert.equal(e.members.rows.length,1);
  assert.equal(e.pending.rows[1][26],"O’Neil");
  assert.equal(e.pending.rows[1][3],false);
  assert.equal(e.pending.rows[0][25],'Last Error');
  e.pending.rows[1][3] = true;
  e.ctx.approveCashApplication(2);
  assert.equal(e.members.rows[1][18],"O’Neil");
  assert.equal(e.pending.rows[1][2],'Complete');
  assert.equal(e.pending.rows[1][3],true);
  assert.equal(e.pdfs[0].tshirt_custom_name,"O’Neil");
  assert.ok(e.emails.some(mail=>mail.body.includes("T-shirt print name: O’Neil")));
  e.ctx.approveCashApplication(2);
  assert.equal(e.pdfs.length,1);
  assert.equal(e.emails.length,4);
  e.post(application({payment_method:'cash',tshirt_custom_name:"O’Neil"}));
  assert.equal(e.pending.rows.length,2);
  assert.equal(e.emails.length,4);
});

test('surname default and old 26-column cash applications remain compatible', () => {
  const e = environment();
  e.post(application({payment_method:'cash'}));
  assert.equal(e.pending.rows[1][26],'Surname');
  e.pending.rows[1].length = 26;
  e.ctx.approveCashApplication(2);
  assert.equal(e.members.rows[1][18],'Surname');
});

test('renewal shirt costs $50 extra; renewal without shirt ignores hidden print name', () => {
  const e = environment();
  assert.equal(e.post(application({join_type:'renewing',amount_cents:24200,tshirt_custom_name:'Ace'})).success,true);
  assert.equal(e.charges[0][1],24200);
  assert.equal(e.members.rows[1][18],'Ace');
  assert.equal(e.post(application({join_type:'renewing',tshirt_size:'',tshirt_custom_name:'Hidden'})).success,true);
  assert.equal(e.charges[1][1],19200);
  assert.equal(e.members.rows[2][18],'');
});

test('overlong name is rejected before cash writes or card charge', () => {
  for (const payment_method of ['cash','card']) {
    const e = environment();
    const result = e.post(application({payment_method,tshirt_custom_name:'X'.repeat(41)}));
    assert.equal(result.success,false);
    assert.match(result.error,/40 characters/);
    assert.equal(e.charges.length,0);
    assert.equal(e.emails.length,0);
    assert.equal(e.members.rows.length,1);
    assert.equal(e.pending.rows.length,1);
  }
});

test('print name is literal spreadsheet text and stays literal through cash approval', () => {
  const e = environment();
  assert.equal(e.ctx.sheetText('=Ace'),"'=Ace");
  e.post(application({payment_method:'cash',tshirt_custom_name:'=Ace'}));
  assert.equal(e.pending.rows[1][26],'=Ace');
  e.ctx.approveCashApplication(2);
  assert.equal(e.members.rows[1][18],'=Ace');
});
