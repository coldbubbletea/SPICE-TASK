"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockBackend = void 0;
/**
 * 前端联调用 Mock 后端：不接 codex，回显一段流式文本和一条命令事件，
 * 用于在 Extension Development Host 里验证聊天 UI 的渲染与状态流转。
 */
class MockBackend {
    constructor() {
        this.onEvent = () => { };
    }
    send(message) {
        this.cancel();
        this.onEvent({ type: 'status', status: 'running' });
        const reply = `[mock] 收到消息（${message.length} 字符）：\n` +
            message.split('\n').slice(0, 3).join('\n') +
            `\n\n这是 Mock 后端的流式回显，用于验证前端渲染。`;
        const chunks = reply.match(/[^]{1,24}/g) ?? [];
        let index = 0;
        const step = () => {
            if (index < chunks.length) {
                this.onEvent({ type: 'text', text: chunks[index++] });
                this.timer = setTimeout(step, 30);
            }
            else {
                this.onEvent({ type: 'command', command: 'echo mock-done', exitCode: 0 });
                this.onEvent({ type: 'status', status: 'idle' });
            }
        };
        this.timer = setTimeout(step, 30);
    }
    cancel() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
}
exports.MockBackend = MockBackend;
//# sourceMappingURL=mockBackend.js.map