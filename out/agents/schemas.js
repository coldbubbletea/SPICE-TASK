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
exports.PROBE_QUOTAS = exports.PROBE_DIMENSIONS = exports.CONTRACT_QUOTAS = exports.CONTRACT_KINDS = void 0;
exports.isValidHiddenContract = isValidHiddenContract;
exports.isValidCallChain = isValidCallChain;
exports.contractCoverage = contractCoverage;
exports.normalizeReport = normalizeReport;
exports.probeCoverage = probeCoverage;
exports.isValidProbe = isValidProbe;
exports.validateProbeReport = validateProbeReport;
exports.extractJson = extractJson;
exports.writeArtifact = writeArtifact;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** 隐藏契约的种类（任务无关的通用分类）。 */
exports.CONTRACT_KINDS = [
    'invariant',
    'precondition',
    'postcondition',
    'unit_convention',
    'ordering',
    'error_semantics',
    'naming_alias',
    'data_shape',
    'numerical_tolerance',
    'resource_lifecycle'
];
/** 隐藏契约的最低交付要求（非阻塞：未满足 → 补正一次，仍缺则告警放行）。 */
exports.CONTRACT_QUOTAS = {
    /** 至少识别出的隐藏契约条数。 */
    minContracts: 3,
    /** 至少覆盖的不同契约种类数。 */
    minKinds: 2,
    /** structure_map 至少要覆盖多少条暴露入口。 */
    minChains: 2
};
/** 探针维度（legacy，2026-09-16 起不再作为交付门禁）。 */
exports.PROBE_DIMENSIONS = ['main_path', 'param_space', 'name_variants', 'robustness', 'api_surface'];
/** 每个维度的最低探针数配额（legacy：仅供参考，不再阻塞交卷；现行硬配额见 CONTRACT_QUOTAS）。 */
exports.PROBE_QUOTAS = {
    main_path: 2,
    param_space: 1,
    name_variants: 1,
    robustness: 1,
    api_surface: 1
};
function isValidHiddenContract(value) {
    const c = value;
    return (!!c &&
        typeof c === 'object' &&
        typeof c.id === 'string' &&
        typeof c.statement === 'string' &&
        c.statement.trim().length > 0 &&
        typeof c.kind === 'string' &&
        typeof c.locus === 'string' &&
        typeof c.discovered_via === 'string' &&
        typeof c.evidence === 'string' &&
        typeof c.violates_if === 'string' &&
        typeof c.patcher_action === 'string');
}
function isValidCallChain(value) {
    const c = value;
    return (!!c &&
        typeof c === 'object' &&
        typeof c.entry === 'string' &&
        typeof c.chain === 'string' &&
        typeof c.termination === 'string' &&
        (c.siblings === undefined || (Array.isArray(c.siblings) && c.siblings.every((x) => typeof x === 'string'))));
}
/** 隐藏契约交付覆盖审计（确定性，非 LLM；非阻塞）。 */
function contractCoverage(report) {
    const contracts = report.hidden_contracts ?? [];
    if (!Array.isArray(report.hidden_contracts)) {
        return { legacy: true, count: 0, counts: {}, hasStructureMap: false, missing: [] };
    }
    const counts = {};
    for (const c of contracts) {
        const k = (c && typeof c.kind === 'string' && c.kind) || 'unspecified';
        counts[k] = (counts[k] ?? 0) + 1;
    }
    const chains = Array.isArray(report.structure_map) ? report.structure_map : [];
    const missing = [];
    if (contracts.length < exports.CONTRACT_QUOTAS.minContracts) {
        missing.push(`hidden_contracts≥${exports.CONTRACT_QUOTAS.minContracts}`);
    }
    if (Object.keys(counts).filter((k) => k !== 'unspecified').length < exports.CONTRACT_QUOTAS.minKinds) {
        missing.push(`contract_kinds≥${exports.CONTRACT_QUOTAS.minKinds}`);
    }
    if (chains.length < exports.CONTRACT_QUOTAS.minChains) {
        missing.push(`structure_map≥${exports.CONTRACT_QUOTAS.minChains}`);
    }
    return { legacy: false, count: contracts.length, counts, hasStructureMap: chains.length > 0, missing };
}
/** 规范化报告：把可选集合补成全量，避免下游 undefined 展开。 */
function normalizeReport(report) {
    return {
        ...report,
        questions: Array.isArray(report.questions) ? report.questions : [],
        exposure_paths: Array.isArray(report.exposure_paths) ? report.exposure_paths : [],
        hidden_contracts: Array.isArray(report.hidden_contracts) ? report.hidden_contracts : [],
        structure_map: Array.isArray(report.structure_map) ? report.structure_map : [],
        probes: Array.isArray(report.probes) ? report.probes : []
    };
}
/** 确定性覆盖检查：统计每个维度的探针数（coverage_matrix 与 probes[].dimension 取并集），
 *  返回配额未满足的维度。旧版报告（无维度元数据）标记 legacy=true 且不告警。 */
