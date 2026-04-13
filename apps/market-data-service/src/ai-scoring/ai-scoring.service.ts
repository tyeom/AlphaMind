import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Stock } from '../stock/entities/stock.entity';
import { StockDailyPrice } from '../stock/entities/stock-daily-price.entity';
import { spawnClaude, spawnParallelAgents, TOKEN_LIMIT_MSG, ABORT_MSG } from './claude-pty';
import { AgentConfigService } from '../agent-config/agent-config.service';
import {
  AiScoreRequestItem,
  AiStockScore,
  AiScoreResponse,
  NewsAgentResult,
  ChartAgentResult,
  ExpertOpinion,
  MeetingConclusion,
} from './types/ai-scoring.types';

export const OAUTH_EXPIRED_MSG = 'Claude OAuth 토큰이 만료되었습니다. 재로그인이 필요합니다.';

export interface AiMeetingSession {
  id: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  stocks: AiScoreRequestItem[];
  scores: AiStockScore[];
  progress: {
    current: number;
    total: number;
    stockCode: string;
    stockName: string;
    phase: string;
  } | null;
  startedAt: number;
  completedAt?: number;
  elapsedMs?: number;
  error?: string;
  userId: number;
  abortController?: AbortController;
}

/**
 * 3단계 멀티 에이전트 회의 시스템
 *
 * Phase 1 (병렬): 데이터 수집
 *   - 뉴스 에이전트: 최신 뉴스 검색 + 감성 분석
 *   - 차트 에이전트: 기술적 분석 + 점수 산출
 *
 * Phase 2 (병렬): 전문가 분석
 *   - 주식 전문가 트레이더: 매매 관점 분석
 *   - 경제 전문 분석가: 거시경제 + 펀더멘탈 관점 분석
 *
 * Phase 3 (직렬): 회의 종합
 *   - 두 전문가 의견을 종합하여 최종 점수 + 추천 결정
 */
@Injectable()
export class AiScoringService {
  private readonly logger = new Logger(AiScoringService.name);
  private sessions = new Map<string, AiMeetingSession>();

  constructor(
    private readonly em: EntityManager,
    private readonly agentConfig: AgentConfigService,
  ) {}

