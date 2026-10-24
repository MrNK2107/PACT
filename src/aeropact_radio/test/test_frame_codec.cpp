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

#include <gtest/gtest.h>

#include <algorithm>
#include <map>
#include <random>
#include <set>
#include <string>
#include <vector>

#include "aeropact_radio/frame_codec.hpp"

using aeropact::radio::Bytes;
using aeropact::radio::CounterSource;
using aeropact::radio::DecodeError;
using aeropact::radio::Envelope;
using aeropact::radio::FleetKey;
using aeropact::radio::ReplayWindow;
namespace radio = aeropact::radio;

namespace
{

FleetKey key(std::uint16_t id, std::uint8_t fill)
{
  FleetKey k;
  k.id = id;
  k.secret.assign(32, fill);
  return k;
}

Envelope envelope(const std::string & sender, std::uint64_t counter, std::size_t payload = 40)
{
  Envelope e;
  e.sender = sender;
  e.counter = counter;
  for (std::size_t i = 0; i < payload; ++i) {
    e.payload.push_back(static_cast<std::uint8_t>(i * 7 + 3));
  }
  return e;
}

}  // namespace

TEST(FrameCodec, Rfc4231HmacSha256TestCase2)
{
  // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?".
  const Bytes k{'J', 'e', 'f', 'e'};
  const std::string data = "what do ya want for nothing?";
  const auto mac = radio::hmac_sha256(k, reinterpret_cast<const std::uint8_t *>(data.data()),
      data.size());
  const std::uint8_t expected[32] = {
    0x5b, 0xdc, 0xc1, 0x46, 0xbf, 0x60, 0x75, 0x4e, 0x6a, 0x04, 0x24, 0x26, 0x08, 0x95, 0x75, 0xc7,
    0x5a, 0x00, 0x3f, 0x08, 0x9d, 0x27, 0x39, 0x83, 0x9d, 0xec, 0x58, 0xb9, 0x64, 0xec, 0x38, 0x43};
  EXPECT_TRUE(radio::constant_time_equal(mac.data(), expected, 32));
}

TEST(FrameCodec, RoundTrip)
{
  const FleetKey k = key(7, 0x42);
  const Envelope in = envelope("A01", 123456789);
  const Bytes wire = radio::encode(in, k);
  DecodeError err = DecodeError::kMalformed;
  const auto out = radio::decode(wire.data(), wire.size(), {k}, err);
  ASSERT_TRUE(out.has_value());
  EXPECT_EQ(err, DecodeError::kNone);
  EXPECT_EQ(out->key_id, 7);
  EXPECT_EQ(out->sender, "A01");
  EXPECT_EQ(out->counter, 123456789U);
  EXPECT_EQ(out->payload, in.payload);
}

// Property: flipping any single bit anywhere in the datagram is detected.
TEST(FrameCodec, EverySingleBitFlipIsRejected)
{
  const FleetKey k = key(1, 0x11);
  const Bytes wire = radio::encode(envelope("D2", 99), k);
  for (std::size_t i = 0; i < wire.size(); ++i) {
    for (int bit = 0; bit < 8; ++bit) {
      Bytes bad = wire;
      bad[i] ^= static_cast<std::uint8_t>(1 << bit);
      DecodeError err = DecodeError::kNone;
      ASSERT_FALSE(radio::decode(bad.data(), bad.size(), {k}, err).has_value())
        << "byte " << i << " bit " << bit;
      ASSERT_NE(err, DecodeError::kNone);
    }
  }
}

TEST(FrameCodec, TruncationAndGarbageAreMalformed)
{
  const FleetKey k = key(1, 0x11);
  const Bytes wire = radio::encode(envelope("A03", 5), k);
  for (std::size_t n = 0; n < wire.size(); ++n) {
    DecodeError err = DecodeError::kNone;
    ASSERT_FALSE(radio::decode(wire.data(), n, {k}, err).has_value()) << n;
  }
  std::mt19937 rng(1);
  for (int i = 0; i < 2000; ++i) {
    Bytes junk(std::uniform_int_distribution<int>(0, 300)(rng));
    for (auto & b : junk) {
      b = static_cast<std::uint8_t>(rng());
    }
    DecodeError err = DecodeError::kNone;
    ASSERT_FALSE(radio::decode(junk.data(), junk.size(), {k}, err).has_value());
  }
}

