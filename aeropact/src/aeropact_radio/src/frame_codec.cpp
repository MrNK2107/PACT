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

#include "aeropact_radio/frame_codec.hpp"

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>

#include <cctype>
#include <memory>
#include <sstream>
#include <stdexcept>

namespace aeropact::radio
{

namespace
{

constexpr std::uint8_t kMagic[4] = {'A', 'P', 'F', '1'};

void put_u16(Bytes & b, std::uint16_t v)
{
  b.push_back(static_cast<std::uint8_t>(v >> 8));
  b.push_back(static_cast<std::uint8_t>(v));
}

void put_u32(Bytes & b, std::uint32_t v)
{
  for (int s = 24; s >= 0; s -= 8) {
    b.push_back(static_cast<std::uint8_t>(v >> s));
  }
}

void put_u64(Bytes & b, std::uint64_t v)
{
  for (int s = 56; s >= 0; s -= 8) {
    b.push_back(static_cast<std::uint8_t>(v >> s));
  }
}

std::uint64_t get_be(const std::uint8_t * p, int n)
{
  std::uint64_t v = 0;
  for (int i = 0; i < n; ++i) {
    v = (v << 8) | p[i];
  }
  return v;
}

int hex_value(char c)
{
  if (c >= '0' && c <= '9') {return c - '0';}
  if (c >= 'a' && c <= 'f') {return c - 'a' + 10;}
  if (c >= 'A' && c <= 'F') {return c - 'A' + 10;}
  return -1;
}

}  // namespace

const char * to_string(DecodeError e)
{
  switch (e) {
    case DecodeError::kNone: return "ok";
    case DecodeError::kMalformed: return "malformed";
    case DecodeError::kUnknownKey: return "unknown_key";
    case DecodeError::kBadMac: return "bad_mac";
    case DecodeError::kReplay: return "replay";
  }
  return "unknown";
}

std::vector<FleetKey> parse_key_file(const std::string & text)
{
  std::vector<FleetKey> keys;
  std::istringstream in(text);
  std::string line;
  int line_no = 0;
  while (std::getline(in, line)) {
    ++line_no;
    const auto hash = line.find('#');
    if (hash != std::string::npos) {
      line.erase(hash);
    }
    std::string s;
    for (char c : line) {
      if (!std::isspace(static_cast<unsigned char>(c))) {
        s.push_back(c);
      }
    }
    if (s.empty()) {
      continue;
    }
    const auto colon = s.find(':');
    if (colon == std::string::npos || colon == 0) {
      throw std::runtime_error("key file line " + std::to_string(line_no) +
              ": expected key_id:hex_secret");
    }
    FleetKey k;
    const std::int64_t id = std::stoll(s.substr(0, colon));
    if (id < 0 || id > 0xFFFF) {
      throw std::runtime_error("key file line " + std::to_string(line_no) + ": key id too large");
    }
    k.id = static_cast<std::uint16_t>(id);
    const std::string hex = s.substr(colon + 1);
    if (hex.size() % 2 != 0) {
      throw std::runtime_error("key file line " + std::to_string(line_no) + ": odd hex length");
    }
    for (std::size_t i = 0; i < hex.size(); i += 2) {
      const int hi = hex_value(hex[i]);
      const int lo = hex_value(hex[i + 1]);
      if (hi < 0 || lo < 0) {
        throw std::runtime_error("key file line " + std::to_string(line_no) + ": bad hex");
      }
      k.secret.push_back(static_cast<std::uint8_t>(hi * 16 + lo));
    }
    if (k.secret.size() < kMinKeySize) {
      throw std::runtime_error("key file line " + std::to_string(line_no) +
              ": key shorter than 256 bits");
    }
    for (const auto & other : keys) {
      if (other.id == k.id) {
        throw std::runtime_error("key file: duplicate key id " + std::to_string(k.id));
      }
    }
    keys.push_back(std::move(k));
  }
  if (keys.empty()) {
    throw std::runtime_error("key file: no keys");
  }
  return keys;
}

std::array<std::uint8_t, kMacSize> hmac_sha256(
  const Bytes & key, const std::uint8_t * data, std::size_t len)
{
  std::array<std::uint8_t, kMacSize> out{};
  unsigned int out_len = 0;
  if (HMAC(EVP_sha256(), key.data(), static_cast<int>(key.size()), data, len, out.data(),
    &out_len) == nullptr || out_len != kMacSize)
  {
    throw std::runtime_error("HMAC-SHA256 failed");
  }
  return out;
}

bool constant_time_equal(const std::uint8_t * a, const std::uint8_t * b, std::size_t len)
{
  return CRYPTO_memcmp(a, b, len) == 0;
}

Bytes encode(const Envelope & env, const FleetKey & key)
{
  if (env.sender.empty() || env.sender.size() > kMaxSenderId) {
    throw std::invalid_argument("sender id must be 1..64 bytes");
  }
  Bytes b;
  b.reserve(4 + 2 + 1 + env.sender.size() + 8 + 4 + env.payload.size() + kMacSize);
  b.insert(b.end(), kMagic, kMagic + 4);
  put_u16(b, key.id);
  b.push_back(static_cast<std::uint8_t>(env.sender.size()));
  b.insert(b.end(), env.sender.begin(), env.sender.end());
  put_u64(b, env.counter);
  put_u32(b, static_cast<std::uint32_t>(env.payload.size()));
  b.insert(b.end(), env.payload.begin(), env.payload.end());
  const auto mac = hmac_sha256(key.secret, b.data(), b.size());
  b.insert(b.end(), mac.begin(), mac.end());
  if (b.size() > kMaxDatagram) {
    throw std::length_error("frame exceeds the datagram limit");
  }
  return b;
}

std::optional<Envelope> decode(
  const std::uint8_t * data, std::size_t len, const std::vector<FleetKey> & keys,
  DecodeError & error)
{
  error = DecodeError::kMalformed;
  constexpr std::size_t kFixed = 4 + 2 + 1 + 8 + 4 + kMacSize;
  if (data == nullptr || len < kFixed || len > kMaxDatagram) {
    return std::nullopt;
  }
  for (int i = 0; i < 4; ++i) {
    if (data[i] != kMagic[i]) {
      return std::nullopt;
    }
  }
  const auto key_id = static_cast<std::uint16_t>(get_be(data + 4, 2));
  const std::size_t sender_len = data[6];
  if (sender_len == 0 || sender_len > kMaxSenderId || len < kFixed + sender_len) {
    return std::nullopt;
  }
  const std::size_t p = 7 + sender_len;
  const std::uint64_t counter = get_be(data + p, 8);
  const std::size_t payload_len = static_cast<std::size_t>(get_be(data + p + 8, 4));
  if (len != kFixed + sender_len + payload_len) {
    return std::nullopt;
  }
  const FleetKey * key = nullptr;
  for (const auto & k : keys) {
    if (k.id == key_id) {
      key = &k;
      break;
    }
  }
  if (key == nullptr) {
    error = DecodeError::kUnknownKey;
    return std::nullopt;
  }
  const std::size_t signed_len = len - kMacSize;
  const auto mac = hmac_sha256(key->secret, data, signed_len);
  if (!constant_time_equal(mac.data(), data + signed_len, kMacSize)) {
    error = DecodeError::kBadMac;
    return std::nullopt;
  }
  Envelope env;
  env.key_id = key_id;
  env.sender.assign(reinterpret_cast<const char *>(data + 7), sender_len);
  env.counter = counter;
  env.payload.assign(data + p + 12, data + p + 12 + payload_len);
  error = DecodeError::kNone;
  return env;
}

bool ReplayWindow::accept(const std::string & sender, std::uint64_t counter)
{
  State & s = state_[sender];
  if (!s.any) {
    s.any = true;
    s.highest = counter;
    s.bitmap = 1;
    return true;
  }
  if (counter > s.highest) {
    const std::uint64_t shift = counter - s.highest;
    s.bitmap = shift >= 64 ? 1 : ((s.bitmap << shift) | 1);
    s.highest = counter;
    return true;
  }
  const std::uint64_t age = s.highest - counter;
  if (age >= 64) {
    return false;  // too old to tell: reject
  }
  const std::uint64_t bit = std::uint64_t{1} << age;
  if (s.bitmap & bit) {
    return false;  // seen
  }
  s.bitmap |= bit;
  return true;
}

// ---- Ed25519 --------------------------------------------------------------------------------

namespace
{

constexpr std::uint8_t kMagicSigned[4] = {'A', 'P', 'F', '2'};

using PkeyPtr = std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)>;
using MdCtxPtr = std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)>;

