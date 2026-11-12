p = r'electron/migrations/m09-review-findings-anchoring.ts'
s = open(p, encoding='utf-8').read()
old = (" CHECK((status IN ('unverified','author-waived') AND span_start IS NULL AND span_end IS NULL AND span_unit IS NULL\n"
       "    AND excerpt_hash IS NULL AND occurrence IS NULL)\n"
       "   OR (status<>'unverified' AND span_start IS NOT NULL AND span_end IS NOT NULL\n"
       "    AND span_unit='utf16-code-unit' AND excerpt_hash IS NOT NULL AND occurrence IS NOT NULL)),\n")
new = (" CHECK(status='author-waived'\n"
       "   OR (status='unverified' AND span_start IS NULL AND span_end IS NULL AND span_unit IS NULL\n"
       "    AND excerpt_hash IS NULL AND occurrence IS NULL)\n"
       "   OR (status IN ('unresolved','unknown','resolved') AND span_start IS NOT NULL AND span_end IS NOT NULL\n"
       "    AND span_unit='utf16-code-unit' AND excerpt_hash IS NOT NULL AND occurrence IS NOT NULL)),\n")
assert old in s, 'old CHECK not found'
s = s.replace(old, new)
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('author-waived unrestricted')
