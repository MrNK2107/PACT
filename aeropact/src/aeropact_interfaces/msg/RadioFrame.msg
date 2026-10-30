# Envelope for every inter-agent message on the simulated mesh (PRD 9.1, NFR-3).
# Exactly one payload field is populated, selected by `type`. Receivers ignore unknown types
# and frames with a newer major version than they support.

uint8 VERSION=1

uint8 TYPE_GOSSIP_DELTA=1
uint8 TYPE_HEARTBEAT=2
uint8 TYPE_PROBE=3
uint8 TYPE_PROBE_ACK=4
uint8 TYPE_DISTRESS=5
uint8 TYPE_SUSPICION=6
uint8 TYPE_PAD_REQUEST=7
uint8 TYPE_PAD_RESPONSE=8

uint8 version
uint8 type
string src
string dst                        # "*" for broadcast
uint64 seq
string sig                        # authentication stub (assumption T6)
GossipDelta[<=1] gossip
Heartbeat[<=1] heartbeat
Probe[<=1] probe
ProbeAck[<=1] probe_ack
Distress[<=1] distress
Suspicion[<=1] suspicion
PadRequest[<=1] pad_request
PadResponse[<=1] pad_response
