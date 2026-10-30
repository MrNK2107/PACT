// Copyright 2026 AeroPACT Contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Line-oriented stdin/stdout oracle over the real aeropact_core merge functions, so that
// Python property tests (hypothesis, with shrinking) can drive the C++ CRDT join directly.
//
// Protocol, one request per line, one response line each:
//   M <v>|<v>|...    fold merge_task over the versions (left to right) -> <v>
//   C <v>|<v>        compare_task_versions(a, b) -> -1 | 0 | 1
//   L <l>|<l>        compare_shard_leases(a, b)  -> -1 | 0 | 1
// Task version <v>:  state claim_epoch epoch owner bid lease_seq lease_ttl abort_reason
// Shard lease  <l>:  holder epoch lease_seq lease_ttl
// Strings are single tokens; "-" encodes the empty string.

#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "aeropact_core/merge.hpp"

namespace core = aeropact::core;

namespace
{

std::string dec(const std::string & s) {return s == "-" ? std::string() : s;}
std::string enc(const std::string & s) {return s.empty() ? std::string("-") : s;}

std::vector<std::string> split(const std::string & s, char sep)
{
  std::vector<std::string> out;
  std::string cur;
  std::istringstream in(s);
  while (std::getline(in, cur, sep)) {out.push_back(cur);}
  return out;
}

core::Task parse_task(const std::string & s)
{
  core::Task t;
  t.task_id = "D1:00000001:0001";
  t.origin_depot = "D1";
  t.drop = {300, 200, 0};
  t.priority = 2;
  t.deadline = 900;
  t.weight_kg = 1.0f;
  t.shard = "H-1-1";
  t.created_at = 10;
  std::istringstream in(s);
  int state = 0;
  std::string owner, reason;
  in >> state >> t.claim_epoch >> t.epoch >> owner >> t.bid >> t.lease_seq >> t.lease_ttl >>
  reason;
  t.state = static_cast<core::TaskState>(state);
  t.owner = dec(owner);
  t.abort_reason = dec(reason);
  return t;
}

std::string show_task(const core::Task & t)
{
  std::ostringstream out;
  out.precision(17);
  out << static_cast<int>(t.state) << ' ' << t.claim_epoch << ' ' << t.epoch << ' ' <<
    enc(t.owner) << ' ' << t.bid << ' ' << t.lease_seq << ' ' << t.lease_ttl << ' ' <<
    enc(t.abort_reason);
  return out.str();
}

core::ShardLease parse_lease(const std::string & s)
{
  core::ShardLease l;
  l.shard_id = "H-1-1";
  std::istringstream in(s);
  std::string holder;
  in >> holder >> l.epoch >> l.lease_seq >> l.lease_ttl;
  l.holder = dec(holder);
  return l;
}

int sign(int c) {return c > 0 ? 1 : (c < 0 ? -1 : 0);}

}  // namespace

int main()
{
  std::ios::sync_with_stdio(false);
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.size() < 2) {
      std::cout << "ERR\n" << std::flush;
      continue;
    }
    const char op = line[0];
    const auto parts = split(line.substr(2), '|');
    if (op == 'M' && !parts.empty()) {
      core::Task acc = parse_task(parts[0]);
      for (std::size_t i = 1; i < parts.size(); ++i) {
        acc = core::merge_task(acc, parse_task(parts[i]));
      }
      std::cout << show_task(acc) << '\n';
    } else if (op == 'C' && parts.size() == 2) {
      std::cout << sign(core::compare_task_versions(parse_task(parts[0]), parse_task(parts[1]))) <<
        '\n';
    } else if (op == 'L' && parts.size() == 2) {
      std::cout << sign(core::compare_shard_leases(parse_lease(parts[0]), parse_lease(parts[1]))) <<
        '\n';
    } else {
      std::cout << "ERR\n";
    }
    std::cout << std::flush;
  }
  return 0;
}
