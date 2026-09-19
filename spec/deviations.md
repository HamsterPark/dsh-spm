# 有意与 Python 不同的行为

**未登记的差异 = 缺陷**（PLAN §12）。每条必须写清：差在哪、为什么有意、哪个测试钉住它。
金样（`spec/golden/`）录的是 Python 的真实行为，所以这些差异会让金样测试变红——测试里逐条
用 `DEVIATIONS` 表声明期望，**不是跳过**：TS 侧的行为同样被断言，只是断言的是这份文档说的那样。

---

## D-SI-1 · 宽松档拒绝 `inf` / `nan`

| | |
|---|---|
| **Python** | `parse_quantity('inf', strict=False)` → `+∞`；`'nan'` → `NaN`；`'-inf'` → `-∞`（`float()` 认这些拼写） |
| **TS** | 三者都抛 `SIParseError` |
| **测试** | `packages/host/kernel/src/si.test.ts` → `parse_quantity('inf', loose)` / `('nan', loose)` / `('-inf', loose)` |

**为什么有意**：`NaN` 会**穿过包络检查**。所有与 NaN 的比较都是 false，所以 `nan > max` 为假、
`nan < min` 也为假——一个「已检查过范围」的参数就这样带着 NaN 到了仪器。`±∞` 同理，且没有任何
物理参数的合法值是无穷。这与 PLAN §3.2-13「『读不到』不是答案，`None/0/False` 不冒充」同源：
一个不表示测量值的东西不该被当成测量值放行。

旧仓这个行为更像是 `float()` 的默认宽容漏出来了，而不是设计。**如果哪天旧仓真的依赖它**，
这条要翻案——但那时应该是旧仓改，不是我们放松。

**机制说明（2026-09-08 变红演练查明）**：这三条的拒绝其实是 **JS 语义白送的**——`Number('inf')`、
`Number('nan')`、`Number('1_000')` 本来就是 `NaN`，不是我写的那条正则挡下来的。演练时把正则去掉换成
裸 `Number(s)`，这三条**照样通过**。所以：它们是真实的行为差异（值得登记），但不要以为是我们主动
实现的防线——**将来若有人为了别的目的改动这段解析，这三条不会自动跟着改**，得靠上面这条测试盯着。

## D-SI-2 · 宽松档拒绝下划线分隔符 `1_000`

| | |
|---|---|
| **Python** | `parse_quantity('1_000', strict=False)` → `1000`（Python 字面量语法，`float()` 继承了它） |
| **TS** | 抛 `SIParseError` |
| **测试** | `packages/host/kernel/src/si.test.ts` → `parse_quantity('1_000', loose)` |

**为什么有意**：这不是安全收紧，就是**没必要实现**。下划线是 Python 数字字面量的写法，模型
路径上不会出现（工具 schema 声明是 string，模型写的是 SI 形式或普通十进制），实现它只是给
一个没有消费者的写法加分支。哪天真有人写了，加一行 `replaceAll('_','')` 即可。

## D-WIRE-1 · 命令名超过 32 字节时抛错，不产出错位的帧

| | |
|---|---|
| **Python**（`stmsim/wire/codec.py::build_request_frame`） | `command.ljust(32, '\0')` 对 40 字符的名字**不截断** ⇒ 帧变成 48 字节，多出的 8 个字符直接盖住 `body_size` 与 `send_response_back` 字段 |
| **TS** | 抛 `WireFrameError` |
| **测试** | `packages/instrument/nanonis-wire/src/frame.test.ts` → 「名字段放不下就抛」——该测试**同时断言金样里那条帧确实是 48 字节**，证明这个 bug 存在而不是我臆想的 |

**为什么有意**：错位的帧不是「这一次调用失败」，是**整条 TCP 流失步**——之后每一个回复都会被
当成另一个命令的回复，而回声校验会把它报成断链。宁可在构造期拒绝一次调用。真实 Nanonis 动词
最长约 25 字符，这条永远不会在生产路径上触发；它防的是我们自己将来写错常量。

## D-WIRE-2 · 名字段按**字节**补齐，不按字符

| | |
|---|---|
| **Python** | `ljust(32)` 先按**字符**补到 32，再 `.encode('utf-8')` ⇒ `Ünicode.Verb`（Ü 占 2 字节）产出 **33 字节**的名字段，整帧错位 1 |
| **TS** | 先编码再补齐到 32 **字节**，产出对齐的 40 字节帧 |
| **测试** | 同上文件 →「非 ASCII 名字」；逐字节对齐的那组测试用「**金样本身是良构帧**」做过滤条件（不是「名字放得下」），否则会把上游的 bug 抄成我们的规格 |

**为什么有意**：同 D-WIRE-1。Nanonis 动词全是 ASCII，这条同样不会在生产路径上触发。
**登记它的价值在于那条过滤条件**——如果按「名字放得下」过滤，这条错位帧会被当成期望值，
我们就会主动实现一个错位的成帧器。

## D-WIRE-3 · `*H` / `*h` / `*b` / `*B` 直接抛，不复刻客户端的错位步长

| | |
|---|---|
| **真实客户端**（`nanonis_spm.decodeArrayPrepended`） | 读 `*X`/`-*X` 数组时**步长固定为 4**（`d` 除外，为 8），与元素实际大小无关 |
| **仪器** | 按元素真实大小写：`H`/`h` 是 2 字节 |
| **后果** | 用 `*H` 的方法，客户端会按 4 字节跨过一个 2 字节的元素——**读出的整个数组是错位的**，而且每个值都是"合法的数" |
| **TS** | 遇到 `*` + 2/1 字节元素直接抛 `WireTypeError` |
| **测试** | `packages/instrument/nanonis-wire/src/types.test.ts` → 「D-WIRE-3」；同组还断言真实用到的 `*f`/`*i`/`*I`/`*d` 不受影响 |

**为什么有意**：671 个方法里**没有一个**用 `*H`/`*h`/`*b`/`*B`（回复侧的 `*X` 只有 `*f` 12 次、
`*i` 10 次、`*d` 7 次、`*I` 2 次，全是 4 或 8 字节），所以这条永远不触发。正因为不触发，
**静默复刻这个 bug 的代价是零收益、全风险**：将来上游加一个 `*H` 方法，我们会安静地读出垃圾。
明确抛错等于把「先决定跟客户端还是跟仪器」这个问题留在原地，而不是替未来的人做错决定。

与 D-SI-1 同一个道理：一个不表示测量值的东西不该被当成测量值放行。

## D-SI-4 · 宽松档拒绝 JS 认而 Python 不认的写法（`0x10`、`Infinity`）

| | |
|---|---|
| **Python** | `float('0x10')` → 报错；`float('Infinity')` → `+∞` |
| **JS 裸 `Number()`** | `Number('0x10')` → `16`（**十六进制**）；`Number('Infinity')` → `+∞` |
| **TS 本模块** | 两者都抛 `SIParseError`——用一条只认十进制/科学计数法的正则把 `Number()` 收窄 |
| **测试** | `packages/host/kernel/src/si.test.ts` → `parse_quantity('0x10', loose)`（金样里 Python 也拒绝，所以这条**不是**偏差，是「TS 必须主动收窄才能与 Python 一致」） |

**这条与 D-SI-1/2 相反**：那两条是 JS 恰好更严，这条是 JS 更宽、必须主动收窄。2026-09-08 的变红演练
证实了这一点——去掉正则换成裸 `Number(s)`，只有 `'0x10'` 变红。**那条正则真正在承担的就是这个**。

## D-SI-3 · 报错原文里 Python `repr()` 的 int/float 之分无法复刻

| | |
|---|---|
| **Python** | `repr(0)` → `0`（int）、`repr(0.0)` → `0.0`（float），两者是不同的类型 |
| **TS** | JS 只有一种数字类型，`pyRepr(0)` 恒为 `0` |
| **测试** | 金样目前只含 int 形态（`parse_si(0)` / `parse_si(1.5)`），所以**当前不变红** |

**为什么有意**：语言层面无法消除。影响面仅限于报错句子里那个数字的显示形式，且只出现在
**内部调用者传裸数字**的路径上——模型路径永远传字符串。若将来有人靠这句话做字符串匹配，
那才是缺陷，届时改成结构化 code（PLAN §3.2-16 本来就要求判据不落在文案上）。

## D-STATE-1 · 状态缓存的读与写用**同一把尺子**（Python 的读侧更松）

| | |
|---|---|
| **Python `refresh()`** | 每个字段是裸 `float(parsed[0])`：`"1.5"` 收下、`NaN` 收下、形状错就**抛** |
| **Python `apply_patch()`** | 同一个缓存的另一个入口走 `scalar_float`：字符串拒、`NaN`/`inf` 拒、多元素序列拒 |
| **TS 本模块** | 两条路都走 `scalarFloat`。读不出数的字段 = **没读到**（`null`），走 carry-forward / stale |
| **证据** | `spec/golden/state.json` 的 `bad_shape_raises` / `nan_through_refresh` / `string_through_refresh` 三条——不是推测，是跑真 `InstrumentState` 跑出来的 |
| **测试** | `packages/instrument/instrument-state/src/cache.test.ts` → `describe('D-STATE-1 …')` |

**为什么有意**，三条，按份量排：

1. **抛出去的代价不是「这个字段没读到」，是「这一秒整个没读到，而且没人知道」。** `refresh()` 里
   `self._cache = state` 在最后一行，抛在它之前 ⇒ 十一个读**全部作废**，缓存悄悄停在旧值上，
   `stale` 不亮、时间戳不动。`stale` 这一位存在的全部理由就是「别把陈值当活值」（2026-07-03 复查），
   而这条路径正好绕开了它。
2. **`NaN` 会被写进缓存和历史环。** 与 D-SI-1 同源：`nan < limit` 恒假，于是安全包络对它形同虚设。
   一个「读数」若不表示测量值，就不该以读数的身份存在。
3. **同一个缓存不该有两套判据。** Python 自己的 `coerce_number` docstring 写着「逐处打补丁只会
   制造第八份实现」——它把判据收拢到了 `scalar_float`，只是**没把读的那一侧也接上去**。

代价：`"1.5"` 这种字符串读数我们会拒。这些动词（`Bias_Get` 等）回的都是数值码，
字符串出现即形状错——**拒绝正是想要的行为**。

## D-SCHEMA-1 · `allowed_values` 里的浮点：JSON 边界上分不出 `1.0` 和 `1`

| | |
|---|---|
| **Python** | `isinstance(v,(str,int,bool)) and not isinstance(v,float)` —— 含浮点的集合**整条失效**，schema 里既没有 `enum` 也没有 `minimum` |
| **TS** | `Number.isInteger(v)` —— JSON 里 `1.0` 解析出来就是 `1`，于是 Python 会拒的 `[1.0, 2.0]` 在我们这边成立 |
| **可观测处** | **只有一处**：`explainValidationError` 的枚举行。Python 印 `{0.5, 1.0}`，我们印 `{0.5, 1}` |
| **测试** | `tool-schema.test.ts` → `D-SCHEMA-1 在这里**变得可观测**` |

**为什么有意**：信息在 JSON 边界就丢了，TS 侧无从恢复。影响面实测为 **0**——1642 个真参数里
没有一个含浮点 `allowed_values`。金样用例 `enum_float_rejected` 是合成的，它存在的意义是
**把这条分支钉住**，不是它有现役调用方。

顺带记一笔旧仓自身的不一致（我们照抄）：schema 那边把含浮点的枚举整条丢掉，而
`_explain_validation` 那边**不过滤**——于是同一个参数，模型在 schema 里看不到合法值，
在报错文案里反而看得到。

## D-SCHEMA-2 · 数值上下界进不了 dsh 的参数 schema，改折进 description

| | |
|---|---|
| **Python** | `Field(ge=, le=)` ⇒ payload 里有 `minimum`/`maximum`。这是**血换来的**：2026-07-27 真机 `SetSetpoint(setpoint_a=1.5)`——1.5 **安培**，实际意图 1.5 nA，模型连发十一次；描述里早已逐字写了范围、还拿 1.5 当反例，散文当时不够 |
| **dsh** | 参数 DSL 的关键字白名单是 `type / enum / const / description / title / default / properties / required / items / oneOf`，**没有数值界**，而且「不支持的关键字**直接拒绝**，不是收下但不强制」 |
| **我们** | `parametersFromSpec` 照旧产出 `minimum`/`maximum`（好让金样比对说的是真话），`toDshParameters()` 把它折进 description——**与有量纲参数走字符串通道时的做法完全一样**，那边 `ge/le` 同样到不了 schema |
| **影响面** | 514 个参数 / 275 个技能（无单位的数值参数；有单位的本来就走字符串通道） |
| **测试** | `stm-skills/tool.test.ts` → `**证明这条偏差是被迫的**`：`minimum` 直接给 dsh 会当场抛，折过的能过 |

**为什么有意**：dsh 的规则本身是对的（不广告你不执行的东西）。**丢的是「模型能不能在生成时
就被约束住」，不是「越界能不能被拦住」**——K6 与安全闸照旧按 `effectiveBounds` 拦，拦的措辞
也没变。那条测试是**反向**写的：哪天上游放开数值关键字，它会变红，我们就该回来把界还给 schema。
一条偏差不该无限期地活着。

## D-SCHEMA-3 · 参数校验失败：dsh 那一行**留着**，教学文案贴在后面

| | |
|---|---|
| **Python** | `tool.handle_validation_error = _explain_validation`，而 `_explain_validation(exc)` **完全忽略异常内容**，只按 meta 渲染一段固定的教学文案 |
| **dsh** | 在 `execute` **之前**按 schema 校验参数，失败抛 `ToolArgsError`（`code: 'INVALID_ARGS'`），消息形如 `invalid arguments: missing required property "setpoint_a"` |
| **我们** | `finalizeContent` 里返回**两段**：dsh 的那一行 + 逐字的 `explainValidationError()` |
| **测试** | 逐字那一段对 21 条金样比（`tool-schema.test.ts`）；两段的组合在 `stm-skills/tool.test.ts` |

**为什么有意**：旧仓这个钩子的理由写在它自己的 docstring 里——pydantic 的样板话
「不是模型能据此行动的东西」。换成 dsh 之后同一句样板话换了种语言，理由一字未变，所以
教学文案必须贴回去。**但旧仓丢了半截**：忽略异常内容意味着一次「少传了 `setpoint_a`」
会被渲染成「参数超出允许范围」——文案对，指向错。dsh 那一行说的正是**哪个参数怎么了**。

同时记下旧仓另一处不一致（照抄不改）：这段文案读的是 `spec.min_value/max_value`，
**不是** `effective_bounds`。于是 `center_x_m` 这种范围全部来自安全包络的参数，
描述里写着「范围 -1.5u … 1.5u m」，而这句话里是「见参数说明」——同一个参数，两处说法。
金样用例 `envelope_only` 把这一格钉住了。

## D-REC-1 · 没有活动实验时**也记**（旧仓整条不记）

| | |
|---|---|
| **Python** | `_record_v2_action` 开头是 `if repos is None or not eid: return None` —— 没有活动实验，v2 里一行都不写 |
| **为什么它这样** | `actions.experiment_id` 是 `NOT NULL` 外键，而 v1 那张表的同名列可空。这不是懒，是 schema 逼的（两个库分担了这件事） |
| **我们** | 种三行哨兵（`campaigns`/`samples`/`experiments`，id 全是 `_unscoped`），每次调用都有地方落。查询侧 `WHERE experiment_id = '_unscoped'` 就能把它们摘出来 |
| **测试** | `store.test.ts` → `**没有活动实验时也记**（D-REC-1）` |

**为什么有意**：「没有活动实验」恰恰是**样品闸拒绝的判据本身**。照抄的话，
最该被记下来的那一类拒绝会一条都不留——而记录层存在的全部意义，按旧仓自己的话说，
是回答「为什么什么都没发生」。我们只有一个库，没有 v1 那张可空表兜着。

## D-REC-2 · `approval_source` 落 `approvals` 表，不给 `actions` 加列

| | |
|---|---|
| **Python** | v1 的 `actions` 有 `approval_source` 列；**v2 的没有**。v2 的 `approvals` 表在这条路上基本是空的——旧仓注释：「nothing on this path records the HITL verdict」 |
| **我们** | `human` → `human_operator`/`gui_click`，`auto` → `automated_policy`/`policy_rule_v1`，`llm` → **不写行**。于是「没有 approvals 行」＝ llm，是可判的，不是缺失 |
| **测试** | `store.test.ts` → `approval_source 落库` 三条 |

**为什么有意**：不加列是因为 `approvals` 已经能表达它，而加列会让我们的库和金样 schema
不一致（`records_schema.sql` 的判据就是「建出来的库一模一样」）。而**必须真的写**这张表，
理由是旧仓自己写下的：

> 审批链路割掉之后 approvals 会变成一张只有历史行的死表，而事后查
> 「这个 DANGEROUS 动作是谁准的」时，**空表和「没人准过」长得一模一样**
> —— 2026-07-27 的取证正好栽在这个形状上。

内核每次调用都知道 `approvalSource`，所以人批准的那一半我们也写得出——这是旧仓那条路
拿不到的信息。

## D-REC-3 · 六种结局压进 schema 的三个 `status`

| | |
|---|---|
| **schema** | `status` 的 CHECK 只认 `pending/running/succeeded/failed/rolled_back/retracted` |
| **内核** | `ok / failed / refused / aborted / busy / rolled_back` |
| **映射** | `ok`→`succeeded`，`rolled_back`→`rolled_back`，**其余全落 `failed`** |
| **测试** | `store.test.ts` → `六种结局都落一行，status 按 schema 的 CHECK 收敛到三个值` |

**为什么有意**：区分没丢，它在 `error` 的**前缀**里（`[skill] precondition_failed:`、
`[sample_gate] …`、`[safety_gate] …`），而那个前缀本来就是机器读的——StallGuard 按它
聚合重复失败（课时 2.12 的 `explainValidationError` 里那句「前缀是**故意**的」）。
加一个 `'refused'` 状态值会让库与金样 schema 不一致，换来的只是一个已经能从前缀得到的答案。

## D-REC-4 · 路径比较写死 Windows 语义

| | |
|---|---|
| **Python** | `os.path.normcase(normpath(p))` ——**随平台变**：Windows 上小写化并把 `/` 换成 `\`，POSIX 上是恒等 |
| **我们** | 永远按 Windows 语义比 |
| **测试** | `claim-audit.test.ts` → `路径比较用 **Windows 语义**，不跟运行平台走` |

**为什么有意**：路径本身是**仪器机的 Windows 路径**，代码在哪台机器上跑不改变这一点。
跟着平台走的话，同一条金样在开发机（Windows）和 CI（Linux）上会给出两个答案，
而这条判据是用来反驳「agent 声称写了一个不存在的文件」的——它不该取决于谁在跑测试。

## D-SKILL-1 · 取不出数就是 `null`，绝不把回包信封当读数

| | |
|---|---|
| **Python** | 一族技能仍在走 `val = parsed[2][0] if isinstance(parsed,(list,tuple)) and len(parsed)>2 else parsed` —— 形状判据不成立时**把整个三段信封当成读数交出去** |
| **证据** | `spec/golden/skill_traces.json` 的 `empty@0` 逐格录着：`GetBiasCalibration` 的 `calibration` 收到的是 `["", "<bytes 0>", []]` |
| **我们** | 一律 `scalarFloat`：取不出数就是 `null`（与 D-STATE-1 同判据） |
| **影响面** | 15 格，登记在 `l0/traces.test.ts` 的 `DEVIATIONS` 里 |

**为什么有意**：`reply_scalar` 的 docstring 把后果写死了——2026-08-13 那次锁机，
抖动中收到一个两段的截断回包 ⇒ `len(parsed) > 2` 为假 ⇒ `('', b'…')` 被当成电流，
一路裸写进状态缓存，再被环境传感器 `float()` 抛成「硬故障」。旧仓把这一族修到了
`reply_scalar`，但**没修完**。

**登记方式值得说一句**：写的是「我们这一侧应该是什么」，而且**两侧都钉**——
测试同时断言旧仓那一侧**不等于**我们这个值。旧仓哪天把某一格修了，那一行会变红，
我们就该回来删掉它。一条偏差不该无限期地活着。

## D-SKILL-2 · 诊断文案里印的是 body，不是 Python 的回包 repr

| | |
|---|---|
| **Python** | `f"…读不懂(return_value={rec.return_value!r})"` —— 印的是三段信封的 Python repr |
| **我们** | 信封在 `nanonis-wire` 那层就拆掉了，`SkillCallRecord` 只有 `values`。印我们真有的东西 |
| **影响面** | 2 条（`GetAutoApproachStatus` / `ListSignalChannels` 的 `empty@0`） |

**为什么有意**：不可消除——我们这一侧根本没有那个信封，为了逐字而伪造一个
Python 元组的字面量，只会让诊断指向一个不存在的数据结构。

## D-SKILL-3 · 旧仓抛 `IndexError` 的那一格，我们判「读不出」

| | |
|---|---|
| **Python** | `GetSafeTipStatus` 直接 `parsed[2][0]`，空 body 时抛 `IndexError: list index out of range` |
| **我们** | 失败，并说清「这**不是**「保护未开」,是没问出来」 |
| **测试** | `l0/traces.test.ts` → `D-SKILL-3 · 旧仓会抛 IndexError 的那一格` |

**为什么有意**：一个只读技能以一句看不懂的 `IndexError` 失败，等于把
「保护未开」和「没问出来」交给调用方去猜——而这两者在要不要进针这件事上
是相反的处境。这正是 `reply_scalar` 那段 docstring 说的第一个毛病，同一族，
只是这一格没被修到。

## D-GRAPH-1 · LangGraph 的 `GraphInterrupt` 没有对应物

| | |
|---|---|
| **Python** | `run_plan` 里两处 `if _is_graph_interrupt(exc): raise` —— HITL 图节点暂停时必须冒泡 |
| **我们** | 不写 |
| **影响面** | 组合执行器的两条异常分支 |

**为什么有意**：dsh 没有图、没有 checkpointer、没有 human node。一个永远为假的分支
写出来只会让读的人以为有人在守它。操作员中止（`AbortRequested`）那一支照移——
它是真的控制流，而且真的会从子技能与生成器里抛出来。

## D-GRAPH-2 · 结论类旁白 `_narrate_step_result` 不移植

| | |
|---|---|
| **Python** | 步骤成功后按 `RESULT_KIND_FOR_SKILL` 发一条带图的旁白，图由 `mast.vision.cluster_panel.render_cluster_panel` 现场渲染落盘 |
| **我们** | 只移植开场旁白与失败旁白 |
| **影响面** | 一个发射点 |

**为什么有意**：视觉链路本仓还没有，而那张图不是装饰——旧仓自己的注释写着
「猜错 origin 的后果不是没有图，是**借了别的图**」。没有渲染方就发一条带 `image`
的旁白，等于发一条**指向不存在资源**的消息。开场与失败两条是纯的，照移；它们承担
「句子里的电压等于真正下发的电压」那条性质（交出去的 `params` 就是下一行送进子技能
的同一份）。

## D-SCAN-1 · JS 只有一种数，`rows`/`cols` 的表头识别判据不同

| | |
|---|---|
| **Python** | `parse_frame_grab` 用 `isinstance(x, int) and not isinstance(x, bool)` 从异构 body 里挑出表头整数；`2.0` 是 float，挑不中 |
| **我们** | `Number.isInteger(x)` —— `2.0` 在 JS 里就是整数 |
| **影响面** | 只有**扁平数值 body** 那条兜底路（桩 / 扁平仪器） |

**为什么有意**：不可消除。真机 body 里那个二维元素会先被找到，表头路根本不参与；
金样 10 格在两种判据下结论相同。差异是真的，但它没落在任何一个已知回包上。

**顺带查出旧仓一处夹具瑕疵**：`export_skill_traces.py` 给 `2f` 合成的是 Python
**list**，而真机上 `nanonis_spm` 解出来是 `ndarray`——旧仓的 `parse_frame_grab` 正是
靠 `isinstance(el, np.ndarray)` 认帧的，于是每一条 `Scan_FrameDataGrab` 轨迹录下的都是
「不可测」，一个真机上不成立的形状。已改成 ndarray 并重新导出。第一反应是改 TS 的判据
去迁就，那等于把一个夹具瑕疵固化成规格。

## D-SCAN-2 · 轮询自己那道中止检查不移植

| | |
|---|---|
| **Python** | `_phase_poll` 开头再查一次 `check_abort`，中了就自己发停扫并返回 `success=False` |
| **我们** | 不写。中止一律由执行器的步前检查拦下 |
| **测试** | `composite/wait-scan-complete.test.ts` → `D-SCAN-2 · 中止只有一个说法` |

**为什么有意**：两件事。

其一，**在本仓它不可达**：执行器同步查完 `checkAbort()` 就调分发器，中间没有 `await`，
所以第二道检查永远和第一道同答案。

其二，它唯一可观测的作用是**让 `abort_facts` 自相矛盾**。金样 `abort_inside_poll`
那一格：`outcome: "aborted"`、`error: "aborted by user"`，而同一份 data 里
`aborted: false, aborted_by_operator: false` —— 因为那条路只写 `partial_data["aborted"]`，
没碰 `progress.aborted`。下游按 `abort_facts` 判「是不是有人喊停」会得到「没有」。
那正是 #46 那一族（判据与事实对不上）的翻版，而 `abort_facts` 本来就是为了修 #46 才
存在的。去掉之后所有中止都走执行器，`abort_facts` 只有一个答案。

**连带**：旧仓 `run_composite` 起手 `set_partial_default("aborted", False)`，而唯一的
写入方就是那条分支。去掉之后这个键恒为 false，按消融的纪律一并删掉；轨迹金样里那 9 条
登记在 `l0/traces.test.ts` 的 `absent` 里（测试会先断言金样里确实有它，差异消失时那条
登记会当场变红）。

## D-SCAN-3 · `WaitScanComplete` 不接断点

| | |
|---|---|
| **Python** | 走 `GraphExecutor` 的 sidecar，`WaitScanComplete__<run_id>.json` |
| **我们** | 不传 `store` |

**为什么有意**：dsh 的一次工具调用不跨进程续跑，而「续跑一次等待」本来也没有意义
（重新等就是了）。接一个永远不会被读的断点，只会让人以为这里有续跑语义。

断点的**判据**（什么时候读、写、丢）仍然全部留在 `graph-executor.ts` 里，介质在
`stm-skills/src/sidecar.ts`——批 5 的组合技能要用。

## ~~D-APPROACH-1 · 进针参数组的切换与放回不移植~~ → **已销账**（2026-09-13）

切换与放回都在 `stm-skills/src/composite/approach-preset.ts`
（`applyApproachPreset` / `restoreZctrl`），`AutoApproach` 与 `ApproachTip` 各套一层。
金样里那三个 `zctrl_preset*` 字段现在**两侧逐字相同**，`traces.test.ts` 里的 `absent`
登记已经删掉——它本来就是按「旧仓哪天把它修了这里会变红」的方式写的，只不过这次
变红的原因是**我们补上了**。

**那笔真正的债是 `finally`，它已经还了**：缺陷⑫ 的判据是「这个状态是不是我改的」。
放回去这件事在 `finally` 里，**中止时更要做**——与「中止不动手」（缺陷⑪）刻意相反。
两者不矛盾：⑪ 说的是不要在中止时**发起**新动作，⑫ 说的是把**自己造成的**改动撤掉。

唯一的例外照移了：**软停时不还设定点**（缺陷⑬ 要求四）。改增益只是改反馈环的响应，
不命令任何位移；而改设定点会让 Z 环把针尖挪到新的电流目标上——那是一次运动，
一个刚被叫停的流程不该以「归还」的名义再动一次针。于是软停后现场是
「增益=调用前、设定点=进针组的值」，这个**组合**要说出来，别让人以为一切都回去了。

**还留着的一处**：`applyApproachPreset` 走 `ctx.runSkill('GetZCtrlGain')` 读当前值，
与旧仓的 `ctx.run(...)` 同义；但本仓的进针参数**真源没接**（`approachProfile`
默认不给），所以默认实例上这一路永远走「档案没配 ⇒ 如实跳过」。接线在宿主侧，
`makeAutoApproach({ presets })` / `makeApproachTip({ presets })` 收它。

## D-APPROACH-2 · 串扰报告不移植

| | |
|---|---|
| **Python** | `_maybe_report_crosstalk` 每 15 s 读一次 lock-in X，往 partial 里放一句「≈还剩多少步」 |
| **我们** | 不写 |
| **影响面** | `_progress.partial_data.crosstalk` 一格 |

**为什么有意**：它**不驱动任何决策**（旧仓自己的注释：「永不抛异常，永不改变等待逻辑
—— 它只是往 partial 里放一句话」），而 lock-in 链路本仓还没有。

顺带一个观测：金样里那一格记的是
「调制读不到 —— 不读 X，也就不翻译……进针/退针流程**开跑前会自动关调制**，
所以默认情况下这条报告在这些流程里永远是这一句」。也就是说**在旧仓的默认配置下它也
不产出信息**。

## D-APPROACH-3 · dI/dV 标定窗与 qPlus 旁证不移植

| | |
|---|---|
| **Python** | `ApproachTip` 进针成功后短开 lock-in 调制读一次 dI/dV 记进标定库（`_didv_calibration_window`），并附上 qPlus 振幅与 dI/dV 趋势（`_approach_evidence` / `_evidence_warning`） |
| **我们** | 不写 |

**为什么有意**：两条都要 lock-in / qPlus 链路，本仓还没有。

**⚠️ qPlus 那一条是有代价的，不是可有可无的装饰。** 它回答的是电流**回答不了**的
问题——「针尖还自由吗」。一根已经犁进表面的针被阻尼到不动，正好是纯电流判据读成
「健康地停在设定点」的那个状态。旧仓自己的注释写着：两者矛盾时**以更悲观的为准**
（先退针复查，不要直接扫图）。补 lock-in 链路时必须连它一起补。

## D-KERNEL-1 · `ctx.runSkill` 不重写第二份闸门清单

| | |
|---|---|
| **Python** | `ExecutionContext.run` 手写了一整套子步闸门：中止闸、注册表、样品闸、运行模式、数值边界、`validate_params`、`check_preconditions` |
| **我们** | 子步**再进一次内核**（`深度 + 1`），K1–K18 逐条自动成立 |

**为什么有意**：那份手写清单必须和主路那份保持一致，而保持一致靠的是有人记得两边
一起改。再进一次内核之后，owner / rootCallId / approvalSource 一路继承（记录链不断），
而 K3 样品闸只在 `depth === 0` 判——与旧仓的 `_scope_admitted` 同义。

**新增的东西**：{@link MAX_COMPOSITION_DEPTH}。旧仓没有这条，因为它的 `run` 不会被
一个自己调自己的技能拖进无限递归（注册表按名字取，而组合层级是人工声明的）。本仓
有了 `runSkill` 这条路之后，一个环就能把进程转死，**而那时仪器还握在手里**。
表达成一次拒绝，于是它进记录、进报文，查得到。

## D-SCAN-4 · 扫描进度视觉监视器不移植

| | |
|---|---|
| **Python** | `StartScan` 起扫后拉起守护线程，在 12.5 %…100 % 抓部分帧、跑 M12、往缓冲发中文旁白；`data.vision_monitor` 记它起没起来 |
| **我们** | 不写 |
| **影响面** | 6 条轨迹的一个字段 |

**为什么有意**：视觉链路本仓还没有。它**完全 fail-safe**（没缓冲/没视觉就空转）、
而且在图之外（自己的线程），所以它不可能弄坏扫描——这是这一族里最容易补、也最不急的
一个。

## D-SCAN-5 · `before=None` → `before=null`

| | |
|---|---|
| **Python** | continuous 闸的报文里印 `(读回的 GET 值:before=None, …)` |
| **我们** | `before=null` |
| **影响面** | 一句话里的一个词；只在**读不到**那一趟出现 |

**为什么有意**：那是一个「读不到」的记号，而 Python 印 `None`、JS 印 `null`。为了逐字
去伪造一个 Python 字面量，等于让诊断指向一个不存在的语言（同 D-SKILL-2 的理由）。

**登记方式**：期望值在测试里**从金样算出来**（一个 `.replace`），不是抄一遍——差异
看得见，而旧仓哪天改了那句话，这里会跟着变，不会悄悄过期。而且只登记**真的**含
`before=None` 的那几趟：读得到值的那几趟两边一字不差，给它们挂一条「偏差」等于登记
一条不存在的差异。

## D-FRAME-1 · 候选保存目录只留一个来源

| | |
|---|---|
| **Python** | `_candidate_save_dirs` 攒四路：① `Util_SessionPathGet` 报的会话目录 ② `scan_registry.known_scan_dirs()`（`SaveScan` 落盘时登记过的）③ `<data>/working-sessions/` ④ 当前样品的 `raw/nanonis/`（原位模式） |
| **我们** | **只留 ①** |
| **影响面** | `GetLatestScanFile` 的 `searched_dirs`；金样那三趟里它是 `[]`，两侧一致 |

**为什么有意**，逐路：

- **②** 是给**没有 context 的调用方**用的（旧仓 data_processing 的文件工具
  `context=None`、没有连接池，只能靠登记表反查目录）。本仓没有那条调用路径——
  每个技能都拿着 `ctx`，会话目录直接问仪器就是。
- **③** 的 `project_root()` 是旧仓的**数据根**（`MAST2_PROJECT_ROOT`），而本仓
  **还没有「数据目录」这个概念**。第一版我把它映射成了 `process.cwd()`——那是我编的：
  本仓没有任何东西会去创建 `<cwd>/working-sessions/`，于是它是一个**永远为空的候选**，
  只会让 `searched_dirs` 长出一行没发生过的搜索（正是 D-FRAME-2 那条纪律要防的），
  外加给轨迹金样引进一个跟工作目录有关的变量。删掉。
- **④** 依赖实验日志与「当前活跃样品」，两者本仓都还没有。

**⚠️ 这一条让模型面的描述超发了。** `GetLatestScanFile` 的 description 是**逐字冻结**的
（DoD ②），而它写着「再查数据目录下的 working-sessions/，最后查历史遗留的开发目录」。
我们现在只查第一路。**不改那句话**——改了它就跟旧仓对不上，而 `searched_dirs` 本来就
把「实际找过哪儿」如实交出去了，调用方读得到真相。接上数据根的时候这条要回来删。

**没有一起省掉的是 ①**：会话目录**问仪器**，不从属性里读。旧仓原先只读一个从来没人写过的
属性，于是存在 working-sessions 之外的图一律找不到（2026-06-29：报 `path: null`，而文件
就在那儿）。这条修补是本技能存在的理由之一，照移。

**照移的还有那条注释里的纪律**：④ 只加一个目录，**绝不**加整个实验根——`findLatestSaved`
是递归的，把实验根塞进来会让它每次翻遍所有历史副本，而且极可能把某个历史副本当成
「刚存的那一个」。这条在补 ④ 的时候必须一起补。

## D-FRAME-2 · `searched_dirs` 报的是**真目录的绝对路径**

| | |
|---|---|
| **Python** | `[str(c) for c in cands]`，`cands` 已经过 `resolve()` + `is_dir()` 过滤 |
| **我们** | 同样过滤，用 `realpathSync`；差别只在 Windows 上 `realpath` 会还原盘符与短名 |
| **测试** | `l0/frames-skills.test.ts` → `existingDirs`、`searched_dirs 只列真找过的目录` |

**为什么登记**：这不是一条「少做了什么」，是一条**平台差异**。两侧都拒绝把不存在的目录
列进去（把它列进去等于报告一次没发生过的搜索），但同一个目录在两侧印出来的字符串可能不同。
金样那三趟里它是空表，所以看不出来——**看不出来正是要写下来的理由**。

## ~~D-PRESET-1 · 只移植自定义组的来历行，不移植 `resolve`~~ → **已销账**（2026-09-13）

`resolve` 的四路现在全在 `kernel/src/zctrl-preset.ts` 的 `resolvePreset`，由
`spec/golden/zctrl_presets.json` 的 15 格钉住（含每一路拒绝报文的逐字）。
`presetTraceLines` 这个只为自定义组存在的临时件已经删掉——`ResolvedPreset.traceLines()`
是唯一的一份。

留下这条销账记录而不是把它整条删掉，是因为**当时那个判断没错**：写一个没有调用方的
分支，它的报文就是一句无人核对的指路牌。差别只在于现在有调用方了
（`ApplyZCtrlPreset` / `ListZCtrlPresets` / 进针前的切换）。

**唯一真正的偏差留在这里**：旧仓的 `resolve(name, context=...)` 在内核里发
`Scan_FrameGet` 去问当前帧宽；本仓的 `resolvePreset` 是**纯函数**，帧宽由技能层
读好当**值**传进来（`PresetSources.frameSizeM`，读不到给 `null`）。判据进内核、
动作留外面，于是 `scan` 那一路的每一支都测得动，而「读不到帧宽」有了一个明确的值
而不是一次异常。

**顺带一个事实，留着**：出厂档位表里 `p_gain` / `time_constant_s` **全是 `None`**
（旧仓也是），所以 `resolve(档名)` 在出厂配置下**恒拒**。能拿到增益的只有操作员
编辑过的档。那不是「还没接线」，是**没配就该拒**——一台仪器的 Z 增益不可能有出厂
默认值。`ScanTier` 上那三个可选字段就是给操作员表留的位置，出厂表一个都不填。

## D-PRESET-2 · 参数组存储在**进程里**，落盘由宿主接

| | |
|---|---|
| **Python** | 模块级 `_presets` + `_persist_sink`，`set_persist_sink` 由 SettingsStore 装 |
| **我们** | `PresetStore` 实例；`processPresetStore` 是给技能默认实例用的那一份，`persist` 由构造参数注入 |
| **测试** | `kernel/src/frames-presets.test.ts`（6 格存储金样）+ 技能层的同名/覆盖/上限三格 |

**为什么有意**：模块级可变状态在测试里要靠 `_presets.clear()` 手动收拾（旧仓的导出脚本
每一格开头都得清一次），而**忘了清的那一次不会报错，只会让下一格读到上一格的残留**。
本仓的导出脚本已经因为同一类问题错了三次（组合技能的断点串在一起）。

**没有跟着变的是那条纪律**：落盘失败**只记不抛**——内存里已经改好了，把一次成功的写入
报成失败比报出去更坏。`PresetStore.#flush` 里那个空 `catch` 就是它。

