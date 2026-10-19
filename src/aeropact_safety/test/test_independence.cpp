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

// Invariant I4 as a build-time rule: the safety package must not depend on the coordination
// stack or the radio. Scans package.xml, CMakeLists.txt and every source file.

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace
{

std::string slurp(const fs::path & p)
{
  std::ifstream in(p);
  std::stringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

const std::vector<std::string> kForbidden{
  "aeropact_core", "aeropact_agent", "aeropact_depot", "radio/rx", "radio/tx", "RadioFrame",
  "GossipDelta", "CoordinatorStatus"};

}  // namespace

TEST(SafetyIndependence, NoCoordinationOrRadioDependencies)
{
  const fs::path root(PACKAGE_DIR);
  std::vector<fs::path> files{root / "package.xml", root / "CMakeLists.txt"};
  for (const auto & dir : {root / "src", root / "include"}) {
    for (const auto & e : fs::recursive_directory_iterator(dir)) {
      if (e.is_regular_file()) {
        files.push_back(e.path());
      }
    }
  }
  ASSERT_GT(files.size(), 3u);
  for (const auto & f : files) {
    const std::string text = slurp(f);
    for (const auto & bad : kForbidden) {
      // The package description legitimately names what it must not depend on.
      if (f.filename() == "package.xml" && bad.rfind("aeropact_", 0) == 0) {
        EXPECT_EQ(text.find("<depend>" + bad), std::string::npos) << f << " depends on " << bad;
        continue;
      }
      EXPECT_EQ(text.find(bad), std::string::npos) << f << " mentions " << bad;
    }
  }
}
