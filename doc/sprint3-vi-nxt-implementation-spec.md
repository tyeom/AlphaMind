# Sprint 3 잔여 구현 명세서 — VI/상하한가 인지 + KRX/NXT 분기 (Codex 실행용)

> 목적: 단타(1~3일 스윙) 다종목 자동매매에 **(A) VI(변동성완화장치)·상하한가 인지** 와 **(B) KRX/NXT 분기 주문처리** 2건을 Codex가 (나중에) 구현하도록 정밀 명세.
> 합성 근거: 다관점 설계(MVP·최소위험) + 코드 그라운딩 + 적대적 우려. **세션 한도로 일부 설계/리뷰 미완 → 메인 루프에서 합성**(적대적 우려는 본문 §리스크에 명시).
> 작성 기준 코드: 2026-06-09 master. 라인 인용은 실제 파일 + `.claude/skills/kis-api/references/` 확인 결과.
> 🔴 **최상위 원칙(불가침)**: VI/정지 중에도 **손절은 절대 누락/스킵하지 않는다.** 감지 로직 장애·불확실 시 **기존 즉시청산으로 fail-safe 폴백**. 감지 때문에 청산을 막으면 절대 안 된다.
> **구현 보류**: 본 명세는 작성만. Codex 위임은 추후 토큰 여유 시 `/codex doc/sprint3-vi-nxt-implementation-spec.md ...`.

---

## 0. Codex 작업 지침 (먼저 읽을 것)

- **레포 구조**: pnpm workspace. `apps/backend`(:3000, KIS·자동매매·실시간 주문 집행), `apps/market-data-service`(:3001), `libs/strategies`, `libs/common`.
- **스택**: NestJS 11, MikroORM 6, `@nestjs/axios`(KIS REST), WebSocket(KIS 실시간), Jest.
- **검증 명령**: `pnpm --filter @alpha-mind/backend run build` / `... run test` / `pnpm -r run lint`. (libs 미수정이면 strategies 빌드 불필요.)
- **가드레일**:
  1. 신규 동작은 **config 토글 기본 OFF**(`VI_HANDLING_ENABLED=false`)로 기존 동작 **비파괴**(토글 OFF 시 비트단위 동일). 매직넘버 금지(전부 config/상수).
  2. **fail-safe 최우선**(위 불가침 원칙): VI 감지 실패/불확실/타임아웃 → `isViActive=false` 취급 → 기존 즉시청산. 손절 경로는 어떤 경우에도 발주를 보장.
  3. 기존 public 시그니처/타입 비파괴. 신규 필드는 optional. DB 마이그레이션 없음(상태는 인메모리 맵, 영속화 불필요 — VI는 2분짜리 실시간 상태).
  4. 실시간 주문 경로 변경이므로 **단위 테스트 필수** + **모의투자(샌드박스) 페이퍼 검증 동선**을 수용기준에 포함.
  5. 로그는 기존 `Logger` 한국어 패턴.
- **권장 순서**: (1) `parseExecution` 필드 확장(f34/f35/f43/f45) + 타입 → (2) VI/정지 상태 맵(`ViStateTracker`) + 판정 유틸 → (3) `evaluateAndExecuteSell`/`executeBuy`에 게이트(손절 유지·보류대상만 defer) → (4) VI 해제·타임아웃 복구 + 보류 재평가 → (5) KRX/NXT 분기 훅(현 KRX 전용) → (6) 단위테스트 + 페이퍼. 각 작업 개별 커밋.

