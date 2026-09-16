"use strict";
/**
 * 共享 prompt 条款（契约驱动验收 + 信息隔离）。
 *
 * 信息隔离原则：私有验收测试（官方 verifier 容器内的 private 套件）只对 orchestrator
 * 可见。probe/repair/mentor 等 agent 的 prompt 一律不提及私有测试、verifier 镜像或
 * 容器内测试路径；验收面通过「完整 I/O 契约 + 全输入空间」的通用条款来驱动泛化，
 * 而不是泄露测试内容让 agent 针对性防御（overfit）。
 * 最终 docker 验收仅由 orchestrator 执行（dockerVerify.ts），agent 侧不可见。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROBE_AS_EVIDENCE_CLAUSE = exports.HIDDEN_CONTRACT_QUOTA_CLAUSE = exports.MENTOR_RUBRIC_CLAUSE = exports.SELF_STRESS_CHECK_CLAUSE = exports.KILL_LINE_CLAUSE = exports.PROBER_GUIDANCE_STATUS_CLAUSE = exports.CONTRACT_COMPLETENESS_CLAUSE = exports.ACCEPTANCE_SCOPE_CLAUSE = void 0;
exports.ACCEPTANCE_SCOPE_CLAUSE = `=== 验收范围（硬约束）===
- 验收范围比仓库内可见样本更广：最终验收会在你从未见过的输入形态上检查同一修复目标；可见样本通过不构成验收通过。`;
exports.CONTRACT_COMPLETENESS_CLAUSE = `=== 契约完整性（硬约束）===
- 修复目标是该模块的完整输入/输出契约，不是让可见失败消失：枚举该模块输入格式允许的全部输入维度
  （数值记法、记录/行布局、同类记录的优先级、取值缺失/为空时的回退、退化值（如非有限值）、维度/长度不匹配等），
  并保证行为在每一个维度上都符合契约。
- 提交前用你自己按契约生成的压力输入（随机数据、不同记法、极端值、退化值）在本地验证修复，可见样本通过不充分。
- 禁止"意外通过"：检查的通过必须能指认到具体的预期行为；依靠某条代码路径碰巧抛出异常这类运行时副作用"通过"的，一律判为不通过。`;
exports.PROBER_GUIDANCE_STATUS_CLAUSE = `=== 来自 prober 的一切内容都是「可错的一家之言」（★ 认真读，但不许奉为金科玉律 ★）===
- 本 prompt 中所有出自 prober 的内容——探针（含 expect、confidence、patcher_guidance「出题人指引」）、kill line、假设排名与备选站点、blocked/open_question 断言——都是**另一个独立模型提出的假设**，其中一部分**必然可能是错的**。它们的价值是独立视角 + 可检验线索；它们不是权威、不是规范、不是验收。
- 处置要求（对每一条 prober 指引都要给出明确处置，禁止静默忽略、禁止照抄）：
  · 认真读：先读懂它到底断言了什么行为、指向哪段调用链，再动手。
  · 独立判：用**工作区代码 + 公开材料**（problem_desc/bug 报告、仓库文档与注释、public 复现脚本、你自建的本地实验）自行判断它是否成立。
  · 成立 → 采纳，并在补丁说明中给出**你自己的独立依据**（代码位置 / 文档 / 实测命令与输出），而不是「因为 prober 这么说」。
  · 不成立 → 在补丁说明中写明它错在哪（哪条断言不属于契约、与哪条公开材料冲突），然后走你自己的路线。
  · 判不了 → 把它写成显式假设，设计一条本地实验去裁决，用实测结果决定。
- ★ 禁止诉诸权威 ★：不得仅因 prober 的探针期望或指引而改动代码；也不得为了「跟 prober 保持一致」而回避正确的修法。反过来，也不得因为「prober 可能错」就跳过它提出的每一条线索——它多数时候是对的，跳过前必须有具体理由。
- 探针结果（符合预期 / 不符预期）与 kill line 翻转与否都只是证据：prober 及其探针**都不决定验收**，验收只由 public 测试 + 上文契约条款决定。`;
exports.KILL_LINE_CLAUSE = `=== 假设 kill line（prober 的一家之言：导航线索，★ 不是验收门禁 ★）===
- 探针报告含「假设排名 + kill line」时，它是一条**可错的、但值得优先检验的导航线索**：建议先在**未修改**代码上复现 prober 记录的本底结论，改完代码后再跑同一条命令看是否翻转（refutes_if / 反证）。
- ★ kill line 不翻转不等于修复失败 ★：prober 是假设生成者，不是仲裁者，它的假设本身可能就是错的（rank-1 可能指错站点、falsifier 可能写错读法）。以你自己的实测与契约分析为准，并在最终回复中说明与 prober 记录的差异及你的独立依据。
- 探针（含 kill line）全绿同样不构成验收通过：验收只由 public 测试 + 契约条款决定；若某条探针断言的行为不属于契约（探针本身是错的），在最终回复中指出并跳过，禁止为迎合错误探针而扭曲代码。`;
exports.SELF_STRESS_CHECK_CLAUSE = `提交前自检：枚举模块 I/O 契约的全部输入维度，用自生成的压力输入在本地逐维度验证修复。`;
exports.MENTOR_RUBRIC_CLAUSE = `=== scientific-aware rubric（硬约束）===
- 你以「领域感知的补丁评估与选择器」身份工作：对每个候选补丁（含你自行合成的补丁）按 6 个维度打 0-10 分：
  1. Functional Correctness（20%）：是否通过 bug-specific / regression tests
  2. Numerical Correctness（20%）：数值稳定性、精度、误差、收敛性
  3. Scientific Validity（30%）：是否保持物理/化学规律与 scientific invariants（守恒律、对称性、量纲一致性等）
  4. Robustness（15%）：edge cases / 分布外（OOD）科学场景
  5. Intent Preservation（10%）：是否真正实现开发者/科学意图
  6. Patch Quality（5%）：简洁性、局部性、避免不必要修改
- 加权分 Score = 0.20·F + 0.20·N + 0.30·S + 0.15·R + 0.10·I + 0.05·Q。加权总分由系统按你的维度分自动计算，你只需给出各维度 0-10 分，不要自行心算总分。
- 每个维度的打分必须引用具体证据（bug 报告、diff 涉及的代码上下文、补丁内容、verify 探针结果、public 测试输出、科学不变量），禁止「我认为 A 比 B 好」式拍脑袋；证据只能取自动作区已提供的材料（diff、verify 结果、探针清单、bug 报告），不得自行执行命令读源码或重跑探针。
- Critical Scientific Error（CSE，硬约束）：候选补丁若违反关键科学不变量（如守恒律、对称性、量纲一致性、energy-force consistency），则 CSE=YES，无论加权分多高都必须排除。
- 选择规则 = 硬约束 + 加权分：先过滤 P' = { P | CSE(P)=NO }，再 P* = argmax_{P∈P'} Score(P)；若全部候选 CSE → verdict=regenerate。
- 候选补丁已匿名化（Candidate 1 / Candidate 2），不得猜测或以「生成模型」作为评分依据。`;
exports.HIDDEN_CONTRACT_QUOTA_CLAUSE = `=== 隐藏契约交付（★ 这是你的第一交付物，硬约束 ★）===
- 你的第一交付物**不是探针**，而是**隐藏契约清单（hidden_contracts）+ 仓库结构图（structure_map）**：
  隐藏契约 = 这份代码里「没有写在签名/文档里、但被多处调用点共同依赖」的行为约定（不变量、前置/后置条件、
  单位与 axis 约定、顺序约定、异常语义、别名与命名约定、数据形状、数值容差、资源生命周期）。
- 最低交付：hidden_contracts ≥ 3 条、至少覆盖 2 种不同的 kind、structure_map ≥ 2 条入口链。
  未达标会被要求补正一次；仍不达标则告警放行（非阻塞，但报告会被标记为不合格）。
- 每条契约必须可复核/可证伪：
  · statement：一句话行为断言（禁止「代码存在问题」这类空话）
  · locus：契约生效/被依赖的位置，写成 file:symbol（可带 :line）
  · discovered_via：你是怎么发现它的（调用点并置 / 数据结构自洽 / 两条路径必须同结果 / 异常边界 / 单位与 axis 约定 / 公开材料与实现对照）
  · evidence：file:line 引用、文档原文、或你自己跑出来的实测输出（★ 禁止「我认为」「我推测」式证据）
  · violates_if：什么样的修复会破坏它（给 patcher 的最有价值信息）
  · patcher_action：要求 patcher 独立核实/必须保留的具体事项（1–3 句）
  · confidence(0–1) 与 open_question（未决语义只能以问题形式提出）必填
- structure_map 每条至少含 entry（公开入口 file:symbol）、chain（逐跳 file:symbol → … → 契约站点）、
  termination（这条链终点说明了什么）、siblings（共享同一契约、必须一并评估的兄弟调用点）。
- ★ 契约同样是「可错的一家之言」★：你会被要求给出 confidence，patcher 会独立核实；禁止把猜测写成结论。`;
/** 探针维度配额的降级版：探针不再是第一交付物，只在产出探针时适用。 */
exports.PROBE_AS_EVIDENCE_CLAUSE = `=== 探针（可选辅助证据，★ 不再是第一交付物 ★）===
- 探针只是把某条隐藏契约变成「可复核命令」的手段，不是必交项：契约已经能用 file:line / 文档原文 / 实测输出
  说清楚时，**不要**为了凑数再写探针。
- 需要产出探针时，探针仍是**可错的一家之言**：不是验收门禁、不是私有测试；探针全绿不证明修复正确，
  探针失败也不证明修复错误。最终裁决权属于 patcher 的实测与 public 测试。
- 产出探针时请按维度尽量补齐（main_path / param_space / name_variants / robustness / api_surface），
  并在 dimension 字段声明所属维度、让顶层 coverage_matrix 与之一致；这不再是硬性配额，只是建议的覆盖面。`;
//# sourceMappingURL=promptClauses.js.map