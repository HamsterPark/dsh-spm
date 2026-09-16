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

## D-NUM-7 · RNG 求的是**可复现**，不是「与 numpy 相同」

xoshiro128\*\*，不是 PCG64。判据是同种子同串；金样里钉的是本仓自己那一串，
于是将来任何一次「顺手换个 RNG」都会当场变红。

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

两者都不认下划线与十六进制（Python `float("1_000")` 同样是抛的，见 D-SI-2）。
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

## D-TIP-1 · 针尖安全包络（`apply_tip_policy`）**没有移植** —— 欠 Phase 5.3

旧仓 `BiasPulseWithReadback.validate_params` 按**当前登记的针尖**检查方案表包络，
**超上限拒绝、不夹紧**（同粗动电压四重锁那条哲学）。修针默认的 ±10 V 是用户对
**金属丝针尖**的做法；铂铱（8 V）、磁性/超导针、qPlus（3 V）会在那里被拒绝 ——
**那不是 bug，是保护**。

它要 `mast.core.tip_conditioning_resolver`（针尖登记表，Phase 5.3）。在那之前这一侧
只有全局 ±10 V 的 SafetyGate 在挡。**没有写一个空的 `validateParams`** ——
写了会让人以为这道闸在。欠账写在 `readback-skills.ts` 的 docstring 里。

金样照不出这一条：导出脚本直接调 `execute`，`validate_params` 一次都没被调用。

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

<!-- ── 批 4c（paper 数据处理 + scan_frame 一族）的登记写在这一行下面 ── -->

<!-- ── 批 4d（composite.scan_at + 撞针追踪）的登记写在这一行下面 ── -->
