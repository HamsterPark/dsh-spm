/**
 * 模型会读到的**钉住短语**（PLAN §3.2-16、§6.2 的 `messages.ts`）。
 *
 * 判据不落在文案上：每一句都配一个机器可判的码，文案只做渲染。集中放在一处为两件事——
 * 改一句话时一眼看得到它还被谁读；测试能逐字钉住它，并钉住它**不被换行劈开**
 * （模型、日志检索与人都按整行读）。
 *
 * 目前只有一动一观的拒绝。别处既有的短语（`formatCommsDown` 等）仍跟着各自的状态机放，
 * 迁过来是另一件事。
 */

/** 一动一观闸门的拒绝码，也是拒绝文案的前缀（`[act_gate]`）。 */
export const ACT_GATE_CODE = 'act_gate'

/**
 * 一动一观（VISUAL-HARNESS §4.5）：同一会话里上一个改变仪器状态的调用，其结果还没进入
 * 模型上下文，这一个就不执行。
 *
 * 措辞取自参考实现（VISTA-SPM `host.py::GATE_REFUSAL`，原句英文），只把 `act` 换成
 * 「改变仪器状态的动作」——本仓没有单一的 `act` 工具，动作就是那些改变仪器状态的技能工具
 * （spec/deviations.md D-VMEM-15）。**「No action was executed」必须留着**：模型要知道这一次
 * 什么都没发生，下一步看过上一个结果再决定，而不是以为它已经跑了。
 */
export const ACT_GATE_REFUSAL =
  `[${ACT_GATE_CODE}] Observe the result of the previous action that changes the instrument ` +
  'before another such action. No action was executed.'
