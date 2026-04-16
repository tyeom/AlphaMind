import { Logger } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { ABORT_MSG, TOKEN_LIMIT_MSG, PtyProgress, PtyResult } from './claude-pty';

const logger = new Logger('GptAgent');
const RATE_LIMIT_PATTERN = 'rate limit';
const NETWORK_ERROR_PATTERNS = [
  'failed to connect to websocket',
  'failed to lookup address information',
  'error sending request for url',
  'stream disconnected before completion',
  'dns error',
];
const GPT_AUTH_EXPIRED_PATTERNS = [
  'failed to refresh token',
  'refresh token was already used',
  'refresh token has already been used',
  'your refresh token was already used',
  'please try signing in again',
  'invalid_grant',
  'token is expired',
  'token has expired',
  '401 unauthorized',
];
export const GPT_AUTH_EXPIRED_MSG =
  'GPT 구독 인증이 만료되었습니다. AI 에이전트 설정에서 Codex auth.json 을 다시 가져오세요.';

interface ClaudeConfigFile {
  authMode?: string;
  anthropicApiKey?: string;
  oauthAccessToken?: string;
}

interface GptConfigFile {
  authMode?: string;
  openaiApiKey?: string;
}

interface AgentConfigFile {
  authMode?: string;
  anthropicApiKey?: string;
  oauthAccessToken?: string;
  claude?: ClaudeConfigFile;
  gpt?: GptConfigFile;
}

function getCodexPath(): string {
  return process.env.CODEX_CLI_PATH || 'codex';
}

function getCodexHome(): string {
  return process.env.CODEX_HOME || resolve('/root', '.codex');
}

function getCodexWorkdir(): string {
  return process.env.CODEX_WORKDIR || tmpdir();
}

