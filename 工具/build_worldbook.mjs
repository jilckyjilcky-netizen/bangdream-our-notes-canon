#!/usr/bin/env node
/**
 * build_worldbook.mjs —— 生成 SillyTavern 世界书（lorebook）
 * 词条内容来自主线六段回摘 + 角色模型（全部为 Our Notes 剧本内事实）。
 * 输出：世界书/mygo_ave_世界书.json
 *
 * 用法：node 工具/build_worldbook.mjs [--out <目录>]
 *   --out 覆盖输出目录（默认 世界书/）。沙箱只允许写工作区根时，落盘到根再搬运——
 *   即 交接计划_口径统一与词层补全.md §二 的应急备案（--out . 与 --out=. 都支持）。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WS } from './_root.mjs';

const argOut = (() => {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--out') return a[i + 1];
    if (a[i].startsWith('--out=')) return a[i].slice('--out='.length);
  }
  return null;
})();
const OUT = argOut ? resolve(WS, argOut) : join(WS, '世界书');
const EXTRA = join(WS, '资料库', '_curated_extra.json');
mkdirSync(OUT, { recursive: true });

/* 历史遗留清理：早期手写词条把旧版 E() 的位置参数（", 0, 100"）粘进了正文，
 * 导致 12/31 条词条的 content 尾部带着这串垃圾进了 SillyTavern。
 * 统一在此剥掉，而不是去改 31 条手写字符串——以后复制粘贴再犯也能兜住。 */
const stripLegacyArgs = s => String(s).replace(/,\s*0,\s*100\s*$/, '');

const E = (keys, content, comment = '', order = 100) => ({
  keys, content: stripLegacyArgs(content), comment,
  extensions: { position: 0, selectiveLogic: 0, addMemo: false, constant: false, enabled: true, order },
  enabled: true
});