  /** 백그라운드 세션 시작 — sessionId 즉시 반환 */
  startBackgroundSession(stocks: AiScoreRequestItem[], userId: number): string {
    const existingRunning = this.getActiveSession(userId);
    if (existingRunning) {
      return existingRunning.id;
    }

    const id = `ai-meeting-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const abortController = new AbortController();
    const session: AiMeetingSession = {
      id,
      status: 'running',
      stocks,
      scores: [],
      progress: null,
      startedAt: Date.now(),
      userId,
      abortController,
    };
    this.sessions.set(id, session);

    this.runSessionInBackground(session).catch((err) => {
      session.status = 'error';
      session.error = err.message;
      this.logger.error(`백그라운드 세션 오류: ${err.message}`);
    });

    return id;
  }

  getSession(id: string): AiMeetingSession | undefined {
    return this.sessions.get(id);
  }

  getActiveSession(userId: number): AiMeetingSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.status === 'running') {
        return session;
      }
    }
    return undefined;
  }

  cancelSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'running') return false;

    session.status = 'cancelled';
    session.completedAt = Date.now();
    session.elapsedMs = session.completedAt - session.startedAt;
    session.progress = null;

    // 실행 중인 Claude CLI 프로세스를 즉시 종료
    session.abortController?.abort();
    this.logger.log(`AI 회의 세션 취소 (프로세스 강제 종료): ${id}`);

    setTimeout(() => this.sessions.delete(id), 3_600_000);
    return true;
  }

  private async runSessionInBackground(session: AiMeetingSession) {
    const signal = session.abortController?.signal;

    try {
      await this.ensureAuth();

      for (let i = 0; i < session.stocks.length; i++) {
        // 취소 요청 확인
        if (session.status !== 'running') {
          this.logger.log(`AI 회의 세션 중단됨: ${session.id} (${i}/${session.stocks.length} 완료)`);
          return;
        }

        const stock = session.stocks[i];

        session.progress = {
          current: i + 1,
          total: session.stocks.length,
          stockCode: stock.stockCode,
          stockName: stock.stockName,
          phase: 'starting',
        };

        const score = await this.scoreSingleStock(stock, (phase) => {
          session.progress = {
            current: i + 1,
            total: session.stocks.length,
            stockCode: stock.stockCode,
            stockName: stock.stockName,
            phase,
          };
        }, signal);

        // 분석 완료 후에도 취소 확인
        if (session.status !== 'running') {
          this.logger.log(`AI 회의 세션 중단됨: ${session.id} (${i + 1}/${session.stocks.length} 완료)`);
          return;
        }

        session.scores.push(score);
      }

      session.status = 'completed';
      session.completedAt = Date.now();
      session.elapsedMs = session.completedAt - session.startedAt;
      session.progress = null;
      this.logger.log(`백그라운드 AI 회의 완료: ${session.id} (${session.elapsedMs}ms)`);

      // 1시간 후 세션 정리
      setTimeout(() => this.sessions.delete(session.id), 3_600_000);
    } catch (err: any) {
      // abort에 의한 에러는 이미 cancelled 상태이므로 error로 덮어쓰지 않음
      if (err.message === ABORT_MSG && session.status === 'cancelled') {
        this.logger.log(`AI 회의 세션 중단 완료: ${session.id}`);
        return;
      }
      session.status = 'error';
      session.error = err.message;
      session.completedAt = Date.now();
      session.elapsedMs = session.completedAt - session.startedAt;
      setTimeout(() => this.sessions.delete(session.id), 3_600_000);
      throw err;
    }
  }

  /** Claude 호출 전 OAuth 토큰 유효성 확인 및 자동 갱신 (외부에서 호출 가능) */
  async ensureAuth(): Promise<void> {
    const valid = await this.agentConfig.ensureValidOAuthToken();
    if (!valid) {
      throw new Error(OAUTH_EXPIRED_MSG);
    }
  }

  async scoreStocks(stocks: AiScoreRequestItem[]): Promise<AiScoreResponse> {
    const startTime = Date.now();
    const scores: AiStockScore[] = [];

    try {
      await this.ensureAuth();
    } catch (err: any) {
      this.logger.error(err.message);
      return { scores: stocks.map((s) => this.fallbackScore(s, err.message)), elapsedMs: Date.now() - startTime };
    }

    for (const stock of stocks) {
      try {
        this.logger.log(`=== ${stock.stockName}(${stock.stockCode}) 멀티 에이전트 분석 시작 ===`);
        const score = await this.analyzeStock(stock);
        scores.push(score);
        this.logger.log(`=== ${stock.stockName} 최종 점수: ${score.score} ===`);
      } catch (err: any) {
        if (err.message === TOKEN_LIMIT_MSG) {
          this.logger.error(`${TOKEN_LIMIT_MSG} 분석을 종료합니다.`);
          scores.push(this.fallbackScore(stock, TOKEN_LIMIT_MSG));
          break;
        }
        this.logger.error(`분석 실패: ${stock.stockCode} - ${err.message}`);
        scores.push(this.fallbackScore(stock, err.message));
      }
    }

    return { scores, elapsedMs: Date.now() - startTime };
  }

  /** SSE용 — 단일 종목 분석 + phase 콜백 */
  async scoreSingleStock(
    item: AiScoreRequestItem,
    onPhase?: (phase: string) => void,
    signal?: AbortSignal,
  ): Promise<AiStockScore> {
    try {
      await this.ensureAuth();
      this.logger.log(`=== ${item.stockName}(${item.stockCode}) 멀티 에이전트 분석 시작 ===`);
      const score = await this.analyzeStock(item, onPhase, signal);
      this.logger.log(`=== ${item.stockName} 최종 점수: ${score.score} ===`);
      return score;
    } catch (err: any) {
      // abort 에러는 상위로 전파
      if (err.message === ABORT_MSG) throw err;
      if (err.message === TOKEN_LIMIT_MSG) {
        this.logger.error(`${TOKEN_LIMIT_MSG} 분석을 종료합니다.`);
      } else {
        this.logger.error(`분석 실패: ${item.stockCode} - ${err.message}`);
      }
      return this.fallbackScore(item, err.message);
    }
  }

  private async analyzeStock(item: AiScoreRequestItem, onPhase?: (phase: string) => void, signal?: AbortSignal): Promise<AiStockScore> {
    const chartSummary = await this.buildChartSummary(item.stockCode);

    // ── Phase 1: 데이터 수집 (병렬) ──
    onPhase?.('phase1');
    this.logger.log(`[Phase 1] 데이터 수집 시작: ${item.stockCode}`);
    const { newsData, chartData } = await this.phase1DataCollection(item, chartSummary, signal);
    this.logger.log(`[Phase 1] 완료 — 뉴스 감성: ${newsData.sentiment}, 기술 점수: ${chartData.technicalScore}`);

    // ── Phase 2: 전문가 분석 (병렬) ──
    onPhase?.('phase2');
    this.logger.log(`[Phase 2] 전문가 분석 시작: ${item.stockCode}`);
    const { traderOpinion, economistOpinion } = await this.phase2ExpertAnalysis(
      item, chartSummary, newsData, chartData, signal,
    );
    this.logger.log(
      `[Phase 2] 완료 — 트레이더: ${traderOpinion.recommendation}(${traderOpinion.score}), ` +
      `분석가: ${economistOpinion.recommendation}(${economistOpinion.score})`,
    );

    // ── Phase 3: 회의 종합 ──
    onPhase?.('phase3');
    this.logger.log(`[Phase 3] 전문가 회의 시작: ${item.stockCode}`);
    const conclusion = await this.phase3Meeting(
      item, newsData, chartData, traderOpinion, economistOpinion, signal,
    );
    this.logger.log(`[Phase 3] 완료 — 최종 점수: ${conclusion.finalScore}`);

    return {
      stockCode: item.stockCode,
      stockName: item.stockName,
      score: conclusion.finalScore,
      reasoning: conclusion.reasoning,
      newsItems: newsData.newsItems || [],
      newsHighlights: newsData.newsHighlights,
      chartAnalysis: chartData.chartAnalysis,
      riskFactors: newsData.riskFactors,
      expertDetail: {
        traderOpinion,
        economistOpinion,
        conclusion,
      },
    };
  }

  // ═══════════════════════════════════════════════
  //  Phase 1: 데이터 수집 (뉴스 + 차트 병렬)
  // ═══════════════════════════════════════════════

  private async phase1DataCollection(
    item: AiScoreRequestItem,
    chartSummary: string,
    signal?: AbortSignal,
  ): Promise<{ newsData: NewsAgentResult; chartData: ChartAgentResult }> {
    const newsPrompt = `당신은 한국 주식시장 뉴스 전문 수집가입니다.

종목: ${item.stockName} (${item.stockCode})

작업:
1. "${item.stockName}" 관련 최신 뉴스를 웹에서 검색하세요 (최근 1~2주)
2. 반드시 실제 뉴스 기사를 찾아서 제목, URL, 핵심 요약을 포함하세요
3. 각 뉴스의 주가 영향도를 분석하세요
4. 전체 뉴스 감성을 종합 평가하세요
5. 투자 리스크 요인을 도출하세요

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "newsItems": [
    { "title": "뉴스 제목", "url": "https://실제뉴스URL", "summary": "핵심 요약 1~2문장", "impact": "positive" },
    { "title": "뉴스 제목2", "url": "https://실제뉴스URL2", "summary": "핵심 요약", "impact": "negative" }
  ],
  "newsHighlights": ["뉴스 핵심 요약 1", "뉴스 핵심 요약 2", "뉴스 핵심 요약 3"],
  "sentiment": "positive",
  "sentimentScore": 0.5,
  "keyIssues": ["핵심 이슈 1", "핵심 이슈 2"],
  "riskFactors": ["리스크 1", "리스크 2"]
}
newsItems[].impact: "positive" | "negative" | "neutral"
sentiment: "positive" | "negative" | "neutral"
sentimentScore: -1.0(매우 부정) ~ 1.0(매우 긍정)`;

    const chartPrompt = `당신은 한국 주식시장 기술적 분석 전문가입니다.

종목: ${item.stockName} (${item.stockCode})
섹터: ${item.sector || '미분류'}
백테스트 결과: ${item.strategyName} 전략 3개월 수익률 ${item.totalReturnPct}%

차트 데이터 (최근 3개월):
${chartSummary}

작업:
1. 추세, 지지/저항선, 모멘텀을 분석하세요
2. 기술적 관점에서 매수 적합도를 1~10점으로 평가하세요
3. 향후 1~3개월 방향성을 예측하세요

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "chartAnalysis": "기술적 분석 요약 2~3문장",
  "technicalScore": 7.5,
  "trendDirection": "상승",
  "supportLevel": 50000,
  "resistanceLevel": 65000,
  "momentum": "강함"
}
trendDirection: "상승" | "하락" | "횡보"
momentum: "강함" | "보통" | "약함"`;

    const results = await spawnParallelAgents(
      [
        { name: 'news', prompt: newsPrompt, timeoutMs: 240_000 },
        { name: 'chart', prompt: chartPrompt, timeoutMs: 180_000 },
      ],
      (name, p) => { if (p.done) this.logger.log(`  [Phase 1] ${name} 에이전트 완료`); },
      signal,
    );

    const newsData = this.safeParseJson<NewsAgentResult>(
      results.get('news')?.output || '',
      { newsItems: [], newsHighlights: [], sentiment: 'neutral', sentimentScore: 0, keyIssues: [], riskFactors: [] },
    );

    const chartData = this.safeParseJson<ChartAgentResult>(
      results.get('chart')?.output || '',
      { chartAnalysis: '', technicalScore: 5, trendDirection: '횡보', supportLevel: 0, resistanceLevel: 0, momentum: '보통' },
    );

    return { newsData, chartData };
  }

  // ═══════════════════════════════════════════════
  //  Phase 2: 전문가 분석 (트레이더 + 분석가 병렬)
  // ═══════════════════════════════════════════════

  private async phase2ExpertAnalysis(
    item: AiScoreRequestItem,
    chartSummary: string,
    newsData: NewsAgentResult,
    chartData: ChartAgentResult,
    signal?: AbortSignal,
  ): Promise<{ traderOpinion: ExpertOpinion; economistOpinion: ExpertOpinion }> {
    const dataContext = this.buildDataContext(item, chartSummary, newsData, chartData);

    const traderPrompt = `당신은 15년 경력의 한국 주식시장 전문 트레이더입니다.
