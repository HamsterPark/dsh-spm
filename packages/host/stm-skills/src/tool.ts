/**
 * `defineSkillTool()` —— 把一个 `Skill` 变成 dsh 的一个工具。
 *
 * 这是**技能与 dsh 之间唯一的接缝**：schema 从 `parametersFromSpec` 来（那一份对着
 * 旧仓的金样逐字比过），执行一律走 `SkillKernel.run()`（K0–K18 那条唯一的通道）。
 * 工具本身**不做任何判断**——它只是把 dsh 的调用形状翻译成内核的调用形状，再把
 * `SkillOutcome` 翻译回去。任何一道闸如果在这里也写一遍，就会有第二个答案。
 *
 * ## D-SCHEMA-2：数值上下界进不了 dsh 的参数 schema
 *
 * dsh 的参数 DSL 关键字白名单是 `type / enum / const / description / title /
 * default / properties / required / items / oneOf`，**没有 `minimum`/`maximum`**，
 * 并且明确「不支持的关键字直接拒绝，而不是收下但不强制」——这是个好设计（不广告
 * 你不执行的东西），但参考实现曾暴露出一个数值单位校验问题：
 *
 * > `SetSetpoint(setpoint_a=1.5)` 会被解释为 1.5 **安培**，而常见意图可能是 1.5 nA。
 * > 那个参数的描述里已经逐字写了范围，还拿 1.5 本身当反例，`min_value`/`max_value`
 * > 也都声明了。仅靠说明文字不能代替机器可读的数值边界。
 *
 * 于是 Python 用 `Field(ge=, le=)` 把界塞进了 payload。到了 dsh，这条路没有了。
 *
 * **我们的做法**：把界折进 description——和有量纲参数走字符串通道时的做法完全一样
 * （那边 `ge/le` 同样到不了 schema，范围也是写在描述里）。影响面 514 个参数 / 275 个
 * 技能。执行侧不受影响：K6 与安全闸照旧按 `effectiveBounds` 拦，**拦的措辞也没变**。
 *
 * 换句话说，丢的是「模型能不能在生成时就被约束住」，不是「越界能不能被拦住」。
 */
import type {
  ParameterPropertySpec,
  ParameterSchemaSpec,
  ToolDefinition,
  ToolExecution,
  ToolExecutionResult,
  ToolRunContext,
} from 'dsh-spm-compat'
import { defineTool } from 'dsh-spm-compat'
import type { SafetyLimits, Skill, SkillContext, SkillKernel, ToolParameters } from 'dsh-spm-kernel'
import { explainValidationError, formatG, parametersFromSpec } from 'dsh-spm-kernel'

/** 把界写成模型读得懂的一句话。没有单位就不写单位。 */
function boundsSentence(lo: number | undefined, hi: number | undefined): string {
  const show = (v: number): string => (v === 0 ? '0' : formatG(v, 6))
  if (lo !== undefined && hi !== undefined) return `范围 ${show(lo)} … ${show(hi)}`
  if (hi !== undefined) return `最大 ${show(hi)}`
  if (lo !== undefined) return `最小 ${show(lo)}`
  return ''
}

/**
 * JSON-Schema 形状 → dsh 的参数 DSL。
 *
 * 两处形状差异，**都在这里显式发生**，不在生成侧：
 * 1. `required` 从根上的数组变成每个属性上的 `required: true`；
 * 2. `minimum`/`maximum` 折进 description（D-SCHEMA-2）。
 *
 * 生成侧保持与 Python 逐字一致，好让金样比对说的是真话；偏差集中在这一个函数里，
 * 于是「哪里和上游不一样」这个问题有一个确切的答案。
 */
export function toDshParameters(p: ToolParameters): ParameterSchemaSpec {
  const required = new Set(p.required)
  const out: ParameterSchemaSpec = {}

  for (const [name, prop] of Object.entries(p.properties)) {
    const sentence = boundsSentence(prop.minimum, prop.maximum)
    const description =
      sentence === ''
        ? prop.description
        : prop.description === undefined || prop.description === ''
          ? sentence
          : `${prop.description} ${sentence}`

    const common = {
      ...(description === undefined ? {} : { description }),
      ...(prop.default === undefined ? {} : { default: prop.default as never }),
      ...(required.has(name) ? { required: true as const } : {}),
    }

    // 逐类型构造而不是一把 `as`：dsh 的 spec 是判别联合，`enum` 的元素类型跟着
    // `type` 走。绕过它就等于把「枚举值和声明的类型对不上」留到运行期才发现。
    const t = prop.type ?? 'string'
    let spec: ParameterPropertySpec
    if (t === 'boolean') {
      spec = {
        type: 'boolean',
        ...common,
        ...(prop.const !== undefined ? { const: prop.const as boolean } : {}),
        ...(prop.enum !== undefined ? { enum: prop.enum as readonly boolean[] } : {}),
      }
    } else if (t === 'integer' || t === 'number') {
      spec = {
        type: t,
        ...common,
        ...(prop.const !== undefined ? { const: prop.const as number } : {}),
        ...(prop.enum !== undefined ? { enum: prop.enum as readonly number[] } : {}),
      }
    } else {
      spec = {
        type: 'string',
        ...common,
        ...(prop.const !== undefined ? { const: prop.const as string } : {}),
        ...(prop.enum !== undefined ? { enum: prop.enum as readonly string[] } : {}),
      }
    }
    out[name] = spec
  }
  return out
}

