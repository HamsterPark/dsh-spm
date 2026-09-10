/**
 * 从 `spec/golden/records_schema.sql` 生成 `RECORDS_DDL` 常量。
 *
 *     node scripts/gen-records-schema.ts            # 写文件
 *     node scripts/gen-records-schema.ts --check    # 只比对，有 diff 就非零退出
 *
 * 为什么生成而不是手抄：**建表语句就是规格本身**。抄一份进 TS 就有了第二份，
 * 而两份迟早漂开——记录库尤其不能这样，一张审计表跟丢一个列，症状是「查不到」，
 * 不是「崩了」。金样由旧仓真实的 `ALL_DDL` 导出，这里只是把它搬进包里。
 *
 * 搬进包里是必须的：profile 的 `node_modules` 里没有 `spec/`，运行期读不到那个文件。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const SRC = fileURLToPath(new URL('spec/golden/records_schema.sql', root))
const OUT = fileURLToPath(new URL('packages/host/stm-records/src/generated/schema.ts', root))

function main(): number {
  const sql = readFileSync(SRC, 'utf8')
  const tables = (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length
  const indexes = (sql.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length

  const text =
    `// 由 \`node scripts/gen-records-schema.ts\` 生成，**不要手改**。\n` +
    `// 源：spec/golden/records_schema.sql（旧仓 mast/logging/v2/schema.py::ALL_DDL）\n` +
    `\n` +
    `/** v2 记录库的完整建表语句：${tables} 张表 / ${indexes} 个索引。 */\n` +
    `export const RECORDS_DDL = ${JSON.stringify(sql)}\n`

  const check = process.argv.includes('--check')
  const current = ((): string | null => {
    try {
      return readFileSync(OUT, 'utf8')
    } catch {
      return null
    }
  })()

  if (check) {
    if (current === text) {
      console.log(`✓ generated/schema.ts 与金样同步（${tables} 张表 / ${indexes} 个索引）`)
      return 0
    }
    console.error('✗ generated/schema.ts 与金样不同步。跑 `node scripts/gen-records-schema.ts`。')
    return 1
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, text, { encoding: 'utf8' })
  console.log(`✓ 生成 RECORDS_DDL：${tables} 张表 / ${indexes} 个索引`)
  return 0
}

process.exit(main())