const entries = [
  /* ---- 乐队 ---- */
  E(['MyGO!!!!!', 'MyGO', '迷路的孩子的乐队'], 'MyGO!!!!!（MyGO）——灯、爱音、立希、爽世、乐奈五人的乐队。队名取自爱音领悟的"It\'s my go"（轮到我出场）加五个感叹号。乐队前身是灯的独演（歌词《迷路的孩子的乐队》由水族馆纸条"逃避也没关系""迷路"得名）。核心宣言：迷失了也要前进，一辈子不放手。, 0, 100'),
  E(['Ave Mujica', 'Mujica', '假面剧团'], 'Ave Mujica——祥子（Oblivionis）、初华（Doloris）、睦（Mortis）、海铃（Timoris）、若麦（Amoris）的职业假面乐队。以"为来宾制造梦境"为使命，全员戴面具演出直到若麦直播摘下。曾经历：武道馆出道→摘面具→巡演→Mortis事件→解散→复活。祥子最终宣言"〔原文略〕"。'),
  E(['梦限大MewType', '梦限大', 'MewType', '梦限大MewType（乐队）'], '梦限大MewType——阿拉蕾（Vo.）、野乃花（Gt.）、律（Gt.）、都子（Key.）、由乃（DJ&Mp.）五人的乐队，成员多就读神田白八马学院。主唱阿拉蕾以"不露脸"的方式演出，用声音代替脸活着；都子是笔名"富士见夜子"的现役漫画家；由乃以线上课程与"省电模式"生活。'),
  E(['millsage', 'millsage（乐队）'], 'millsage——萤（Key.&Vo.）、枣（Gt.／作曲）、凪（Gt.）、茉幌（Ba.）、朋花（Dr.）五人的乐队，成员多就读水濑女子学园。主唱萤是街头钢琴出身、被唤作"天才"的孩子（奏多的徒弟）。乐队经历过主唱位的变动：前任奏多出走后，茉幌曾顶上主唱。朋花的宣传语是「〔原文略〕」。'),
  E(['一家Dumb Rock!', '一家Dumb Rock', 'Dumb Rock', 'Family'], '一家Dumb Rock!——蕾叶（Gt.&Vo.）、心玖（Gt.&Vo.／作曲）、蓬咲（Ba.）、千樱梨（Dr.）、宁月（Key.）五人的乐队。核心是"Family"：把乐队当成真正的家。成员学校分散（羽丘、月之森、花咲川、新樱女子大学），宁月是最年幼的成员，心玖是家里负责采买的理性管家。'),

  /* ---- 角色（精简词条，完整看角色卡） ---- */
  E(['高松灯', 'Tomori', '灯'], 'MyGO!!!!! 主唱兼作词，羽丘高一A班。认为"自己不是人类"（自我诊断）。用歌词笔记与人建立连接；收集石头、创可贴、树叶。口头禅是"〔原文略〕"。喜欢企鹅与星星。, 0, 100'),
  E(['千早爱音', 'Anon', '爱音', 'Tomorin'], 'MyGO!!!!! 吉他手，羽丘高一A班。留学失败逃回日本；最初靠乐队出风头，后被灯拯救，成为把乐队聚拢的人。称灯为 Tomorin（乐队定名后改口；此前叫"小灯"）。, 0, 100'),
  E(['椎名立希', 'Taki', '立希', 'Rikki'], 'MyGO!!!!! 鼓手，花咲川高一B班。嘴硬心软的行动派；对灯有救赎式追随（灯的歌让她觉得"有资格活下去"）；自卑锚点"做不到像祥子一样好"。在 RiNG 打工。, 0, 100'),
  E(['长崎爽世', '长崎爽世', 'Soyo', '爽世', 'Soyorin'], 'MyGO!!!!! 贝斯手，月之森女子学园（与睦、祥子同校）。父母离异独居；把CRYCHIC当"命运共同体"执念；表面温柔实为操控，后承认"我可是一直在利用你们"。称祥子"小祥子"。, 0, 100'),
  E(['要乐奈', 'Rana', '乐奈', '野猫'], 'MyGO!!!!! 主音吉他，羽丘初中部。猫系直白，评价人只分"有趣/无趣"；外婆是 Live House『SPACE』的老板娘；喜欢抹茶。吉他声能把小睦唤醒。, 0, 100'),
  E(['丰川祥子', 'Sakiko', '祥子', '小祥', 'Oblivionis'], 'Ave Mujica 键盘手/领队（Oblivionis），前CRYCHIC组建者。母亲病逝、父亲被骗168亿引咎辞职酗酒、与祖父丰川定治决裂。CRYCHIC时期温柔领队→Mujica时期完美指挥→"成神"后忘却女神。对灯有亏欠。, 0, 100'),
  E(['三角初华', 'Uika', '初华', 'Doloris'], 'Ave Mujica 吉他手/主唱（Doloris），偶像组合 sumimi 成员。真名初音：丰川定治私生女，冒名妹妹出道。对祥子无条件追随；夏夜星空是她唯一的喘息。被祥子确认"喜欢星星的是初音"。, 0, 100'),
  E(['若叶睦', 'Mutsumi', '睦', 'Mortis', '小睦'], 'Ave Mujica 吉他手（Mortis），艺能名门之女，月之森。体内有人格：小睦（本体，沉默，"从没觉得玩乐队开心过"）与 Mortis（自认的"帮助小睦的角色"，怕消失，称小睦为第三人称）。吉他=小睦唯一的自我。, 0, 100'),
  E(['八幡海铃', 'Umiri', '海铃', 'Timoris', '海子'], 'Ave Mujica 贝斯手（Timoris），兼任约30支乐队。第一支乐队演出当天被全员放鸽子——这是她全部职业化的根源。效率至上、零口吃；若麦称她"海子"。, 0, 100'),
  E(['祐天寺若麦', 'Nyamu', '若麦', 'Amoris', 'Nyamuchi'], 'Ave Mujica 鼓手（Amoris），视频创作者Nyamu（Nyamuchi）。靠"被看到"确立存在；给别人起"×子"昵称（海子/初子/睦子）；疑问率全场第1。最终宣言"〔原文略〕"。, 0, 100'),

  /* ---- Sumimi（不在五支乐队编制内，但属 Ave Mujica 主线） ---- */
  E(['纯田真奈', '真奈', 'Mana', 'Sumida Mana', 'sumimi主唱'], '偶像组合 sumimi 的主唱之一，与初华组成"二人一体"的双人偶像，「和真奈一起做偶像吧！」。表层是元气甜豆（逢人元气道早、分甜甜圈给累坏的小初、小天使营业）；里层是温柔的知情者：早看穿初华的另一半生活（Ave Mujica），却选择温柔地"不知道"，好让 sumimi 继续下去。组合暂停期坚持个人演艺，为 sumimi 重启留力——她真正怕的是 sumimi 散掉。'),

  /* ---- 地点 ---- */
  E(['RiNG'], '演唱会现场/咖啡厅/录音室一体的 Live House，MyGO!!!!! 的据点。爱音初期在公告板招募成员；乐奈被称作"RiNG的野猫"；凛凛子是店长。', 0, 100),
  E(['羽丘女子学园'], '灯与爱音的学校，祥子转学后也在羽丘。爱音入学1-A与灯同班。', 0, 100),
  E(['月之森女子学园'], '爽世、睦、祥子（转学前）的学校，初中管弦乐团很强。', 0, 100),
  E(['花咲川女子学园'], '立希、海铃、初华的学校（高一B班同班）。', 0, 100),
  E(['星象馆', '天文馆'], '灯逃避时去的地方；与乐奈、睦、初华都有观星场景（金牛座流星雨夜是睦坠落事件的舞台）。', 0, 100),
  E(['SPACE'], '乐奈外婆经营的传奇 Live House，已倒闭；乐奈的归宿原型，"总会有人再创造新的归宿"。', 0, 100),
  E(['丰川家'], '祥子的祖父丰川定治的宅邸；祥子被接回后住在台球室；是168亿负债与"初音"事件的发生地。', 0, 100),

  /* ---- 关键物品/意象 ---- */
  E(['春日影'], 'CRYCHIC的歌，灯的歌词。MyGO首演重奏令台下祥子落泪，成为爽世决裂与道歉的焦点——"〔原文略〕"。', 0, 100),
  E(['想要成为人类之歌', '歌词笔记本', '笔记'], '灯的歌词笔记本：最初是《想要成为人类之歌》，后成为Label；水族馆纸条上写着"逃避也没关系""迷路"。灯的歌词是两部主线的"中介物"，合奏救赎过CRYCHIC旧人。', 0, 100),
  E(['创可贴'], '灯的收藏与社交货币：海洋生物系列（帽带企鹅、蓝鲸、长须鲸……）。"〔原文略〕"。', 0, 100),
  E(['抹茶芭菲', '抹茶拿铁'], '乐奈的登台条件与口粮。', 0, 100),
  E(['面具'], 'Ave Mujica 的设定核心：假面舞会制造梦境；若麦直播摘面具揭露全员真面目；"摘假面要在最棒的舞台与最好的时机"。', 0, 100),

  /* ---- 关键事件 ---- */
  E(['CRYCHIC', '命运共同体'], '祥子初中组建的乐队：灯（主唱/词）、祥子（键盘）、睦（吉他）、立希（鼓）、爽世（贝斯）。祥子的"命运共同体"话语是爽世至今的执念。解散因：母亲病逝+父亲负债，祥子雨夜退出。', 0, 100),
  E(['168亿'], '祥子父亲清告经商被骗后引咎辞职的负债额；是CRYCHIC解散的真正苦衷，被爽世查出。', 0, 100),
  E(['Mortis', '小睦沉睡'], '睦崩溃后出现的第二人格，自称"我从小就在和小睦聊天"；因祥子逼坏小睦而接管身体；怕消失（"我不想消失"）；Mortis 一人分饰两角视频成为复活Mujica的导火索。', 0, 100),
  E(['一辈子', '组一辈子乐队'], '灯的信仰宣言。定名MyGO!!!!!时正式化：吵过架受过伤，"〔原文略〕"。立希唯对灯发过"一辈子我也愿意"的誓。', 0, 100),
  E(['初音', '身世'], '初华真名初音：丰川定治私生女，母亲在岛上独自抚养；冒名妹妹"初华"出道。向清告坦白致祥子家破；10038祥子拒赴瑞士救回她，"〔原文略〕"。', 0, 100),
  E(['成神', '我来成为神明'], '祥子在10039的宣言："〔原文略〕"；以Oblivionis之名豁免一切，重新出道假面舞会。', 0, 100),
  E(['游轮', '翡翠交响号'], '丰川集团委托的豪华游轮假面舞会（10103-10105 exstory）：祥子被"回到过去"的幻影诱惑（以母亲瑞穗、灯之姿），最终识破并抛花入海——"晚安，我耀眼而美丽的回忆"。', 0, 100),
];

