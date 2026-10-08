"""Turns the output of a test run into annotations, which survive when the log of a job does not."""
import os
import re

path = os.path.join(os.environ['RUNNER_TEMP'], 'vitest-out.txt')
text = open(path, encoding='utf-8', errors='replace').read()
text = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', text)
lines = text.splitlines()
keys = [
    line
    for line in lines
    if re.search(r'FAIL|AssertionError|Error:|threshold|Coverage for|Unhandled|Test Files|Tests  |exit=', line)
]


def escape(value: str) -> str:
    return value.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')


print('::error title=vitest key lines::' + escape('\n'.join(keys[:40])[:30000]))
print('::error title=vitest tail::' + escape('\n'.join(lines[-60:])[:30000]))
