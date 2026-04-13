import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { scanStocks, startAiSession, getActiveAiSession, streamAiSession, cancelAiSession } from '../api/scanner';
import type { SseProgress } from '../api/scanner';
import { api } from '../api/client';
import { startSessionsBatch, getSessions, pauseSession, resumeSession, stopSession, updateSession, deleteSessionPermanent, manualOrder } from '../api/auto-trading';
import { getBalance } from '../api/kis';
import { ApiError } from '../api/client';
import { useAutoTradingWebSocket, type PriceUpdate } from '../hooks/useAutoTradingWebSocket';
import type { ScanResult, AiStockScore, ExpertOpinion, NewsItem } from '../types/scanner';
import type {
  AutoTradingSession,
  ManualOrderRequest,
  SessionConflictAction,
  SessionConflictError,
  SessionConflictItem,
  SessionEntryMode,
  StartSessionRequest,
} from '../types/auto-trading';
import {
  AutoTradingConfigModal,
  type TradingConfigItem,
} from '../components/AutoTradingConfigModal';
import { SessionConflictModal } from '../components/SessionConflictModal';
import { saveAiMeetingResults, getAiMeetingResults, getAiMeetingResult, type AiMeetingResult } from '../api/ai-meeting-result';

type Step = 'idle' | 'scanning' | 'scanned' | 'scoring' | 'scored' | 'trading';

function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}

function pctClass(n: number): string {
  return n > 0 ? 'text-profit' : n < 0 ? 'text-loss' : '';
}

const REC_LABELS: Record<string, string> = {
  strong_buy: '강력 매수',
  buy: '매수',
  hold: '관망',
  sell: '매도',
  strong_sell: '강력 매도',
};

const REC_CLASS: Record<string, string> = {
  strong_buy: 'rec-strong-buy',
  buy: 'rec-buy',
  hold: 'rec-hold',
  sell: 'rec-sell',
  strong_sell: 'rec-strong-sell',
};

