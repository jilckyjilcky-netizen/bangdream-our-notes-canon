import json, os, re
from collections import defaultdict

ROOT = 'D:/Project/bangdream-our-notes-canon'
MASTER = f'{ROOT}/masterdata/master'
DESIGN = f'{ROOT}/角色模型/设计思路'
os.makedirs(DESIGN, exist_ok=True)

def load(fn):
    d = json.load(open(f'{MASTER}/{fn}', encoding='utf-8'))
    return d['_allData'] if isinstance(d, dict) else d

# ---------- 文本/角色 ----------
mt = {x['_id']: x for x in load('MasterText.json')}
def zh(tid):
    r = mt.get(tid, {})
    return r.get('_simplifiedChinese') or r.get('_traditionalChinese') or r.get('_japanese') or ''

chars = load('MasterCharacter.json')
cid2name = {}
for c in chars:
    nid = c.get('_nameTextID')
    nm = zh(nid) if nid else ''
    # 形如 "Doloris / 三角初华" → 取后半作本体名
    if '/' in nm: nm = nm.split('/')[-1].strip()
    cid2name[c['_id']] = nm

# charId → Live2D model（项目规范映射，已稳定；待核对）
CID2MODEL = {
    1: 'tomori', 2: 'anon', 3: 'rana', 4: 'soyo', 5: 'taki',
    6: 'uika', 7: 'mutsumi', 8: 'umiri', 9: 'nyamu', 10: 'sakiko',
}
# alter ego（仅 ADV 有，MasterTalk 无文本）
ALTER = {
    'mortis': '若叶睦·Mortis', 'doloris': '三角初华·Doloris',
    'timoris': '八幡海铃·Timoris', 'amoris': '祐天寺若麦·Amoris',
    'oblivionis': '丰川祥子·Oblivionis',
}

# ---------- 更细的对话模式分类器 ----------
def mode_of(line):
    s = line.strip()
    if not s:
        return '空白'
    # 应和/附和：极短语气词
    if len(s) <= 2 and re.fullmatch(r'[ええうんんあおはぁぇえー〜…嗯诶哦啊哎噢唔额]+', s):
        return '应和'
    # 反问：难道/岂/不是…吗/怎么会/谁说/哪有 + 问号，或句尾 「じゃない/不是吗」
    if re.search(r'(难道|岂|怎么会|谁说|哪有|什么意思|你说谁)', s) or \
       (('吗' in s or '呢' in s) and re.search(r'(不是|没|难道)', s)) or \
       s.endswith('じゃない') or s.endswith('不是吗') or s.endswith('不是么'):
        return '反问'
    # 疑问
    if s[-1] in '？?':
        return '疑问'
    if s.endswith('吗') or s.endswith('呢') or s.endswith('呀') or \
       any(k in s for k in ['为什么', '怎么', '什么', '谁', '哪', '几', '是不是', '要不要', '对不对', '有没有', '多久', '哪儿']):
        return '疑问'
    # 感叹
    if s[-1] in '！!':
        return '感叹'
    if re.search(r'(太[^，。]*了|好[^，。]*啊|真[^，。]*呀|简直)', s):
        return '感叹'
    # 省略（拖尾）
    if s[-1] in '…~〜ー' or s.endswith('……') or '——' in s[-3:]:
        return '省略'
    # 祈使
    if s.endswith('吧') or s.startswith('请') or s.startswith('别') or s.startswith('不要') or s.startswith('不准') or s.startswith('快') or s.startswith('给我'):
        return '祈使'
    if re.search(r'(して|しろ|しなさい|行こう|いこう|やめろ|やめて)$', s):
        return '祈使'
    return '陈述'

MO = ['陈述', '疑问', '感叹', '省略', '祈使', '反问', '应和', '空白']

