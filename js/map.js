// 판다산다 지도: 카카오맵 키(PS.KAKAO_JS_KEY)가 있으면 카카오맵, 없으면 Leaflet + OpenStreetMap.
// 두 지도를 같은 모양의 함수로 감싸서 화면 코드는 어느 지도인지 몰라도 되게 한다.
(function () {
  var PS = window.PS;
  var DEFAULT_CENTER = { lat: 37.383, lng: 127.119 }; // 성남시 분당구

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('스크립트를 불러오지 못했어요: ' + src)); };
      document.head.appendChild(s);
    });
  }
  function loadCss(href) {
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
  }

  function pinHtml(item) {
    return '<button type="button" class="map-pin' + (item.active ? ' on' : '') + '" data-id="' + PS.esc(item.id) + '">' +
      '<span>' + PS.esc(item.label) + '</span></button>';
  }

  // ---------- 카카오맵 ----------
  function kakaoAdapter() {
    var kakao = window.kakao;
    var geocoder = kakao.maps.services ? new kakao.maps.services.Geocoder() : null;
    return {
      kind: 'kakao',
      create: function (el, center) {
        var map = new kakao.maps.Map(el, { center: new kakao.maps.LatLng(center.lat, center.lng), level: 6 });
        var overlays = [];
        var me = null;
        return {
          setMarkers: function (items, onClick) {
            overlays.forEach(function (o) { o.setMap(null); });
            overlays = items.map(function (it) {
              var wrap = document.createElement('div');
              wrap.innerHTML = pinHtml(it);
              var btn = wrap.firstChild;
              btn.addEventListener('click', function (e) { e.stopPropagation(); onClick(it.id); });
              var o = new kakao.maps.CustomOverlay({ position: new kakao.maps.LatLng(it.lat, it.lng), content: btn, yAnchor: 1.15, zIndex: it.active ? 10 : 1 });
              o.setMap(map);
              return o;
            });
          },
          fit: function (items) {
            if (!items.length) return;
            if (items.length === 1) { map.setCenter(new kakao.maps.LatLng(items[0].lat, items[0].lng)); map.setLevel(5); return; }
            var b = new kakao.maps.LatLngBounds();
            items.forEach(function (it) { b.extend(new kakao.maps.LatLng(it.lat, it.lng)); });
            map.setBounds(b, 80, 40, 260, 40);
          },
          panTo: function (lat, lng) { map.panTo(new kakao.maps.LatLng(lat, lng)); },
          center: function () { var c = map.getCenter(); return { lat: c.getLat(), lng: c.getLng() }; },
          onMove: function (cb) { kakao.maps.event.addListener(map, 'idle', cb); },
          showMe: function (lat, lng) {
            var pos = new kakao.maps.LatLng(lat, lng);
            if (!me) {
              var dot = document.createElement('div');
              dot.className = 'map-me';
              me = new kakao.maps.CustomOverlay({ position: pos, content: dot, zIndex: 20 });
              me.setMap(map);
            } else me.setPosition(pos);
          },
          relayout: function () { map.relayout(); }
        };
      },
      geocode: function (text) {
        return new Promise(function (resolve) {
          if (!geocoder) return resolve(null);
          geocoder.addressSearch(text, function (res, status) {
            if (status === kakao.maps.services.Status.OK && res[0]) resolve({ lat: Number(res[0].y), lng: Number(res[0].x) });
            else resolve(null);
          });
        });
      }
    };
  }

  // ---------- Leaflet + OSM (카카오 키가 없을 때) ----------
  function leafletAdapter() {
    var L = window.L;
    return {
      kind: 'leaflet',
      create: function (el, center) {
        var map = L.map(el, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], 13);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap'
        }).addTo(map);
        var layer = L.layerGroup().addTo(map);
        var me = null;
        return {
          setMarkers: function (items, onClick) {
            layer.clearLayers();
            items.forEach(function (it) {
              var icon = L.divIcon({ className: 'map-pin-wrap', html: pinHtml(it), iconSize: null, iconAnchor: [0, 0] });
              var m = L.marker([it.lat, it.lng], { icon: icon, zIndexOffset: it.active ? 1000 : 0 });
              m.on('click', function () { onClick(it.id); });
              m.addTo(layer);
            });
          },
          fit: function (items) {
            if (!items.length) return;
            if (items.length === 1) { map.setView([items[0].lat, items[0].lng], 14); return; }
            map.fitBounds(items.map(function (it) { return [it.lat, it.lng]; }), { paddingTopLeft: [40, 90], paddingBottomRight: [40, 280], maxZoom: 15 });
          },
          panTo: function (lat, lng) { map.panTo([lat, lng]); },
          center: function () { var c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },
          onMove: function (cb) { map.on('moveend', cb); },
          showMe: function (lat, lng) {
            if (!me) me = L.marker([lat, lng], { icon: L.divIcon({ className: '', html: '<div class="map-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 2000 }).addTo(map);
            else me.setLatLng([lat, lng]);
          },
          relayout: function () { map.invalidateSize(); }
        };
      },
      geocode: async function (text) {
        try {
          var r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=kr&accept-language=ko&q=' + encodeURIComponent(text));
          var j = await r.json();
          return j[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null;
        } catch (e) { return null; }
      }
    };
  }

  var loading = null;
  PS.loadMap = function () {
    if (loading) return loading;
    loading = (async function () {
      if (PS.KAKAO_JS_KEY) {
        try {
          await loadScript('https://dapi.kakao.com/v2/maps/sdk.js?appkey=' + encodeURIComponent(PS.KAKAO_JS_KEY) + '&autoload=false&libraries=services');
          await new Promise(function (resolve) { window.kakao.maps.load(resolve); });
          return kakaoAdapter();
        } catch (e) {
          console.warn('[판다산다] 카카오맵을 불러오지 못해 기본 지도로 보여줘요', e);
        }
      }
      loadCss('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
      await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
      return leafletAdapter();
    })();
    return loading;
  };

  PS.DEFAULT_CENTER = DEFAULT_CENTER;

  // 지역 글자 → 좌표 (한 번 찾은 건 브라우저에 저장)
  PS.geocodeRegion = async function (adapter, text) {
    if (!text) return null;
    var key = 'ps_geo_' + text;
    try { var hit = localStorage.getItem(key); if (hit) return JSON.parse(hit); } catch (e) {}
    var pos = await adapter.geocode(text);
    if (pos) { try { localStorage.setItem(key, JSON.stringify(pos)); } catch (e) {} }
    return pos;
  };

  // 같은 자리에 겹친 물건은 둥글게 살짝 흩어 놓는다 (약 50m)
  PS.spreadPins = function (items) {
    var groups = {};
    items.forEach(function (it) {
      var k = it.lat.toFixed(4) + ',' + it.lng.toFixed(4);
      (groups[k] = groups[k] || []).push(it);
    });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.length < 2) return;
      g.forEach(function (it, i) {
        var a = (2 * Math.PI * i) / g.length;
        var r = 0.0005 * (1 + Math.floor(i / 8) * 0.6);
        it.lat += r * Math.sin(a);
        it.lng += r * Math.cos(a) * 1.25;
      });
    });
    return items;
  };

  PS.distanceKm = function (a, b) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  };
})();
