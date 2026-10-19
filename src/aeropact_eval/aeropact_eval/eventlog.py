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
"""Reading and writing the structured event log (events.jsonl, NFR-4)."""

import json
from typing import Any, Dict, Iterable, List


def load(path: str) -> List[Dict[str, Any]]:
    """Load events sorted by simulation time (stable for equal times)."""
    events = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    events.sort(key=lambda e: e.get('t', 0.0))
    return events


def dump_line(t: float, agent: str, etype: str, data: Any) -> str:
    return json.dumps({'t': round(t, 3), 'agent': agent, 'type': etype, 'data': data},
                      separators=(',', ':'), sort_keys=True)


def of_type(events: Iterable[Dict[str, Any]], *types: str) -> List[Dict[str, Any]]:
    wanted = set(types)
    return [e for e in events if e['type'] in wanted]
