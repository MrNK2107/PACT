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
"""Site configuration loading and validation for the deployment launch files."""

import os

import yaml

POLICY_DEFAULTS = {
    'allocation': 'pact', 'partition': 'QUORUM', 'bundle_len': 3, 'auction_period_s': 2.0,
    'gossip_period_s': 1.0, 'lease_ttl_s': 20.0, 'renew_period_s': 5.0, 't_commit_s': 3.0,
    'max_optimistic_claims': 2, 'use_shard_leases': True, 'use_charging_penalty': True,
    'use_indirect_probing': True,
}
MESH_DEFAULTS = {
    'mode': 'multicast', 'multicast_group': '239.255.70.1', 'port': 47000,
    'interface_address': '0.0.0.0', 'multicast_ttl': 2, 'multicast_loopback': False, 'peers': [],
    # auth: hmac (fleet_key) or ed25519 (this computer's private key + the site roster), D-30
    'auth': 'hmac', 'private_key_file': '', 'public_keys_file': '',
}
FLEET_DEFAULTS = {'capacity_kg': 2.0, 'cruise_speed_mps': 9.0, 'battery_wh': 60.0}


class SiteConfigError(RuntimeError):
    pass


def load_site(path, world_override=''):
    """Load, default and validate a site file. Raises SiteConfigError with a clear message."""
    if not os.path.isfile(path):
        raise SiteConfigError('site file not found: %s' % path)
    with open(path, encoding='utf-8') as f:
        doc = yaml.safe_load(f) or {}
    site = doc.get('site') or {}
    mesh = dict(MESH_DEFAULTS, **(doc.get('mesh') or {}))
    if mesh['auth'] not in ('hmac', 'ed25519'):
        raise SiteConfigError('mesh.auth must be hmac or ed25519')
    required = ['world_file', 'fleet_roster', 'depot_ids']
    required += ['fleet_key'] if mesh['auth'] == 'hmac' else []
    for key in required:
        if not site.get(key):
            raise SiteConfigError('site.%s is required' % key)
    if world_override:
        site['world_file'] = world_override
    files = [('site.world_file', site['world_file'])]
    if mesh['auth'] == 'hmac':
        files.append(('site.fleet_key', site['fleet_key']))
    else:
        # The private key is per computer (mesh.private_key_file, or a vehicles.<id> / depots.<id>
        # private_key_file override); it is checked when the node's parameters are built.
        files.append(('mesh.public_keys_file', mesh['public_keys_file']))
    for what, file in files:
        if not file or not os.path.isfile(file):
            raise SiteConfigError('%s does not exist: %r' % (what, file))
    with open(site['world_file'], encoding='utf-8') as f:
        world = (yaml.safe_load(f) or {}).get('world') or {}
    if 'geodetic_origin' not in world:
        raise SiteConfigError('the planning map has no geodetic_origin (surveyed WGS84 origin)')
    pads = {p['id']: p['position'] for d in world.get('depots', []) for p in d.get('pads', [])}
    vehicles = doc.get('vehicles') or {}
    for vid in site['fleet_roster']:
        v = vehicles.get(vid)
        if v is None:
            raise SiteConfigError('vehicle %s is in the roster but not under vehicles:' % vid)
        if v.get('home_pad') not in pads:
            raise SiteConfigError('vehicle %s: home_pad %r is not a pad on the map'
                                  % (vid, v.get('home_pad')))
    known_depots = {d['id'] for d in world.get('depots', [])}
    for did in site['depot_ids']:
        if did not in known_depots:
            raise SiteConfigError('depot %s is not on the map' % did)
    policy = dict(POLICY_DEFAULTS, **(doc.get('policy') or {}))
    fleet = dict(FLEET_DEFAULTS, **(doc.get('fleet') or {}))
    return {'site': site, 'world': world, 'pads': pads, 'vehicles': vehicles,
            'depots': doc.get('depots') or {}, 'policy': policy, 'mesh': mesh, 'fleet': fleet}


def mesh_parameters(cfg, node_id):
    m = cfg['mesh']
    own = (cfg['vehicles'].get(node_id) or cfg['depots'].get(node_id) or {})
    private_key = own.get('private_key_file') or m['private_key_file']
    if m['auth'] == 'ed25519' and not os.path.isfile(private_key or ''):
        raise SiteConfigError('%s: private key file does not exist: %r' % (node_id, private_key))
    return {'node_id': node_id, 'auth': m['auth'], 'key_file': cfg['site'].get('fleet_key', ''),
            'private_key_file': private_key,
            'public_keys_file': m['public_keys_file'], 'mode': m['mode'],
            'multicast_group': m['multicast_group'], 'port': int(m['port']),
            'interface_address': m['interface_address'],
            'multicast_ttl': int(m['multicast_ttl']),
            'multicast_loopback': bool(m['multicast_loopback']),
            'peers': [str(p) for p in m['peers']] or ['']}