- **핵심 결정**:
  1. **VI 감지 = 기존 H0STCNT0(체결) 스트림 필드 추출**(무비용). `parseExecution`(`kis-websocket.service.ts` L687-707)이 f[21]까지만 읽음 → **f34 `NEW_MKOP_CLS_CODE`(신장운영구분), f35 `TRHT_YN`(거래정지 Y/N), f43 `HOUR_CLS_CODE`(0:장중/A:장후예상/B:장전예상/D:시간외단일가예상), f45 `VI_STND_PRC`(정적VI발동기준가)** 추가 추출. 출처: `.claude/skills/kis-api/references/kis-websocket.md` L155-185. → **추가 구독(H0STMCD0) 없이** 이미 구독 중인 스트림으로 감지 = 세션 구독 한도(~41/세션) 잠식 0.
  2. **H0STMCD0(실시간 VI발동/해제)는 선택적 강화**(2순위). 명시적 on/off·정적/동적 구분을 주지만 **스킬 레퍼런스에 필드 레이아웃 없음**(grep 0건) → 필드 인덱스를 KIS apiportal '실시간시세>VI발동/해제'에서 확정해야 하고, 도입 시 **보유 종목에만 구독**(한도 보호). **MVP/1차 구현 범위에서 제외**, T1 §확장에 자리만.
  3. **NXT(넥스트레이드)는 현재 미사용**(코드 전체 참조 0, KIS 주문은 KRX 발주, order-cash 응답에 `KRX_FWDG_ORD_ORGNO`만). → **KRX 전용 구현 + NXT 분기 훅(stub)**. NXT 라우팅·핸들링 실제 구현은 NXT 도입 결정 시 별도.
  4. **상태는 종목별 인메모리 맵**(`Map<stockCode, ViState>`), TTL/타임아웃 기반. 마이그레이션·영속화 없음.

---

## T1. VI(변동성완화장치)·상하한가 인지

### 목표·근거
종목이 **VI 발동(약 2분 단일가매매)** 또는 **거래정지/상하한가(±30%)** 상태인 동안, **무의미하거나 불리한 시장가 발주를 피하고** 신규 매수·이익성 청산(트레일링/본전/TP1)은 **보류·재시도**한다. 단 **손절은 유지**(아래 정책).

**검증된 VI 사실(KRX 공식)**: 동적 VI = 직전체결가 대비 KOSPI200 ±3%(종가단일가 ±2%)/일반·KOSDAQ ±6%(±4%); 정적 VI = 전일종가/직전단일가 대비 ±10%; 발동 시 KRX **약 2분 단일가매매**(임의연장 ≤30초) → 주문 누적 후 동시체결. 가격제한폭 ±30%.

### 현재 코드 (파일·라인)
- `apps/backend/src/kis/kis-websocket.service.ts`
  - `parseExecution(f)` L687-707: H0STCNT0 체결 파싱. **f[0]~f[21]만** 추출(현재가 f2, executionType f21 등). **f34/f35/f43/f45 미추출** → 여기 확장.
  - dispatch switch L660-671: `case 'H0STCNT0' → execution$`, `H0STASP0 → orderbook$`, `H0STCNI9 → notification$`. **default 없음** → 신규 trId(H0STMCD0) 추가가 비파괴.
  - `parseOrderbook(f)` L710-735: `expectedPrice` f[51], `expectedVolume` f[52](단일가 예상체결 — 보조 신호, 정규 시가/종가 단일가에도 켜져 노이즈).
  - 구독: `subscribe('H0STCNT0', code)` — 보유/감시 종목마다 이미 구독 중. 한도 초과 시 REST 폴백(auto-trading `pollingStockIntervals`).
- `apps/backend/src/kis/kis.types.ts`: `KisRealtimeExecution` L141-159(`executionType` L158) → 신규 필드 추가.
- `apps/backend/src/auto-trading/auto-trading.service.ts`
  - `evaluateAndExecuteSell(session, price)` ≈L2069: 손절(`returnPct ≤ session.stopLossPct`) → executeSell / 러너익절 / TP1 부분익절(scale-out 블록) / 최대보유. 단일 진입점(30초 루프 + 실시간 가격 트리거 공유).
  - `executeBuy(session, price)`: 지정가('00') 신규/추가 매수.
  - `executeSell(session, price, reason, opts)`: 시장가('01'), 전량/부분(sellQty), `sellInFlightSessionIds` 락.
  - 실시간 가격: `latestPrices`(WS 체결가) + `getReliableSellCheckPrice`(REST 보강). VI 상태도 이 execution$ 스트림에서 같이 받음.
