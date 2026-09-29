import { describe, expect, it } from 'vitest'
import { buildIdeRequest, summarizeIde } from './ide'

describe('buildIdeRequest', () => {
  it('⭐ 参数放 POST 表单体（拼 URL 上会读不到 —— 踩过）', () => {
    const r = buildIdeRequest('530479', 'SwgEeH', { action: '3' }, 'openid=x')
    expect(r.url).toBe('https://comm.ams.game.qq.com/ide/')
    expect(r.url).not.toContain('iChartId')
    expect(r.body).toContain('iChartId=530479')
    expect(r.body).toContain('iSubChartId=530479')
    expect(r.body).toContain('sIdeToken=SwgEeH')
    expect(r.body).toContain('action=3')
  })

  it('必须带 Referer（官方会看它）', () => {
    expect(buildIdeRequest('1', 't', {}).headers['Referer']).toBe('https://df.qq.com/')
  })

  it('不给 cookie 就不带 Cookie 头（用来做无登录对照实验）', () => {
    expect(buildIdeRequest('1', 't', {}).headers['Cookie']).toBeUndefined()
  })

  it('调用方的参数不会被内置键覆盖顺序问题影响', () => {
    const r = buildIdeRequest('1', 't', { iChartId: '999', method: 'x' })
    expect(r.body).toContain('iChartId=999') // 后写的生效
    expect(r.body).toContain('method=x')
  })
})

describe('summarizeIde', () => {
  it('正常：ret=0 + 嵌套数组', () => {
    const s = summarizeIde(200, '{"ret":0,"iRet":0,"sMsg":"ok","jData":{"data":{"code":0,"data":[1,2,3]}}}')
    expect(s).toMatchObject({ status: 200, ret: 0, innerCode: 0, dataShape: '数组（3 条）', jDataKeys: ['data'] })
  })

  it('⭐ 军需处那种：jData.data 直接是数组', () => {
    const s = summarizeIde(200, '{"ret":0,"jData":{"iRet":"0","sMsg":"ok","data":[1,2]}}')
    expect(s.dataShape).toBe('数组（2 条）')
  })

  it('⭐ ret=-4000 那种"访问人数太多"能如实读出（不美化）', () => {
    const s = summarizeIde(200, '{"ret":-4000,"sMsg":"抱歉，目前访问人数太多！"}')
    expect(s.ret).toBe(-4000)
    expect(s.sMsg).toContain('访问人数太多')
  })

  it('⭐ ret=0 但空数组 —— dataShape 要如实说 0 条（不是"没数据"）', () => {
    expect(summarizeIde(200, '{"ret":0,"jData":{"data":{"data":[]}}}').dataShape).toBe('数组（0 条）')
  })

  it('不是 JSON 也不抛异常', () => {
    const s = summarizeIde(500, '<html>502 Bad Gateway</html>')
    expect(s.ret).toBeNull()
    expect(s.sMsg).toContain('不是 JSON')
  })

  it('没有 jData 时不崩', () => {
    expect(summarizeIde(200, '{"ret":101}').dataShape).toBe('（没有）')
  })
})
