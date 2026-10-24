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

// Fleet key generation from the OS's cryptographic random source.
//
//   fleet_keygen <key_id>                          shared HMAC key line "key_id:hex" (auth hmac)
//   fleet_keygen --ed25519 <node_id> <key_file>    per-node key (auth ed25519): writes the
//                                                  private key to <key_file> (mode 600) and
//                                                  prints the roster line "node_id:hex_public"

#include <sys/stat.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>

#include "aeropact_radio/frame_codec.hpp"

int main(int argc, char ** argv)
{
  namespace radio = aeropact::radio;
  if (argc == 4 && std::string(argv[1]) == "--ed25519") {
    const std::string node = argv[2];
    if (node.empty() || node.size() > radio::kMaxSenderId || node.find(':') != std::string::npos) {
      std::fprintf(stderr, "node id must be 1..64 characters without ':'\n");
      return 2;
    }
    const radio::SigningKey k = radio::generate_signing_key();
    {
      std::ofstream out(argv[3], std::ios::trunc);
      if (!out) {
        std::fprintf(stderr, "cannot write %s\n", argv[3]);
        return 1;
      }
      out << "# AeroPACT Ed25519 private key for " << node << " - keep secret\n"
          << radio::to_hex(k.seed) << "\n";
    }
    ::chmod(argv[3], S_IRUSR | S_IWUSR);
    std::printf("%s:%s\n", node.c_str(), radio::to_hex(k.public_key).c_str());
    return 0;
  }
  if (argc != 2) {
    std::fprintf(stderr,
      "usage: fleet_keygen <key_id 0..65535>\n"
      "       fleet_keygen --ed25519 <node_id> <private_key_file>\n");
    return 2;
  }
  const int id = std::atoi(argv[1]);
  if (id < 0 || id > 65535) {
    std::fprintf(stderr, "key id out of range\n");
    return 2;
  }
  radio::SigningKey seed_source = radio::generate_signing_key();  // 32 random bytes
  std::printf("%d:%s\n", id, radio::to_hex(seed_source.seed).c_str());
  return 0;
}
