# Copyright 2026 AeroPACT Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Tests for the world generator: determinism, consistency of the generated artefacts."""

import importlib.util
import os
import xml.etree.ElementTree as ET

import pytest
import yaml

HERE = os.path.dirname(__file__)
GEN = os.environ.get('GENERATOR', os.path.join(HERE, '..', 'scripts', 'generate_world.py'))
MAPS = os.environ.get('MAPS_DIR', os.path.join(os.path.dirname(__file__), '..', 'maps'))


def load_generator():
    spec = importlib.util.spec_from_file_location('generate_world', GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def scenario(tmp_path):
    path = tmp_path / 'scenario.yaml'
    path.write_text(yaml.safe_dump({'name': 'unit', 'map': 'test_field',
                                    'fleet': {'n_drones': 4}}))
    return str(path)


@pytest.mark.parametrize('map_name', ['metro_district', 'compact_town', 'test_field'])
def test_every_map_generates_valid_artefacts(tmp_path, map_name):
    gen = load_generator()
    path = tmp_path / 's.yaml'
    path.write_text(yaml.safe_dump({'name': 's', 'map': map_name, 'fleet': {'n_drones': 4}}))
    info = gen.generate(str(path), MAPS, str(tmp_path / 'out'))
    out = tmp_path / 'out'
    world = yaml.safe_load((out / 'world.yaml').read_text())['world']
    assert world['depots'] and world['drop_points'] and world['buildings']
    root = ET.parse(out / 'world.sdf').getroot()
    names = [m.get('name') for m in root.iter('model')]
    for drone in info['fleet']['drones']:
        assert drone['id'] in names
    bridge = yaml.safe_load((out / 'bridge.yaml').read_text())
    assert any(e['ros_topic_name'] == '/clock' for e in bridge)
    assert sum(1 for e in bridge if e['ros_topic_name'].endswith('/odom')) == 4


def test_generation_is_deterministic(tmp_path, scenario):
    gen = load_generator()
    gen.generate(scenario, MAPS, str(tmp_path / 'a'))
    gen.generate(scenario, MAPS, str(tmp_path / 'b'))
    for f in ('world.yaml', 'world.sdf', 'bridge.yaml', 'fleet.yaml'):
        assert (tmp_path / 'a' / f).read_text() == (tmp_path / 'b' / f).read_text(), f


def test_drop_points_are_clear_of_buildings_and_zones(tmp_path):
    gen = load_generator()
    path = tmp_path / 's.yaml'
    path.write_text(yaml.safe_dump({'name': 's', 'map': 'metro_district'}))
    gen.generate(str(path), MAPS, str(tmp_path / 'out'))
    world = yaml.safe_load((tmp_path / 'out' / 'world.yaml').read_text())['world']
    for dp in world['drop_points']:
        x, y, _ = dp['position']
        for b in world['buildings']:
            xs = [p[0] for p in b['footprint']]
            ys = [p[1] for p in b['footprint']]
            assert not (min(xs) - 5 < x < max(xs) + 5 and min(ys) - 5 < y < max(ys) + 5), \
                (dp['id'], b['id'])
        for z in world['no_fly']:
            assert not gen.point_in_polygon(x, y, z['polygon']), (dp['id'], z['id'])


def test_fleet_larger_than_pads_is_rejected(tmp_path):
    gen = load_generator()
    path = tmp_path / 's.yaml'
    path.write_text(yaml.safe_dump({'name': 's', 'map': 'compact_town', 'fleet': {'n_drones': 9}}))
    with pytest.raises(ValueError):
        gen.generate(str(path), MAPS, str(tmp_path / 'out'))


def test_kinematic_backend_spawns_on_the_ground(tmp_path, scenario):
    gen = load_generator()
    info = gen.generate(scenario, MAPS, str(tmp_path / 'out'), backend='kinematic')
    assert all(d['spawn'][2] == 0.0 for d in info['fleet']['drones'])
