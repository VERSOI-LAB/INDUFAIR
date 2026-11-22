// 인스타그램·스레드 주간 게시물 (여러 장 슬라이드)
//   /social/weekly.json      이번 주 슬라이드 목록 + 캡션 (supabase/functions/social-publish 가 읽음)
//   /social/weekly/1.jpg …   n 번째 슬라이드 (1080×1350 JPEG)
//   ?v=… 를 붙이면 새로 그림 (발행 때마다 같은 v 로 목록·이미지를 맞춤). 같은 주소는 30분 캐시
// 그림·문구는 api/_social.js
var So = require('./_social');

module.exports = async function (req, res) {
  try {
    if (req.query.manifest) {
      var m = await So.manifest();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, s-maxage=1800');
      res.status(200).send(JSON.stringify(m));
      return;
    }
    var n = parseInt(String(req.query.file || '').replace(/\.jpg$/i, ''), 10);
    if (!(n >= 1 && n <= 10)) { res.status(404).send('not found'); return; }
    var jpg = await So.slide(n);
    if (!jpg) { res.status(404).send('not found'); return; }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', jpg.length);
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
    res.status(200).send(jpg);
  } catch (e) {
    console.error('social', e);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).send('error');
  }
};
