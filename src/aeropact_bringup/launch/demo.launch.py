# Copyright 2026 AeroPACT Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""
Five-minute demo (PRD G5): the hub-loss + partition scenario in Gazebo with RViz.

    ros2 launch aeropact_bringup demo.launch.py            # PACT (QUORUM)
    ros2 launch aeropact_bringup demo.launch.py system:=central gui:=true
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration


def generate_launch_description():
    scenario_launch = os.path.join(get_package_share_directory('aeropact_bringup'), 'launch',
                                   'scenario.launch.py')
    args = [
        DeclareLaunchArgument('system', default_value='pact_quorum'),
        DeclareLaunchArgument('backend', default_value='gazebo'),
        DeclareLaunchArgument('gui', default_value='false'),
        DeclareLaunchArgument('rviz', default_value='true'),
    ]
    return LaunchDescription(args + [IncludeLaunchDescription(
        PythonLaunchDescriptionSource(scenario_launch),
        launch_arguments={
            'scenario': 'demo_hub_loss_partition',
            'system': LaunchConfiguration('system'),
            'backend': LaunchConfiguration('backend'),
            'gui': LaunchConfiguration('gui'),
            'rviz': LaunchConfiguration('rviz'),
        }.items())])