Bytes parse_hex(const std::string & hex, const std::string & what)
{
  if (hex.size() % 2 != 0) {
    throw std::runtime_error(what + ": odd hex length");
  }
  Bytes out;
  for (std::size_t i = 0; i < hex.size(); i += 2) {
    const int hi = hex_value(hex[i]);
    const int lo = hex_value(hex[i + 1]);
    if (hi < 0 || lo < 0) {
      throw std::runtime_error(what + ": bad hex");
    }
    out.push_back(static_cast<std::uint8_t>(hi * 16 + lo));
  }
  return out;
}

std::string strip(const std::string & line)
{
  std::string s;
  for (char c : line.substr(0, line.find('#'))) {
    if (!std::isspace(static_cast<unsigned char>(c))) {
      s.push_back(c);
    }
  }
  return s;
}

}  // namespace

std::string to_hex(const Bytes & b)
{
  static const char * digits = "0123456789abcdef";
  std::string s;
  for (std::uint8_t v : b) {
    s.push_back(digits[v >> 4]);
    s.push_back(digits[v & 0x0F]);
  }
  return s;
}

SigningKey signing_key_from_seed(const Bytes & seed)
{
  if (seed.size() != kEd25519KeySize) {
    throw std::invalid_argument("an Ed25519 private key is 32 bytes");
  }
  PkeyPtr pkey(EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, nullptr, seed.data(), seed.size()),
    EVP_PKEY_free);
  if (!pkey) {
    throw std::runtime_error("Ed25519 key setup failed");
  }
  SigningKey k;
  k.seed = seed;
  k.public_key.resize(kEd25519KeySize);
  std::size_t len = k.public_key.size();
  if (EVP_PKEY_get_raw_public_key(pkey.get(), k.public_key.data(), &len) != 1 ||
    len != kEd25519KeySize)
  {
    throw std::runtime_error("Ed25519 public key derivation failed");
  }
  return k;
}

