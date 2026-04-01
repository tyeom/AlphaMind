import { Logger } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import { dirname } from 'path';

const logger = new Logger('ClaudeAgent');

function getClaudePath(): string {
  return process.env.CLAUDE_CLI_PATH || 'claude';
}

function getNodePath(): string {
  return process.execPath;
}

function buildFullPath(): string {
  const claudePath = getClaudePath();
  const claudeDir = dirname(claudePath);
  const nodeDir = dirname(getNodePath());
  const existing = process.env.PATH || '';
  return [claudeDir, nodeDir, existing].filter(Boolean).join(':');
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
  } = {},
): Promise<PtyResult> {
  const { timeoutMs = 240_000, onProgress } = options;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const claudePath = getClaudePath();
    const nodePath = getNodePath();
    logger.log(`Spawn: ${nodePath} ${claudePath} -p [prompt ${prompt.length}자]`);

    const proc: ChildProcess = spawn(nodePath, [
      claudePath,
      '-p', prompt,
      '--output-format', 'text',
      '--allowedTools', 'WebSearch,WebFetch,Read,Glob,Grep',
    ], {
      env: {
        ...process.env,
        PATH: buildFullPath(),
        // CLAUDE_CONFIG_DIR 미설정 → 기본 ~/.claude/ 인증 사용
      },
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

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      onProgress?.({ output: stdout, done: false });
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        logger.error(`프로세스 에러: ${err.message}`);
        reject(new Error(`Claude 프로세스 오류: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
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
): Promise<Map<string, PtyResult>> {
  const results = new Map<string, PtyResult>();

  const promises = agents.map(async (agent) => {
    logger.log(`에이전트 시작: [${agent.name}]`);
    try {
      const result = await spawnClaude(agent.prompt, {
        timeoutMs: agent.timeoutMs ?? 240_000,
        onProgress: (p) => onAgentProgress?.(agent.name, p),
      });
      results.set(agent.name, result);
      logger.log(`에이전트 완료: [${agent.name}] (exit: ${result.exitCode}, output: ${result.output.length}자)`);
    } catch (err: any) {
      logger.error(`에이전트 실패: [${agent.name}] - ${err.message}`);
      results.set(agent.name, { output: '', exitCode: 1 });
    }
  });

  await Promise.all(promises);
  return results;
}