## D-PRESET-3 · `ThreadingRLock` 不移植

| | |
|---|---|
| **Python** | `_lock = threading.RLock()`，`upsert` / `delete` 全程持锁 |
| **我们** | 没有锁 |

**为什么有意**：Node 是单线程的，而 `PresetStore` 的每个方法都是**同步**的——它们之间
没有 `await`，所以不存在另一个任务插进来的那一刻。加一把在这门语言里永远不会争用的锁，
只会让读代码的人以为这里有并发。

**边界写清楚**：这条成立的**前提**是那些方法保持同步。哪天 `persist` 变成 `await`，
`#flush` 之后的状态就有人能看见了——那时要重新想，不是加锁，是想清楚「一次半完成的
写入被别人读到」意味着什么。

## D-READBACK-1 · 回读比对的容差**是判据，不是宽容**

| | |
|---|---|
| **Python** | `values_match(requested, actual, rel_tol=1e-3)`，`math.isclose(..., abs_tol=0.0)` |
| **我们** | `kernel/src/readback.ts` 的 `valuesMatch`，同一个数、同一套语义 |
| **测试** | `kernel/src/readback.test.ts`（11 格）+ `stm-skills/integration/readback.test.ts`（对真 stmsim） |

**这条不是「有意不同」，是一条差点漏掉的移植**，登记在这里因为它的发现方式值得留着。

第一版我把 `SetSetpoint` / `SetZCtrlGain` 的回读比对写成了**精确相等**。结果：

- 轨迹金样**全绿**（`mismatch` 那一趟给的是一个明显不同的数，精确与近似都判不符）；
- 手写的技能网格**全绿**（回包是我摆的，写什么读什么）；
- 而真机上**每一次**写增益都会失败。

Nanonis 在 TCP 上按 **float32** 打包，`3e-12` 回来是 `2.9999999880125916e-12`。
2026-09-13 第一次把这两个技能接上真 stmsim，报文是：

> 写后回读不一致 …… p_gain: 请求 3e-12, 读回 2.9999999880125916e-12(**相差 1 倍**)
> ……已还原为写入前的值。**不要进针、不要扫图**

「相差 1 倍」——那句话自己就说清了它在拒绝什么：**什么都没差**。

**为什么两套金样都照不出来**：它们的回包都由我决定。合成器精确回显，手写脚本也精确
回显。一个「在两套自己造的回包上都对」的解析器，仍然可以在真东西上一次都对不上——
这就是 DoD ④ 要那条 stmsim 缝的全部理由。

**容差的两端都要说清**：`1e-3` 在 float32 往返噪声（实测 ~4e-9）之上六个数量级，
同时照样抓得住任何真的损坏——这里要防的失败是**差 1e12 倍**（2026-08-03 那次
`3` 与 `3e-12`），不是差 0.1 %。两端各有一格测试钉着。

**顺带修掉的第二处**：不符且**还原失败**时，我这边原先什么都不说，而旧仓说
「无法还原为写入前的值。」。现在一致。

## D-SKILL-1 补充 · 空 body 上的信封（批 3c 的十一格）

| | |
|---|---|
| **Python** | 空 body 时 `decode_reply` / `_rv` 把**整个回包信封** `["", "<bytes 0>", []]` 当读数交出去 |
| **我们** | 信封在 wire 层就拆掉了，手上只有 body（`[]`） |
| **影响面** | 11 条 `empty@0`：4 个单动词读的 `raw`、6 个聚合读的那一格、`GetRTOversample` 的 `0` |
| **测试** | `l0/traces.test.ts` 的 `withoutEnvelope(...)` —— **期望值从金样算出来**，不是抄一遍 |

这是 D-SKILL-1 在批 3c 上的又一批，机制与最早那 16 格完全一样，单列是因为**算法不同**：
早先那批是逐格写死期望值；这一批用一条递归替换（把深相等于信封的值换成 `[]`）从金样
导出来。差异因此只有那一条替换看得见，而旧仓哪天改了回包解码，这里会跟着变。

**两条值得单说的**：

- `GetTipShaperConfig/empty@0` 的具名报文里印着**数到了几个值**：旧仓数的是信封的
  三段（「本机返回 3 个值」），我们数的是空 body 的 0 个。期望值同样是算出来的
  （一条 `.replace`），不是抄的。
- `GetRTOversample/empty@0` 旧仓把解不出的信封**折成了 `0`**。本仓答 `null`——
  「读不到」不是「零」。这一格我们比旧仓对，而它照样要登记：**未登记的差异 = 缺陷**。

## D-JSON-1 · `json.loads` 的报错位置写死在第 1 列

| | |
|---|---|
| **Python** | `json.JSONDecodeError` 带真实的行列，如 `Expecting value: line 3 column 7 (char 42)` |
| **我们** | 恒为 `Expecting value: line 1 column 1 (char 0)` |
| **影响面** | `SetPiezoHysteresisValues` 参数解析失败那一句 |
| **测试** | 金样 `SetPiezoHysteresisValues/bad_json` 逐字 |

**为什么有意**：`JSON.parse` 抛的是另一套英文（`Unexpected token …`），而这句话是模型读的，
所以不能直接透传。要逐字复刻 CPython 的行列，等于**为了一句诊断再写一个 JSON 解析器**。

而模型需要的信息是「这个参数不是 JSON」——那一句已经说到了。位置对模型改这次调用
没有帮助：它手上就是那个字符串，重写一遍比按列号去数更快。

**边界**：哪天这个参数变成「模型会写很长的 JSON」的那一类，位置就重新有价值了，
那时该做的不是抄位置，是把参数拆细。

## D-SKILL-1 补充二 · 锁相解调侧六个读的 `raw` 兜底（批 3d）

| | |
|---|---|
| **Python** | 解不出来时 `data = {demodulator, raw: decode_reply(parsed)}`，而空 body 上 `decode_reply` 交出整个信封 |
| **我们** | 同样走 `raw` 兜底，只是 `raw` 里是 body（`[]`） |
| **影响面** | `GetDemodSignal` / `GetDemodPhase` / `GetDemodPhasReg` / `GetDemodHarmonic` / `GetDemodLPFilter` / `GetDemodHPFilter` 各一条 `empty@0` |
| **测试** | 与批 3c 同一个 `withoutEnvelope(...)`，期望值从金样算出来 |

**`raw` 兜底这件事本身是对的，照移了**：解不出来时交出原始 body，与「我看懂了，它是空的」
是两回事——后者会被当成一个读数。这一条差的只是 `raw` 里装的是信封还是 body。

## D-LOCKIN-1 · 调制侧 phase **永不下发**，而这条判据落在调用序列上

| | |
|---|---|
| **Python** | `lockin_presets` 的 `_PROFILE_KEYS` 里**没有** phase；`ApplyLockInPreset` 里有一句 `assert "phase_deg" not in call_params` |
| **我们** | `ConfigureLockIn` **仍然支持** `phase_deg` 参数（给了就写），与旧仓一致 |
| **测试** | 金样 `ConfigureLockIn/with_values` 里 `LockIn_ModPhasSet` 确实发了 |

**这不是一条偏差，是一条要写下来免得将来被"优化"掉的事实**：

旧仓 2026-08-05 真机实测（全分辨率截图 + TCP）三条硬事实——

1. 被拒的**只有** `lockin.modphasset` 一条命令（解调侧 phase 写得进、频率与幅度都写得进
   ⇒ 不是家族锁也不是模块锁）；
2. Lock-In 面板的 **Modulate 区根本没有 phase 字段**。「Parameter is Locked」不是谁锁了
   一个标定量，是**该参数在本机配置下不存在于操作面、固件恒拒写**；
3. **写同值也被拒** —— 拒绝由写入动作本身触发，与值无关。

⇒ 挑不出「更好的相位值」来绕过它；唯一有用的动作是**这条命令根本不出现在调用序列里**。
所以 `lockin_presets` 那一组永不下发它，而 `ConfigureLockIn` 这个**逐字段技能**保留它——
两者不矛盾：参数组是「代替用户做决定」，技能是「用户明确要求」。

**补 `ApplyLockInPreset` 的时候这一条必须一起补**（那个 `assert` 就是它的执法者），
而且判据要落在**调用序列**上，不落在参数值上。

## D-CHANNELS-1 · 两处通道解析**刻意不同**

| | |
|---|---|
| `crash-check.ts` 的 `parseChannels` | 认不出的记号**跳过**，全不认就回落到默认 `0,14` |
| `datalog-marks.ts` 的 `logChannels` | 有一个记号不是整数，**整串作废**（`null` ⇒ 拒绝） |

两边都逐字照移了旧仓，而**把它们统一成一个函数是错的**：

- 撞针检测少探一路无所谓——剩下那几路照样回答得了「撞没撞」，而一个错字让整次检测
  不做，代价大得多；
- 数据记录记的是**哪几路**。默默丢掉一路，会让日志里少一个通道**而没人知道**，
  几小时之后才在数据里发现。

登记它，是因为「两个看起来一样的函数行为不一样」正是将来有人做重构时最想合并的东西。

## D-LOCKIN-2 · 调制参数**没有出厂默认**

| | |
|---|---|
| **Python** | `lockin_mod_freq_hz` / `lockin_mod_amp_v` 在 `instrument_profile._CONFIG_SPEC` 里带出厂默认 `973.0` / `0.02`，而 `sanitize()` 又把空值**丢掉** ⇒ `get_config` 永远给得出数 |
| **TS** | `LockInProfile` 全是 `number \| null`，**没接 = 没填**；一个键都没填时 `usable: false`，`ApplyLockInPreset` 拒绝并说去哪儿填 |
| **测试** | `packages/host/kernel/src/lockin-preset.test.ts`；`packages/host/stm-skills/src/l0/lockin-presets.test.ts` → `D-LOCKIN-2 · 本仓不带出厂默认` |

**旧仓那两句话互相矛盾，而矛盾的那一方赢了。** 模块 docstring 写着「档案没填的键**不下发**，
不是补一个默认值下去」，`why()` 写着「这组数只由用户输入，不经模型」——而存储层让「没填」
根本不可能发生：`sanitize()` 丢掉 `None` / `""`，于是那两个键永远在 `_CONFIG_SPEC` 的默认值上。

⇒ `ResolvedLockInPreset.usable` 恒为 `True`，`why()` 的否定支与 `ApplyLockInPreset` 的
`if not preset.usable` 都是**死代码**。

**这不是纸面问题。** `export_lockin_presets.py` 本来要录「一个键都没配 ⇒ 拒绝」那一格，
结果**录不到**：`set_profile({})` 之后返回里照旧带着 973 / 0.02，而 `sources` 说它们来自
「仪器档案 lockin_mod_amp_v」——读的人会当成用户填的。那一格于是留在金样里，
名字就叫 `profile_cleared_still_has_factory_defaults`，它录到的是这件事本身。

**为什么本仓反过来**：0.02 V 的调制是一次**真实的物理动作**，加在谁也没确认过的隧道结上。
这与 `zctrl-preset.ts` 的 `fromProfile` 拒绝编造进针增益是同一条理由，那里写着——

> **读不到就拒**，绝不拿一组「常见值」顶上：编一个出来会以本机标定的名义跑一次真实的进针。

金样那一格的前提（「档案已填」）本来藏在出厂表里，现在**写出来**了：轨迹重放侧的
`LOCKIN_FIXTURE` 与专用金样的 `profile_fixture` 都摆着同一份 973 / 0.02。

## D-ZERO-1 · `x or default` 把一个**合法的 0** 吃掉

| 哪一处 | 旧仓 | 后果 |
|---|---|---|
| `spectrum_analyzer.fft_window` | `int(params.get(k, 1) or 1)` | **矩形窗（0）一次也下发不出去** —— 而描述里明写着「0 = 矩形窗」 |
| `spectrum_analyzer.averaging_mode` | 同上 | **不平均（0）选不出来** |
| `bias_sweep.sweep_direction` | `int(params.get(k, 1) or 1)` | **「上限→下限」一次也选不出来** |
| `bias_pulse.z_hold` | 本仓的 `i()` 早期版本 | `0 = 不变` 被顶成 `1 = 保持` |
| `optional_sweepers.num_sweeps` | `int(params.get(k, 1) or 1)` | **「一直扫到被停止」整个模式选不出来** —— 见 D-INFINITE-1，那一处丢的不是档位是**模式** |

**TS**：这四处都改成「给了就用，`0` 也算给了」。而**步数 / 周期**那两处保持原样——
它们的 `min` 是 2 与 1，`0` 本来就不合法，把它顶成缺省是对的。

**测试**：`packages/host/stm-skills/src/l0/tail-l0e.test.ts` → `D-ZERO-1` 那几格。

**这是同一个形状第二次出现。** 批 3d 的 `ConfigureLockIn` 里那条「幅度 0 要写得下去」是第一次：
`amplitude_v = 0` 是「开之前先把它变安全」，而旧仓的 `> 0` 守卫让这件事做不到。

判据：**`0` 什么时候是「没给」，取决于 `0` 在那个参数上是不是一个合法值**——
不取决于写起来方不方便。症状则一律是同一种：「我选了矩形窗，而谱看起来像加了窗」，
图上看不出任何错。

## D-BIASSWP-1 · `BiasSwp_PropsSet` 的**第五个实参不存在**

| | |
|---|---|
| **Python** | `safe_call("BiasSwp_PropsSet", steps, period, autosave, 0, period)` —— **五个**，注释写着第五个是 `Settling_ms` |
| **协议表 / `nanonis_spm`** | `BiasSwp.PropsSet(Number_of_steps, Period_ms, Autosave, Save_dialog_box)` —— **四个**，没有 `Settling_ms` |
| **TS** | 只发四个 |
| **测试** | `traces.test.ts` 的 `withoutPhantomArg`（期望值从金样算出来，旧仓哪天删了它这里就变红）；`tail-l0e.test.ts` → `只发四个实参` |

**真机上那是一次 `TypeError`**，被 `safe_call` 的 `except Exception` 兜成 `record.error`
⇒ `RunBiasSweep` 每一次都停在第三步。**这个技能一次也没在真硬件上成功过。**

**金样照不出它**：假 context 不检查实参个数，于是那一格录下的是一次漂亮的成功。
照出它的是**协议表**——而那张表也正是本仓生成整个 Nanonis 门面的同一份源。

**注释是这个 bug 的来源**：有人写下了一个五参数的签名（多半是从谱模块那边抄的，那里确实有
安定时间），然后照着自己的注释写了代码。

**为什么不照抄五个**：本仓的编码层按协议表的 `args` 逐位取参，多出来的那个会被**静默丢掉**
⇒ 代码仍然声称设了一个安定时间，而什么都没设。那比报错更坏。

## D-HYPOT-1 · 两种语言的 `hypot` 不是同一个函数

| | |
|---|---|
| **Python** | `math.hypot(1e-15, 1e-15)` → `1.414213562373095e-15` |
| **TS** | `Math.hypot(1e-15, 1e-15)` → `1.4142135623730953e-15`（差 1 ULP） |
| **测试** | `packages/host/stm-skills/src/l0/lockin-presets.test.ts` → `D-HYPOT-1 的差异**只在证据里**` |

两边各有自己的缩放与补偿。换成 `sqrt(x² + y²)` 不解决问题：那一格反而对上了，
`hypot(0.7, 0.2)` 又对不上，而且它在 `1e-200` 上直接**下溢成 0**。

**为什么可以登记而不是复刻**：`r` 进的是 `AutoPhase` 的**证据**字段；判据是它与 `1e-12`
的比较，而模型读到的是 `formatG(r, 3)` —— 最后一位在这两处都表示不出来。
金样比对里 `r` 单独按「相对差 ≤ 1e-15」比，**其余字段照旧逐字深比**。

## D-OSCI-1 · 解码失败的文案不复刻 Python 的异常 repr

| | |
|---|---|
| **Python** | `f"Decode error: {exc}"` / `f"Unexpected TimebaseGet shape: {rec.return_value!r}"` —— 印的是 Python 异常与**整个三段信封**的 repr |
| **TS** | `Decode error: 回包的四个字段里有解不开的 —— t0=…, dt=…, n=…, samples=…`；形状那句印 body 的 JSON |
| **测试** | `packages/host/stm-skills/src/l0/tail-l0e.test.ts` → `解不开就说解不开` |

同 D-SKILL-2 的理由：信封在本仓的 wire 层就拆掉了，手上只有 body ——
**印我们真有的东西**。而且模型要的可执行信息是「**哪一个**字段解不开」，
一句 `float() argument must be...` 说不到那儿。

`Unexpected response shape: {n} fields` 那一句**逐字保留**（它印的是字段数，两侧一样）。

## D-SKILL-1 补充三 · 最赤裸的一次：`str(整个信封)` 当成示波器数据

| | |
|---|---|
| **Python** | `PLLSignalAnalyzer` 写的是 `data["osci_data"] = str(rec.return_value)` ⇒ 模型收到的是字符串 `"('', b'', [0.25, 0.5, 5, 1.0])"` |
| **TS** | `osci_data` 是 body 本身（`[0.25, 0.5, 5, 1.0]`） |
| **测试** | `traces.test.ts` 的 `withoutStrEnvelope`（期望值**从金样那串字符串里把 body 抠出来**，不是抄一遍） |

这一族此前的形态都是「形状判据不成立时把信封当读数交出去」——**这一处连判据都没有**，
直接 `str()`。里面那段 `b''` 在真机上是几千字节的原始回包，而 2026-08-14 的
「四个技能直接 500」正是它把 HTTP 层的序列化撑炸的。

同一批里还有一小族同形状的（空 body 上旧仓交出整个信封）：PLL 五个读的 `raw`、
`HomeZController` 的 `home_props`、`SetSafeTipProps` 的 `before`。逐格登记在
`traces.test.ts` 的 `DEVIATIONS` 里。

## D-SKILL-3 补充 · PLL 的读在空 body 上**抛异常**，本仓给一个值

| | |
|---|---|
| **Python** | `int(v[0])` 直接对空 body 取下标 ⇒ `IndexError`。金样里十格记着 `raised`（`GetPLLStatus` / `GetPLLAddOnOff` / `GetPLLAmpCtrlOnOff` / `GetPLLDemodFilter` / `GetPLLDemodHarmonic` / `GetPLLExcRange` / `GetPLLFreqRange` / `GetPLLInpCalibr` / `GetPLLPhasCtrlOnOff` / `GetPLLSignalAnlzrCh`） |
| **TS** | 技能 `success`，`raw` 给 `[]`，**解不出的那个字段不写这个键** |
| **测试** | `packages/host/stm-skills/src/l0/tail-l0f.test.ts` → `PLL 的读：空 body 给一个值，不抛` |

与 `GetSafeTipStatus` 那一格（D-SKILL-3 本体）同一条理由：**一个只读技能以一句
看不懂的异常失败，和「没问出来」是两件事**。前者会让调用方以为工具坏了；
后者是一个可以据以决策的答案。

「不写这个键」而不是「写一个 `null`」：这一族的键是**开关状态**
（`add_on` / `amp_ctrl_on` / …），而 `null` 在 JSON 里读起来太容易被当成「关着」。
缺键是没有歧义的。

## D-DIAG-1 · `diagnostics.record` → `ctx.markers.emit`

| | |
|---|---|
| **Python** | `mast.core.diagnostics.record(kind, subject, reason, **fields)`：进程内一个环形表 + 落一行 JSONL 到磁盘 |
| **TS** | `ctx.markers.emit(kind, {subject, reason, ...fields})`——**内核自己的留痕通道**（`skill_ok` / `skill_failed` / `skill_crashed` 走的也是它） |
| **测试** | `tail-l0f.test.ts` → `拒绝要留痕`、`SetZLimits —— 放宽合法，但要留痕` |

`kind`（`safety_block` / `note`）与字段名逐字照搬，于是两边的台账**读起来是同一种东西**。
落盘由宿主接——同 D-PRESET-2（参数组存储在进程里，落盘由宿主接）那条：
一个技能不该自己决定往哪个目录写文件。

**批 3h / 3i 又添了八处用例**（`user_output` 的限值放宽留痕、`advanced_ops` 的
「停扫失败不拦着退针，只留一条痕」、qPlus 基线落盘…）。这条至此覆盖本仓全部
「该留下证据」的位置。

**为什么必须有**：脚本那一族的留痕不是日志，是**证据**。本仓看不见脚本内部
（它跑在 RT 控制器上），所以「哪个槽位、哪份配方、用的哪串 LUT」这条记录
是事后唯一能拿到的东西。金样只录返回值，录不到它 —— 所以它由技能级测试单独钉。

## D-PLL-1 · `f₀` / `Q` **不写回仪器档案**

| | |
|---|---|
| **Python** | `AcquirePLLFreqSweep` 扫完把 `resonance_freq_hz` / `q_factor` 写进 `instrument_profile` 的实测槽位（2026-07-31 加的，理由是「不然想知道当前音叉的 f₀/Q 就得重扫一次」） |
| **TS** | 只放进返回值 |
| **测试** | 轨迹金样（`AcquirePLLFreqSweep/ok` 两侧 `data` 一致；那次写回本来就不进 `data`） |

本仓还没有那份**可写**的档案存储（`processLockInProfile` 是只读接线）。
而**写一个没有读者的值**只会让下一个人以为有人在用它 —— 与消融那条纪律同义：
说不清现在承担什么就不写。

接上去的条件很明确：等有一个技能真的要问「当前这支音叉的 Q 是多少」的时候。
到那时这条要销账。

## D-INFINITE-1 · 两个「无限」旋钮，两个**相反**的决定

| | |
|---|---|
| `HSSwp.num_sweeps = 0` | 声明里逐字写着「**0 = 一直连续扫到被停止为止**」，`min_value = 0`，代码里 `1 if n == 0 else 0` 那一支也写好了 —— 而 `int(params.get(k, 1) or 1)` 让 `n` **永远不是 0**，那一支是**死分支** |
| `APRFGen.Infinite` | 旧仓**永远写 0**，注释写死了「an agent must never start an unbounded RF sweep」 |

**TS**：前者放行 `0`（无限标志真的翻得起来），后者照旧焊死 `0`。
**测试**：`optional-modules.test.ts` → `num_sweeps = 0 是「一直扫」，不是「扫一次」`；
`traces.test.ts` 的 `ConfigureHighSpeedSweep/infinite`（期望值从金样算出来）。

**分辨这两个的唯一办法是问：停得下来吗。**

- `StopHighSpeedSweep` 存在，而且 `HSSwp_Stop` 在**中止后的放行清单里** ⇒ 一次无限扫描
  随时叫得停 ⇒ 敢让 `0` 过去。**停得下来，才敢让它无限**——这是那个决定的前提，
  不是补充说明。
- RF 那边即使停得下来，**已经灌进隧道结里的功率停不回来**。

⚠️ 登记它是因为**它们看起来是同一个旋钮**：同一份代码里两个叫 "Infinite" 的位、
同样的 0/1、同样的「要不要一直跑下去」。一个是缺陷，一个是纪律。
下一个做重构的人最想做的事正是把它们统一——与 D-CHANNELS-1 同一条理由。

## D-SKILL-1 补充四 · 空 body 上的信封又 **34 格**（批 3g / 3h / 3i）

旧仓这三批全走 `_multi_read` / 逐格 `_rv`，于是空 body 上把整个三段信封
`["", "<bytes 0>", []]` 当成那一格的读数交出去。本仓信封在 wire 层就没了，手上只有 `[]`。

逐格登记在 `traces.test.ts` 的 `DEVIATIONS` 里（用现成的 `withoutEnvelope`，
**期望值从金样算出来，不是抄一遍**）：

- **批 3g（21 格）**：`GetPiController` `GetGenericPiController` `GetPreamp`
  `GetPllZoomFftData` `GetPllSignalAnalyzerData` `GetOcSync` `GetTipRecorderData`
  `GetKelvinController` `GetCpdCompensation` `GetInterferometer` `GetBeamDeflection`
  `GetLaser` `GetProbeZController` `GetProbeBias` `GetProbeCurrent`
  `GetHighSpeedSweepStatus` `GetRfGeneratorStatus` `GetHighResScopeData`
  `GetHighResScopeStatus` `RunHighSpeedSweep` `RunPllPhaseSweep`
- **批 3h（8 格）**：`GenSwpAcqChsGet` `GenSwpPropsGet` `GenSwpSwpSignalGet`
  `GetLockInSweepLimits` `GetLockInSweepProps` `GetPatternCloud` `GetPatternProps`
  `WaitForScanEndBlocking`
- **批 3i（5 格）**：见 `docs/handoff/batch-3i.md`

**这一族至此 60+ 格。** 它不是「旧仓某处写错了」，是**一个没有单一真源的解析动作
被手写了几十遍**——本仓自己也复现过一次（见 `common.ts` 的 `cell`）。

## D-PIEZO-1 · `checkPiezoRange` 这个名字在本仓有**两个**

| | |
|---|---|
| `configure-scan.ts` 的私有 `checkPiezoRange` | 「**这一帧**超不超压电半程」——输入是帧的中心/宽高/角度 |
| `piezo-reconcile.ts` / `CheckPiezoRange` 技能 | 「**配置里的限值**与仪器报的量程对不对得上」——输入是 `SafetyLimits.xy_max_m` 与 `Piezo_RangeGet` |

**测试**：`packages/host/kernel/src/piezo-reconcile.test.ts`（整份）。两者调用点互不相交。

**为什么有意**：与 **D-CHANNELS-1** 完全同一条理由——「两个看起来一样的东西，
正是将来有人重构时最想合并的东西」。合并的代价是：帧闸会开始拿**配置**的限值去判
一个**帧**，而那个配置正是 2026-08-16 事故里比实际大 23 % 的那个数。

**没有改名**（旧仓那个是私有的、只有一个调用点），只把差异登记下来。
上一次（D-CHANNELS-1）的教训是「行为不一样的两个函数最想被合并」；
这一次是它的**前一步**——**名字一样的两件事，连发现它们不一样都要先花一分钟。**

## D-QPLUS-1 · 振幅判据要**两条证据**，而基线住在进程里

| | |
|---|---|
| **Python** | 基线写进 `instrument_profile`；两个键必须在 `_CONFIG_SPEC` 里注册过，否则 `sanitize()` **静默丢掉**，读回来永远 `None`，撞针探测器**永久停在 `no_baseline`** |
| **TS** | `processQPlusBaseline`（显式对象，无 sanitize 过滤），落盘由宿主接；落盘失败**只记不抛**（同 D-PRESET-2） |
| **测试** | `tail-l0i.test.ts` → `取基线` / `落盘失败只记不抛` |

**缺陷⑰（真机实测）**：本机 STM 模式下 `excitation_on = 0` / `excitation_v = 0 V`，
而振幅通道上那 7–8 pm 是**未驱动解调器的噪声底**——拿它跟自由振荡基线比
**永远比出「塌了」**。所以判据要**两条证据**：开关开着**并且**幅度 > 0。

代价说清：PLL 读不回来的机器上这条判据**不可用**（四态里的 `unavailable`）。
收益是它不再永远误报。**后者是实测发生的，前者是假设的。**

## D-LIMITS-1 · 生效限值**由外面注入**，不读类默认值

| | |
|---|---|
| **Python** | `_get_effective_limits(SafetyLimits())` —— 配置 + 管理员覆写 + 仪器事实收紧 |
| **TS** | `deps.effectiveLimits?.()`，没接退回 `DEFAULT_SAFETY_LIMITS` |
| **测试** | `tail-l0i.test.ts` → `没接生效限值 ⇒ 退回出厂默认` |

旧仓那句话值得抄在这里：**直接读类默认值会绕过管理员覆写，于是报出来的数和实际
生效的数不是同一个——一个对账工具报错数字，比不对账更坏。**

本仓现在退回的正是出厂默认 `xy_max_m = 1.5e-6`，而**那就是 2026-08-16 事故里的那个数**；
宿主把生效限值接上之后这里自动跟着对。

## D-NUM-1 · 一个仓里只能有一个 `sum`，而它不是 numpy 的那个

| | |
|---|---|
| **numpy** | `np.sum` 用成对求和（pairwise） |
| **本仓** | `pySum`（CPython 3.12+ 的 Neumaier 补偿求和，`kernel/src/si.ts`） |
| **测试** | `numerics.test.ts` → `三种求和算法给三个答案` |

**不是选哪个更准的问题**：技能金样那一侧要的是 CPython 的答案（`AutoPhase` 的
`x_mean` 就卡在这一位上，2026-09-13）。**一个仓里只能有一个 `sum`**，
否则「均值」会随调用方而变。代价是数值层对 numpy 的比对必须带容差 ——
那条容差写明是 `8·eps·log₂N`（实测 N=2048 时相对差 `1.8e-16`，界 `2.4e-15`）。

