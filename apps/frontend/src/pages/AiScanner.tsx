import { useState, useEffect } from 'react';
import { scanStocks, streamAiScores } from '../api/scanner';
import type { SseProgress } from '../api/scanner';
import { startSessionsBatch, getSessions, pauseSession, resumeSession, stopSession, updateSession } from '../api/auto-trading';
import { getBalance } from '../api/kis';
import { ApiError } from '../api/client';
import { useAutoTradingWebSocket, type PriceUpdate } from '../hooks/useAutoTradingWebSocket';
import type { ScanResult, AiStockScore, ExpertOpinion, NewsItem } from '../types/scanner';
import type {
  AutoTradingSession,
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

export function AiScanner() {
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
  const [conflictState, setConflictState] = useState<{
    conflicts: SessionConflictItem[];
    pendingDtos: StartSessionRequest[];
    entryMode: SessionEntryMode;
  } | null>(null);

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

  useEffect(() => {
    getSessions()
      .then((list) => {
        if (list.length > 0) {
          setSessions(list);
          setStep('trading');
        }
      })
      .catch(() => {});
  }, []);

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

  const handleAiScore = () => {
    setError('');
    setStep('scoring');
    setScoringProgress(null);
    setScoringElapsed(0);
    setAiScores(new Map());

    const startTime = Date.now();
    const elapsedTimer = setInterval(() => {
      setScoringElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    const stocks = scanResults
      .filter((r) => selected.has(r.stockCode))
      .map((r) => ({
        stockCode: r.stockCode,
        stockName: r.stockName,
        totalReturnPct: r.totalReturnPct,
        strategyId: r.bestStrategy.strategyId,
        strategyName: r.bestStrategy.strategyName,
      }));

    const abort = streamAiScores(stocks, {
      onProgress: (progress) => {
        setScoringProgress(progress);
      },
      onScore: (score) => {
        setAiScores((prev) => new Map(prev).set(score.stockCode, score));
      },
      onDone: () => {
        clearInterval(elapsedTimer);
        setScoringProgress(null);
        setAbortScoring(null);
        setStep('scored');
      },
      onError: (message) => {
        clearInterval(elapsedTimer);
        setError(message || 'AI 점수 측정에 실패했습니다.');
        setScoringProgress(null);
        setAbortScoring(null);
        setStep('scanned');
      },
    });

    setAbortScoring(() => () => {
      abort();
      clearInterval(elapsedTimer);
      setScoringProgress(null);
      setStep('scanned');
    });
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
  };

  const handleResume = async (id: number) => {
    const updated = await resumeSession(id);
    setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
  };

  const handleStop = async (id: number) => {
    const updated = await stopSession(id);
    setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
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
      });
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setEditSession(null);
    } catch (err: any) {
      setError(err.message || '세션 수정에 실패했습니다.');
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
                <th>종목</th><th>전략</th><th>목표/손절</th><th>상태</th><th>보유수량</th><th>평균단가</th>
                <th>현재가</th><th>평가 손익</th><th>실현 손익</th><th>AI</th><th>관리</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const cp = prices.get(s.stockCode);
                const unr = cp && s.holdingQty > 0 ? (cp - s.avgBuyPrice) * s.holdingQty : Number(s.unrealizedPnl);
                return (
                  <tr key={s.id} className={`session-${s.status}`}>
                    <td><strong>{s.stockName}</strong><br /><small className="text-muted">{s.stockCode}</small></td>
                    <td>{STRATEGY_NAMES[s.strategyId] || s.strategyId}{s.variant && <small className="text-muted"> ({s.variant})</small>}</td>
                    <td>
                      <span className="text-profit">+{s.takeProfitPct}%</span>
                      <small className="text-muted"> / </small>
                      <span className="text-loss">{s.stopLossPct}%</span>
                    </td>
                    <td><span className={`status-badge status-${s.status}`}>
                      {s.status === 'active' ? '활성' : s.status === 'paused' ? '일시정지' : '종료'}
                    </span></td>
                    <td>{fmt(s.holdingQty)}</td>
                    <td>{fmt(Math.round(s.avgBuyPrice))}</td>
                    <td>{cp ? fmt(cp) : '-'}</td>
                    <td className={pctClass(unr)}>{fmt(Math.round(unr))}원</td>
                    <td className={pctClass(Number(s.realizedPnl))}>{fmt(Number(s.realizedPnl))}원</td>
                    <td>{s.aiScore ? s.aiScore.toFixed(1) : '-'}</td>
                    <td className="session-actions">
                      {s.status === 'active' && (
                        <>
                          <button className="btn btn-sm" onClick={() => setEditSession(s)}>수정</button>
                          <button className="btn btn-sm btn-warning" onClick={() => handlePause(s.id)}>일시정지</button>
                          <button className="btn btn-sm btn-danger" onClick={() => handleStop(s.id)}>종료</button>
                        </>
                      )}
                      {s.status === 'paused' && (
                        <>
                          <button className="btn btn-sm" onClick={() => setEditSession(s)}>수정</button>
                          <button className="btn btn-sm btn-primary" onClick={() => handleResume(s.id)}>재개</button>
                          <button className="btn btn-sm btn-danger" onClick={() => handleStop(s.id)}>종료</button>
                        </>
                      )}
                      {s.status === 'stopped' && (
                        <span className="text-muted">{s.stoppedAt ? new Date(s.stoppedAt).toLocaleDateString('ko-KR') : '종료됨'}</span>
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
