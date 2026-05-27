// ============================================================
//  지리 좌표 ↔ 셀 그리드 변환
//  위경도를 일정 크기 셀로 양자화하여 영토 단위로 사용.
// ============================================================
import { CONFIG } from './config.js';

// 셀 크기: 위도 1도 ≈ 111km. CELL_SIZE_M 미터 단위로 양자화.
const CELL_DEG = CONFIG.MACRO.CELL_SIZE_M / 111000; // 위도 기준 셀 크기(도)

export function latLngToCell(lat, lng) {
  // 경도는 위도에 따라 미터/도가 달라지므로 보정
  const cellY = Math.floor(lat / CELL_DEG);
  const lngDeg = CELL_DEG / Math.cos((lat * Math.PI) / 180);
  const cellX = Math.floor(lng / lngDeg);
  return { cellX, cellY };
}

export function cellToLatLng(cellX, cellY) {
  const lat = (cellY + 0.5) * CELL_DEG;
  const lngDeg = CELL_DEG / Math.cos((lat * Math.PI) / 180);
  const lng = (cellX + 0.5) * lngDeg;
  return { lat, lng };
}

// 셀 이웃 (4방향)
export function cellNeighbors(cellX, cellY) {
  return [
    { cellX: cellX - 1, cellY },
    { cellX: cellX + 1, cellY },
    { cellX, cellY: cellY - 1 },
    { cellX, cellY: cellY + 1 },
  ];
}

// 두 셀 간 거리 (셀 단위)
export function cellDist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

// 두 위경도 좌표 간 미터 거리 (Haversine)
export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
