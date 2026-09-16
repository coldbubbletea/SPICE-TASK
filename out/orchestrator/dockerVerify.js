"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.rewritePatchPaths = rewritePatchPaths;
exports.runDockerVerify = runDockerVerify;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function gitDiff(workspaceRoot) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)('git', ['-C', workspaceRoot, 'diff', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`git diff 失败：${stderr || err.message}`));
            }
            else {
                resolve(stdout);
            }
        });
    });
}
/** 给 diff 里的文件路径加前缀（对齐 verifier 镜像内仓库布局，如 source/src/...）。 */
function rewritePatchPaths(diff, prefix) {
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
function runDocker(options) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)('docker', ['run', '--rm', '-v', `${options.workDir}:/logs`, options.verifierImage], { timeout: options.timeoutMs ?? 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            const output = (stdout + '\n' + stderr).trim();
            if (err && !output) {
                reject(new Error(`docker 运行失败：${err.message}`));
            }
            else {
                resolve(output);
            }
        });
    });
}
async function runDockerVerify(options) {
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
        }
        catch {
            // fall through
        }
    }
    return { ok: false, output: output.slice(-2000), patchFile, error: '未找到 reward 输出' };
}
//# sourceMappingURL=dockerVerify.js.map