TEST(FrameCodec, WrongKeyAndUnknownKeyId)
{
  const FleetKey fleet = key(1, 0x11);
  const FleetKey attacker = key(1, 0x99);  // same id, different secret
  const Bytes forged = radio::encode(envelope("A01", 1), attacker);
  DecodeError err = DecodeError::kNone;
  EXPECT_FALSE(radio::decode(forged.data(), forged.size(), {fleet}, err).has_value());
  EXPECT_EQ(err, DecodeError::kBadMac);
  const Bytes other_id = radio::encode(envelope("A01", 1), key(9, 0x11));
  EXPECT_FALSE(radio::decode(other_id.data(), other_id.size(), {fleet}, err).has_value());
  EXPECT_EQ(err, DecodeError::kUnknownKey);
}

TEST(FrameCodec, KeyRotationAcceptsBothKeysInService)
{
  const FleetKey old_key = key(1, 0x11);
  const FleetKey new_key = key(2, 0x22);
  for (const auto & k : {old_key, new_key}) {
    const Bytes wire = radio::encode(envelope("A01", 1), k);
    DecodeError err = DecodeError::kNone;
    EXPECT_TRUE(radio::decode(wire.data(), wire.size(), {old_key, new_key}, err).has_value());
  }
}

TEST(FrameCodec, KeyFileParsing)
{
  const auto keys = radio::parse_key_file(
    "# fleet keys\n"
    "1:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n"
    "  2 : 00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF  # next\n");
  ASSERT_EQ(keys.size(), 2U);
  EXPECT_EQ(keys[1].id, 2);
  EXPECT_EQ(keys[1].secret[10], 0xAA);
  EXPECT_THROW(radio::parse_key_file(""), std::runtime_error);
  EXPECT_THROW(radio::parse_key_file("1:0011"), std::runtime_error);  // too short
  EXPECT_THROW(radio::parse_key_file("1:zz112233445566778899aabbccddeeff00112233445566778899aabb"
    "ccddeeff"), std::runtime_error);
  EXPECT_THROW(radio::parse_key_file(
      "1:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n"
      "1:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n"),
    std::runtime_error);
}

TEST(ReplayWindow, AcceptsEachCounterOnceAndRejectsOld)
{
  ReplayWindow w;
  EXPECT_TRUE(w.accept("A01", 100));
  EXPECT_FALSE(w.accept("A01", 100));
  EXPECT_TRUE(w.accept("A01", 102));
  EXPECT_TRUE(w.accept("A01", 101));   // reordered, inside the window
  EXPECT_FALSE(w.accept("A01", 101));
  EXPECT_TRUE(w.accept("A01", 500));
  EXPECT_FALSE(w.accept("A01", 400));  // older than the window
  EXPECT_TRUE(w.accept("A02", 1));     // senders are independent
  EXPECT_EQ(w.senders(), 2U);
}

// Property: any delivery order with duplicates, reordering bounded by the window, accepts every
// counter exactly once.
TEST(ReplayWindow, RandomReorderingWithDuplicatesAcceptsExactlyOnce)
{
  std::mt19937 rng(11);
  for (int trial = 0; trial < 300; ++trial) {
    std::vector<std::uint64_t> sent;
    for (std::uint64_t c = 1000; c < 1300; ++c) {
      sent.push_back(c);
    }
    // Local shuffles within blocks of 32 keep reordering inside the 64-wide window.
    for (std::size_t b = 0; b < sent.size(); b += 32) {
      std::shuffle(sent.begin() + b, sent.begin() + std::min(sent.size(), b + 32), rng);
    }
    std::vector<std::uint64_t> wire;
    for (auto c : sent) {
      wire.push_back(c);
      if (rng() % 4 == 0) {
        wire.push_back(c);  // duplicate (retransmission or replay)
      }
    }
    ReplayWindow w;
    std::set<std::uint64_t> accepted;
    for (auto c : wire) {
      if (w.accept("A01", c)) {
        ASSERT_TRUE(accepted.insert(c).second) << "accepted twice: " << c;
      }
    }
    ASSERT_EQ(accepted.size(), sent.size()) << "trial " << trial;
  }
}

TEST(CounterSource, StrictlyIncreasingEvenWhenTheClockStallsOrStepsBack)
{
  CounterSource c;
  std::uint64_t last = 0;
  for (std::uint64_t t : {100ULL, 100ULL, 99ULL, 50ULL, 200ULL, 200ULL}) {
    const auto v = c.next(t);
    EXPECT_GT(v, last);
    last = v;
  }
}

// ---- Ed25519 per-node signatures (D-30) ---------------------------------------------------

