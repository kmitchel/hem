#!/usr/bin/env python3
"""Create HEM RRDs or rebuild them in a separate directory from offline sources."""
import argparse
from collections import Counter, defaultdict
import copy
import json
import math
import re
from pathlib import Path
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

STEP = 30
# Resolution seconds, retained rows. 1095 days is an elapsed-day policy.
TIERS = [(30, 5760), (60, 43200), (300, 25920), (900, 35040), (3600, 26280)]
# DS name, LevelDB collection, accepted bounds, extrema archives.
SERIES = {
    'w': ('power-W', 0, 100000, True),
    'in': (None, -4, 140, True),
    'out': ('temp-284a046d4c2001a3', -67, 257, True),
    'upper': ('temp-2809853f030000a7', -67, 257, True),
    'lower': ('temp-2813513f03000072', -67, 257, True),
    'achigh': ('temp-289fa756b5013c68', -67, 257, True),
    'aclow': ('temp-2874913c46200105', -67, 257, True),
    'dew': ('temp-room1-dewF', -148, 140, True),
    'rh': ('temp-room1-rh', 0, 100, True),
    'gpm': ('water-GPM', 0, 1000, False),
    'heat': ('hvac-heat', 0, 100, False),
    'cool': ('hvac-cool', 0, 100, False),
}
RESOLUTIONS = {'01': 60, '05': 300, '15': 900, '60': 3600}


def run(*args):
    return subprocess.check_output(['rrdtool', *map(str, args)], text=True)


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def old_archives(root):
    last = int(root.findtext('lastupdate'))
    base = int(root.findtext('step'))
    result = []
    for rra in root.findall('rra'):
        period = base * int(rra.findtext('pdp_per_row'))
        rows = rra.findall('database/row')
        end = last // period * period
        values = {end - (len(rows)-1-i)*period: float(row.findtext('v')) for i, row in enumerate(rows)}
        result.append((rra.findtext('cf').strip(), period, values))
    return result


def resample_old(archives, target, start, end, cf='AVERAGE'):
    """Use the finest available known archive; never expand a coarse bin into finer data.

    Coarser target grids need not divide old grids: duration-weighted overlap is
    an explicit approximation of the old interval means. Require >=50% coverage.
    """
    selected = {}
    for source_cf, period, values in sorted(archives, key=lambda a: a[1]):
        if source_cf != cf or period > target:
            continue
        sums, coverage = defaultdict(float), defaultdict(float)
        extrema = {}
        for t, value in values.items():
            if not finite(value) or t <= start or t-period >= end:
                continue
            first = (t-period)//target*target+target
            for out_end in range(first, t+target, target):
                if not start < out_end <= end:
                    continue
                overlap = min(t, out_end)-max(t-period, out_end-target)
                if overlap <= 0:
                    continue
                coverage[out_end] += overlap
                sums[out_end] += value*overlap
                if cf == 'MIN': extrema[out_end] = min(extrema.get(out_end, value), value)
                if cf == 'MAX': extrema[out_end] = max(extrema.get(out_end, value), value)
        for t, duration in coverage.items():
            if t not in selected and duration >= target/2:
                selected[t] = sums[t]/duration if cf == 'AVERAGE' else extrema[t]
    return selected


def load_leveldb(directory, collection, minimum, maximum, anchor, runtime=False):
    result = {(cf, period): {} for cf in ('AVERAGE', 'MIN', 'MAX') for period, _ in TIERS}
    stats = Counter()
    if not collection or not (directory / (collection+'.jsonl')).exists():
        return result, stats
    raw = defaultdict(list)
    with (directory / (collection+'.jsonl')).open() as source:
        for line in source:
            resolution, milliseconds, value = json.loads(line)
            if not finite(milliseconds):
                stats['rejected'] += 1
                continue
            if resolution == '00':
                # Bucket timestamps in the export are observation times, not bucket starts.
                if finite(value) and minimum <= value <= maximum:
                    t = int(milliseconds/1000)//STEP*STEP+STEP
                    if anchor-2*86400 < t <= anchor//STEP*STEP:
                        raw[t].append(value)
                else:
                    stats['rejected'] += 1
                continue
            period = RESOLUTIONS.get(resolution)
            if period is None:
                continue
            t = int(milliseconds/1000)+period  # LevelDB stores bucket starts; RRD stores ends.
            if t > anchor//period*period:
                continue  # Never import a currently incomplete LevelDB bucket as complete.
            if runtime:
                # Counter is minutes of runtime per bucket. No absent bucket becomes zero.
                if not finite(value):
                    stats['rejected'] += 1
                    continue
                mean = value*60/period*100
                if not minimum <= mean <= maximum:
                    stats['rejected'] += 1
                    continue
                result['AVERAGE', period][t] = mean
            elif (isinstance(value, list) and len(value) == 4 and
                  all(finite(v) for v in value) and value[0] > 0 and
                  value[0] == int(value[0]) and value[2] <= value[3]):
                mean = value[1]/value[0]
                if minimum <= mean <= maximum:
                    result['AVERAGE', period][t] = mean
                    if minimum <= value[2] <= value[3] <= maximum:
                        result['MIN', period][t] = value[2]
                        result['MAX', period][t] = value[3]
                else:
                    stats['rejected'] += 1
            else:
                stats['rejected'] += 1
    for t, values in raw.items():
        result['AVERAGE', STEP][t] = sum(values)/len(values)
        result['MIN', STEP][t] = min(values)
        result['MAX', STEP][t] = max(values)
    stats['raw_populated_bins'] = len(raw)
    return result, stats