## D-NUM-2 · scipy 与 numpy 把 `reflect` / `mirror` 这两个名字**拧着用**

| scipy 的名字 | 序列 | `numpy.pad` 管它叫 |
|---|---|---|
| `reflect` | `d c b a │ a b c d` —— 边界元素**重复** | `symmetric` |
| `mirror` | `d c b │ a b c d` —— 边界元素**不重复** | `reflect` |

**TS 按 scipy 的命名**（被移植的那一侧调的是 scipy）。五种模式各有金样。

认错了**不报错**，只让图像四条边各差一点——而扣背景、找台阶、算漂移
全都从边上开始受影响。

## D-NUM-3 · 相位互相关的**符号就是漂移方向**

`phaseCrossCorrelation(reference, moving)` 给的是**「把 moving 移动多少才能对上
reference」**，与 skimage 同：`moving = roll(reference, +d)` 时返回 `−d`。

一次参数写反或一次轴对调**不会报错**，只会让漂移补偿往**反方向**走，
而图看起来只是「漂得更快了」。金样用不对称的位移（3≠5、有零有负）逐格钉住，
另有一条测试断言 `shift(a,b) === −shift(b,a)`。

## D-NUM-4 · `.npy` 读：列优先**当场转回**，截断**抛而不补零**

- `fortran_order` **不往调用方传**：一个「记得自己是列优先」的数组，迟早会被某个
  忘了检查它的人按行优先读一遍，而**一张转置的扫描图在方形帧上看起来完全正常**。
- 截断的文件**抛**，不补零：补零之后图的下半截是一片平坦的「干净表面」——
  **那正是撞针检测要找的形状**。

## D-NUM-5 · `ssim` 的 `data_range` **没有缺省值**

skimage 不给就按 dtype 猜，而它对 float 图的猜测（`1.0`）在一张**以米为单位的
形貌图**上差九个数量级 —— C1/C2 两个稳定化常数完全失效，SSIM 退化成一个只反映噪声的数。
**本仓不给就抛。**

## D-NUM-6 · 默认值就是语义：邻接数与 bin 右边界

- **连通域的邻接数是语义**：同一张掩膜，4-邻接 5 个域、8-邻接 4 个。
  金样**两个都录**，于是「默认用哪个」不可能被含糊过去。标签按行优先首次出现编号（同 scipy）。
- **`histogram` 的最后一个 bin 右边界也闭**（同 numpy）：落在 `range[1]` 上的样本
  进最后一个 bin，不被丢掉。这一条在「最高的那个 bin 是哪个」上会翻结论——
  而那正是调用方要的答案。

## D-NUM-7 · RNG 求的是**可复现**，不是「与 numpy 相同」—— 而现在有两份

通用那一份是 xoshiro128\*\*，不是 PCG64。判据是同种子同串；金样里钉的是本仓自己
那一串，于是将来任何一次「顺手换个 RNG」都会当场变红。

### 2026-09-17 补：本仓现在**也有**一份逐位复现 numpy 的 PCG64

批 4b 的 `superstructure_test` 要 `np.random.default_rng` 抽的那几个对照波矢 ——
**那是一串要被比的答案，不是一串随便的数**。于是 `numerics/pcg64.ts` 把它实现了
（pool / state / raw / uniform 四层各比一遍）。`rng.ts` 抬头原来那句「复现它要实现
一个 128 位状态的 LCG」现在有了下文。

于是仓里有两个 RNG，而**判据不是「哪个更好」，是「对面有没有一个被比的答案」**：

| | 用在哪 | 追不追 numpy | 为什么 |
|---|---|---|---|
| `Xoshiro128` | RANSAC 抽样、一切「只要可复现」的地方 | **不追** | 对面那串数**本身不是答案** —— 换一串照样得出同一个平面（D-VISION-1） |
| `Pcg64` | `superstructure_test` 的对照波矢 | **逐位追** | 那几个点**进了判决**：抽哪几个决定了「有没有超结构」这句话 |

同 D-FLOAT-1 / D-CHANNELS-1 / D-PIEZO-1：**一个名字在仓里有几份实现时，
登记的是「凭什么几份」。** 这一条的答案最短：**看那串数有没有下游。**

## D-3DS-1 · `.3ds` 截断：没写进来的像素填 **NaN**，并把「缺几个」交出来

| | |
|---|---|
| **Python** | `read_3ds` 先 `np.zeros((ny, nx, n_points))`，写不满一个像素就 `break` —— 尾部像素留 **0** |
| **TS** | 尾部像素留 **NaN**，`params` 另加 `pixels_written` / `pixels_missing` 两个数 |
| **测试** | `packages/host/nanonis-files/src/nanonis-files.test.ts` → `nanTail()` + 「3ds · D-3DS-1」两条 |

**为什么有意**：**一条恒为零的谱不是「没有数据」，它长得像一块干净的样品** —— 在自动流程里
那是最像「这里可以测」的东西，而且**没有任何外部可见的信号**（形状对、dtype 对、值是合法浮点）。
同 D-NUM-4：补出来的零会被当成测量值。

**但这里不抛，与 D-NUM-4 相反** —— 因为两种截断的成因不同：

| | 截断意味着 | 所以 |
|---|---|---|
| `.npy` | 帧是一次性写完的 ⇒ 截断 = **文件坏了** | 抛 |
| `.3ds` | 网格是**逐像素增量写**的 ⇒ 截断 = **操作员按了停** | 不抛：那是正常操作 |

一次被中断的网格仍然是有价值的数据，抛掉它等于让一次合法的中断变成读不出。于是三种格式
是三种策略（`.sxm` 丢帧 / `.3ds` NaN + 计数 / `.npy` 抛），而这**不是不一致**：
截断在三者里意味着三件不同的事。

`pixels_missing` 是一个**数**而不是「你自己去数 NaN」：判据只有做成读得到的值，
调用方才有可能真的看它一眼。

**期望值怎么钉的**：测试里的 `nanTail()` **从金样算出来**，而且把两件事分开了 ——
「缺几个像素」由金样自己的字节数 ÷ 金样自己的头算出（这一步旧仓与本仓本来就同意，
不算偏差），**偏差只在那几格里填什么**，所以替换之前先断言金样里那几格确实是 0。
旧仓哪天自己改成 NaN、改成抛、或者挪了 `break` 的位置，这条断言当场变红。

## D-SXM-1 · `.sxm` 头**不解 GBK**，乱码逐字钉住

| | |
|---|---|
| **Python** | `content[:header_end].decode("utf-8", errors="replace")` —— 一段 GBK 注释「探针」读成 `̽��` |
| **TS** | 同样 `TextDecoder('utf-8')` + replace，**乱码逐字复刻** |
| **测试** | 金样 `sxm/gbk_comment` 那一格 |

**为什么不修**：`errors="replace"` **永不失败**，所以**没有任何信号能分辨「这份头是 GBK」和
「这份头是 Latin-1」**。要修就得先回答这个问题，并且旧仓与本仓**同时**修 —— 否则金样两侧分叉。
而注释字段不驱动任何决策，现在修的收益是零。

登记成一条偏差而不是一个 TODO：**TODO 会过期成背景噪声，登记会在旧仓改动时变红。**

## D-DAT-1 · `.dat` 一律 UTF-8，旧仓随本机 locale

| | |
|---|---|
| **Python** | `open(path, "r", errors="replace")` —— **本机 locale 编码**（而 `.sxm` / `.3ds` 是硬写 UTF-8） |
| **TS** | 三种格式**一律 UTF-8** |
| **测试** | 没有金样能查（见下） |

**为什么金样查不到**：本机 `locale.getpreferredencoding(False)` 是 `cp65001`（就是 UTF-8），
于是这台机器上两边逐字相同。在一台 cp936 的机器上，旧仓会把 `.dat` 头当 GBK 解而本仓不会。

**没有加一格 GBK 的 `.dat` 金样**：那会把「这台机器的 locale」钉进金样，换一台机器
（或 CI 的 Linux）当场变红 —— 那是一条**记录环境而不是记录行为**的假判据。
一条查不到的偏差写进文档，好过一条查错东西的测试。

## D-FLOAT-1 · 同一个词两处两条规则：解析一个浮点数

`kernel/src/readback.ts` 的 `toFloat` **只认十进制**，而 `nanonis-files/src/common.ts` 的
`pyFloat` **认 `nan` / `inf`**。这不是不一致，判据是「**这个数从哪来**」：

| | 解析的是 | `NaN` 该怎么办 |
|---|---|---|
| `toFloat` | **调用方给的参数**（LUT 值、设定点） | 拒 —— 一个写成 `0x10` 的值会被当成 16 灌进硬件 |
| `pyFloat` | **仪器写出来的数据列** | 收 —— Nanonis 在缺点位上写的就是 `NaN`，拒掉等于丢整行 |

**2026-09-16 补：现在是三份。** 批 3k 的 `kernel/src/vacuum-interlock.ts` 又要了一份 `pyFloat`：

| | 收什么进来 | `'nan'` | `'inf'` | `null` / 对象 |
|---|---|---|---|---|
| `readback.ts` `toFloat` | 调用方给的**参数** | 拒 | 拒 | 拒 |
| `nanonis-files` `pyFloat` | 仪器写出来的**数据列**（只收 `string`） | `NaN`（**保留**） | `±Infinity` | 不接受这个入参 |
| `vacuum-interlock` `pyFloat` | 一次**规读数**（`unknown`，含 bool） | `null` | `±Infinity`，下游 `isFinite` 拦 | `null` |

三份的分歧全在 `'nan'` 上，而三个答案都对：一列谱里的 `NaN` **是一个要留在原位的缺点位**；
一个设定点里的 `NaN` 会**穿过包络检查**（D-SI-1）；一次规读数里的 `NaN` 是**「这只规没给出压强」**。
同一个拼写，三件事。

三份都不认下划线与十六进制。**十六进制那一半两边一致**（`float("0x10")` 在 CPython 里确实抛
`ValueError`，实测），**下划线那一半不是** —— `float("1_000")` 在 CPython 里给 `1000.0`，
不抛。那本来就是一条登记过的偏差（**D-SI-2**：本仓有意更严，因为下划线是 Python 数字字面量的
写法，模型路径上不会出现）。

> **2026-09-16 订正。** 本条初稿在这里写的是「`float("1_000")` 同样是抛的」——
> 而同一份文档的 D-SI-2 正文写着相反的事实。**一份自相矛盾的登记册，两处都读起来像真的**，
> 而读的人只会看离他最近的那一处。本机 CPython 3.13 实测：`float('1_000') = 1000.0`、
> `float('0x10')` 抛 `ValueError`。是批 4d 那条支线核出来的 —— 它去问了 Python，我没有。

同 D-CHANNELS-1 / D-PIEZO-1：**一个名字在仓里有几份实现时，登记的是「凭什么几份」**。

## D-VAC-1 · 真空阈值**由外面注入**，不读 `instrument_profile`

| | |
|---|---|
| **Python** | `vac._config()` 从 `mast.core.instrument_profile` 取五个键，读不出来用模块默认，**并把异常吞掉** |
| **TS** | `processVacuum.config`（`Partial<VacuumConfig>`），没接就是 `DEFAULT_VACUUM_CONFIG` |
| **测试** | `packages/host/kernel/src/vacuum-interlock.test.ts` → 「进程级源」那一组 |

同 D-LIMITS-1 / D-PRESET-2 / D-LOCKIN-2：**限值是台架的属性，不是类的属性**。

旧仓那句「defaults are the safe direction」在本仓结构上仍然成立 —— 默认值是 DL-7 的，
而 DL-7 的量程上限**恰好**压在放电带下沿。⚠️ **那是这组默认值的一个好性质，不是判据的前提**：
换一只规就得填那两个数，而 `gaugeConfigProblem()` 在**第一次**拒绝时就把原因说出来，不是第十次。

## D-VAC-2 · 墙钟注入：`processVacuum.nowS`

| | |
|---|---|
| **Python** | `sample.age_s(now=None)` / `att.remaining_s(now=None)` 直接读 `time.time()` |
| **TS** | 全部走 `processVacuum.nowS()`，默认 `Date.now() / 1000` |
| **测试** | `vacuum-interlock.test.ts` → 「接上一只好规 ⇒ 放行，而且用的是注入的钟」 |

与导出器把墙钟钉成 `1_700_000_000` 是同一条理由：**一份每跑一次都换个数的金样，
`git diff` 回答不了「有没有变」。**

## D-VAC-3 · 审计钩子（`set_audit_sink`）**没移**

| | |
|---|---|
| **Python** | `attest` / `revoke_attestation` 各发一条 `_audit(...)`，sink 由运行时注入，抛了只记不抛 |
| **TS** | **不存在** |

消融：本仓没有审计落点，接一个**没有消费方的 sink** 等于给下一个人留一条永远不亮的分支。
签署事件本身在 `processVacuum.attestation` 里看得见；宿主要审计时在 `attest()` 外面包一层即可 ——
那是宿主的决定，不是判据。

## D-VAC-4 · `Number()` 会把三个「没有值」变成**完美真空**

| | |
|---|---|
| **Python** | `float(None)` / `float('')` 抛 ⇒ `to_pascal` 返回 `None` |
| **JS** | `Number(null)` / `Number('')` / `Number('  ')` **全是 `0`** |
| **TS** | `pyFloat()`（在 `vacuum-interlock.ts`，温度那边也用它） |
| **测试** | `vacuum-interlock.test.ts` → 「`Number()` 会把这些当 0，而 0 Pa 读起来正是完美真空」 |

这条不是洁癖：**`0 Pa` 与占位传感器那个 `0.0` 是同一种失败形状**，只是这回由类型转换伪造出来
（读不到 ≠ 零 ≠ 否，第 N 次）。没有复用 `scalarFloat`：它的语义是「body 的第 i 位取不出数就 null」，
与 `float(x)` 不是一回事。

⚠️ 这一份 `pyFloat` 与 `nanonis-files` 那一份**不是同一条规则**，见 D-FLOAT-1 的三栏表。
它对 `'nan'` 交 `null` 而不是 `NaN` —— 这一处**比 Python 的 `float()` 严**（`float('nan')` 是不抛的）。
对外看不出来：`toPascal()` 下游那道 `Number.isFinite` 会把 `nan` 和 `inf` 一起拦成 `None`，
金样 `to_pascal` 里 `"NaN"` / `"Infinity"` 两格录的正是 `null`。**早拦一步只是让「这不是一个压强」
在它第一次出现的地方就成立**，而不是靠下游记得检查。

## D-TEMP-1 · `TempChannel.as_dict()` **没移**，只移技能报的那一份

| | |
|---|---|
| **Python** | `as_dict()` 有 7 个键（多一个 `value`）；`GetTemperature` 报 `available_channels` 时**另拼**一份 6 键的 |
| **TS** | 只有 `channelDict()`（6 键，与技能报的那份同形） |
| **测试** | `packages/host/kernel/src/temperature.test.ts` → 「channelKelvin 与 channelDict 用的是同一条换算」 |

`as_dict()` 在 `mast/skills/**` 与 `mast/agents/**` 里**零调用方**。移一个没有消费方的形状，
下一个人会以为这两份字典应该是同一份、然后把它们合并 —— **而它们刻意不是**。
金样（`export_environment.py`）录的是**会上线的那一份**。

## D-TEMP-2 · `age_s` 的「日期-only」形式，两种语言解释不同

`datetime.fromisoformat('2026-09-16')` 按**本地**午夜解，`Date.parse('2026-09-16')` 按 **UTC**
午夜解（ES 规范对纯日期串如此）。差的是时区偏移那么多小时 —— 而这个数直接决定
「这份读数还新鲜吗」。本仓在 `ageS()` 里把纯日期补成 `T00:00:00`，让两边都走「本地朴素时间」那一支。

**测试**：`temperature.test.ts` → `ageS` 那一组（金样里的三条时区用例）。

## D-TEMP-3 · `latest_temperature` 的类型校验：`isinstance` → 结构校验

| | |
|---|---|
| **Python** | `isinstance(out, TempReading)`，不是就回 `no_source` |
| **TS** | 结构校验（五个键齐不齐），不是就回 `no_source` |
| **测试** | `temperature.test.ts` → 「源回了个不是读数的东西 ⇒ no_source」 |

TS 没有运行期类名。判据（**「源给的不是一份读数 ⇒ 当作没接上」**）一模一样。

## D-NUM-8 · `grey_dilation` 用的是**翻转过的**结构元，`grey_erosion` 不翻

形态学的对偶要求 `(f ⊕ B)(x) = max_b f(x − b)`，而腐蚀是 `min_b f(x + b)`：**偏移号相反**。
写成「翻掩膜 + 原点从 `size>>1` 变 `size − 1 − size>>1`」与它等价。

**奇数尺寸时两者恰好一样**，所以 3×3 / 5×3 / 十字全都看不出来 —— 是金样里那一格 **4×4**
把它逼出来的。猜错了整张图沿两轴各平移一个像素，而**一张平移一个像素的形貌图看起来完全正常**。

**变异**：`numerics-morph-dilation-reflects-se`。

## D-NUM-9 · `wrap` 在 scipy 的**滤波族**与**插值族**里周期不同

| 名字 | `filters.ts`（`gaussian_filter` 那一族） | `interpolate.ts`（`map_coordinates` 那一族） |
|---|---|---|
| `wrap` | 周期 **`n`**：`a b c d \| a b c d` | 周期 **`n − 1`**：首尾两点重合 |

同一个字符串、同一个库，两族函数里含义不同（scipy 自己的文档把插值族的重合点取哪一个
注明为「没有定义」）。**于是 `interpolate.ts` 不复用 `filters.ts` 的 `boundaryIndex` ——
复用才是 bug。** 两处各有一条测试互相指认。

**变异**：`numerics-interp-wrap-period-is-n-minus-1`。

## D-NUM-10 · `mirror` 在 `(n−1, n)` 这一段上**根本不折坐标**

scipy 的 `map_coordinate` 外层判 `x > n−1` 才进来，**内层却判 `y >= n` 才翻**，于是
`x = 11.5`（`n = 12`）一路活到取整：`floor(12.0) = 12`，再由**下标**折叠给出第 10 行。
先折坐标的话是 `10.5 → 11` —— 差一行。

`order = 1` 上两种做法**完全同解**（两个邻居折过去正好是对称的那一对），只有 `order = 0`
的取整分得开 —— 这就是为什么要给一族数值函数留一档**零容差的孪生**（见课时）。

**变异**：`numerics-interp-mirror-keeps-last-span`。

## D-NUM-11 · `order >= 2` **抛，不近似**

scipy 的 `order >= 2` 先对整张图做一次**样条预滤波**（一条前向 + 一条后向的 IIR 递推），
得到的系数图才拿去插值。那一步是**全局**的：改一个像素会影响整张图的输出。
拿三次卷积核去近似它误差在 `1e−2` 量级 —— **那不是容差，那是另一个算法。**

`export_numerics.py` 仍然录了 `order=3` 的金样：**录下来是为了证明我们知道它长什么样、
并且确实没在复现它**，将来谁要补这一块，判据现成。

## D-NUM-12 · `shift` 改名叫 `shiftImage`

这个包是扁平导出的（60 多个顶层名字）。一个叫 `shift` 的导出迟早会被某个局部变量遮住，
**而那种遮蔽不报错**。方向照搬 scipy：`shiftImage(a, s)` 给 `out[i] = a[i − s]`，
内容往 `+s` 方向搬。

## D-NUM-13 · 相位归一化的分母是 `max(|·|, 100·eps)`，理由是**对齐，不是更准**

本仓上一版写的是「模为零才置零」，skimage 写的是
`image_product /= np.maximum(np.abs(image_product), 100 * eps)`。差别只在模小于 `2.2e−14`
的那些频点上。

**这一改一开始编过一个理由，而探针当场把它证伪了。** 原话是「压住噪声，峰就留在直流」——
可是对一次精确的 `roll`，那些「噪声」频点带的是**同一个相位**（`B = A·e^{−2πi k·d}`
对每个频点都成立，dust 也不例外），不压反而给出更干净的峰。

所以改成去问 skimage：金样补了一格 `near_flat`（两张 16×16 的几乎常数帧，各带独立的
1e−12 噪声），**skimage 报的是 `(5, 5)`** —— 一个纯属虚构的位移，而我们逐位复现它。
理由落回「对齐」，**不落在「更准」**。

**变异**：`numerics-xcorr-damps-tiny-magnitudes`。它**第一次跑是绿的** —— 也就是说
那一改当时没有任何测试在看。补上 `near_flat` 才变红。**一条变异跑出绿色，说的不是
「这个变异不重要」，是「这条闸不存在」。**

## D-NUM-14 · 亚像素档在平坦帧上会报出一个**纯属虚构**的位移

相位互相关把每个频点都归一化成单位模长，**于是没有信号的地方由噪声说了算**：

- 几乎平坦的一对帧 ⇒ `(5, 5)`（D-NUM-13 那一格金样）；
- 一张**真正的**常数图 ⇒ 相关面全平，`argmax` 只挑第 0 格，亚像素档下那一格等于
  `−dftshift/uf`（`uf = 2 / 4 / 10` 分别是 `−0.5 / −0.75 / −0.7`）。

输出还恒为 `1/uf` 的整数倍，所以**调用方要判「漂没漂」必须自己看峰有多尖、再设阈值**。
拿 `!== 0` 去判，等于每一帧都在补偿噪声 —— **而那会制造漂移。**

这一层不替调用方做那个判断（它没有「这张图该有多少结构」的信息），但两条测试把这个坑
钉在原地了。⚠️ **技能层欠一个「峰质量」指标**：在它到位之前，`CorrectDrift_XCorr`
的高精度档不该被直接信。

**变异**：`numerics-subpixel-dftshift-is-fix`。

## D-STREAM-1 · `_readback_stream.scalar` 是旧仓那一族**没被收进去的第四份**

| | |
|---|---|
| **Python** | `_readback_stream.scalar`：多元素 body 直接取 `d[0]`，嵌套表再取 `v[0]` |
| **TS** | 一律走 `scalarFloat`：**多元素 body 一个样本都不记** |
| **测试** | `packages/host/stm-skills/src/l0/tail-l0j.test.ts` → 「取不出数就是 null」 |

旧仓自己把三份手写的 `_scalar` 收进了 `io/nanonis_files.scalar_float`，**而这一份没收进去**。
`scalar_float` 的 docstring 点名说最难查的就是这一种：**「双通道回包上悄悄选一路」**。

**影响面 0 格**：`Current_Get` / `ZCtrl_ZPosGet` 的协议声明都是单个 `f`，
所以这条只在协议被违反时才分岔 —— **而那时沉默比猜好**。

> 这个号是支线暂定的（`D-READBACK-1` 已被「回读比对的容差是判据」占了），
> 主线确认沿用：`readback-stream.ts` 与 `tail-l0j.test.ts` 里各引了一次。

## D-STREAM-2 · `timing.budget_exhausted`：**本仓新增**的圈数预算

旧仓的采集循环用真墙钟，不可能不停；本仓的时钟是**注入的**，于是
**一个不往前走的钟会把它变成一个不发任何调用的死循环 —— 而死循环与通过在退出码上
长得一模一样。**

预算**从请求本身算出来**（`totalS·(pollHz+1000)+64`），不是一个拍脑袋的常数。
超了就收工并补一句 `budget_exhausted: true` —— **只在发生时才写，缺键就是没发生**
（同 `tipXyFields` 的空对象、旧仓 `warning` 那个键），所以金样一格没变。

连带改了一句文案：`BiasPulseWithReadback` 在「始终没到开火时刻」时旧仓只有一句
`Aborted before the pulse was fired`。照抄会把**一次夹具故障说成一次用户中止**，
而这两件事要做的下一步完全不同。预算耗尽时换成「注入的时钟没有前进」。

**这道闸没有变异演练，而那正是它存在的理由**：拆掉它测试不会变红，它会**挂住** ——
演练自己有 120 秒上限，一条本该变红的变异会被报成「超时失败」（2026-09-13 真踩过）。
改由 `tail-l0j.test.ts` 三条正向断言看着。

## D-STREAM-3 · 采集循环在旧仓有**两份**，本仓收成一个骨架

`capture_signal_buffer.py`（早）与 `_readback_stream.py`（晚）各写了一遍
「绝对时刻调度 + abort 早退」。本仓收成 `pollLoop`，两个调用点各传自己的 `poll`。

**但字面动词留在调用点**：本仓每一样安全工具（中止策略检查、安全审计、API 覆盖普查）
都靠 grep `safe_call("…")` 找 Nanonis 调用，**一个经变量到达的动词对这三样全部不可见**。
收骨架收的是流程，不是那个字符串。

## D-CLOCK-1 · 两侧的假钟摆在**不同的量级**上 ⇒ 时间字段按容差比

| | |
|---|---|
| **Python** | `export_skill_traces.py` 的 `_CLOCK = 1_000_000.0` **秒**，每读一次 `+= 1e-3` |
| **TS** | `SkillContext.now()` 按契约是**毫秒**，轨迹夹具给的是整数 |
| **后果** | 「3 毫秒」那边算出来 `0.003000000142492354`，这边 `0.0030000000000427463` |
| **测试** | `l0/traces.test.ts` 的 `clockApprox`（`|a−b| ≤ 1e-6·max(1,|a|)`；实测差 1e-10） |

**这个差消不掉。** 毫秒钟在 1e9 上的栅格比秒钟在 1e6 上的粗 2.4 %，于是约 2 % 的秒值
**根本没有毫秒原像** —— 无论怎么折算都回不到同一个 double（实测 200 000 个采样点里
4 688 个回不去）。真要消掉只能改那个**全局**假钟，而那会把每一条已有金样的时间字段
一起改掉。

**判据分毫不动**：容差按名字只作用在 17 个时钟派生的叶子键上（`CLOCK_KEYS`），
而且是**逐格登记**的 —— 只挂在这一族三个技能的轨迹上，其余 326 个技能照旧逐位比。
采了几点、哪一帧丢了、顺序、判定、文案全部不在那张名单里。

> **值得单记的一条**：`post_roll_s` 的默认值（20 ms）**正好压在采样栅格上**
> （假钟下一帧 3 ms）。后窗是 `t >= cap - win` 的闭区间，边界压在样本上时，
> 那 1e-10 的残渣会**决定一个样本进不进窗**，`n_post` 因此差一个。
> 导出参数改成 21.5 ms（刻意不落在栅格上）。
> **浮点残渣本身不可怕，可怕的是它落在一个离散判据的边界上。**

## D-TIP-1 · 针尖安全包络（`apply_tip_policy`）—— ~~欠 Phase 5.3~~ **2026-09-18 已结清**

> **两条订正，都在这一段的开头说，因为下面那些话曾经被当真过：**
>
> 1. **欠账结清了**（批 5a）：闸是实的，落点与金样见下方「D-TIP-1 **结清**」那一节。
> 2. ⚠️ **下面那句「铂铱（8 V）、磁性/超导针、qPlus（3 V）会在那里被拒绝」
>    在今天的旧仓已经不成立**，而且**写下它的时候就已经不成立了** ——
>    旧仓 2026-08-12 就把两个上限统一拉满了（见下）。我从批 3j 的交接里抄了这句话，
>    **没有去翻那张表**。这是本仓「读源头、不读转述」这条纪律的一次自打脸。

旧仓 `BiasPulseWithReadback.validate_params` 按**当前登记的针尖**检查方案表包络，
**超上限拒绝、不夹紧**（同粗动电压四重锁那条哲学）。~~修针默认的 ±10 V 是用户对
**金属丝针尖**的做法；铂铱（8 V）、磁性/超导针、qPlus（3 V）会在那里被拒绝。~~

**今天那张表的实情**（2026-09-18 逐档核过 `core/tip_conditioning_policy.py`）：
`max_abs_pulse_v` **全表一律 10.0**、`max_poke_depth_m` 全表一律 `1.0e-8`，
**还能分辨针尖的包络字段只剩 `max_pulse_count`（通用 5 / qPlus 2）**。

旧仓自己把这个决定和理由写在表头上，值得原样留着：

> 现场给出的理由：凭多年 STM 经验，这个安全包络定得过严、没有实际意义，针尖没有那么容易损坏。
> **要推翻它，需要回答**：哪一次真机事故是「包络本可以拦住、而它被拉满了才发生」？
> 反过来的证据我们有：2026-08-12 第一次完整 `ForgeAuTip` 失败，而包络**一发脉冲都没拦**
> （三发 10 V 全部放行），它死在一个陈掉的状态缓存上 —— 当时**拉满与否对结果没有任何影响**。

**这段反问值得学**：它没有说「包络不重要」，它说的是「**拿证据来**」，
并且**先把反方向的证据摆了出来**。本仓照移这张表，不自作主张收紧 ——
要收紧的话，答的应当是它提的那个问题，而不是「看起来更安全」。

~~它要 `mast.core.tip_conditioning_resolver`（针尖登记表，Phase 5.3）。~~ **已移植**。
当初**没有写一个空的 `validateParams`** —— 写了会让人以为这道闸在。
那个决定现在回头看是对的：空壳在这里活了两轮，而**没有人误以为它在挡**。

~~金样照不出这一条：导出脚本直接调 `execute`，`validate_params` 一次都没被调用。~~
现在有一台专用驱动器（`spec/golden/tip_policy.json`，276 格 / 111 格被拒）——
**通用驱动器照不出来的东西，不等于照不出来，只等于那台驱动器走不到。**

## D-LANG-1 · `pyFixed`：`%.3f` 是 round-half-even，`toFixed` 明写「取大的那个」

语言分歧一族的**第六个成员**（前五个：`pyFloatRepr` / `formatG` / `pyStr` / `pyMod` /
`pySum`，见 D-SI-3 / D-NUM-1 与 `kernel/src/si.ts`）。

Python 的 `%.3f` 在半分点上 round-half-even，ECMA-262 的 `toFixed` 明写取大的那个。
**半分点恰好是 1/16 的奇数倍**（0.0625、0.1875、0.3125…），全是二进制精确表示的数 ——
所以这不是理论问题：`"%.3f" % 0.0625` = `0.062`，`(0.0625).toFixed(3)` = `"0.063"`。
金样 `seg4_exact_sixteenth` 那一格印的就是 `0.062`。

**欠账**：它现在住在 `kernel/src/z-trace.ts` 而不是 `si.ts` —— 这一轮有四条并行支线
在改文件，塞进 `si.ts` 会让四份改动撞在同一行上。收族的时候搬过去。

## D-TRACE-1 · `MAST_TRACES_DIR` 环境变量**没有移植**

旧仓那个变量的职责是**测试隔离的抓手**（17 个测试文件都够得着这条落盘路径）。
本仓的抓手就是 `TraceDeps.tracesDir` 这个注入点本身 —— **同一件事两个开关，
只会多一个漂移的地方**。默认落在 `<cwd>/experiments/traces`（同 `frames.ts`，已在 `.gitignore`）。

## D-TRACE-2 · `TRACE_SCHEMA` **保留 `mast.` 前缀**

`mast.readback_trace/1` 这个串写进的是**磁盘上的文件**，而那些文件要被旧仓的读取侧、
以及用户手上已经存着的分析脚本认出来。为「本仓改名了」而换掉它，等于**让同一种文件
在两个仓里长得不一样** —— 那正是版本号要防的事。

## D-SKILL-2 补充 · `shaper_bias_default` 的「读不懂」文案（1 格）

旧仓印 `str(return_value)[:80]`，也就是三段信封的 Python repr
（`Bias_Get 回包读不懂(repr 前 80 字:('', b'', []))`）。信封在 `nanonis-wire` 那层
就拆掉了，本仓印 `values=[]`。**期望值从金样算出来**（一条 `.replace`），
旧仓改了那句话这里会跟着变。登记在
`l0/traces.test.ts` 的 `DEVIATIONS['TipShapeWithReadback/empty@0']`。

## D-STS-1 · `_reshape_spectrum` 的 `reason` 里**不复刻 numpy 的异常文本**

| | |
|---|---|
| **Python** | `np.array(...).reshape(rows, cols)` 抛 ValueError，`str(exc)` 拼进 reason：`6×7 装不下这段数据: cannot reshape array of size 4 into shape (6,7)` |
| **TS** | `6×7 装不下这段数据: 一共 4 个数，要 42 个` |
| **测试** | `l0/traces.test.ts` 的 `reshapeReason()` —— **期望值从金样算出来**（正则抠出 size/rows/cols 再重算） |

同 D-SKILL-2 / D-OSCI-1：逐字复刻一句 numpy 的异常，等于让诊断**指向一个本仓根本没有的库**。
**判据（几个数、要几个）一模一样。** 旧仓改了那句话、或者 numpy 换了措辞，这条登记当场变红。

本仓多一条分支：块里有不是数的元素时给「这段数据里有不是数的元素」（旧仓那边同样落在
`np.array` 抛上，只是说不出是哪一种）。

## D-STS-2 · 通道串解析不了：旧仓**抛**，本仓**拒**

| | |
|---|---|
| **Python** | `ConfigureSTSChannels` 走 `int(x)`、`_coerce_int_list` 走 `int(float(x))` —— 两者都抛 ValueError，技能以一句看不懂的异常失败 |
| **TS** | `strictIntList` / `coerceIntList` 解不出给 `null`，技能回一条说得清的拒绝，**一次调用都不发** |
| **测试** | `l0/spectroscopy.test.ts` →「解析不了 ⇒ 一次调用都不发」；`traces.test.ts` 那条通用分支 |

