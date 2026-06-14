const APPS_SCRIPT_URL = 'https://script.google.com/a/macros/powerhousearmwrestling.com.au/s/AKfycbzAxulwj1oyDk_2s-XPbG21EbzL6VhI6YVa5xjSrapdw2ua6NCLwgTjcIdUaKXFAhvxsA/exec';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const upstream = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(req.body),
      redirect: 'follow',
    });

    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error('Unexpected response from Apps Script: ' + text.slice(0, 300)); }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
