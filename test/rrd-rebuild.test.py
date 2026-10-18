#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('rebuild', Path(__file__).resolve().parents[1]/'rrd-rebuild.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RebuildTests(unittest.TestCase):
    def test_resampling_never_invents_finer_data(self):
        archives = [('AVERAGE', 120, {120: 10., 240: 20., 360: 30.})]
        self.assertEqual(m.resample_old(archives, 60, 0, 360), {})
        self.assertEqual(m.resample_old(archives, 300, 0, 600), {300: 18.})

    def test_gaps_and_finest_source_precedence(self):
        archives = [('AVERAGE', 30, {30: 2., 60: 4., 90: float('nan'), 120: float('nan')}),
                    ('AVERAGE', 60, {60: 99., 120: 8.})]
        self.assertEqual(m.resample_old(archives, 60, 0, 120), {60: 3., 120: 8.})
        self.assertEqual(m.resample_old(archives, 30, 60, 120), {})
        self.assertEqual(m.resample_old(archives, 60, 0, 120, 'MIN'), {})

    def test_leveldb_bucket_ends_extrema_and_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p/'temp.jsonl').write_text('\n'.join(json.dumps(v) for v in [
                ['01', 0, [2, 20, 8, 12]], ['01', 60000, [1, 99, 99, 99]],
                ['01', 120000, [1, 50, 50, 50]], # Incomplete bucket at anchor=135.
                ['00', 90001, 10], ['00', 119999, 20],
                ['00', 120001, 30], # Incomplete raw bucket.
                ['00', 80000, None]
            ])+'\n')
            values, rejected = m.load_leveldb(p, 'temp', 0, 100, 135)
            self.assertEqual(values['AVERAGE',60], {60:10.,120:99.})
            self.assertEqual(values['MIN',60], {60:8,120:99})
            self.assertEqual(values['MAX',60], {60:12,120:99})
            self.assertEqual(values['AVERAGE',30], {120:15.})
            self.assertEqual(rejected['rejected'], 1)
            (p/'hvac.jsonl').write_text('\n'.join(json.dumps(v) for v in [
                ['01', 0, .25], ['01', 120000, 2], ['05', 0, 1.25]])+'\n')
            runtime, rejected = m.load_leveldb(p, 'hvac', 0, 100, 600, True)
            self.assertEqual(runtime['AVERAGE',60], {60:25.})
            self.assertEqual(runtime['AVERAGE',300], {300:25.})
            self.assertNotIn(120, runtime['AVERAGE',60]) # No zero-fill for absent buckets.
            self.assertEqual(rejected['rejected'], 1)

    def test_restored_partial_pdp_and_cdp_match_continuing_source(self):
        # The first consolidated result after cutover must include the already
        # accumulated PDPs and fractional current PDP exactly once.
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            base = 1700000000//3600*3600
            old, new, xml = p/'old.rrd', p/'new.rrd', p/'new.xml'
            m.run('create', old, '--start', base, '--step', 30, 'DS:w:GAUGE:60:0:100000',
                  'RRA:AVERAGE:0.5:1:100', 'RRA:AVERAGE:0.5:10:100')
            for t,v in [(30,10),(60,20),(90,30),(120,40),(135,50)]:
                m.run('update', old, f'{base+t}:{v}')
            source = ET.fromstring(m.run('dump', old))
            m.run('create', new, '--start', base+135, '--step', 30, 'DS:w:GAUGE:60:0:100000',
                  'RRA:AVERAGE:0.5:1:100', 'RRA:AVERAGE:0.5:10:100')
            target = ET.fromstring(m.run('dump', new))
            new.unlink()
            m.set_preparation(target, source, m.old_archives(source), base+135, base+135)
            ET.ElementTree(target).write(xml, encoding='utf-8', xml_declaration=True)
            m.run('restore', xml, new)
            for t in range(150, 601, 30):
                for f in [old,new]: m.run('update', f, f'{base+t}:{t/10}')
            expected = m.run('fetch',old,'AVERAGE','--resolution',300,'--start',base,'--end',base+600)
            actual = m.run('fetch',new,'AVERAGE','--resolution',300,'--start',base,'--end',base+600)
            self.assertEqual(actual, expected)

    def test_catch_up_preserves_partial_pdp_and_averages(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            base = 1700000000//3600*3600
            old, candidate = p/'old.rrd', p/'candidate.rrd'
            m.run('create',old,'--start',base,'--step',30,'DS:w:GAUGE:60:0:100000',
                  'RRA:AVERAGE:0.5:1:100','RRA:AVERAGE:0.5:10:100')
            for t in [30,60,90,120,135]: m.run('update',old,f'{base+t}:{t}')
            candidate.write_bytes(old.read_bytes())
            for t in [150,180,210,240,270,300,330,360,390,420,450,480,510,540,570,600,615]:
                m.run('update',old,f'{base+t}:{t}')
            self.assertGreater(m.catch_up(candidate,old),0)
            for t in [630,660,690,720,750,780,810,840,870,900]:
                for f in [old,candidate]: m.run('update',f,f'{base+t}:{t}')
            for period in [30,300]:
                expected=m.run('fetch',old,'AVERAGE','--resolution',period,'--start',base,'--end',base+900)
                actual=m.run('fetch',candidate,'AVERAGE','--resolution',period,'--start',base,'--end',base+900)
                self.assertEqual(actual,expected)


if __name__ == '__main__':
    unittest.main()
