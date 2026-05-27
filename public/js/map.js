// ============================================================
//  매크로 지도 — OSM 타일 + 영토 셀 렌더링
// ============================================================
const TILE = 256;

export class MacroMap {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.zoom = opts.zoom || 14;
    this.view = { lat: opts.lat || 37.5665, lng: opts.lng || 126.978 };
    this.cells = [];           // 서버에서 받은 셀
    this.tileCache = {};
    this.cellSizeM = opts.cellSizeM || 200;
    this.onTapEmpty = opts.onTapEmpty || (() => {});
    this.onTapCell = opts.onTapCell || (() => {});
    this.tribeColors = opts.tribeColors || ['#3ad1c8', '#ff5d73', '#ffc24d'];
    this.myId = opts.myId;
    this.claimRadiusM = opts.claimRadiusM || 1000;
    this.myLoc = null;          // {lat, lng, acc}
    this.minZoom = opts.minZoom || 11;   // 더 멀리 — 약 30km 시야
    this.maxZoom = opts.maxZoom || 18;   // 더 가깝게 — 골목 단위
    this._resize();
    window.addEventListener('resize', () => this._resize());
    canvas.addEventListener('click', (e) => this._onClick(e));
    this._bindGestures(canvas);
    // 마우스 휠 줌 (데스크톱)
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    this._raf();
  }

  // 핀치 줌 + 드래그 팬 + 탭 구분
  _bindGestures(canvas) {
    let touchStart = null;       // 1손가락 탭 추적
    let dragLast = null;         // 1손가락 드래그 시작점
    let dragged = false;         // 탭/드래그 구분용
    let pinchPrev = null;        // 핀치 직전 두 손가락 거리·중점
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        touchStart = { x: t.clientX, y: t.clientY, t: Date.now() };
        dragLast = { x: t.clientX, y: t.clientY };
        dragged = false;
        pinchPrev = null;
      } else if (e.touches.length === 2) {
        pinchPrev = { d: dist(e.touches[0], e.touches[1]), m: mid(e.touches[0], e.touches[1]) };
        touchStart = null; dragLast = null;
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinchPrev) {
        e.preventDefault();
        const d = dist(e.touches[0], e.touches[1]);
        const m = mid(e.touches[0], e.touches[1]);
        const ratio = d / pinchPrev.d;
        // 일정 임계치 넘어가면 줌 한 단계 (정수 줌 레벨이라 매끄럽지 않지만 안정적)
        if (ratio > 1.25) { this._zoomAt(m.x, m.y, +1); pinchPrev = { d, m }; }
        else if (ratio < 0.8) { this._zoomAt(m.x, m.y, -1); pinchPrev = { d, m }; }
      } else if (e.touches.length === 1 && dragLast) {
        const t = e.touches[0];
        const dx = t.clientX - dragLast.x, dy = t.clientY - dragLast.y;
        if (Math.hypot(dx, dy) > 6) dragged = true;
        if (dragged) {
          e.preventDefault();
          this._panBy(dx, dy);
          dragLast = { x: t.clientX, y: t.clientY };
        }
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      if (pinchPrev && e.touches.length < 2) pinchPrev = null;
      if (!touchStart || dragged) { touchStart = null; dragLast = null; dragged = false; return; }
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
      const dt = Date.now() - touchStart.t;
      touchStart = null; dragLast = null;
      if (dt < 500 && dx*dx + dy*dy < 100) {
        e.preventDefault();
        this._onClick({ clientX: t.clientX, clientY: t.clientY });
      }
    });
  }

  // 화면 좌표(clientX/Y)를 기준으로 줌 한 단계 (그 지점이 그대로 그 자리에 보이도록 view 보정)
  _zoomAt(sx, sy, dir) {
    const rect = this.canvas.getBoundingClientRect();
    const x = sx - rect.left, y = sy - rect.top;
    const before = this.screen2geo(x, y);
    const nz = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + dir));
    if (nz === this.zoom) return;
    this.zoom = nz;
    const after = this.screen2geo(x, y);
    this.view.lat += before.lat - after.lat;
    this.view.lng += before.lng - after.lng;
  }

  // 캔버스 중앙 기준 줌 (버튼용)
  zoomBy(dir) {
    const nz = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + dir));
    if (nz !== this.zoom) this.zoom = nz;
  }

  _panBy(dxPx, dyPx) {
    const a = this.screen2geo(this.W/2, this.H/2);
    const b = this.screen2geo(this.W/2 - dxPx, this.H/2 - dyPx);
    this.view.lat += b.lat - a.lat;
    this.view.lng += b.lng - a.lng;
  }
  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.W = r.width; this.H = r.height;
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  setCells(cells) { this.cells = cells; }
  setView(lat, lng) { this.view = { lat, lng }; }
  setMyLoc(loc) { this.myLoc = loc; }

  // 미터 → 현재 줌의 픽셀 거리 (시야 위도 기준)
  _metersToPx(meters) {
    // Web Mercator: 1 픽셀 = (현재 위도의 미터/픽셀)
    // 적도에서 zoom z의 픽셀당 미터 = 156543.03392 / 2^z
    const mPerPx = (156543.03392 * Math.cos((this.view.lat * Math.PI) / 180)) / Math.pow(2, this.zoom);
    return meters / mPerPx;
  }

  // 좌표 변환
  _lng2tx(lng) { return (lng + 180) / 360 * Math.pow(2, this.zoom); }
  _lat2ty(lat) { return (1 - Math.log(Math.tan(lat*Math.PI/180) + 1/Math.cos(lat*Math.PI/180)) / Math.PI) / 2 * Math.pow(2, this.zoom); }
  _tx2lng(x) { return x / Math.pow(2, this.zoom) * 360 - 180; }
  _ty2lat(y) { const n = Math.PI - 2*Math.PI*y/Math.pow(2, this.zoom); return 180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n))); }

  geo2screen(lat, lng) {
    const cx = this._lng2tx(this.view.lng) * TILE, cy = this._lat2ty(this.view.lat) * TILE;
    return { x: this._lng2tx(lng)*TILE - cx + this.W/2, y: this._lat2ty(lat)*TILE - cy + this.H/2 };
  }
  screen2geo(x, y) {
    const cx = this._lng2tx(this.view.lng) * TILE, cy = this._lat2ty(this.view.lat) * TILE;
    return { lat: this._ty2lat((cy + (y - this.H/2)) / TILE), lng: this._tx2lng((cx + (x - this.W/2)) / TILE) };
  }

  _loadTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (this.tileCache[key] !== undefined) return this.tileCache[key];
    this.tileCache[key] = 'loading';
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { this.tileCache[key] = img; };
    img.onerror = () => { this.tileCache[key] = 'err'; };
    const sub = ['a', 'b', 'c'][(x + y) % 3];
    img.src = `https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
    return 'loading';
  }

  _drawTiles() {
    const ctx = this.ctx, z = this.zoom;
    ctx.fillStyle = '#0d1420'; ctx.fillRect(0, 0, this.W, this.H);
    const cxT = this._lng2tx(this.view.lng), cyT = this._lat2ty(this.view.lat);
    const cxP = cxT * TILE, cyP = cyT * TILE;
    const cols = Math.ceil(this.W/TILE)+2, rows = Math.ceil(this.H/TILE)+2;
    const sx = Math.floor(cxT - cols/2), sy = Math.floor(cyT - rows/2);
    const max = Math.pow(2, z);
    for (let ix = 0; ix < cols; ix++) for (let iy = 0; iy < rows; iy++) {
      let tx = sx + ix, ty = sy + iy;
      if (ty < 0 || ty >= max) continue;
      tx = ((tx % max) + max) % max;
      const px = tx*TILE - cxP + this.W/2, py = ty*TILE - cyP + this.H/2;
      const tile = this._loadTile(z, tx, ty);
      if (tile && tile !== 'err' && tile !== 'loading') {
        ctx.globalAlpha = 1;
        ctx.filter = 'grayscale(0.5) brightness(0.55) contrast(1.1)';
        ctx.drawImage(tile, px, py, TILE, TILE);
        ctx.filter = 'none';
      } else {
        this._drawProcTile(px, py, tx, ty);
      }
    }
  }
  _drawProcTile(sx, sy, tx, ty) {
    const ctx = this.ctx;
    ctx.save(); ctx.beginPath(); ctx.rect(sx, sy, TILE, TILE); ctx.clip();
    ctx.fillStyle = '#11202b'; ctx.fillRect(sx, sy, TILE, TILE);
    let h = ((tx*73856093) ^ (ty*19349663)) >>> 0;
    const rnd = () => { h = (h*1664525 + 1013904223) >>> 0; return h/4294967296; };
    const gap = 42 + Math.floor(rnd()*26);
    for (let bx = sx; bx < sx+TILE; bx += gap) for (let by = sy; by < sy+TILE; by += gap) {
      if (rnd() < 0.72) { const p = 4+rnd()*5, s = 22+Math.floor(rnd()*16);
        ctx.fillStyle = `rgb(${s+6},${s+14},${s+20})`; ctx.fillRect(bx+p, by+p, gap-p*2, gap-p*2); }
    }
    ctx.strokeStyle = 'rgba(120,140,160,0.28)'; ctx.lineWidth = 1;
    for (let bx = sx; bx <= sx+TILE; bx += gap) { ctx.beginPath(); ctx.moveTo(bx, sy); ctx.lineTo(bx, sy+TILE); ctx.stroke(); }
    for (let by = sy; by <= sy+TILE; by += gap) { ctx.beginPath(); ctx.moveTo(sx, by); ctx.lineTo(sx+TILE, by); ctx.stroke(); }
    ctx.restore();
  }

  _drawCells() {
    const ctx = this.ctx;
    for (const c of this.cells) {
      if (c.lat == null) continue;
      const p = this.geo2screen(Number(c.lat), Number(c.lng));
      if (p.x < -60 || p.x > this.W+60 || p.y < -60 || p.y > this.H+60) continue;
      const mine = c.owner_id === this.myId;
      const color = c.tribe != null ? this.tribeColors[c.tribe] : '#3a4859';
      const radius = 18 + Math.sqrt(c.value || 40) * 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI*2);
      ctx.fillStyle = this._alpha(color, 0.16); ctx.fill();
      ctx.lineWidth = mine ? 3 : 1.6;
      ctx.strokeStyle = mine ? '#fff' : color; ctx.stroke();
      if (c.is_hero) { // 영웅 빛
        ctx.beginPath(); ctx.arc(p.x, p.y, radius+4, 0, Math.PI*2);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.fillStyle = color; ctx.font = 'bold 10px JetBrains Mono,monospace'; ctx.textAlign = 'center';
      ctx.fillText(c.username || '거점', p.x, p.y - radius - 5);
    }
    this._drawMyLoc();
  }

  // 내 GPS 위치 + 점유 가능 반경(1km)
  _drawMyLoc() {
    if (!this.myLoc) return;
    const ctx = this.ctx;
    const p = this.geo2screen(this.myLoc.lat, this.myLoc.lng);
    if (p.x < -200 || p.x > this.W+200 || p.y < -200 || p.y > this.H+200) return;
    // 점유 가능 반경 원 (반투명, 점선)
    const rPx = this._metersToPx(this.claimRadiusM);
    if (rPx > 8) {
      ctx.save();
      ctx.beginPath(); ctx.arc(p.x, p.y, rPx, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(58, 209, 200, 0.06)'; ctx.fill();
      ctx.strokeStyle = 'rgba(58, 209, 200, 0.55)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
      ctx.restore();
    }
    // 내 위치 핀 (펄스)
    const t = (Date.now() % 1600) / 1600;
    const pulse = 8 + t * 14;
    ctx.beginPath(); ctx.arc(p.x, p.y, pulse, 0, Math.PI*2);
    ctx.fillStyle = `rgba(58, 209, 200, ${0.35 * (1-t)})`; ctx.fill();
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI*2);
    ctx.fillStyle = '#3ad1c8'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }
  _alpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
  }

  _onClick(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    // 셀 히트 테스트
    for (const c of this.cells) {
      if (c.lat == null) continue;
      const p = this.geo2screen(Number(c.lat), Number(c.lng));
      const radius = 18 + Math.sqrt(c.value || 40) * 1.5;
      if ((x-p.x)**2 + (y-p.y)**2 <= radius*radius) { this.onTapCell(c); return; }
    }
    const g = this.screen2geo(x, y);
    this.onTapEmpty(g.lat, g.lng);
  }

  _raf() {
    const loop = () => { this._drawTiles(); this._drawCells(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
}