단기 매매(스윙/데이트레이딩)에 특화되어 있으며, 기술적 분석과 수급 분석을 중시합니다.
리스크 관리에 엄격하고, 손익비(Risk-Reward Ratio)를 항상 계산합니다.

아래 데이터를 바탕으로 이 종목의 단기(1~3개월) 투자 의견을 제시하세요.

${dataContext}

트레이더 관점에서 분석하세요:
1. 현재 매수 타이밍이 적절한가?
2. 기술적 패턴상 기대 수익률은?
3. 손절선은 어디에 설정해야 하는가?
4. 수급 측면에서 유리한가?

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "recommendation": "buy",
  "score": 7.5,
  "analysis": "트레이더 관점 분석 요약 3~4문장",
  "keyPoints": ["매수 근거 1", "매수 근거 2", "매수 근거 3"],
  "concerns": ["우려사항 1", "우려사항 2"],
  "targetReturnPct": 15.0,
  "confidence": 0.7
}
recommendation: "strong_buy" | "buy" | "hold" | "sell" | "strong_sell"
score: 1.00(매도) ~ 10.00(강력 매수)
confidence: 0.0(확신 없음) ~ 1.0(매우 확신)`;

    const economistPrompt = `당신은 20년 경력의 경제 전문 분석가입니다.
