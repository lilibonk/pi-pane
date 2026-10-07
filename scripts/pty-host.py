#!/usr/bin/env python3
"""Small JSON-lines bridge to a real PTY; child configuration arrives on stdin."""
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import subprocess
import sys
import termios


def emit(item):
    print(json.dumps(item), flush=True)


def main():
    control_buffer = b""
    while b"\n" not in control_buffer:
        data = os.read(sys.stdin.fileno(), 65536)
        if not data:
            return
        control_buffer += data
    first_line, control_buffer = control_buffer.split(b"\n", 1)
    config = json.loads(first_line)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 180, 0, 0))
    child = subprocess.Popen(config["argv"], cwd=config["cwd"], env=config["env"],
                             stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    emit({"type": "started", "pid": child.pid})
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ, "pty")
    selector.register(sys.stdin, selectors.EVENT_READ, "control")
    try:
        while child.poll() is None:
            while b"\n" in control_buffer:
                line, control_buffer = control_buffer.split(b"\n", 1)
                command = json.loads(line)
                if command["type"] == "write":
                    os.write(master, command["data"].encode("utf-8"))
                elif command["type"] == "terminate":
                    os.killpg(child.pid, signal.SIGTERM)
            for key, _ in selector.select(0.1):
                if key.data == "pty":
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        data = b""
                    if data:
                        emit({"type": "output", "data": data.decode("utf-8", errors="replace")})
                    else:
                        selector.unregister(master)
                else:
                    data = os.read(sys.stdin.fileno(), 65536)
                    if not data:
                        return
                    # TextIO.readline can prefetch a second command while select
                    # only tracks the fd; that command would wait for later input.
                    control_buffer += data
        emit({"type": "exit", "code": child.returncode})
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        os.close(master)
        selector.close()


if __name__ == "__main__":
    main()