SigningKey generate_signing_key()
{
  Bytes seed(kEd25519KeySize);
  if (RAND_bytes(seed.data(), static_cast<int>(seed.size())) != 1) {
    throw std::runtime_error("RAND_bytes failed");
  }
  return signing_key_from_seed(seed);
}

SigningKey parse_private_key_file(const std::string & text)
{
  std::istringstream in(text);
  std::string line;
  while (std::getline(in, line)) {
    const std::string s = strip(line);
    if (!s.empty()) {
      return signing_key_from_seed(parse_hex(s, "private key"));
    }
  }
  throw std::runtime_error("private key file: no key");
}

std::map<std::string, Bytes> parse_public_keys(const std::string & text)
{
  std::map<std::string, Bytes> roster;
  std::istringstream in(text);
  std::string line;
  int line_no = 0;
  while (std::getline(in, line)) {
    ++line_no;
    const std::string s = strip(line);
    if (s.empty()) {
      continue;
    }
    const auto colon = s.find(':');
    const std::string where = "public keys line " + std::to_string(line_no);
    if (colon == std::string::npos || colon == 0 || colon > kMaxSenderId) {
      throw std::runtime_error(where + ": expected node_id:hex_public_key");
    }
    Bytes key = parse_hex(s.substr(colon + 1), where);
    if (key.size() != kEd25519KeySize) {
      throw std::runtime_error(where + ": an Ed25519 public key is 32 bytes");
    }
    if (!roster.emplace(s.substr(0, colon), std::move(key)).second) {
      throw std::runtime_error(where + ": duplicate node " + s.substr(0, colon));
    }
  }
  if (roster.empty()) {
    throw std::runtime_error("public keys: empty roster");
  }
  return roster;
}