def create(path, name, start):
    _, minimum, maximum, extrema = SERIES[name]
    args = ['create', path, '--start', start, '--step', STEP,
            f'DS:{name}:GAUGE:60:{minimum}:{maximum}']
    for cf in (('AVERAGE', 'MIN', 'MAX') if extrema else ('AVERAGE',)):
        for period, rows in TIERS:
            args.append(f'RRA:{cf}:0.5:{period//STEP}:{rows}')
    run(*args)


def set_preparation(root, source_root, archives, anchor, source_last):
    """Carry live PDP state, and seed unfinished CDPs from existing completed PDPs."""
    if anchor == source_last:
        root.remove(root.find('ds'))
        root.insert(3, copy.deepcopy(source_root.find('ds')))
        # Bounds belong to the new schema, not the old source.
        name = root.findtext('ds/name').strip()
        root.find('ds/min').text = str(SERIES[name][1])
        root.find('ds/max').text = str(SERIES[name][2])
    completed = next((v for cf,p,v in archives if cf == 'AVERAGE' and p == STEP), {})
    for rra in root.findall('rra'):
        cf = rra.findtext('cf').strip()
        period = STEP*int(rra.findtext('pdp_per_row'))
        partial_times = range(anchor//period*period+STEP, anchor//STEP*STEP+1, STEP)
        # Existing AVERAGE PDPs cannot establish historical MIN/MAX extrema.
        values = [completed.get(t, math.nan) if cf == 'AVERAGE' else math.nan for t in partial_times]
        known = [v for v in values if finite(v)]
        ds = rra.find('cdp_prep/ds')
        ds.find('unknown_datapoints').text = str(len(values)-len(known))
        ds.find('value').text = str(sum(known)) if known and cf == 'AVERAGE' else 'NaN'
        ds.find('primary_value').text = 'NaN'
        ds.find('secondary_value').text = 'NaN'


def rebuild(output, originals, exported, now):
    output.mkdir()  # Refuse an existing directory or overwriting any live RRD.
    summary = {'as_of': now, 'tiers': TIERS, 'files': {}}
    for name in SERIES:
        collection, minimum, maximum, extrema = SERIES[name]
        source_root = ET.fromstring(run('dump', originals/f'hem-{name}.rrd'))
        source_last = int(source_root.findtext('lastupdate'))
        # Fresh series carry their exact partially accumulated PDP. Stale series
        # advance to now with unknown preparation, so next updates cannot bridge outages.
        anchor = source_last if now-source_last <= 60 else now
        archives = old_archives(source_root)
        values, rejected = load_leveldb(exported, collection, minimum, maximum, anchor, name in ('heat','cool'))
        destination = output/f'hem-{name}.rrd'
        with tempfile.TemporaryDirectory(prefix='hem-rrd-template-') as temp:
            template = Path(temp)/'empty.rrd'
            create(template, name, anchor)
            root = ET.fromstring(run('dump', template))
            counts = []
            for rra in root.findall('rra'):
                cf = rra.findtext('cf').strip()
                period = STEP*int(rra.findtext('pdp_per_row'))
                rows = rra.findall('database/row')
                end = anchor//period*period
                start = end-len(rows)*period
                imported = values[cf, period]
                # Preserve known old RRD values ahead of LevelDB's differently weighted means.
                old = resample_old(archives, period, start, end, cf)
                known = from_old = from_level = 0
                for i,row in enumerate(rows):
                    t = start+(i+1)*period
                    value = old.get(t, imported.get(t, math.nan))
                    if finite(value) and minimum <= value <= maximum:
                        known += 1
                        if t in old: from_old += 1
                        else: from_level += 1
                        row.find('v').text = f'{value:.17g}'
                    else:
                        row.find('v').text = 'NaN'
                counts.append({'cf':cf, 'resolution':period, 'rows':len(rows), 'known':known,
                               'from_old_rrd':from_old, 'from_leveldb':from_level})
            set_preparation(root, source_root, archives, anchor, source_last)
            xml = Path(temp)/'rebuilt.xml'
            ET.ElementTree(root).write(xml, encoding='utf-8', xml_declaration=True)
            run('restore', xml, destination)
        summary['files'][name] = {'last_update':anchor, 'source_last_update':source_last,
                                  'archives':counts, 'import_stats':dict(rejected)}
        print(f'{destination.name}: {sum(a["known"] for a in counts)} populated archive rows', flush=True)
    (output/'rebuild-summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    return summary


def catch_up(target, original):
    """Replay completed old PDP averages and the final partial PDP after stopping HEM.

    This bridges the offline build without keeping collection stopped for XML
    reconstruction. It preserves averages; extrema of these replayed intervals
    describe 30-second averages rather than unavailable individual samples.
    """
    info = run('info', target)
    last = int(re.search(r'^last_update = (\d+)$', info, re.M)[1])
    source = ET.fromstring(run('dump', original))
    source_last = int(source.findtext('lastupdate'))
    if source_last <= last:
        return 0
    archives = old_archives(source)
    pdps = next(v for cf,p,v in archives if cf == 'AVERAGE' and p == STEP)
    first_end = last//STEP*STEP+STEP
    if first_end < min(pdps):
        raise ValueError('Offline build exceeded the original fine archive; rebuild from a newer snapshot')
    name = source.findtext('ds/name').strip()
    minimum, maximum = SERIES[name][1:3]
    updates = []
    partial = float(re.search(r'^ds\['+re.escape(name)+r'\]\.value = (.+)$', info, re.M)[1])
    unknown = int(re.search(r'^ds\['+re.escape(name)+r'\]\.unknown_sec = (\d+)$', info, re.M)[1])
    for t in range(first_end, source_last//STEP*STEP+1, STEP):
        value = pdps.get(t, math.nan)
        if t == first_end and last % STEP and finite(value) and finite(partial):
            # Source mean includes the part already accumulated in the candidate.
            value = (value*(STEP-unknown)-partial)/(t-last)
        updates.append(f'{t}:{value:.17g}' if finite(value) and minimum <= value <= maximum else f'{t}:U')
    if source_last % STEP:
        # Last partial PDP has not yet appeared in the source archive.
        duration = source_last % STEP-int(source.findtext('ds/unknown_sec'))
        value = float(source.findtext('ds/value'))/duration if duration > 0 else math.nan
        # If no completed PDP followed last, subtract candidate's partial sum.
        if source_last//STEP == last//STEP and finite(value) and finite(partial):
            value = (float(source.findtext('ds/value'))-partial)/(source_last-last)
        updates.append(f'{source_last}:{value:.17g}' if finite(value) and minimum <= value <= maximum else f'{source_last}:U')
    if updates:
        run('update', target, *updates)
    return len(updates)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='New directory; must not already exist')
    parser.add_argument('--originals', type=Path)
    parser.add_argument('--export', type=Path)
    parser.add_argument('--as-of', type=int, default=int(time.time()))
    parser.add_argument('--create-only', action='store_true')
    parser.add_argument('--catch-up', action='store_true', help='Replay latest original PDPs into an offline replacement directory')
    args = parser.parse_args()
    if args.catch_up:
        if not args.originals: parser.error('--originals is required')
        for name in SERIES:
            count = catch_up(args.output/f'hem-{name}.rrd', args.originals/f'hem-{name}.rrd')
            print(f'{name}: replayed {count} PDP updates')
    elif args.create_only:
        args.output.mkdir()
        for name in SERIES: create(args.output/f'hem-{name}.rrd', name, args.as_of)
    else:
        if not args.originals or not args.export: parser.error('--originals and --export are required')
        if args.as_of < max(int(ET.fromstring(run('dump', p)).findtext('lastupdate')) for p in args.originals.glob('hem-*.rrd')):
            parser.error('--as-of precedes a source update')
        rebuild(args.output, args.originals, args.export, args.as_of)


if __name__ == '__main__':
    main()
