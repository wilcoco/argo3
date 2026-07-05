// ============================================================
//  전투 사운드 — WebAudio 합성 (에셋 파일 없음, 오프라인 동작)
//  브라우저 자동재생 정책: 첫 사용자 제스처에서 AudioContext 생성/재개
// ============================================================

let ctx = null;
let master = null;
let muted = localStorage.getItem('bw_mute') === '1';
const lastPlay = {};   // 종류별 스로틀

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// 기본 톤 — freq에서 slideTo로 미끄러지며 vol → 0 감쇠
function tone(freq, dur, { type = 'sine', vol = 0.25, slideTo = null, delay = 0 } = {}) {
  const c = ac(); if (!c || muted) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g); g.connect(master);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

// 노이즈 버스트 (타격감)
function noise(dur, { vol = 0.15, delay = 0 } = {}) {
  const c = ac(); if (!c || muted) return;
  const t0 = c.currentTime + delay;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(g); g.connect(master);
  src.start(t0);
}

function throttled(key, ms) {
  const now = performance.now();
  if (lastPlay[key] && now - lastPlay[key] < ms) return true;
  lastPlay[key] = now;
  return false;
}

export const SFX = {
  // 돌 배치 — 묵직한 "탁"
  place() { tone(180, 0.1, { type: 'square', vol: 0.18 }); tone(90, 0.14, { vol: 0.25 }); },
  // 포탄 발사 — 가벼운 "핑" (다발이라 강한 스로틀)
  fire(focused) {
    if (throttled('fire', focused ? 90 : 150)) return;
    tone(focused ? 880 : 660, 0.04, { type: 'triangle', vol: 0.07 });
  },
  // 타격 — 짧은 노이즈
  hit() { if (throttled('hit', 120)) return; noise(0.05, { vol: 0.09 }); },
  // 변환 (오델로 뒤집기) — 상승 아르페지오
  flip() {
    if (throttled('flip', 200)) return;
    tone(440, 0.08, { vol: 0.2 }); tone(660, 0.08, { vol: 0.2, delay: 0.06 }); tone(880, 0.12, { vol: 0.22, delay: 0.12 });
  },
  // 돌 사망 — 낮게 미끄러지는 둔음
  death() { if (throttled('death', 150)) return; tone(160, 0.2, { type: 'sawtooth', vol: 0.14, slideTo: 55 }); },
  // 집중공격 지정 — 명령 "삑"
  focus() { tone(990, 0.06, { type: 'square', vol: 0.15 }); tone(1320, 0.05, { vol: 0.12, delay: 0.05 }); },
  // 카운트다운 / 시작
  count() { tone(880, 0.08, { vol: 0.2 }); },
  go() { tone(1320, 0.18, { vol: 0.28 }); tone(1760, 0.12, { vol: 0.15, delay: 0.08 }); },
  // 승리 / 패배 징글
  win() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, { vol: 0.22, delay: i * 0.11 }));
  },
  lose() {
    [392, 330, 262, 196].forEach((f, i) => tone(f, 0.2, { type: 'triangle', vol: 0.18, delay: i * 0.13 }));
  },
  // 수확/보상 (맵에서도 사용 가능)
  coin() { tone(1047, 0.07, { vol: 0.18 }); tone(1568, 0.12, { vol: 0.16, delay: 0.06 }); },
};

export function isMuted() { return muted; }
export function toggleMute() {
  muted = !muted;
  localStorage.setItem('bw_mute', muted ? '1' : '0');
  if (master) master.gain.value = muted ? 0 : 0.5;
  return muted;
}
// 첫 제스처에서 컨텍스트 준비 (자동재생 정책 해제)
export function primeAudio() { ac(); }
