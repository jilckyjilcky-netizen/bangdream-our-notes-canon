#!/usr/bin/env node
/**
 * 角色表.mjs —— 25 名乐队角色 ＋ 附加角色 的路径映射（audit_models 的数据源）
 *
 * 原文件在 订单队列/角色表.mjs（云队列停运后目录未迁移，脚本也从未入 git），
 * 这里按同一规则从 素材全量/按角色/zh-Hans/ 五个乐队目录的文件名派生：
 *   - corpus: 素材全量/按角色/zh-Hans/{乐队}/{短名}_{全名}.md
 *   - model : 角色模型/{乐队目录}/{短名}_{全名}_角色扮演模型.md
 *   - fp    : 角色模型/指纹/{短名}_{全名}_语言指纹报告.md
 *   - sp    : 角色模型/系统提示词/{短名}_{全名}_系统提示词.md
 * 乐队名对照：素材目录用全名（Ave Mujica / 一家Dumb Rock），模型目录用拼接名（AveMujica / 一家DumbRock）。
 *
 * EXTRA_CHARS：不在五支乐队编制内、但已有完整《角色扮演模型》的在册角色（真奈）。
 *   语料落在 素材全量/按角色全量/zh-Hans/（按角色/ 里她在「配角」目录、没有独立文件），
 *   故这里显式给出 corpus 路径；其余路径规则与主角色完全一致。
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WS } from './_root.mjs';

const BAND_DIR = {
  'MyGO': 'MyGO',
  'Ave Mujica': 'AveMujica',
  '梦限大MewType': '梦限大MewType',
  'millsage': 'millsage',
  '一家Dumb Rock': '一家DumbRock',
};
const CODE = { 'MyGO': 'MyGO', 'Ave Mujica': 'AveM', '梦限大MewType': '梦限', 'millsage': 'mill', '一家Dumb Rock': 'Dumb' };

const CHARS = [];
for (const [band, dir] of Object.entries(BAND_DIR)) {
  for (const f of readdirSync(join(WS, '素材全量', '按角色', 'zh-Hans', band))) {
    if (!f.endsWith('.md')) continue;
    const [k, full] = f.replace(/\.md$/, '').split('_');
    CHARS.push({ k, full, g: CODE[band], band, dir });
  }
}

/* 附加角色（非乐队编制；真奈 = sumimi 主唱）。corpus 用「按角色全量」版式。 */
const EXTRA_CHARS = [
  { k: '真奈', full: '纯田真奈', g: 'Sumi', band: 'Sumimi', dir: 'Sumimi', corpus: '素材全量/按角色全量/zh-Hans/真奈_纯田真奈.md' },
];

const corpusOf = c => join(WS, '素材全量', '按角色', 'zh-Hans', c.band, `${c.k}_${c.full}.md`);
const modelOf = c => join(WS, '角色模型', c.dir, `${c.k}_${c.full}_角色扮演模型.md`);
const fpOf = c => join(WS, '角色模型', '指纹', `${c.k}_${c.full}_语言指纹报告.md`);
const spOf = c => join(WS, '角色模型', '系统提示词', `${c.k}_${c.full}_系统提示词.md`);

export { WS, CHARS, EXTRA_CHARS, corpusOf, modelOf, fpOf, spOf };