export interface SkillToolDeps {
  readonly kernel: SkillKernel
  readonly limits?: SafetyLimits | undefined
  /**
   * 这次调用算谁批准的。缺省 `'llm'`——**工具入口就是模型入口**。
   * 人从命令或界面发起的那条路自己传 `'human'`，硬闸对两者的答案不同
   * （模型来的直接拒，人来的才问）。
   */
  readonly approvalSource?: 'llm' | 'human' | 'auto' | undefined
  /** 标记发射器。缺省无操作；2.13 的 RunLedger 会接上真的那个。 */
  readonly markers?: ((exec: ToolRunContext) => SkillContext['markers']) | undefined
}

/**
 * 把一个技能包成 dsh 工具。
 *
 * 输出是**一段文本**，不是结构体：模型读的就是这段文本，而拒绝、失败、成功走的是
 * 同一条通道（Python 那边也是——拒绝是一条 tool message，不是异常，模型据此改正）。
 * 结构化的那份留在 `SkillOutcome` 里，2.13 的 RunLedger 从内核直接取，不绕道模型。
 */
export function defineSkillTool(skill: Skill, deps: SkillToolDeps): ToolDefinition {
  const spec = skill.spec
  const params = toDshParameters(parametersFromSpec(spec, deps.limits))

  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: params,
    output: {
      schema: { type: 'string' },
      // 返回类型不标注：`defineTool` 的选项类型已经知道它是 ContentBlock[]，
      // 为一个标注给 compat 引一整个 `dsh-llm` 依赖不划算（还要钉三处版本）。
      render: (_args, value) => [{ type: 'text' as const, text: value }],
    },
    /**
     * D-SCHEMA-3：参数校验失败时，把旧仓那段**教学文案**贴回去。
     *
     * dsh 在 `execute` **之前**按 schema 校验参数（漏必填、类型不对、枚举不在集合里），
     * 失败时模型读到的是 `invalid arguments: missing required property "x"`。旧仓当年
     * 专门挂 `handle_validation_error` 就是为了这个：样板话「不是模型能据此行动的
     * 东西」。语言换了，问题没换。
     *
     * **偏差在于我们不丢掉 dsh 那一行。** 旧仓的钩子完全忽略异常内容，于是一次
     * 「少传了 setpoint_a」会被渲染成「参数超出允许范围」——文案对，指向错。
     * dsh 那行说的是**哪个参数怎么了**，这是旧仓当时拿不到、或者说没去拿的信息。
     * 所以：dsh 的一行 + 逐字的教学文案，两段都留。逐字那一段单独可测（对金样）。
     */
    finalizeContent: (_exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
      if (result.isError !== true) return undefined
      if (result.error.info?.code !== 'INVALID_ARGS') return undefined
      return [
        { type: 'text' as const, text: result.error.message },
        { type: 'text' as const, text: explainValidationError(spec, deps.limits) },
      ]
    },
    execute: async (args, exec): Promise<string> => {
      const outcome = await deps.kernel.run(skill, args as Record<string, unknown>, {
        rootCallId: exec.rootCallId,
        // `Agent` 上只有 `id`（一个 SessionId）——Python 那边 owner 是 agent 名字，
        // 这里能拿到的最接近的东西就是它。记录里认得出是谁发的就够了。
        ...(exec.agent === undefined ? {} : { owner: exec.agent.id }),
        signal: exec.signal,
        approvalSource: deps.approvalSource ?? 'llm',
        ...(deps.markers === undefined ? {} : { markers: deps.markers(exec) }),
      })
      // 中止闩要**结束本轮**，不是让模型接着试下一个技能——`concludeTurn` 就是
      // dsh 侧表达这件事的地方，内核那一位布尔到此为止。
      if (outcome.concludeTurn === true) exec.concludeTurn()
      return outcome.text
    },
  })
}