# ---------- MasterTalk 薄维度（有文本）----------
talk = load('MasterTalk.json')
thin = {}  # model → agg
for t in talk:
    cid = t.get('_characterId')
    model = CID2MODEL.get(cid)
    if not model:
        continue  # 仅合并 10 可玩角色；NPC 不进合并报告（见 _演出动作谱 原始）
    line = zh(t.get('_textId'))
    if not line:
        continue
    mo = t.get('_motionName') or '(无动作)'
    ex = t.get('_expressionName') or '(无表情)'
    m = mode_of(line)
    c = thin.setdefault(model, {
        'cn': cid2name.get(cid, model), 'total': 0,
        'mode_count': defaultdict(int),
        'mode_motion': defaultdict(lambda: defaultdict(int)),
        'motion_emo': defaultdict(lambda: defaultdict(int)),
        'emo_motion': defaultdict(lambda: defaultdict(int)),
    })
    c['total'] += 1
    c['mode_count'][m] += 1
    c['mode_motion'][m][mo] += 1
    c['motion_emo'][mo][ex] += 1
    c['emo_motion'][ex][mo] += 1

# ---------- ADV 厚维度（纯演出，_演出动作谱.json）----------
act = json.load(open(f'{DESIGN}/_演出动作谱.json', encoding='utf-8'))
byModel = act.get('byModel', {})

def top(d, n=6):
    return dict(sorted(d.items(), key=lambda x: -x[1])[:n])

# 由 expMotion 反推 motion→exp
def invert_exp_motion(exp_motion):
    m2e = defaultdict(lambda: defaultdict(int))
    for ex, ms in exp_motion.items():
        for m, n in ms.items():
            m2e[m][ex] += n
    return m2e

# ---------- 合并 ----------
out = {'_meta': {
    'source': '对话模式=MasterTalk.json (572行, 有文本) × 情绪→动作=_演出动作谱.json (ADV cmd=21, 31505行, 纯演出)',
    'x_axis': '对话模式（句式：陈述/疑问/感叹/省略/祈使/反问/应和）—— 原型启发式，非 canon 标注',
    'y_axis': 'Live2D 动作 (motionName)，动作上挂情绪标签 (expressionName)',
    'merge_note': '真正「合并分析」：X 轴(对话模式)来自有文本的 MasterTalk（薄，每角色~23条）；Y 轴(情绪→动作)来自 ADV 主线演出（厚，每角色上千行）。两维口径不同，分别标注样本量。',
    'adv_join_failed': 'ADV 脚本的 Episode(演出轨) 与 Text(台词轨) 无逐行关联键（_advTextID 全空、顺序不对齐），无法把上万句台词精确配对到动作，故对话模式维度只能取 MasterTalk。',
}, 'byModel': {}}

# 10 可玩角色：合并薄+厚
for model, c in thin.items():
    em = byModel.get(model, {})
    exp_motion = em.get('expMotion', {})
    m2e = invert_exp_motion(exp_motion)
    out['byModel'][model] = {
        'cn': c['cn'],
        '对话模式分布': dict(c['mode_count']),
        '对话模式x动作': {m: top(c['mode_motion'][m]) for m in MO if m in c['mode_motion']},
        '情绪到动作_厚': {ex: top(ms) for ex, ms in exp_motion.items()},
        '动作到情绪_厚': {mo: top(ex) for mo, ex in m2e.items()},
        '样本': {'对话模式': f"MasterTalk {c['total']}条(薄)", '情绪动作': f"ADV {em.get('total',0)}行(厚)"},
    }

# 5 alter ego：仅厚维度（MasterTalk 无文本）
for model, cn in ALTER.items():
    em = byModel.get(model, {})
    if not em:
        continue
    exp_motion = em.get('expMotion', {})
    m2e = invert_exp_motion(exp_motion)
    out['byModel'][model] = {
        'cn': cn,
        '对话模式分布': {},
        '对话模式x动作': {},
        '情绪到动作_厚': {ex: top(ms) for ex, ms in exp_motion.items()},
        '动作到情绪_厚': {mo: top(ex) for mo, ex in m2e.items()},
        '样本': {'对话模式': 'MasterTalk 无文本(空)', '情绪动作': f"ADV {em.get('total',0)}行(厚)"},
    }

