"""Pure Python implementation of Douyin a_bogus signing.

Ported from the Rust implementation in better-douyin-R/src-tauri/src/sign/mod.rs.
"""

from __future__ import annotations

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
_WINDOW_ENV_STR = "1536|747|1536|834|0|30|0|0|1536|834|1536|864|1525|747|24|24|Win32"


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


def sign(params: str, user_agent: str, args: tuple[int, int, int]) -> str:
    combined = _generate_random_bytes() + _generate_rc4_bb(params, user_agent, args)
    return _custom_base64_encode(combined) + "="


def sign_detail(params: str, user_agent: str) -> str:
    return sign(params, user_agent, (0, 1, 14))


def sign_reply(params: str, user_agent: str) -> str:
    return sign(params, user_agent, (0, 1, 8))
