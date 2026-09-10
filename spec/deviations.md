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