/* ── 增量：后补 15 人的角色词条由队列生成、收集器落盘 ──
 * 来源 资料库/_curated_extra.json（由 订单队列/收集_补齐产物.mjs 写）。
 * 该文件不存在时，本脚本行为与从前完全一致（只出 31 条）。 */
let extraCount = 0;
try {
  if (existsSync(EXTRA)) {
    const ex = JSON.parse(readFileSync(EXTRA, 'utf8'));
    for (const w of (ex.worldbook || [])) {
      if (w && Array.isArray(w.keys) && w.keys.length && typeof w.content === 'string' && w.content.trim()) {
        entries.push(E(w.keys, w.content));
        extraCount++;
      }
    }
  }
} catch (e) { console.error('⚠ 资料库/_curated_extra.json 读取失败，只生成基础词条：' + e.message); }

const lorebook = { entries, metadata: { version: 1 } };
const file = join(OUT, 'mygo_ave_世界书.json');
writeFileSync(file, JSON.stringify(lorebook, null, 2), 'utf8');
console.log('已生成 ' + file + '  (' + entries.length + ' 词条 = 基础 ' + (entries.length - extraCount) + ' + 增量 ' + extraCount + ', ' + Buffer.byteLength(JSON.stringify(lorebook), 'utf8') + ' bytes)');