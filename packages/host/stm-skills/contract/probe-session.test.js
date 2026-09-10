/**
 * `_Probe` 走**完整一条链**：`ctx.tools.execute` → guard → pre-execute → 工具体 →
 * `SkillKernel` K0–K18 → 记录库。
 *
 * 前面每一段都是分开测的。分开测不了的正是这一段要看的东西：
 * **一次调用在真实调度链上会不会在某个环节整个消失。**
 * 单测里内核总是被直接调用，而真实路径上它前面还有两道 dsh 侧的闸——
 * 那两道闸如果拒了，内核根本不会被调用，于是记录层什么也看不见。
 */
import { Context } from 'dsh-spm-compat';
import { SkillKernel, emptyHardwareState } from 'dsh-spm-kernel';
import * as records from 'dsh-spm-stm-records';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineSkillTool } from '../src/tool.js';
const S0 = emptyHardwareState('T0');
const probe = (over = {}) => ({
    spec: {
        name: '_Probe',
        description: '内核探针',
        parameters: [{ name: 'setpoint_a', type: 'float', unit: 'A', required: true }],
        ...over.spec,
    },
    execute: over.execute ?? (() => Promise.resolve({ success: true, summary: '_Probe: ok' })),
});
let ctx;
beforeEach(async () => {
    ctx = new Context();
    ctx.plugin(records, {});
    await new Promise((r) => ctx.inject(['stmRecords'], () => r()));
});
afterEach(async () => {
    await ctx.registry.delete(records);
});
/** 装一个由内核驱动的 `_Probe` 工具，返回它的执行入口。 */
function install(kernel, skill = probe()) {
    ctx.tools.register(defineSkillTool(skill, { kernel }));
    return async (args) => {
        const r = await ctx.tools.execute({
            callId: 'c1',
            name: skill.spec.name,
            arguments: args,
            signal: new AbortController().signal,
        });
        return r;
    };
}
const rows = () => ctx.stmRecords.store.db
    .prepare('SELECT action_type, status, error FROM actions ORDER BY hlc')
    .all();
describe('_Probe 在真实调度链上走一趟', () => {
    it('成功：工具体跑到、内核记一行 succeeded', async () => {
        const run = install(new SkillKernel({ snapshot: () => S0, record: ctx.stmRecords.fromKernel }));
        const r = (await run({ setpoint_a: '100p' }));
        expect(r.isError).toBe(false);
        expect(rows()).toEqual([{ action_type: '_Probe', status: 'succeeded', error: null }]);
    });
    it('内核拒绝：**照样落一行** —— 拒绝是一次正常返回，不是异常', async () => {
        const run = install(new SkillKernel({
            snapshot: () => S0,
            abortLatched: () => true,
            record: ctx.stmRecords.fromKernel,
        }));
        const r = (await run({ setpoint_a: '100p' }));
        // dsh 侧是成功的（工具返回了文本），内核侧是拒绝的 —— 两个层面不是一回事
        expect(r.isError).toBe(false);
        const [row] = rows();
        expect(row?.status).toBe('failed');
        expect(row?.error).toContain('中止已闩上');
    });
    it('**dsh 侧的 guard 拒绝时，内核根本没被调用** —— 所以记录层看不见这一条', async () => {
        // 这是分开测发现不了的那种洞：单测里内核总是被直接调用。
        // 记下来是因为它有后果 —— 「为什么什么都没发生」在这条路上暂时答不出，
        // 而答案只能由拒绝的那一方（guard 自己）补上。3.x 接 stm-safety 时要解决。
        const run = install(new SkillKernel({ snapshot: () => S0, record: ctx.stmRecords.fromKernel }));
        ctx.tools.guard(() => '[test_gate] 就是不让过');
        const r = (await run({ setpoint_a: '100p' }));
        expect(r.isError).toBe(true);
        expect(r.error?.message).toContain('就是不让过');
        expect(rows()).toEqual([]); // ← 记录层是空的
    });
    it('参数非法：dsh 先拦，而**教学文案贴回去了**（D-SCHEMA-3）', async () => {
        const run = install(new SkillKernel({ snapshot: () => S0, record: ctx.stmRecords.fromKernel }));
        const r = (await run({}));
        expect(r.isError).toBe(true);
        const text = r.content.map((c) => c.text ?? '').join('\n');
        expect(text).toContain('setpoint_a'); // dsh 说的是哪个参数
        expect(text).toContain('precondition_failed: 参数超出允许范围'); // 旧仓的教学文案
    });
    it('SI 字符串在链路上**全程保持字符串**，只在内核里变成数字', async () => {
        let seen;
        const run = install(new SkillKernel({ snapshot: () => S0, record: ctx.stmRecords.fromKernel }), probe({
            execute: (_c, p) => {
                seen = p['setpoint_a'];
                return Promise.resolve({ success: true, summary: 'ok' });
            },
        }));
        await run({ setpoint_a: '100p' });
        expect(seen).toBe(1e-10);
        // 记录里也是数字 —— 那四个生成列读的就是这里
        const v = ctx.stmRecords.store.db
            .prepare('SELECT param_setpoint_a AS v FROM actions')
            .get();
        expect(v.v).toBe(1e-10);
    });
    it('一整轮下来，账本能反驳一条捏造的声明', async () => {
        const run = install(new SkillKernel({ snapshot: () => S0, record: ctx.stmRecords.fromKernel }));
        await run({ setpoint_a: '100p' });
        const entry = ctx.stmRecords.runEntry();
        expect(entry.skills).toEqual(['_Probe']);
        // 跑过技能 ⇒ 「零技能」那条不成立；但它引用的文件仍然不存在 ⇒ 仍然被抓
        const v = records.auditClaim('结果见 D:\\data\\never.sxm', {
            executedSkills: entry.skills,
            artifacts: entry.artifacts,
            pathExists: () => false,
        });
        expect(v.unsupported_completion).toBe(false);
        expect(v.fabricated_paths).toEqual(['D:\\data\\never.sxm']);
    });
});
//# sourceMappingURL=probe-session.test.js.map