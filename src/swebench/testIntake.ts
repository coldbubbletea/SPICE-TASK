/**
 * swe-bench-science 测试拉取/验收组件（独立组件，无 vscode 依赖）。
 *
 * 流水线：定位/物化 task bundle → 解析 task.toml 的 digest 固定镜像引用
 * → docker pull → env 镜像 sanity → verifier baseline（空 patch）→
 * 可选 patch 验收。与 tools/swe-bench-science/smoke-075.sh 等价，
 * 可被 orchestrator/CLI 直接调用。
 *
 * CLI:
 *   node out/swebench/testIntake.js [--task 075] [--root <swe-bench-science 根>]
 *        [--with-patch <model.patch>] [--keep-logs]
 * 退出码: 0=冒烟通过; 1=环境/用法错误; 2=测试链路损坏; 3=patch 未验收
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface IntakeOptions {
  /** 任务号，如 "075" */
  task?: string;
  /** swe-bench-science 数据集根；默认 <repo>/../swe-bench-science */
  datasetRoot?: string;
  /** 候选 patch 文件（git apply 格式）；不传则只做 baseline 冒烟 */
  withPatch?: string;
  /** 保留日志目录（默认清理） */
  keepLogs?: boolean;
  log?: (msg: string) => void;
}

export interface VerifierStats {
  reward: number;
  publicPassed: number;
  privateCollected: number;
  privateFailed: number;
}

export interface SmokeResult {
  ok: boolean;
  task: string;
  bundle: string;
  environmentImage: string;
  verifierImage: string;
  baseline?: VerifierStats;
  patch?: { patch: string; stats: VerifierStats };
  logsDir?: string;
  error?: string;
  /** 0=通过; 1=环境/用法错误; 2=链路损坏; 3=patch 未验收 */
  exitCode: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const anyErr = err as { code?: unknown };
          code = typeof anyErr.code === 'number' ? anyErr.code : 1;
        }
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/** 数据集根：默认取仓库上级目录下的 swe-bench-science。 */
export function resolveDatasetRoot(explicit?: string): string {
  if (explicit) {
    return path.resolve(explicit);
  }
  // 编译产物 out/swebench/testIntake.js → 仓库根 = ../../
  const repoRoot = path.resolve(__dirname, '..', '..');
  return path.join(repoRoot, '..', 'swe-bench-science');
}

/** 定位 task bundle；缺失时调用数据集 materialize.py 物化（受限任务需 license opt-in）。 */
export async function ensureTaskBundle(datasetRoot: string, task: string): Promise<string> {
  const bundle = path.join(datasetRoot, 'tasks', `task_${task}`);
  if (fs.existsSync(path.join(bundle, 'task.toml'))) {
    return bundle;
  }
  const materialize = path.join(datasetRoot, 'scripts', 'materialize.py');
  if (!fs.existsSync(materialize)) {
    throw new Error(
      `task bundle 缺失且无物化脚本：${bundle}；请手工执行 ` +
        `python3 ${materialize} --task-id ${task} --allow-restricted-licenses --output ${path.join(datasetRoot, 'tasks')}`,
    );
  }
  const r = await run('python3', [
    materialize,
    '--task-id',
    task,
    '--allow-restricted-licenses',
    '--output',
    path.join(datasetRoot, 'tasks'),
    '--force',
  ]);
  if (r.code !== 0 || !fs.existsSync(path.join(bundle, 'task.toml'))) {
    throw new Error(`materialize 失败（rc=${r.code}）：${r.stderr.trim()}`);
  }
  return bundle;
}

/** 从 task.toml 解析 digest 固定的 env/verifier 镜像引用。 */
export function readTaskImages(bundle: string): { environment: string; verifier: string } {
  const text = fs.readFileSync(path.join(bundle, 'task.toml'), 'utf8');
  let section = '';
  let environment = '';
  let verifier = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    const kv = line.match(/^docker_image\s*=\s*"(.*)"\s*$/);
    if (kv) {
      if (section === 'environment') {
        environment = kv[1];
      } else if (section === 'verifier.environment') {
        verifier = kv[1];
      }
    }
  }
  if (!environment || !verifier) {
    throw new Error(`${path.join(bundle, 'task.toml')} 缺少 [environment]/[verifier.environment] 的 docker_image`);
  }
  return { environment, verifier };
}

/** 确保镜像在本地：优先 digest 固定引用，失败时退回 tag-only（告警）。 */
export async function ensureDockerImage(ref: string, log?: (m: string) => void): Promise<string> {
  const tag = ref.includes('@') ? ref.slice(0, ref.indexOf('@')) : ref;
  const inspect = await run('docker', ['image', 'inspect', ref]);
  if (inspect.code === 0) {
    log?.(`[test-intake]   镜像已在本地: ${tag}`);
    return ref;
  }
  log?.(`[test-intake]   docker pull ${ref} …`);
  const pull = await run('docker', ['pull', ref], { timeoutMs: 30 * 60 * 1000 });
  if (pull.code === 0) {
    return ref;
  }
  if (tag === ref) {
    throw new Error(`docker pull 失败（rc=${pull.code}）：${ref}\n${pull.stderr.trim()}`);
  }
  log?.(`[test-intake]   ⚠ digest 引用拉取失败，退回 tag-only: ${tag}`);
  const fallback = await run('docker', ['pull', tag], { timeoutMs: 30 * 60 * 1000 });
  if (fallback.code !== 0) {
    throw new Error(`docker pull 失败（rc=${fallback.code}）：${tag}\n${fallback.stderr.trim()}`);
  }
  return tag;
}