function ExpertCard({ title, role, opinion }: { title: string; role: string; opinion: ExpertOpinion }) {
  return (
    <div className="expert-card">
      <div className="expert-header">
        <strong>{title}</strong>
        <span className="expert-role">{role}</span>
      </div>
      <div className="expert-rec">
        <span className={`rec-badge ${REC_CLASS[opinion.recommendation] || 'rec-hold'}`}>
          {REC_LABELS[opinion.recommendation] || opinion.recommendation}
        </span>
        <span className="expert-score">{opinion.score.toFixed(1)}/10</span>
        <span className="expert-confidence">확신도 {(opinion.confidence * 100).toFixed(0)}%</span>
      </div>
      <p className="expert-analysis">{opinion.analysis}</p>
      {opinion.keyPoints.length > 0 && (
        <div className="expert-section">
          <small className="section-label">핵심 근거</small>
          <ul>{opinion.keyPoints.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}
      {opinion.concerns.length > 0 && (
        <div className="expert-section">
          <small className="section-label text-loss">우려사항</small>
          <ul>{opinion.concerns.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </div>
      )}
      <div className="expert-target">
        목표 수익률: <strong className={pctClass(opinion.targetReturnPct)}>{opinion.targetReturnPct}%</strong>
      </div>
    </div>
  );
}

function AiMeetingResultModal({
  result,
  onClose,
}: {
  result: AiMeetingResult;
  onClose: () => void;
}) {
  const score: AiStockScore = result.data;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content ai-meeting-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <h3>AI 전문가 회의 결과 - {result.stockName} ({result.stockCode})</h3>
          <button className="btn btn-sm btn-text" onClick={onClose}>닫기</button>
        </div>
        <div className="meeting-meta">
          <small className="text-muted">
            분석일시: {new Date(result.updatedAt).toLocaleString('ko-KR')}
          </small>
        </div>

        <div className="final-score-banner">
          <div className={`final-score ${score.score >= 7 ? 'score-high' : score.score >= 4 ? 'score-mid' : 'score-low'}`}>
            {score.score.toFixed(2)}
          </div>
          <div className="final-reasoning">
            <p><strong>{score.expertDetail?.conclusion.finalRecommendation || '분석 완료'}</strong></p>
            <p>{score.reasoning}</p>
          </div>
        </div>

        <div className="data-summary">
          <div className="data-block">
            <small className="section-label">뉴스 수집 결과</small>
            {score.newsItems && score.newsItems.length > 0 ? (
              <ul className="news-list">
                {score.newsItems.map((item: NewsItem, j: number) => (
                  <li key={j} className={`news-item news-${item.impact}`}>
                    <div className="news-title">
                      {item.url ? (
                        <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
                      ) : (
                        <span>{item.title}</span>
                      )}
                      <span className={`news-impact impact-${item.impact}`}>
                        {item.impact === 'positive' ? '호재' : item.impact === 'negative' ? '악재' : '중립'}
                      </span>
                    </div>
                    <p className="news-summary">{item.summary}</p>
                  </li>
                ))}
              </ul>
            ) : score.newsHighlights && score.newsHighlights.length > 0 ? (
              <ul>{score.newsHighlights.map((n, j) => <li key={j}>{n}</li>)}</ul>
            ) : (
              <p className="text-muted">수집된 뉴스 없음</p>
            )}
          </div>
          {score.chartAnalysis && (
            <div className="data-block">
              <small className="section-label">차트 분석</small>
              <p>{score.chartAnalysis}</p>
            </div>
          )}
        </div>

        {score.expertDetail && (
          <>
            <div className="expert-cards">
              <ExpertCard
                title="주식 전문가 트레이더"
                role="단기 매매 / 기술적 분석"
                opinion={score.expertDetail.traderOpinion}
              />
              <ExpertCard
                title="경제 전문 분석가"
                role="거시경제 / 펀더멘탈 분석"
                opinion={score.expertDetail.economistOpinion}
              />
            </div>

            <div className="meeting-conclusion">
              <h4>회의 결론</h4>
              <p className="conclusion-rec">{score.expertDetail.conclusion.finalRecommendation}</p>
              <p className="conclusion-reasoning">{score.expertDetail.conclusion.reasoning}</p>

              {score.expertDetail.conclusion.consensusPoints.length > 0 && (
                <div className="conclusion-section">
                  <small className="section-label">합의점</small>
                  <ul>{score.expertDetail.conclusion.consensusPoints.map((p, j) => <li key={j}>{p}</li>)}</ul>
                </div>
              )}
              {score.expertDetail.conclusion.disagreements.length > 0 && (
                <div className="conclusion-section">
                  <small className="section-label">이견</small>
                  <ul>{score.expertDetail.conclusion.disagreements.map((d, j) => <li key={j}>{d}</li>)}</ul>
                </div>
              )}
            </div>
          </>
        )}

        {score.riskFactors && score.riskFactors.length > 0 && (
          <div className="conclusion-section">
            <small className="section-label text-loss">리스크 요인</small>
            <ul>{score.riskFactors.map((rf, j) => <li key={j}>{rf}</li>)}</ul>
          </div>
        )}
      </div>
    </div>
  );
}

function ManualOrderModal({
  session,
  currentPrice,
  onCancel,
  onConfirm,
}: {
  session: AutoTradingSession;
  currentPrice?: number;
  onCancel: () => void;
  onConfirm: (dto: ManualOrderRequest) => void;
}) {
  const [orderType, setOrderType] = useState<'buy' | 'sell'>('buy');
  const [orderDvsn, setOrderDvsn] = useState<'00' | '01'>('01');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');

  const isSellDisabled = session.holdingQty <= 0;

  const handleSubmit = () => {
    const qty = Number(quantity);
    if (!qty || qty <= 0) return;
    if (orderDvsn === '00' && (!Number(price) || Number(price) <= 0)) return;

    onConfirm({
      orderType,
      orderDvsn,
      quantity: qty,
      price: orderDvsn === '00' ? Number(price) : undefined,
    });
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content manual-order-modal" onClick={(e) => e.stopPropagation()}>
        <h3>수동 주문 — {session.stockName} ({session.stockCode})</h3>

        <div className="order-info">
          {currentPrice && <div className="info-row"><label>현재가</label><span>{fmt(currentPrice)}원</span></div>}
          <div className="info-row"><label>보유 수량</label><span>{fmt(session.holdingQty)}주</span></div>
          {session.holdingQty > 0 && (
            <div className="info-row"><label>평균 단가</label><span>{fmt(Math.round(session.avgBuyPrice))}원</span></div>
          )}
        </div>

        <div className="order-type-toggle">
          <button
            className={`toggle-btn toggle-buy ${orderType === 'buy' ? 'active' : ''}`}
            onClick={() => setOrderType('buy')}
          >
            매수
          </button>
          <button
            className={`toggle-btn toggle-sell ${orderType === 'sell' ? 'active' : ''}`}
            onClick={() => setOrderType('sell')}
            disabled={isSellDisabled}
            title={isSellDisabled ? '보유 수량이 없습니다' : undefined}
          >
            매도
          </button>
        </div>

        <div className="order-dvsn-toggle">
          <button
            className={`toggle-btn ${orderDvsn === '01' ? 'active' : ''}`}
            onClick={() => setOrderDvsn('01')}
          >
            시장가
          </button>
          <button
            className={`toggle-btn ${orderDvsn === '00' ? 'active' : ''}`}
            onClick={() => setOrderDvsn('00')}
          >
            지정가
          </button>
        </div>

        <div className="order-fields">
          <label>
            주문 수량
            <input
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              min="1"
              max={orderType === 'sell' ? session.holdingQty : undefined}
              placeholder={orderType === 'sell' ? `최대 ${session.holdingQty}주` : '수량 입력'}
            />
          </label>
          {orderType === 'sell' && session.holdingQty > 0 && (
            <button
              className="btn btn-sm btn-text"
              onClick={() => setQuantity(String(session.holdingQty))}
            >
              전량
            </button>
          )}

          {orderDvsn === '00' && (
            <label>
              주문 단가
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                min="1"
                placeholder={currentPrice ? `현재가 ${fmt(currentPrice)}` : '단가 입력'}
              />
            </label>
          )}
        </div>

        {quantity && Number(quantity) > 0 && (
          <div className="order-estimate">
            예상 금액: <strong>
              {fmt(Math.round(
                Number(quantity) * (orderDvsn === '00' && Number(price) > 0 ? Number(price) : (currentPrice ?? 0)),
              ))}원
            </strong>
            {orderDvsn === '01' && <small className="text-muted"> (시장가 — 실제 체결가와 다를 수 있음)</small>}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-text" onClick={onCancel}>취소</button>
          <button
            className={`btn ${orderType === 'buy' ? 'btn-primary' : 'btn-danger'}`}
            onClick={handleSubmit}
            disabled={!quantity || Number(quantity) <= 0 || (orderDvsn === '00' && (!price || Number(price) <= 0))}
          >
            {orderType === 'buy' ? '매수 주문' : '매도 주문'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AiScanner() {
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState<Step>('idle');
  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [aiScores, setAiScores] = useState<Map<string, AiStockScore>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sessions, setSessions] = useState<AutoTradingSession[]>([]);
  const [prices, setPrices] = useState<Map<string, number>>(new Map());
  const [investmentAmount, setInvestmentAmount] = useState('10000000');
  const [topN, setTopN] = useState('10');
  const [error, setError] = useState('');
  const [scanInfo, setScanInfo] = useState({ scanned: 0, eligible: 0, elapsed: 0 });
  const [scoringProgress, setScoringProgress] = useState<SseProgress | null>(null);
  const [scoringElapsed, setScoringElapsed] = useState(0);
  const [expandedDetail, setExpandedDetail] = useState<string | null>(null);
  const [abortScoring, setAbortScoring] = useState<(() => void) | null>(null);
  const [configModalItems, setConfigModalItems] = useState<TradingConfigItem[] | null>(null);
  const [editSession, setEditSession] = useState<AutoTradingSession | null>(null);
  const [orderSession, setOrderSession] = useState<AutoTradingSession | null>(null);
  const [conflictState, setConflictState] = useState<{
    conflicts: SessionConflictItem[];
    pendingDtos: StartSessionRequest[];
    entryMode: SessionEntryMode;
  } | null>(null);

  const [meetingResultModal, setMeetingResultModal] = useState<AiMeetingResult | null>(null);
  const [meetingResultCache, setMeetingResultCache] = useState<Map<string, AiMeetingResult>>(new Map());

  const [, setAiSessionId] = useState<string | null>(null);

  const { connected, on } = useAutoTradingWebSocket();

  useEffect(() => {
    const off = on('price-update', (data: PriceUpdate) => {
      setPrices((prev) => new Map(prev).set(data.stockCode, data.price));
    });
    return off;
  }, [on]);

  useEffect(() => {
    const off = on('session-update', (data: AutoTradingSession) => {
      setSessions((prev) => prev.map((s) => (s.id === data.id ? data : s)));
    });
    return off;
  }, [on]);

  const connectToAiSession = useCallback((sessionId: string, existingScores?: AiStockScore[]) => {
    setAiSessionId(sessionId);
    setStep('scoring');
    setScoringProgress(null);

    // closure 변수로 점수를 수집 — React 상태에 의존하지 않음
    const collected = new Map<string, AiStockScore>();

    if (existingScores && existingScores.length > 0) {
      const map = new Map<string, AiStockScore>();
      for (const s of existingScores) {
        map.set(s.stockCode, s);
        collected.set(s.stockCode, s);
      }
      setAiScores(map);
    }

    const startTime = Date.now();
    const elapsedTimer = setInterval(() => {
      setScoringElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    const abort = streamAiSession(sessionId, {
      onProgress: (progress) => setScoringProgress(progress),
      onScore: (score) => {
        collected.set(score.stockCode, score);
        setAiScores((prev) => new Map(prev).set(score.stockCode, score));
      },
      onDone: () => {
        clearInterval(elapsedTimer);
        setScoringProgress(null);
        setAbortScoring(null);
        setAiSessionId(null);
        setStep('scored');
        createMeetingNotification('completed');
        const allScores = Array.from(collected.values());
        if (allScores.length > 0) {
          saveAiMeetingResults(allScores).catch(() => {});
        }
      },
      onCancelled: () => {
        clearInterval(elapsedTimer);
        setScoringProgress(null);
        setAbortScoring(null);
        setAiSessionId(null);
        setStep('scanned');
      },
      onError: (message) => {
        clearInterval(elapsedTimer);
        const errorMsg = message || 'AI 점수 측정에 실패했습니다.';
        setError(errorMsg);
        setScoringProgress(null);
        setAbortScoring(null);
        setAiSessionId(null);
        setStep('scanned');
        createMeetingNotification('error', errorMsg);
      },
    });

    setAbortScoring(() => () => {
      // 서버에 취소 요청 후 SSE 스트림 종료
      cancelAiSession(sessionId)
        .then(() => createMeetingNotification('cancelled'))
        .catch(() => {});
      abort();
      clearInterval(elapsedTimer);
      setScoringProgress(null);
      setAbortScoring(null);
      setAiSessionId(null);
      setStep('scanned');
    });
  }, []);

  const createMeetingNotification = useCallback(async (type: 'started' | 'completed' | 'cancelled' | 'error', errorMessage?: string) => {
    try {
      const notifTypes: Record<string, string> = {
        started: 'ai_meeting_started',
        completed: 'ai_meeting_completed',
        cancelled: 'ai_meeting_started', // 같은 타입으로 기존 "시작" 알림을 대체
        error: 'ai_meeting_error',
      };
      const titles: Record<string, string> = {
        started: 'AI 전문가 회의 시작',
        completed: 'AI 전문가 회의 완료',
        cancelled: 'AI 전문가 회의 중단',
        error: 'AI 전문가 회의 오류',
      };
      const messages: Record<string, string> = {
        started: 'AI 전문가 회의가 시작되었습니다.',
        completed: 'AI 전문가 회의가 완료되었습니다. 결과를 확인하세요.',
        cancelled: 'AI 전문가 회의가 사용자에 의해 중단되었습니다.',
        error: errorMessage || 'AI 전문가 회의 중 오류가 발생했습니다.',
      };
      await api.post('/notifications/create', {
        type: notifTypes[type],
        title: titles[type],
        message: messages[type],
      });
    } catch { /* 실패해도 무시 */ }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const viewParam = searchParams.get('view');

      // 진행 중인 AI 세션이 있는지 확인
      try {
        const { active, session: activeSession } = await getActiveAiSession();
        if (!cancelled && active && activeSession && activeSession.status === 'running') {
          // 기존 세션의 종목 정보를 scanResults에 설정
          const fakeResults: ScanResult[] = activeSession.stocks.map((s: any) => ({
            stockCode: s.stockCode,
            stockName: s.stockName,
            bestStrategy: { strategyId: s.strategyId || '', strategyName: s.strategyName || '', variant: '' },
            totalReturnPct: s.totalReturnPct || 0,
            winRate: 0,
            maxDrawdownPct: 0,
            totalTrades: 0,
            summary: '',
            currentSignal: { direction: 'NEUTRAL', strength: 0, reason: '' },
            indicators: {},
          }));
          setScanResults(fakeResults);
          setSelected(new Set(fakeResults.map((r) => r.stockCode)));
          setScanInfo({ scanned: 0, eligible: 0, elapsed: 0 });

          connectToAiSession(activeSession.id, activeSession.scores);
          return;
        }
      } catch { /* ignore */ }

      // ?view=results — 저장된 AI 회의 결과 표시
      if (!cancelled && viewParam === 'results') {
        try {
          const results = await getAiMeetingResults();
          if (!cancelled && results.length > 0) {
            const scoreMap = new Map<string, AiStockScore>();
            const fakeResults: ScanResult[] = results.map((r) => {
              scoreMap.set(r.stockCode, r.data as AiStockScore);
              return {
                stockCode: r.stockCode,
                stockName: r.stockName,
                bestStrategy: { strategyId: '', strategyName: '', variant: '' },
                totalReturnPct: 0,
                winRate: 0,
                maxDrawdownPct: 0,
                totalTrades: 0,
                summary: '',
                currentSignal: { direction: 'NEUTRAL', strength: 0, reason: '' },
                indicators: {},
              };
            });
            setScanResults(fakeResults);
            setAiScores(scoreMap);
            setSelected(new Set(fakeResults.map((r) => r.stockCode)));
            setScanInfo({ scanned: 0, eligible: 0, elapsed: 0 });
            setStep('scored');
            // URL 파라미터 제거 (뒤로가기 시 재진입 방지)
            // window.history 사용 — setSearchParams는 searchParams를 변경하여
            // useEffect가 재실행되고 step이 'trading'으로 덮어씌워지는 버그를 유발
            window.history.replaceState(null, '', window.location.pathname);
            return;
          }
        } catch { /* ignore */ }
      }

      // 기존 자동매매 세션 확인
      if (!cancelled) {
        try {
          const list = await getSessions();
          if (!cancelled && list.length > 0) {
            setSessions(list);
            setStep('trading');
          }
        } catch { /* ignore */ }
      }
    }

    init();
    return () => { cancelled = true; };
  }, [connectToAiSession, searchParams]);

  const handleScan = async () => {
    setError('');
    setStep('scanning');
    setScanResults([]);
    setAiScores(new Map());
    setSelected(new Set());

    try {
      let excludeCodes: string[] = [];
      try {
        const balance = await getBalance();
        excludeCodes = balance.items
          .filter((item) => item.holdingQty > 0)
          .map((item) => item.stockCode);
      } catch { /* ignore */ }

      const result = await scanStocks({
        excludeCodes,
        topN: Number(topN),
        investmentAmount: Number(investmentAmount),
      });

      setScanResults(result.results);
      setScanInfo({
        scanned: result.scannedStocks,
        eligible: result.eligibleStocks,
        elapsed: result.elapsedMs,
      });
      setSelected(new Set(result.results.map((r) => r.stockCode)));
      setStep('scanned');
    } catch (err: any) {
      setError(err.message || '스캔에 실패했습니다.');
      setStep('idle');
    }
  };

  const handleAiScore = async () => {
    setError('');
    setScoringElapsed(0);
    setAiScores(new Map());

    const stocks = scanResults
      .filter((r) => selected.has(r.stockCode))
      .map((r) => ({
        stockCode: r.stockCode,
        stockName: r.stockName,
        totalReturnPct: r.totalReturnPct,
        strategyId: r.bestStrategy.strategyId,
        strategyName: r.bestStrategy.strategyName,
      }));

    try {
      const { sessionId } = await startAiSession(stocks);
      createMeetingNotification('started');
      connectToAiSession(sessionId);
    } catch (err: any) {
      setError(err.message || 'AI 세션 시작에 실패했습니다.');
    }
  };

  const handleStartTrading = () => {
    setError('');
    const selectedResults = scanResults.filter((r) => selected.has(r.stockCode));
    if (selectedResults.length === 0) {
      setError('종목을 선택해주세요.');
      return;
    }

    // 단일/복수 모두 설정 팝업을 열어 진입 방식(모니터링/즉시매수) 및 설정을 확정
    const items: TradingConfigItem[] = selectedResults.map((r) => ({
      stockCode: r.stockCode,
      stockName: r.stockName,
      strategyId: r.bestStrategy.strategyId,
      variant: r.bestStrategy.variant,
      takeProfitPct: 5,
      stopLossPct: -3,
      addOnBuyMode: 'skip',
    }));
    setConfigModalItems(items);
  };

  const submitSessions = async (
    sessionDtos: StartSessionRequest[],
    entryMode: SessionEntryMode,
  ) => {
    try {
      const newSessions = await startSessionsBatch({
        sessions: sessionDtos,
        entryMode,
      });
      setSessions(newSessions);
      setStep('trading');
      setConfigModalItems(null);
      setConflictState(null);
    } catch (err: any) {
      // 409 Conflict: 이미 활성 세션이 있는 종목 → 충돌 해결 모달 표시
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.body &&
        typeof err.body === 'object' &&
        err.body.code === 'SESSION_CONFLICT' &&
        Array.isArray(err.body.conflicts)
      ) {
        const conflictBody = err.body as SessionConflictError;
        setConflictState({
          conflicts: conflictBody.conflicts,
          pendingDtos: sessionDtos,
          entryMode,
        });
        return;
      }
      setError(err.message || '자동 매매 시작에 실패했습니다.');
    }
  };

  const startSessionsWithConfigs = async (
    items: TradingConfigItem[],
    entryMode: SessionEntryMode,
  ) => {
    const sessionDtos: StartSessionRequest[] = items.map((item) => ({
      stockCode: item.stockCode,
      stockName: item.stockName,
      strategyId: item.strategyId,
      variant: item.variant,
      investmentAmount: Number(investmentAmount),
      takeProfitPct: item.takeProfitPct,
      stopLossPct: item.stopLossPct,
      addOnBuyMode: item.addOnBuyMode,
      aiScore: aiScores.get(item.stockCode)?.score,
    }));
    await submitSessions(sessionDtos, entryMode);
  };

  const handleConflictConfirm = async (
    actions: Record<string, SessionConflictAction>,
  ) => {
    if (!conflictState) return;
    // 각 DTO에 사용자가 선택한 onConflict 값 주입. skip 선택 종목은 제외해도 무방하지만
    // 서버에서 skip을 받아도 기존 세션을 반환하므로 그대로 전송.
    const resolved = conflictState.pendingDtos.map((dto) => {
      const action = actions[dto.stockCode];
      if (!action) return dto;
      return { ...dto, onConflict: action };
    });
    await submitSessions(resolved, conflictState.entryMode);
  };

  const handleConflictCancel = () => {
    setConflictState(null);
  };

  const toggleSelect = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === scanResults.length) setSelected(new Set());
    else setSelected(new Set(scanResults.map((r) => r.stockCode)));
  };

  const handlePause = async (id: number) => {
    const updated = await pauseSession(id);
    setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
    // 일시정지 시 캐시된 실시간 가격 제거 — 재개 후 stale 값 표시 방지
    setPrices((prev) => {
      const next = new Map(prev);
      next.delete(updated.stockCode);
      return next;
    });
  };

  const handleResume = async (id: number) => {
    const updated = await resumeSession(id);
    setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
  };

  const handleStop = async (id: number) => {
    const updated = await stopSession(id);
    setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
    // 종료 시 캐시된 실시간 가격 제거
    setPrices((prev) => {
      const next = new Map(prev);
      next.delete(updated.stockCode);
      return next;
    });
  };

  const handleDeletePermanent = async (id: number, stockName: string) => {
    if (
      !window.confirm(
        `'${stockName}' 세션을 완전 삭제합니다.\n이 작업은 되돌릴 수 없습니다. 계속하시겠습니까?`,
      )
    ) {
      return;
    }
    try {
      await deleteSessionPermanent(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err: any) {
      setError(err.message || '세션 삭제에 실패했습니다.');
    }
  };

  const handleEditConfirm = async (items: TradingConfigItem[]) => {
    if (!editSession || items.length === 0) return;
    const item = items[0];
    try {
      const updated = await updateSession(editSession.id, {
        strategyId: item.strategyId,
        variant: item.variant,
        takeProfitPct: item.takeProfitPct,
        stopLossPct: item.stopLossPct,
        addOnBuyMode: item.addOnBuyMode,
      });
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setEditSession(null);
    } catch (err: any) {
      setError(err.message || '세션 수정에 실패했습니다.');
    }
  };

  const handleManualOrder = async (dto: ManualOrderRequest) => {
    if (!orderSession) return;
    try {
      const updated = await manualOrder(orderSession.id, dto);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setOrderSession(null);
    } catch (err: any) {
      setError(err.message || '주문에 실패했습니다.');
      setOrderSession(null);
    }
  };

  const STRATEGY_NAMES: Record<string, string> = {
    'day-trading': '일간 모멘텀',
    'mean-reversion': '평균회귀',
    'infinity-bot': '무한매수봇',
    'candle-pattern': '캔들 패턴',
  };

  return (
    <div className="scanner-page">
      <h1>AI 종목 추천 & 자동 매매</h1>

      {error && <div className="alert alert-error">{error}</div>}

      {configModalItems && (
        <AutoTradingConfigModal
          items={configModalItems}
          onCancel={() => setConfigModalItems(null)}
          onConfirm={(items, entryMode) =>
            void startSessionsWithConfigs(items, entryMode)
          }
        />
      )}

      {conflictState && (
        <SessionConflictModal
          conflicts={conflictState.conflicts}
          onCancel={handleConflictCancel}
          onConfirm={(actions) => void handleConflictConfirm(actions)}
        />
      )}

      {meetingResultModal && (
        <AiMeetingResultModal
          result={meetingResultModal}
          onClose={() => setMeetingResultModal(null)}
        />
      )}

      {orderSession && (
        <ManualOrderModal
          session={orderSession}
          currentPrice={prices.get(orderSession.stockCode)}
          onCancel={() => setOrderSession(null)}
          onConfirm={(dto) => void handleManualOrder(dto)}
        />
      )}

      {editSession && (
        <AutoTradingConfigModal
          title="자동 매매 설정 수정"
          description="전략과 목표 수익/손절 기준을 변경할 수 있습니다. 변경사항은 즉시 모니터링에 반영됩니다."
          confirmLabel="수정 저장"
          showEntryMode={false}
          items={[
            {
              stockCode: editSession.stockCode,
              stockName: editSession.stockName,
              strategyId: editSession.strategyId,
              variant: editSession.variant,
              takeProfitPct: editSession.takeProfitPct,
              stopLossPct: editSession.stopLossPct,
              addOnBuyMode: editSession.addOnBuyMode,
            },
          ]}
          onCancel={() => setEditSession(null)}
          onConfirm={(items) => void handleEditConfirm(items)}
        />
      )}

      {/* ── Step 1: 스캔 설정 ── */}
      {(step === 'idle' || step === 'scanning') && (
        <div className="scanner-config card">
          <h2>1. 최적 종목 스캔</h2>
          <p className="text-muted">
            전체 KRX 종목을 4가지 전략으로 백테스팅하여 최적 종목을 추출합니다.
          </p>
          <div className="form-row">
            <label>
              투자 금액
              <input type="text" value={investmentAmount}
                onChange={(e) => setInvestmentAmount(e.target.value)} disabled={step === 'scanning'} />
            </label>
            <label>
              Top N
              <input type="number" value={topN}
                onChange={(e) => setTopN(e.target.value)} min="1" max="50" disabled={step === 'scanning'} />
            </label>
          </div>
          <button className="btn btn-primary btn-lg" onClick={handleScan} disabled={step === 'scanning'}>
            {step === 'scanning' ? '스캔 중...' : 'AI 최적 종목 추출'}
          </button>
          {step === 'scanning' && (
            <div className="scan-progress">
              <div className="spinner" />
              <span>전체 종목 백테스팅 진행 중... (약 15~30초 소요)</span>
            </div>
          )}
        </div>
      )}

      {/* ── Step 2: 스캔 결과 + AI 점수 ── */}
      {(step === 'scanned' || step === 'scoring' || step === 'scored') && (
        <div className="scan-results card">
          <div className="scan-header">
            <h2>2. 스캔 결과 & AI 전문가 회의</h2>
            <div className="scan-stats">
              <span>스캔: {fmt(scanInfo.scanned)}개</span>
              <span>유효: {fmt(scanInfo.eligible)}개</span>
              <span>소요: {(scanInfo.elapsed / 1000).toFixed(1)}초</span>
            </div>
          </div>

          {step === 'scoring' && (
            <div className="meeting-progress card">
              <div className="spinner spinner-lg" />
              <div className="meeting-steps">
                <p><strong>
                  {scoringProgress
                    ? `[${scoringProgress.current}/${scoringProgress.total}] ${scoringProgress.stockName} — ${
                        scoringProgress.phase === 'phase1' ? 'Phase 1: 뉴스 수집 + 차트 분석' :
                        scoringProgress.phase === 'phase2' ? 'Phase 2: 전문가 분석' :
                        scoringProgress.phase === 'phase3' ? 'Phase 3: 회의 종합' :
                        '준비 중...'
                      }`
                    : 'AI 전문가 회의 준비 중...'}
                </strong></p>
                <div className="scoring-meta">
                  <span className="scoring-elapsed">{Math.floor(scoringElapsed / 60)}분 {scoringElapsed % 60}초 경과</span>
                  <span className="text-muted">
                    완료: {aiScores.size}/{scanResults.length} 종목
                  </span>
                </div>
                {scoringProgress && (
                  <>
                    <div className="phase-indicator">
                      <div className={`phase-dot ${scoringProgress.phase === 'phase1' ? 'active' : scoringProgress.phase === 'phase2' || scoringProgress.phase === 'phase3' ? 'done' : ''}`} />
                      <div className="phase-line" />
                      <div className={`phase-dot ${scoringProgress.phase === 'phase2' ? 'active' : scoringProgress.phase === 'phase3' ? 'done' : ''}`} />
                      <div className="phase-line" />
                      <div className={`phase-dot ${scoringProgress.phase === 'phase3' ? 'active' : ''}`} />
                    </div>
                    <div className="phase-labels">
                      <span>데이터 수집</span>
                      <span>전문가 분석</span>
                      <span>회의 종합</span>
                    </div>
                  </>
                )}
                {abortScoring && (
                  <button className="btn btn-sm btn-danger" style={{ marginTop: 12 }} onClick={abortScoring}>
                    중단
                  </button>
                )}
              </div>
            </div>
          )}

          <table className="data-table">
            <thead>
              <tr>
                <th><input type="checkbox" checked={selected.size === scanResults.length} onChange={toggleSelectAll} /></th>
                <th>#</th>
                <th>종목</th>
                <th>전략</th>
                <th>수익률</th>
                <th>승률</th>
                <th>MDD</th>
                <th>거래수</th>
                <th>AI 점수</th>
              </tr>
            </thead>
            <tbody>
              {scanResults.map((r, i) => {
                const score = aiScores.get(r.stockCode);
                const isExpanded = expandedDetail === r.stockCode;
                return (
                  <>
                    <tr key={r.stockCode}>
                      <td><input type="checkbox" checked={selected.has(r.stockCode)} onChange={() => toggleSelect(r.stockCode)} /></td>
                      <td>{i + 1}</td>
                      <td>
                        <strong>{r.stockName}</strong><br />
                        <small className="text-muted">{r.stockCode}</small>
                      </td>
                      <td>
                        {STRATEGY_NAMES[r.bestStrategy.strategyId] || r.bestStrategy.strategyId}
                        {r.bestStrategy.variant && <small className="text-muted"> ({r.bestStrategy.variant})</small>}
                      </td>
                      <td className={pctClass(r.totalReturnPct)}>{r.totalReturnPct.toFixed(2)}%</td>
                      <td>{(r.winRate * 100).toFixed(1)}%</td>
                      <td className="text-loss">{r.maxDrawdownPct.toFixed(2)}%</td>
                      <td>{r.totalTrades}</td>
                      <td>
                        {score ? (
                          <div className="ai-score-cell">
                            <button
                              className={`ai-score-btn ${score.score >= 7 ? 'score-high' : score.score >= 4 ? 'score-mid' : 'score-low'}`}
                              onClick={() => setExpandedDetail(isExpanded ? null : r.stockCode)}
                              title="클릭하여 전문가 회의 상세 보기"
                            >
                              {score.score.toFixed(2)}
                            </button>
                            {score.expertDetail?.conclusion.finalRecommendation && (
                              <span className={`rec-badge rec-sm ${REC_CLASS[score.expertDetail.traderOpinion.recommendation] || 'rec-hold'}`}>
                                {REC_LABELS[score.expertDetail.traderOpinion.recommendation] || '관망'}
                              </span>
                            )}
                          </div>
                        ) : step === 'scoring' && selected.has(r.stockCode) ? (
                          <span className="scoring-dot">분석중</span>
                        ) : (
                          <span className="text-muted">-</span>
                        )}
                      </td>
                    </tr>
                    {/* 전략 분석 근거 요약 */}
                    <tr key={`${r.stockCode}-strategy`} className="strategy-summary-row">
                      <td colSpan={9}>
                        <div className="strategy-summary">
                          <span className={`signal-badge signal-${r.currentSignal.direction.toLowerCase()}`}>
                            {r.currentSignal.direction === 'BUY' ? '매수' : r.currentSignal.direction === 'SELL' ? '매도' : '중립'}
                            <small>{(r.currentSignal.strength * 100).toFixed(0)}%</small>
                          </span>
                          <span className="strategy-reason">{r.currentSignal.reason}</span>
                          <span className="strategy-detail">{r.summary}</span>
                        </div>
                      </td>
                    </tr>
                    {/* 점수 근거 요약 (점수 완료된 종목) */}
                    {score && !isExpanded && (
                      <tr key={`${r.stockCode}-summary`} className="score-summary-row">
                        <td colSpan={9}>
                          <div className="score-summary" onClick={() => setExpandedDetail(r.stockCode)}>
                            <span className="score-reasoning">{score.reasoning || '분석 결과 없음'}</span>
                            <span className="expand-hint">상세 보기 ▾</span>
                          </div>
                        </td>
                      </tr>
                    )}
                    {/* 전문가 회의 상세 패널 */}
                    {isExpanded && score && (
                      <tr key={`${r.stockCode}-detail`} className="detail-row">
                        <td colSpan={9}>
                          <div className="expert-meeting-detail">
                            <div className="detail-header">
                              <h3>전문가 회의 분석 - {r.stockName}</h3>
                              <button className="btn btn-sm btn-text" onClick={() => setExpandedDetail(null)}>접기 ▴</button>
                            </div>

                            {/* 종합 분석 결과 */}
                            <div className="final-score-banner">
                              <div className={`final-score ${score.score >= 7 ? 'score-high' : score.score >= 4 ? 'score-mid' : 'score-low'}`}>
                                {score.score.toFixed(2)}
                              </div>
                              <div className="final-reasoning">
                                <p><strong>{score.expertDetail?.conclusion.finalRecommendation || '분석 완료'}</strong></p>
                                <p>{score.reasoning}</p>
                              </div>
                            </div>

                            {/* 뉴스 & 차트 요약 */}
                            <div className="data-summary">
                              <div className="data-block">
                                <small className="section-label">뉴스 수집 결과</small>
                                {score.newsItems && score.newsItems.length > 0 ? (
                                  <ul className="news-list">
                                    {score.newsItems.map((item: NewsItem, j: number) => (
                                      <li key={j} className={`news-item news-${item.impact}`}>
                                        <div className="news-title">
                                          {item.url ? (
                                            <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
                                          ) : (
                                            <span>{item.title}</span>
                                          )}
                                          <span className={`news-impact impact-${item.impact}`}>
                                            {item.impact === 'positive' ? '호재' : item.impact === 'negative' ? '악재' : '중립'}
                                          </span>
                                        </div>
                                        <p className="news-summary">{item.summary}</p>
                                        {item.url && (
                                          <span className="news-source">
                                            <a href={item.url} target="_blank" rel="noopener noreferrer">
                                              {(() => { try { return new URL(item.url).hostname; } catch { return item.url; } })()}
                                            </a>
                                          </span>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                ) : score.newsHighlights.length > 0 ? (
                                  <ul>{score.newsHighlights.map((n, j) => <li key={j}>{n}</li>)}</ul>
                                ) : (
                                  <p className="text-muted">수집된 뉴스 없음</p>
                                )}
                              </div>
                              {score.chartAnalysis && (
                                <div className="data-block">
                                  <small className="section-label">차트 분석</small>
                                  <p>{score.chartAnalysis}</p>
                                </div>
                              )}
                            </div>

                            {/* 전문가 의견 카드 */}
                            {score.expertDetail && (
                              <>
                                <div className="expert-cards">
                                  <ExpertCard
                                    title="주식 전문가 트레이더"
                                    role="단기 매매 / 기술적 분석"
                                    opinion={score.expertDetail.traderOpinion}
                                  />
                                  <ExpertCard
                                    title="경제 전문 분석가"
                                    role="거시경제 / 펀더멘탈 분석"
                                    opinion={score.expertDetail.economistOpinion}
                                  />
                                </div>

                                {/* 회의 결론 */}
                                <div className="meeting-conclusion">
                                  <h4>회의 결론</h4>
                                  <p className="conclusion-rec">{score.expertDetail.conclusion.finalRecommendation}</p>
                                  <p className="conclusion-reasoning">{score.expertDetail.conclusion.reasoning}</p>

                                  {score.expertDetail.conclusion.consensusPoints.length > 0 && (
                                    <div className="conclusion-section">
                                      <small className="section-label">합의점</small>
                                      <ul>{score.expertDetail.conclusion.consensusPoints.map((p, j) => <li key={j}>{p}</li>)}</ul>
                                    </div>
                                  )}
                                  {score.expertDetail.conclusion.disagreements.length > 0 && (
                                    <div className="conclusion-section">
                                      <small className="section-label">이견</small>
                                      <ul>{score.expertDetail.conclusion.disagreements.map((d, j) => <li key={j}>{d}</li>)}</ul>
                                    </div>
                                  )}
                                </div>
                              </>
                            )}

                            {score.riskFactors.length > 0 && (
                              <div className="conclusion-section">
                                <small className="section-label text-loss">리스크 요인</small>
                                <ul>{score.riskFactors.map((rf, j) => <li key={j}>{rf}</li>)}</ul>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>

          <div className="scan-actions">
            {step === 'scanned' && (
              <>
                <button className="btn btn-secondary" onClick={handleAiScore}>
                  AI 전문가 회의 시작
                </button>
                <button className="btn btn-primary" onClick={handleStartTrading} disabled={selected.size === 0}>
                  선택 종목 자동 매매 시작 ({selected.size}개)
                </button>
              </>
            )}
            {step === 'scored' && (
              <button className="btn btn-primary" onClick={handleStartTrading} disabled={selected.size === 0}>
                선택 종목 자동 매매 시작 ({selected.size}개)
              </button>
            )}
            <button className="btn btn-text" onClick={() => { setStep('idle'); setScanResults([]); setExpandedDetail(null); }}>
              다시 스캔
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: 자동 매매 모니터링 ── */}
      {step === 'trading' && sessions.length > 0 && (
        <div className="trading-monitor card">
          <div className="monitor-header">
            <h2>3. 자동 매매 모니터링</h2>
            <div className="monitor-status">
              <span className={`ws-indicator ${connected ? 'connected' : 'disconnected'}`}>
                {connected ? 'LIVE' : 'OFFLINE'}
              </span>
              <button className="btn btn-text btn-sm" onClick={() => getSessions().then(setSessions)}>새로고침</button>
              <button className="btn btn-text btn-sm" onClick={() => setStep('idle')}>새 스캔</button>
            </div>
          </div>

          <div className="session-summary">
            <div className="stat-card">
              <label>활성 세션</label>
              <span>{sessions.filter((s) => s.status === 'active').length}</span>
            </div>
            <div className="stat-card">
              <label>보유중 / 대기중</label>
              <span>
                <span className="text-profit">
                  {sessions.filter((s) => s.status === 'active' && s.holdingQty > 0).length}
                </span>
                <small className="text-muted"> / </small>
                <span style={{ color: '#e67700' }}>
                  {sessions.filter((s) => s.status === 'active' && s.holdingQty === 0).length}
                </span>
              </span>
            </div>
            <div className="stat-card">
              <label>총 실현 손익</label>
              <span className={pctClass(sessions.reduce((a, s) => a + Number(s.realizedPnl), 0))}>
                {fmt(sessions.reduce((a, s) => a + Number(s.realizedPnl), 0))}원
              </span>
            </div>
            <div className="stat-card">
              <label>총 평가 손익</label>
              <span className={pctClass(sessions.reduce((a, s) => a + Number(s.unrealizedPnl), 0))}>
                {fmt(sessions.reduce((a, s) => a + Number(s.unrealizedPnl), 0))}원
              </span>
            </div>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>종목</th><th>전략</th><th>목표/손절</th><th>보유 시<br />매수신호</th><th>상태</th><th>포지션</th><th>보유수량</th><th>평균단가</th>
                <th>현재가</th><th>평가 손익</th><th>실현 손익</th><th>AI</th><th>관리</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                // 활성 세션만 실시간 현재가 표시 — 비활성(일시정지/종료)은 DB 저장 값으로 폴백
                const cp = s.status === 'active' ? prices.get(s.stockCode) : undefined;
                const unr = cp && s.holdingQty > 0 ? (cp - s.avgBuyPrice) * s.holdingQty : Number(s.unrealizedPnl);
                // 백엔드 계산값이 있으면 사용, 없으면 holdingQty 로 폴백 (구버전 API 호환)
                const positionStatus = s.positionStatus ?? (s.holdingQty > 0 ? 'holding' : 'waiting');
                return (
                  <tr key={s.id} className={`session-${s.status}`}>
                    <td><strong>{s.stockName}</strong><br /><small className="text-muted">{s.stockCode}</small></td>
                    <td>{STRATEGY_NAMES[s.strategyId] || s.strategyId}{s.variant && <small className="text-muted"> ({s.variant})</small>}</td>
                    <td>
                      <span className="text-profit">+{s.takeProfitPct}%</span>
                      <small className="text-muted"> / </small>
                      <span className="text-loss">{s.stopLossPct}%</span>
                    </td>
                    <td>
                      <span
                        className={`add-on-badge add-on-${s.addOnBuyMode}`}
                        title="보유 중 매수 신호가 발생했을 때의 처리"
                      >
                        {s.addOnBuyMode === 'add' ? '추가매수' : '스킵'}
                      </span>
                    </td>
                    <td><span className={`status-badge status-${s.status}`}>
                      {s.status === 'active' ? '활성' : s.status === 'paused' ? '일시정지' : '종료'}
                    </span></td>
                    <td>
                      <span
                        className={`position-badge position-${positionStatus}`}
                        title={
                          positionStatus === 'holding'
                            ? '실제 매수되어 보유 중 (익절/손절 감시)'
                            : '아직 매수 전 — 전략 매수 신호 대기 중'
                        }
                      >
                        {positionStatus === 'holding' ? '보유중' : '대기중'}
                      </span>
                    </td>
                    <td>{fmt(s.holdingQty)}</td>
                    <td>{fmt(Math.round(s.avgBuyPrice))}</td>
                    <td>{cp ? fmt(cp) : '-'}</td>
                    <td className={pctClass(unr)}>{fmt(Math.round(unr))}원</td>
                    <td className={pctClass(Number(s.realizedPnl))}>{fmt(Number(s.realizedPnl))}원</td>
                    <td>
                      {s.aiScore ? (
                        <button
                          className={`ai-score-btn ${s.aiScore >= 7 ? 'score-high' : s.aiScore >= 4 ? 'score-mid' : 'score-low'}`}
                          title="AI 전문가 회의 결과 보기"
                          onClick={() => {
                            const cached = meetingResultCache.get(s.stockCode);
                            if (cached) {
                              setMeetingResultModal(cached);
                            } else {
                              getAiMeetingResult(s.stockCode).then((r) => {
                                if (r) {
                                  setMeetingResultCache((prev) => new Map(prev).set(s.stockCode, r));
                                  setMeetingResultModal(r);
                                }
                              }).catch(() => {});
                            }
                          }}
                        >
                          {s.aiScore.toFixed(1)}
                        </button>
                      ) : '-'}
                    </td>
                    <td className="session-actions">
                      {s.status === 'active' && (
                        <>
                          <button className="btn btn-sm btn-order" onClick={() => setOrderSession(s)}>주문</button>
                          <button className="btn btn-sm" onClick={() => setEditSession(s)}>수정</button>
                          <button
                            className="btn btn-sm btn-warning"
                            onClick={() => handlePause(s.id)}
                            disabled={positionStatus === 'holding'}
                            title={positionStatus === 'holding' ? '보유 중인 종목은 일시정지할 수 없습니다 (먼저 매도 필요)' : undefined}
                          >
                            일시정지
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => handleStop(s.id)}
                            disabled={positionStatus === 'holding'}
                            title={positionStatus === 'holding' ? '보유 중인 종목은 종료할 수 없습니다 (먼저 매도 필요)' : undefined}
                          >
                            종료
                          </button>
                        </>
                      )}
                      {s.status === 'paused' && (
                        <>
                          <button className="btn btn-sm btn-order" onClick={() => setOrderSession(s)}>주문</button>
                          <button className="btn btn-sm" onClick={() => setEditSession(s)}>수정</button>
                          <button className="btn btn-sm btn-primary" onClick={() => handleResume(s.id)}>재개</button>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => handleStop(s.id)}
                            disabled={positionStatus === 'holding'}
                            title={positionStatus === 'holding' ? '보유 중인 종목은 종료할 수 없습니다 (먼저 매도 필요)' : undefined}
                          >
                            종료
                          </button>
                        </>
                      )}
                      {s.status === 'stopped' && (
                        <>
                          <span className="text-muted">{s.stoppedAt ? new Date(s.stoppedAt).toLocaleDateString('ko-KR') : '종료됨'}</span>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => handleDeletePermanent(s.id, s.stockName)}
                            title="비활성 세션 완전 삭제 (되돌릴 수 없음)"
                          >
                            완전 삭제
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