거시경제, 산업 동향, 기업 펀더멘탈 분석에 특화되어 있습니다.
중장기 투자 관점을 중시하며, 뉴스와 시장 환경의 영향을 깊이 분석합니다.

아래 데이터를 바탕으로 이 종목의 투자 의견을 제시하세요.

${dataContext}

경제 분석가 관점에서 분석하세요:
1. 현재 경제 환경에서 이 섹터/종목이 유리한가?
2. 뉴스 이벤트가 주가에 미칠 중장기 영향은?
3. 기업의 펀더멘탈 대비 현재 가격은 적절한가?
4. 거시경제 리스크는 무엇인가?

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "recommendation": "buy",
  "score": 6.5,
  "analysis": "경제 분석가 관점 분석 요약 3~4문장",
  "keyPoints": ["투자 근거 1", "투자 근거 2", "투자 근거 3"],
  "concerns": ["우려사항 1", "우려사항 2"],
  "targetReturnPct": 10.0,
  "confidence": 0.6
}
recommendation: "strong_buy" | "buy" | "hold" | "sell" | "strong_sell"
score: 1.00(매도) ~ 10.00(강력 매수)
confidence: 0.0(확신 없음) ~ 1.0(매우 확신)`;

    const results = await spawnParallelAgents(
      [
        { name: 'trader', prompt: traderPrompt, timeoutMs: 180_000 },
        { name: 'economist', prompt: economistPrompt, timeoutMs: 180_000 },
      ],
      (name, p) => { if (p.done) this.logger.log(`  [Phase 2] ${name} 전문가 완료`); },
      signal,
    );

    const defaultOpinion: ExpertOpinion = {
      recommendation: 'hold',
      score: 5,
      analysis: '',
      keyPoints: [],
      concerns: [],
      targetReturnPct: 0,
      confidence: 0.3,
    };

    const traderOpinion = this.safeParseJson<ExpertOpinion>(
      results.get('trader')?.output || '', defaultOpinion,
    );

    const economistOpinion = this.safeParseJson<ExpertOpinion>(
      results.get('economist')?.output || '', defaultOpinion,
    );

    return { traderOpinion, economistOpinion };
  }

  // ═══════════════════════════════════════════════
  //  Phase 3: 전문가 회의 종합
  // ═══════════════════════════════════════════════

  private async phase3Meeting(
    item: AiScoreRequestItem,
    newsData: NewsAgentResult,
    chartData: ChartAgentResult,
    traderOpinion: ExpertOpinion,
    economistOpinion: ExpertOpinion,
    signal?: AbortSignal,
  ): Promise<MeetingConclusion> {
    const meetingPrompt = `당신은 투자위원회 의장입니다. 두 전문가의 분석을 종합하여 최종 투자 결정을 내려야 합니다.

