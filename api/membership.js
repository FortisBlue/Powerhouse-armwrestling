const { google } = require('googleapis');

const SQ_BASE = process.env.SQUARE_SANDBOX === 'true'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function ensureHeaders(sheets, sheetId) {
  const check = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Sheet1!A1',
  });
  if (check.data.values && check.data.values.length > 0) return;

  const headers = [
    'Timestamp','Join Type','First Name','Last Name','Phone','Email','Date of Birth',
    'T-Shirt Size','Membership Type','Amount Paid',
    'EC Name','EC Phone','Payment ID','Member Signed','EC Signed',
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Sheet1!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [headers] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.11, green: 0.063, blue: 0.086 },
                textFormat: {
                  bold: true,
                  foregroundColor: { red: 0.788, green: 0.635, blue: 0.204 },
                },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
      ],
    },
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const data = req.body;

  try {
    // 1. Charge Square
    const sqResp = await fetch(`${SQ_BASE}/v2/payments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SQUARE_TOKEN}`,
        'Content-Type': 'application/json',
        'Square-Version': '2025-01-23',
      },
      body: JSON.stringify({
        source_id:       data.nonce,
        idempotency_key: data.idempotency_key,
        amount_money:    { amount: data.amount_cents, currency: 'AUD' },
        note:            `Powerhouse Armwrestling — ${data.membership_type === 'yearly' ? 'Yearly' : 'Half Year'} Membership`,
      }),
    });

    const sqResult = await sqResp.json();

    if (!sqResult.payment || sqResult.payment.status !== 'COMPLETED') {
      const msg = sqResult.errors ? sqResult.errors[0].detail : 'Payment declined';
      return res.status(200).json({ success: false, error: msg });
    }

    const paymentId = sqResult.payment.id;

    // 2. Write to Google Sheets
    const sheets  = await getSheets();
    const sheetId = process.env.SHEET_ID;

    await ensureHeaders(sheets, sheetId);

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range:         'Sheet1!A:O',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          new Date().toISOString(),
          data.join_type     || 'new',
          data.first_name,
          data.last_name,
          data.phone,
          data.email,
          data.dob,
          data.tshirt_size   || '',
          data.membership_type,
          '$' + (data.amount_cents / 100).toFixed(2) + ' AUD',
          data.ec_name,
          data.ec_phone,
          paymentId,
          data.member_signed ? 'Yes' : 'No',
          data.ec_signed     ? 'Yes' : 'No',
        ]],
      },
    });

    return res.status(200).json({ success: true, payment_id: paymentId });

  } catch (err) {
    console.error('Membership handler error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