namespace
{

radio::SigningKey node_key(std::uint8_t fill)
{
  return radio::signing_key_from_seed(radio::Bytes(32, fill));
}

}  // namespace

TEST(SignedFrames, Rfc8032PublicKeyDerivation)
{
  // RFC 8032 section 7.1, test 1.
  const auto k = radio::parse_private_key_file(
    "# test vector\n9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60\n");
  EXPECT_EQ(radio::to_hex(k.public_key),
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
}

TEST(SignedFrames, RoundTripAndEveryBitFlipRejected)
{
  const auto a01 = node_key(0x01);
  const std::map<std::string, radio::Bytes> roster{{"A01", a01.public_key}};
  const radio::Bytes wire = radio::encode_signed(envelope("A01", 77), a01);
  DecodeError err = DecodeError::kMalformed;
  const auto out = radio::decode_signed(wire.data(), wire.size(), roster, err);
  ASSERT_TRUE(out.has_value());
  EXPECT_EQ(out->sender, "A01");
  EXPECT_EQ(out->counter, 77U);
  for (std::size_t i = 0; i < wire.size(); ++i) {
    for (int bit = 0; bit < 8; ++bit) {
      radio::Bytes bad = wire;
      bad[i] ^= static_cast<std::uint8_t>(1 << bit);
      ASSERT_FALSE(radio::decode_signed(bad.data(), bad.size(), roster, err).has_value())
        << "byte " << i << " bit " << bit;
    }
  }
}

TEST(SignedFrames, ACompromisedNodeCannotImpersonateAnother)
{
  // A04's key is stolen. With a group key the thief could speak as anyone; with per-node keys a
  // frame claiming to come from A01 but signed with A04's key fails verification.
  const auto a01 = node_key(0x01);
  const auto a04 = node_key(0x04);
  const std::map<std::string, radio::Bytes> roster{
    {"A01", a01.public_key}, {"A04", a04.public_key}};
  const radio::Bytes forged = radio::encode_signed(envelope("A01", 5), a04);
  DecodeError err = DecodeError::kNone;
  EXPECT_FALSE(radio::decode_signed(forged.data(), forged.size(), roster, err).has_value());
  EXPECT_EQ(err, DecodeError::kBadMac);
  // ...and once A04 is revoked (removed from the roster) it cannot speak as itself either.
  const radio::Bytes own = radio::encode_signed(envelope("A04", 6), a04);
  const std::map<std::string, radio::Bytes> revoked{{"A01", a01.public_key}};
  EXPECT_FALSE(radio::decode_signed(own.data(), own.size(), revoked, err).has_value());
  EXPECT_EQ(err, DecodeError::kUnknownKey);
}

TEST(SignedFrames, SchemesDoNotCrossDecode)
{
  const auto a01 = node_key(0x01);
  const std::map<std::string, radio::Bytes> roster{{"A01", a01.public_key}};
  const FleetKey fleet = key(1, 0x11);
  const radio::Bytes hmac_wire = radio::encode(envelope("A01", 1), fleet);
  const radio::Bytes signed_wire = radio::encode_signed(envelope("A01", 1), a01);
  DecodeError err = DecodeError::kNone;
  EXPECT_FALSE(radio::decode_signed(hmac_wire.data(), hmac_wire.size(), roster, err));
  EXPECT_FALSE(radio::decode(signed_wire.data(), signed_wire.size(), {fleet}, err));
}

TEST(SignedFrames, RosterParsing)
{
  const auto a = node_key(0x01);
  const auto b = node_key(0x02);
  const auto roster = radio::parse_public_keys(
    "# site roster\nA01:" + radio::to_hex(a.public_key) + "\n D1 : " +
    radio::to_hex(b.public_key) + "  # depot\n");
  ASSERT_EQ(roster.size(), 2U);
  EXPECT_EQ(roster.at("D1"), b.public_key);
  EXPECT_THROW(radio::parse_public_keys(""), std::runtime_error);
  EXPECT_THROW(radio::parse_public_keys("A01:0011"), std::runtime_error);
  EXPECT_THROW(radio::parse_public_keys("A01:" + radio::to_hex(a.public_key) + "\nA01:" +
    radio::to_hex(b.public_key)), std::runtime_error);
  // Fresh keys are distinct and usable.
  const auto g1 = radio::generate_signing_key();
  const auto g2 = radio::generate_signing_key();
  EXPECT_NE(g1.public_key, g2.public_key);
  EXPECT_EQ(radio::signing_key_from_seed(g1.seed).public_key, g1.public_key);
}
