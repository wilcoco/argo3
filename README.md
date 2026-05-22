# 🦠 BACTERIA WAR (argo3)

GPS 기반 영토 점령 게임. **매크로(지도 위 영토 생태계)** 에서 운영하다가 **마이크로(실시간 전투)** 로 요충지를 다툰다.

- **매크로**: 실제 지도(OSM) 위에서 영역을 점유·자동운영. 3종족 가위바위보 상성, 밀도 기반 생산, 환생 생태계, 영웅.
- **마이크로**: 도전 시 그 영역을 전장으로 실시간 1:1 전투. 중앙 노른자 쟁탈, 베팅=전력, 진화 챔피언 기반 자동방어 AI.
- 누구도 영원히 지배하지 못하는 자기균형 생태계가 시뮬레이션으로 검증됨.

## 기술 스택

- **백엔드**: Node.js + Express + Socket.IO (실시간)
- **DB**: PostgreSQL
- **배포**: Railway
- **클라이언트**: 바닐라 JS + Canvas (의존성 없음, OSM 타일)

## 폴더 구조

```
argo3/
├── server/
│   ├── index.js              # 메인 서버 (Express + Socket.IO + 생태계 틱)
│   ├── db/
│   │   ├── schema.sql        # PostgreSQL 스키마
│   │   ├── pool.js           # DB 연결 풀
│   │   └── init.js           # 스키마 적용 + 종족 시드
│   ├── routes/
│   │   └── api.js            # REST API
│   └── game/
│       ├── config.js         # 모든 게임 변수 (검증된 값)
│       ├── geo.js            # 위경도 ↔ 셀 그리드
│       ├── battle.js         # 마이크로 전투 (서버 권위 판정)
│       └── macro.js          # 매크로 로직 (점유/도전/생태계 틱)
├── public/                   # 클라이언트
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js            # 메인 흐름
│       ├── map.js            # 매크로 지도
│       └── battle.js         # 마이크로 전투 (실시간 렌더)
├── package.json
├── railway.json              # Railway 배포 설정
└── .env.example
```

## 로컬 실행

```bash
# 1. 의존성 설치
npm install

# 2. PostgreSQL 준비 후 .env 작성
cp .env.example .env
# .env 에서 DATABASE_URL 채우기

# 3. DB 초기화 (스키마 + 종족 시드)
npm run initdb

# 4. 서버 실행
npm start        # 또는 npm run dev (파일 변경 시 자동 재시작)
# → http://localhost:3000
```

## Railway 배포

1. 이 레포를 Railway 프로젝트에 연결 (GitHub 연동).
2. Railway에서 **PostgreSQL 플러그인 추가** → `DATABASE_URL` 자동 주입됨.
3. 최초 1회 DB 초기화: Railway 콘솔(또는 `railway run`)에서
   ```bash
   npm run initdb
   ```
4. 배포되면 자동으로 서버가 뜨고 생태계 틱이 시작됨.
   - 헬스체크: `/healthz`

> **참고**: `DATABASE_URL`이 없으면 서버는 뜨지만 생태계 틱은 비활성화된다(경고 출력). DB 연결 후 재시작하면 활성화.

## 게임 흐름

1. 닉네임 입력 → 종족 자동 배정(인구 균형 위해 최소 종족 우선).
2. 지도에서 빈 땅 탭 → 점유(⚡40). 적 영역 탭 → 도전.
3. 도전 시 베팅 → 실시간 전투(노른자 쟁탈) → 서버가 승패 권위 판정.
4. 이기면 점유권+베팅 흡수, 지면 베팅 손실. 결과가 지도에 반영.
5. 보유 영역은 서버 틱마다 자동 생산. 시간이 흐르며 종족 생태계가 돌아감.

## 실시간 대전 (구현됨)

도전 시 방어자 상태에 따라 자동 분기:
- **방어자 온라인 + 수락** → 사람 대 사람 실시간 대전 (PvP). 양쪽 입력을 Socket.IO로 중계, 도전자 측이 서버에 결과 보고.
- **방어자 미응답(15초) / 거절 / 오프라인** → AI 자동방어 (진화 챔피언 두뇌, 서버 권위 판정).

방어 대기 시간은 `CONFIG.MICRO.DEFENSE_WAIT_SEC` (기본 15초).

## 다음 작업 (TODO)

- [ ] PvP 결과 부정 방지 강화 (현재는 도전자 보고 신뢰 — 양쪽 보고 대조 로직 추가 여지)
- [ ] 인증 강화 (현재 닉네임만 — JWT/세션 추가)
- [ ] 무적 시간대(수면 보호) 등록 UI
- [ ] 토너먼트(다중 도전자) 처리
- [ ] 영웅 강림 시각 효과 + 알림
- [ ] Firebase 실시간 옵션 (현재 Socket.IO)
- [ ] 신(神) 게임 모드 (차기 방향: 1종족 지배 → 약자종족 영웅 강림 개입)

## CLI 작업 메모

Claude CLI로 이 레포를 다룰 때:

```bash
# 의존성 설치 & 문법 점검
npm install
node --check server/index.js

# git 푸시 (레포: https://github.com/wilcoco/argo3)
git init && git add -A && git commit -m "init: BACTERIA WAR 서버+클라이언트"
git branch -M main
git remote add origin https://github.com/wilcoco/argo3.git
git push -u origin main
```