═══ 종목 정보 ═══
종목: ${item.stockName} (${item.stockCode})
백테스트 수익률: ${item.totalReturnPct}%

═══ 수집된 데이터 ═══
뉴스 감성: ${newsData.sentiment} (${newsData.sentimentScore})
핵심 뉴스: ${newsData.newsHighlights.join(' / ')}
기술적 점수: ${chartData.technicalScore}/10
추세: ${chartData.trendDirection}, 모멘텀: ${chartData.momentum}

═══ 주식 전문가 트레이더 의견 ═══
추천: ${traderOpinion.recommendation} (점수: ${traderOpinion.score}/10, 확신도: ${(traderOpinion.confidence * 100).toFixed(0)}%)
분석: ${traderOpinion.analysis}
매수 근거: ${traderOpinion.keyPoints.join(' / ')}
우려사항: ${traderOpinion.concerns.join(' / ')}
목표 수익률: ${traderOpinion.targetReturnPct}%

═══ 경제 전문 분석가 의견 ═══
추천: ${economistOpinion.recommendation} (점수: ${economistOpinion.score}/10, 확신도: ${(economistOpinion.confidence * 100).toFixed(0)}%)
분석: ${economistOpinion.analysis}
투자 근거: ${economistOpinion.keyPoints.join(' / ')}
우려사항: ${economistOpinion.concerns.join(' / ')}
목표 수익률: ${economistOpinion.targetReturnPct}%