同 D-SKILL-3。两个解析器**照旧刻意不同**（认不认 `;`、认不认 `'2.5'` 这种小数写法、
认不认非字符串入参），没有合并 —— 同 D-FLOAT-1：**一个名字在仓里有几份实现时，
登记的是「凭什么几份」**。

## D-STS-3 · `AcquireSTS` 报的是**真的用上的** recv 预算

| | |
|---|---|
| **Python** | `data["recv_timeout_s"] = round(recv_budget_s, 1)` —— 记的是**请求的**那个数，而 `connection.py` 会把它夹到 900 s |
| **TS** | 记的是 `ctx.slowCall` 回来的那个数（**已夹过**）；宿主没接这条口时是 `null` |
| **测试** | `l0/spectroscopy.test.ts` 的 recv 预算两格 + `slowCallFrom` 三格；变异 `recv-budget-is-capped` / `recv-budget-unwired-is-null` |

金样照不出它（夹具里的预算从来没超过 900 s），所以它由单测 + 变异钉住。

理由同 D-SCAN-4「回声不是读数」：**一个「我请求了 3000 s」的记账，在一台上限 900 s
的台架上是假的** —— 而事后看记录的人没有第二个地方可以查真值。

## D-STS-4 · `.dat` 候选目录只有一个来源（沿用 D-FRAME-1，不新开）

旧仓 `_attach_saved_dat` 走 `_candidate_save_dirs`（四路）。本仓沿用 `GetLatestScanFile`
那一份：**问仪器**要 session 目录，只搜真目录，只认最近 120 s。另外三路（落盘登记表、
`working-sessions`、样品原位目录）依赖本仓还没有的东西，已在 D-FRAME-1 登记过。
**调用序列因此与旧仓一致**（都是一次 `Util_SessionPathGet`）。

`record_scan_path` 那一句（旧仓裹在 `except: pass` 里的落盘登记）**没移**：本仓没有那份
登记表，接一个**没有消费方的写入**，下一个人会以为有人在读它（消融精神，同 D-VAC-3 / D-PLL-1）。

## D-STS-5 · `AdvPropsSet` 被拒时那两个键是 `null`，不是 `false`

这一条**与旧仓相同**（`True if adv_ok else None`），登记它只是因为它值得被看见：
**「没设上」不是「设成了 false」。** 一个宣称了 Z-Ctrl Hold、而那个寄存器根本没碰过的
返回值，正是这一族最想避免的东西（同 D-LOCKIN-1 的 `phase_deg: 0.0`、D-ZERO-1 的反面）。

## D-LANG-2 · `pyRound`：`round(x, n)` 是**银行家舍入、按精确值算**

语言分歧一族的**第七个**（前六：`pyFloatRepr` / `formatG` / `pyStr` / `pyMod` / `pySum` /
`pyFixed`，见 D-SI-3 / D-NUM-1 / D-LANG-1）。

Python 的 `round(x, n)` 在半分点上取偶，而且**按 double 的精确值**判半分点；
`toFixed` 明写「正好一半取大的那个」，`Math.round(x*10**n)/10**n` 则先制造一次乘法误差。
`pyRound()` 在 `kernel/src/spectroscopy.ts`。

## D-NUM-15 · `find_peaks` 的 `distance` 在 `prominence` **之前**筛

scipy 的顺序是 `plateau_size → height → threshold → distance → prominence → width`。
反过来做**不会报错**，只在某些信号上多留或少留一个峰：

```
x = [0, 5, 0, 9.9, 9.8, 9.8, 9.8, 9.8, 10, 0]，prominence = 1，distance = 3
  scipy（distance 先）  ⇒ [8]      下标 3 那个高而不突出的峰先把下标 1 挤掉，
                                   然后它自己被 prominence 筛掉
  prominence 先         ⇒ [1, 8]   下标 3 先没了，于是没人挤下标 1
```

金样 `peaks.order_probe_{both,prom_only,dist_only}` 三格专为此录。
**别的输入上两种顺序同解** —— 一组分辨不出两种候选的金样不是判据。

**变异**：`numerics-findpeaks-distance-keeps-the-taller`。

## D-NUM-16 · `prominence` 取两侧最小值的 **`max`**，不是 `min`

峰高减去「向左、向右各走到**遇见一个严格更高的样本**为止，这两段区间里各自的最小值」
的**较大者**。两个容易写成的错版本都给出完全合理的数：

- 取 `min` ⇒ 每个峰都偏突出（走到全局最低点那一侧几乎总是 0），噪声上的小包越过阈值；
- 只看**直接相邻**的谷 ⇒ 大山肩上的小凸起拿到和主峰一样的 prominence。

金样 `peaks.prominence_side`：`max ⇒ 0.4`，`min ⇒ 0.7`。

**变异**：`numerics-findpeaks-prominence-is-the-lower-base`。

## D-NUM-17 · 平台峰取中点**向下**取整；紧贴数组两端的极大值**不算峰**

`[0,1,1,1,1,0]` 的峰是下标 **2**（平台 `[1,4]`，`(1+4)>>1 = 2`）—— 向上取整会给 3，
而**奇数宽的平台上两种写法完全同解**。`x[n−1]` 再高也不是峰：scipy 的扫描区间是
`[1, n−2]`。旧仓 `classical_seg.py` / `_hist_modes` 在直方图两端各补一个 0，就是为了后半句。

**变异**：`numerics-findpeaks-plateau-midpoint-floors`。

## D-NUM-18 · 等高峰在 `distance` 里谁赢，scipy **没有定义**

scipy 用 `np.argsort`（quicksort，**不稳定**）按高度排序再从高到低处理。两个**等高**
且互相在 `distance` 之内的峰，留下哪一个由排序实现决定 —— **换一版 numpy 就可能换一个答案**。

本仓用**稳定**排序（等高时下标小的排前），于是处理时下标大的先赢。**确定，但不保证等于 scipy。**

金样里因此**没有等高峰**：一格分辨不出两种候选的金样不是判据，
而一格**答案本身没有定义**的金样更糟 —— 它会把上游的一次实现变更记成本仓的一次回归。

## D-NUM-19 · `correlate2d(mode='same')` 的原点是 `(Mb−1)//2`，而 `grey_*` 的是 `Mb//2`

| | 原点 | 4×4 的核 |
|---|---|---|
| `scipy.signal.correlate2d(mode='same')` | `(Mb − 1) // 2` | **1** |
| `scipy.ndimage.grey_erosion(size=…)` | `Mb // 2` | **2** |

**两个都是 scipy、两个都叫「中心」**，偶数尺寸时差一格（实测：一张只有一个 1 的图
× 一个 `arange` 的核，四种尺寸逐一确认）。猜错了整张相关面平移一格 ⇒ 漂移向量整体
偏一个像素，**而那仍是一个合法读数**。

金样里 **2×2 与 4×4** 两格偶数核为此而录 —— 奇数核上两种猜法完全同解。
同 D-NUM-2（`reflect` / `mirror` 两族拧着用）与 D-NUM-9（两族 `wrap` 周期不同）：
**同一个库里同一个词，换一族就换一个意思。**

**变异**：`numerics-correlate2d-origin-is-half-of-size-minus-one`。

## D-NUM-20 · 相位归一化**可关**，而关掉它是另一个算法、不是另一档精度

| | 互功率谱 | 峰由谁说了算 |
|---|---|---|
| `'phase'`（skimage 缺省，本仓缺省） | `A·conj(B)` 除以模（下限 `100·eps`） | **每个频点一票** —— 没有信号的地方由噪声投票（D-NUM-14） |
| `null` | `A·conj(B)` 原样 | **按功率加权** —— 低频与强结构说了算 |

旧仓 `drift_xcorr` 明确传 `normalization=None`，注释写明理由：**对 SPM 的行噪声更稳**
（一条横贯整帧的噪声脊在相位归一化下与真信号一样有投票权）。

**两档在同一对帧上给不同的位移**：同一对几乎平坦的帧，`'phase'` 报虚构的 `(5, 5)`，
`null` 报 `(0, 0)`。**只有这种帧分得开** —— 一组普通帧的金样会让这个开关
**没有任何测试在看**（D-NUM-13 那一次的教训）。

**变异**：`numerics-xcorr-normalization-is-switchable`。

## D-NUM-21 · `error` 只能在**平方**上给容差，而它有个下限

`1 − |CC|²/(src·tgt)` 在对得上的一对帧上是**两个几乎相等的数相减**，`√` 又把剩下的
放大（`d√u = du/(2√u)`）。结论对调用方直接有用：

> **`error` 的绝对精度只到 `√(32·fftRelTol(N))` ≈ 8e−7**（N=1024；
> `fftRelTol(1024) = 8·eps·log₂1024 = 1.78e−14`，×32 再开方）——
> 也就是说 `error = 1e−8` 与 `error = 1e−7` 是同一个数。
> **拿 `error` 判「配准好不好」，阈值不能设在 1e−6 以下**，那是在读噪声。

（2026-09-16 订正：本条初稿把 8e−7 写成了 1e−6。**推导在 `fft.ts` 抬头，
以它为准** —— 一个从推导里抄漏一位的数，读起来和推出来的一模一样。）

同「一个逐元素的相对比较不是容差，是抽签」：**相消毁掉的精度，开方会把它放大回来。**

## D-NUM-22 · `savgol_filter(mode='interp')` 的两端不是「边界模式」，是**另一个算法**

最外各 `w//2` 个点**完全不经过那串系数**，而是对最外 `w` 个样本做一次 `polyfit` 再求值。
拿 `mode='nearest'` 之类近似它，最外几个点差到 **0.5 量级** ——
**而一条谱的最外几个点正是「有没有能隙」要看的地方。**

## D-NUM-23 · `savgol_coeffs` 解的是**最小范数解**，不是最小二乘解

`A c = y` 是**欠定**的（`polyorder+1` 个方程、`window_length` 个未知数）。
写成 `(AᵀA)⁻¹Aᵀy` 会当场抛（`AᵀA` 秩亏，Cholesky 报错）—— **那算运气好**。
真正危险的是随手挑一个特解：它**满足方程**，滤出来的曲线**仍然光滑**，
只是平滑的不是原来那条信号。

`polyorder > 3` 本仓**抛，不近似**（同 D-NUM-11）：行缩放能修 `A'A'ᵀ` 的条件数，
修不了重建那一步的相消（w=31 / po=5 差着 6.5 倍）。金样照录，
**录下来是为了证明我们知道它长什么样、并且确实没在复现它。**

## D-VISION-1 · `fit_plane_robust` 的 RANSAC **不与 numpy 逐位一致**，判据因此换了一条

| | |
|---|---|
| **Python** | `np.random.default_rng(42)`（PCG64）抽三点子集 |
| **TS** | `Xoshiro128`（D-NUM-7：判据是**可复现**，不是「与 numpy 相同」） |
| **测试** | `packages/host/vision/src/vision.test.ts` → `抽签这件事是**真的**` |

三点假设只是搜索启发式，真正的答案是「用全部内点重拟合」。两边抽到的子集不同 ⇒
**落在带边缘上的若干点归属不同** ⇒ 重拟合的输入集差几个点。实测（128×128 的台面帧、
`sigma=None`）：内点率 `0.390625` 对 `0.390380859375`，差 **4 个点 / 16384**，
由此 `std` 的相对差 `4.7e-5`。

于是判据分两层，两层都写在 `plane.ts` 的 `RANSAC_REL_TOL` 上：

* **定死内点集的那一格逐位比** —— 给一个显式 `sigma`，大到「整条台面在带内、
  隔壁台面在带外」，那时每一个够好的三点假设都圈出同一个内点集
  （金样 `terraces_sigma10pm`，内点率 `0.390625` 逐位相同）；
* **抽签的那几格**按「两边拟合出来的平面，在帧上**任何一点**的差不超过量程的
  `1e-3`」比 —— 不逐系数按相对比：一张几乎水平的帧上 `a ≈ −3e-15`（整帧 0.3 pm）、
  一张常数帧上 `a ≈ −9e-27`（纯舍入），对这种数要求相对精度是在要求一件不成立的事。

⚠️ 金样里**删掉**过一格（`sigma=20pm`）：在那个阈值上「一条沿楼梯斜穿的平面」与
「一整条台面」的内点数相当，挑中谁由抽样序列决定，两边的答案差一个量级。
**一个答案是掷骰子的用例不是判据**，留着它只会让下一个人去调容差。

## D-VISION-2 · `numerics.median` 是 `np.percentile(50)`，**不是** `np.median`

| | 偶数长度时算什么 |
|---|---|
| `np.median` | `np.mean(两个中位)` = `(a + b) / 2` |
| `np.percentile(x, 50, 'linear')` | `a + (b − a) · 0.5` |
| `numerics.median` | 后者（它就是 `percentile(xs, 50)`） |

两个表达式数学上相等、浮点上不等。`mast/vision/` 里凡是 `np.median` / `np.nanmedian`
的地方本仓走 `vision/nd.ts` 的 `npMedian`（`(a+b)/2`）。

**测试**：`vision.test.ts` → `` `np.median` 不是 `np.percentile(50)` ``，
金样 `analysis.json` 的 `np_median` 一节里有一格**必然分岔**
（`[-0.1, 0.30000000000000004]` ⇒ `0.10000000000000002` 对 `0.10000000000000003`）。
那一格是**挑出来让它分岔的**，不是随手取的 —— 第一版拿合成帧验，两者恰好处处相等，
那条断言于是绿着什么也没验（同 `numerics.md` 第四节第二条）。

`numerics.median` 没有错，它对的是 `np.percentile`。这是 D-CHANNELS-1 的形状：
两个看起来该合并的东西，合并会默默改掉判决。

## D-VISION-3 · `judge_frame` 的 `std` 走 **float32**，而那不是精度问题

`tip_metrics._detrend` 的最后一步是 `.astype(np.float32)`，而 `np.std` 对一个 float32
数组**在 float32 里累加**。一张带倾斜的死平帧，去趋势残差在 `1e-25` 量级 ——
**`1e-25` 的平方在 float32 里下溢成 0** ⇒ 方差 0 ⇒ `std` 为 0 ⇒ `judge_frame`
走第一档（`DEAD_FLAT_REASON`）。在 float64 里算的话 `std ≈ 1e-25 ≠ 0`，
同一张帧改走第二档、**报的是另一句话**，而这一层的产品正是那句话。

本仓照抄那次降精度（`vision/nd.ts` 的 `std32`，每一步都 `Math.fround`）。
**累加顺序仍与 numpy 的成对求和不同**，那一份差异由 `corrugationRelTol(n)` 承担
（`8 · eps32 · log₂n`，与 `sumRelTol` 同一条推导，只是把 `eps` 换成 `eps32`）。

**测试**：`vision.test.ts` → `judgeFrame 的两档死平判据` 的 `dead_flat_float64` 那一格。
⚠️ 那一格**不走 `.sxm`**：存成 float32 之后量化噪声（~1e-16）远大于下溢的门槛，
只有**活体帧**（直接从线上拿到的 float64）撞得到这一条。

## D-ADATOM-1 · `VerifyAdatomAt` 的 `min_peak_height_m` 在旧仓把候选**全滤光了**

| | |
|---|---|
| **Python** | `adatom_verify.py:120` 读 `c.get("peak_height_m")`，而 `ExtractClusters` 交出来的键叫 **`peak_height_pm`** ⇒ 取到 `None` ⇒ `or 0.0` ⇒ `0.0 < min_h` 恒真 ⇒ **每一个候选都被 `continue` 掉** |
| **后果** | 技能报 `not_found`（「这一帧的目标附近没有团簇」），而诚实的答案是「**我把它们全筛掉了**」；`others[].peak_height_m` 一并恒为 `None` |
| **TS** | 按 `peak_height_pm × 1e-12` 读 |
| **测试** | `l0/analysis-skills.test.ts` → `D-ADATOM-1` 那一组（三条：旧仓那一侧钉住 · 本仓照实报 · 滤器抬到 1 nm 时仍然会滤） |

这与 `_frame_contains` 自己 docstring 里写的那条一模一样：
「a target the frame does not cover would come back as `not_found` —— *the atom is not there* ——
when the honest answer is *this frame cannot say*」。同一个技能，同一种错，另一个字段。

## D-ATOMLINE-1 · 「按信号名找 Z」那一支在旧仓是**死的**

| | |
|---|---|
| **Python** | `_scan_readout.first_values(rec)` 取三段信封的第三段，也就是**整个 body**。`Signals_NamesGet` 的 body 是 `[size, declared_n, 名字表]`，于是 `flat` 成了 `['31', '31', 'current (a)']` 这样三个串，而 `flat[c]`（c 是 0 / 30 这种**信号索引**）几乎不可能命中 `Z_NAME_HINTS` ⇒ 永远落到兜底 |
| **TS** | 按 `body[2]` 取名字表（与 `ListSignalChannels` 同一条口径），于是那一支真的能命中 |
| **测试** | `l0/analysis-skills.test.ts` → `D-ATOMLINE-1` 那一组（三条，含「缓冲里多一路非电流时兜底会挑错」） |

兜底本身是诚实的（它**说自己是兜底**：`兜底：缓冲里非电流的那一路`），
但它在缓冲里有第三路时会挑错：`[0(Current), 5(Bias), 30(Z)]` ⇒ 兜底给 **5**，
而本模块抬头明写「必须读 Z」（Z 的线级 SNR 中位 211–225，电流只有 52–82，**差 2.6–4 倍**）。

⚠️ 这是批 4a **唯一**一处刻意改了旧仓解析的地方。

## D-SCANPREP-1 · 扫描图阈值 profile：外部 JSON → **注入**，而且只移**两个字段**

| | |
|---|---|
| **Python** | `scan_prep_thresholds.py` 22 个阈值 + 从 `project_root()/config/scan_prep_profiles.json` 读外部 profile（读不动就当没有） |
| **TS** | `kernel/src/scan-prep-thresholds.ts`：只有 `name` / `provenance` / `corrugationHighPm` / `corrugationRefScanNm`，外部 profile 是 `scanPrepProfiles.external` 这张表 |
| **测试** | `kernel/src/corrugation-gate.test.ts` → `scan-prep profile` 那一组 |

注入那一半同 **D-VAC-1 / D-PRESET-2 / D-LOCKIN-2**。
只移两个字段那一半是**消融**：本批唯一的消费方 `AssessFrameCorrugation` 只读这四个，
移那 18 个进来就是给下一个人留 18 条永远不亮的分支，而它们各自的标定说明会在
**没有任何测试盯着**的情况下慢慢过期。

⚠️ 内建 profile 的起伏门**出厂就是 `null`**（判不了），这是判据不是疏漏 ——
`judgeCorrugation` 因此开箱即 `undecidable`，而它的 `reason` 会说清
「上限与它的标定视野都没填 …… 这不是『没有上限所以都算正常』」。

## D-SCANART-1 · `detect_scan_artifacts` 只移了 `bad_row_frac` 那一条路

旧仓那个函数无条件还算 `_spike_frac`（要 `ndi.median_filter`，基线没有）、
`_oscillation`、`_drift_px`。本批**唯一的消费方**（`AssessFrameCorrugation` 的旁证）
只取 `bad_row_frac`，所以只移 `_bad_rows`(10) + `_plane_detrend`(9) 这 19 行。

⚠️ `_drift_px` 尤其不要顺手补：它是 FFT 循环相关，而
`docs/handoff/survey-remaining.md` §3.4 第一行记着旧仓 2026-09-13 **明确把相位相关
换掉了**（沿慢轴绕回，「沿 y 挪 3 nm 量到 −0.06 nm」）。要用的时候该看的是那条记录。

**另一条照移的**：`detect_scan_artifacts` 在 `_detrend_rows(fwd).std() < 1e-9` 时
直接返回一个全默认的结果，而 `bad_row_frac` 的默认是 **0.0**。
Z 数据以米计（~1e-9），去趋势残差 ~1e-11 ⇒ **真机上这条早退几乎总是成立**，
于是 `bad_row_frac` 报的那个 0 的含义是「**没算**」而不是「没有坏行」。
本仓照移并把这句话写在 `scan-artifacts.ts` 的 `badRowFrac` 上。

## D-CLUSTER-1 · `AssessClusterRoundness` 读**裸块**，`ExtractClusters` 读归位后的帧

| | 取帧 | 阈值 | 预处理 | 裁行 |
|---|---|---|---|---|
| `ExtractClusters` | `sxm_oriented_frames`（反扫翻正、`SCAN_DIR: up` 上下翻） | `median ± 3σ_MAD` | 默认 **RAW** | **裁**（整行有限） |
| `AssessClusterRoundness` | **`scan["channels"][ch]` 裸块** | `mean ± 1.5σ`（或物理阈值） | 恒 OLS 平面 | **不裁** |

两处都照移。**不是笔误，也不是可以顺手统一的东西**：

* 分割口径的差异写在 `ExtractClusters` 的**模型可见描述**里（「注意它是另一套分割，
  不是这一套的封装 …… **同一帧会得到不同的 blob**」）—— 统一它等于让那句话变成假话；
* 而取帧那一处**是旧仓的现状**：`AssessClusterRoundness` 拿的是裸块，于是一张
  `SCAN_DIR: up` 的帧在它这里是上下颠倒的。这一条**没有跟着修**，因为修它会让
  这个技能的每一格金样改数，而本批没有一个用例能证明修完是对的
  （`ExtractClusters` 那一侧 2026-08-11 修这条时是拿真机 60 nm 帧量出 31.8 nm 的偏差的）。
  欠账写在 `analysis-clusters.ts` 的抬头。

## D-ANALYSIS-1 · 六个读 `.sxm` 的技能里，**只有一个**在报文里带异常类名

旧仓六个调用方里五个写 `f"…{exc}"`、一个（`ExtractClusters`）写
`f"…{type(exc).__name__}: {exc}"`。本仓 `loadSxm` 因此同时给 `why`（带类名）与
`plain`（只有那句话），各按各的用。

**统一成同一种写法会让六条报文有五条对不上，而改掉的是模型读的那句。**

⚠️ 操作系统那半句（`[WinError 2] 系统找不到指定的文件。` / `ENOENT: no such file or directory`）
带着**本机的语言环境**，两边措辞本来就不同。金样与测试在**两侧**都把它归一化成
`<oserror>`（导出器一组正则、测试一组同样的正则）——判据是它前面那半句：
谁在报、报的是哪条路径。


---

<!-- 并行支线的登记落点。**支线一律不编号**（留临时号），由主线统一编。
     每条支线只往自己那一行下面写，中间那行谁都不要动 —— 上一轮两条支线
     同时往文件末尾追加，它第一次成了冲突点。 -->

<!-- ── 批 4b（晶格判据底座 + 原子分辨判定一族）的登记写在这一行下面 ── -->

## D-LATTICE-1 · ±k 孪生峰**谁排在前面没有定义**

实信号的谱满足 `|F(−k)| = |F(k)|` —— 在精确算术里这是一个**精确的平局**，
而 `np.argmax` 的平局规则是「C 序里第一个」。于是谁排前面**完全由那一对的最后一位
浮点决定**：

| | |
|---|---|
| 金样 `hex` 第一对 | 功率**逐位相同** ⇒ numpy 取 C 序靠前的 `kx = −15` |
| 同一格**第三对** | numpy 自己那边就差一个 ulp（`…cec75` vs `…cec74`）—— **numpy 也不保证这个对称** |
| 本仓 | `fft2` 在第一对上差一个 ulp ⇒ 取 `kx = +15` |

⇒ 这是 **D-NUM-18 的形状**（「一格答案本身没有定义的金样更糟」）。本仓**不去追**：
下游没有一个消费方看得见这个差别 —— `uniq` 按 `angle mod 180` 去重、`measureCell`
把候选折到上半平面、半径散布取 `hypot`。

**测试**：`vision/lattice.test.ts` 的 `canonPeak` 把两侧都折到上半平面之后再比；
`nPeaks` / `nRidge` / `periodsNm` / `anglesDeg` / `hexagonal` / `latticeAngleDeg` /
`directionBalance` / `warnings` **一个不少地逐条比**，它们全都与这个符号无关。

## D-SHARP-1 · `_fft_sharpness` 旧仓在 **float32** 里做整条 FFT

`_detrend` 的输出是 `astype(np.float32)`；`_detrend(h) / std` 里的 `std` 是一个
**Python 弱标量**（NEP 50）⇒ 结果仍是 float32；而 `np.fft.fft2(float32)` 回
**complex64** —— 也就是说那次变换整条在单精度里。

本仓**只把输入降到 float32**（逐元素 `Math.fround`，两处都照抄），变换留在 float64：
复现单精度 pocketfft 要把每一次蝶形都降精度。差额写成一条推得出来的容差
`fftSharpnessRelTol(sharp) = 8·eps32·sharp`（`vision/tip-metrics.ts`）——
它**随锐度线性放大**，因为单精度 FFT 的本底噪声与 `‖F‖∞` 挂钩而 `sharp = peak/median`。

⚠️ 判据 `sharp < sharpness_min(8)` **没有被这条容差威胁到**：金样里离闸门最近的一格
是 `noise` 的 **3.559**（闸门 8.0，余量 2.2 倍），而那一格的容差只有 `3.4e−6`。

（2026-09-17 订正：这里原本写的是 3.63 —— 金样里根本没有这个值，最小的两格是
3.559 与 3.732。余量那句是对的，错的只是那个数。现已由 `lattice.test.ts` 钉住。）
实测最坏占比 `0.32`（`hex`，`1.6e−3` / `5.0e−3`）。

**另一半照抄了**：`detrend32` 的输出必须**是**一个 float32，
而这一条用一条**结构性**断言钉住（`v === Math.fround(v)`，零容差）——
容差那一条看不见它（一个 ulp 的窗，而去掉 `fround` 只挪半个 ulp），
变异演练当场照出来了。

## D-SUPER-1 · `superstructure_test` 的相干求和只能给**绝对**容差

`_max_over_neighbourhood` 算的是 `Σ hw·e^{-2πik·r}`。对一个**对照**波矢，这是
三万多个 `~1e−11` 的数相加得到 `~1e−14` —— **相消了三个量级**。
相消毁掉相对精度、不毁绝对精度，所以容差按 `Σ|hw|` 定：
`coherentAbsTol(n, sumAbs, wsum) = 2·n·eps·sumAbs/wsum`（`vision/lattice-cell.ts`）。

第二个理由更硬：numpy 那两步是 **`@` 矩阵乘**（BLAS 分块累加），
**不是** `np.add.reduce` 的成对求和 —— 也就是说这一处**没有可照抄的累加顺序**
（`numerics/pairwise.ts` 能逐位复刻的是后者）。
判决离阈值最近的一格是 `1.25`（闸在 1.2 / 1.5），而这条界给出的相对误差在 `1e−7` 量级。

> ⚠️ **对照波矢本身不在这条偏差里**：`np.random.default_rng(0)` 抽的那 8 个点
> 本仓**逐位复现**（`numerics/pcg64.ts`）。`rng.ts` 抬头那句「复现它要实现一个
> 128 位状态的 LCG」现在有了下文 —— 实现了，而且四层（pool / state / raw / uniform）
> 各比一遍。这与 D-VISION-1（RANSAC 的抽样序列**不**追 numpy）是同一条判据的两侧：
> 追不追，看的是**对面有没有一个被比的答案**。

## D-LATTICE-2 · 同一件事两套措辞，**两套都照移**

| 事 | `_sxm_frame.load_frame` 那一族 | `atomic_lattice._load_frame` 那一族 |
|---|---|---|
| 通道不在 | `没有通道 'Z' 的正扫数据` | `文件里没有通道 'Z' 的正扫数据` |
| 头里没有像素标度 | 当场报 `文件头里没有像素标度` | **不报错**，把 `null` 传给判据环 ⇒ 出局词 `unknown_pixel_size` |

第二行不只是措辞：后者给的是一条**机器可判**的出局词，调用方据此判「这一帧回答不了」；
前者给的是一句中文串，调用方只能去匹配散文。**后者更好，而本仓两种都照移** ——
统一成一种会让金样里四条报文有两条对不上，而改掉的正是模型读的那一句
（同 D-ANALYSIS-1 的形状）。

`loadFrame` 因此带一个 `requireScale` 开关，两个技能族各传各的；
一条变异（`skill-load-frame-scale-requirement-differs`）钉着它。

## D-LATTICE-3 · 两个 `_MIN_PERIODS_IN_FRAME`，同名不同值

| 住在哪 | 值 | 它在挡什么 |
|---|---|---|
| `atomic_phase`（判据） | **5** | `seg_scale_adaptive` 把可搜周期上限压到 `min(H,W)/4` ⇒ 短边不足约 4.75 个周期时，晶格那根谱线**根本不在搜索区间里** |
| `lattice_cell`（测量） | **12** | 谱心的直流裙边：周期越长的候选越靠近谱心，越容易赢在背景上而不是赢在结构上 |

本仓给了两个名字（`PHASE_MIN_PERIODS_IN_FRAME` / `CELL_MIN_PERIODS_IN_FRAME`）
并且**两个都导出**。登记它的理由与 **D-PIEZO-1** 一字不差：
「名字一样的两件事，连发现它们不一样都要先花一分钟」——
而合并它们会让判据在 2.4 倍的尺度上错。


<!-- ── 批 4c（paper 数据处理 + scan_frame 一族）的登记写在这一行下面 ── -->

## D-JUMP-1 · `DetectAtomJump` 的 `method` 报的是**请求**，不是跑了哪一条

| | |
|---|---|
| **Python** | `"method": "cnn" if model_path else "statistical"` |
| **我们** | 恒为 `"statistical"` |

`_cnn_detect` 抛异常时旧仓 `logger.warning` 之后**落回统计**，而 `method` 那一行
在返回值里，看的是 `model_path` 这个**入参**。于是「CNN 跑失败了」这件事
外部一个字都读不到：返回值说 `cnn`，数却是统计那一支算的（金样
`model_path_says_cnn` 与 `json_jump` 的 `confidence` **逐位相同**，那就是证据）。

本仓没有 CNN 那一支（`onnxruntime` 要等 Phase 8），照抄会让这个字段
**永远**说谎，而不只是偶尔。

**同族的 `Denoise_AE` 在同一个位置上是对的**：它在 `except` 里把 `method` 改成
`"gaussian"`。同一天写的同一个模式，一个报实际、一个报请求 ——
本仓跟对的那个（D-SCAN-4「回声不是读数」同一条）。

**两侧都钉住**：`paper-skills.test.ts` 的 `D-JUMP-1` 两条，一条断言旧仓那一格
确实报 `cnn` 且数与统计支相同，一条断言本仓报 `statistical` 且别的字段一个不差。

## D-JUMP-2 · 统计回退的 z 分数**上限是 2**，而缺省阈值是 3

**照移，没有修**（与 D-CLUSTER-1 同一种处理）。这里登记的是一条**旧仓的缺陷**：

```
z = |mean₂ − mean₁| / std(整条曲线)
```

中点劈开时整条曲线的方差是 `s² + (d/2)²`（`s` 组内、`d` 两半均值差），于是

```
z = d / √(s² + d²/4) ≤ d / (d/2) = 2        （s → 0 取等）
```

**与跳变有多大无关** —— 跳得越高分母跟着长。参数声明里 `threshold` 的下界是
`1.0`、缺省 `3.0`，也就是说**缺省参数下这个技能永远报不出它名字里那件事**。
金样十一格里只有 `threshold_1_jump`（阈值 1.0）那一格 `jumped: true`。

另外 `confidence = min(1, z / (2·threshold))` 拿**阈值**当尺度 ——
同一条曲线在 `threshold=1` 上「置信度 1.0」、在 `3` 上「0.33」。
那不是置信度，是「离阈值多远」。照移。

修它要换判据本身（Welch t 或者真的 CUSUM），**那是另一个技能**。

## D-DRIFT-1 · `ComputeDriftVector` 的中心差一格，而空缓冲上它报半幅

两件事，都**照移**（金样把旧仓那一侧钉住了），但都要写下来：

**① 偶数边长上系统性偏一个像素。** `scipy.signal.correlate2d(mode='same')` 的
原点是 `(M−1)//2`，而技能拿 `shape//2` 当中心（D-NUM-19：两个都是 scipy、
两个都叫「中心」）。于是一次**完美的**配准被报成 `−1` 像素：
金样 `ok` 那一格真位移是 `roll(ref, +3, −2)`，报出来是 `(−4, +1)`。
256 px / 10 nm 的帧上那是 39 pm 的凭空漂移，每一帧都有。

**② 一片死平的缓冲上，它报半幅。** 去均值之后整幅是 0 ⇒ 互相关面处处是 0 ⇒
`argmax` 落在下标 0 ⇒ 位移 `= −(shape//2)`。`success: true`，四个数一个不缺，
**没有任何字段说得出「这两帧里没有可对齐的东西」**。
这一条是对真 stmsim 的 e2e 当场撞出来的（模拟器刚起来时缓冲整幅 65536 个 0，
报出 −5 nm 的漂移），钉在 `integration/paper-drift.test.ts`。

⚠️ 顺带：尺寸对不上那一支报 `drift = 0` **外加一个 `note` 键**，而成功那一支
**没有**这个键 —— 「0 是量出来的」与「0 是量不了」靠一个键在不在区分。照移。

## D-PAPER-1 · 解析器与操作系统的异常文本**不复刻**，判据是前半句

