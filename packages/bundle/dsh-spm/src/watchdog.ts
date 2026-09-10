/**
 * bundle 的子路径入口：`name: dsh-spm/watchdog`。
 *
 * 与状态缓存一样**归 bundle 的 patch 而不归 profile 的**：
 * 「有没有针尖看门狗」不因 profile 而异——sim / offline / rig 都要它。
 * （真机那份尤其要，但正因为如此，它不能是 rig 专属的一行：
 * 只在真机上才生效的安全件，等于在模拟器上从来没被验过。）
 */
export { name, apply, inject, type Config } from 'dsh-spm-instrument-watchdog'