/** env 镜像 sanity：/app/task_<id>、reproduce.py、baseline commit。 */
export async function checkEnvironmentImage(envRef: string, task: string, log?: (m: string) => void): Promise<void> {
  const taskDir = `task_${task}`;
  const r = await run(
    'docker',
    [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      envRef,
      '-c',
      `test -d /app/${taskDir} && test -f /app/${taskDir}/reproduce.py \
   && (cd /app/${taskDir} && git log --oneline -1)`,
    ],
    { timeoutMs: 10 * 60 * 1000 },
  );
  if (r.code !== 0) {
    throw new Error(`env 镜像 sanity 失败（rc=${r.code}）：${(r.stderr + r.stdout).trim()}`);
  }
  log?.(`[test-intake]   env baseline commit: ${r.stdout.trim()}`);
}

function parseVerifierLogs(logsDir: string): VerifierStats {
  const rewardPath = path.join(logsDir, 'verifier', 'reward.json');
  const reward = JSON.parse(fs.readFileSync(rewardPath, 'utf8')) as {
    reward: number;
    public?: { passed?: number };
  };
  let collected = 0;
  let failed = 0;
  const junit = path.join(logsDir, 'verifier', 'junit.xml');
  if (fs.existsSync(junit)) {
    const xml = fs.readFileSync(junit, 'utf8');
    for (const m of xml.matchAll(/<testsuite\b[^>]*>/g)) {
      const head = m[0];
      const t = head.match(/tests="(\d+)"/);
      const f = head.match(/failures="(\d+)"/);
      const e = head.match(/errors="(\d+)"/);
      collected += t ? Number(t[1]) : 0;
      failed += (f ? Number(f[1]) : 0) + (e ? Number(e[1]) : 0);
    }
  }
  return {
    reward: reward.reward,
    publicPassed: reward.public?.passed ?? 0,
    privateCollected: collected,
    privateFailed: failed,
  };
}

/** 在 verifier 容器中跑一轮：$patchFile 为空串表示空 patch（baseline）。 */
export async function runVerifier(
  verifierRef: string,
  patchFile: string,
  logsDir: string,
  log?: (m: string) => void,
): Promise<VerifierStats> {
  fs.mkdirSync(path.join(logsDir, 'artifacts'), { recursive: true });
  const modelPatch = path.join(logsDir, 'artifacts', 'model.patch');
  fs.writeFileSync(modelPatch, patchFile && patchFile !== '' ? fs.readFileSync(patchFile) : '');
  const r = await run('docker', ['run', '--rm', '-v', `${logsDir}:/logs`, verifierRef], {
    timeoutMs: 30 * 60 * 1000,
  });
  if (r.code !== 0 && !fs.existsSync(path.join(logsDir, 'verifier', 'reward.json'))) {
    throw new Error(`verifier 容器中止（rc=${r.code}）：${(r.stderr + r.stdout).trim()}`);
  }
  // 容器以 root 运行：回收 /logs 属主，保证宿主机侧可清理
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  await run(
    'docker',
    ['run', '--rm', '--entrypoint', 'chown', '-v', `${logsDir}:/logs`, verifierRef, '-R', `${uid}:${gid}`, '/logs'],
    { timeoutMs: 5 * 60 * 1000 },
  );
  log?.((r.stdout + r.stderr).trim());
  return parseVerifierLogs(logsDir);
}

