const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzAxulwj1oyDk_2s-XPbG21EbzL6VhI6YVa5xjSrapdw2ua6NCLwgTjcIdUaKXFAhvxsA/exec';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  try {
    const upstream = await fetch(APPS_SCRIPT_URL, { redirect: 'follow' });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(200).json({ count: 0 }); }
    return res.status(200).json({ count: typeof data.count === 'number' ? data.count : 0 });
  } catch {
    return res.status(200).json({ count: 0 });
  }
};