json.dump(out, open(f'{DESIGN}/_对话模式动作谱.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('JSON 写出 | 合并角色数:', len(out['byModel']),
      '| 对话模式来源:', sum(c['total'] for c in thin.values()), '条')

# ---------- markdown ----------
L = []
L.append('# 对话模式 × 动作 合并分析（§2 说法层真源证据）')
L.append('')
L.append('> **这是把「台词」维度与「live2d 演出」维度真正合并的分析**，不是概率学统计。')
L.append('> - **X 轴 对话模式**（句式：陈述/疑问/感叹/省略/祈使/反问/应和）= 来自 `MasterTalk`（有文本，薄，每角色约 23 条，原型启发式分类**非 canon 标注**）')
L.append('> - **Y 轴 情绪→动作**（厚）= 来自 `_演出动作谱.json`（ADV 主线 `cmd=21`，每角色上千行，纯演出证据）')
L.append('> - 两维口径不同、样本量不同，分别标注，勿混为一谈。')
L.append('>')
L.append('> ⚠️ **ADV 逐行 join 失败说明**：缓存里 ADV 的 Episode(演出轨) 与 Text(台词轨) 无逐行关联键（`_advTextID` 全 2755 个 cmd=23 全空、顺序也不对齐），无法把上万句台词精确配对到具体动作。故「对话模式」维度只能取 MasterTalk；「情绪→动作」维度用 ADV 厚数据。')
L.append('> 本文件是**证据不是判断**：为什么在这种对话模式下做这个动作，须人工写进 §2 说法层因果链。')
L.append('')
L.append('## 角色总览（对话模式维度样本量）')
L.append('')
L.append('| 角色 | 对话模式样本 | 陈述/疑问/感叹/省略/祈使/反问/应和 |')
L.append('|---|---|---|')
for model, c in sorted(out['byModel'].items(), key=lambda x: -(x[1]['样本']['对话模式'].count('条') and x[1]['对话模式分布'] and sum(x[1]['对话模式分布'].values()) or 0)):
    mc = c['对话模式分布']
    if not mc:
        L.append(f"| {c['cn']} ({model}) | — | （MasterTalk 无文本，仅厚维度） |")
        continue
    dist = ' / '.join(f'{m}{mc.get(m,0)}' for m in ['陈述','疑问','感叹','省略','祈使','反问','应和'])
    L.append(f"| {c['cn']} ({model}) | {c['样本']['对话模式']} | {dist} |")
L.append('')

def short(s):
    # 仅去掉前缀，保留方向后缀（L/R/C），避免 smile01_L / smile01_R 折叠成同名造成重复计数假象
    return s.replace('mtn_', '').replace('exp_', '')

for model, c in out['byModel'].items():
    if not c['对话模式分布'] and not c['情绪到动作_厚']:
        continue
    L.append(f'## {c["cn"]}（{model}）')
    L.append('')
    L.append(f'- 样本：对话模式={c["样本"]["对话模式"]}；情绪→动作={c["样本"]["情绪动作"]}')
    L.append('')
    if c['对话模式分布']:
        L.append('**① 对话模式 × 动作**（文本维度，薄）')
        L.append('')
        for m in MO:
            if m not in c['对话模式x动作']:
                continue
            topm = sorted(c['对话模式x动作'][m].items(), key=lambda x:-x[1])[:6]
            s = '  '.join(f'{short(mo)}×{n}' for mo, n in topm)
            L.append(f'- {m}：{s}')
        L.append('')
    L.append('**② 情绪 → 动作**（演出维度，厚 · 来自 ADV 主线）')
    L.append('')
    for ex, ms in sorted(c['情绪到动作_厚'].items(), key=lambda x:-sum(x[1].values()))[:10]:
        topm = sorted(ms.items(), key=lambda x:-x[1])[:5]
        s = '  '.join(f'{short(mo)}×{n}' for mo, n in topm)
        L.append(f'- {short(ex)}：{s}')
    L.append('')

open(f'{DESIGN}/_对话模式动作谱.md','w',encoding='utf-8').write('\n'.join(L))
print('MD 写出')