═══ 의장으로서의 임무 ═══
1. 두 전문가의 의견이 일치하는 부분을 정리하세요
2. 의견이 다른 부분을 정리하고, 어느 쪽이 더 타당한지 판단하세요
3. 최종 투자 점수를 결정하세요 (1.00~10.00)
4. 최종 추천 의견을 한 문장으로 작성하세요
5. 종합 분석 근거를 3~4문장으로 작성하세요

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "finalScore": 7.0,
  "finalRecommendation": "최종 추천 의견 한 문장",
  "consensusPoints": ["합의점 1", "합의점 2"],
  "disagreements": ["이견 1과 판단 근거", "이견 2와 판단 근거"],
  "reasoning": "종합 분석 근거 3~4문장"
}
finalScore: 1.00(강력 매도) ~ 10.00(강력 매수)`;

    const result = await spawnClaude(meetingPrompt, {
      timeoutMs: 180_000,
      onProgress: (p) => { if (p.done) this.logger.log(`  [Phase 3] 회의 종합 완료`); },
      signal,
    });

    const conclusion = this.safeParseJson<MeetingConclusion>(result.output, {
      finalScore: this.calculateFallbackScore(traderOpinion, economistOpinion),
      finalRecommendation: '전문가 회의 결과를 도출하지 못했습니다.',
      consensusPoints: [],
      disagreements: [],
      reasoning: this.buildFallbackReasoning(item, traderOpinion, economistOpinion),
    });

    // 점수 범위 보정
    conclusion.finalScore = Math.max(1, Math.min(10, Math.round(conclusion.finalScore * 100) / 100));

    return conclusion;
  }

  // ═══════════════════════════════════════════════
  //  유틸리티
  // ═══════════════════════════════════════════════

  private buildDataContext(
    item: AiScoreRequestItem,
    chartSummary: string,
    newsData: NewsAgentResult,
    chartData: ChartAgentResult,
  ): string {
    return `═══ 종목 정보 ═══
종목: ${item.stockName} (${item.stockCode})
섹터: ${item.sector || '미분류'}
백테스트: ${item.strategyName} 전략, 3개월 수익률 ${item.totalReturnPct}%

═══ 차트 데이터 (최근 3개월) ═══
${chartSummary}

═══ 기술적 분석 결과 ═══
기술적 점수: ${chartData.technicalScore}/10
추세: ${chartData.trendDirection}, 모멘텀: ${chartData.momentum}
지지선: ${chartData.supportLevel?.toLocaleString()}원, 저항선: ${chartData.resistanceLevel?.toLocaleString()}원
분석: ${chartData.chartAnalysis}

