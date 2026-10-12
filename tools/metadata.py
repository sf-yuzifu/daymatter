"""Patch fixed Gen2 header metadata without changing resource offsets or format version."""

import struct

DEFAULT_ID = "979825266002"
DEFAULT_VERSION = 1


def patch_metadata(path, watchface_id, version):
    if (
        not watchface_id.isascii()
        or not watchface_id.isdigit()
        or len(watchface_id) not in (9, 12)
    ):
        raise ValueError("Watchface ID must contain 9 or 12 ASCII digits")
    if not 0 <= version <= 0xFFFFFFFF:
        raise ValueError("Version must fit UInt32")
    data = bytearray(path.read_bytes())
    if len(data) < 168 or data[:4] != b"\x5a\xa5\x34\x12":
        raise ValueError("Unexpected Gen2 face header")
    original = bytes(data)
    # ID starts at 40; AstroBox default ID search range ends at 58.
    data[40:58] = watchface_id.encode("ascii").ljust(18, b"\0")
    # Release version at offset 4 is device-verified; offset 16 is the format version.
    struct.pack_into("<I", data, 4, version)
    assert data[8:40] == original[8:40] and data[58:] == original[58:]
    assert len(data) == len(original)
    path.write_bytes(data)
    written = path.read_bytes()
    assert written[40:58].split(b"\0", 1)[0].decode("ascii") == watchface_id
    assert struct.unpack_from("<I", written, 4)[0] == version