四处，都是 `f"…: {exc}"` 把别人的异常拼进报文：

| 报文 | 那半句是谁的 |
|---|---|
| `invalid regions JSON: …` | Python 的 `json` ／ V8 的 `JSON.parse` |
| `Failed to load current trace: …`（JSON 那一支） | 同上 |
| `读不了 {path}: {类名}: {那句话}` | Python 的异常**类名** + `read_sxm` 的措辞 |
| `cannot load reference image: …` | `np.load` 的 `FileNotFoundError` ／ Node 的 `ENOENT` |

金样在**两侧**归一化（导出器一组正则、测试一组同样的正则）成
`<json-error>` / `<read-error>` / `<oserror>`；判据是它**前面那半句**
（谁在拒、拒的是什么），同 D-STS-1 与 D-ANALYSIS-1。

**分得开的那件事另有一条测试**：`读不了 X` 在本仓是 `ENOENT: …`（文件不存在）
与 `Cannot find header end marker in X`（不是个 `.sxm`）两句**不同**的话，
由 `paper-skills.test.ts` 专门钉住 —— 归一化抹掉的是措辞，不是区分。

⚠️ **一处反过来的**：`Cross-correlation failed: images must be same shape` 这句
**照抄了 skimage 的原话**。本仓 `phaseCrossCorrelation` 抛的是自己的中文措辞
（它有别的调用方），所以这一层在调用之前先判一次形状。判据没变（形状不等就拒），
变的只是谁来说这句话 —— 而这句话是模型读的那一句。

## D-PAPER-2 · `load_image_2d` 只落了**有读法**的三种扩展名

| 扩展名 | 旧仓 | 我们 |
|---|---|---|
| `.npy` · `.sxm` · `.dat` | ✓ | ✓ |
| `.3ds`（谱那一路） | ✓ | ✓ |
| `.npz` | `np.load` 解 zip | **没有**（本仓没有 zip 解压） |
| `.sm4` | `read_sm4` | **没有**（本仓没有这个读法） |
| `.txt` / `.csv` / `.asc` / `.tsv` / `.xyz` | `read_txt` | **没有** |

缺的三种**当场说清楚**（「本仓读不了 .npz —— 已实现的是 .npy / .sxm / .dat」），
而不是让 `decodeNpy` 去撞一个「魔数不对」：后者会让人去查文件，而文件没有问题。

⚠️ 这条让模型面的描述**超发了** —— 五个技能的 `image_path` 描述逐字冻结着
「`.npy/.npz/.sxm/.txt/.csv`」。**不改那句话**（改了就跟旧仓对不上，DoD ②），
错误报文已经把真相说清楚了。补上读法的时候这一条要回来删。

## D-PAPER-3 · `SubtractPlane_RANSAC` 在**带裙边**的真图上与旧仓不逐位一致

`np.random.default_rng(42)`（PCG64）与本仓 `Xoshiro128` 抽的是两串数
（D-NUM-7：RNG 求的是可复现，不是与 numpy 相同）。

金样那几张图上**答案相同，而且这不是运气**：背景是一张精确平面（或一口很浅的碗），
特征是**平顶圆盘**（高 5e-9，没有裙边），内点阈 1e-10 —— 于是任何一组
「三点全在背景上」的抽样都给出同一个内点集（933/1024，`ransac_facts` 单独录着），
最后那次全内点最小二乘两边解同一个方程组。

**真机上的图不是这样**：分子的裙边、台阶的边缘上有一圈像素的残差**正好在阈值
附近**，那时「先抽到谁」会改掉内点集，`inlier_ratio` 与 `plane_coefficients`
在两个实现之间没有理由相同，差多少也说不出来。同 D-VISION-1 的形状，
判据因此是**「离对的近、离错的远」**：`ransac_facts.lstsq_all_coefficients`
把「不剔除圆盘」那一版也录了下来，两者差 7 倍，测试比的是这个比。

## D-PAPER-4 · 三处照移的钝处，各记一笔

1. **`ParseRegions` 的 `angle_deg` / `label` 在 `try` 块外面。** 四个必填字段
   给一条 `success=False`，第五个直接**抛出去** —— 而这两件事对调用方完全不是
   一回事。金样 `raises_bad_angle` 钉着那一句（`ValueError: could not convert
   string to float: 'spin'`，本仓是同文案的 `RangeError`）。
2. **`SubtractPlane_RANSAC._load_image` 把三件事压成一句。** `try: … except:
   return None` 让「没给路径」「文件不存在」「不是个 `.npy`」都报
   `No image data available.`，而同族的 `FindEmptySpot` / `CorrectDrift_XCorr`
   **把异常带出来了**。一个族里两种做法，照移。
3. **`LevelLines_Median` 认不出的 `method` 什么都不做。** 旧仓没有 `else`，
   于是 `method="zzz"` 走完整个循环、一行都没改，返回值里 `method: "zzz"` ——
   只有 `rms_before == rms_after` 说得出「什么也没发生」。金样
   `unknown_method` 那一格就是为它录的。

## D-PAPER-5 · `poly2d_subtract` 那条 `i + j > order_x + order_y` 的裁剪是**死代码**

旧仓 `background.py:352` 写着 `elif i + j > order_x + order_y: continue`，
而循环是 `for i in range(order_x + 1)` / `for j in range(order_y + 1)` ⇒
`i + j` 的最大值**正好**是 `order_x + order_y`，那个 `>` 一次都不成立。

所以项数恒为 `(order_x+1)·(order_y+1)`（缺省 2×2 是 **9** 项，不是 6），
而 `n_coefficients` 那个字段就是证据：金样 `order31` 那一格是 **8** = 4×2。

本仓**不写那条永不成立的分支** —— 写一条进来，下一个人会花半天想它在挡什么。
盘点（`survey-remaining.md` A33）把它当成一条真的裁剪，那是读代码读出来的，
不是跑出来的。

<!-- ── 批 4d（composite.scan_at + 撞针追踪）的登记写在这一行下面 ── -->

## D-SCANRES-1 · `resolve_scan` 的三处 `human` f-string 在旧仓**抛 TypeError**，而它下面那句兜底因此是死代码

| | |
|---|---|
| **Python** | `note("line_time_s", line_time, …, human=f"{line_time:.4g} s/线")` —— 而 `_clamp` 是会给 `None` 的 |
| **我们** | 值是 `null` 时 `human` 也是 `null`（**不是 `0 s/线`**），`line_time` 随后落回内建默认 `0.5` |
| **金样** | `spec/golden/scan_resolver.json` 里 **4 格** `raised: {type: "TypeError"}` |
| **测试** | `kernel/src/scan-resolver.test.ts` → `TypeError 的那四格：本仓给一个值，而那个值不是 0` |

四个入口：`explicit.line_time_s` / `explicit.angle_deg` / `explicit.bias_v` 解不出数，
以及 `prefs.scan_speed_nm_s` 是个非数值字符串（`if pref_speed` 是**真值**判断，
一个 `'fast'` 会进那一支）。四条都从模型 / 偏好表直达，不是理论路径。

**连带的一件事更值得记**：`resolve_scan` 里那句

```python
if line_time is None:                    # pragma: no cover
    line_time = 0.5
    note("line_time_s", line_time, SOURCE_DEFAULT)
```

是**死代码** —— 每一条能让 `line_time` 变成 `None` 的路，都先在上面那个 f-string 上抛了。
`pragma: no cover` 让它看起来只是「测不到的兜底」，而它其实是「到不了的兜底」。
本仓补上 `human = null` 之后它**第一次真的可达**，也第一次有了一条测试。

**为什么不照移那次抛**：同 D-SKILL-3（旧仓抛 `IndexError` 的那一格本仓给一个值）。
模块自己的话是「偏好读不到绝不能让扫描失败」，而一个抛出去的 `TypeError` 正是让扫描失败。

**`human = null` 而不是 `0`**：`f"{None:.4g}"` 的替代品不该是 `0 V` / `0°` ——
那是给一个**没有的数**编一个读数，正好是这一层最该防的事。
变异 `scan-null-human-is-not-zero` 钉着它。

---

## D-SCANRES-2 · `int(float('inf'))` 抛的是 `OverflowError`，而 `_num` 的 `except` 收不住

| | |
|---|---|
| **Python** | `_num(value, int)` 的 `except (TypeError, ValueError)` —— `int(inf)` 抛的是 `OverflowError`，**漏出去** |
| **我们** | `pyInt(Infinity)` 给 `null` ⇒ 落到「档位表保证非空」那条兜底（`pixels = 256`，来源 `default`） |
| **测试** | `kernel/src/scan-resolver.test.ts` → `旧仓抛 OverflowError 的那一格：本仓给一个值` |

同一条在撞针追踪那边也成立：`_cell` 的 `round(float(x) / tol)` 对 `inf` 抛 `OverflowError`，
而它的 `except` 同样只收 `TypeError` / `ValueError` ⇒ **一次撞针记录把整个技能炸掉**。
本仓 `pyNum(Infinity)` 给 `null` ⇒ 进哨兵格：一个读不出坐标的撞针仍然是一次撞针。

`float('nan')` 两侧行为相同（Python 那边 `round(nan)` 抛 `ValueError`，被收住 ⇒ 哨兵格）。

---

## D-FLOAT-1 补充 · 第四份 `float()`，以及**原登记里一句说反了的话**

`kernel/src/scan-resolver.ts` 的 `pyNum` 是这一族的第四份（前三份见 D-FLOAT-1 那张表）。
它站在 `readback.ts` 的 `toFloat` 这一侧 —— 解析的是**调用方给的参数**
（显式覆盖、偏好表、档位表），不是仪器写出来的数据列。两处比旧仓严：

| 写法 | Python `float()` | `pyNum` | 为什么 |
|---|---|---|---|
| `'0x10'` | 抛 ⇒ `None` | `null` | JS 的 `Number('0x10')` 是 **16** —— 一个十六进制写法被当成十进制那个数送到硬件上（同批 3f 的 `lutValues`） |
| `'1_000'` | **1000.0** | `null` | 一个写成 `1_000` 的每线时间在旧仓是 1000 s/线 ⇒ clamp 到 600 ⇒ 256 线一帧 **85 小时** |

⚠️ **原 D-FLOAT-1 末尾那句「Python `float("1_000")` 同样是抛的」是错的。**
CPython 3.6 起 `float()` 认数字间的下划线；本机 3.13 实测：

```
'1_000' → 1000.0 · '1_0.5' → 10.5 · '1e1_0' → 1e10 · '_1' / '1_' / '0x10' → ValueError
```

也就是说「两者都不认下划线」在**本仓这一侧**成立，在**旧仓那一侧不成立** ——
这一条从此是一条真的偏差，不是一句「两边一样」。
（`si.ts` 的 `parseSi` 走的是另一条路，D-SI-2 不受影响。）

---

## D-SCANRES-3 · 档位表 / 偏好 / 针尖速度上限**由外面注入**，`preview()` 与写入路径不移植

| | |
|---|---|
| **Python** | `resolve_scan` 里三处「顺手读一下」：`_read_prefs()`（延迟 import `experiment_prefs`）、`_read_v_tip_max()`（读 `instrument_profile`）、`tiers_lookup or scan_policy`（模块级活动表） |
| **TS** | `opts.prefs` / `opts.vTipMaxMS` / `opts.tiers`，不给就是 `{}` / `2e-6` / `FACTORY_LOOKUP` |
| **测试** | `kernel/src/scan-resolver.test.ts` → `档位表由外面注入`；`composite/scan-at.test.ts` → 同名一组 |

同 D-VAC-1 / D-LIMITS-1 / D-PRESET-2：**限值与偏好是台架的属性，不是模块的属性**。
三条降级路径的**取值**逐字照移（旧仓读不到时给的就是这三个），换掉的只是「谁去读」。

**跟着不移的两块**：

* `scan_policy` 的**写入侧**（`sanitize` / `set_policy` / `set_persist_sink` / `format_policy_block`，
  约 300 行）—— 它们的消费方是**设置界面**，本仓还没有。`ResolverTier` 这个形状把
  「操作员表」留成一个**入参**，所以那一侧接上来的时候这里不用改；
  `_tier_source` 的三条支路今天就由金样里那张 `operator_tiers` 走到。
* `preview()`（38 行）—— 同一个消费方。`ScanAt` 一次都不调它。

**代价说清**：宿主没接偏好源之前，`SOURCE_PREFS` / `SOURCE_PREFS_DERIVED` 这两个来源
在真实运行里**一次都不会出现**，而金样里它们各有 4 格。这不是「写了没人用」——
它是那条优先级链本身，少一节链就断。

---

## D-SCAN-5 补充 · `ScanAt` 的来源表里那个空记号

`param_summary` 每一行是 `- name = {值} ← 来源`，而「不下发那个硬件写」的那几行值就是
一个空记号：Python 印 `None`，JS 印 `null`。沿用 D-SCAN-5 的判断：**为了逐字去写一个
Python 字面量，等于让这张给人看的表指向一门这里没有在跑的语言。**

登记方式也照旧：期望值在 `l0/traces.test.ts` 的 `scanAtNullRendering` 里
**从金样算出来**（一个 `.replace`），不是抄一遍。

**浮点那一半照移**：`1e-07` / `0.0` / `1.0` 走 `pyFloatRepr`，因为读的人要拿它跟面板上的
数比。为此 `TraceEntry` 多了一个**本仓新增**的 `isInt` 标记（JS 只有一种数，D-SI-3）——
全表只有 `pixels` 一格是 int。它是渲染提示，**不进报文**（`ScanAt` 的 `param_trace` 里把它剥掉）。

---

## D-CRASH-1 · 撞针追踪：住进程、限值注入、`snapshot().since_s` 是本仓新增

| | |
|---|---|
| **Python** | `_singleton` + `get_tip_crash_tracker()`；阈值 / 容差 / TTL 是 `__init__` 的默认实参；`clock=time.monotonic` |
| **TS** | `processTipCrash.{config, nowS, tracker}`；`getTipCrashTracker()` 惰性建 |
| **测试** | `kernel/src/tip-crash-tracker.test.ts` → `进程级追踪器` 一组 |

三个问题的答案写在 `kernel/src/tip-crash-tracker.ts` 的抬头里，这里只记结论：

1. **住进程级**，理由与进针拒绝闩逐字相同 —— 一根针、一块样品，「这个点已经撞过两次」
   必须跨调用、跨链活着。
2. **限值注入**（D-VAC-1 / D-LIMITS-1 / D-QPLUS-1 同一条）：8 nm 的「同一个点」取决于
   你在什么尺度上扫，30 分钟的 TTL 取决于漂移有多快。**墙钟**同样注入（D-VAC-2）。
3. **宿主不接 ⇒ 出厂默认生效，闸照常关**，不是 fail-open 成「没撞过」。留痕
   （D-DIAG-1 的 `ctx.markers.emit`）接不上时**拒绝照发** —— `crashGuard` 先判断、
   后留痕，留痕在自己的 try 里，变异 `tipcrash-diag-failure-is-not-a-pass` 钉着这个顺序。

**本仓新增 `snapshot().since_s`**（这台追踪器活了多久）。进程级不等于持久：本仓和旧仓
一样**不落盘**，宿主重启之后 30 秒前撞了两次的那个点重新变成「没撞过」。这是照移，
不是新增的洞；但它是**真的洞**，所以把出生时刻交出来 —— 「一条记录都没有」与
「我刚出生」是两句话，而只有前者能支持「这儿没撞过」。

`threading.RLock` 不移植，理由同 D-PRESET-3（Node 单线程，这些方法之间没有 `await`）。

---

## D-CRASH-2 · `FullScan` 的逐通道判语一律 `ch<编号>`，不带名字

| | |
|---|---|
| **Python** | 静态兜底探针表 `((0, "ch0"), (14, "Z"))` —— 第二项带着名字「Z」 |
| **TS** | 一律 `ch${channel}`（沿用 `crash-check.ts` 已有的口径） |
| **登记** | `l0/traces.test.ts` 的 `fullScanChannelLabels`，**只在真的走了兜底那条路的格子上** |

那个标签是一句**没核过的断言**：一路逐通道的判语，键上写着一个可能根本不是那路信号的
名字。2026-06-29 那个「撞针检查每一次都报 skipped」的缺陷，根就是同一个数字
（旧仓注释说标准模拟器上 Z 是 30）。

⚠️ **本机实测把那句注释推翻了一半**：`Signals_NamesGet` 的第 **14** 项正是 `Z (m)`，
`Scan_BufferGet` 回的是 `[2, [0, 14], 256, 256]`（**裸整数**，不是那串 1-元组）。
也就是说在这台机器上那张写死的表**碰巧是对的** —— 于是「探的是真正采到的那几路」
这件事，用默认通道跑一趟**证不出来**。集成测试因此换了一份通道清单（`channels: 'Z'`）
去证它：只采一路 ⇒ 只探一路，而静态表会给两路。

---

## D-CRASH-3 · `FullScan` 的视觉判语（`_vision_verdict`）不移植

| | |
|---|---|
| **Python** | 从 `buffer.active` 取最近一次针尖质量判定，贴 `vision_tip_quality` / `vision_tip_confidence` / `vision_note` 进 `data`，整段包在 `try/except → {}` |
| **我们** | 不写 |
| **影响面** | 成功路径上的 2–3 个字段 |

同 D-SCAN-4 / D-GRAPH-2：视觉链路本仓还没有，接一个永远返回空的读口，等于给下一个人
留一条永远不亮的分支。

**代价说清，因为它有代价**：2026-07-10 #88 那次，视觉模型一路说 `tip=bad`，而 agent
照旧旁白「图像质量正常」—— 它手上只有撞针检查，而撞针检查是**钝的**（方差接近零或 NaN）。
补视觉链路时必须连它一起补。

---

## D-CRASH-4 · `ScanAt` / `FullScan` 都不接断点

沿用 D-SCAN-3（`WaitScanComplete` 不接断点）：dsh 的一次工具调用不跨进程续跑。
两个技能的 `wait` 步仍然 `checkpointAfter: true` —— 判据留在内核里，介质由宿主接。

⚠️ 这一条对 `ScanAt` 比对 `WaitScanComplete` 更要紧：旧仓 2026-07-27 那次
`BatchRegionsScan` 假成功，正是五个 region 共用一份断点。本仓没有断点，也就没有那条路；
接上断点的那一天，`graph-executor.ts` 里那三条守卫（`isTerminal` / `dropStaleAbort` /
跑完删自己）要连着一起验。

<!-- ── 批 5a（针尖登记表底座 + TipPulse/TipShape + 两个 fail-open 自检）的登记写在这一行下面 ── -->

## D-TIP-1 结清 · 针尖安全包络已移植，`validateParams` 是实的

D-TIP-1 原文写的是欠账：「**没有写一个空的 `validateParams`** —— 写了会让人以为这道闸在。」
这一批把它写实了，**原文不改**（那是主线的编号区），在这里记结清：

| | |
|---|---|
| **落点** | `kernel/src/tip-registry.ts` + `tip-conditioning-policy.ts` + `tip-conditioning-resolver.ts`；技能层 `l0/tip-policy.ts` 的 `applyTipPolicy` |
| **闸装在哪** | `BiasPulseWithReadback` / `TipShapeWithReadback` / `TipPulse` 的 `validateParams`（内核 **K6**，任何硬件调用之前）；`TipShape` 在 `execute` 最前面（**照旧仓**，见下条） |
| **金样** | `spec/golden/tip_policy.json`（**新的专用驱动器**）：12 支针尖 × 23 个请求 = 276 格，111 格被拒（2026-09-19 补第 23 个请求 `shaper_depth_at_limit`，见 D-TIPDEPTH-1 末节） |
| **测试** | `kernel/src/tip-conditioning.test.ts`（287 条）· `l0/tail-l0-tip.test.ts`（31 条）· `integration/tip.test.ts`（5 条，对真 stmsim） |

⚠️ **D-TIP-1 原文里那句「铂铱（8 V）、qPlus（3 V）会被拒绝」在今天的旧仓已经不成立。**
2026-08-12 现场把两个上限**统一拉满**（逐字：「凭多年 STM 经验，这个安全包络定得过严、
没有实际意义」），于是全部档位一律 `max_abs_pulse_v = 10.0`、`max_poke_depth_m = 1.0e-8`。
我逐档核过：**现在还能分辨针尖的包络字段只剩 `max_pulse_count`（通用 5 / qPlus 2）**。
`kernel/src/tip-conditioning.test.ts` 有一条测试把这三组值钉住 —— 哪天旧仓再收紧，它会变红。

**这不代表这道闸是摆设**：① `TipPulse.count` 的声明上限是 **50**，包络是 5（qPlus 2）——
K6 的范围检查放行的值这道闸会拒；② 宿主覆写可以**收紧**（`processTipRegistry.overrides`）；
③ 它在任何硬件调用之前拒，而全局 ±10 V 的 SafetyGate 只按**参数名子串**判，
**不知道台上装的是哪根针**。

## D-TIPREG-1 · 针尖登记表：住进程、由外面注入、宿主不接时闸照常关

| | |
|---|---|
| **Python** | `tip_state` 的模块级 holder + `threading.RLock`，真源是 SQLite 的 `tips` 表；覆写延迟 import `SettingsStore` |
| **TS** | `processTipRegistry.{current, overrides}`（与 `processTipCrash` / `processVacuum` 同一族），**没有那张表** |
| **测试** | `kernel/src/tip-conditioning.test.ts` → 「针尖 holder」一组 |

三个问题的答案写在 `kernel/src/tip-registry.ts` 的抬头里，这里只记结论：

1. **住进程级** —— 一根针、一块样品，「现在装的是一支 qPlus」必须跨调用活着；
2. **由宿主注入**（`setCurrentTip` / `.overrides`），一个字段都不猜；
3. **不接 ⇒ 未登记 / 空覆写 ⇒ 通用保守档生效，闸照常关**，不是 fail-open。

⚠️ 旧仓 `tip_conditioning_resolver` 的 docstring 曾写着「未登记针尖时不拒绝任何东西
（fail-open，与 sample_gate 同款）」——**那句是假的**（旧仓 2026-08-10 自己更正过）：
未登记走通用档，而那一档有自己的包络。fail-open 的是**另一道门**（`qplus_gate`，
而且出厂就是关的）。两道门两条哲学，那段注释把其中一道的性质安到了另一道头上。
变异 `tip-unregistered-is-not-fail-open` 把那句假话变成真的，8 条测试当场变红。

`threading.RLock` 不移植，理由同 D-PRESET-3 / D-CRASH-1（Node 单线程，这些方法之间没有 `await`）。

## D-TIPREG-2 · 词表归一**挪到了 holder 入口**（旧仓在 `register_tip` 工具层）

| | |
|---|---|
| **Python** | `normalize_material/fabrication/form` 由 `register_tip` 工具调用，存进库的已是词表值；holder 只转存 |
| **TS** | `setCurrentTip()` **自己归一**；认不出的写法留**空**（不是留原文） |
| **测试** | `tip-conditioning.test.ts` → 「入口归一」「认不出的写法留空」 |

本仓没有 `register_tip` 那一层（也没有那张表），归一没有第二个落点。不归一的话，
一行 `material: "钨"` 会在方案表里**静默落到通用档** —— 而「静默落到一个更宽的档」
正是这道闸最不该有的失败模式（qPlus 那一档的发数上限是 2，通用档是 5）。
变异 `tip-registry-normalizes-at-the-door` 钉着它。

## D-TIPREG-3 · `TipShapeWithReadback.validateParams` 是**本仓新增**

旧仓这个技能**没有** `validate_params`，而它的孪生兄弟 `TipShape` 在 `execute` 最前面就过一遍
针尖包络。两个技能下发的是**同一串** `TipShaper_PropsSet(11 参)` + `TipShaper_Start`，
也就是对针尖做同一件事，却一个有闸一个没有。这种不对称正是「同一条判据的两份实现，
改了一处另一处还是旧的」那一类（本仓在粗动那次付过账）。判据与 `TipShape` 那一侧逐字同源。

**金样照不出这一条**：导出器直调 `execute`。它由 `tail-l0-tip.test.ts` 的三条与变异
`readback-tip-envelope-is-wired` 看着。

## D-TIPREG-4 · `TipShape` 的包络在 `execute` 而不是 `validateParams`（**照旧仓**）

`TipPulse` / 两个读回技能的包络都在 K6；`TipShape` 这一个在 `execute` 最前面。
不是漏了：它的两个策略字段（`shaper_bias_v` / `shaper_lift_v`）要先经过「方案表填不填」
这一步才知道最终值是多少，而 `validateParams` 拿不到那一步的结果。
代价说清：**K6 的拒绝会进拒绝台账，`execute` 里的拒绝是一次失败的调用**。
两者对模型都是「为什么被拒」，对记录侧不是同一件事。

## D-TIPREG-5 · `qplus_gate` / `allow_on_qplus` **不移植**

| | |
|---|---|
| **Python** | `_tip_policy.qplus_gate`：qPlus 针尖上的「戳表面」类操作要显式 `allow_on_qplus=true` |
| **TS** | 不写。`allow_on_qplus` 这个参数**在本仓没有消费方**（它在声明里，模型看得见） |

它**出厂就是关的**：`_guard_on()` 读 `MAST_QPLUS_POKE_GUARD`，默认 `"0"`，第一行就 `return None`。
2026-08-16 现场逐字：「**一道每次都被同一个人用同一句话解开的门，不是保护，是仪式。**」
移不移它对默认行为**零差别**，而移过来等于在本仓多一个「看起来在挡、其实关着」的东西。

⚠️ **代价说清**：`TipShape` 声明里 `allow_on_qplus` 的描述写着「否则 qPlus 针尖一律**拒绝**」
—— 那句话**在旧仓也已经是假的**（门关着）。模型可见面逐字照移（DoD ②），所以那句描述留着，
而本仓没有任何东西在执行它。**真正护音叉的那两样都在**：扎针深度包络 `max_poke_depth_m`
（超了拒绝不夹紧，就在这一批里）与「扎针前把偏压缓降到 20 mV」（`shaperBiasDefault`
那条「跟随成像偏压」，批 3j 已落 —— qPlus 实验里成像偏压就是 20 mV 本身）。

## D-SELFCHK-1 · 两个自检：**依赖缺席 ⇒ `ok=false, blocking=true`**（有意与旧仓不同）

| | |
|---|---|
| **Python** | 每一处 `except Exception → add(…, None, "查不了（…）")`，而 `add()` 的规则是 `ok is None` **只进 warnings**；`ready = not blockers` ⇒ 打出「✅ 可以开工」 |
| **TS** | 依赖不在 ⇒ `ok=false` 且 **blocking**，措辞点名缺的是哪个子系统、在哪一批 |
| **测试** | `tail-l0-tip.test.ts` → 「依赖缺席 ⇒ 进 blockers，不是 warnings」；变异 `selfcheck-missing-dependency-blocks` |

⚠️ **我跑了一遍旧仓，照出来的比盘点说的还要直白**（`skill_traces.json` 的
`TipForgeSelfCheck/ok`）：那一趟**一个 `except` 都没触发**（旧仓依赖全在），而 `ready` 仍然是
`true` —— 因为「衬底可解析」那一条 `ok=False` 是 **`blocking=False`** 写的。
也就是说通往假许可有**两条**路：依赖缺席（`None`）与「失败但不阻塞」（`False, blocking=False`）。
前者这一批改掉，后者照移（它是旧仓刻意的分级）。

本仓这两个自检现在几乎必然报「❌ 还不能开工」—— **那正是真话**：`_tip_phases` 的六个特异化
流程一个都不在，扫描地图与仪器档案也不在。一个在这种状态下说「可以开工」的自检，
比没有这个自检更糟。

## D-SELFCHK-2 · 自检的 `registry` 那一项**换了不变量**

| | |
|---|---|
| **Python** | 查「冻结打包时 `walk_packages` 不跑、包 `__init__` 没 import 到的模块里的技能会**静默消失**」（2026-08-04 真机一次丢 19 个、另一次 141 个） |
| **TS** | 查「`REQUIRED_SKILLS` 里还有几个没移植」 |

本仓是静态 `import` + `export const`，掉一个技能是 `tsc` 编译错误 ——
**这个不变量在 TypeScript 里不存在**。同一个位置、同一种后果（有一条链是断的，而且断得
很安静），判据换成本仓真有的那一个。

## D-SELFCHK-3 · 自检里**不移**的四项

| 项 | 为什么 |
|---|---|
| `TipForgeSelfCheck` 第 6 项（电流监控豁免表 `tip_intent.TIP_WORK_PATTERNS`，约 30 行） | 本仓没有电流监控。**自检一张没人读的表，绿了也不代表任何事** |
| 第 7 项（地图标记归类 `io/exp_map._SKILL_KIND_RULES`，约 50 行） | 本仓没有实验地图，同上 |
| 两份的「操作模式」 | 运行模式住在 `stm-safety` 插件里，技能层够不着；再开一个进程级 holder 会造出**第二个真源**（内核 K7 那道闸读的是插件那一份）。旧仓这一项本身也只是信息项（`except: pass`），真正拦人的是模式闸 |
| 旧仓两份对 Tip Shaper 那一句措辞差一个「模块」 | 本仓两处共用同一句。同一件事两句话，多的那一句只会漂 |

## D-SELFCHK-4 · 「未登记针尖」那句话**改了**：不写断言，写实测

旧仓 `TipConditioningSelfCheck` 那一句是：「未登记 —— 安全包络退到保守通用档，
流程默认的 10 V 大修脉冲**会被拒**。先 register_tip。」

**后半句是假的**（2026-08-12 之后通用档也是 10.0 V，`abs(10) > 10` 为假）。
写这句话的时候它是真的（通用档当时 6.0 V）—— 「修好之后旧理由会静静变成假话」。
本仓这一句**拿同一台解析器真判一次**，说它到底拒不拒，并把当前包络三个数印出来。
于是下次有人改包络，这句话自己跟着变。

## D-TIPREG-6 · `ResolvedConditioning.warnings` / `FIELD_OWNERS` / `policy_summary` / `envelope_of` 的去留

旧仓这四样**在全仓零消费方**（我 grep 过整个 `MASTv2`）：

* `warnings`：**没有一处写入、也没有一处读出** ⇒ **不移**。一个永远是空表的字段，
  读的人只会以为「这次没有警告」。
* `policy_summary` ⇒ **不移**（消费方是设置界面，本仓还没有）。
* `FIELD_OWNERS` ⇒ 移，但**唯一的读者是导出器**（它是「这一档可能有哪些字段」的行标题）。
* `envelope_of` ⇒ 移，因为本仓给了它第一个调用方：`TipConditioningSelfCheck` 要把
  「这支针尖现在的上限是多少」印出来。

## D-TIPREG-7 · `tip_state` 的渲染层（约 200 行）**不移**

`format_tip_block`（注入块）+ `_service_days` / `_fmt_hz` / `_bias_polarity_line` /
`_preamp_line` / `_MATERIAL_NOTES` / `_FAB_NOTES` / `_QPLUS_POKE_NOTE` / `auto_name` /
`*_candidates` / `*_LABELS`：消费方是两样本仓还没有的东西 —— **提示块的针尖段**
（要 `instrument_profile` 的偏压极性与前置放大器两个字段，批 5c）与 **`register_tip` 工具**
（要那张 SQLite 表）。消融精神：没有消费方的形状不移。

⚠️ 这里面有一段**值得单独盯着**：`_QPLUS_POKE_NOTE`（每一轮都进模型上下文的那段
qPlus 说明）。2026-08-17 之前它写的是「戳表面类处理有毁掉音叉的风险…默认拒绝」，
两处都不成立，而且造成了真实伤害（模型在该动手的时候回来问「要不要扎针」）。
接提示块时**要接的是改过之后那一版**，不是它的前身。

## D-TIPREG-8 · `module_down_hint` **不移**（跟着 `TipShapeWithReadback` 走）

旧仓在 `TipShaper_PropsSet` / `TipShaper_Start` 的错误路径上追一句「去 Nanonis 里打开
Tip Shaper 模块」，判据是错误文本里有没有 `not running` / `未运行` 那一族子串。
批 3j 的 `TipShapeWithReadback` 已经没有移它，`TipShape` 跟着它走 ——
**两个下发同一串命令的技能不该一个有一个没有**。整条 `_preflight.py`（探针表 +
`_DOWN_SIGNATURES` + `_AMBIGUOUS` + `preflight_modules`）留给批 5c。
**金样照不出这一条**：通用注错文案是「连接被对端关闭」，不命中任何一个子串。

## D-TIPREG-9 · `TIP_SOURCE_*` 带前缀，而 `scan-resolver` 那一族不带

不是风格问题：那边的 `SOURCE_DEFAULT` 是 `'default'`，这边是 `'factory_default'`。
**名字一样、值不一样**的两个常量放在同一个 `export *` 出口下，读的人只会看见离他最近
的那一个（D-CHANNELS-1 / D-PIEZO-1 记过同一件事的两个面）。`'explicit'` 两边同值，
但一族里挑一个不带前缀，会让人以为另外三个也在那边有对应物。

## D-TIPREG-10 · 原子相判据干跑的**反例**换了：噪声不来自 numpy

| | |
|---|---|
| **Python** | `np.random.default_rng(0).normal(0, 2e-12, (128,128))` |
| **TS** | 本仓 `Xoshiro128`（固定种子）叠 12 个均匀数（Irwin–Hall，方差正好 1） |

