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

#include "aeropact_sim/yaml_json.hpp"

#include <cstdlib>

#include "aeropact_core/json.hpp"

namespace aeropact::sim
{

namespace
{

bool is_number(const std::string & s)
{
  if (s.empty()) {
    return false;
  }
  char * end = nullptr;
  std::strtod(s.c_str(), &end);
  return end != nullptr && *end == '\0';
}

}  // namespace

std::string to_json(const YAML::Node & node)
{
  switch (node.Type()) {
    case YAML::NodeType::Null:
    case YAML::NodeType::Undefined:
      return "null";
    case YAML::NodeType::Scalar: {
        const std::string s = node.Scalar();
        if (node.Tag() != "!" && (is_number(s) || s == "true" || s == "false")) {
          return s;
        }
        return "\"" + core::Json::escape(s) + "\"";
      }
    case YAML::NodeType::Sequence: {
        std::string out = "[";
        for (std::size_t i = 0; i < node.size(); ++i) {
          out += (i ? "," : "") + to_json(node[i]);
        }
        return out + "]";
      }
    case YAML::NodeType::Map: {
        std::string out = "{";
        bool first = true;
        for (const auto & kv : node) {
          out += (first ? "\"" : ",\"") + core::Json::escape(kv.first.as<std::string>()) + "\":" +
            to_json(kv.second);
          first = false;
        }
        return out + "}";
      }
  }
  return "null";
}

YAML::Node parse_args(const std::string & json)
{
  try {
    YAML::Node n = YAML::Load(json.empty() ? "{}" : json);
    return n.IsMap() ? n : YAML::Node(YAML::NodeType::Map);
  } catch (const YAML::Exception &) {
    return YAML::Node(YAML::NodeType::Map);
  }
}

}  // namespace aeropact::sim