- 레이트리밋: `KisService.request`(Sprint1) — EGW00201 백오프. 재시도 발주는 이 경로 통과.

### VI/정지 감지 알고리즘
1. **`parseExecution` 확장** — 추출 추가(비파괴, 기존 필드 유지):
   - `newMkopClsCode = f[34]`(신장운영구분), `tradingHalt = f[35] === 'Y'`(거래정지), `hourClsCode = f[43]`(0 장중/A 장후예상/B 장전예상/D 시간외단일가예상), `viStndPrc = Number(f[45])`(정적VI기준가).
   - `KisRealtimeExecution`에 optional 필드로 노출.
2. **`ViStateTracker`**(신규, backend, 인메모리 `Map<stockCode, {active, since, source, lastSeen}>`):
   - execution$ 수신 시 종목별 VI/정지 상태 갱신. **판정 규칙**:
     - `tradingHalt === true` → 정지(active).
     - 단일가 추정: `newMkopClsCode`가 단일가/VI 운영코드값일 때 active. **⚠️ NEW_MKOP_CLS_CODE의 정확한 코드값(어떤 값이 VI 단일가인지)은 스킬에 없음** → 페이퍼에서 **raw 로깅으로 역설계 후 상수 매핑 확정**(구현 1단계 산출물). 확정 전에는 `tradingHalt`만으로 보수 동작.
     - **오탐 방지(필수)**: `hourClsCode`가 정규 장전(B)/장후(A)/시간외(D) 예상단일가이거나, 시간대가 정규 단일가 구간(개장 직전 08:30~09:00, 종가 15:20~15:30)이면 **VI로 보지 않는다**(시간대 필터).
   - **상하한가**: 현재가가 전일종가 대비 ±30% 근접(예: ≥29.5% 또는 ≤−29.5%)이면 limit-near 플래그(전일종가는 일봉/현재가 API에서 확보).
3. **fail-safe**: 데이터 결손/파싱 실패/필드 부재 → `active=false`. 감지가 손절을 막지 않게.

### 주문 처리 정책 (핵심)
`evaluateAndExecuteSell`·`executeBuy`에 게이트 삽입(`VI_HANDLING_ENABLED && viTracker.isActive(stockCode)`):

| 의도 | VI/단일가 중 동작 |
|---|---|
| **손절**(returnPct≤stopLossPct) | **🔴 무조건 발주 유지.** 단 시장가('01')는 단일가에서 거부/불리 → **지정가('00')로 하한가 근처(또는 예상체결가/현재가−여유틱)에 넣어 동시체결**되게. 발주 스킵 절대 금지. |
| **신규/추가 매수**(executeBuy) | **보류** → VI 해제 후 재평가(매수 급할 것 없음, 단일가 진입 불리). |
| **트레일링/본전 청산** | **보류** → VI 해제 후 재평가(이익 보호라 노이즈에 단일가로 던질 필요 없음). |
| **TP1 부분익절**(scale-out) | **보류**(이익이라 비급박) → 해제 후 재평가. |
| **최대보유 청산** | 보류(시간 만료는 비급박) → 해제 후. |

- **NXT 분기는 T2** — KRX는 위처럼 '지정가 넣어두기'(단일가 누적체결), NXT는 정지라 지정가도 불가 → 정지 해제 후 재발주(자리만).