本仓 `Pcg64` 只到 `uniform` —— numpy 的 `normal` 走 ziggurat（一张 256 格的表 + 拒绝采样），
移它是另一件事；而**这里要的性质是「不是晶格」，不是「是高斯」**。
**不用真随机数**：一个每次都换一片噪声的自检，红了你不知道是判据坏了还是这次的噪声
刚好像晶格（同批 3j「金样要可复现」那条）。

正例（三个 60° 方向余弦和、10 pm、a=0.2494 nm）与旧仓逐字同源。
变异 `selfcheck-dry-run-needs-a-counterexample` 钉着「必须有一个会被拒的样本」。


<!-- ── 批 5b（A 档零散一批（各自自足，不压子系统））的登记写在这一行下面 ── -->

> **批 5b 的六条。编号是临时的**（我按 `D-PSD-*` / `D-WATCH-*` / `D-B5B-*` 编，主线统一改）。

## D-PSD-1 · 一个解析不了的 `freq_range_indices` 要**说出来**，不是只写进日志

| | |
|---|---|
| **Python** | `logger.warning("AcquirePSD: invalid freq_range_indices %r (%s); falling back to single-range mode.")` 然后退回单量程 |
| **TS** | 同样退回单量程，但**多一个字段** `data.freq_range_indices_ignored`（原样带着那串没解开的文本） |
| **测试** | `l0/batch5b.test.ts` 的 `psd/bad_indices_json` 那一格：先钉住**金样里没有**这个键，再断言本仓有它且等于入参 |
| **变异** | `psd-ignored-list-is-reported` |

**为什么有意**：日志**不跟着回包走**。模型看到的是 `per_range` 里一段谱，而它请求的是三段 ——
两者之间的差别只存在于宿主的日志里，而调用方读不到日志。这与 `BatchRegionsScan` 的
「`fail_count` 躺在 `data` 里而没有人读 data」是同一种失败：**一件事发生了，而唯一记下它的
地方不在收信人手上**。

⚠️ 这是本批**唯一一处「本仓说的话比旧仓多」**，所以两侧都钉住了：旧仓哪天把这句话
加进回包，那条断言（`want['freq_range_indices_ignored']` 必须是 `undefined`）会当场变红。

---

## D-PSD-2 · 配置相的四次调用**失败即忽略**，真相要等 `DataGet` —— 照移，代价记在这里

| | |
|---|---|
| **Python** | `_phase_configure` 里 `SpectrumAnlzr_Run` / `FreqResSet` / `FreqResGet` / `ChGet` 四条**都不检查 `rec.error`**（只有 `ChSet` 检查） |
| **TS** | 逐条照移 |
| **测试** | `l0/batch5b.test.ts` 的 `psd/chset_rejected`（唯一早退的那一条）+ 集成测试 `AcquirePSD` 那一格 |

旧仓给的理由只有半句（`Run` 幂等、模块已在跑时会回无害的警告），另外三条没有理由，
就是没查。

**代价在真模拟器上当场量到了**（`integration/current-diag.test.ts`）：stmsim 上
`SpectrumAnlzr` 模块**根本没装**，于是 `Run` / `FreqResGet` / `ChGet` 三条全带着
`NanonisError: NeedModule: Cannot access the 'SpectrumAnlzr' module.` 回来，
而技能一声不吭地往下走 —— 直到 `DataGet` 才把这句话交出去。
`channel_index` 因此是 `-1`（"没读到" 与 "第 -1 路" 共用一个值）。

也就是说：**「模块没装」这条信息在第一次调用就有了，而技能要到第六次调用才说得出来**。
不改，因为改它会让「模块已经在跑」这种真实情形变成一次失败；但下一个人如果要修，
该修的是**分辨这两种错**（`NeedModule` 对别的），而不是简单地把四条都改成早退 ——
Osci1T 那三个技能已经有现成的分流范式（`CUSTOM_ERRORS` 的 `need_module@0`）。

---

## D-WATCH-1 · `WatchScanLines` 与 `AssessAtomicLines` 共用**那份修好的** `resolveReadout`

| | |
|---|---|
| **Python** | 两个技能都 import `_scan_readout.resolve_readout`，而那份实现里「按信号名找 Z」那一支是**死的**（D-ATOMLINE-1） |
| **TS** | 两个技能都走 `l0/analysis-lines.ts` 的 `resolveReadout` —— 也就是**已经修好**的那一份 |
| **测试** | `l0/traces.test.ts` 的 `WatchScanLines/*` 四格 + `integration/current-diag.test.ts` |

D-ATOMLINE-1 登记的是「本仓把 `body[2]` 当名字表，于是那条支路真的能命中」。
这一条只补一句**射程**：那个修复**同时**改了 `WatchScanLines` 的行为，
因为旧仓那份 `_scan_readout.py` 的抬头写得很清楚 ——
「两个技能各写一份的下场是两边迟早只有一边对」，所以本仓也只有一份。

**本机实测（真 stmsim）**：`Scan_BufferGet` 回 `[2, [0, 14], 256, 256]`，
`Signals_NamesGet` 的第 14 项正是 `Z (m)` ⇒ `channel_source` 是
**「按信号名 Z 解出」**而不是兜底。旧仓在这台机器上会落到兜底那一支
（兜底恰好也给 14，所以**答案相同、理由不同**）—— 而缓冲里出现第三路时两者就分岔了。

---

## D-ZERO-1 补充（批 5b）· 四处**照移的 `or`**：显式的 `0` 退回缺省（与 D-ZERO-1 方向相反）

| 位置 | 旧仓 | 后果 |
|---|---|---|
| `RecoverTipFromSaturation.max_coarse_steps` | `int(params.get(...) or 800)` | 「一步粗动都不许走」这个意图**表达不出来** |
| `ClassifyUnexplainedCurrent.repeats` | `int(params.get("repeats") or 3)` | `repeats=0` 退回 3（而声明的 `min_value` 是 1，所以内核先拦） |
| `WaitForThermalSettle.max_rate_k_per_min` / `timeout_s` / `window` | `float(params.get(...) or 缺省)` | 同上；`window=0` 退回 6 |
| `MonitorCurrentFFT.window` / `output` | `(params.get(k) or "hann").lower()` | 空串退回缺省（而不是「不加窗」） |

| | |
|---|---|
| **TS** | 逐处照移 |
| **测试** | `l0/batch5b-edges.test.ts` 的「照移的三处 `or`」一组 |

**为什么登记**：本仓的通则是 D-ZERO-1 ——「一个合法的 `0` 被 `x || 缺省` 吃掉」是本项目
反复抓的那类缺陷。这四处**是同一个形状，而我们照移了**，所以必须写下来，否则下一个人
会把它们当成 bug 顺手「修好」，而那一改就是**行为变更**（金样会红，但红的时候没人知道
该改哪边）。

⚠️ 四处里有三处**被内核的边界检查挡在前面**（`min_value ≥ 1` / `≥ 0.001` / `≥ 10`），
也就是说模型那条路上根本传不进 0 —— 只有直调 API 走得到。`max_coarse_steps`
的 `min_value` 是 **0**，所以它是四处里唯一一个**模型真的能踩到**的。

---

## D-BATCH-1 · `BatchRegionsScan` 的 `angle_deg` 在 `try` 外面，坏值会**抛**

| | |
|---|---|
| **Python** | `ang = float(it.get("angle_deg", 0.0) or 0.0)` 写在捕获 `KeyError/TypeError/ValueError` 的 `try` **之后**（`batch_regions_scan.py:180`） |
| **TS** | 照移（`kernel/batch-regions.ts` 的那一行带 ⚠️ 注释） |
| **测试** | 没有专门用例 —— 与 `ParseRegions` 那一条（`raises_bad_angle`）同形，判据在代码抬头 |

四个必填字段给一条 `success=False`，第五个给一次**异常**，而这两件事对调用方完全不是
一回事。与 `ParseRegions` 的同名钝处并列登记 —— 要修的话，修的是旧仓，而且要**一起**修
两处（不然本仓会出现「同一个坏 `angle_deg` 在两个技能里两种下场」）。

顺带一条**两份实现刻意不合并**的提醒：`ParseRegions` 与 `BatchRegionsScan` 的区域校验
边界值一模一样（±1 mm、1e-10…1e-5 m、最多 64 个），**措辞与报错粒度不同**，而且
`label` 的缺省规则不同（`"label" in rec` 对 `str(... or f"R{i+1}")`）、空数组的结论相反。
合并会让至少三格的答案变掉。理由写在 `kernel/batch-regions.ts` 的抬头。

---

## D-CLOCK-1 补充 · 批 5b 的两个轮询技能

`MonitorCurrent` / `MonitorCurrentFFT` 加进 `clockApprox` 那一组，并给
`CLOCK_KEYS` 补了四个叶子：`contact_at_s`（何时判到接触）、
`nyquist_hz` / `df_hz` / `freqs_hz`（频率刻度 = 实测采样率 ÷ 点数）。

理由与批 3j 那三个逐字相同：导出脚本的假钟是 **1e6 秒 / 每读 +1e-3**，本仓夹具是
**1e6 毫秒 / 每读 +1**，于是同一个时刻在两边差第 10 位。实测最坏 **4.7e−8**
（`actual_fs_hz`），容差 1e-6，占 4.7 %。

**判据字段一个都不在那张表里**：`n_samples` / `contact_detected` / `min|max|mean|std_abs_a` /
`samples_a` / `window` / `output` / **`spectrum`** 全部逐位比。
`spectrum` 尤其**不能**进那张表 —— 它按 `max(1,|a|)` 归一，而 PSD 的量级是 1e−22，
那条容差会退化成「绝对 1e−6」，也就是什么都不判。谱由
`l0/batch5b.test.ts` 的 `spectrumTol` 单独比（按**整幅谱的最大值**归一，
`4·fftRelTol(n)`，power 档另加一个 `CLOCK_REL`）。

⚠️ 还有一条**只在这两个技能上成立**的事实：`actual_duration_s` 是
「最后一次读钟减 t0」，所以**读钟的次数**也是判据 —— 落地当天就撞到了：
外层多读了一次 `now()`，`actual_duration_s` 就整整差 1 ms（远超那条 1e-6 的容差）。
`pollCurrent` 因此把 `t0` **交出去**而不是让调用方自己再读一次。


<!-- ── 批 5c（仪器档案 + Z 稳定 + 粗动驱动三个子系统）的登记写在这一行下面 ── -->

<!-- 批 5c：以下 12 条的**编号留空**（`?`），由主线统一编。 -->

## D-PROF-1 · 仪器档案**由外面注入**，而「没接」是一个说得出口的状态

| | |
|---|---|
| **Python** | `instrument_profile` 是一个模块级 `_profile` dict，空档案 = `{}`；模块永远在，所以「读不到档案」只有 `import` / 属性访问抛异常那一条路 |
| **TS** | `processInstrumentProfile.source`（读口函数）。`source === null` = **宿主没接**，与「档案是空的」是两回事 |
| **测试** | `kernel/src/instrument-profile.test.ts` → 「三态」那几组；`l0/calibrations.test.ts` → 「两种否定」 |

同 D-VAC-1 / D-LIMITS-1 / D-PRESET-2：**档案是台架的属性，不是类的属性**。

做成读口而不是一份快照，是为了让「宿主根本没接」**在类型上存在**。这一条是这一批的要害：
`ReadCalibrations` 的全部价值是区分「**从未标定过**」与「**读不到档案**」，而把没接存储折成一个
空档案，它就会永远说前者 —— 与旧仓永远说后者一样，都是一句编造出来的话。

宿主不接时各口的行为：`getConfig` → **出厂默认生效，闸照常关**（旧仓在空档案上也是这个行为）；
`readProfile` / `getTiltCalibration` / `getCalibration` → **照实说读不到**；
`zExtendSignOrNone` → `null` ⇒ **拒判**（见下一条）。

变异 `profile-missing-source-is-not-an-empty-profile` 钉着它。

## D-PROF-2 · 档案键表**按消融精神裁过**，而裁掉的那些逐条记在金样里

| | |
|---|---|
| **Python** | `_CONFIG_SPEC` 39 + `_CHOICE_SPEC` 9 + `_TEXT_SPEC` 1 |
| **TS** | 8 + 2 + 0 —— **只登记本仓真的有消费方的**（每一行的注释就是消费方） |
| **测试** | `instrument-profile.test.ts` → 「消融掉的键**一个都没登记**」（名单来自金样 `ablated_keys`） |

未登记的键在 `sanitize` 里被丢掉，与旧仓同一条规则 —— 而那条规则本身咬过人（D-QPLUS-1：
「两个键必须先注册，否则写得干干净净、读回来永远是 `None`」）。所以这里每加一个消费方，
要同时加它的那一行；金样把两侧的键集**双向**钉住（多登记一个也红）。

## D-PROF-3 · `sanitize` 比旧仓**严**两格：空白串与布尔

| | |
|---|---|
| **Python** | `float('  ')` 抛 ⇒ 丢；而 `float(True)` = `1.0`、`int(False)` = `0` ⇒ **收下**（再夹进区间） |
| **TS** | 空白串丢（同旧仓）；**布尔也丢** |
| **测试** | `instrument-profile.test.ts` → `sanitize` 那一组的 `STRICTER` 登记（`bool_dropped`） |

⚠️ 空白串这一格在 TS 里**不是白送的**：`Number('  ')` 是 `0`，而 `0 nm` 的远离阈值等于
「任何 Z 变化都算远离」。同 D-VAC-4：读不到 ≠ 零，而这次是由类型转换伪造出来的。
布尔那一格是主动收紧（同 `scalarFloat` / `pyFloat`）：一个布尔型的 `z_recede_min_nm` 意味着
宿主发错了东西，把它当成 `1.0 nm` 用比拒绝它更坏。变异 `profile-blank-string-becomes-zero` 钉着前者。

## D-CAL-1 · `ReadCalibrations` 的「标称 f₀/Q」**不移植**，而旧仓那两个字段恒为 `None`

| | |
|---|---|
| **Python** | `_qplus_block` 用 `get_config("qplus_f0_hz")` / `("qplus_q")` 取**标称**值 |
| **TS** | 这两个字段（连同 `nominal_note`）**不出现** |
| **测试** | `l0/traces.test.ts` → `ReadCalibrations/ok` 的 `absent` 登记；`calibrations.test.ts` → 「标称 f₀/Q 不在报文里」 |

**这是一个旧仓缺陷，不是一次取舍**：那两个键住在**针尖登记表**那一行上（`core/tip_state.py`），
从来没有在仪器档案的键表里注册过 —— 于是 `sanitize()` 会静默丢掉它们，`get_config` 永远回
`None`。金样 `skill_traces.json` 里逐格录着 `"nominal_f0_hz": null`，就是证据。

接一条永远返回空的读口，等于给下一个人留一条永远不亮的分支（同 D-CRASH-3）。
**针尖登记表（批 5a）落地的那天，把它们接到那一侧，不是接到档案上。**

## D-CAL-2 · 三块全空时的那句 summary：先问档案读没读到

| | |
|---|---|
| **Python** | 无条件写「(已确认读到档案,不是读取失败 —— 逐项 why 里写了原因)」 |
| **TS** | 先 `readProfile()`：读得到才说那句；读不到就说「原因是**读不到仪器档案本身**……**这不是「从未标定过」**」 |
| **测试** | `calibrations.test.ts` → 「宿主没接档案存储」那一条 |

**旧仓这一行是真缺陷，而且正好是这个技能存在的理由的反面**：三块全空最常见的成因
**就是**读不到档案，于是这个专门用来分开两种否定的技能，在它自己的 summary 里把两者
合成了一句，还合成了错的那一句。变异 `readcalibrations-summary-claims-it-read-the-archive` 钉着它。

## D-ZS-1 · `nanonis_calls` 不在结果上：settle 的调用台账由内核记

| | |
|---|---|
| **Python** | `settle_and_read_z(ctx, log=…)` 把值得留的记录 append 进 `log`，随 `SkillResult.nanonis_calls` 回去 |
| **TS** | `SkillResultLike` 没有这一栏（内核记账），所以 `log` 这个入参不存在 |
| **测试** | 轨迹金样对的是**动词序列**本身（`l0/traces.test.ts`），那比台账更严 |

要紧的几个数（`samples` / `elapsed_s` / `drift_m` / `excursion_m`）本来就骑在 `ZSettle` 上，
没有随 `log` 一起丢。轮询读**两侧都不记**（5 s × 10 Hz = 100 次往返，一百条记录会把结果自己埋了）。

## D-ZS-2 · 两台方向判定机**刻意不合并**

| | |
|---|---|
| **Python** | `RetractForSampleChange._judge_recede` 与 `RelocateCoarseXY._judge_recede` 是两个函数，措辞与电流那一支的判法都不同 |
| **TS** | `judgeRecedeLadder` / `judgeRecedeClearance`，两台都在内核、都对金样逐格比 |
| **测试** | `kernel/src/z-settle.test.ts` → 「两台判定机刻意不是同一台」 |

同 D-CHANNELS-1 / D-PIEZO-1：**两个看起来一样的东西，正是将来有人重构时最想合并的东西。**

最要紧的那一格：**读不到 setpoint 时**，梯子版拿一条照成像条件（~100 pA）定的**绝对地板**
去判，判成 `approaching`；清障版改用一个与工作点无关的界（前放满量程），拿不到就
**不判电流**并把「这一条没判」写进结论，落到 Z 主证据。2026-08-10 真机上正是前者
把一次正常的退针判成了「方向搞反了」—— 一句**自信而具体的错话**。金样两台都录着，
谁把它们合并了当场变红。

## D-RELOC-1 · 落点复核（粗动大地图）**不移植** —— 而这条降级要在报文里说出来

| | |
|---|---|
| **Python** | `io/coarse_map`(604) + `coarse_map_provider`：算出落点、查最小间距 200 步、查单轴行程预算、里程表失效时只许沿上次方向前进 |
| **TS** | `#checkDestination` **永远放行**，并带一句「粗动大地图未移植……这一趟没有『别回到去过的站点』这条保护」+ `map_available: false` |
| **测试** | `composite/coarse-composites.test.ts` → 「落点复核此刻永远放行，而它把地图没移植说出来了」 |

旧仓那段本来就包在 try/except、失败即放行（「落点复核不可用，放行」），所以技术上可降级 ——
**但降级掉的正是那条保护**，而 2026-08-16 这条链断掉的症状是**第二轮把第一轮的坑原路重打了一遍**，
没有任何一处报错。所以本仓把「地图不在」**写进 `checks.destination`**，而不是复述旧仓那句
含糊的「不可用，放行」：两者都放行，但只有前者说得出放行的是什么。

⚠️ 连带后果：`StepCoarseXY` 的 `allow_revisit=true` 此刻**跳过的是一条空的约束**。
那个技能仍然成立（名字对得上的入口 + ≤60 步的用途上限与地图无关），地图接上来那天它一个字都不用改。

温度（`coarse_map_provider.temperature_k`）同理不移植，`checks.temperature_k` 恒 `null` ——
它本来就只记录、从不当闸。

## D-RELOC-2 · 串扰导航报告不移植（同 D-APPROACH-2）

| | |
|---|---|
| **Python** | 每一级 `rung.update(crosstalk_report(ctx))`，加 `crosstalk_modulation_off` / `crosstalk_skipped` 两个键，并经 `ctx.run("GetLockInConfig")` |
| **TS** | 不写，**也不塞占位键** |
| **测试** | `l0/traces.test.ts` → `withoutCrosstalk`（期望值从金样算出来） |

它要一条参考曲线，本仓没有。旧仓那段自己写着「这是报告，不是任何流程的目的」，
整体包在 try/except、永不抛、**不驱动任何决策**。接一个永远返回同一句话的读口，
等于给下一个人留一条永远不亮的分支（D-CRASH-3 同一条）。

## D-RELOC-3 · 急停失败的判据从「抛异常」换成「回包带 error」—— 这一换修了一个真缺陷

| | |
|---|---|
| **Python** | `_panic` 的两个动作各包一层 `except Exception` → 记进 `_panic_failures` |
| **TS** | 看 `rec.error`（`safeCall` **永不抛**，失败表达成 `record.error`） |
| **测试** | `composite/coarse-composites.test.ts` → 「急停**没能下发**时……照样判失败」 |

**旧仓那两个 `except` 几乎是死代码**：`ExecutionContext.safe_call` 不为仪器报错抛异常，
它把错放进 `record.error`（见 `core/execution_context.py:274`）。于是「急停下发了但仪器拒绝了」
**根本不会**进 `_panic_failures`，而那是本技能里唯一一条「针尖可能正贴着表面而马达还在走」的路径。
照抄那个形状在 TS 里会得到一条恒空的分支 —— 于是改判据。变异
`relocate-panic-failure-is-still-a-success` 钉着「失败要顶到结论里」。

## D-RELOC-4 · 偏压恢复补在**每一条**路径上（旧仓漏了两条）

| | |
|---|---|
| **Python** | `_restore_bias` 只在 `_phase_reapproach` 与 `_panic` 里被调 |
| **TS** | `run()` 收尾处再调一次（幂等） |
| **测试** | `composite/coarse-composites.test.ts` → 「横移前把偏压降到 0.5 V，而本来就低于它就不碰」 |

**证据是旧仓自己的注释**：它写着「三条路径都要调它：正常收尾、panic、以及 `reapproach=False`
时的结束。漏掉任何一条，调用方就会在一个自己没要求过的偏压上继续工作」—— 而代码里
`reapproach=False` 那条**没有**调用点，清障基线不可用那条 fail-closed 返回也不经过 `_panic`。
两种情况下调用方都会停在 0.5 V 上。那正是 2026-08-26 追了半夜的那件事。

## D-RELOC-5 · 步进计数器对账的答复**顶到结果里**（旧仓留在步骤里）

| | |
|---|---|
| **Python** | `_phase_verify` 返回 `{"counter": "unavailable", "note": "……这是如实记录,不是通过"}`，而 `run_composite` 的 `data` 里没有这一格 |
| **TS** | `onStepResult` 把它写进 `partial_data`，最终 `data.step_counter` 带着它 |
| **测试** | `integration/coarse-composites.test.ts` → 「这台控制器真的不支持步进计数器」 |

一句专门写来防止「打一个安心的勾」的话，读不到就等于没写。stmsim 正好是不支持
`Motor_StepCounterGet` 的那一种（`NeedModule`），一跑就照出来了。

⚠️ 另一处**照移未改**：前置检查那张 `checks` 表在**拒绝路径上不进最终 `data`**（`#checks` 只在
整段 preflight 走完之后才赋值，旧仓同）。于是一次拒绝的全部诊断只在 `error` 那一句里。
这一条登记在这里但没动 —— 它牵动金样里已经录好的几格，值得单独一次。

## D-TIPREG-11 · 拒绝文案里那个数被 `%g` 抹平了 —— **照移，并写下什么情况下才改**

旧仓 `tip_conditioning_resolver.py:184` 是 `f"{key}={val:g} V 超出{what}的安全上限 ±{max_pulse:g} V。"`，
`%g` 缺省六位有效数字。于是一个 `pulse_v = 10.000001` 的请求被拒时，印出来的是：

> `pulse_v=10 V 超出当前针尖（…）的安全上限 ±10 V。拒绝执行。`

**判据没错，话说歪了** —— 读的人（和模型）看到的是一句自相矛盾的拒绝。
本仓 `formatG(val, 6)` 逐位照移，金样 `tip_policy.json` 里逐字录着这一句。

**为什么不改**：措辞是模型读到的东西（D-SKILL-2 一族），而这一处**决定是对的、
只是渲染精度不够**。改它等于在本仓与旧仓之间多一条只影响可读性的分叉，
而分叉的维护成本要由每一次金样比对来付。

**⚠️ 2026-09-19 补：同一个失败形状有两处，而此前只登记了一处。**
深度那句走的**不是** `%g`，是 `{val:.3e}`（`tip_conditioning_resolver.py:198`）：

> `shaper_depth_m=-1.000e-08 m 的下压深度超出…的上限 1.000e-08 m。`

输入是 `-1.0000001e-8`（真的超限、真的被拒），印出来两个数**逐字相同**。
形状与 `%g` 那一处一样，格式化器不是同一个 —— 所以按「哪个函数出的问题」去找，
只会找到一半。**要找的是「渲染后的值等于渲染后的界」这个形状，不是某个格式化符。**

而这一句**没有任何一格金样录着**：金样 `tip_policy.json` 里 48 条深度拒绝的值是
−11 / −12 / −20 / −50 nm（上限 10 nm），印出来都离上限足够远；唯一到得了那个数的输入在
`l0/tip-phase-deps.test.ts` 里，**而那条测试只断言「拒了一条」，不看文案**。
⇒ 要让这一处也被看住，得先造一格把它印出来的金样。

**什么情况下才改**（照旧仓表头那段反问的形状，先把要回答的问题写下来）：
只要出现**一次**「有人因为这句话去查那道闸有没有坏」的记录 —— 那时它就不再是
可读性问题，而是**一句会把人引向错误下一步的拒绝**（同 D-CAL-2 那条说反了的 summary）。
到那天改法也已经想好：只在**渲染后的值等于渲染后的上限**时多印几位，
别的时候一个字不动。

<!-- ── 批 6a（特异化流程 _tip_phases 六个组合技能）的登记写在这一行下面 ── -->

<!-- 批 6a：以下 2 条的**编号留空**（`?`），由主线统一编。 -->

## D-TIPDEPTH-1 · **扎针深度接上了那半道安全包络 —— 本仓有，旧仓没有**

| | |
|---|---|
| **Python** | **没有这道闸**。`TipShape.execute` → `apply_tip_policy(params, ("shaper_bias_v", "shaper_lift_v"), …)` —— 两个都是**电压**；深度包络 `_check_envelope` 认的键是 `shaper_depth_m` / `poke_shallow_depth_m` / `poke_deep_depth_m`，**全仓没有一处把值送进去** |
| **TS** | `tipDepthRefusals()`（`l0/tip-policy.ts`）：`tip_lift_m` 显式给出且为**下压**（负）时，单独调一次 `resolveConditioning(['shaper_depth_m'], { shaper_depth_m: tipLiftM })`，**只取 `refusals`**。装在 `TipShape` 与 `TipShapeWithReadback` 的 `validateParams`（内核 **K6**，任何硬件调用之前） |
| **测试** | `tip-phase-deps.test.ts` → 「每一次扎入也经过深度那半道闸」·「上限是不许超不是不许到」·「没给 `tip_lift_m` 就什么都不判」·「抬起不是下压」 |
| **变异** | `tipshape-readback-depth-goes-through-the-envelope` · `tipshape-depth-goes-through-the-envelope` · `tip-depth-is-judged-only-when-given` · `tip-depth-boundary-is-exclusive` |

**这是本仓比旧仓严的一条**，而理由是 D-TIP-1 原话的反面。D-TIP-1 当年不写空壳
`validateParams` 的理由是「**写了会让人以为这道闸在**」；这里的状态一模一样地坏，
只是方向相反：**闸是实的、`tip_policy.json` 276 格逐格验过、而生产路径上没有任何输入
到得了它**。批 5a 结清 D-TIP-1 时那句「真正护音叉的那两样都在」（D-TIPREG-5 末段）
于是成了一句静静变假的话 —— 一发 **50 nm** 的下压过去全程放行：
声明范围 ±100 nm 放行；全局硬闸**按参数名子串是管深度的**
（`safety-tables.ts` 的 `GLOBAL_CHECKS` 里有 `tip_lift` / `lift_height` / `deep_depth` 三行），
**只是它的界就是 `tip_lift_min_m/max_m` = ±100 nm，与 K6 声明范围同宽 ⇒ 50 nm 照样放行**。
（2026-09-19 订正：此前三处都写成「只管电压、不管深度」—— 结论不变，而那个理由是错的。
**「没挡住」有两种：没有这道闸，和这道闸的界太宽。前者要新建，后者只要改一个数** ——
写错理由就等于把一个改一个数的活记成了一个新建的活。）针尖包络看不见它，
而通用档与 qPlus 档的 `max_poke_depth_m` 都是 **10 nm**。

⚠️ **旧仓自己的 `FIELD_OWNERS` 写着 `shaper_depth_m → ("TipShape",)`** ——
这个字段本来就是给它准备的，只是**没有一处把值送进去**（全仓 grep：`shaper_depth_m`
只出现在方案表与 `FIELD_OWNERS` 里）。**生产方接好了、消费方缺席** ——
同 `_tip_phases.py:2106` 那条 `exclude_used_spots`（「参数一直就在，只是从来没有
调用方传过」）。**旧仓那一侧今天仍然不通**，这条登记记的就是这个差。

### 三处刻意，每一处都是「别把一道闸变成一次行为改变」

**① 不塞进 `applyTipPolicy` 的 `policyFields`。** 那是最自然的接法，而它会让
`resolveConditioning` 在调用方**没给** `tip_lift_m` 时去方案表**填一个默认深度**。
后果不是多一道闸，是多一次**假拒绝**：操作员把 `max_poke_depth_m` 覆写收到 0.5 nm 时，
通用档出厂的 `shaper_depth_m = −1 nm` 会让一次根本没要求下压的调用被拒 ——
「出厂默认落在自己包络之外」那条路（`tippulse-refuses-before-planning` 钉着的那一条，
旧仓真出过）复活。旧仓实跑确认过这个填值：
`resolve_conditioning(("shaper_depth_m",), {})` → `params={'shaper_depth_m': -1e-09}`，
`trace={'shaper_depth_m': 'factory_default'}`。
变异 `tip-depth-is-judged-only-when-given` 钉着这道守卫，而它的输入正是那个覆写。

**② 只判下压那一半（`tip_lift_m < 0`）。** `tip_lift_m` 是**有符号的方向量**
（负 = 压向表面，正 = 抬离），而 `shaper_depth_m` 的定义域是下压（方案表全表负数）。
`checkEnvelope` 按绝对值比，是因为那个字段按构造就是负的 —— **不是**在声明「抬起也危险」。
⚠️ 这一处与旧仓解析器的取值范围不同，说清楚：旧仓 `resolve_conditioning` 拿
`shaper_depth_m = +5e-8` 是**拒**的（实跑确认）。但旧仓**从不把 `tip_lift_m` 送进这个字段**，
所以那里没有「一次抬离该不该被拒」这个问题 —— 这个问题是本仓这条接线新造出来的，
答案由本仓给：一次抬离表面 50 nm 不会戳坏音叉，把它送进下压字段等于凭空多一条
方案表从来没声明过的限制。**哪天有人用正向 `tip_lift_m` 做拉伸修针，这一条要重新想。**

**③ 装在 K6 而不是 `TipShape.execute`。** D-TIPREG-4 说 `TipShape` 的包络在 `execute`，
理由是它那两个策略字段要先经过「方案表填不填」才知道最终值；**这一条不需要那一步**
（只在显式给出时判），所以按本仓的规矩它属于 K6 —— 而且那里更早。
两个孪生技能因此**用同一个函数、装在同一层**，这正是 D-TIPREG-3 那次不对称要防的事。

### 金样：这一条**进不了** `tip_policy.json`

那台驱动器驱动的是**解析层**，网格的键是方案表字段名；而 `tip_lift_m` 是**技能参数名**，
`tip_lift_m → shaper_depth_m` 这条映射是本仓新增的，**旧仓没有对应行为可录**。
判据本身（`shaper_depth_m` 超限的拒绝文案，逐字）已经由 `*/all_deep` 那 12 格录着。
**唯一还缺的一格是深度的边界**（正好等于上限）—— 金样里深度用例全在线两侧
（−0.3 nm 过 / −1.2、−2、−5 nm 拒），线上一格没有。这一批**没有**加它：
加一行请求 = 全表 +12 格，而「264 格」这句话要在四处改，其中两处在
`spec/deviations.md` 的 D-TIP-1 段落里 —— 本轮锚点之外。
边界改由**生产路径**钉住（`tip_lift_m = −1e-8` 放行、`−1.0000001e-8` 拒），
并已对旧仓实跑核过一次（两边一致）。

> **2026-09-19 结清**（收尾支线）：那一格补上了。`export_tip_policy.py` 新增第 23 个
> 请求 `shaper_depth_at_limit`（`shaper_depth_m = -1.0e-8`，**正好等于上限**），
> 全表 **264 → 276 格**，12 支针尖**全过**，被拒数不变仍是 **111**。
> 边界因此两侧都钉住了：金样这一侧（276 格里的 12 格）与生产路径那一侧
> （`tip-phase-deps.test.ts`）。
>
> 顺带核实：12 支针尖的 `max_poke_depth_m` **现在一律是 `1.0e-8`** —— 上面那句
> 「通用档与 qPlus 档的 `max_poke_depth_m` 都是 10 nm」在今天的旧仓仍然成立，
> 而 `tip_conditioning_policy.py` 里 qPlus 那一档的 `note` 还写着
> 「`max_poke_depth_m` = 5 nm」。**那句 note 与它自己档位里的值对不上**（旧仓原文，
> 照录不改）——「还能分辨针尖的包络字段只剩 `max_pulse_count`」这句话没有因此变假。

## D-TIPDEPS-1 · 两张依赖表改成**由旧仓源码算出来**，并修正 `FORGE_REQUIRED_SKILLS`

| | |
|---|---|
| **Python** | 无对应物（`CONDITIONING_REQUIRED_SKILLS` / `FORGE_REQUIRED_SKILLS` 是**本仓新增**，见 D-SELFCHK-2） |
| **TS** | 新金样 `spec/golden/tip_phase_deps.json` + `tip-phase-deps.test.ts` 逐字比 |

