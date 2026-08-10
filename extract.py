import re
h = open('prototype.html').read()
m = re.search(r'<script>(.*?)</script>', h, re.S)
open('proto.check.js', 'w').write(m.group(1))
print('extracted', len(m.group(1)), 'chars')
