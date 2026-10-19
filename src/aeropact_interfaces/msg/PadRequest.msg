# Radio request to a depot pad arbiter.
uint8 OP_RESERVE=0
uint8 OP_RELEASE=1
string drone_id
string depot_id
uint8 op
uint64 request_id
float64 eta                        # fleet time base (s)
float64 duration_s
string pad_id                      # for release