### VI 해제·타임아웃 복구 (영구 보류 방지 — 필수)
- 해제 트리거: ① `tradingHalt`가 N으로 복귀 + `newMkopClsCode`/`hourClsCode`가 정상(장중)으로 복귀, OR ② (H0STMCD0 도입 시) 해제 이벤트, OR ③ **타임아웃 `VI_CLEAR_TIMEOUT_MS`(기본 150000=2.5분, 2분+임의연장 30초+여유)** 경과.
- 해제 시 보류 큐의 해당 종목 주문 의도를 **재평가**(보류 시점 가격이 아니라 **현재가로 재판정** — 스테일 방지). 재평가에서 조건 미충족이면 발주 안 함.
- 보류 큐는 `Map<sessionId, {intent, queuedAt}>` 인메모리. 세션 종료/매도 체결 시 정리.

### config (전부 토글, 기본=기존 동작)
- backend `validation.schema.ts`: `VI_HANDLING_ENABLED`(default false), `VI_CLEAR_TIMEOUT_MS`(150000), `VI_LIMIT_NEAR_PCT`(29.5), `VI_STOPLOSS_LIMIT_ORDER`(true: 손절을 지정가로), `VI_REEVAL_DEBOUNCE_MS`(1000). `.env.example` 동기화.
- NEW_MKOP_CLS_CODE 단일가 코드값은 상수 맵(`VI_SINGLE_PRICE_MKOP_CODES`)으로 — 페이퍼 역설계 후 채움.

### 엣지케이스
- 손절+VI 동시: 위 정책대로 지정가 발주(스킵 금지). `sellInFlightSessionIds` 락 유지.
- 오탐(정규 단일가): 시간대 필터로 제외.
- VI 해제 이벤트 누락: 타임아웃 복구.
- 보류 중 가격 급변: 해제 시 현재가 재판정.
- 재시도 폭주: `VI_REEVAL_DEBOUNCE_MS` + Sprint1 레이트리미터(EGW00201).
- WS 끊김/REST 폴백 구간: VI 미감지 → fail-safe(즉시청산).
- 토글 OFF: 게이트 전체 우회, 기존 동작 동일.

### 수용 기준
- [ ] `VI_HANDLING_ENABLED=false`에서 기존 매매 동작 비트단위 동일(골든테스트).
- [ ] VI active + 손절 신호 → **지정가 매도 발주됨**(스킵 안 됨) 단위테스트.
- [ ] VI active + 신규매수/트레일링/TP1 → 보류, 해제(또는 타임아웃) 후 현재가 재판정 발주.
- [ ] 정규 시가/종가 단일가(hourClsCode A/B/D, 해당 시간대) → VI로 오판 안 함.
- [ ] 감지 데이터 결손 → fail-safe(즉시청산).

### 테스트 / 페이퍼 검증
- 단위: `ViStateTracker` 판정(정지/단일가/오탐/타임아웃), 게이트별 정책(손절 유지/보류), 해제 재판정.
- 페이퍼(샌드박스): NEW_MKOP_CLS_CODE raw 로깅으로 실제 VI 발동 종목의 코드값 역설계 → 상수 확정. (VI는 변동성 큰 종목에서 장중 관찰; 강제 불가.)

---

## T2. KRX/NXT 분기 주문처리

### 목표·근거
VI/정지 시 거래소별 처리가 다름: **KRX = 2분 단일가매매**(주문 누적→동시체결, 지정가 넣어두기 유효) vs **NXT(넥스트레이드) = 2분 매매정지**(취소주문만, 신규/지정가 불가). 현재 **KRX 전용**이므로 KRX 정책을 구현하고 NXT는 분기 훅만 둔다.

### 현재 코드 (파일·라인)
- `kis-order.service.ts`: `orderCash` order-cash 발주 — 응답 `KRX_FWDG_ORD_ORGNO`(한국거래소전송주문조직번호)만(`kis-order.md` L65/132/144). **거래소 선택 파라미터 없음 = KRX 단일 경로.** NXT 라우팅 파라미터·참조 전무.
- 체결/현재가 데이터에도 거래소 구분 필드 미사용.

