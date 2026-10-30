# AeroPACT development / CI image: ROS 2 Jazzy + Gazebo Harmonic on Ubuntu 24.04.
#   docker build -t aeropact -f docker/Dockerfile .
#   docker run --rm -it aeropact make test
FROM osrf/ros:jazzy-desktop-full

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ros-jazzy-ros-gz \
      ros-jazzy-rosbag2-storage-mcap \
      python3-yaml python3-matplotlib python3-pytest python3-venv \
      make \
    && rm -rf /var/lib/apt/lists/*

ENV AEROPACT_WS=/opt/aeropact
WORKDIR ${AEROPACT_WS}
COPY . ${AEROPACT_WS}
RUN bash -c "source /opt/ros/jazzy/setup.bash && make build BUILD_ROOT=/opt/aeropact_build JOBS=4"
ENV BUILD_ROOT=/opt/aeropact_build
RUN echo 'source /opt/ros/jazzy/setup.bash && source /opt/aeropact_build/install/setup.bash' \
      >> /root/.bashrc
CMD ["bash"]
