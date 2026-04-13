import { Logger } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';

const logger = new Logger('ClaudeAgent');

export const TOKEN_LIMIT_MSG = '토큰 한도가 100%로 꽉 찼습니다.';
export const ABORT_MSG = 'AI 분석이 사용자에 의해 중단되었습니다.';
const RATE_LIMIT_PATTERN = "You've hit your limit";

function getClaudePath(): string {
  return process.env.CLAUDE_CLI_PATH || 'claude';
}

interface AgentConfigFile {
  authMode?: string;
  anthropicApiKey?: string;
  oauthAccessToken?: string;
}

function readAgentConfig(): AgentConfigFile {
  const configDir = process.env.AGENTS_CONFIG_DIR
    || resolve(process.cwd(), '../../.agents');
  const configPath = resolve(configDir, 'config.json');
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return {};
}

function getAnthropicApiKey(): string | undefined {
  const config = readAgentConfig();
  // 구독 모드면 API 키 대신 OAuth 토큰 사용
  if (config.authMode === 'subscription') return undefined;
  // 1) 환경변수 우선
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  // 2) config.json에서 읽기
  return config.anthropicApiKey || undefined;
}

export interface PtyProgress {
  output: string;
  done: boolean;
}

export interface PtyResult {
  output: string;
  exitCode: number;
}

/**
 * child_process.spawn으로 Claude Code CLI를 실행하고 실시간 출력을 스트리밍합니다.
 *
 * 중요: CLAUDE_CONFIG_DIR을 별도로 설정하지 않습니다.
 * 호스트의 ~/.claude/ 인증 정보를 그대로 사용합니다.
 * `-p` 플래그는 비대화형 모드로, 각 호출이 독립적입니다.
 */
export function spawnClaude(
  prompt: string,
  options: {
    timeoutMs?: number;
    onProgress?: (progress: PtyProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<PtyResult> {
  const { timeoutMs = 240_000, onProgress, signal } = options;

  return new Promise((resolve, reject) => {
    // 이미 abort된 signal이면 즉시 거부
    if (signal?.aborted) {
      reject(new Error(ABORT_MSG));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const claudePath = getClaudePath();
    logger.log(`Spawn: ${claudePath} -p [prompt ${prompt.length}자]`);

    const apiKey = getAnthropicApiKey();
    const env: Record<string, string | undefined> = {
      ...process.env,
    };
    if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
    }
    // 구독 모드: CLI가 ~/.claude/.credentials.json에서 OAuth 토큰을 읽음
    // ANTHROPIC_AUTH_TOKEN으로 직접 전달하면 API가 거부하므로 설정하지 않음

    // claude를 직접 실행 (shell 래퍼/심링크 모두 지원)
    const proc: ChildProcess = spawn(claudePath, [
      '-p', prompt,
      '--model', 'sonnet',
      '--output-format', 'text',
      '--allowedTools', 'WebSearch,WebFetch,Read,Glob,Grep',
    ], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        logger.error(`타임아웃 (${timeoutMs / 1000}초). stdout(${stdout.length}자), stderr(${stderr.length}자)`);
        reject(new Error(`Claude 타임아웃 (${timeoutMs / 1000}초)`));
      }
    }, timeoutMs);

    const killWithTokenLimit = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        proc.kill('SIGTERM');
        logger.error(TOKEN_LIMIT_MSG);
        reject(new Error(TOKEN_LIMIT_MSG));
      }
    };

    // AbortSignal 리스너: 중단 요청 시 즉시 프로세스 종료
    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        proc.kill('SIGTERM');
        logger.log(`사용자 중단 요청으로 Claude 프로세스 종료 (pid: ${proc.pid})`);
        reject(new Error(ABORT_MSG));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.includes(RATE_LIMIT_PATTERN)) return killWithTokenLimit();
      onProgress?.({ output: stdout, done: false });
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (stderr.includes(RATE_LIMIT_PATTERN)) return killWithTokenLimit();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        logger.error(`프로세스 에러: ${err.message}`);
        reject(new Error(`Claude 프로세스 오류: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;

        // 디버그 로그: 실제 출력 확인용
        if (stdout.length === 0) {
          logger.warn(`Claude 출력 없음 (exit: ${code}). stderr: ${stderr.slice(0, 500)}`);
        } else {
          logger.log(`Claude 완료 (exit: ${code}), stdout: ${stdout.length}자`);
          logger.debug(`stdout 미리보기: ${stdout.slice(0, 300)}`);
        }

        if (stderr.length > 0) {
          logger.debug(`stderr: ${stderr.slice(0, 300)}`);
        }

        onProgress?.({ output: stdout, done: true });
        resolve({ output: stdout, exitCode: code ?? 1 });
      }
    });
  });
}

/**
 * 여러 Claude 에이전트를 병렬로 실행합니다.
 */
export async function spawnParallelAgents(
  agents: {
    name: string;
    prompt: string;
    timeoutMs?: number;
  }[],
  onAgentProgress?: (agentName: string, progress: PtyProgress) => void,
  signal?: AbortSignal,
): Promise<Map<string, PtyResult>> {
  const results = new Map<string, PtyResult>();

  const promises = agents.map(async (agent) => {
    logger.log(`에이전트 시작: [${agent.name}]`);
    try {
      const result = await spawnClaude(agent.prompt, {
        timeoutMs: agent.timeoutMs ?? 240_000,
        onProgress: (p) => onAgentProgress?.(agent.name, p),
        signal,
      });
      results.set(agent.name, result);
      logger.log(`에이전트 완료: [${agent.name}] (exit: ${result.exitCode}, output: ${result.output.length}자)`);
    } catch (err: any) {
      if (err.message === TOKEN_LIMIT_MSG || err.message === ABORT_MSG) throw err;
      logger.error(`에이전트 실패: [${agent.name}] - ${err.message}`);
      results.set(agent.name, { output: '', exitCode: 1 });
    }
  });

  await Promise.all(promises);
  return results;
}