批 5a 这两张表是照 `_tip_phases.py` 读出来的。批 6a 给它装了一台驱动器
（`export_tip_phase_deps.py`，从六个 `plan_dynamic` 求 `CompositeStep(skill_name=…)`
的传递闭包）。核下来：

* `CONDITIONING_REQUIRED_SKILLS` **一个不差**；
* `FORGE_REQUIRED_SKILLS` **少四个**：`AutoTilt`（台面上的调平，
  `flat_poke_sites` → `_level_on_terrace`）· `GetBias` · `CaptureSignalBuffer`
  （两条都在 `poke_phase` / `_poke_step` 里，与贵金属那张表同因）· `AssessAtomicLines`。
  四个里 `AutoTilt` 是 todo ⇒ **`TipForgeSelfCheck` 此前少报了一条缺口**；
* `FORGE_REQUIRED_SKILLS` **多一个**：`PokeConditionTip`。两条特异化流程要的是
  `poke_phase` 那个**生成器**（`make_special_tip.py:292/855` 写的是 `yield from poke_phase(...)`），
  不是那个技能 —— `_tip_phases.py` 抬头点名说了为什么（「composite 调 composite 在本仓
  没有先例，断点续跑与 abort 的交互没人验证过」）。一条**代码**依赖写进技能覆盖表，
  说的是假话，而缺口数看起来仍然对。移除它不丢信息：那个技能仍由贵金属那张表报着。

变异 `forge-required-covers-the-terrace-leveling` · `selfcheck-each-check-asks-its-own-chain`。

<!-- ── 批 6b（vision 的 scan_prep 链）的登记写在这一行下面 ── -->

## D-SCANPREP-2 · PNG **没有移**，而 `png_path` 恒为空串**正好是旧仓自己的一条路**

| | |
|---|---|
| **Python** | `AnalyzeScanImage` / `AutoProcessScanBatch` 的 `_render()` 走 matplotlib（`plot_flattened_scan` → `savefig`），成功时 `png_path` 是一条真路径、`images` 带上它 |
| **TS** | `png_path` **恒为空串**、`images` 恒为空表 |
| **理由** | 盘点把 matplotlib 归在 **D 档**：「本仓没有、也不该有 matplotlib 等价物」（`ComposePanelMontage` 那一行） |
| **形状对得上** | 旧仓 `_render` 自己就有「画不出来返回空串」那一支，注释写着**「画不出来不该让分析失败」**。所以本仓给出的是它的一条**合法**输出，只是永远走那一支 |
| **测试** | `l0/scan-prep-skills.test.ts` → `PNG 没移：save_png=true 时除了 png_path/images 之外**每一格逐字相同**`。⚠️ 写成整棵比而**不是** `if ('png_path' in data)` —— 一个「报没报」的问题不能写成「报了的话就检查一下」（green-8 §2.4） |

⚠️ **`_write_report` 反过来照移了**：它是纯字符串拼接 + 一次写文件，而报告正文
（每一个实测数字 + 每一个决定的理由）是这个技能的产品之一。
金样里录的是**报告全文**，测试逐字比。

### ⚠️ 这一条最锋利的一面：**给模型的那句话改不了**

`AutoProcessScanBatch` 的描述里写着「**它会渲染出这些 PNG**，并写一份 `_report.md`」，
参数表里还有 `render`（缺省 true）与 `save_png`。而本仓只做得到后半句。

**DoD ② 要求 515 个技能 / 1642 个参数与旧仓逐字比**，所以那句话不能改 ——
它只能是一条**响亮的** deviation，外加两条断言把「报告在、图不在」两面都钉住
（`scan-prep-skills.test.ts` 的 `save_png=true` 与 `render=true` 两格）。

**下一个人要知道的是**：这个技能今天对模型许下了一个它兑现不了的承诺。
兑现它要的是一条渲染路（本仓没有 matplotlib 等价物，盘点 D 档），
**而不是**把那句话删掉 —— 删掉就与旧仓的描述对不上，DoD ② 会当场变红。

## D-SCANPREP-3 · `scan_prep_thresholds` 的 20 个字段**带着消费方补上了**，`KNOB_LABELS` 仍然不移

批 4a 的 D-SCANPREP-1 只移了 4 个字段，原话是「真要用的时候照着旧仓那份 docstring 补，
**那时它们会带着自己的消费方一起来**」。这一刻到了：`measureFrame` / `planFor` /
`harmoniseBatch` 逐条读那 20 个。

**仍然没移的两张表**：`KNOB_LABELS`（设置 UI 的中文标签）与
`CALIBRATABLE_FROM_DISTRIBUTION`（标定工具的分组）—— 本仓既没有设置 UI 也没有
`scan_prep_commission`，那两张表在这里**一个读者都没有**。

⚠️ **两种越界处理并存，照移**：既有数值字段**夹紧**（历史行为，没跟着改），
{@link SCAN_PREP_NULLABLE_FIELDS} **丢弃 + 说明**（不夹紧）。旧仓 `from_mapping`
的注释逐字：「对一个 `None` = 判不了的字段来说，夹紧等于**凭空造出一个从没标定过的判据**」。
⚠️ 本仓多一样：丢弃的那一条**交给调用方**（`dropped`），旧仓那里是一条
`logger.warning`，而本仓零 I/O —— **静默丢弃与夹紧一样看不出来**。

**另外收 snake_case 的键**：旧仓那份 JSON 与它每一份标定报告都是 snake_case，
而本仓内部是 camelCase。只认一种写法会把另一种写法的**整份 profile 静默当成「没配」**，
而 `provenance` 照旧印在报告里说它标定过。

## D-SCANPREP-6 · 两处「旧仓自己就不确定」的地方：多数票的平局，与输出目录

| | Python | TS |
|---|---|---|
| `harmonise_batch` 的**平局** | `max(set(methods), key=methods.count)` —— **集合迭代序由字符串哈希定**，而 CPython 默认开哈希随机化（`PYTHONHASHSEED`）。同票时选谁**跨进程都可能不同** | 按**首次出现的顺序**取第一个票数最高的。这是两边唯一可复现的口径 |
| `_output_dir` 的缺省 | `figures_dir()`（`mast.agents._shared.data_paths`） | **落在那个文件夹旁边**。本仓没有「数据根 / figures 目录」这个概念（D-FRAME-1 已为此销过一次账） |

两处都**没有金样覆盖**：平局在本批的用例里一次都没出现（造一个出来就是造一个
旧仓自己答不出的问题），输出目录在每一格里都是显式给的。
登记它们是因为**「旧仓在这里是不确定的」这件事本身要有人知道** ——
下一个人看到两边不一样时，要能分清「移错了」与「那里本来就没有答案」。

## D-SCANART-2 · `detect_scan_artifacts` 补齐了另外三条路，而 D-SCANART-1 的警告**没有被推翻**

批 4a 只移了 `bad_row_frac`，并点名 `_drift_px` 不要顺手补。这一批补了 ——
**因为消费方出现了**：`measure_frame` 把六个字段整份转发进 `FrameMetrics.artifacts`，
而 `_frame_notes` 里有两句话直接读 `oscillation` / `oscillation_severity`。

D-SCANART-1 警告的是「拿 FFT 循环相关去量**漂移矢量**」（旧仓 2026-09-13 把
`pair_displacement` 的相位相关换掉了，沿慢轴绕回，「沿 y 挪 3 nm 量到 −0.06 nm」）。
这里这一份**不是**那个用途：它只回答「正反扫之间有没有一个明显偏移」，
而且自带两道闸 —— **搜索限制在中心 15% 的圆窗**、**偏移峰要比零位移峰高 8%**
（晶格上「平移一个晶格矢量 = 原图」会与零位移打平，那不是漂移）。
**要量漂移矢量仍然用 `pair_displacement`，不是这个。**

## D-SCANART-3 · 整条路在 **float32** 里，本仓照抄**输入量化**、累加留 float64

`_to_2d` 一开始就 `np.ascontiguousarray(a, dtype=np.float32)`，此后 `np.median` /
`np.std` / `np.fft.fft2`（numpy 2.x 对 float32 给 **complex64**）全在单精度里。
本仓照抄那次量化（`toFloat32Frame`），变换留在 float64 —— 复现单精度 pocketfft
要把每一次蝶形都降精度（同 D-SHARP-1）。

⇒ 容差：`oscillation_severity` 走 `OSC_REL_TOL = 32·eps32`；计数比（`bad_row_frac` /
`spike_frac`）与下标（`drift_px` / `oscillation_cycles_per_line`）**容差 0**。

⚠️ **量化必须照抄**的理由是判据级的：`has_artifact` 是四个布尔的或，每一个都是
「某个统计量 > 某个常数」。输入差第七位与输入差第二位，对一个阈值比较是两件事。

## D-TIPCHANGE-1 · `tr` 通道**没有移**（消融精神）

旧仓 `row_channels` 有第五个通道 `tr`（正反扫逐行最大归一化互相关），只在传了
retrace 时出现。而本仓这一族**唯一的消费方**是 `scan_prep.measure_frame`，
它调的是 `detect_tip_change(_fill(span), nm_per_px=…)` —— 一个**二维**数组，
于是 `_to_pair` 给 `(trace, None)`，**`tr` 那一支在旧仓自己的这条路上也从来没跑过**。

移它要的不是十行，是一整套 `rfft` / `irfft` 的逐行往返（本仓 `numerics` 没有
`irfft`，得现写一份）。**一条没有输入的分支加一件没有消费方的原语** —— 两条都踩在
消融精神上。真要它的时候（`PreScanCheck` 那条路给的是正反两帧）连着 `irfft` 一起做。

**测试**：`vision/scan-prep.test.ts` → `` **`tr` 通道没有移** —— 而这里要说得出它不在 ``
（金样每一格的 `channels` 里都不许有 `tr`）。

## D-SCANPREP-4 · ±k 孪生峰：`fine_angle_deg` 与旧仓**可能差正好 180°**

实信号的谱满足 `|F(−k)| = |F(k)|` —— 精确算术里那是一个**精确的平局**，
而 `np.argmax` 与本仓的扫描都取「先遇到的最大值」。谁先到手由那一对的**最后一位
浮点**决定，而两边的 FFT 是两个实现。实测：同一张 `axis_wave` 上一边 `+63.435°`、
一边 `−116.565°`。

`snr` 与 `period_nm` 对 ±k **完全相同**，所以**只有角度**要折。
测试两侧都折到 `(−90, 90]` 再比。**与 D-LATTICE-1 是同一件事，理由一字不差。**

⚠️ 这条**没有**在生产代码里折：折了就与旧仓那个值不同，而 `fine_angle_deg`
是进模型上下文的一个字段。本仓自己是确定的（同输入同输出），只有跨实现才翻。

## D-SCANPREP-5 · 报告里的 `%` 与定点数：`pyFixed(-0, n)` 在 kernel 里**给错了符号**

Python 的 `f"{-0.0:.1f}"` 是 `'-0.0'`，而 `kernel/z-trace.ts` 的 `pyFixed` 给 `'0.0'`
（JS 的 `toFixed` 判 `x < 0`，而 `-0 < 0` 是假）。`round(s, 3)` 把一个很小的负数变成
`-0` 之后，这一格就印进报文：「最接近的通道是 \`dc\`(-0.0)」。

`formatG` 早就处理过同一件事（`coverage-gaps.test.ts`：`formatG(-0, 6) === '-0'`），
**`pyFixed` 漏了**。本批**不改 kernel 那一份**（共享文件，波及别人的金样），
在 `vision/scan-prep.ts` 与 `l0/scan-prep-skills.ts` 各自的 `fx()` 里挡了一层，
并把它写成一条**给主线的欠账**（见 `docs/handoff/batch-6b.md` §7）。

<!-- ── 批 7b-1（封锁账闭包化 + AssessAtomicPhase + 两条已解封锁的流程）的登记写在这一行下面 ── -->

<!-- 批 7b-1：编号**留空**（`?`），由主线统一编。 -->

## D-EXTRA-SPLIT-1 · 旧仓把 `extra_reasons` / `extra_warnings` **拆散在两个类里**

`builtins/tip_spectro_assess.py` 一个文件两个技能，而同一次重构的两半落进了两个类：

```
 151  def execute(...)                    ← AssessShockleyOnset.execute
 236      "reasons":  list(res.reasons)  + extra_reasons,     ← **用而未赋值**
 237      "warnings": list(res.warnings) + extra_warnings,
 242  （execute 结束；151–242 之间一处赋值都没有，逐行核过）
 263  class AssessAtomicPhase(BaseSkill):
 405          extra_reasons  = ["incomplete_frame"] if incomplete else []   ← **赋值而未用**
 406-410      extra_warnings = ["只有 %.0f%% 的像素有数据 —— 这一帧**判不了**…"]
 412-435      data = { …, "reasons": list(res.reasons), "warnings": list(res.warnings) }
```

两侧各错一半，**而两半互为对方的证据**：`AssessShockleyOnset` 每条成功路径
必然 `NameError`（那个技能这一批不落，见交接），`AssessAtomicPhase` 把自己算好的
两句话**扔了**。`grep -n "extra_reasons\|extra_warnings"` 全文件只有这四行。

**本仓不照抄（DoD ⑤）**，三处接回来：

| | 旧仓 | 本仓 |
|---|---|---|
| `data.reasons` | 残帧上**不含** `incomplete_frame` | 含（`:405` 写的就是它） |
| `data.warnings` | 残帧上是**空表** | 含 `:406-410` 那句话，**逐字**，一个字没新造 |
| `summary` | 分支在 `res.passed` 上 ⇒ 残帧上说「有原子相」，而同一个回包里 `data.passed=false` | 残帧上用 `:406-410` 那句话当 summary |

⚠️ 第三行是**模型面**的：`data.passed` 是机器读的，`summary` 是模型读的，
**而模型只读得到后者**。金样 `batch7b1.json / coverage_below_gate_but_judged`
把旧仓那一格钉着（`summary` 含「有原子相」而 `data.passed` 是 `false`），
本仓那一侧由 `batch7b1-skills.test.ts` 的「D-EXTRA-SPLIT」一组各写一条断言 ——
**差异消失的那天这几条会红，这条登记必须跟着删。**

**改它需要什么证据**：旧仓某天把那两个变量移回各自的类（或者把 `AssessShockleyOnset`
的 `:236-237` 删掉）。在那之前，本仓这一侧是**旧仓自己写下来、却被一次拆分切断**的行为，
不是发明。

## D-SUBSTRATE-1 · `resolve_substrate` 的三处收窄（注入口 + 只认四个洁净金属面 + 无模糊匹配）

旧仓 `core/sample_facts.py` 走 `get_active_log() → current_sample_id →
storage.get_sample()` 再查 30570 行的 `knowledge/`。本仓两样都没有，于是：

| # | 旧仓 | 本仓 | 证据 |
|---|---|---|---|
| 1 | 不给名字时**问实验记录**「台面上现在放的是什么」 | {@link substrateFacts.currentSample} 注入口，**默认关** ⇒ 走「不知道」那条路 | 与旧仓在**没有样品记录**时同解（金样 `resolve_substrate` 的 `null` / `""` 两格）。同 `analysis-clusters.ts:612 substrateTolerance` |
| 2 | 精确查不中时再走一趟 `match_material` 模糊匹配（只收 `type_id=="clean_metal"`） | **整条不在**：认不出就是认不出 | 那一趟存在的理由是知识库里有非金属条目（实测 `match_material("au111")` 返回 `MoS2_on_Au111`）。本仓没有那张表 ⇒ 没有那个陷阱，也没有那条兜底 |
| 3 | 认得的面由知识库的 `clean_metal` 表定 | 一张 **4 条**的埃值表（`CLEAN_METAL_NN_ANG`） | **量出来的，不是猜的**：金样把 `SURFACE_LATTICE_NM` 的全部七个面都问了一遍，旧仓对 `HOPG` / `NaCl(100)` / `Si(111)-1x1` 一律 `available=false` |

⚠️ 第 3 行原本差点写错：拿本仓已有的 `SURFACE_LATTICE_NM`（vision 的七个面）
当衬底知识库，会让三个面**凭空「知道」** —— 而知道之后走的是完全另一条路
（做晶格常数比对而不是跳过它）。两张表在旧仓里本来就是两张：一张在
`vision/lattice_calibration`（FFT 一阶峰的几何常数），一张在知识库（样品事实）。
**合成一张不是消除重复，是把两个不同的问题合成一个。**

三处的降级都是**诚实拒绝**：拿不到衬底只是不做晶格常数那一项比对，
其余三条判据照跑 —— 旧仓注释明写「0 或推断不出来时只是不做这一项比对，**不算失败**」。

## D-ROWSPACING-1 · 行间距的算式**不与 `firstOrderPeriodNm` 统一**（旧仓两处结合顺序不同）

```
sample_facts.py:51,196        _ROW_SPACING_FACTOR = math.sqrt(3.0) / 2.0 ; nn_nm * _ROW_SPACING_FACTOR
lattice_calibration.py:88     a * math.sqrt(3) / 2.0
sample_facts.py:184-185       nn_nm = nearest_neighbor_ang / 10.0        （知识库存的是**埃**）
```

三处合起来，Pt(111) 上与「本仓 nm 表 × `(a·√3)/2`」差 **1 ulp**
（`0.2403220495501817` vs `…174`；`2.775/10 = 0.27749999999999997 ≠ 0.2775`）。

**照着「同一个概念不写第二份」去统一是错的**：`expected_a_nm` 是晶格常数比对的
**入口**，而下游是一个 15% 的容差判决 —— 入口差一位不改判决，但它会让金样
逐格比对整列对不上，于是**下一个人分不清「容差写松了」与「算错了」**。
所以这里跟 `sample_facts` 那一份（存埃、除 10、乘预算好的 √3/2），
`firstOrderPeriodNm` 跟它自己那一份。两条变异各盯一边
（`atomicphase-row-spacing-is-the-nearest-neighbour` / `-reassociates`）。

## D-EMPTYPATH-1 · 空 `scan_path` 走的是「读取失败」，**不是**「文件不存在」

`Path("")` 在 Python 里等价于 `Path(".")`，而当前目录**是存在的** ⇒
`if not Path(path).exists()` 为假 ⇒ 掉进 `read_sxm("")` 的 OSError ⇒
`.sxm 读取失败: …`。本仓 `existsSync('')` 返回 `false`，照写就会说「文件不存在」。

**这是实跑出来的，不是读代码读出来的**（金样 `batch7b1.json / empty_path`）——
一个「看起来显然」的分支走到了另一支，而模型读的正是这两句里的一句。
本仓用 `path === '' ? existsSync('.') : existsSync(path)` 对齐。

## D-ATOMICPHASE-CHANNEL-1 · 指名通道拿不到时**回落到第一个通道**（与孪生技能刻意不同）

```
tip_spectro_assess.py:361     ch = channels.get(channel_name) or next(iter(channels.values()), None)
atomic_lattice._load_frame    拿不到就报错退出
```

两个技能读同一种文件、回答相近的问题，而在这一点上给出完全不同的行为。
**两条都照移**：统一成一种会让金样里有一格对不上，而对不上的那一格正是模型读的那一句。
⇒ 「文件里没有可用通道」这句话**只在通道表为空时**说得出来（金样 `no_channels`）。

同理，这个技能**不走** `sxmOrientedFrames`（反扫去镜像 / 按 `SCAN_DIR` 翻正）——
旧仓这一支是 `ch.get("forward") or ch.get("backward")`，原样取，一次几何归位都不做。

## D-CLOSURE-DEPTH-1 · 闭包**不抄**旧仓那个「超过八层就 UNKNOWN」的上限

旧仓同形状的那一份是 `mast/skills/compliance.py:751`：

```python
if name in _seen or len(_seen) > 8:
    return SkillFootprint(UNKNOWN, reasons=(f"{name}：子技能循环引用或嵌套太深",))
