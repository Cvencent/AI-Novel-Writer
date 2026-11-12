p = r'src/services/workflows/__tests__/qa-repair-evidence.probe.test.ts'
lines = open(p, encoding='utf-8').read().split('\n')
BS = chr(92)
out = []
i = 0
while i < len(lines):
    line = lines[i]
    # 修 1：孤行 "')"
    if line.strip() == "')" :
        i += 1
        continue
    # 修 2：把
 转义与裸换行 等价化 注释被拆
    if line.strip() == "// 差异只有换行：把" and i + 1 < len(lines):
        out.append("    // 差异只有换行：把 " + BS + "n 转义与裸换行等价化之后，两份文本逐字相同")
        i += 1
        # 跳过被拆散的 expect(repaired...) 行直到遇到 toBe(...) 行
        while i < len(lines) and not lines[i].strip().startswith('expect('):
            i += 1
        # 这一行是 expect(repaired.replace(...) —— 重建整行
        if i < len(lines):
            out.append("    expect(repaired.replace(/" + BS + "n/gu, '" + BS + "n')).toBe(candidate.replace(/" + BS + "r" + BS + "n/gu, '" + BS + "n'))")
            i += 1
        continue
    out.append(line)
    i += 1
open(p, 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
print('repaired all')