═══ 뉴스 분석 결과 ═══
감성: ${newsData.sentiment} (점수: ${newsData.sentimentScore})
핵심 뉴스:
${newsData.newsHighlights.map((n, i) => `  ${i + 1}. ${n}`).join('\n')}
핵심 이슈: ${newsData.keyIssues.join(', ')}
리스크: ${newsData.riskFactors.join(', ')}`;
  }

  /** 회의 실패 시 두 전문가 점수의 가중 평균으로 폴백 */
  private calculateFallbackScore(trader: ExpertOpinion, economist: ExpertOpinion): number {
    const traderWeight = trader.confidence || 0.5;
    const economistWeight = economist.confidence || 0.5;
    const totalWeight = traderWeight + economistWeight;
    const score = (trader.score * traderWeight + economist.score * economistWeight) / totalWeight;
    return Math.max(1, Math.min(10, Math.round(score * 100) / 100));
  }

  private buildFallbackReasoning(
    item: AiScoreRequestItem,
    trader: ExpertOpinion,
    economist: ExpertOpinion,
  ): string {
    return `${item.stockName}에 대해 트레이더는 ${trader.recommendation}(${trader.score}점), ` +
      `분석가는 ${economist.recommendation}(${economist.score}점)을 제시했습니다. ` +
      `두 전문가 의견의 가중 평균으로 최종 점수를 산출했습니다.`;
  }

  private async buildChartSummary(stockCode: string): Promise<string> {
    const stock = await this.em.findOne(Stock, { code: stockCode });
    if (!stock) return '차트 데이터 없음';

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const prices = await this.em.find(
      StockDailyPrice,
      { stock, date: { $gte: threeMonthsAgo } },
      { orderBy: { date: 'ASC' } },
    );

    if (prices.length === 0) return '가격 데이터 없음';

    const closes = prices.filter((p) => p.close != null).map((p) => p.close!);
    if (closes.length === 0) return '종가 데이터 없음';

    const first = closes[0];
    const last = closes[closes.length - 1];
    const high = Math.max(...closes);
    const low = Math.min(...closes);
    const changePct = ((last - first) / first) * 100;

    const volumes = prices.slice(-5).filter((p) => p.volume != null).map((p) => p.volume!);
    const avgVolume = volumes.length > 0
      ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length)
      : 0;

    const volatility =
      (Math.sqrt(
        closes.slice(1).reduce((sum, c, i) => {
          const ret = (c - closes[i]) / closes[i];
          return sum + ret * ret;
        }, 0) / (closes.length - 1),
      ) * 100) || 0;

    const sma20 = closes.length >= 20
      ? Math.round(closes.slice(-20).reduce((a, b) => a + b, 0) / 20)
      : null;

    const sma5 = closes.length >= 5
      ? Math.round(closes.slice(-5).reduce((a, b) => a + b, 0) / 5)
      : null;

    const trend = changePct > 5 ? '상승 추세' : changePct < -5 ? '하락 추세' : '횡보';

    return [
      `- 기간: ${prices.length}거래일`,
      `- 시작가: ${first.toLocaleString()}원 → 현재가: ${last.toLocaleString()}원`,
      `- 기간 수익률: ${changePct.toFixed(1)}%`,
      `- 최고가: ${high.toLocaleString()}원, 최저가: ${low.toLocaleString()}원`,
      `- 변동성(일간): ${volatility.toFixed(2)}%`,
      `- 추세: ${trend}`,
      sma5 ? `- 5일 이동평균: ${sma5.toLocaleString()}원` : '',
      sma20 ? `- 20일 이동평균: ${sma20.toLocaleString()}원 (현재가 ${last > sma20 ? '위' : '아래'})` : '',
      avgVolume ? `- 최근 5일 평균 거래량: ${avgVolume.toLocaleString()}주` : '',
    ].filter(Boolean).join('\n');
  }

  private safeParseJson<T>(output: string, fallback: T): T {
    try {
      if (!output || output.trim().length === 0) {
        this.logger.warn(`safeParseJson: 출력이 비어있음 → fallback 사용`);
        return fallback;
      }
      const clean = output.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn(`safeParseJson: JSON 미발견. 출력 미리보기(300자): ${clean.slice(0, 300)}`);
        return fallback;
      }
      const parsed = JSON.parse(jsonMatch[0]);
      this.logger.debug(`safeParseJson: 파싱 성공 — keys: ${Object.keys(parsed).join(', ')}`);
      return { ...fallback, ...parsed };
    } catch (err: any) {
      this.logger.warn(`safeParseJson: JSON 파싱 실패 — ${err.message}. 출력 미리보기: ${output.slice(0, 200)}`);
      return fallback;
    }
  }

  private fallbackScore(item: AiScoreRequestItem, errorMsg: string): AiStockScore {
    return {
      stockCode: item.stockCode,
      stockName: item.stockName,
      score: 0,
      reasoning: `AI 분석 실패: ${errorMsg}`,
      newsItems: [],
      newsHighlights: [],
      chartAnalysis: '',
      riskFactors: [],
    };
  }
}
