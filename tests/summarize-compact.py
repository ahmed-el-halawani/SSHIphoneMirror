"""Summarize an opt-in run; tiktoken is a local analysis tool, not an app dependency."""
import json
import math
import pathlib
import statistics

import tiktoken

root = pathlib.Path(__file__).parents[1]
report = json.loads((root / '.research/compact-report.json').read_text(encoding='utf-8'))
corpus = json.loads((root / '.research/compact-token-corpus.json').read_text(encoding='utf-8'))
catalog = json.loads((root / '.research/compact-tool-catalog.json').read_text(encoding='utf-8'))
encoding = tiktoken.get_encoding('cl100k_base')


def tokens(text):
    return len(encoding.encode(text, disallowed_special=()))


def response_text(entry):
    return '\n'.join(block['text'] for block in json.loads(entry['json'])['content'] if block['type'] == 'text')


assert report['complete'] and report['checks'] and len(report['benchmark']) == 4, 'A complete paired benchmark is required'
assert all(s['ok'] or s.get('expectedError') for s in report['samples']), 'Unexpected failure in completed run'
assert len(report['samples']) == len(corpus)
summary = dict(date=report['date'], deviceId=report['deviceId'], fixture=report['bundleId'], sourceSha256=report['sourceSha256'], checks=report['checks'], tokenizer='cl100k_base', tokenScope='MCP text content and JSON tool arguments; excludes model reasoning, transport framing and client-specific schema conversion', groups=[])
summary['validationRuns'] = report.get('validationRuns', {'combinedRecordedAt': report['date']})
for group in report['benchmark']:
    entries = corpus[group['corpusStart']:group['corpusEnd']]
    samples = report['samples'][group['corpusStart']:group['corpusEnd']]
    assert len(entries) == group['calls']
    if group['mode'] == 'baseline':
        cycles = [samples[i]['wallMs'] + samples[i + 1]['wallMs'] for i in range(0, len(samples), 2)]
    else:
        cycles = [s['wallMs'] for s in samples if s['action'] == 'act']
    assert len(cycles) == group['rounds']
    summary['groups'].append({**group, 'responseTextTokens': sum(tokens(response_text(e)) for e in entries), 'requestJsonTokens': sum(tokens(e['request']) for e in entries), 'medianCycleMs': statistics.median(cycles), 'p95CycleMs': sorted(cycles)[math.ceil(.95 * len(cycles)) - 1]})
for mode in ('baseline', 'compact'):
    groups = [g for g in summary['groups'] if g['mode'] == mode]
    summary[mode] = {key: sum(g[key] for g in groups) for key in ('rounds', 'wallMs', 'calls', 'responseBytes', 'responseTextTokens', 'requestJsonTokens')}
    summary[mode]['meanCycleMsIncludingInitialSnapshot'] = round(summary[mode]['wallMs'] / summary[mode]['rounds'], 1)
summary['reductionsPercent'] = {key: round(100 * (1 - summary['compact'][key] / summary['baseline'][key]), 1) for key in ('wallMs', 'calls', 'responseBytes', 'responseTextTokens', 'requestJsonTokens')}
new_tools = [tool for tool in catalog['tools'] if tool['name'] in ('ios_snapshot', 'ios_act')]
assert len(new_tools) == 2
summary['newToolSchemaJsonTokens'] = tokens(json.dumps(new_tools, ensure_ascii=False, separators=(',', ':')))
summary['successfulCompactActions'] = sum(s['action'] == 'act' and s['ok'] for s in report['samples'])
summary['expectedRefusals'] = [s['expectedError'] for s in report['samples'] if s.get('expectedError')]
output = root / 'docs/compact-benchmark-2026-11-09.json'
output.write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
print(json.dumps({key: value for key, value in summary.items() if key != 'groups'}, indent=2))