function probeCoverage(report) {
    const probes = report.probes ?? [];
    const byId = new Map();
    for (const p of probes)
        byId.set(p.id, p);
    const hasMetadata = !!report.coverage_matrix || probes.some((p) => typeof p.dimension === 'string' && p.dimension.trim());
    const counts = {};
    for (const dim of exports.PROBE_DIMENSIONS)
        counts[dim] = 0;
    if (hasMetadata) {
        const declared = new Map();
        const declaredIds = (dim) => {
            let set = declared.get(dim);
            if (!set) {
                set = new Set();
                declared.set(dim, set);
            }
            return set;
        };
        if (report.coverage_matrix) {
            for (const [dim, ids] of Object.entries(report.coverage_matrix)) {
                if (Array.isArray(ids))
                    for (const id of ids)
                        if (typeof id === 'string' && byId.has(id))
                            declaredIds(dim).add(id);
            }
        }
        for (const p of probes) {
            const dim = typeof p.dimension === 'string' ? p.dimension.trim() : '';
            if (dim && exports.PROBE_DIMENSIONS.includes(dim))
                declaredIds(dim).add(p.id);
        }
        for (const dim of exports.PROBE_DIMENSIONS)
            counts[dim] = declared.get(dim)?.size ?? 0;
    }
    const missing = hasMetadata
        ? exports.PROBE_DIMENSIONS.filter((dim) => counts[dim] < exports.PROBE_QUOTAS[dim])
        : [];
    return { legacy: !hasMetadata, counts, missing };
}
function isValidProbe(value) {
    const probe = value;
    return (!!probe &&
        typeof probe.id === 'string' &&
        typeof probe.title === 'string' &&
        (probe.kind === 'python' || probe.kind === 'shell') &&
        typeof probe.code === 'string' &&
        typeof probe.expect === 'string' &&
        (probe.dimension === undefined || typeof probe.dimension === 'string'));
}
function validateProbeReport(value) {
    const report = value;
    return (!!report &&
        typeof report.role === 'string' &&
        Array.isArray(report.questions) &&
        report.questions.every((q) => typeof q === 'string') &&
        Array.isArray(report.exposure_paths) &&
        report.exposure_paths.every((p) => p && typeof p.file === 'string' && typeof p.symbol === 'string' && typeof p.how === 'string') &&
        (Array.isArray(report.probes) || Array.isArray(report.hidden_contracts)) &&
        (!Array.isArray(report.probes) || report.probes.every(isValidProbe)) &&
        (report.hidden_contracts === undefined ||
            (Array.isArray(report.hidden_contracts) && report.hidden_contracts.every(isValidHiddenContract))) &&
        (report.structure_map === undefined ||
            (Array.isArray(report.structure_map) && report.structure_map.every(isValidCallChain))) &&
        (report.coverage_matrix === undefined ||
            (typeof report.coverage_matrix === 'object' &&
                report.coverage_matrix !== null &&
                !Array.isArray(report.coverage_matrix) &&
                Object.values(report.coverage_matrix).every((ids) => Array.isArray(ids) && ids.every((x) => typeof x === 'string')))));
}
/** 从模型输出文本中提取 JSON（容忍 markdown 围栏与前后杂文本）。 */
function extractJson(text) {
    const fenced = text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
    const candidates = fenced ? [fenced[1], text] : [text];
    for (const candidate of candidates) {
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(candidate.slice(start, end + 1));
            }
            catch {
                // try next candidate
            }
        }
    }
    return undefined;
}
function writeArtifact(runDir, name, data) {
    const file = path.join(runDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    return file;
}
//# sourceMappingURL=schemas.js.map