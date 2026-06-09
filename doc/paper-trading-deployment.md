# 모의투자(페이퍼) 전체 기능 운용 — docker-compose 배포 가이드

> 작성 2026-06-09. KIS **sandbox(모의투자)** 로 Sprint 1~4 전 기능 ON 운용.
> 검증: 전체 토글 ON으로 backend 로컬 부팅 성공(세션 복원·크래시 없음), `docker compose config` 유효.

## 1. 활성화된 기능 (전부 ON)
| 위치 | 토글 | 효과 |
|---|---|---|
| backend/.env | `SCALE_OUT_ENABLED=true` | 부분청산: +2%에 TP1 33% 매도, 잔량 러너(러너TP 6%) |
| backend/.env | `R_SIZING_ENABLED=true` | R기반 사이징: 거래당 0.5% 리스크로 수량 산정 |
| backend/.env | `REGIME_SCALING_ENABLED=true` | 시장 레짐 스케일러 |
| backend/.env | `CORRELATION_CAP_ENABLED=true` | 상관 클러스터 캡(클러스터당 ≤2) |
| backend/.env | `VI_HANDLING_ENABLED=true` | VI/정지 인지(🔴손절 불가침, 비손절만 보류) |
| market-data/.env | `SURVIVORSHIP_RETAIN_DELISTED=true` | 전향적 상폐 보존(지금부터 누적) |
| market-data/.env | `ROLLING_WF_ENABLED=true` | 앵커드 롤링 walk-forward(3폴드) |
| market-data/.env | `SCAN_INCLUDE_DELISTED_FOR_BACKTEST=false` | (의도적 OFF) 매수 후보 스캔에 상폐 섞임 방지 |

> ⚠️ **인라인 주석 금지**: docker-compose `env_file`은 `KEY=true  # 주석`을 지원 안 함 → 값이 오염돼 토글이 false가 됨. 주석은 별도 `#` 줄로만.

## 2. 🔴 배포 전 필수 (별도 서버는 빈 상태)
1. **`.env` 파일 수동 복사** — `apps/backend/.env`, `apps/market-data-service/.env`는 **gitignored**라 git clone에 없음. 서버로 직접 복사(KIS sandbox 키·DB·토글 포함).
2. **데이터+유저 이전** — 빈 postgres면 스캔 후보 0 + 스케줄 유저(SCHEDULED_TRADER_USER_ID=2) 없음 → "지금 바로 운용" 불가. 현재 dev DB를 덤프→복원:
   ```bash
   # [현재 머신] 덤프 (데이터 324k행 + 유저 + 마이그레이션 상태 포함)
   docker exec alpha-mind-db pg_dump -U alpha -Fc alpha_mind > alpha_mind.dump
   # 서버로 전송 (scp 등) 후, 서버에서 postgres 컨테이너 기동 뒤:
   docker cp alpha_mind.dump alpha-mind-db:/tmp/
   docker exec alpha-mind-db pg_restore -U alpha -d alpha_mind --clean --if-exists /tmp/alpha_mind.dump
   ```
   - 대안(fresh 시작): 데이터는 market-data 수집 cron이 시간 두고 채움(Yahoo, 6개월×2900종목 → 수 시간~수일), 유저는 `/api/users/sign-up`으로 생성 + SCHEDULED_TRADER_USER_ID 매칭.

## 3. 배포
```bash
docker compose up -d --build
```
- **마이그레이션 자동 실행**: backend·market-data Dockerfile CMD가 `migrator.up()` 후 앱 기동 → 별도 명령 불필요.
- 서비스: postgres(5432) · rabbitmq(5672/15672) · backend(3000) · market-data(3001) · frontend(80).
- 로그: `docker compose logs -f backend market-data`

## 4. 운용 방식 (어떻게 매매가 도는가)
- **기동 즉시**: 복원된 활성 세션을 backend가 복원·모니터링(실시간 KIS WS 체결가 + 30초 루프). 보유분은 즉시 TP1/손절/VI 감시.
- **신규 후보 스캔**: 평일 **08:00 KST cron**(`scheduled-scanner`)이 전 종목 스캔 → 레짐·상관·롤링WF 적용해 후보 추출 → 세션 시작. **즉시 스캔을 원하면** 수동 트리거 API(인증 필요) 또는 다음 08:00 대기.
- **KIS_ENV=sandbox** → 모든 주문은 모의투자(실돈 X).

## 5. ⚠️ 전체 ON 결합 동작 (예상)
- **레짐**: 현재 시장 **CRISIS 우세**(튜닝 64%) → 노출 ~절반(슬롯×0.5·금액×0.6, 하드플로어 보유≥3·금액≥0.4). 방어적.
- **롤링 WF + 상관캡 + R사이징**: 후보 검증이 더 엄격 → **후보 수가 적거나 0일 수 있음**(약세장 + 다중 게이트). 정상 — 과적합·동반손실 방지.
- **VI**: fail-safe(감지 실패→즉시청산), 손절은 VI 중에도 지정가 발주.
- 종합: **거래 빈도↓·포지션 작고 방어적**. 모의투자 관찰엔 적합.

## 6. 관찰 / 롤백
- **관찰**: `docker compose logs -f backend` — `regime=ON correlation=ON`, 클러스터 캡 스킵, `TP1 부분익절`, `자동 손절`, `VI/정지 중 주문 보류`, 알림(notifications 테이블).
- **개별 토글 롤백**: 해당 `.env`에서 `=false` 후 `docker compose restart backend`(또는 market-data). 코드 변경·재빌드 불필요.
- **전체 중단**: `docker compose down`(볼륨 유지) / `docker compose down -v`(데이터 삭제 주의).

## 7. 체크리스트
- [ ] `.env` 2개 서버 복사(sandbox 키 확인, KIS_ENV=sandbox)
- [ ] DB 덤프→복원(데이터+유저) 또는 fresh+수집+유저생성
- [ ] `docker compose up -d --build` → 마이그레이션 자동 + 5개 서비스 healthy
- [ ] `docker compose logs -f backend` 에서 세션 복원·토글 ON 확인
- [ ] (선택) 수동 스캔 트리거 또는 08:00 대기
