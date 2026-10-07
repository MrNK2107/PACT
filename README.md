# SwarmOS — Virtual Multi-Drone Simulation Platform

> **SIMULATION ONLY**: SwarmOS is a web-first virtual multi-drone simulation environment. It does not connect to physical drones, transmit real flight commands, or claim physical flight certification.

---

## Overview

SwarmOS is an engineering-grade operations console for spawning, visualizing, controlling, and coordinating 10–100 virtual drones in a shared 3D simulation environment.

### Architecture
- **Backend**: Python FastAPI with fixed-step (20 Hz) kinematic simulation engine, SQLite persistence, and high-throughput WebSockets for telemetry snapshots and events.
- **Frontend**: React + Three.js (`@react-three/fiber`, `@react-three/drei`), Tailwind CSS, and Lucide icons.
- **Control Modes**: `MANUAL`, `AUTOPILOT`, `HOLD`, `RETURNING`, `PAUSED`, `ERROR`.

---

## Quickstart

### 1. Run Backend Server
```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

### 2. Run Frontend Dashboard
```bash
cd frontend
npm install
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Running Tests & Benchmarks

Run backend unit, integration, and performance benchmarks:
```bash
cd backend
python -m pytest tests -s
```

### Measured Performance
- **10 Drones**: ~0.05 ms / tick (~20,000 Hz)
- **50 Drones**: ~0.60 ms / tick (~1,650 Hz)
- **100 Drones**: ~2.08 ms / tick (~480 Hz)
*Well exceeds the 20 Hz (50 ms) real-time requirement.*

---

## Manual Controls
When a drone is selected and switched to `MANUAL` mode:
- **W / S**: Pitch / Forward / Backward
- **A / D**: Roll / Strafe Left / Right
- **Space**: Ascend (Up)
- **Shift**: Descend (Down)
- **Q / E**: Yaw Left / Right
Input is safely clamped, sent continuously at 20 Hz, and released on key-up or focus loss.
