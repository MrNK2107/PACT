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

#ifndef AEROPACT_SIM__YAML_JSON_HPP_
#define AEROPACT_SIM__YAML_JSON_HPP_

#include <yaml-cpp/yaml.h>

#include <string>

namespace aeropact::sim
{

/// Serialise a YAML node as compact JSON (fault arguments travel as JSON strings).
std::string to_json(const YAML::Node & node);

/// Parse a JSON (or YAML) string; returns an empty map node on failure.
YAML::Node parse_args(const std::string & json);

}  // namespace aeropact::sim

#endif  // AEROPACT_SIM__YAML_JSON_HPP_