```

它那么写有它的道理（那台是**运行时**跑的，要对付声明式 spec 与动态注册）。
本仓 `tip-phase-closure.ts` 的 `skillClosure` **没有深度上限**：这一批修的正是
「追一层就停」，抄一个「追八层就停」过来只是把同一个 bug 的阈值调大。
这里的图是静态有限的（515 个技能，金样 `skill_runs`），完整不动点一定收敛；
环由 `seen` 挡，挡掉了什么由 `closure_limits.cycles` 说出来（今天空表，有测试盯着）。

⚠️ 记这一条是因为：**一处刻意的不一致，没写下理由就等于一处疏忽** ——
下一个人看到「旧仓有上限而本仓没有」，会以为是漏了。

<!-- ── 批 7b-2（势垒链与线缆（8 个技能 / 7 个模块））的登记写在这一行下面 ── -->

<!-- 批 7b-2：编号**留空**（`?`），由主线统一编。 -->

<!-- ── 批 7b-3（composite 零新原语五个 + paper 四个纯函数）的登记写在这一行下面 ── -->

<!-- 批 7b-3：编号**留空**（`?`），由主线统一编。 -->

<!-- ── 批 7a-1（vision/tilt 一族 + AnalyzeFrameTilt + AutoTilt）的登记写在这一行下面 ── -->

<!-- 批 7a-1：编号**留空**（`?`），由主线统一编。 -->

## D-TILT-1 · `_segmentation_step_signal` 落在旧仓**自己的 fail-open 分支**上

| | |
|---|---|
| **Python** | `from mast.vision.seg_scale_adaptive import segment_scale_adaptive, summarize_segmentation` —— 分割器在场，`terraces_8` 上报 `(True, 0.7061)` |
| **TS** | 本仓**没有** `segment_scale_adaptive`（`vision/seg-texture.ts` 抬头明写「只移这一条链，不移它」）。于是走旧仓那个 `except Exception: return (False, 0.0)` |
| **测试** | `vision/src/tilt.test.ts` → `没有分割器 ⇒ 与旧仓「缺依赖」那一支逐字` / `把金样录下来的分割器输出注进去 ⇒ 与旧仓「分割器在场」那一支逐字` |

**不是把 `(False, 0.0)` 写死**：`assessSteps` 收一个注入口 `segSignal`，
缺省不注入就是「缺依赖」，注入了会抛的就是 `except`（那一支有单测），
哪天分割器真落了接上来即可，**这个文件一个字都不用改**。

金样**两侧都录**（`seg_signal.with_segmenter` / `.segmenter_unavailable`，
`assess_steps.verdict_seg` / `.verdict_noseg`），做法是把
`sys.modules['mast.vision.seg_scale_adaptive']` 设成 `None` 逼出真的 `ImportError`
—— 走的是旧仓自己那条 except，不是我替它编的返回值。
`terraces_8` / `terraces_16` 两格上两侧**真的不同**（`triggered_by` 是 `both` 对
`dominance`，`step_area_frac` 是 0.7061 对 0），所以这不是一组分辨不出两种候选的金样。

**差在哪儿**：分割器缺席**只会让台阶判据更宽松**（两个判据取「或」）。
也就是说本仓在「完全平行于快扫轴的台阶」上会给出一个倾斜数字，而旧仓会拒答。
那一档由 7a-3 的 `kde_layers` 那条线补。

## D-TILT-2 · `frame_not_2d` 在本仓由**类型系统**承担

| | |
|---|---|
| **Python** | `estimate_tilt(np.arange(8))` → `invalid_reason: 'frame_not_2d'` |
| **TS** | `Mat` 由 `matOf` 保证是二维的，**一维输入构造不出来**。最接近的形状是 `1×N` 的 `Mat`，而它走的是 `frame_too_small` |
| **测试** | `vision/src/tilt.test.ts` → ``​`frame_not_2d` 在本仓由类型系统承担`` —— 金样里对面的答案与本仓这一侧的答案**都写着** |

`structure_dominance` / `step_dominance_multiscale` 的 `ndim != 2` 守卫同理。
**不补一条 runtime 检查**（消融精神：它现在什么都挡不住），但金样里留着对面的答案，
这样「不可达」是一句量出来的话，不是一句我说的话。

## D-TILT-3 · `estimate_tilt` 的 `fit_failed` **不可达**（两侧都是）

`fit_plane_robust` 只在有限像素 < 3 时交 `None`，而 64×64 上那意味着 NaN 占比
**99.9%** —— `too_many_nan`（0.20 的线）在它前面。金样
`estimate_tilt_unreachable` 逐格量着这条推理（finite = 0…4，`fit_is_none` 与
`invalid_reason` 并排）。

**不删那一支**（`MIN_FRAME_PX` 哪天调小就用得上），但它现在是一段没有闸的代码，
所以这一族的变异不打在它上面 —— 同 green-8 §2.8 的处置。

## D-TILTCIRCLE-1 · 秩亏的圆拟合，两边给出**差一倍**的倾斜，而两边都判 `valid`

| | |
|---|---|
| **Python** | 12 个点全在同一个角度上 ⇒ `np.linalg.lstsq(rcond=None)` 给**最小范数**解（系数平分给两根相同的列）⇒ `slope_mag_deg = 1.4321°` |
| **TS** | 列缩放 Householder QR 把系数全压在第一根列上 ⇒ `slope_mag_deg = 2.8624°`（**斜率整整 2 倍**） |
| **测试** | `vision/src/tilt.test.ts` → `秩亏那一格两边**差整整一倍**，而两边都判 valid` |

两边的残差都是 `~1e-25`，也就是说「哪一个对」这个问题**本身没有答案** ——
解不唯一。

**为什么不改**（不加一条秩闸）：它**没有下游**。`TiltProbeCircle` 的角度是
`2πk/n`，互不相同，这一格从那里到不了。加一条旧仓没有的闸等于给一个不存在的
输入写代码。但断言留着：哪天有别的调用方，它会当场说出「这两边不是一回事」。

## D-TILTCAL-1 · 写档案：本仓多出**两态**，而旧仓只有一个 `None`

| | |
|---|---|
| **Python** | `set_tilt_calibration` 拒写时一律返回 `None`，而 `TiltCalibrate` 的报文把它**全部**说成「标定被拒绝(条件数 … 超过上限 10.0)」 |
| **TS** | `setTiltCalibration` 交一个联合类型：`bad_matrix` / `not_finite` / `cond_unknown` / `cond_too_high` / `no_sink` |
| **测试** | `kernel/src/tilt-loop.test.ts` → `五条拒写理由各一条`；`l0/tilt-skills.test.ts` → `宿主没接写口 ⇒ **另一句话**` |

两件事：

1. **形状非法 / 条件数算不出**在旧仓那句话里被说成「两轴响应几乎共线」——
   一句关于**硬件**的假话，而真相是调用方传错了东西。
   本仓其余四态照旧仓逐字（那几条在技能层到不了：响应幅度闸与奇异闸在前面），
   只有 `no_sink` 换一句。
2. **`no_sink` 是旧仓没有的一态**：它的档案是进程内的一份 dict，永远写得进；
   本仓的写口由宿主注入（批 7a-1 新加的 `processInstrumentProfile.write`）。
   **不许静默成功** —— 那会让技能报「标定完成」而档案里一个字都没有。

同一条也落在 `AutoTilt` 的**读**侧：`calibration_unreadable` 是本仓的第三态
（旧仓只有「有」与「没有」），`next_action_hint` 从 `run_tilt_calibrate` 换成
`fix_profile_host` —— 一个去跑标定，一个去修宿主接线，**该做的事完全不同**。
登记在 `traces.test.ts` 的 `DEVIATIONS`（`AutoTilt/*`），期望值**从金样算出来**。

## D-TILT-4 · `AutoTilt` 的 `no_action_needed` 里那句空 `reason` **不可达**

`trigger = min(0.05·zr, 10·rms) ≤ 0.05·zr`，`hard = 0.20·zr`，而走到那一支的前提是
`span ≤ trigger` ⇒ `span < hard` 恒成立（`zr > 0`，`CONFIG_SPEC` 把 `z_range_m`
夹在 `[1e-9, 1e-4]`）。于是 `"within_budget" if span < hard else ""` 的 `else`
永远不取。金样 `no_action_reason_unreachable` 用 15 格（3 个量程 × 5 个起伏）量着它。

照移、不删；变异不打在它上面。

## D-HYPOT-1 补充 · 本批给它添了三个消费方

`Math.hypot` 与 CPython 的 `math.hypot` 差 1 ULP（原条目在上面）。批 7a-1 的三处：
**补偿增量的幅度**（`tiltDelta` 之后）、**帧对角线**（`frameDiagonal`）、
**合成倾斜角**（`estimateTilt` 的 `slope_mag_deg`）。

实测 `hypot(1e-7, 1e-7)` 两边差 1 ULP，而 `hypot(3e-7, 2e-7)` 一样 ——
所以这不是「换个写法就好了」。三处都只用来跟阈值比大小或印给人看，
按 `HYPOT_REL_TOL`（2 ULP）比，其余字段照旧逐字。
`AutoTilt` 的 `frame_fallback` 那一格**故意**让扫描框是 300×200 nm 而不是 100 nm ——
兜底对角线恰好是 `hypot(1e-7, 1e-7)`，用 100 nm 的框会让「读到了框」与
「读不到、走兜底」给出同一个数。

## D-TILT-5 · `AnalyzeFrameTilt` 读的是**裸块**，不做几何归位

旧仓写的是 `scan["channels"][name]["forward"]`，一次 `sxm_oriented_frames` 都没有。
与 `AssessClusterRoundness` 是同一种情形（`analysis-common.ts` 抬头点过名）：
**不是本仓的选择，是旧仓的现状**。归位会翻 `backward` 块、会把 `up` 帧翻正，
而那两件都会改变报出来的 `tilt_slow_deg` 的符号。照移，并留一条变异
（`frametilt-reads-the-raw-block`）钉住它。

顺带一条**本仓比旧仓多说的**：`.sxm` 读取失败那句话里印**路径**
（旧仓 `read_sxm(path)` 天然有它，本仓的读取器缺省印 `<sxm>`）。
`loadSxm` 因此多一个可选参数，**缺省不变**。

⚠️ **2026-09-20 订正理由**（结论不变，理由换掉）：初稿写「改缺省会让批 4a/4c/6b/6c 的
那几句报文整排变红」—— **不成立**。`<sxm>` 在整个 `spec/golden/` 里出现 **0 次**，
含那句 `header end marker` 的金样只有 `batch7a3` / `nanonis_files` / `tilt` 三份，
都不属于那四批；7a-3 的交接自己写的也是「本批全量跑过，**零影响**」。

**真正的理由**：`loadSxm` 全仓 12 个调用点、**10 个吃缺省**，而**没有一格金样看着它们**。
改缺省 = 同时改掉 10 处面向模型的报文，而不会有任何一格变红。
⇒ 不改缺省，不是因为「会打破测试」，恰恰是因为**不会**：
**在一个没有判据看着的地方改模型读的那句话，错了也没人会知道。**

**改它需要什么证据**：先给那 10 处里任意一处造一格录着这句报文的金样 ——
有了看着的那一格，缺省是 `<sxm>` 还是路径才成为一个可以讨论的问题。

<!-- ── 批 7a-2（实验地图层 + FindCleanSpot）的登记写在这一行下面 ── -->

<!-- 批 7a-2：编号**留空**（`?`），由主线统一编。 -->

## D-MAP-1 · `AnalysisConfig` 21 个字段里**只搬了 15 个**

| | |
|---|---|
| **Python** | `dataclass` 21 个字段 |
| **TS** | 15 个。没搬：`reuse_overlap_frac` · `min_usable_unscanned_frac` · `center_zone_frac` · `center_zone_blocked_frac` · `max_sts_points` · `max_candidates` |
| **测试** | `packages/host/kernel/src/map-layer.test.ts` → `字段集：本仓的 15 个 + **写明没搬的 6 个** = 旧仓的 21 个` |

这六个在本批的闭包里**既没有生产方也没有消费方**：`analysis_config` 一个都不设
（它们只是 dataclass 的静态默认），`nearest_clean_from` / `build_avoid_circles`
一个都不读 —— 它们服务的是栅格化与巡览路线（`rasterize` / `candidate_positions` /
`coarse_move_advice`，本批没移）。按消融精神不写。

名单写成 `ANALYSIS_CONFIG_FIELDS_NOT_PORTED` 而不是一句注释，是因为金样比字段集时
要拿它去补：**一次静默的少写与一次说好的少写，在 diff 里长得一模一样。**

## D-MAP-2 · 写侧 `record_damage_marker` **没搬** —— 一笔点名的欠账

| | |
|---|---|
| **Python** | `map_scope.record_damage_marker`（49 行），`load_markers` 的写侧对偶，同一个 storage、同一个 scope |
| **TS** | 不存在 |
| **测试** | —— |

旧仓把这两个函数放在同一个文件里，抬头写着理由：**写进 A 而从 B 读，几何上等于没写**
——而症状是「它怎么又在同一个地方动手」，没有任何一处会报错（2026-08-16 真机：
第二轮把第一轮的坑原路重打了一遍，`map_known=True`，地图读得到，里面就是没有脉冲标记）。

本批没搬的理由是**本仓还没有任何一个消费方**：没有技能会写损伤标记
（`TipPulse` / `TipShape` 都不写），搬过来就是一段没有调用者的代码。

⚠️ **它是一笔点名的欠账，不是一次遗漏**：第一个要写标记的技能落地时，
它必须和那个技能**同批** —— 否则 `map_known=true` 而地图永远是空的，
而那正是这条链最难看出来的失效方式。

## D-MAP-3 · 地图读口的三态由**宿主**给，`storage.get_markers(...) or []` 移到适配器

| | |
|---|---|
| **Python** | `marker_rows()` 自己问 `get_active_log()` → `_storage` → `get_markers(...) or []`，三条「读不到」（没有活动实验 / 没有存储 / 取数抛）在函数内部分开 |
| **TS** | `processExpMap.markerRows`：读口为 `null`（宿主没接）、返回 `null`、或者抛 —— 三条都是「读不到」；返回一个表（可以是空的）才是「读到了」 |
| **测试** | `map-layer.test.ts` → `读口**返回 `null`** ⇒ 读不到` / `读口**抛了** ⇒ 读不到，而且**不往外抛**` |

内核零 I/O（PLAN §6.1-2），拿不到 storage，也就无从区分「存储说没有」与「问不到存储」。
`or []` 那一步因此属于宿主适配器。**判据没有丢**：`available` 这个布尔的含义
（「不知道」≠「干净」）一字未动，而它正是整条链的要害。

## D-MAP-4 · `state.snapshot()` 的 fail-soft 从内核挪到技能层

| | |
|---|---|
| **Python** | `analysis_config` 里 `try: snap = state.snapshot() … except: pass` |
| **TS** | `analysisConfig` 收的是**已经读出来的**扫描框宽度；那道 `try` 在 `FindCleanSpot` 里 |
| **测试** | `packages/host/stm-skills/src/l0/clean-spot.test.ts` → `实时状态**抛了** ⇒ 帧尺寸回落到 100 nm，选点照常` |

同一条保护，同一个位置（读那一刻），只是换了个函数。内核那一侧因此连
`state_raises` 这条路径都不存在 —— 金样里那一格在 TS 侧等价于「没有 state」。

## D-MAP-5 · `crashMemoryMarkers` 读不到时的返回值，与「问过了、没有」**逐字节相同**

| | |
|---|---|
| **Python** | `except Exception: return [], 0` |
| **TS** | 照移 |
| **测试** | `map-layer.test.ts` → `⚠️ **读不到**与**问过了没有**给出逐字节相同的返回值（照移的 fail-open）` |

**这是一条 fail-open，而且它和旧仓自己的抬头打架。** 旧仓写着「读不到这一路来源
≠ 没撞过，调用方按『少了一个来源』处理」——**而这个返回值让调用方做不到**：
`FindCleanSpot` 的 `avoidance_sources` 靠 `crash_mem` 非空来判断这一路答没答上，
于是「追踪器炸了」和「追踪器好好的、只是没撞过」给出**同一份回包**。

**照移，没有偷偷加一个布尔**：那会改掉模型面的回包，而 DoD ② 要的是逐字对齐 ——
要补它得连 `FindCleanSpot` 的报文一起改，那是一个该由人拍板的决定，
不该塞进一次移植里。（同形先例：`TipCrashSnapshot.since_s` 是本仓**加**的一个
字段，那一次动的是一个旧仓没有的结构。）

## D-MAP-6 · `build_avoid_circles` 的圈数上限，对**损伤** marker 常常不生效

| | |
|---|---|
| **Python** | 损伤那一支 `out.append(...)` 之后直接 `continue`，**跳过**了 `if len(out) >= cfg.max_avoid_circles: break` |
| **TS** | 照移 |
| **测试** | `map-layer.test.ts` → `cap_not_enforced_on_damage`（5 个损伤 marker、上限 3 ⇒ 5 个圈）与 `cap_enforced_after_a_non_damage`（中间夹一个 `move` ⇒ 当场截断） |

**旧仓缺陷，照移。** 不改的理由是方向：上限截掉的是**避让圈**，而
**少画一个圈就是多一个可以打下去的坑**。今天这条上限在损伤这一路上不生效，
等于「一个都不少画」——那是安全的那一侧。要修它，得先回答
「400 个圈之后该怎么办」，而那不是这一批的题。

## D-MAP-7 · `center_zone_side_nm` 是一个**拧不动的旋钮**

| | |
|---|---|
| **Python** | `_nm_unless_set("center_zone_side_nm", 1200e-9)`，而这个键**不在 `_CONFIG_SPEC` 里** ⇒ `sanitize` 丢掉它 ⇒ `get_profile()` 永远没有它 |
| **TS** | 照移（`sanitizeProfile` 同样丢掉未注册的键） |
| **测试** | `map-layer.test.ts` → `` `center_zone_side_nm` 这个旋钮**拧不动** —— 档案里设了也不生效 ``；金样 `config.center_zone_knob_is_dead` |

与 D-QPLUS-1 完全同形（「两个键必须先注册，否则写得干干净净、读回来永远是 `None`」），
也与 `qplus_f0_hz` 那条同形。**照移**：注册它等于给这台机器加一个从来没有人用过的
旋钮，而它连着的那条设计（「中心区与脉冲避让半径是一对」）要求改一个就得改另一个。
`nearest_clean_from` 的抬头写得很清楚：**改这两个数中的任何一个，都要回答
「改完之后中心区里还剩几个落点？」答案是 1 或 0 的话，那不是一条约束，是一个死锁。**

## D-MAP-8 · marker 行的非数值列，本仓读作「没有这一列」

| | |
|---|---|
| **Python** | `marker_from_row` **一次转换都不做**：`row.get("x_m")` 原样带走，一路走到 `float(m.x_m)` 才炸 |
| **TS** | `numCol` / `strOr`：不是数（不是串）就读作 `null`（落回默认值） |
| **测试** | `map-layer.test.ts` → `本仓比旧仓**窄一档**：非数值的坐标读作「没有这一列」` |

`map_markers` 的这几列在 schema 上是 `REAL` / `TEXT`，所以这条窄化从真实存储走不到。
窄的方向是安全的那一侧：**一个读不懂的坐标画不出避让圈，那正是它该有的下场** ——
而旧仓那条路会在几十行之后以一句看不懂的 `TypeError` 结束。

## D-MAP-9 · `distance_m` 的最后一位 —— D-HYPOT-1 在这一族的落点

| | |
|---|---|
| **Python** | `math.hypot(4e-7, 4e-7)` → `5.65685424949238e-07` |
| **TS** | `Math.hypot(4e-7, 4e-7)` → `5.656854249492381e-07`（差 1 ULP） |
| **测试** | `map-layer.test.ts` / `clean-spot.test.ts` → `distance ULP：实测占容差的比例 < 1`；`traces.test.ts` 的 `HYPOT_KEYS` |

D-HYPOT-1 已经裁过这件事（保留 `Math.hypot`，登记差异）。这里要补的是
**它在这一族里改不了任何一个决定**，而那不是运气，是**造金样时刻意安排的**：

* 落点坐标是 `gx * step`（整数乘一个 double）⇒ **两边逐位相同**，顺序与个数零容差；
* 同距候选由**对称的同一个表达式**算出（`hypot(s,0)` 对 `hypot(0,s)`、
  `hypot(s,s)` 对 `hypot(s,-s)`）⇒ 两种语言各自内部相等，稳定排序不会翻；
* **每一条边界判据都造在轴上**（`hypot(a, 0)` 两边都精确）——
  `circle_touching_is_blocked` / `exclude_exact_diameter_is_kept` /
  `max_distance_exact_is_kept` 三格；
* 报文里的距离是 `:.0f` / `:.1f`，最后一位在字符串这一侧**表示不出来**。

容差 `4 · eps`（一个 ULP 的四倍）。它盖不住任何一次真的算错：这一族的错要么是
**选错了点**（坐标就不一样了），要么是**量错了距离**（纳米级）。

## D-MAP-10 · `nanonis_calls` 那一栏不存在 ⇒「读针尖那一次不记账」这条区分没有落点

| | |
|---|---|
| **Python** | `read_tip_xy` 的那一次 `safe_call` **不进** `SkillResult.nanonis_calls`（`Piezo_RangeGet` 进） |
| **TS** | `SkillResultLike` 没有这一栏 —— 调用台账由内核记（同 `RetractForSampleChange` 抬头） |
| **测试** | `clean-spot.test.ts` → 每一格都断言**真正下发了什么**（`calls`），而不是回包里的那一栏 |

## D-MAP-11 · 三处「没有任何输入能验它」（照移、注明、**不打变异**）

green-8 §4 的第三种形状。三处都保留代码 + 就地注明，并且**变异清单里一条都没打**
——打了也永远绿，而那会让一条「闸不存在」混进 32 条真闸里。

| 处 | 为什么不可达 |
|---|---|
| `analysisConfig` 的 `spacing()` 里 `v < 1.0 ? 1.2 : v` | `sanitizeProfile` 已经把 `scan_spacing_factor` 夹进 `[1, 20]`，而缺省是 1.2 ⇒ 小于 1 的值进不来（金样 `config.spacing_below_one_is_clamped` 把这条钉死） |
| `FindCleanSpot` 拒绝话术外面那道 `try` | 它防的是「报错的修饰把报错本身弄坏」，而 `nearestCleanFrom` 在**同一份 marker 表**上已经先调过一次 `buildAvoidCircles` ⇒ 唯一能让它抛的东西会在那里先炸。测试 `没有任何输入能验它（证明在这里）` 把这条**证明**钉住 |
| `nearestCleanFrom` 的 `maxRing = trunc(reach/step) + 2` | 第 r 环上每个格至少有一个坐标是 `±r·step`，`r·step > reach` 时整环出局 ⇒ 超出 `trunc(reach/step)` 的环一个点都贡献不了。`+2` 是取整余量，不是一道闸 |

另有一处**在 TS 里结构上不可达**（不是照移的问题）：`exp-map.ts` 的
`coerceFloat` 显式拒 `bool`。Python 里 `isinstance(True, int)` 为真，所以那一条在旧仓
是真的在挡；TS 里 `true` 既不是 `number` 也不是 `string`，最后那个 `else return null`
本来就接住了它。**守卫留着**（它写的是意图，而 `epochOfRow` 的语义确实要求拒 bool），
变异不打它。

<!-- ── 批 7a-3（kde_layers + FindFlatRegion + BiasWiggle）的登记写在这一行下面 ── -->

<!-- 批 7a-3：编号**留空**（`?`），由主线统一编。 -->

## D-FLAT-1 · 设计阵**掉秩**时 `_local_plane_rms` 给 `null`，旧仓给「一块完美的平地」

| | |
|---|---|
| **Python** | 窗内 ≥ 12 个有效点**全落在同一行**（真机上是 NaN 挖出来的形状）时 `[x, y, 1]` 掉秩，`np.linalg.lstsq` 走 SVD 给一个**最小范数解** —— 一条直线被一个平面拟合的残差恰好是 0，于是它报 `rms = 4.5e−28` |
| **TS** | `lstsqPlane` 走中心化正规方程，掉秩时 Cholesky 抛 ⇒ `localPlaneRms` 返回 `null`，那个窗**跳过** |
| **测试** | `l0/batch7a3-skills.test.ts` → `_local_plane_rms > collinear`（两侧都断言：本仓 `null`，而金样是一个 `< 1e−20` 的数 —— 差异消失这条就红） |

**为什么有意**：那个 `4.5e−28` 会**赢下 `argmin`**，然后调用方拿着它的坐标去移动针尖。
这与本技能自己那道前置（`judge_frame` 拦死平帧）挡的是同一件事，原话就在那里：
「读起来像『找到了一块完美的平地』，而调用方拿这个坐标去移动针尖。」
按 DoD ⑤ 缺陷判据不照抄。

本仓这一侧**不是碰巧**：`numerics/fit.ts` 的抬头写着「不满秩就抛 —— 一个不满秩的系统
解出来的是『某一个解』，而调用方会把它当成『那个解』」。掉秩的窗判不了，就该说判不了。

## D-WIGGLE-1 · `BiasWiggle` 的收尾**没有 `allow_on_abort` 那个逃生口**（本批的欠账）

| | |
|---|---|
| **Python** | `_restore` 两处写的是 `context.safe_call("Bias_Set", …, allow_on_abort=True)` —— 中止闩上之后 `Bias_Set` 被动词闸拒，而这次写**是因为 abort 才要做的**，所以显式走逃生口 |
| **TS** | `SafeCall` 的签名是 `(method, ...args)`，**本仓没有这个口**；`Bias_Set` 也不在 `ABORT_SAFE_WRITES` 里（那张表按「停」的语义建，而 `Bias_Set` 没有哪个实参形能表达「停」）。收尾照直发 `ctx.safeCall` |
| **测试** | `l0/batch7a3-skills.test.ts` → 「⚠️ 中止闩上时：`Bias_Set` 全被拒，而 `bias_restored` 照样报 true（本批的欠账）」，以及「**收尾那几次在旧仓是带 `allow_on_abort=True` 的**，本仓没有那个口」（后者从金样的 `calls[].kwargs` 里证明那个差异还在） |

**为什么有意**：**今天它不改变任何人的行为** —— 本仓还没有任何地方把 `gatedSafeCall`
接进 `SkillContext.safeCall`（中止闩在工具入口的 K2 与 `stm-safety` 的 guard 上）。
而那一天来的时候，这个技能会：每一次 `Bias_Set` 被拒 ⇒ 第一次跳变就停 ⇒ 收尾也被拒
⇒ **而 `data.bias_restored` 照样报 `true`**。

本批**没有发明那个口**，三条理由（逐条可核）：

1. **它今天没有流量。** 没有消费方 ⇒ 金样到不了它、变异也红不了它 —— 按 green-8 §2.8，
   那是一段没有闸的守卫；
2. **口的形状是内核接口改动。** 按 `SkillContext` 自己的原话，它要写成**一个单独命名的
   入口**（同 `emergencyCall` / `slowCall`：「这条路谁在走、走了几次，要能一眼 grep 出来」），
   而那会动到三十来处构造 `SkillContext` 的夹具 —— 在三条支线并行的一轮里，
   那是一次看不见别人工作树的破坏性改动。**做成可选的更坏**：静默回落到 `safeCall`，
   洞还在，而且看起来补上了；
3. **它是一个安全口，需要的是政策不是通道。** 「中止之后谁还能发命令」在本仓的答案一直是
   **一张按动词与实参判的表**（`ABORT_SAFE_WRITES`）；照抄旧仓那个「任何技能想走就走」的
   参数，等于把更松的那个模型换个名字请回来。

⇒ 本批的处置是**把洞钉住**：那条测试今天绿（它断言的正是「放不回去、而回包说放回去了」），
**开口的那天它会红**，于是 `bias_restored` 必须跟着改成实话。
完整的落地建议写在 `docs/handoff/batch-7a-3.md` §7。

## D-WIGGLE-2 · `_restore` 的 `except Exception: pass` **不照抄**（在这一侧不可达）

| | |
|---|---|
| **Python** | `_restore` 整段套着 `except Exception: pass`（「收尾绝不能把已经发生的事变成异常」） |
| **TS** | **没有这个 try/catch** |
| **测试** | 无 —— 正因为它不可达才不写；`SkillContext.safeCall` 的约定是**永不抛**（失败表达成 `record.error`），`ctx.sleep` 同理 |

**为什么有意**：同 green-8 §2.8 与批 6c 的 `D-FORCE-3`。旧仓那个 `except` 挡的是
`safe_call` 可能抛出来的东西，而本仓这条约定写在 `SkillContext` 的抬头里、由内核保证。
照抄它等于留一段**永远进不去**的守卫，而那种东西的坏处 green-8 已经量过：
它看起来在挡什么，于是没有人再去问那里到底有没有闸。

## 指回 **D-SI-1** · `exclude_used_spots` 里的 `nan,0` / `inf,0`（**不要新编号**）

这一条**不是新差异**，是 D-SI-1（「宽松档拒绝 `inf` / `nan`」）在 `FindFlatRegion` 上的
**第二例**，写在这里只是为了让它有一处指得到的落点。

| | |
|---|---|
| **Python** | `parse_quantity('nan', strict=False)` 走 `float()` ⇒ `NaN` 被当成一个**合法坐标**收下（金样 `parse_excluded` 那两格逐字录着） |
| **TS** | 抛 `SIParseError` ⇒ 进 `bad`，整次调用被「exclude_used_spots 里有解析不了的坐标」拒掉 |
| **测试** | `l0/batch7a3-skills.test.ts` → `_parse_excluded（逐格对金样）> "nan,0"` / `"inf,0"`（两侧都断言） |

**为什么有意**：D-SI-1 那条登记里写的后果在这里**原样发生**了一次 ——
一个 NaN 坐标穿过之后，`(cx − nan)² + (cy − nan)² < min_sep²` **恒为假**，
于是「别再选这几个点」悄悄变成「一个都不排除」。
而这个技能的拒绝文案自己就写着：**「没有把这些点排除掉就选点是危险的 ——
它们正是你要避开的位置。」** 旧仓在同一个函数里为了这句话把
`except ValueError: continue` 改成了报错，却在 `parse_quantity` 那一层把 NaN 放了进来。

<!-- ── 批 6c（批 5b 欠下的数值原语 + 晶格一族剩余）的登记写在这一行下面 ── -->

## D-FORCE-1 · `InvertForceSaderJarvis` **真的把 F(z)/U(z) 落盘**（旧仓那一份从没落过）

| | |
|---|---|
| **Python** | `_save_curve` 里写的是 `from mast.core._runtime_paths import project_root` —— **那个模块不存在**（2026-09-19 实测：全仓另外 **79 处**写的都是 `mast._runtime_paths`，错写成 `mast.core.` 的只有 **2 处**。订正自本条初稿的「十几处」—— 那是估的）。外面套着 `except Exception: return None` ⇒ `curve_path` **恒为 `None`** |
| **TS** | 真的写 `<curveDir>/<stem>_force.json`，`curve_path` 带着它 |
| **测试** | `l0/batch6c-skills.test.ts` → 「F(z)/U(z) **真的落了盘**，而路径进回包」（读回文件、比点数、确认 `data` 里**没有**曲线本身） |

按 DoD ⑤「KNOWN_ISSUES 里的缺陷判据不照抄」。这不是风格差异：`data` 里**只有** `curve_path`，
没有 `z_m` / `force_n` / `energy_ev` —— 也就是说这个技能唯一的产品（那条力曲线）在旧仓里
**一次都没有产出过**，而调用方拿到的是一份看起来完整、只是没有曲线的报告。

⚠️ **同一个死导入在旧仓还有第二处**（`skills/builtins/dispersion_fit.py:315` 的 `_save_table`），
而那一处**不照这条办**：它的 `except` 后面带着一句注释，大意是「数才是产品，表只是附赠」——
对色散拟合成立，所以那里落不落盘都不改变技能交付了什么。
**分界线是「唯一的产品在不在」**：力反演的 `data` 里只有标量（见下），曲线就是它的全部产出；
色散拟合的数在回包里。同一个 bug，两种处置，靠的不是它长什么样，是它挡住了什么。

⚠️ 顺带一条**目录的**差异：旧仓的根是 `project_root()`（`MAST2_PROJECT_ROOT` 或仓根），
本仓是 `process.cwd()/artifacts/force_inversion`，并按 `frames.ts` / `readback-stream.ts` 的既有体例
留了一个注入口（`makeInvertForceSaderJarvis({ curveDir })`）。金样两侧都归一成 `<artifacts>`。

## D-FORCE-2 · `ForceInversionResult.notes` 不实现

| | |
|---|---|
| **Python** | dataclass 上有一个 `notes: dict`，**恒为 `{}`** |
| **TS** | 没有这个字段 |
| **测试** | `vision/batch6c-units.test.ts` 的 `withoutNotes()` —— 比对前从金样里摘掉 |

消融精神：技能层一个字段都不读它，而它从来没有被写过。

## D-FORCE-3 · `forward_df` 的**小振幅极限**那一支不实现，改成抛

| | |
|---|---|
| **Python** | `a < 1e-13` 时走有限差分的 `−f₀/(2k)·F′` |
| **TS** | 抛 `RangeError`，消息里说明为什么 |
| **测试** | 无 —— **它没有输入**（见下） |

`amplitude_m` 的声明下界就是 `1e-13`，另外两条来源（`.dat` 头 / 振幅列）都要
`1e-13 < v < 1e-8` ⇒ 从这个技能出发**无论如何走不到**那一支。
要验它需要什么：一格 `a ≤ 1e-13` 的入参，而且那一格的答案要与本式在 `a → 0` 的极限**不同**
（否则两种候选分不开）。在那之前，一条抛出来的 `RangeError` 比一段没人验的分支诚实。

## D-SHARP-2 · 没有像素标度时 `verdict` 报 `no_step`，而同一格的 `has_step` 是 `true`

| | |
|---|---|
| **Python** | `verdict` 只看 `edge_resolution_nm`，而那一项需要标度；`has_step` 看的是 `nm` **或** `px` |
| **TS** | **照移** |
| **测试** | `l0/batch6c-skills.test.ts` → 「没有像素标度时 `verdict` 报 `no_step`，**而 `has_step` 是 true**」 |

**照移未改**：同一格里两句话互相矛盾（`edge_resolution_px` 是个数、`has_step` 是 true、
而 `verdict` 说「这张图里没有清晰台阶」）。改掉的正是模型读的那一句 ——
统一成一种写法会让金样里那条报文对不上，而那条报文是这个技能的产品。
写在这里是为了让它**看得见**：读 `verdict` 的下游在无标度的帧上会得到一个假的否定。

## D-LATTICE-4 · `_UNUSABLE_REASONS` 里的 `"too_small"` **永远匹配不上**

| | |
|---|---|
| **Python** | `lattice_multiframe._UNUSABLE_REASONS` 含 `"too_small"`，而 `find_lattice_peaks` 报的是 `"image_too_small"` |
| **TS** | **照移**（`UNUSABLE_REASONS` 逐字相同） |
| **测试** | `vision/batch6c-units.test.ts` → 「`半帧 NaN` 走的是 `incomplete_frame` —— 而 `image_too_small` **落不进** `UNUSABLE_REASONS`」 |

两个串对不上 ⇒ 一帧「太小」被算成**可用帧上没有晶格**，也就是算成了「这个晶格是假的」
那一侧的证据。而那张四态表存在的全部理由，就是把「帧用不了」与「帧可用但没有晶格」分开。

照移，因为改它会**同时**改掉下游那四个态的分布，而金样里 `absent` / `undetermined` 两格
正是按现在这个分法录的。哪天改，要连同「下游的四态表跟着变了吗」一起问。
那条测试就是为这一天留的：它一红，先问那个问题。

## D-NUM-24 · `np.gradient(y, x)`：**间距恰好相等就退回标量分支**

| | |
|---|---|
| **numpy** | 进函数前先 `if (diff(x) == diff(x)[0]).all(): dx = diff(x)[0]`（源码注释写的是「a consistent speedup」） |
| **TS** | **照抄那一条**（`calculus.ts` 的 `uniform` 分支） |
| **测试** | `numerics.test.ts` → 「五格**逐位**等于 numpy（容差 0）」的 `uniform` 那一格 |

它换的**是算法不是速度**：标量分支算 `(f[i+1] − f[i−1]) / (2·dx)`，非均匀分支算
`a·f[i−1] + b·f[i] + c·f[i+1]`，两者数学相等、浮点差一两个 ulp。
本仓第一版没写这一条，`calculus.gradient.uniform` 当场红在最后一位上 ——
**而只有等距那一格分得开**（非等距的格上两条分支给的是完全不同的数，错了一眼看出来）。

这不是「与 numpy 不同」，是「与 numpy 相同**所以必须照抄一个看起来像优化的分支**」。
登记在这里，是因为下一个人很容易把它当成冗余删掉。

## D-NUM-25 · `np.corrcoef` **给不出零容差**（`np.dot` 走 BLAS）

| | |
|---|---|
| **numpy** | `cov` 里那次 `X @ Xᵀ` 走 BLAS，累加顺序不是成对 |
| **TS** | 走 {@link npSum}（成对），容差 `corrcoefAbsTol(n) = 8·sumRelTol(n)`，**绝对** |
| **测试** | `numerics.test.ts` → 「六格对 numpy」+ 三条**结构性**断言（自相关恰好 1、反相关恰好 −1、平移不改） |

与 `pairwise.ts` 那一族的分界就在这里：**累加顺序照抄得了的给 0，照抄不了的给界**。
容差写成绝对是因为这个量落在 `[−1, 1]` 而且近零的 `r` 是相消的结果 ——
相消毁掉相对精度、不毁绝对精度。

## D-TIPMETRIC-1 · `_fwd_bwd_instability` 在**只扫了一行**的帧上两边不同

| | |
|---|---|
| **Python** | `_detrend` 的 `[x, y, 1]` 在单行上秩亏，`np.linalg.lstsq` 给**最小范数解**、照常去趋势 ⇒ 这个量是一个正常的数（合成 `1×64` 帧实测 `0.78273`） |
| **TS** | `lstsqPlane` 对秩亏回 `null` ⇒ `detrend` 整帧 NaN ⇒ 这个量是 **NaN** |
| **测试** | 无 —— **这一格没有金样**，登记在这里正是因为它没有 |

`measureFrame` 喂进来的是 `acquiredRowSpan` 切出来的已扫行段，所以「只有一行」
是一张刚开扫的帧的**正常形状**，不是构造出来的输入。

**本轮不改**，理由是改它要动 `lstsqPlane` 的秩亏语义（`null` vs 最小范数解），
而那一份是批 4a 的件、有十几个消费方与四份金样在读；一次没有金样撑着的语义变更，
会把「移对了没有」这个问题变成「我猜哪一种对」。

要销它需要什么：一格 `H = 1`（以及 `H = 2`、`H = 3`）的 `fwd_bwd_instability` 金样，
由 `export_scan_prep.py` 从旧仓导出 —— 有了那三格，秩亏那一条该怎么处置就是被
测出来的，不是被决定的。在那之前，`safeDelegate` 会把 NaN 如实报进
`measureFrame` 的 `errors`，而**一个 NaN 比一个看起来正常的 `1e−13` 诚实**
（批 6b 那一份走 `detrend32`，秩亏时系数退化成 0，给出的是后者）。

## D-LSQ-1 · `polyfit` 有**两份**，而且是故意的

| | |
|---|---|
| **numpy** | `np.polyfit` 一份：列缩放后走 **SVD**（`gelsd`） |
| **TS** | **两份**：`numerics/savgol.ts`（列缩放 + 正规方程，误差 `κ²·eps`）与 `vision/lsq.ts`（列缩放 + Householder **QR**，误差 `κ·eps`） |
| **测试** | `numerics.test.ts` 的 `polyfit` 一节（对 `spec/golden/numerics.json`）· `vision/scan-prep.test.ts` 的 `line_subtract` 一族（对 `spec/golden/scan_prep.json`） |

它们**不是同一个函数**：同一份 `n=256, deg=3` 的数据上系数相对差 **`5e−9`**
（不是最后一位）；某一列范数为 0 时 QR 那份照解、正规方程那份抛
「设计矩阵不满秩」。

为什么不合并成一份：**各自的消费方要的正是各自那一档精度**。
`scan_prep.poly_subtract(order=2)` 的设计阵 `[1, x, x², y, xy, y²]` 在 256 边长上
κ(A) ≈ 1e6 ⇒ 正规方程只剩四位，而 `bow_gain` 要拿残差跟 1.15 比大小；
`savgol` 那一份则是它自己两端重算的一步，容差按 `lstsqRelTol(κ²)` 推过、金样录过。
统一成任一份都会**同时**改动 `spec/golden/numerics.json` 与 `spec/golden/scan_prep.json`。

登记在这里而不是悄悄留着，是因为「同一个 numpy 函数在本仓有两份实现」正是
「十份 `cell()`」那个形状 —— 区别在于**这一份是被验过的**：两者的差不是
最后一位，而是 `5e−9`，也就是说它们**分得开**，而分开它们的那个输入已经在上面。
要合并，判据是**先有一格能分开它们的金样**，而不是「看起来一样」。

<!-- ── 收尾支线（`pyFixed` 负零 + `tip_policy` 深度边界）的登记写在这一行下面 ── -->

<!-- 收尾支线：以下 1 条的**编号留空**（`?`），由主线统一编。 -->

## D-LANG-3 · `pyFixed` 的**符号与半分点都不能从算出来的那个数里读**

语言分歧一族的又一处，而它修的是**这一族自己的第六个成员**（`pyFixed`，D-LANG-1）。
2026-09-19 对着 CPython 3.13 跑了 **10 843 个 double × 7 档小数位 = 75 901 格**
（含全部 `n/2^k` 半分点与一万个伪随机 double），本仓这一份当时有 **70 格**分岔。

| | |
|---|---|
| **Python** | `"%.*f" % (n, x)`：符号取自**输入**（`"%.1f" % -0.0` = `'-0.0'`），半分点按**精确值**判、round-half-even |
| **TS（改前）** | 符号交给 `toFixed`（判 `x < 0`，而 `-0 < 0` 为**假**）；半分点判「`v·10^(d+1)` 是整数且末位 ±5」 |
| **TS（改后）** | `sign = v < 0 \|\| Object.is(v, -0)`；半分点判「`\|v\|·2^(d+1)` 是**奇整数**」—— 这个乘法是纯指数平移，不舍入 |
| **测试** | `kernel/src/z-trace.test.ts` →「与 CPython 逐个对过的三类分岔」四组 `it.each`（50 格） |
| **变异** | `pyfixed-sign-comes-from-the-input` · `pyfixed-half-point-test-is-exact` · `pyfixed-rounds-half-to-even`（既有那条改了 find 串） |

### ① 负号：**与 `formatG` 那次是同一个坑**

`si.ts:57` 早就为 `formatG` 立过规矩（逐字：「`-0` 出现在界或读数里，多半意味着上游
做了一次乘负或取反 —— 把符号擦掉，就把那条线索也擦掉了」），**`pyFixed` 漏了**。
`pyFloatRepr`（`si.ts:220`）也有同一道守卫，注释就写着「同 `formatG`」。
三份里两份有、一份没有 —— 而分辨它们的唯一办法是找一个能把它们分开的输入。

**这一格真的印在报文里**：批 6b 撞见的原话是「最接近的通道是 `dc`(-0.0)」。
而且它不只是 `-0` 自己：任何**四舍五入之后变成零、符号还在**的数
（`-1e-9`、`-0.0004`、`-0.04` @1 位…）都走这条路，后者才是常见情形。

### ② 半分点：上一版用的正是 `pyRound` 抬头明写「会错」的那种写法

改前的注释断言「能满足它的只有二进制精确表示的数，而那时这个乘法本身也是精确的 ——
**不精确的数落不到半分点上**」。**那句断言是假的**，而 D-LANG-2（`pyRound`）的抬头
第一条警告写的就是它：*那个乘法自己要舍入*。`2.675` 的精确值是 2.67499999999999982…，
`2.675 * 1000` 却**恰好**得到 `2675` ⇒ 被判成半分点、取偶按到 `'2.68'`，CPython 给 `'2.67'`。
63/70 格是这一类。

真判据不用看小数位：`a` 正好落在第 `d` 位的半分点 ⟺ `a = q/2^(d+1)`、`q` 为奇整数
（`a = (2j+1)/(2·10^d) = (2j+1)/(2^(d+1)·5^d)`，而 `a` 是二进制小数 ⇒ `5^d | (2j+1)`）。

### ③ 两者叠起来

`"%.0f" % -0.5`：半分点分支算出 `0`，正负号在那一步一起没了 ⇒ `'0'`，CPython 给 `'-0'`。

### 这条**没有**改任何一份金样

`spec/golden/` 全部 41 台导出器都是 **Python 侧**驱动的，印的是旧仓自己的数 ——
改本仓的 `pyFixed` 动不到它们（改后全量重跑，41 份逐字节相同）。
换句话说：**这 70 格分岔此前一格金样都照不到**。它们能被发现，是因为批 6b 在
`scan-prep` 报文里撞见了 `-0.0`，而不是因为哪条判据变红了。

**批 6b 那两处 `fx()` 挡板**（`l0/scan-prep-skills.ts` 与 `vision/src/scan-prep.ts`）
当时各挡了一层绕开 kernel。**两处都已撤，这笔欠账 2026-09-19 结清。**

- `l0/scan-prep-skills.ts`：整个 `fx()` 删掉，**15 处**调用（分布在 11 行）直接走
  `pyFixed`，行为一字未改。（订正：本条初稿与提交 `0171470` 正文都写「十处」；
  改前文件里 `fx(` 出现 16 次，减去 `:119` 的定义 = 15。）
- `vision/src/scan-prep.ts`：当天晚些时候撤掉。原文写它「现在是一句**恒假**的判断」——
  **不对，是冗余**：输入 `-0` 照样走进那一支，只是 `pyFixed` 修好之后两条路
  逐字给出同一个 `'-0.000'`。

⚠️ 这个区别不是措辞：**「走不到」和「走了也一样」只有后者可以直接删。**
前者删掉会改变将来某个输入的命运（那一支迟早会被走到，只是今天的输入够不着），
后者删掉今天明天都不改变任何输出。判它属于后者靠的是 `kernel/src/z-trace.test.ts` 里
`[-0, 0|1|2] → '-0' / '-0.0' / '-0.00'` 那三格 —— **没有那三格，这个删除就只是看起来安全。**

### 还剩一处已知分岔（**没修**，出了这条的范围）

`|v| ≥ 1e21` 时 `toFixed` 按 ECMA-262 回 `ToString(v)`（`'1e+21'`），而 CPython 印完整
展开的 `'1000000000000000000000.000'`。`pyFixed` 今天的调用方全是百分比 / 皮米 / 倍数，
到不了那个量级；`pyRound`（D-LANG-2）那边有同一条边界，处理是 `>= 1e21` 直接原样返回。
真要修，两处一起修。
