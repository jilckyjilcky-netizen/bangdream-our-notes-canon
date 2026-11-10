#!/usr/bin/env node
/**
 * _跑负向测.mjs —— check_chapter.mjs 判据的负向测
 *
 * **为什么需要它**：`check_chapter.mjs` 判 ❌ 的依据是「说话指纹偏离原作」。
 * 如果这个判据写反了，它会对**照抄原作**的章报一堆偏离——
 * 报告读起来「很严格」，实际是废的（与 `check_design_links.mjs` 文件头那条
 * 「闸门必须负向测过，否则断言是废的」同源）。
 *
 * 所以这里**不校验任何一章写得好不好**，只校验判据本身。
 *
 * ⚠️ **不能靠 spawn 的 stdout**（本沙箱管道模式静默失败，stdout=undefined，
 *   MEMORY「环境边界」记着这条）。解法：**让被测脚本把结果写文件**——
 *   `check_chapter.mjs --json` 的结果用 `--md` 落不成 json，所以这里
 *   改用 `--out-json <路径>`（见被测脚本支持）。**读文件，不读管道。**
 *
 * 期望值写死成**具体数字**，不是「>0」。因为「比 0 多」无法区分
 * 「判据正确」与「判据过敏（什么都报）」—— 实测第一版就把照抄样本
 * 报出 ❌，正是这类过敏。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, '..');
const CHECK = join(TOOLS, 'check_chapter.mjs');
/**
 * ⚠️ 临时 json **必须落在工作区外**（`工具/_selftest/` 里）。
 * 实测踩过：最初写在样本旁边，自检中途被打断就**留下残file**，
 * 于是 `工具/` 目录凭空多 1 个文件 → 规模数字台账变红，
 * 表现为「我什么都没改它却红了」。运行态产物不许进工作区。
 */
const TMPDIR = join(tmpdir(), 'bgchapter');

/** 期望：❌ 级偏离数 / OOC 项数。null = 该项不作判据。 */
const CASES = [
  { file: '_测试章_01.md', 期望偏离: 0, 期望OOC: null, 理由: '混合样本，各角色 n 太小 → 该判「样本不足」而非硬判失败' },
  { file: '_测试章_02_OOC.md', 期望偏离: 3, 期望OOC: null, 理由: '灯写飘：省略号率 86.3→0、≤6字 57.4→0、均长 6.9→17.8' },
  { file: '_测试章_03_照抄.md', 期望偏离: 0, 期望OOC: 0, 理由: '照抄原作 30 句 → 必须 0偏离。**这条是防误报的核心**' },
  { file: '_测试章_04_OOC禁令.md', 期望偏离: null, 期望OOC: 2, 理由: '插了波浪号（7 次）+ 非 CRYCHIC 期叫「小祥子」（1 次）' },
  // 世界观：校名封闭集合。⚠️ 期望 3 而非 4 —— 「神田白八马学院」是**真实校名**，
  //   负向测当场抓到过把它误报成「不在册」的假阳性（正则贪婪吃进了前面的「去」字）。
  //   **假阳性比漏报更坏**：正确写法被判错，作者会去改本来对的地方。
  { file: '_测试章_05_世界观.md', 期望偏离: null, 期望OOC: null, 期望世界观: 3,
    理由: '照抄原作 20 句 + 注入「羽丘学园」「月之森学园」（错）、「神田白八马学院」（**对，不能报**）、`[待补充]`' },
];

const rows = [];
let fails = 0;
mkdirSync(TMPDIR, { recursive: true });

// ⚠️ 无论正常跑完还是中途失败，都要把临时目录清掉 ——
//   残file 落在工作区里会让规模数字台账无端变红（实测踩过）。
try {
  for (const c of CASES) {
    const src = join(HERE, c.file);
    const outJson = join(TMPDIR, `_out_${c.file}.json`);
    if (existsSync(outJson)) unlinkSync(outJson);

    const r = spawnSync(process.execPath, [CHECK, src, '--out-json', outJson],
      { stdio: ['ignore', 'ignore', 'inherit'] });

    if (!existsSync(outJson)) {
      rows.push({ ...c, 实际偏离: null, 实际OOC: null, 通过: false, 原因: '被测脚本没产出 json' });
      fails++;
      continue;
    }
    const d = JSON.parse(readFileSync(outJson, 'utf8'));
    unlinkSync(outJson);

    const 实际偏离 = d.失败项;
    const 实际OOC = d.OOC风险.length;
    // 世界观：只数 ❌ 级（「引号内人名不在册」是 ⚠️ 提示，不算）
    const 实际世界观 = (d.世界观一致性 || []).filter((w) => w.等级 === '❌').length;
    const ok偏离 = c.期望偏离 === null || 实际偏离 === c.期望偏离;
    const okOOC = c.期望OOC === null || 实际OOC === c.期望OOC;
    const ok世界观 = c.期望世界观 === undefined || 实际世界观 === c.期望世界观;
    // 退出码必须与「是否有 ❌」一致，否则 CLI 契约就是坏的
    const okCode = (r.status === 0) === (实际偏离 === 0 && 实际OOC === 0 && 实际世界观 === 0);
    const 通过 = ok偏离 && okOOC && ok世界观 && okCode;

    rows.push({
      ...c, 实际偏离, 实际OOC, 实际世界观, 退出码: r.status, 通过,
      原因: !通过 ? [!ok偏离 && '偏离数不符', !okOOC && 'OOC 数不符', !ok世界观 && `世界观数不符(期望 ${c.期望世界观} 实得 ${实际世界观})`, !okCode && '退出码与判定不一致'].filter(Boolean).join('；') : '',
    });
    if (!通过) fails++;
  }
} finally {
  rmSync(TMPDIR, { recursive: true, force: true });   // 残 file 绝不能留在工作区
}

console.log('\ncheck_chapter.mjs 负向测（验判据本身，不是验某章写得好不好）\n');
const W = (s, w) => String(s).padEnd(w);
console.log(W('案例', 24) + W('偏离', 6) + W('期望', 6) + W('OOC', 5) + W('期望', 5) + W('世界观', 7) + W('期望', 6) + W('退出码', 8) + '结论');
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(W(r.file, 24) + W(r.实际偏离, 6) + W(r.期望偏离, 6) + W(r.实际OOC, 5) + W(r.期望OOC, 5)
    + W(r.实际世界观, 7) + W(r.期望世界观 === undefined ? '-' : r.期望世界观, 6)
    + W(r.退出码, 8) + (r.通过 ? '✓' : `✗ ${r.原因}`));
}
console.log('-'.repeat(96));
console.log(fails ? `\n✗ ${fails}/${rows.length} 项不符 —— 判据漂了，先修 check_chapter.mjs` : `\n✓ ${rows.length}/${rows.length} 项符合 —— 判据可用`);
console.log('\n其中「照抄原作必须 0 偏离」是**防误报**的唯一证据，比会报错重要。');
process.exit(fails ? 1 : 0);