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

## D-APPROACH-1 · 进针参数组的切换与放回不移植

| | |
|---|---|
| **Python** | `run_composite` 走 `apply_approach_preset` → 跑图 → `finally: restore_zctrl`，并把 `zctrl_preset` / `zctrl_preset_applied` / `zctrl_preset_note` 三行留痕放进 `data` |
| **我们** | 不切参数组，也就没有要放回的东西 |
| **影响面** | 轨迹金样里 11 格的三个字段，登记在 `l0/traces.test.ts` 的 `absent` |

**为什么有意**：它依赖 `mast.core.zctrl_presets` 参数组存储，本仓还没有——而那份存储
同时也是 `CreateZCtrlPreset` 卡着的东西，两者该一起落。

**为什么这不是半个闸**：**没配参数组本来就是旧仓支持的正常配置**。导出机上就没配，
金样里那三行记的正是「仪器档案里没有可用的进针参数组，本次进针沿用当前 Z 控制器增益
（即改动前的行为）」——也就是本仓现在做的事。

**⚠️ 但 `finally` 那一条是真的债。** 缺陷⑫的判据是「这个状态是不是我改的」：中止时
**更**需要放回去，与「中止不动手」（缺陷⑪）刻意相反。补参数组的时候必须连它一起补，
不能只补切换。

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
