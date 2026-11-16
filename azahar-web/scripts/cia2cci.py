#!/usr/bin/env python3
"""Turns a homebrew .cia into the formats retail games use: the main NCCH (.cxi) and a cartridge
image (.3ds / CCI, NCSD container with the CXI as partition 0). Only unencrypted contents are
supported (homebrew CIAs); encrypted retail CIAs are rejected.
usage: cia2cci.py input.cia [output_basename]"""
import struct
import sys

MEDIA_UNIT = 0x200


def align(value, to):
    return (value + to - 1) // to * to


SIG_SIZES = {0x010000: 0x200 + 0x3C, 0x010001: 0x100 + 0x3C, 0x010002: 0x3C + 0x40,
             0x010003: 0x200 + 0x3C, 0x010004: 0x100 + 0x3C, 0x010005: 0x3C + 0x40}


def extract_cxi(cia):
    hdr_size, _type, _ver, cert_size, ticket_size, tmd_size, _meta, content_size = struct.unpack_from(
        '<IHHIIIIQ', cia, 0)
    tmd_off = align(hdr_size, 64) + align(cert_size, 64) + align(ticket_size, 64)
    content_off = tmd_off + align(tmd_size, 64)
    sig_type = struct.unpack_from('>I', cia, tmd_off)[0]
    tmd_hdr = tmd_off + 4 + SIG_SIZES[sig_type]
    title_id = struct.unpack_from('>Q', cia, tmd_hdr + 0x4C)[0]
    content_count = struct.unpack_from('>H', cia, tmd_hdr + 0x9E)[0]
    chunks = tmd_hdr + 0xC4 + 0x24 * 64
    offset = content_off
    for i in range(content_count):
        cid, index, ctype, size = struct.unpack_from('>IHHQ', cia, chunks + i * 0x30)
        if index == 0:
            if ctype & 1:
                raise SystemExit('content 0 is encrypted (retail CIA?): not supported')
            cxi = cia[offset:offset + size]
            if cxi[0x100:0x104] != b'NCCH':
                raise SystemExit('content 0 is not an NCCH')
            return title_id, cxi
        offset += align(size, 16)
    raise SystemExit('no content with index 0')


def build_cci(title_id, cxi):
    part_off = 0x4000
    cxi_padded = cxi + b'\0' * (align(len(cxi), MEDIA_UNIT) - len(cxi))
    total = part_off + len(cxi_padded)
    image = bytearray(part_off)
    image[0x100:0x104] = b'NCSD'
    struct.pack_into('<I', image, 0x104, total // MEDIA_UNIT)
    struct.pack_into('<Q', image, 0x108, title_id)          # media id
    struct.pack_into('<II', image, 0x120, part_off // MEDIA_UNIT, len(cxi_padded) // MEDIA_UNIT)
    image[0x188 + 5] = 1                                       # media platform: CTR
    image[0x188 + 6] = 1                                       # media type: CARD1
    image[0x188 + 7] = 0                                       # media unit = 0x200 << 0
    struct.pack_into('<Q', image, 0x190, title_id)            # partition 0 id
    struct.pack_into('<I', image, 0x200, 0xFFFFFFFF)          # card info: writable address (none)
    return bytes(image) + cxi_padded


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    src = sys.argv[1]
    base = sys.argv[2] if len(sys.argv) > 2 else src.rsplit('.', 1)[0]
    with open(src, 'rb') as f:
        cia = f.read()
    title_id, cxi = extract_cxi(cia)
    flags = cxi[0x188:0x190]
    product = cxi[0x150:0x160].split(b'\0')[0].decode(errors='replace')
    print(f'title {title_id:016x} product {product} NCCH {len(cxi)} B '
          f'{"NoCrypto" if flags[7] & 4 else "encrypted"}')
    with open(base + '.cxi', 'wb') as f:
        f.write(cxi)
    with open(base + '.3ds', 'wb') as f:
        f.write(build_cci(title_id, cxi))
    print(f'wrote {base}.cxi and {base}.3ds')


if __name__ == '__main__':
    main()
