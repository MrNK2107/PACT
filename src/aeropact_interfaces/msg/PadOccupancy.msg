# A charging pad's occupancy sensor (load cell, beam or camera at the depot), D-31. Published by
# the depot's sensor driver; in simulation the vehicle plant publishes it from ground truth.
std_msgs/Header header
string depot_id
string pad_id
bool occupied