### 알고리즘 (현 KRX 전용 + NXT 훅)
1. **거래소 판별 훅** `resolveExchange(stockCode): 'KRX' | 'NXT'` — 현재는 **항상 'KRX' 반환**(상수). NXT 도입 시 종목/주문 라우팅 정보로 분기(자리만).
2. **KRX 정책**(T1과 결합): VI 단일가 중 손절 = 지정가 넣어두기(누적 동시체결). 신규/이익청산 = 보류.
3. **NXT 정책(stub)**: VI=매매정지로 간주 → **지정가도 발주 불가** → 손절 포함 모든 주문 보류 + 정지 해제까지 취소만 허용. **단 현재 NXT 미사용이라 이 분기는 실행되지 않음**(resolveExchange가 KRX 고정). 구현은 인터페이스/분기문만, 실제 NXT 라우팅은 범위 외.
4. 손절 불가침 원칙은 KRX에서 보장(지정가 발주). NXT가 실제 도입되면 "정지 중 손절 불가" 리스크를 별도 설계 필요(범위 외 명시).

### config
- `NXT_HANDLING_ENABLED`(default false), `resolveExchange`는 토글 무관 항상 KRX(미도입). NXT 도입 시 활성.

### 엣지케이스 / 수용 기준
- [ ] `resolveExchange`가 항상 KRX 반환(현행) — 기존 동작 불변.
- [ ] NXT 분기 코드는 존재하되 미실행(단위테스트로 KRX 경로만 검증).
- [ ] NXT 정책 stub은 향후 확장 지점 주석 명시.

---

## 8. 작업 범위 밖 (이번 명세 제외)
- **H0STMCD0(실시간 VI 명시 이벤트) 구독** — 필드 레이아웃 확정·보유종목 한정 구독은 후속(T1 §확장에 자리만). 1차는 H0STCNT0 필드 추출로 충분.
- **NXT 실제 라우팅/주문** — NXT 도입 결정 시 별도. 현재는 분기 훅·stub만.
- **별도 WS 세션 분리**(VI 구독 한도 회피) — H0STCNT0 재사용으로 불필요해짐.

## 9. 완료 정의 (DoD)
- [ ] T1·T2 수용 기준 + 단위 테스트 통과 + **토글 OFF 골든 회귀**.
- [ ] `pnpm --filter @alpha-mind/backend run build && pnpm -r run build` 성공, `pnpm -r run lint` 통과.
- [ ] **🔴 "VI 중 손절 발주 유지" 테스트 통과**(불가침 원칙 검증).
- [ ] fail-safe(감지 실패→즉시청산) 테스트 통과.
- [ ] NEW_MKOP_CLS_CODE 단일가 코드값 페이퍼 역설계 → 상수 확정(또는 미확정 시 `tradingHalt`만으로 보수 동작 + TODO 명시).
- [ ] 마이그레이션 없음(인메모리 상태) 확인. 각 작업 개별 커밋, config 토글 기본 OFF.

---

### 부록 — 적대적 우려 체크리스트 (리뷰 미완 → 구현 시 필수 점검)
1. 🔴 **손절 누락 금지** — VI 중에도 손절은 지정가 발주(스킵 금지). #1 mustFix.
2. **오탐 VI** — 정규 시가/종가 단일가(hourClsCode A/B/D + 시간대)와 VI 단일가 구분.
3. **VI 해제 누락 → 영구 보류** — 타임아웃(2.5분) 복구 필수.
4. **재시도 폭주 + EGW00201** — 디바운스 + 레이트리미터.
5. **보류 주문 스테일** — 해제 시 현재가 재판정.
6. **구독 한도** — H0STCNT0 재사용으로 0 잠식(H0STMCD0 미도입).
7. **fail-safe** — 감지 실패/불확실 → 즉시청산 폴백.
8. **NXT 정지 중 손절 불가** — 현재 미도입이라 비활성. NXT 도입 시 별도 설계(범위 외).
