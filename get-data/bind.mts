import { readFileSync } from 'node:fs'
import { loadConfig } from './src/config'
const cfg = loadConfig()
const c = JSON.parse(readFileSync(`${cfg.dataDir}/auth.json`, 'utf8'))
const cookie = `openid=${c.openid}; access_token=${c.access_token}; acctype=${c.acctype}; appid=${c.appid}`
const IDE = 'https://comm.ams.game.qq.com/ide/'
async function ide(label: string, form: Record<string, string | number>) {
  const r = await fetch(IDE, {
    method: 'POST',
    headers: { Referer: 'https://df.qq.com/', Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString(),
  })
  const j = (await r.json()) as any
  console.log(`\n### ${label}\nHTTP ${r.status} ret=${j.ret} iRet=${j.iRet} sMsg=${j.sMsg}`)
  console.log(JSON.stringify(j.jData).slice(0, 500))
  return j
}
// ① 绑定状态
const s1 = await ide('① 绑定状态', { iChartId: 316964, iSubChartId: 316964, sIdeToken: '95ookO' })
if (s1?.jData?.bindarea) {
  console.log('已经绑过了，bindarea =', JSON.stringify(s1.jData.bindarea).slice(0, 300))
} else {
  // ② 查角色
  const roleUrl = 'https://comm.aci.game.qq.com/main?' + new URLSearchParams({
    needGopenid: '1', sAMSAcctype: 'qq', sAMSAccessToken: c.access_token,
    sAMSAppOpenId: c.openid, sAMSTargetAppId: '1110543085', sAMSSourceAppId: '101491592',
    game: 'dfm', sCloudApiName: 'ams.gameattr.role', area: '36', platid: '1', partition: '36',
  }).toString()
  const rr = await fetch(roleUrl, { headers: { Referer: 'https://df.qq.com/' } })
  const txt = await rr.text()
  const top: Record<string, string> = {}
  for (const m of txt.matchAll(/(\w+):'([^']*)'/g)) top[m[1]!] = m[2]!
  for (const m of txt.matchAll(/(\w+):(-?\d+)/g)) top[m[1]!] = m[2]!
  const inner: Record<string, string> = {}
  for (const m of (top['data'] ?? '').matchAll(/(\w+)=([^&]*)/g)) inner[m[1]!] = m[2]!
  console.log('\n### ② 查角色\n顶层字段:', Object.keys(top).join(', '))
  console.log('data 内字段数:', Object.keys(inner).length, '| 角色名:', inner['charac_name'])
  const checkparam = top['checkparam'] ?? inner['checkparam'] ?? ''
  const md5str = top['md5str'] ?? inner['md5str'] ?? ''
  console.log('checkparam:', checkparam ? checkparam.slice(0, 80) : '（没有）')
  console.log('md5str:', md5str ? md5str.slice(0, 40) : '（没有）')
  if (!checkparam || !md5str) { console.log('\n⛔ 拿不到 checkparam/md5str，无法绑定'); process.exit(1) }
  const roleId = checkparam.split('|')[2] ?? ''
  // ③ 提交绑定
  const s3 = await ide('③ 提交绑定', {
    iChartId: 316965, iSubChartId: 316965, sIdeToken: 'sTzZS2',
    sArea: 36, sPlatId: 1, sPartition: 36, sCheckparam: checkparam, sRoleId: roleId, md5str,
  })
  console.log('绑定结果:', s3.ret === 0 ? '✅ 成功' : '✗ 失败')
  // ④ 复核
  await ide('④ 复核绑定状态', { iChartId: 316964, iSubChartId: 316964, sIdeToken: '95ookO' })
}
// ⑤ 制造（用 POST，之前用 GET 是错的）
await ide('⑤ 制造', { iChartId: 365589, iSubChartId: 365589, sIdeToken: 'bQaMCQ', source: 5 })
