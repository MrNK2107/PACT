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

#ifndef AEROPACT_CORE__JSON_HPP_
#define AEROPACT_CORE__JSON_HPP_

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace aeropact::core
{

/// Minimal compact JSON object writer for structured event payloads (NFR-4).
class Json
{
public:
  Json & add(const std::string & key, const std::string & value)
  {
    key_(key);
    body_ += '"' + escape(value) + '"';
    return *this;
  }
  Json & add(const std::string & key, const char * value) {return add(key, std::string(value));}
  Json & add(const std::string & key, bool value)
  {
    key_(key);
    body_ += value ? "true" : "false";
    return *this;
  }
  Json & add(const std::string & key, double value)
  {
    key_(key);
    if (!std::isfinite(value)) {
      body_ += "null";
    } else {
      char buf[32];
      std::snprintf(buf, sizeof(buf), "%.6g", value);
      body_ += buf;
    }
    return *this;
  }
  Json & add(const std::string & key, int32_t value) {return add_int(key, value);}
  Json & add(const std::string & key, uint32_t value) {return add_int(key, value);}
  Json & add(const std::string & key, int64_t value) {return add_int(key, value);}
  Json & add(const std::string & key, uint64_t value) {return add_int(key, value);}
  Json & add(const std::string & key, const std::vector<std::string> & values)
  {
    key_(key);
    body_ += '[';
    for (std::size_t i = 0; i < values.size(); ++i) {
      body_ += (i ? ",\"" : "\"") + escape(values[i]) + '"';
    }
    body_ += ']';
    return *this;
  }
  /// Insert a pre-serialised JSON value.
  Json & raw(const std::string & key, const std::string & json)
  {
    key_(key);
    body_ += json;
    return *this;
  }

  std::string str() const {return '{' + body_ + '}';}

  static std::string escape(const std::string & s)
  {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
      switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\t': out += "\\t"; break;
        default:
          if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
          } else {
            out += c;
          }
      }
    }
    return out;
  }

private:
  template<typename T>
  Json & add_int(const std::string & key, T value)
  {
    key_(key);
    body_ += std::to_string(value);
    return *this;
  }
  void key_(const std::string & key)
  {
    if (!body_.empty()) {
      body_ += ',';
    }
    body_ += '"' + escape(key) + "\":";
  }

  std::string body_;
};

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__JSON_HPP_
