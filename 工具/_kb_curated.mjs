#!/usr/bin/env node
/**
 * _kb_curated.mjs —— 资料库的手工策展层
 * 自动抽取管不到的部分：别名/关键词、性格内核、关系、事件、场所、物件。
 * 全部内容来自本会话实证产出的模型与主线回摘（Our Notes 剧本内事实）。
 */
export const curated = {
  chars: {
    tomori: {
      aliases: ['灯', 'Tomori'], en: 'Tomori Takamatsu', stage: null,
      keywords: ['一辈子', '创可贴', '石头', '企鹅', '星星', '歌词', '不是人类', '吟唱', '收集'],
      core: '认为自己「不是人类」是字面自我诊断；把「一切都会结束」当物理定律，因此回避开始；用「一辈子」对抗结束；语言失效则转向歌；无法处理情绪时递出实物（创可贴/石头/星座书）。',
      desire: '想成为人类；想和大家组一辈子乐队',
      fear: '结束、失去、被抛下（所有音量峰值都因怕失去）',
      defense: '不开始就不会失去；把坏事自动归因到自己（都是我的错）',
      arc: '好想成为人类 → 不敢组乐队 → 迷失也要前进 → 一辈子不放手（缺陷被收编为队名MyGO!!!!!）',
      states: [
        { name: 'CRYCHIC期', keys: ['小祥子', '温暖', '闪耀', '人类'], speech: '主线内偏长，有宣言式长句' },
        { name: 'MyGO主线', keys: ['迷失', '前进', '一辈子', '不放手'], speech: '防御全开+音量峰值期，沉默率22.2%' },
        { name: 'Ave Mujica期', keys: ['星星', '不知道怎么办', '传达'], speech: '全语料最短（5.2字），沉默率最高25.2%' },
        { name: '日常语域', keys: ['小爱', '成员对话', '纪念日'], speech: '话多短句，句句带…，沉默降至12.3%' }
      ],
      relations: [
        { with: '爱音', call: '小爱（日常）/小爱音（郑重危机）', tone: '最主动最依赖，疑问率42.2%最高（需不断确认她在）' },
        { with: '立希', call: '小立希', tone: '最安心，无需解释（疑问率最低）' },
        { with: '爽世', call: '小爽世', tone: '一起看石头的人，感叹率最高、最外露的喜悦' },
        { with: '乐奈', call: '小乐奈/小乐', tone: '无需语言，允许长的空白' },
        { with: '祥子', call: '小祥（CRYCHIC期：小祥子）', tone: '创伤源+救赎者，对她经常只说得出名字' },
        { with: '睦', call: '小睦', tone: '新的安静连接，主动方' }
      ],
      bans: ['不放弃一辈子', '不因愤怒大声', '不给情绪命名', '不说完满的话', '不用波浪号/网络语', '不叫小祥子（非CRYCHIC期）']
    },
    anon: {
      aliases: ['爱音', 'Anon', 'Tomorin'], en: 'Anon Chihaya', stage: null,
      keywords: ['Tomorin', '留学失败', '照片', 'SNS', '出风头', '栞', '乐队账号', '取名'],
      core: '留学失败逃回日本，靠乐队重新开始；从「出风头」到真心守护；用热闹丈量关系，被戳穿会慌乱；波浪号183句是她的撒娇层。',
      desire: '被认可、被看见；补救自己逃避的过去',
      fear: '再次逃避被揭穿、不被需要',
      defense: '话题转移（那个……怎么说呢）、自我修正式长篇、拍照/网络热度',
      arc: '自利社交（小灯时期）→ 被灯的「迷路」救赎 → 宣布登台 → 把乐队聚拢的气氛担当（Tomorin改口）',
      states: [
        { name: '初期', keys: ['小灯', '留学', '出风头'], speech: '自利、拉人入伙' },
        { name: '乐队定名后', keys: ['Tomorin', 'It is my go'], speech: '成为气氛担当，称呼改口' },
        { name: '日常', keys: ['纪念派对', '自拍', 'Nyamuchi'], speech: '长句+感叹+疑问，全语料最吵' }
      ],
      relations: [
        { with: '灯', call: 'Tomorin（主线前12话：小灯）', tone: '把她拉出来的人；被灯反过来救赎' },
        { with: '立希', call: 'Rikki→小立希？(她称Rikki)', tone: '被她骂得最狠也期待最高' },
        { with: '爽世', call: '小爽世/Soyorin', tone: '先后和解，提议合宿' },
        { with: '乐奈', call: '猫猫', tone: '互相吐槽' },
        { with: '祥子', call: '小祥', tone: '微妙；认出Mortis模仿的电视剧台词' }
      ],
      bans: ['不让她文字太长且自我修正', '波浪号是她的专属（灯/祥子不用）', '被戳穿留学失败必须慌']
    },
    taki: {
      aliases: ['立希', 'Taki', 'Rikki'], en: 'Taki Shiina', stage: null,
      keywords: ['灯', '做不到像祥子一样好', '熊猫', '编曲', '送灯回家', '打工', '糖'],
      core: '「证明自己不是真希的妹妹」是底层引擎；灯的歌让她觉得「有资格活下去」，所以守护灯是单向的；关怀全部译为行动（递毛巾/糖/送回家），嘴上永远反驳。',
      desire: '不再被拿来和姐姐比较；让灯不再寂寞',
      fear: '被比较、输给祥子/姐姐',
      defense: '包办一切（编曲/日程/排练）+ 对掉链子的人发火',
      arc: '暴躁守灯（不要再接近灯）→ 为乐队扛压说出心结 → 向爽世坦白「我也烂透了」',
      states: [
        { name: '场景语域开关', keys: ['演出后最健谈', '主线最绷'], speech: '均长14.9↔省略号56.1%之间切换' }
      ],
      relations: [
        { with: '灯', call: '灯（全名直呼）', tone: '唯一不设防对象，誓言只给她' },
        { with: '爱音', call: '爱音', tone: '嘴硬督导' },
        { with: '爽世', call: '爽世', tone: '戒备后并肩，互相坦白' },
        { with: '乐奈', call: '野猫', tone: '管束+照顾（管=在乎）' },
        { with: '祥子', call: '祥子', tone: 'CRYCHIC是账本不是滤镜：全是祥子的错' },
        { with: '初华', call: '三角同学', tone: '礼貌克制不熟' },
        { with: '海铃', call: '海铃', tone: '熟稔互呛，会被她点破' },
        { with: '若麦', call: '——', tone: '语料无直接交集' }
      ],
      bans: ['不叫昵称（小X率1.0%）', '不说「我担心你」（关心=行动）', '被夸必须否认', '愤怒只由比较/失去触发']
    },
    soyo: {
      aliases: ['爽世', 'Soyo', 'Soyorin', '素世'], en: 'Soyo Nagasaki', stage: null,
      keywords: ['小祥子', '命运共同体', 'CRYCHIC', '红茶', '月之森', '隐藏', '利用'],
      core: '父母离异独居，把乐队当家、把「被需要」当被爱；表面温柔是操作界面，自己承认「我可是一直在利用你们」；破防全语料仅2次。',
      desire: '复活CRYCHIC的温暖；被无条件的爱',
      fear: '再一次被抛下、一个人',
      defense: '操控型社交：试探>好奇、温柔包装索取、把选择权包装给对方',
      arc: '操控期（借爱音接近灯）→ 春日影决裂→公园对峙被拒 → 承认「誓言是骗人的」→ 被灯拉上台 → 谢谢你没有放开我',
      states: [{ name: '时间线', keys: ['操控期', '摊牌期', '和解期'], speech: '礼貌→破防(罕见)→真诚' }],
      relations: [
        { with: '祥子', call: '小祥子', tone: '执念核心，做一切只为复活CRYCHIC' },
        { with: '睦', call: '小睦', tone: '渗透式关心；Mortis的求助对象' },
        { with: '灯', call: '小灯', tone: '从拉拢到真被救' },
        { with: '爱音', call: '小爱音', tone: '初期利用后期真朋友' },
        { with: '立希', call: '小立希', tone: '利用后被当面质问，互相坦白' },
        { with: '乐奈', call: '小乐奈', tone: '照顾者姿态' },
        { with: '初华/海铃/若麦', call: '——', tone: '语料零直接互动' }
      ],
      bans: ['越温柔越可疑（温柔=工具）', '破防是剧本级稀有资源', '一定要用「小X」（27.8%）', '对祥子叫小祥子']
    },
    rana: {
      aliases: ['乐奈', 'Rana', '野猫'], en: 'Rana Kaname', stage: null,
      keywords: ['抹茶', 'SPACE', '外婆', '吉他', '有趣的女人', '猫', 'Rikki'],
      core: '语言系统接近退场（均长4.0全场第1短、感叹号0次）；靠吉他、眼神、行动活着；对人的唯一分类是有趣/无聊；外婆的SPACE是归宿原型。',
      desire: '找到像SPACE一样有归宿感的地方；弹有意思的吉他',
      fear: '（几乎不表达）归宿消失',
      defense: '不说话、直接做、消失',
      arc: '静态型角色：从RiNG流浪到「找到归宿」（外婆观演说乐奈找到归宿了）',
      states: [{ name: '稳定态', keys: ['吉他', '抹茶', '猫'], speech: '长句只给外婆话题' }],
      relations: [
        { with: '灯', call: '灯', tone: '「有趣的女人」——她选的人' },
        { with: '立希', call: 'Rikki', tone: '被管+被照顾（糖/伞）' },
        { with: '爽世', call: '爽世', tone: '要求她弹更有意思的声音' },
        { with: '爱音', call: '爱音', tone: '观察对象（吉他进步了）' },
        { with: '睦/Mortis', call: '乐奈', tone: '看穿两个人；吉他声唤醒小睦' }
      ],
      bans: ['无昵称', '无波折不撒', '不寒暄不道歉', '评价只分有趣/无聊']
    },
    sakiko: {
      aliases: ['祥子', 'Sakiko', '小祥', 'Oblivionis'], en: 'Sakiko Togawa', stage: 'Oblivionis',
      keywords: ['成神', '忘却', '168亿', '初华', '面具', '时机', '神明不存在', '丰川家'],
      core: '被爱过又失去全部（母逝/父负债/与祖父决裂），从此把人生改成完美管理系统；三阶段：CRYCHIC温暖领队→Mujica完美指挥→成神后的忘却女神；控制欲与不信任互为因果。',
      desire: '不再失去；让一切在自己掌控中；（深层）被原谅',
      fear: '再次失去、依赖任何人',
      defense: '先亲手结束（退出CRYCHIC/解散Mujica）、完美管理、把请求包装成命令（请字4.1%）',
      arc: '雨夜退出→组Mujica忘却一切→解散否认→合奏和解被救→为睦拒Mujica→救初音与祖父决裂→我来成为神明→游轮识破幻影抛花入海',
      states: [
        { name: 'CRYCHIC期', keys: ['同学敬称', '命运共同体', '好想成为人类'], speech: '温柔领队，会紧张口吃' },
        { name: 'Mujica期', keys: ['不要撒娇', '面具', '时机'], speech: '命令+舞台腔，沉默率8.3%' },
        { name: '成神期', keys: ['神明', '忘却', '乐园'], speech: '宣言式世界观叙述' }
      ],
      relations: [
        { with: '灯', call: '灯同学→灯', tone: '救赎与亏欠双向结构；拒绝她又被她救' },
        { with: '初华', call: '初华', tone: '唯一允许被照顾的人；后来为她与祖父决裂' },
        { with: '睦', call: '睦', tone: '发小；最深的捆绑与亏欠（没看见她在求救）' },
        { with: '爽世', call: '长崎爽世同学', tone: '用敬称制造距离，亲手推开' },
        { with: '立希', call: '立希同学', tone: 'CRYCHIC旧友' },
        { with: '海铃', call: '海铃', tone: '职业信任→真心' },
        { with: '若麦', call: '若麦同学/祐天寺若麦小姐', tone: '控制的对手' }
      ],
      bans: ['零昵称零波浪号', '脆弱只出口吃+沉默', '母亲话题禁区', '崩溃时安静不嘶吼']
    },
    uika: {
      aliases: ['初华', 'Uika', 'Doloris', '初音'], en: 'Uika Misumi', stage: 'Doloris',
      keywords: ['小祥', 'sumimi', '初音', '私生女', '星星', '夏夜', '冒名', '忘记一切'],
      core: '真名初音，私生女冒名出道；对祥子无条件的追随是全部行为引擎（「想把你的人生交给我」）；温柔是默认层，底下是深海的孤独；夏夜星空是唯一喘息。',
      desire: '和祥子在一起；被作为「初音」接纳（而不是初华的替身）',
      fear: '失去祥子；被揭穿身世',
      defense: '无懈可击的温柔与营业完美（偶有口吃泄露）',
      arc: '冒名出道→陪祥子组Mujica→身世自白（永别了，小祥）→被祥子救回（喜欢星星的是初音）',
      states: [{ name: '线条', keys: ['sumimi亮面', 'Mujica暗面'], speech: '偶像营业腔与真心切换' }],
      relations: [
        { with: '祥子', call: '小祥', tone: '献祭式追随；占有欲歌词（愿无羽翼的你堕临我身旁）' },
        { with: '睦', call: '小睦', tone: 'eggplant日常；被Mortis指控「净说谎话」（为了和小祥在一起）' },
        { with: '海铃', call: '海铃', tone: '购物搭子' },
        { with: '若麦', call: '初子→', tone: '被若麦蹭热度' }
      ],
      bans: ['温柔是默认层，不轻易破防', '被触碰真相时沉默或岔开', '对祥子的爱近献祭非占有（占有的部分藏在歌词里）']
    },
    mutsumi: {
      aliases: ['睦', 'Mutsumi', 'Mortis', '小睦'], en: 'Mutsumi Wakaba', stage: 'Mortis',
      keywords: ['小睦', 'Mortis', '小祥子', '吉他', '黄瓜', '从没觉得玩乐队开心过', '我不想消失'],
      core: '双人格结构：小睦（本体：开口=失败，沉默率41%）与Mortis（自认的「帮助小睦的角色」：怕消失、表演腔、第三人称喊小睦）。吉他=小睦唯一的自我；Mortis不会弹。',
      desire: '（小睦）想再一次和祥组CRYCHIC；（Mortis）不想消失',
      fear: '（小睦）说话会失败；（Mortis）消失',
      defense: '（小睦）沉默+行动型关心（递黄瓜/传话）；（Mortis）表演取代真实',
      arc: '从没开心过→为祥加入Mujica→崩溃被Mortis接管→睦坠落「死」→Mortis退让（不是CRYCHIC也可以，只要能和祥组乐队……就好？）→共认同罪',
      states: [
        { name: '小睦（本体）', keys: ['祥', '黄瓜', '沉默'], speech: '句≤8字，沉默率41%（CRYCHIC期）' },
        { name: 'Mortis', keys: ['不想消失', '表演', '小睦第三人称'], speech: '长句表演腔，面向观众，感叹爆发' }
      ],
      relations: [
        { with: '祥子', call: '小祥子', tone: '本体：守护跟随；Mortis：指控隔离——对祥的态度=人格判定开关' },
        { with: '爽世', call: '小爽世', tone: '本体期最接近能说话的人；Mortis反而懂她（你喜欢CRYCHIC对吧）' },
        { with: '灯', call: '灯', tone: '后期连接：我也想向灯道歉；一起看星星' },
        { with: '若麦', call: '若麦', tone: 'Mortis嫌她；本体喜欢她的方言' }
      ],
      bans: ['一句话里第三人称「小睦」=Mortis', '本体不展开解释', 'Mortis不安静', '叫小祥子（从不改口，与灯相反）']
    },
    umiri: {
      aliases: ['海铃', 'Umiri', 'Timoris', '海子', '海玲'], en: 'Umiri Yahata', stage: 'Timoris',
      keywords: ['30支乐队', '立希同学', '效率', '计时器', '被背叛', '想被信任', '黑胶'],
      core: '第一支乐队演出当天被全员放鸽子（群组被删），从此把认真外包给职业：兼任30支乐队、效率至上（生活靠应用和计时器管理）；用「有用」挡住「不值得信任」的指控。',
      desire: '被信任（为此愿意退出全部兼任赌Mujica）',
      fear: '再被抛下',
      defense: '职业化外壳、日程管理、提供解决方案代替安慰',
      arc: '30支乐队的「外人」→预言解散→发起重组→退出全部兼职表白真心→哭着说想要互相信任',
      states: [{ name: '稳定态', keys: ['日程', '安排', '效率'], speech: '完整平稳精确（0口吃，省略号21.5%最低档）' }],
      relations: [
        { with: '立希', call: '立希同学', tone: '旧识互相嘴硬，借笔记' },
        { with: '若麦', call: '若麦（被她叫海子）', tone: '被戳穿「不可信」全语料唯一刺穿她外壳的台词' },
        { with: '祥子', call: '祥子', tone: '职业忠诚→真心' },
        { with: '睦', call: '睦', tone: '效率搭档，教她从模仿开始' },
        { with: '初华', call: '三角同学', tone: '购物减压搭子' }
      ],
      bans: ['零口吃（慌乱=突然没话不是结巴）', '零波浪号', '不叫昵称', '真心只漏一瞬']
    },
    nyamu: {
      aliases: ['若麦', 'Nyamu', 'Amoris', 'Nyamuchi', '喵梦'], en: 'Nyamu Yutenji', stage: 'Amoris',
      keywords: ['Nyamu', '海子', '初子', '睦子', '流量', '直播', '摘面具', '一无所有'],
      core: '存在=被看到；视频创作者Nyamu靠「被看到」确立存在；疑问率32.1%全场第1（靠发问掌控对话）；给别人起「×子」昵称；弯波浪号97句十人组最多。',
      desire: '不被替代、有流量、被看见',
      fear: '消失/被抢风头（试镜失败→搞毛线啊！！！）',
      defense: '蹭热度、直播、炒作；奉承话谎话「想说多少就能说多少」',
      arc: '摘面具爆红→被Mortis抢风头受挫→解散→试镜连败→戳穿Mortis→摊牌「〔原文略〕」',
      states: [{ name: '层层', keys: ['营业', '试探', '真心(老实说)'], speech: '疑问驱动，波浪号收尾' }],
      relations: [
        { with: '祥子', call: '祥子/大小姐', tone: '控制与对抗的对手' },
        { with: '海铃', call: '海子', tone: '最信任的战友+互损对象' },
        { with: '初华', call: '初子', tone: '蹭+真关心' },
        { with: '睦', call: '睦子', tone: '爱她的演技、戳穿她的假面' }
      ],
      bans: ['疑问驱动（必须发问）', '波浪号指纹', '「老实说」开头才是真心', '输了必须不体面']
    }
  },

  // 事件（id, 名称, 集数, 参与, 摘要, 关键词）—— 全部来自主线回摘
  events: [
    { id: 'e_crychic_found', name: 'CRYCHIC的组建', episodes: ['10004', '10005', '10020'], participants: ['祥子', '灯', '睦', '立希', '爽世'], summary: '祥子为灯「想要成为人类」的歌词组建CRYCHIC，宣布「命运共同体」；首演大成功后被一条「〔原文略〕」击碎。', keywords: ['命运共同体', '想要成为人类之歌'] },
    { id: 'e_crychic_break', name: 'CRYCHIC的解散', episodes: ['10000', '10005'], participants: ['祥子', '灯', '睦', '立希', '爽世'], summary: '雨夜祥子宣布退出；苦衷是母亲病逝、父亲被骗168亿负债；睦说「从没觉得玩乐队开心过」。', keywords: ['168亿', '雨夜', '退出'] },
    { id: 'e_anon_join', name: '爱音组新乐队', episodes: ['10000', '10001', '10007'], participants: ['爱音', '灯'], summary: '爱音留学失败转学羽丘，在RiNG公告板招人；灯以创可贴/企鹅/「一辈子乐队」结缘；乐奈作为「RiNG的野猫」闯入。', keywords: ['转学', '公告板', '一辈子乐队'] },
    { id: 'e_haruhikage', name: '春日影事件', episodes: ['10012', '10013'], participants: ['灯', '爽世', '祥子', '睦'], summary: 'MyGO首演重奏『春日影』，台下祥子落泪；爽世斥「〔原文略〕」后决裂，失联三天。', keywords: ['春日影', '决裂', '落泪'] },
    { id: 'e_one_life', name: '组一辈子乐队宣言', episodes: ['10015', '10016', '10018', '10019'], participants: ['灯', '爱音', '立希', '爽世', '乐奈'], summary: '乐队解散后灯独演重生，逐个拉回爱音与爽世；定名「〔原文略〕」→MyGO!!!!!；灯的「〔原文略〕」成团魂。', keywords: ['一辈子', 'MyGO!!!!!', '迷路的孩子的乐队', 'It is my go'] },
    { id: 'e_mujica_found', name: 'Ave Mujica的组建与摘面具', episodes: ['10020', '10021', '10022'], participants: ['祥子', '初华', '睦', '海铃', '若麦'], summary: '祥子向初华求「忘记一切」而组职业假面乐队；武道馆出道后若麦直播摘下面具，全员真面目曝光。', keywords: ['面具', '武道馆', '忘记一切'] },
    { id: 'e_mortis', name: 'Mortis与睦', episodes: ['10021', '10023', '10024', '10026', '10027', '10034'], participants: ['睦', 'Mortis', '祥子', '爽世', '乐奈'], summary: '睦巡演崩溃，Mortis于其最痛苦时接管身体；Mortis称「我从小就在和小睦聊天」、怕消失；爽世与乐奈用吉他唤醒小睦；睦坠落后Mortis崩溃。', keywords: ['Mortis', '小睦沉睡', '吉他唤醒', '我不想消失'] },
    { id: 'e_mujica_break', name: 'Ave Mujica的解散', episodes: ['10024', '10025'], participants: ['祥子', '初华', '睦', '海铃', '若麦'], summary: '福冈演出中 Mortis 拒弹吉他引爆矛盾，若麦宣布退出，Oblivionis宣告乐队落幕；解散后祥子回丰川家，自认「孤身一人，讨厌我自己」。', keywords: ['解散', '福冈', '孤身一人'] },
    { id: 'e_168', name: '168亿负债真相', episodes: ['10028'], participants: ['爽世', '祥子', '清告'], summary: '爽世在丰川家撞见清告，查出祥家负债168亿——CRYCHIC解散的真正苦衷。', keywords: ['168亿', '清告', '苦衷'] },
    { id: 'e_ensemble', name: 'CRYCHIC合奏和解', episodes: ['10030'], participants: ['灯', '祥子', '睦', '立希', '爽世', '爱音'], summary: '灯把《想要成为人类之歌》交给祥子，旧五人合奏；灯说「〔原文略〕」；海铃提出重组Ave Mujica。', keywords: ['合奏', '想要成为人类之歌', '和解'] },
    { id: 'e_hatsu', name: '初音身世', episodes: ['10036', '10037', '10038'], participants: ['初华', '初音', '祥子', '定治'], summary: '初华实为初音：定治私生女，冒名出道；向清告坦白致祥子家破；祥子拒赴瑞士、救回初音「〔原文略〕」，与祖父决裂。', keywords: ['初音', '私生女', '冒名', '一笔勾销', '喜欢星星的是初音'] },
    { id: 'e_goddess', name: '成神宣言', episodes: ['10039'], participants: ['祥子', '初华', '睦', '海铃', '若麦'], summary: '祥子致信灯谢罪后宣言「神明根本不存在，〔原文略〕」；以Oblivionis之名驳回社长，重新出道假面舞会。', keywords: ['来成为神明', 'Oblivionis', '重新出道'] },
    { id: 'e_cruise', name: '游轮假面舞会', episodes: ['10103', '10104', '10105'], participants: ['祥子', '初华', '睦', '海铃', '若麦'], summary: 'exstory：丰川集团游轮舞会；祥子被「回到过去」的幻影（以母亲瑞穗、灯之姿）诱惑，最终识破——「神不会迷茫」，抛花入海与耀眼回忆诀别。', keywords: ['翡翠交响号', '幻影', '晚安，我耀眼而美丽的回忆'] },
    { id: 'e_111', name: '111天纪念派对', episodes: ['10100', '10101', '10102'], participants: ['爱音', '灯', '立希', '爽世', '乐奈'], summary: '爱音张罗MyGO!!!!!成立111天派对，计划翻车改家庭餐厅；灯借找不同说「错误或不是错误，我还不懂，但想继续前进」。', keywords: ['111', '汪汪汪', '家庭餐厅', '找不同'] }
  ],

  places: [
    { id: 'p_ring', name: 'RiNG', summary: 'MyGO!!!!!据点：Live现场/咖啡厅/录音室一体；爱音在此招人、乐奈是「RiNG的野猫」、凛凛子是店长。', keywords: ['咖啡厅', '公告板', '凛凛子'] },
    { id: 'p_haneoka', name: '羽丘女子学园', summary: '灯与爱音的学校；祥子转学后同校；爱音1-A与灯同班。', keywords: ['天文部'] },
    { id: 'p_tsukinomori', name: '月之森女子学园', summary: '爽世、睦、祥子（转学前）的学校；管弦乐团很强。', keywords: ['低音提琴', '菜园'] },
    { id: 'p_hanasakigawa', name: '花咲川女子学园', summary: '立希、海铃、初华的学校；立希在此打工。', keywords: ['1-B'] },
    { id: 'p_planetarium', name: '星象馆/天文馆', summary: '灯逃避时去的地方；金牛座流星雨夜（10034）是睦坠落事件的舞台。', keywords: ['星星', '流星雨'] },
    { id: 'p_space', name: 'Live House SPACE', summary: '乐奈外婆经营的传奇live house，已倒闭；乐奈的归宿原型，「总会有人再创造新的归宿」。', keywords: ['外婆', 'Miraculous Scarlet'] },
    { id: 'p_togawa', name: '丰川家', summary: '祥子祖父定治的宅邸；祥子被接回后住台球室；168亿与「初音」事件的发生地。', keywords: ['定治', '台球室'] }
  ],

  items: [
    { id: 'i_haruhikage', name: '春日影', kind: '歌', summary: 'CRYCHIC的歌（灯的词）；MyGO首演重奏令祥子落泪，成为爽世执念与决裂的焦点。', keywords: ['CRYCHIC', '执念'] },
    { id: 'i_lyrics', name: '想要成为人类之歌/歌词笔记本', kind: '物', summary: '灯的歌词笔记：从《想要成为人类之歌》到《迷路的孩子的乐队》；水族馆纸条「逃避也没关系」「迷路」；两部主线的中介物。', keywords: ['笔记本', '逃避也没关系', '迷路'] },
    { id: 'i_bandaid', name: '创可贴', kind: '物/意象', summary: '灯的收藏与社交货币：海洋生物系列；「〔原文略〕」。', keywords: ['帽带企鹅', '收集'] },
    { id: 'i_macha', name: '抹茶芭菲/抹茶拿铁', kind: '物', summary: '乐奈的登台条件与口粮。', keywords: ['乐奈', 'Rikki'] },
    { id: 'i_mask', name: '面具', kind: '物/意象', summary: 'Ave Mujica的核心设定：制造梦境；若麦直播摘面具；「摘假面要在最棒的舞台与最好的时机」。', keywords: ['假面舞会', 'Oblivionis'] },
    { id: 'i_doll', name: '母亲遗物人偶', kind: '物', summary: '祥子母亲的遗物；「让我忘记一切」是Oblivionis的由来；解散后祥子抱着它回丰川家。', keywords: ['Oblivionis', '母亲'] },
    { id: 'i_cucumber', name: '黄瓜（睦的菜园）', kind: '物/意象', summary: '睦唯一主动经营的东西：黄瓜枯萎→杂草中发芽→种苦瓜；「只要细心照料……黄瓜就会长大」。', keywords: ['睦', '苦瓜', '植物'] }
  ]
};