function getCodexModel(): string {
  return process.env.CODEX_MODEL || 'gpt-4.5-preview';
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

function getOpenAiApiKey(): string | undefined {
  const config = readAgentConfig();
  const gpt = config.gpt || {};
  if (gpt.authMode === 'subscription') return undefined;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  return gpt.openaiApiKey || undefined;
}

function getGptAuthMode(): string | undefined {
  const config = readAgentConfig();
  return config.gpt?.authMode;
}

function resolveCodexModel(): string | undefined {
  const requestedModel = getCodexModel();
  const authMode = getGptAuthMode();

  if (authMode === 'subscription') {
    logger.warn(
      `GPT 구독 모드에서는 --model 을 강제하지 않고 Codex 기본 모델 선택을 사용합니다.`,
    );
    return undefined;
  }

  return requestedModel;
}

function buildGptProcessError(
  exitCode: number,
  stderr: string,
  stdout: string,
): Error {
  const stderrLower = stderr.toLowerCase();

  if (GPT_AUTH_EXPIRED_PATTERNS.some((pattern) => stderrLower.includes(pattern))) {
    return new Error(GPT_AUTH_EXPIRED_MSG);
  }

  if (NETWORK_ERROR_PATTERNS.some((pattern) => stderrLower.includes(pattern))) {
    return new Error(
      'GPT 연결 실패: Codex CLI가 OpenAI 서비스(chatgpt.com)에 연결하지 못했습니다. ' +
      '컨테이너의 외부 HTTPS/DNS 접근을 확인하세요.',
    );
  }

  if (stderrLower.includes('authentication') || stderrLower.includes('unauthorized')) {
    return new Error('GPT 인증 실패: Codex auth.json 또는 OpenAI API 키 설정을 확인하세요.');
  }

  if (stderrLower.includes('model') && (stderrLower.includes('not found') || stderrLower.includes('not supported'))) {
    const model = resolveCodexModel();
    return new Error(
      model
        ? `GPT 모델 오류: ${model} 모델을 사용할 수 없습니다.`
        : 'GPT 모델 오류: 현재 계정/환경에서 지정 모델을 사용할 수 없습니다.',
    );
  }

  const detail = (stderr || stdout).trim().slice(0, 500);
  return new Error(
    detail
      ? `GPT 프로세스 비정상 종료 (exit: ${exitCode}): ${detail}`
      : `GPT 프로세스 비정상 종료 (exit: ${exitCode})`,
  );
}

export function spawnGpt(
  prompt: string,
  options: {
    timeoutMs?: number;
    onProgress?: (progress: PtyProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<PtyResult> {
  const { timeoutMs = 240_000, onProgress, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(ABORT_MSG));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const codexPath = getCodexPath();
    const outputDir = mkdtempSync(join(tmpdir(), 'codex-exec-'));
    const outputFile = join(outputDir, 'last-message.txt');
    const model = resolveCodexModel();
    logger.log(
      `Spawn: ${codexPath} exec${model ? ` --model ${model}` : ''} [prompt ${prompt.length}자]`,
    );

    const apiKey = getOpenAiApiKey();
    const env: Record<string, string | undefined> = {
      ...process.env,
      CODEX_HOME: getCodexHome(),
    };
    if (apiKey) {
      env.OPENAI_API_KEY = apiKey;
    }

    const args = [
      '--search',
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--color', 'never',
      '-C', getCodexWorkdir(),
      '-o', outputFile,
      prompt,
    ];
    if (model) {
      args.splice(2, 0, '--model', model);
    }

    const proc: ChildProcess = spawn(codexPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const cleanup = async () => {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        void cleanup();
        logger.error(`타임아웃 (${timeoutMs / 1000}초). stdout(${stdout.length}자), stderr(${stderr.length}자)`);
        reject(new Error(`GPT 타임아웃 (${timeoutMs / 1000}초)`));
      }
    }, timeoutMs);

    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        proc.kill('SIGTERM');
        void cleanup();
        logger.log(`사용자 중단 요청으로 GPT 프로세스 종료 (pid: ${proc.pid})`);
        reject(new Error(ABORT_MSG));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.toLowerCase().includes(RATE_LIMIT_PATTERN)) {
        settled = true;
        clearTimeout(timer);
        proc.kill('SIGTERM');
        void cleanup();
        reject(new Error(TOKEN_LIMIT_MSG));
        return;
      }
      onProgress?.({ output: stdout, done: false });
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (stderr.toLowerCase().includes(RATE_LIMIT_PATTERN)) {
        settled = true;
        clearTimeout(timer);
        proc.kill('SIGTERM');
        void cleanup();
        reject(new Error(TOKEN_LIMIT_MSG));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        void cleanup();
        logger.error(`프로세스 에러: ${err.message}`);
        reject(new Error(`GPT 프로세스 오류: ${err.message}`));
      }
    });

    proc.on('close', async (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (settled) {
        await cleanup();
        return;
      }
      settled = true;

      let output = stdout;
      try {
        const lastMessage = await readFile(outputFile, 'utf-8');
        if (lastMessage.trim()) {
          output = lastMessage;
        }
      } catch {
        // ignore and fallback to stdout
      }

      await cleanup();

      if ((code ?? 1) !== 0) {
        const err = buildGptProcessError(code ?? 1, stderr, stdout);
        logger.warn(`GPT 비정상 종료 (exit: ${code}). stderr: ${stderr.slice(0, 2000)}`);
        reject(err);
        return;
      }

      if (output.length === 0) {
        logger.warn(`GPT 출력 없음 (exit: ${code}). stderr: ${stderr.slice(0, 500)}`);
      } else {
        logger.log(`GPT 완료 (exit: ${code}), output: ${output.length}자`);
      }
      if (stderr.length > 0) {
        logger.debug(`stderr: ${stderr.slice(0, 300)}`);
      }

      onProgress?.({ output, done: true });
      resolve({ output, exitCode: code ?? 1 });
    });
  });
}

export async function spawnParallelGptAgents(
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
      const result = await spawnGpt(agent.prompt, {
        timeoutMs: agent.timeoutMs ?? 240_000,
        onProgress: (p) => onAgentProgress?.(agent.name, p),
        signal,
      });
      results.set(agent.name, result);
      logger.log(`에이전트 완료: [${agent.name}] (exit: ${result.exitCode}, output: ${result.output.length}자)`);
    } catch (err: any) {
      if (
        err.message === TOKEN_LIMIT_MSG
        || err.message === ABORT_MSG
        || err.message === GPT_AUTH_EXPIRED_MSG
      ) {
        throw err;
      }
      logger.error(`에이전트 실패: [${agent.name}] - ${err.message}`);
      results.set(agent.name, { output: '', exitCode: 1 });
    }
  });

  await Promise.all(promises);
  return results;
}
