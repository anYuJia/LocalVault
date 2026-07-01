import socket

from src.web.port_utils import find_available_port


def test_find_available_port_skips_occupied_range():
    sockets = []
    try:
        for port in (5001, 5002, 5003):
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", port))
            sock.listen(1)
            sockets.append(sock)

        chosen = find_available_port(start=5001, end=5003)

        assert chosen not in {5001, 5002, 5003}
    finally:
        for sock in sockets:
            sock.close()


def test_find_available_port_respects_excluded_ports():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    chosen = find_available_port(preferred=port, start=port, end=port, exclude={port})

    assert chosen != port
