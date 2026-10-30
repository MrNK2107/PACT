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

#ifndef AEROPACT_RADIO__FRAME_CODEC_HPP_
#define AEROPACT_RADIO__FRAME_CODEC_HPP_

#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace aeropact::radio
{

using Bytes = std::vector<std::uint8_t>;
constexpr std::size_t kMacSize = 32;      ///< HMAC-SHA256
constexpr std::size_t kMinKeySize = 32;   ///< 256-bit fleet keys
constexpr std::size_t kMaxDatagram = 65000;
constexpr std::size_t kMaxSenderId = 64;

/// A fleet key: identifier (lets a site rotate keys with two in service) and secret.
struct FleetKey
{
  std::uint16_t id{0};
  Bytes secret;
};

/// Parses "key_id:hex_secret" lines (comments with '#'); throws on malformed or short keys.
std::vector<FleetKey> parse_key_file(const std::string & text);

/// HMAC-SHA256 (OpenSSL); constant-time comparison for verification.
std::array<std::uint8_t, kMacSize> hmac_sha256(
  const Bytes & key, const std::uint8_t * data,
  std::size_t len);
bool constant_time_equal(const std::uint8_t * a, const std::uint8_t * b, std::size_t len);

/**
 * Datagram layout (all integers big-endian):
 *   magic "APF1" | key_id u16 | sender_len u8 | sender | counter u64 | payload_len u32 | payload
 *   | mac[32] = HMAC-SHA256(key, everything before the mac)
 * The payload is the CDR-serialised RadioFrame. `counter` is strictly increasing per sender
 * (wall-clock nanoseconds, bumped on ties), so a sender needs no persistent state across reboots.
 */
struct Envelope
{
  std::uint16_t key_id{0};
  std::string sender;
  std::uint64_t counter{0};
  Bytes payload;
};

enum class DecodeError : std::uint8_t
{
  kNone = 0,
  kMalformed,
  kUnknownKey,
  kBadMac,
  kReplay,
};
const char * to_string(DecodeError e);

Bytes encode(const Envelope & env, const FleetKey & key);

/// Parses and authenticates a datagram; does not check replay (see ReplayWindow).
std::optional<Envelope> decode(
  const std::uint8_t * data, std::size_t len,
  const std::vector<FleetKey> & keys, DecodeError & error);

// ---- Per-node signatures (Ed25519) --------------------------------------------------------
//
// Datagram layout "APF2": magic | sender_len u8 | sender | counter u64 | payload_len u32 |
// payload | sig[64] = Ed25519(sender's private key, everything before the signature).
// Each node holds only its own private key and the site's roster of public keys, so a
// compromised node can speak only as itself and is revoked by removing one roster line (D-30).

constexpr std::size_t kEd25519KeySize = 32;
constexpr std::size_t kEd25519SigSize = 64;

/// A node's signing key: the 32-byte Ed25519 seed (private key) and its public key.
struct SigningKey
{
  Bytes seed;
  Bytes public_key;
};

/// Generates a new key from the OS's cryptographic random source.
SigningKey generate_signing_key();
/// Derives the public key from a 32-byte seed; throws on a bad seed.
SigningKey signing_key_from_seed(const Bytes & seed);
/// Parses a private key file: one line with 64 hex characters (comments with '#').
SigningKey parse_private_key_file(const std::string & text);
/// Parses a public-key roster: "node_id:hex_public_key" lines; throws on malformed entries.
std::map<std::string, Bytes> parse_public_keys(const std::string & text);
std::string to_hex(const Bytes & b);

Bytes encode_signed(const Envelope & env, const SigningKey & key);

/// Parses an APF2 datagram and verifies it against the sender's roster key.
/// kUnknownKey: the sender has no roster entry; kBadMac: the signature does not verify.
std::optional<Envelope> decode_signed(
  const std::uint8_t * data, std::size_t len,
  const std::map<std::string, Bytes> & roster, DecodeError & error);

/**
 * Anti-replay: per sender, the highest counter seen and a 64-entry bitmap below it (as in IPsec
 * ESP). Accepts each counter at most once, tolerates reordering within the window, rejects
 * anything older. Only authenticated envelopes may be offered (an attacker cannot advance it).
 */
class ReplayWindow
{
public:
  bool accept(const std::string & sender, std::uint64_t counter);
  std::size_t senders() const {return state_.size();}

private:
  struct State
  {
    std::uint64_t highest{0};
    std::uint64_t bitmap{0};  ///< bit i set: counter (highest - i) seen
    bool any{false};
  };
  std::map<std::string, State> state_;
};

/// Strictly increasing counter source for a sender.
class CounterSource
{
public:
  std::uint64_t next(std::uint64_t now_ns)
  {
    last_ = now_ns > last_ ? now_ns : last_ + 1;
    return last_;
  }

private:
  std::uint64_t last_{0};
};

}  // namespace aeropact::radio

#endif  // AEROPACT_RADIO__FRAME_CODEC_HPP_