/** 完整流水线：bundle → 镜像 → env sanity → baseline verifier →（可选）patch 验收。 */
export async function runTaskSmoke(options: IntakeOptions = {}): Promise<SmokeResult> {
  const log = options.log ?? (() => {});
  const task = options.task ?? '075';
  const result: SmokeResult = {
    ok: false,
    task,
    bundle: '',
    environmentImage: '',
    verifierImage: '',
    exitCode: 1,
  };
  const fail = (code: number, error: string): SmokeResult => {
    result.ok = false;
    result.exitCode = code;
    result.error = error;
    log(`[test-intake] ✗ ${error}`);
    return result;
  };

  const datasetRoot = resolveDatasetRoot(options.datasetRoot);
  if (!fs.existsSync(path.join(datasetRoot, 'manifests', 'tasks.jsonl'))) {
    return fail(1, `数据集根不存在或不完整: ${datasetRoot}（用 datasetRoot/--root 指定）`);
  }

  log(`[test-intake] 阶段1: 定位/物化 task bundle`);
  let bundle: string;
  try {
    bundle = await ensureTaskBundle(datasetRoot, task);
  } catch (e) {
    return fail(1, (e as Error).message);
  }
  result.bundle = bundle;
  log(`[test-intake]   使用 bundle ${bundle}`);

  log('[test-intake] 阶段2: 确保 digest 固定镜像就位');
  const images = readTaskImages(bundle);
  let envRef: string;
  let verifierRef: string;
  try {
    envRef = await ensureDockerImage(images.environment, log);
    verifierRef = await ensureDockerImage(images.verifier, log);
  } catch (e) {
    return fail(1, (e as Error).message);
  }
  result.environmentImage = envRef;
  result.verifierImage = verifierRef;

  log('[test-intake] 阶段3: env 镜像 sanity');
  try {
    await checkEnvironmentImage(envRef, task, log);
  } catch (e) {
    return fail(2, (e as Error).message);
  }

  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), `swe-bench-science-${task}-`));
  const patchLogsDir = `${logsDir}-patch`;
  const cleanup = (): void => {
    if (!options.keepLogs) {
      for (const dir of [logsDir, patchLogsDir]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (e) {
          console.warn(`[test-intake] 清理 ${dir} 失败（容器属主问题？）：${(e as Error).message}`);
        }
      }
    }
  };

  log('[test-intake] 阶段4: verifier baseline（空 patch，期望 reward=0）');
  let baseline: VerifierStats;
  try {
    baseline = await runVerifier(verifierRef, '', logsDir, log);
  } catch (e) {
    cleanup();
    return fail(2, (e as Error).message);
  }
  result.baseline = baseline;
  result.logsDir = logsDir;
  log(
    `[test-intake]   reward=${baseline.reward} public_passed=${baseline.publicPassed} ` +
      `private: collected=${baseline.privateCollected} failed=${baseline.privateFailed}`,
  );
  if (baseline.privateCollected <= 0) {
    cleanup();
    return fail(2, 'verifier 未收集到任何 private 测试（junit.xml 缺失或为空），链路损坏');
  }
  if (baseline.reward === 1) {
    log('[test-intake]   ⚠ 警告: baseline（无 patch）即 reward=1，private 测试区分度存疑');
  }

  if (options.withPatch) {
    if (!fs.existsSync(options.withPatch)) {
      cleanup();
      return fail(1, `--with-patch 指定的文件不存在: ${options.withPatch}`);
    }
    log(`[test-intake] 阶段5: verifier 验收 patch: ${options.withPatch}`);
    let patchStats: VerifierStats;
    try {
      patchStats = await runVerifier(verifierRef, options.withPatch, patchLogsDir, log);
    } catch (e) {
      cleanup();
      return fail(3, `verifier 在应用 patch 时中止（可能 git apply 失败）：${(e as Error).message}`);
    }
    result.patch = { patch: options.withPatch, stats: patchStats };
    log(
      `[test-intake]   reward=${patchStats.reward} public_passed=${patchStats.publicPassed} ` +
        `private: collected=${patchStats.privateCollected} failed=${patchStats.privateFailed}`,
    );
    if (patchStats.reward !== 1) {
      cleanup();
      return fail(3, `patch 未通过（期望 reward=1）；日志: ${patchLogsDir}/verifier/test-stdout.txt`);
    }
    log('[test-intake]   patch 验收通过 ✅ reward=1');
  }

  cleanup();
  result.ok = true;
  result.exitCode = 0;
  log(`[test-intake] ✅ 冒烟测试通过（task ${task}）`);
  return result;
}

interface CliArgs {
  task?: string;
  datasetRoot?: string;
  withPatch?: string;
  keepLogs: boolean;
  help: boolean;
}

function parseCli(argv: string[]): CliArgs {
  const args: CliArgs = { keepLogs: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') {
      args.task = argv[++i];
    } else if (a === '--root') {
      args.datasetRoot = argv[++i];
    } else if (a === '--with-patch') {
      args.withPatch = argv[++i];
    } else if (a === '--keep-logs') {
      args.keepLogs = true;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }
  return args;
}

async function main(argv: string[]): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCli(argv);
  } catch (e) {
    console.error(`[test-intake] ✗ ${(e as Error).message}（-h 查看用法）`);
    process.exit(1);
    return;
  }
  if (args.help) {
    console.log('用法: node out/swebench/testIntake.js [--task 075] [--root <swe-bench-science 根>] [--with-patch <patch>] [--keep-logs]');
    return;
  }
  const result = await runTaskSmoke({
    task: args.task,
    datasetRoot: args.datasetRoot,
    withPatch: args.withPatch,
    keepLogs: args.keepLogs,
    log: (m) => console.log(m),
  });
  if (!result.ok && result.error) {
    console.error(`[test-intake] 详情: ${result.error}`);
  }
  process.exit(result.exitCode);
}

if (require.main === module) {
  void main(process.argv.slice(2));
}