Bytes encode_signed(const Envelope & env, const SigningKey & key)
{
  if (env.sender.empty() || env.sender.size() > kMaxSenderId) {
    throw std::invalid_argument("sender id must be 1..64 bytes");
  }
  Bytes b;
  b.reserve(4 + 1 + env.sender.size() + 8 + 4 + env.payload.size() + kEd25519SigSize);
  b.insert(b.end(), kMagicSigned, kMagicSigned + 4);
  b.push_back(static_cast<std::uint8_t>(env.sender.size()));
  b.insert(b.end(), env.sender.begin(), env.sender.end());
  put_u64(b, env.counter);
  put_u32(b, static_cast<std::uint32_t>(env.payload.size()));
  b.insert(b.end(), env.payload.begin(), env.payload.end());
  PkeyPtr pkey(EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, nullptr, key.seed.data(),
    key.seed.size()), EVP_PKEY_free);
  MdCtxPtr ctx(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  std::uint8_t sig[kEd25519SigSize];
  std::size_t sig_len = sizeof(sig);
  if (!pkey || !ctx || EVP_DigestSignInit(ctx.get(), nullptr, nullptr, nullptr, pkey.get()) != 1 ||
    EVP_DigestSign(ctx.get(), sig, &sig_len, b.data(), b.size()) != 1 ||
    sig_len != kEd25519SigSize)
  {
    throw std::runtime_error("Ed25519 signing failed");
  }
  b.insert(b.end(), sig, sig + kEd25519SigSize);
  if (b.size() > kMaxDatagram) {
    throw std::length_error("frame exceeds the datagram limit");
  }
  return b;
}

std::optional<Envelope> decode_signed(
  const std::uint8_t * data, std::size_t len, const std::map<std::string, Bytes> & roster,
  DecodeError & error)
{
  error = DecodeError::kMalformed;
  constexpr std::size_t kFixed = 4 + 1 + 8 + 4 + kEd25519SigSize;
  if (data == nullptr || len < kFixed || len > kMaxDatagram) {
    return std::nullopt;
  }
  for (int i = 0; i < 4; ++i) {
    if (data[i] != kMagicSigned[i]) {
      return std::nullopt;
    }
  }
  const std::size_t sender_len = data[4];
  if (sender_len == 0 || sender_len > kMaxSenderId || len < kFixed + sender_len) {
    return std::nullopt;
  }
  const std::size_t p = 5 + sender_len;
  const std::uint64_t counter = get_be(data + p, 8);
  const std::size_t payload_len = static_cast<std::size_t>(get_be(data + p + 8, 4));
  if (len != kFixed + sender_len + payload_len) {
    return std::nullopt;
  }
  const std::string sender(reinterpret_cast<const char *>(data + 5), sender_len);
  const auto it = roster.find(sender);
  if (it == roster.end()) {
    error = DecodeError::kUnknownKey;
    return std::nullopt;
  }
  PkeyPtr pkey(EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, nullptr, it->second.data(),
    it->second.size()), EVP_PKEY_free);
  MdCtxPtr ctx(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  const std::size_t signed_len = len - kEd25519SigSize;
  if (!pkey || !ctx ||
    EVP_DigestVerifyInit(ctx.get(), nullptr, nullptr, nullptr, pkey.get()) != 1 ||
    EVP_DigestVerify(ctx.get(), data + signed_len, kEd25519SigSize, data, signed_len) != 1)
  {
    error = DecodeError::kBadMac;
    return std::nullopt;
  }
  Envelope env;
  env.sender = sender;
  env.counter = counter;
  env.payload.assign(data + p + 12, data + p + 12 + payload_len);
  error = DecodeError::kNone;
  return env;
}

}  // namespace aeropact::radio
