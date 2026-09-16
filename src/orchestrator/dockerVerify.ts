import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface DockerVerifyOptions {
  workspaceRoot: string;
  verifierImage: string;
  patchPathPrefix: string;
  workDir: string;
  timeoutMs?: number;
}

export interface DockerVerifyResult {
  ok: boolean;
  reward?: number;
  output: string;
  patchFile: string;
  error?: string;
}

function gitDiff(workspaceRoot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', workspaceRoot, 'diff', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git diff 失败：${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** 给 diff 里的文件路径加前缀（对齐 verifier 镜像内仓库布局，如 source/src/...）。 */
export function rewritePatchPaths(diff: string, prefix: string): string {
  if (!prefix) {
    return diff;
  }
  const normalized = prefix.endsWith('/') ? prefix : prefix + '/';
  return diff.split('\n').map((line) => {
    if (line.startsWith('diff --git ')) {
      return line.replace(/(\s[ab])\//g, (m, g1) => g1 + '/' + normalized);
    }
    if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
      return line.replace(/^(---|\+\+\+) ([ab])\//, (m, g1, g2) => g1 + ' ' + g2 + '/' + normalized);
    }
    return line;
  }).join('\n');
}

function runDocker(options: DockerVerifyOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['run', '--rm', '-v', `${options.workDir}:/logs`, options.verifierImage],
      { timeout: options.timeoutMs ?? 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = (stdout + '\n' + stderr).trim();
        if (err && !output) {
          reject(new Error(`docker 运行失败：${err.message}`));
        } else {
          resolve(output);
        }
      }
    );
  });
}

export async function runDockerVerify(options: DockerVerifyOptions): Promise<DockerVerifyResult> {
  fs.mkdirSync(path.join(options.workDir, 'artifacts'), { recursive: true });
  const patchFile = path.join(options.workDir, 'artifacts', 'model.patch');

  const diff = await gitDiff(options.workspaceRoot);
  if (!diff.trim()) {
    return { ok: false, output: '工作区没有未提交的改动（git diff 为空），先让 repair 产出补丁再验证。', patchFile };
  }
  fs.writeFileSync(patchFile, rewritePatchPaths(diff, options.patchPathPrefix));

  const output = await runDocker(options);
  // verifier 输出形如 {"private": ..., "public": ..., "reward": 1, "task_id": "..."}
  const jsonLine = output.split('\n').reverse().find((l) => l.trim().startsWith('{') && l.includes('reward'));
  if (jsonLine) {
    try {
      const parsed = JSON.parse(jsonLine.trim());
      return { ok: parsed.reward === 1, reward: parsed.reward, output: jsonLine.trim(), patchFile };
    } catch {
      // fall through
    }
  }
  return { ok: false, output: output.slice(-2000), patchFile, error: '未找到 reward 输出' };
}
