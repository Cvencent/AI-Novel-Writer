p = r'src/services/workflows/__tests__/qa-repair-evidence.probe.test.ts'
lines = open(p, encoding='utf-8').read().split('\n')
BS = chr(92)
out = []
i = 0
while i < len(lines):
    line = lines[i]
    stripped = line.strip()
    # 残片 1：把 + 换行（注释被拆断的续行）
    if stripped == '把':
        i += 1
        continue
    # 残片 2：孤行 "'))"
    if stripped == "'))":
        i += 1
        continue
    # 残片 3：孤行 expect(repaired... 且以 replace(/ 结尾或含跨行残迹——重建整行
    if 'expect(repaired.replace' in line:
        out.append("    expect(repaired.replace(/" + BS + "n/gu, '" + BS + "n')).toBe(candidate.replace(/" + BS + "r" + BS + "n/gu, '" + BS + "n'))")
        i += 1
        # 跳过后续残片（空、')、/gu 等）
        while i < len(lines) and lines[i].strip() in ("'))", "')", "/gu, '", "'")") or lines[i].strip().startswith('/gu'):
            i += 1
        continue
    out.append(line)
    i += 1
open(p, 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
print('final repair done')
