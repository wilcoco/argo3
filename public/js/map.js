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
    this._resize();
    window.addEventListener('resize', () => this._resize());
    canvas.addEventListener('click', (e) => this._onClick(e));
    // 모바일 터치 보강 (iOS 사파리에서 click 누락 방지)
    let touchStart = null;
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { touchStart = null; return; }
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY, t: Date.now() };
    }, { passive: true });
    canvas.addEventListener('touchend', (e) => {
      if (!touchStart) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
      const dt = Date.now() - touchStart.t;
      touchStart = null;
      // 짧고 거의 움직임 없는 터치만 탭으로
      if (dt < 500 && dx*dx + dy*dy < 100) {
        e.preventDefault();
        this._onClick({ clientX: t.clientX, clientY: t.clientY });
      }
    });
    this._raf();
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
