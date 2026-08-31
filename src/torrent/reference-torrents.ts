/* eslint-disable */
/**
 * Reference torrents built by NATIVE libtorrent 2.0.13, and the fixtures they describe.
 *
 * GENERATED, and deliberately checked in rather than built at test time: the point of a reference is
 * that it was produced by somebody else's implementation, so a copy that regenerates itself from
 * this repo's own code would prove nothing. Rebuilding it needs libtorrent's python bindings, which
 * are not a dependency of this project; the generator lives in the notes for ripple.
 *
 * Each case names the rule it exists to exercise. A case nothing exercises is a case that reports
 * success unconditionally, and every rule below was broken on purpose to confirm the matrix catches
 * it before any of this was written.
 *
 * Content is REGENERATED from `seed` rather than shipped, by `referenceBytes` in the test, so the
 * fixture is kilobytes instead of megabytes.
 */

export type ReferenceCase = {
  name: string
  why: string
  /** The torrent's own `name`: the picked folder, or the picked file. */
  torrentName: string
  pieceLength: number
  /** A picked FILE rather than a folder: the info dict takes the single-file shape. */
  single: boolean
  files: {
    path: string[]
    size: number
    seed: string
    /** What libtorrent computed for this file: `pieces root`, and its `piece layers` entry. */
    root: string | null
    layer: string[]
  }[]
  /** base64 of the whole `.torrent`, as libtorrent emitted it, with `creation date` dropped. */
  torrents: { v1: string, hybrid: string, v2: string }
}

export const REFERENCE_CASES: ReferenceCase[] = [
  {
    "name": "pow2-pieces",
    "torrentName": "Pack",
    "why": "baseline: short file, sub-piece file, exact piece, multi-piece, empty file, unaligned tail",
    "pieceLength": 65536,
    "single": false,
    "files": [
      {
        "path": [
          "a-small.bin"
        ],
        "size": 1000,
        "seed": "pow2-pieces/a-small.bin",
        "root": "6f718e297e046fc53f8a9f09d96b3b7d6b612c21acb3ad787534d4fa22ee4f3a",
        "layer": []
      },
      {
        "path": [
          "b-block-and-a-bit.bin"
        ],
        "size": 20000,
        "seed": "pow2-pieces/b-block-and-a-bit.bin",
        "root": "ef488644614355e883574c8be3a60f0d8d6341e5677125d30dac6923cf95bde6",
        "layer": []
      },
      {
        "path": [
          "nested",
          "c-exact-piece.bin"
        ],
        "size": 65536,
        "seed": "pow2-pieces/nested/c-exact-piece.bin",
        "root": "b63e615ec13e66a1a451d85f6c926e6d2ceaa4d49e4b1bc1fd670930f5fac1fc",
        "layer": []
      },
      {
        "path": [
          "nested",
          "d-many-pieces.bin"
        ],
        "size": 208953,
        "seed": "pow2-pieces/nested/d-many-pieces.bin",
        "root": "73d21fc614b17e03b4a3eeab04610dd16327f0bb3a63b571fc3d0b425ede0363",
        "layer": [
          "07573306c71b5697aa43c5585b8bc49f769b759a0792523600718e6df506e2b6",
          "b283dc6c49e3487e57c8be521d69fc3c793f5254c4d507b1f9bd02a720aaafca",
          "906c2d681c1568278590cef1ffbaad68075d77c0fd52060d9aef694f0b6ab103",
          "4115a3e12b9972f7bbc875c9b8c847320f09c0198488d6419cd58e4bda80440f"
        ]
      },
      {
        "path": [
          "e-empty.bin"
        ],
        "size": 0,
        "seed": "pow2-pieces/e-empty.bin",
        "root": null,
        "layer": []
      },
      {
        "path": [
          "z-tail.bin"
        ],
        "size": 5000,
        "seed": "pow2-pieces/z-tail.bin",
        "root": "b0b767abaad85906b228e149179883a68f526ba93083355a4fd58d4f55f365bd",
        "layer": []
      }
    ],
    "torrents": {
      "v1": "ZDQ6aW5mb2Q1OmZpbGVzbGQ2Omxlbmd0aGkxMDAwZTQ6cGF0aGwxMTphLXNtYWxsLmJpbmVlZDY6bGVuZ3RoaTIwMDAwZTQ6cGF0aGwyMTpiLWJsb2NrLWFuZC1hLWJpdC5iaW5lZWQ2Omxlbmd0aGk2NTUzNmU0OnBhdGhsNjpuZXN0ZWQxNzpjLWV4YWN0LXBpZWNlLmJpbmVlZDY6bGVuZ3RoaTIwODk1M2U0OnBhdGhsNjpuZXN0ZWQxNzpkLW1hbnktcGllY2VzLmJpbmVlZDY6bGVuZ3RoaTBlNDpwYXRobDExOmUtZW1wdHkuYmluZWVkNjpsZW5ndGhpNTAwMGU0OnBhdGhsMTA6ei10YWlsLmJpbmVlZTQ6bmFtZTQ6UGFjazEyOnBpZWNlIGxlbmd0aGk2NTUzNmU2OnBpZWNlczEwMDoQ1zPwjpHX8+1/2hALZxqFDv8fIV5uJ/AwMDaRaieY8kfeMuRXkQ/Z4qlWLeBYPBSe6u9JlLGr3QzviWOg3m7sp2THSZ6uumTwPMUlqLCPl8KgPiRibiz/4CwVdkrsrigyZskGZWU=",
      "hybrid": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQxMTphLXNtYWxsLmJpbmQwOmQ2Omxlbmd0aGkxMDAwZTExOnBpZWNlcyByb290MzI6b3GOKX4Eb8U/ip8J2Ws7fWthLCGss614dTTU+iLuTzplZTIxOmItYmxvY2stYW5kLWEtYml0LmJpbmQwOmQ2Omxlbmd0aGkyMDAwMGUxMTpwaWVjZXMgcm9vdDMyOu9IhkRhQ1Xog1dMi+OmDw2NY0HlZ3El0w2saSPPlb3mZWUxMTplLWVtcHR5LmJpbmQwOmQ2Omxlbmd0aGkwZWVlNjpuZXN0ZWRkMTc6Yy1leGFjdC1waWVjZS5iaW5kMDpkNjpsZW5ndGhpNjU1MzZlMTE6cGllY2VzIHJvb3QzMjq2PmFewT5moaRR2F9skm5tLOqk1J5LG8H9Zwkw9frB/GVlMTc6ZC1tYW55LXBpZWNlcy5iaW5kMDpkNjpsZW5ndGhpMjA4OTUzZTExOnBpZWNlcyByb290MzI6c9IfxhSxfgO0o+6rBGEN0WMn8Ls6Y7Vx/D0LQl7eA2NlZWUxMDp6LXRhaWwuYmluZDA6ZDY6bGVuZ3RoaTUwMDBlMTE6cGllY2VzIHJvb3QzMjqwt2erqthZBrIo4UkXmIOmj1JrqTCDNVpP1Y1PVfNlvWVlZTU6ZmlsZXNsZDY6bGVuZ3RoaTEwMDBlNDpwYXRobDExOmEtc21hbGwuYmluZWVkNDphdHRyMTpwNjpsZW5ndGhpNjQ1MzZlNDpwYXRobDQ6LnBhZDU6NjQ1MzZlZWQ2Omxlbmd0aGkyMDAwMGU0OnBhdGhsMjE6Yi1ibG9jay1hbmQtYS1iaXQuYmluZWVkNDphdHRyMTpwNjpsZW5ndGhpNDU1MzZlNDpwYXRobDQ6LnBhZDU6NDU1MzZlZWQ2Omxlbmd0aGkwZTQ6cGF0aGwxMTplLWVtcHR5LmJpbmVlZDY6bGVuZ3RoaTY1NTM2ZTQ6cGF0aGw2Om5lc3RlZDE3OmMtZXhhY3QtcGllY2UuYmluZWVkNjpsZW5ndGhpMjA4OTUzZTQ6cGF0aGw2Om5lc3RlZDE3OmQtbWFueS1waWVjZXMuYmluZWVkNDphdHRyMTpwNjpsZW5ndGhpNTMxOTFlNDpwYXRobDQ6LnBhZDU6NTMxOTFlZWQ2Omxlbmd0aGk1MDAwZTQ6cGF0aGwxMDp6LXRhaWwuYmluZWVkNDphdHRyMTpwNjpsZW5ndGhpNjA1MzZlNDpwYXRobDQ6LnBhZDU6NjA1MzZlZWUxMjptZXRhIHZlcnNpb25pMmU0Om5hbWU0OlBhY2sxMjpwaWVjZSBsZW5ndGhpNjU1MzZlNjpwaWVjZXMxNjA6uacEv2OiHS+4LRczPui8dAKe9kIFBdlg8zfF8UwdTNiUY2DiQxF91+6O22VvT5+hWDxDG3k0vWTprKJQwJVPEFZ3Z6w7E9QXvbW1KqUmpou4xWF78BFw3Q4MCX26KNaUF4L6dZUMP32zY+U4Rou61+RDugFiGnm3eTsrd6tifWoidHFKBZ0wsFn8zLtNxpUQp+Au0ggOiBwau5k2sZqWeGUxMjpwaWVjZSBsYXllcnNkMzI6c9IfxhSxfgO0o+6rBGEN0WMn8Ls6Y7Vx/D0LQl7eA2MxMjg6B1czBscbVpeqQ8VYW4vEn3abdZoHklI2AHGObfUG4rayg9xsSeNIflfIvlIdafw8eT9SVMTVB7H5vQKnIKqvypBsLWgcFWgnhZDO8f+6rWgHXXfA/VIGDZrvaU8LarEDQRWj4SuZcve7yHXJuMhHMg8JwBmEiNZBnNWOS9qARA9lZQ==",
      "v2": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQxMTphLXNtYWxsLmJpbmQwOmQ2Omxlbmd0aGkxMDAwZTExOnBpZWNlcyByb290MzI6b3GOKX4Eb8U/ip8J2Ws7fWthLCGss614dTTU+iLuTzplZTIxOmItYmxvY2stYW5kLWEtYml0LmJpbmQwOmQ2Omxlbmd0aGkyMDAwMGUxMTpwaWVjZXMgcm9vdDMyOu9IhkRhQ1Xog1dMi+OmDw2NY0HlZ3El0w2saSPPlb3mZWUxMTplLWVtcHR5LmJpbmQwOmQ2Omxlbmd0aGkwZWVlNjpuZXN0ZWRkMTc6Yy1leGFjdC1waWVjZS5iaW5kMDpkNjpsZW5ndGhpNjU1MzZlMTE6cGllY2VzIHJvb3QzMjq2PmFewT5moaRR2F9skm5tLOqk1J5LG8H9Zwkw9frB/GVlMTc6ZC1tYW55LXBpZWNlcy5iaW5kMDpkNjpsZW5ndGhpMjA4OTUzZTExOnBpZWNlcyByb290MzI6c9IfxhSxfgO0o+6rBGEN0WMn8Ls6Y7Vx/D0LQl7eA2NlZWUxMDp6LXRhaWwuYmluZDA6ZDY6bGVuZ3RoaTUwMDBlMTE6cGllY2VzIHJvb3QzMjqwt2erqthZBrIo4UkXmIOmj1JrqTCDNVpP1Y1PVfNlvWVlZTEyOm1ldGEgdmVyc2lvbmkyZTQ6bmFtZTQ6UGFjazEyOnBpZWNlIGxlbmd0aGk2NTUzNmVlMTI6cGllY2UgbGF5ZXJzZDMyOnPSH8YUsX4DtKPuqwRhDdFjJ/C7OmO1cfw9C0Je3gNjMTI4OgdXMwbHG1aXqkPFWFuLxJ92m3WaB5JSNgBxjm31BuK2soPcbEnjSH5XyL5SHWn8PHk/UlTE1Qex+b0CpyCqr8qQbC1oHBVoJ4WQzvH/uq1oB113wP1SBg2a72lPC2qxA0EVo+ErmXL3u8h1ybjIRzIPCcAZhIjWQZzVjkvagEQPZWU="
    }
  },
  {
    "name": "odd-piece-counts",
    "torrentName": "Pack",
    "why": "THE PIECE-LEVEL PAD HASH. Every file here has a non-power-of-two piece count",
    "pieceLength": 65536,
    "single": false,
    "files": [
      {
        "path": [
          "three-pieces.bin"
        ],
        "size": 131073,
        "seed": "odd-piece-counts/three-pieces.bin",
        "root": "8db72418059eea9e5014855ae4faef42b5fd965e11b4c1b1302eba868a84152c",
        "layer": [
          "c85a37ee55269c8e49c8cb49303f986f2c600a0cead4524ceea44233d78b8972",
          "9a736e427b4896d4ffc921f8f8ac0a78b31290d8d920e98920ace5a36d06657d",
          "1c268d70a991e69eca05da13acd27dbe9e467832ece5102359f5abd6a481e994"
        ]
      },
      {
        "path": [
          "five-pieces.bin"
        ],
        "size": 262151,
        "seed": "odd-piece-counts/five-pieces.bin",
        "root": "505273c8365fb1689fbeb9484a32222457e1e911464ccfabeb598ce12dacd751",
        "layer": [
          "f6a6e006b37740dec2dbb5bf552691e4a4fee9e35437057dfaab36a7fab1b016",
          "ac039a84e46f48df5b241b4ddd4777b2e6ad474678f29855d7e02d678ad41d62",
          "b3ebe40361cc12021f950c5d38a0a32d32ec70e95a95c576d1f2b52d26a6dcce",
          "dea0c8f3e7ec8ec19866999cfd7929aa85bae0b22af48c74cf598fc55e38bdf4",
          "b694cc926fad3d6551c8b1aeb9490046aaee220db155f62f372f25ece677cdc9"
        ]
      },
      {
        "path": [
          "seven-pieces.bin"
        ],
        "size": 458751,
        "seed": "odd-piece-counts/seven-pieces.bin",
        "root": "1af6c8c8ed9e0c7935662e4ead10b936b203ff3e951737ae3944d109a6e62879",
        "layer": [
          "93d349ecb4ae91e00529a44b3ccace7e040fe3baccc418c4b7188ff2ac83a702",
          "7ec1cbb38dd12a1d010314965bf335fcffd15e9c61957a887548ac309b997d18",
          "52bfc801349dd2dca935ad25def0353739e13e6c0397d4cf99ebe76814230070",
          "22fcf02a38db0d8b6ad9be0f3815065c1338599e3660efd5383b1e4aabc3cc14",
          "7035362c4bd1e99cd43a12bd2aab55f99e949f64ec5278fde8df3abe57c0bbba",
          "d57e44ad7f9092cba36332c153ffac75597fc5958041aa82341b5e4c5e698c16",
          "248de5cc7f0967d777f37e8a064f03939f7434734789d4a7d80594e592e09364"
        ]
      }
    ],
    "torrents": {
      "v1": "ZDQ6aW5mb2Q1OmZpbGVzbGQ2Omxlbmd0aGkxMzEwNzNlNDpwYXRobDE2OnRocmVlLXBpZWNlcy5iaW5lZWQ2Omxlbmd0aGkyNjIxNTFlNDpwYXRobDE1OmZpdmUtcGllY2VzLmJpbmVlZDY6bGVuZ3RoaTQ1ODc1MWU0OnBhdGhsMTY6c2V2ZW4tcGllY2VzLmJpbmVlZTQ6bmFtZTQ6UGFjazEyOnBpZWNlIGxlbmd0aGk2NTUzNmU2OnBpZWNlczI4MDpNXDjyy5z4GTa8wPfk17GGLe/UUCvUO9dudPfIKrrnvB5R96qzGca4/zLvg1k/2SnU10QOtLCQyaqX15yQglJTDMfwnBWN0CqdEVeIAsRcmV8Nj8qjRQVQB3gpEC/gFW5+hVn8dHyPw//KEyp9tzgpb5NEkiWMiuHXar8Dup1sn4JsRumBdueNhD5O2sjMJH4vlFfmyn8msOnki0IY4mRXR13NbqDQQ0gv6nIyGWxVbyVrm7tWH4u35z8w67QAWxNYiHA/Mxnn/v8hQ1tgHRUFhxKaAtis4fIeGuNqkmtbmcpBf5WTNw3u1o7HVUCDwYsZ0kSgO2rkuWqgmUFI1fbhAGpUOZp7mmoSROLOpy3PRVt6kM2pTRMCZWU=",
      "hybrid": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQxNTpmaXZlLXBpZWNlcy5iaW5kMDpkNjpsZW5ndGhpMjYyMTUxZTExOnBpZWNlcyByb290MzI6UFJzyDZfsWifvrlISjIiJFfh6RFGTM+r61mM4S2s11FlZTE2OnNldmVuLXBpZWNlcy5iaW5kMDpkNjpsZW5ndGhpNDU4NzUxZTExOnBpZWNlcyByb290MzI6GvbIyO2eDHk1Zi5OrRC5NrID/z6VFzeuOUTRCabmKHllZTE2OnRocmVlLXBpZWNlcy5iaW5kMDpkNjpsZW5ndGhpMTMxMDczZTExOnBpZWNlcyByb290MzI6jbckGAWe6p5QFIVa5PrvQrX9ll4RtMGxMC66hoqEFSxlZWU1OmZpbGVzbGQ2Omxlbmd0aGkyNjIxNTFlNDpwYXRobDE1OmZpdmUtcGllY2VzLmJpbmVlZDQ6YXR0cjE6cDY6bGVuZ3RoaTY1NTI5ZTQ6cGF0aGw0Oi5wYWQ1OjY1NTI5ZWVkNjpsZW5ndGhpNDU4NzUxZTQ6cGF0aGwxNjpzZXZlbi1waWVjZXMuYmluZWVkNDphdHRyMTpwNjpsZW5ndGhpMWU0OnBhdGhsNDoucGFkMToxZWVkNjpsZW5ndGhpMTMxMDczZTQ6cGF0aGwxNjp0aHJlZS1waWVjZXMuYmluZWVkNDphdHRyMTpwNjpsZW5ndGhpNjU1MzVlNDpwYXRobDQ6LnBhZDU6NjU1MzVlZWUxMjptZXRhIHZlcnNpb25pMmU0Om5hbWU0OlBhY2sxMjpwaWVjZSBsZW5ndGhpNjU1MzZlNjpwaWVjZXMzMDA6oYvy6HMmc4htCQu7nFF4kXDUPMe+9uhyyAsewUMWFmH+6mqAjgQabqU1JusI2wX1ZIY8JSzyDBzN2ghTwLlQ4X4FmpdZcbMSXSlmkCQK77QHGPUBALntVjlMIgaSsI9fwdOPpHCUWN5pr3ykWncwvyvBs7K8C9ov1jRtArfzoYxQ6vMEnvl5S6YTIQhLLTsZxmabI75183H4t9vYez+2xOya7j3AaT11w9teL8dSTAVkFyc0xpyO+GzZsDGb3R0kuSYpEKDdbogOMkeO67W6HcTId5DwHIdFF1YHveMRs04g3oFH4bp8MRxn5eGUisrxTVw48suc+Bk2vMD35Nexhi3v1FAr1DvXbnT3yCq657weUfeqsxnGuE7WbCIltIUjOJvyMXb9L0RwGrcdZTEyOnBpZWNlIGxheWVyc2QzMjoa9sjI7Z4MeTVmLk6tELk2sgP/PpUXN645RNEJpuYoeTIyNDqT00nstK6R4AUppEs8ys5+BA/juszEGMS3GI/yrIOnAn7By7ON0SodAQMUllvzNfz/0V6cYZV6iHVIrDCbmX0YUr/IATSd0typNa0l3vA1NznhPmwDl9TPmevnaBQjAHAi/PAqONsNi2rZvg84FQZcEzhZnjZg79U4Ox5Kq8PMFHA1NixL0emc1DoSvSqrVfmelJ9k7FJ4/ejfOr5XwLu61X5ErX+QksujYzLBU/+sdVl/xZWAQaqCNBteTF5pjBYkjeXMfwln13fzfooGTwOTn3Q0c0eJ1KfYBZTlkuCTZDMyOlBSc8g2X7Fon765SEoyIiRX4ekRRkzPq+tZjOEtrNdRMTYwOvam4Aazd0Dewtu1v1UmkeSk/unjVDcFffqrNqf6sbAWrAOahORvSN9bJBtN3Ud3suatR0Z48phV1+AtZ4rUHWKz6+QDYcwSAh+VDF04oKMtMuxw6VqVxXbR8rUtJqbczt6gyPPn7I7BmGaZnP15KaqFuuCyKvSMdM9Zj8VeOL30tpTMkm+tPWVRyLGuuUkARqruIg2xVfYvNy8l7OZ3zckzMjqNtyQYBZ7qnlAUhVrk+u9Ctf2WXhG0wbEwLrqGioQVLDk2OshaN+5VJpyOScjLSTA/mG8sYAoM6tRSTO6kQjPXi4lymnNuQntIltT/ySH4+KwKeLMSkNjZIOmJIKzlo20GZX0cJo1wqZHmnsoF2hOs0n2+nkZ4MuzlECNZ9avWpIHplGVl",
      "v2": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQxNTpmaXZlLXBpZWNlcy5iaW5kMDpkNjpsZW5ndGhpMjYyMTUxZTExOnBpZWNlcyByb290MzI6UFJzyDZfsWifvrlISjIiJFfh6RFGTM+r61mM4S2s11FlZTE2OnNldmVuLXBpZWNlcy5iaW5kMDpkNjpsZW5ndGhpNDU4NzUxZTExOnBpZWNlcyByb290MzI6GvbIyO2eDHk1Zi5OrRC5NrID/z6VFzeuOUTRCabmKHllZTE2OnRocmVlLXBpZWNlcy5iaW5kMDpkNjpsZW5ndGhpMTMxMDczZTExOnBpZWNlcyByb290MzI6jbckGAWe6p5QFIVa5PrvQrX9ll4RtMGxMC66hoqEFSxlZWUxMjptZXRhIHZlcnNpb25pMmU0Om5hbWU0OlBhY2sxMjpwaWVjZSBsZW5ndGhpNjU1MzZlZTEyOnBpZWNlIGxheWVyc2QzMjoa9sjI7Z4MeTVmLk6tELk2sgP/PpUXN645RNEJpuYoeTIyNDqT00nstK6R4AUppEs8ys5+BA/juszEGMS3GI/yrIOnAn7By7ON0SodAQMUllvzNfz/0V6cYZV6iHVIrDCbmX0YUr/IATSd0typNa0l3vA1NznhPmwDl9TPmevnaBQjAHAi/PAqONsNi2rZvg84FQZcEzhZnjZg79U4Ox5Kq8PMFHA1NixL0emc1DoSvSqrVfmelJ9k7FJ4/ejfOr5XwLu61X5ErX+QksujYzLBU/+sdVl/xZWAQaqCNBteTF5pjBYkjeXMfwln13fzfooGTwOTn3Q0c0eJ1KfYBZTlkuCTZDMyOlBSc8g2X7Fon765SEoyIiRX4ekRRkzPq+tZjOEtrNdRMTYwOvam4Aazd0Dewtu1v1UmkeSk/unjVDcFffqrNqf6sbAWrAOahORvSN9bJBtN3Ud3suatR0Z48phV1+AtZ4rUHWKz6+QDYcwSAh+VDF04oKMtMuxw6VqVxXbR8rUtJqbczt6gyPPn7I7BmGaZnP15KaqFuuCyKvSMdM9Zj8VeOL30tpTMkm+tPWVRyLGuuUkARqruIg2xVfYvNy8l7OZ3zckzMjqNtyQYBZ7qnlAUhVrk+u9Ctf2WXhG0wbEwLrqGioQVLDk2OshaN+5VJpyOScjLSTA/mG8sYAoM6tRSTO6kQjPXi4lymnNuQntIltT/ySH4+KwKeLMSkNjZIOmJIKzlo20GZX0cJo1wqZHmnsoF2hOs0n2+nkZ4MuzlECNZ9avWpIHplGVl"
    }
  },
  {
    "name": "min-piece-length",
    "torrentName": "Pack",
    "why": "blocksPerPiece is 1, so the piece layer IS the leaf layer and the pad hash degenerates",
    "pieceLength": 16384,
    "single": false,
    "files": [
      {
        "path": [
          "a.bin"
        ],
        "size": 1000,
        "seed": "min-piece-length/a.bin",
        "root": "7b2ae3124cef0e0626db23ba9190cc933d18dd7ecfc43e4e271357a0b5f307d1",
        "layer": []
      },
      {
        "path": [
          "b.bin"
        ],
        "size": 81923,
        "seed": "min-piece-length/b.bin",
        "root": "9d42b4bc6b204c0a6a1c76102109a953086a62382170d927ae09a9fa2900584a",
        "layer": [
          "20d5499e0ef557f98aadc7a1c85a3420f1ccd47cfed515364e5618dfe700e6e9",
          "55c3165d70a37fa524b8847389474343cf9173d669d75b6019940f3c957c69f1",
          "cecc9b0aee4684184f7639a1a6b2e63b49cb99bbba017de9db53c810878229cb",
          "c407a3b569e40a176765bf50426d4ac7cdfc892a7102b8ebed4962ca92b33d69",
          "a8c1000df4bc30738975d7d0d6bc9404c9a424d6b38715c811cd0f6d46f60e7a",
          "1ee497163bc4c80fd91cef57d7316683ec98f1429202950f9a48d32464fd53a4"
        ]
      }
    ],
    "torrents": {
      "v1": "ZDQ6aW5mb2Q1OmZpbGVzbGQ2Omxlbmd0aGkxMDAwZTQ6cGF0aGw1OmEuYmluZWVkNjpsZW5ndGhpODE5MjNlNDpwYXRobDU6Yi5iaW5lZWU0Om5hbWU0OlBhY2sxMjpwaWVjZSBsZW5ndGhpMTYzODRlNjpwaWVjZXMxMjA6ON41dEdq5i21Ct8joKyLvujdFcI2mRISm7yMwKBlIRTGbhjE17YphXQLzWzmQ49KDdyDgXFyfXpVrN8fi5cuw9k81AoMDnqueseTSFI7u31l21gBLHqeOsMxSUhWgvdWQCb8OOXsGMnFIPCPBtjxyNilGBF9OgJdZWU=",
      "hybrid": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ1OmEuYmluZDA6ZDY6bGVuZ3RoaTEwMDBlMTE6cGllY2VzIHJvb3QzMjp7KuMSTO8OBibbI7qRkMyTPRjdfs/EPk4nE1egtfMH0WVlNTpiLmJpbmQwOmQ2Omxlbmd0aGk4MTkyM2UxMTpwaWVjZXMgcm9vdDMyOp1CtLxrIEwKahx2ECEJqVMIamI4IXDZJ64JqfopAFhKZWVlNTpmaWxlc2xkNjpsZW5ndGhpMTAwMGU0OnBhdGhsNTphLmJpbmVlZDQ6YXR0cjE6cDY6bGVuZ3RoaTE1Mzg0ZTQ6cGF0aGw0Oi5wYWQ1OjE1Mzg0ZWVkNjpsZW5ndGhpODE5MjNlNDpwYXRobDU6Yi5iaW5lZWQ0OmF0dHIxOnA2Omxlbmd0aGkxNjM4MWU0OnBhdGhsNDoucGFkNToxNjM4MWVlZTEyOm1ldGEgdmVyc2lvbmkyZTQ6bmFtZTQ6UGFjazEyOnBpZWNlIGxlbmd0aGkxNjM4NGU2OnBpZWNlczE0MDosUjI3whULQ+Gi1eSptBB2z9ulhC3/ZzsW0c+K8nesddrJnzFe5cS//ZCpInmIVzkCu0YIaYsRpK1AUT2TghIpoVR5gHWJty6VFj7ziGuyL786ZU76fk+DbcxoVz3tdFvDaTL8Tj8fW0NpoGU3iuV5HEV3J2KDiuk5jOCSbZOCuiseEaPptVIa904uNWUxMjpwaWVjZSBsYXllcnNkMzI6nUK0vGsgTApqHHYQIQmpUwhqYjghcNknrgmp+ikAWEoxOTI6INVJng71V/mKrcehyFo0IPHM1Hz+1RU2TlYY3+cA5ulVwxZdcKN/pSS4hHOJR0NDz5Fz1mnXW2AZlA88lXxp8c7MmwruRoQYT3Y5oaay5jtJy5m7ugF96dtTyBCHginLxAejtWnkChdnZb9QQm1Kx838iSpxArjr7UliypKzPWmowQAN9Lwwc4l119DWvJQEyaQk1rOHFcgRzQ9tRvYOeh7klxY7xMgP2RzvV9cxZoPsmPFCkgKVD5pI0yRk/VOkZWU=",
      "v2": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ1OmEuYmluZDA6ZDY6bGVuZ3RoaTEwMDBlMTE6cGllY2VzIHJvb3QzMjp7KuMSTO8OBibbI7qRkMyTPRjdfs/EPk4nE1egtfMH0WVlNTpiLmJpbmQwOmQ2Omxlbmd0aGk4MTkyM2UxMTpwaWVjZXMgcm9vdDMyOp1CtLxrIEwKahx2ECEJqVMIamI4IXDZJ64JqfopAFhKZWVlMTI6bWV0YSB2ZXJzaW9uaTJlNDpuYW1lNDpQYWNrMTI6cGllY2UgbGVuZ3RoaTE2Mzg0ZWUxMjpwaWVjZSBsYXllcnNkMzI6nUK0vGsgTApqHHYQIQmpUwhqYjghcNknrgmp+ikAWEoxOTI6INVJng71V/mKrcehyFo0IPHM1Hz+1RU2TlYY3+cA5ulVwxZdcKN/pSS4hHOJR0NDz5Fz1mnXW2AZlA88lXxp8c7MmwruRoQYT3Y5oaay5jtJy5m7ugF96dtTyBCHginLxAejtWnkChdnZb9QQm1Kx838iSpxArjr7UliypKzPWmowQAN9Lwwc4l119DWvJQEyaQk1rOHFcgRzQ9tRvYOeh7klxY7xMgP2RzvV9cxZoPsmPFCkgKVD5pI0yRk/VOkZWU="
    }
  },
  {
    "name": "big-piece-length",
    "torrentName": "Pack",
    "why": "blocksPerPiece is 64, so the leaf-vs-piece padding rules differ the most",
    "pieceLength": 1048576,
    "single": false,
    "files": [
      {
        "path": [
          "small.bin"
        ],
        "size": 100,
        "seed": "big-piece-length/small.bin",
        "root": "0da32fd6609455ccbf7a3e3fe46a5368694cea1928d981941e702189d27568bc",
        "layer": []
      },
      {
        "path": [
          "mid.bin"
        ],
        "size": 307200,
        "seed": "big-piece-length/mid.bin",
        "root": "1e2a29e202fc6e270faf9c8c5e55d78ecc3122fe4267c75148cfdcc213a166d7",
        "layer": []
      },
      {
        "path": [
          "big.bin"
        ],
        "size": 2097157,
        "seed": "big-piece-length/big.bin",
        "root": "806f297e8c42fc3e480b9753025fc489681e0abab8b0675879f659bb26c7441d",
        "layer": [
          "a3e7f80cc4be3193e54c71f1c6b9f7c84757602b05674dba4a80d147ad87605c",
          "d87351211a411e4201cf0d5c247a6afb67794197fd31334eb4d5eaab3eb68d70",
          "30026d6b6f61d9693f10b8a80fbdd985d2f9db13a7e8b0615b34e3e586965879"
        ]
      }
    ],
    "torrents": {
      "v1": "ZDQ6aW5mb2Q1OmZpbGVzbGQ2Omxlbmd0aGkxMDBlNDpwYXRobDk6c21hbGwuYmluZWVkNjpsZW5ndGhpMzA3MjAwZTQ6cGF0aGw3Om1pZC5iaW5lZWQ2Omxlbmd0aGkyMDk3MTU3ZTQ6cGF0aGw3OmJpZy5iaW5lZWU0Om5hbWU0OlBhY2sxMjpwaWVjZSBsZW5ndGhpMTA0ODU3NmU2OnBpZWNlczYwOj5auZYbPoHB/JFOkhej1KUQ9wyY691JG5a2apAhXj3LbT8j24hRwPmzTlkEsaQNdZelXrg/8f6RorA96mVl",
      "hybrid": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ3OmJpZy5iaW5kMDpkNjpsZW5ndGhpMjA5NzE1N2UxMTpwaWVjZXMgcm9vdDMyOoBvKX6MQvw+SAuXUwJfxIloHgq6uLBnWHn2Wbsmx0QdZWU3Om1pZC5iaW5kMDpkNjpsZW5ndGhpMzA3MjAwZTExOnBpZWNlcyByb290MzI6Hiop4gL8bicPr5yMXlXXjswxIv5CZ8dRSM/cwhOhZtdlZTk6c21hbGwuYmluZDA6ZDY6bGVuZ3RoaTEwMGUxMTpwaWVjZXMgcm9vdDMyOg2jL9ZglFXMv3o+P+RqU2hpTOoZKNmBlB5wIYnSdWi8ZWVlNTpmaWxlc2xkNjpsZW5ndGhpMjA5NzE1N2U0OnBhdGhsNzpiaWcuYmluZWVkNDphdHRyMTpwNjpsZW5ndGhpMTA0ODU3MWU0OnBhdGhsNDoucGFkNzoxMDQ4NTcxZWVkNjpsZW5ndGhpMzA3MjAwZTQ6cGF0aGw3Om1pZC5iaW5lZWQ0OmF0dHIxOnA2Omxlbmd0aGk3NDEzNzZlNDpwYXRobDQ6LnBhZDY6NzQxMzc2ZWVkNjpsZW5ndGhpMTAwZTQ6cGF0aGw5OnNtYWxsLmJpbmVlZDQ6YXR0cjE6cDY6bGVuZ3RoaTEwNDg0NzZlNDpwYXRobDQ6LnBhZDc6MTA0ODQ3NmVlZTEyOm1ldGEgdmVyc2lvbmkyZTQ6bmFtZTQ6UGFjazEyOnBpZWNlIGxlbmd0aGkxMDQ4NTc2ZTY6cGllY2VzMTAwOqxUjwiEk6+CVsUbCjANQM6BTn622iMD2GBJH/anoRnV6No4fiXl55pVbIHTsGCWXDI35yOQVMQy+7fG4etk/fVeUJOIEDwN87CXK52Ps3f+YuhjiDPDzhcrhdL+7yu79jP7kP9lMTI6cGllY2UgbGF5ZXJzZDMyOoBvKX6MQvw+SAuXUwJfxIloHgq6uLBnWHn2Wbsmx0QdOTY6o+f4DMS+MZPlTHHxxrn3yEdXYCsFZ026SoDRR62HYFzYc1EhGkEeQgHPDVwkemr7Z3lBl/0xM0601eqrPraNcDACbWtvYdlpPxC4qA+92YXS+dsTp+iwYVs04+WGllh5ZWU=",
      "v2": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ3OmJpZy5iaW5kMDpkNjpsZW5ndGhpMjA5NzE1N2UxMTpwaWVjZXMgcm9vdDMyOoBvKX6MQvw+SAuXUwJfxIloHgq6uLBnWHn2Wbsmx0QdZWU3Om1pZC5iaW5kMDpkNjpsZW5ndGhpMzA3MjAwZTExOnBpZWNlcyByb290MzI6Hiop4gL8bicPr5yMXlXXjswxIv5CZ8dRSM/cwhOhZtdlZTk6c21hbGwuYmluZDA6ZDY6bGVuZ3RoaTEwMGUxMTpwaWVjZXMgcm9vdDMyOg2jL9ZglFXMv3o+P+RqU2hpTOoZKNmBlB5wIYnSdWi8ZWVlMTI6bWV0YSB2ZXJzaW9uaTJlNDpuYW1lNDpQYWNrMTI6cGllY2UgbGVuZ3RoaTEwNDg1NzZlZTEyOnBpZWNlIGxheWVyc2QzMjqAbyl+jEL8PkgLl1MCX8SJaB4KuriwZ1h59lm7JsdEHTk2OqPn+AzEvjGT5Uxx8ca598hHV2ArBWdNukqA0Ueth2Bc2HNRIRpBHkIBzw1cJHpq+2d5QZf9MTNOtNXqqz62jXAwAm1rb2HZaT8QuKgPvdmF0vnbE6fosGFbNOPlhpZYeWVl"
    }
  },
  {
    "name": "sort-order",
    "torrentName": "Pack",
    "why": "FILE ORDER: names where a naive joined-path sort gives a different answer",
    "pieceLength": 65536,
    "single": false,
    "files": [
      {
        "path": [
          "a",
          "b.bin"
        ],
        "size": 100,
        "seed": "sort-order/a/b.bin",
        "root": "0bc570e6fcbb3248e960aa7b7ba4f3969952bc95d587637b64fcfff582e5cdec",
        "layer": []
      },
      {
        "path": [
          "a.b.bin"
        ],
        "size": 100,
        "seed": "sort-order/a.b.bin",
        "root": "17f645e7c20c9db475eeb27a9c495431968d8f159ba062ea1ef84176f8595131",
        "layer": []
      },
      {
        "path": [
          "a!.bin"
        ],
        "size": 100,
        "seed": "sort-order/a!.bin",
        "root": "1f072b158024f842839cb55103f2a44626f3974e95c70c19eb192c45185d9a7b",
        "layer": []
      },
      {
        "path": [
          "B.bin"
        ],
        "size": 100,
        "seed": "sort-order/B.bin",
        "root": "2161c68f5b5bb91c93d9e5b9c570177b55d4d733f1afb66eeb3cb6d388077be3",
        "layer": []
      },
      {
        "path": [
          "a",
          "a.bin"
        ],
        "size": 100,
        "seed": "sort-order/a/a.bin",
        "root": "50c19ff32d64ca4ad6fe4af81d5b1566e686865261dca812e6ca7b2815e27a02",
        "layer": []
      }
    ],
    "torrents": {
      "v1": "ZDQ6aW5mb2Q1OmZpbGVzbGQ2Omxlbmd0aGkxMDBlNDpwYXRobDE6YTU6Yi5iaW5lZWQ2Omxlbmd0aGkxMDBlNDpwYXRobDE6YTU6YS5iaW5lZWQ2Omxlbmd0aGkxMDBlNDpwYXRobDc6YS5iLmJpbmVlZDY6bGVuZ3RoaTEwMGU0OnBhdGhsNjphIS5iaW5lZWQ2Omxlbmd0aGkxMDBlNDpwYXRobDU6Qi5iaW5lZWU0Om5hbWU0OlBhY2sxMjpwaWVjZSBsZW5ndGhpNjU1MzZlNjpwaWVjZXMyMDoHmIyvqFzMhv/9tvw9aRAi5fEDKWVl",
      "hybrid": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ1OkIuYmluZDA6ZDY6bGVuZ3RoaTEwMGUxMTpwaWVjZXMgcm9vdDMyOiFhxo9bW7kck9nlucVwF3tV1Ncz8a+2bus8ttOIB3vjZWUxOmFkNTphLmJpbmQwOmQ2Omxlbmd0aGkxMDBlMTE6cGllY2VzIHJvb3QzMjpQwZ/zLWTKStb+SvgdWxVm5oaGUmHcqBLmynsoFeJ6AmVlNTpiLmJpbmQwOmQ2Omxlbmd0aGkxMDBlMTE6cGllY2VzIHJvb3QzMjoLxXDm/LsySOlgqnt7pPOWmVK8ldWHY3tk/P/1guXN7GVlZTY6YSEuYmluZDA6ZDY6bGVuZ3RoaTEwMGUxMTpwaWVjZXMgcm9vdDMyOh8HKxWAJPhCg5y1UQPypEYm85dOlccMGesZLEUYXZp7ZWU3OmEuYi5iaW5kMDpkNjpsZW5ndGhpMTAwZTExOnBpZWNlcyByb290MzI6F/ZF58IMnbR17rJ6nElUMZaNjxWboGLqHvhBdvhZUTFlZWU1OmZpbGVzbGQ2Omxlbmd0aGkxMDBlNDpwYXRobDU6Qi5iaW5lZWQ0OmF0dHIxOnA2Omxlbmd0aGk2NTQzNmU0OnBhdGhsNDoucGFkNTo2NTQzNmVlZDY6bGVuZ3RoaTEwMGU0OnBhdGhsMTphNTphLmJpbmVlZDQ6YXR0cjE6cDY6bGVuZ3RoaTY1NDM2ZTQ6cGF0aGw0Oi5wYWQ1OjY1NDM2ZWVkNjpsZW5ndGhpMTAwZTQ6cGF0aGwxOmE1OmIuYmluZWVkNDphdHRyMTpwNjpsZW5ndGhpNjU0MzZlNDpwYXRobDQ6LnBhZDU6NjU0MzZlZWQ2Omxlbmd0aGkxMDBlNDpwYXRobDY6YSEuYmluZWVkNDphdHRyMTpwNjpsZW5ndGhpNjU0MzZlNDpwYXRobDQ6LnBhZDU6NjU0MzZlZWQ2Omxlbmd0aGkxMDBlNDpwYXRobDc6YS5iLmJpbmVlZDQ6YXR0cjE6cDY6bGVuZ3RoaTY1NDM2ZTQ6cGF0aGw0Oi5wYWQ1OjY1NDM2ZWVlMTI6bWV0YSB2ZXJzaW9uaTJlNDpuYW1lNDpQYWNrMTI6cGllY2UgbGVuZ3RoaTY1NTM2ZTY6cGllY2VzMTAwOmmtMBycpRy0anxONrab/epTJ6kebq5wR6NJy7Edy1948HdwIXPn2N5XKdgopOuId5iwBllgYu/o9X0PGdERh9YcRy2X6XxG6wuxW/TGHgt5McFK7bwCakup00QiGZG5mfWQuOhlMTI6cGllY2UgbGF5ZXJzZGVl",
      "v2": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ1OkIuYmluZDA6ZDY6bGVuZ3RoaTEwMGUxMTpwaWVjZXMgcm9vdDMyOiFhxo9bW7kck9nlucVwF3tV1Ncz8a+2bus8ttOIB3vjZWUxOmFkNTphLmJpbmQwOmQ2Omxlbmd0aGkxMDBlMTE6cGllY2VzIHJvb3QzMjpQwZ/zLWTKStb+SvgdWxVm5oaGUmHcqBLmynsoFeJ6AmVlNTpiLmJpbmQwOmQ2Omxlbmd0aGkxMDBlMTE6cGllY2VzIHJvb3QzMjoLxXDm/LsySOlgqnt7pPOWmVK8ldWHY3tk/P/1guXN7GVlZTY6YSEuYmluZDA6ZDY6bGVuZ3RoaTEwMGUxMTpwaWVjZXMgcm9vdDMyOh8HKxWAJPhCg5y1UQPypEYm85dOlccMGesZLEUYXZp7ZWU3OmEuYi5iaW5kMDpkNjpsZW5ndGhpMTAwZTExOnBpZWNlcyByb290MzI6F/ZF58IMnbR17rJ6nElUMZaNjxWboGLqHvhBdvhZUTFlZWUxMjptZXRhIHZlcnNpb25pMmU0Om5hbWU0OlBhY2sxMjpwaWVjZSBsZW5ndGhpNjU1MzZlZTEyOnBpZWNlIGxheWVyc2RlZQ=="
    }
  },
  {
    "name": "single-file",
    "torrentName": "movie.mkv",
    "why": "a picked FILE rather than a folder: no `files` list, and pads around a single file",
    "pieceLength": 65536,
    "single": true,
    "files": [
      {
        "path": [
          "movie.mkv"
        ],
        "size": 132071,
        "seed": "single-file/movie.mkv",
        "root": "f935afdacfaa325a007b965cd20b2e92ad1b81ebc73e8270be88538bfbd27cbd",
        "layer": [
          "8fe2413064d5b18875649a3acc9b20f0b7db8fe9ec435bdceab9146f21b282e3",
          "e215c512542cf8df25b69b9ff055f9480e93a6de166d859692dab411c6b2d9e1",
          "f29bb329c89b69d7e2c3c8b26aff63831d49b265259616a01c6f78aedb36fb2d"
        ]
      }
    ],
    "torrents": {
      "v1": "ZDQ6aW5mb2Q2Omxlbmd0aGkxMzIwNzFlNDpuYW1lOTptb3ZpZS5ta3YxMjpwaWVjZSBsZW5ndGhpNjU1MzZlNjpwaWVjZXM2MDr0/qusinvpwJrEsV3bVkO/x8rSsN0Yxi7LrUhk+Zur3DEiyjsjR+THaMxqajVYvZ8FmPNQEIdomM66HbRlZQ==",
      "hybrid": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ5Om1vdmllLm1rdmQwOmQ2Omxlbmd0aGkxMzIwNzFlMTE6cGllY2VzIHJvb3QzMjr5Na/az6oyWgB7llzSCy6SrRuB68c+gnC+iFOL+9J8vWVlZTY6bGVuZ3RoaTEzMjA3MWUxMjptZXRhIHZlcnNpb25pMmU0Om5hbWU5Om1vdmllLm1rdjEyOnBpZWNlIGxlbmd0aGk2NTUzNmU2OnBpZWNlczYwOvT+q6yKe+nAmsSxXdtWQ7/HytKw3RjGLsutSGT5m6vcMSLKOyNH5MdozGpqNVi9nwWY81AQh2iYzrodtGUxMjpwaWVjZSBsYXllcnNkMzI6+TWv2s+qMloAe5Zc0gsukq0bgevHPoJwvohTi/vSfL05NjqP4kEwZNWxiHVkmjrMmyDwt9uP6exDW9zquRRvIbKC4+IVxRJULPjfJbabn/BV+UgOk6beFm2FlpLatBHGstnh8puzKcibadfiw8iyav9jgx1JsmUllhagHG94rts2+y1lZQ==",
      "v2": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ5Om1vdmllLm1rdmQwOmQ2Omxlbmd0aGkxMzIwNzFlMTE6cGllY2VzIHJvb3QzMjr5Na/az6oyWgB7llzSCy6SrRuB68c+gnC+iFOL+9J8vWVlZTEyOm1ldGEgdmVyc2lvbmkyZTQ6bmFtZTk6bW92aWUubWt2MTI6cGllY2UgbGVuZ3RoaTY1NTM2ZWUxMjpwaWVjZSBsYXllcnNkMzI6+TWv2s+qMloAe5Zc0gsukq0bgevHPoJwvohTi/vSfL05NjqP4kEwZNWxiHVkmjrMmyDwt9uP6exDW9zquRRvIbKC4+IVxRJULPjfJbabn/BV+UgOk6beFm2FlpLatBHGstnh8puzKcibadfiw8iyav9jgx1JsmUllhagHG94rts2+y1lZQ=="
    }
  },
  {
    "name": "single-file-exact",
    "torrentName": "exact.bin",
    "why": "single file landing exactly on a piece boundary: no trailing pad at all",
    "pieceLength": 65536,
    "single": true,
    "files": [
      {
        "path": [
          "exact.bin"
        ],
        "size": 65536,
        "seed": "single-file-exact/exact.bin",
        "root": "47783b0f6cb9a581f39bc6bd11d211aafeb180a3a199d3c432729a6e2e9b39ff",
        "layer": []
      }
    ],
    "torrents": {
      "v1": "ZDQ6aW5mb2Q2Omxlbmd0aGk2NTUzNmU0Om5hbWU5OmV4YWN0LmJpbjEyOnBpZWNlIGxlbmd0aGk2NTUzNmU2OnBpZWNlczIwOmZpySeqmzo4lerRTQtHVEuRQhAoZWU=",
      "hybrid": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ5OmV4YWN0LmJpbmQwOmQ2Omxlbmd0aGk2NTUzNmUxMTpwaWVjZXMgcm9vdDMyOkd4Ow9suaWB85vGvRHSEar+sYCjoZnTxDJymm4umzn/ZWVlNjpsZW5ndGhpNjU1MzZlMTI6bWV0YSB2ZXJzaW9uaTJlNDpuYW1lOTpleGFjdC5iaW4xMjpwaWVjZSBsZW5ndGhpNjU1MzZlNjpwaWVjZXMyMDpmacknqps6OJXq0U0LR1RLkUIQKGUxMjpwaWVjZSBsYXllcnNkZWU=",
      "v2": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ5OmV4YWN0LmJpbmQwOmQ2Omxlbmd0aGk2NTUzNmUxMTpwaWVjZXMgcm9vdDMyOkd4Ow9suaWB85vGvRHSEar+sYCjoZnTxDJymm4umzn/ZWVlMTI6bWV0YSB2ZXJzaW9uaTJlNDpuYW1lOTpleGFjdC5iaW4xMjpwaWVjZSBsZW5ndGhpNjU1MzZlZTEyOnBpZWNlIGxheWVyc2RlZQ=="
    }
  },
  {
    "name": "folder-one-file",
    "torrentName": "Pack",
    "why": "ONE file in a FOLDER, ending unaligned: libtorrent emits NO pad, because the rule counts files",
    "pieceLength": 65536,
    "single": false,
    "files": [
      {
        "path": [
          "only.mkv"
        ],
        "size": 100000,
        "seed": "folder-one-file/only.mkv",
        "root": "e2a8acfc72af4d1d25bb25ddd9b08ee4985532162c9def5bd9db05d87833b4a2",
        "layer": [
          "4174c64dddaba26da68f9551d3efe97c8697fd5e5e07b21216ee6c816d5451d8",
          "e72867809e464435dc2ce590d964631edad23288b2e43fa999ca3e601867dd4e"
        ]
      }
    ],
    "torrents": {
      "v1": "ZDQ6aW5mb2Q1OmZpbGVzbGQ2Omxlbmd0aGkxMDAwMDBlNDpwYXRobDg6b25seS5ta3ZlZWU0Om5hbWU0OlBhY2sxMjpwaWVjZSBsZW5ndGhpNjU1MzZlNjpwaWVjZXM0MDrxrolF5Ek6cHfSy/AKDsoq3eY05gplrZdf++hIAIZhsFFrGsfU6EuIZWU=",
      "hybrid": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ4Om9ubHkubWt2ZDA6ZDY6bGVuZ3RoaTEwMDAwMGUxMTpwaWVjZXMgcm9vdDMyOuKorPxyr00dJbsl3dmwjuSYVTIWLJ3vW9nbBdh4M7SiZWVlNTpmaWxlc2xkNjpsZW5ndGhpMTAwMDAwZTQ6cGF0aGw4Om9ubHkubWt2ZWVlMTI6bWV0YSB2ZXJzaW9uaTJlNDpuYW1lNDpQYWNrMTI6cGllY2UgbGVuZ3RoaTY1NTM2ZTY6cGllY2VzNDA68a6JReRJOnB30svwCg7KKt3mNOYKZa2XX/voSACGYbBRaxrH1OhLiGUxMjpwaWVjZSBsYXllcnNkMzI64qis/HKvTR0luyXd2bCO5JhVMhYsne9b2dsF2HgztKI2NDpBdMZN3auibaaPlVHT7+l8hpf9Xl4HshIW7myBbVRR2OcoZ4CeRkQ13CzlkNlkYx7a0jKIsuQ/qZnKPmAYZ91OZWU=",
      "v2": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ4Om9ubHkubWt2ZDA6ZDY6bGVuZ3RoaTEwMDAwMGUxMTpwaWVjZXMgcm9vdDMyOuKorPxyr00dJbsl3dmwjuSYVTIWLJ3vW9nbBdh4M7SiZWVlMTI6bWV0YSB2ZXJzaW9uaTJlNDpuYW1lNDpQYWNrMTI6cGllY2UgbGVuZ3RoaTY1NTM2ZWUxMjpwaWVjZSBsYXllcnNkMzI64qis/HKvTR0luyXd2bCO5JhVMhYsne9b2dsF2HgztKI2NDpBdMZN3auibaaPlVHT7+l8hpf9Xl4HshIW7myBbVRR2OcoZ4CeRkQ13CzlkNlkYx7a0jKIsuQ/qZnKPmAYZ91OZWU="
    }
  },
  {
    "name": "one-file-plus-empty",
    "torrentName": "Pack",
    "why": "the same file plus an empty one, so the count passes 1 and the pad DOES appear",
    "pieceLength": 65536,
    "single": false,
    "files": [
      {
        "path": [
          "a.mkv"
        ],
        "size": 100000,
        "seed": "one-file-plus-empty/a.mkv",
        "root": "3328113079aa0cdcfc17ca6cc7ab7fd398b5be004792caec7c8699291ee11ee7",
        "layer": [
          "2f6c5b5d43b184f83a49f1aeaddbd6950d16764ad696943b331f74dfce424210",
          "8f49bc4ec982098c9b157e8b9bd7cfea94bde5fab01138df70277837ef43082b"
        ]
      },
      {
        "path": [
          "z-empty.bin"
        ],
        "size": 0,
        "seed": "one-file-plus-empty/z-empty.bin",
        "root": null,
        "layer": []
      }
    ],
    "torrents": {
      "v1": "ZDQ6aW5mb2Q1OmZpbGVzbGQ2Omxlbmd0aGkxMDAwMDBlNDpwYXRobDU6YS5ta3ZlZWQ2Omxlbmd0aGkwZTQ6cGF0aGwxMTp6LWVtcHR5LmJpbmVlZTQ6bmFtZTQ6UGFjazEyOnBpZWNlIGxlbmd0aGk2NTUzNmU2OnBpZWNlczQwOkMz2+KhYIiZOVlK4cX9E1n0xnhuZNU7y8h9jS5NH8uIAhHipJ8OJvNlZQ==",
      "hybrid": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ1OmEubWt2ZDA6ZDY6bGVuZ3RoaTEwMDAwMGUxMTpwaWVjZXMgcm9vdDMyOjMoETB5qgzc/BfKbMerf9OYtb4AR5LK7HyGmSke4R7nZWUxMTp6LWVtcHR5LmJpbmQwOmQ2Omxlbmd0aGkwZWVlZTU6ZmlsZXNsZDY6bGVuZ3RoaTEwMDAwMGU0OnBhdGhsNTphLm1rdmVlZDQ6YXR0cjE6cDY6bGVuZ3RoaTMxMDcyZTQ6cGF0aGw0Oi5wYWQ1OjMxMDcyZWVkNjpsZW5ndGhpMGU0OnBhdGhsMTE6ei1lbXB0eS5iaW5lZWUxMjptZXRhIHZlcnNpb25pMmU0Om5hbWU0OlBhY2sxMjpwaWVjZSBsZW5ndGhpNjU1MzZlNjpwaWVjZXM0MDpDM9vioWCImTlZSuHF/RNZ9MZ4bl3GiOSVD0KE4/u6UCqQRONk3mS5ZTEyOnBpZWNlIGxheWVyc2QzMjozKBEweaoM3PwXymzHq3/TmLW+AEeSyux8hpkpHuEe5zY0Oi9sW11DsYT4Oknxrq3b1pUNFnZK1paUOzMfdN/OQkIQj0m8TsmCCYybFX6Lm9fP6pS95fqwETjfcCd4N+9DCCtlZQ==",
      "v2": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ1OmEubWt2ZDA6ZDY6bGVuZ3RoaTEwMDAwMGUxMTpwaWVjZXMgcm9vdDMyOjMoETB5qgzc/BfKbMerf9OYtb4AR5LK7HyGmSke4R7nZWUxMTp6LWVtcHR5LmJpbmQwOmQ2Omxlbmd0aGkwZWVlZTEyOm1ldGEgdmVyc2lvbmkyZTQ6bmFtZTQ6UGFjazEyOnBpZWNlIGxlbmd0aGk2NTUzNmVlMTI6cGllY2UgbGF5ZXJzZDMyOjMoETB5qgzc/BfKbMerf9OYtb4AR5LK7HyGmSke4R7nNjQ6L2xbXUOxhPg6SfGurdvWlQ0WdkrWlpQ7Mx90385CQhCPSbxOyYIJjJsVfoub18/qlL3l+rARON9wJ3g370MIK2Vl"
    }
  },
  {
    "name": "empty-first",
    "torrentName": "Pack",
    "why": "an empty file FIRST: no pad after it, and the tail pad still lands after the real one",
    "pieceLength": 65536,
    "single": false,
    "files": [
      {
        "path": [
          "a-empty.bin"
        ],
        "size": 0,
        "seed": "empty-first/a-empty.bin",
        "root": null,
        "layer": []
      },
      {
        "path": [
          "z.mkv"
        ],
        "size": 100000,
        "seed": "empty-first/z.mkv",
        "root": "8a8f2bc0adb5770c87c13cf333c2b3a3d09384a783bb4a91ef426243020dbe7b",
        "layer": [
          "afe2d0d8bcf715c209d5c422eaae97e184c8110513998dadedd13ac1eb8e4876",
          "b46ceec51d1bf9fc5471af4f07f21b46eb8e4f8e52d8f015c8a148488d2e000f"
        ]
      }
    ],
    "torrents": {
      "v1": "ZDQ6aW5mb2Q1OmZpbGVzbGQ2Omxlbmd0aGkwZTQ6cGF0aGwxMTphLWVtcHR5LmJpbmVlZDY6bGVuZ3RoaTEwMDAwMGU0OnBhdGhsNTp6Lm1rdmVlZTQ6bmFtZTQ6UGFjazEyOnBpZWNlIGxlbmd0aGk2NTUzNmU2OnBpZWNlczQwOuvOH4GL4ND9hpRjXRbt+zPEcFPEk8lqUgBWgbTcCHJpKoe1DcWhtXllZQ==",
      "hybrid": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQxMTphLWVtcHR5LmJpbmQwOmQ2Omxlbmd0aGkwZWVlNTp6Lm1rdmQwOmQ2Omxlbmd0aGkxMDAwMDBlMTE6cGllY2VzIHJvb3QzMjqKjyvArbV3DIfBPPMzwrOj0JOEp4O7SpHvQmJDAg2+e2VlZTU6ZmlsZXNsZDY6bGVuZ3RoaTBlNDpwYXRobDExOmEtZW1wdHkuYmluZWVkNjpsZW5ndGhpMTAwMDAwZTQ6cGF0aGw1OnoubWt2ZWVkNDphdHRyMTpwNjpsZW5ndGhpMzEwNzJlNDpwYXRobDQ6LnBhZDU6MzEwNzJlZWUxMjptZXRhIHZlcnNpb25pMmU0Om5hbWU0OlBhY2sxMjpwaWVjZSBsZW5ndGhpNjU1MzZlNjpwaWVjZXM0MDrrzh+Bi+DQ/YaUY10W7fszxHBTxAYMQ/LEuc/BH2x0v9WspohLrwBQZTEyOnBpZWNlIGxheWVyc2QzMjqKjyvArbV3DIfBPPMzwrOj0JOEp4O7SpHvQmJDAg2+ezY0Oq/i0Ni89xXCCdXEIuqul+GEyBEFE5mNre3ROsHrjkh2tGzuxR0b+fxUca9PB/IbRuuOT45S2PAVyKFISI0uAA9lZQ==",
      "v2": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQxMTphLWVtcHR5LmJpbmQwOmQ2Omxlbmd0aGkwZWVlNTp6Lm1rdmQwOmQ2Omxlbmd0aGkxMDAwMDBlMTE6cGllY2VzIHJvb3QzMjqKjyvArbV3DIfBPPMzwrOj0JOEp4O7SpHvQmJDAg2+e2VlZTEyOm1ldGEgdmVyc2lvbmkyZTQ6bmFtZTQ6UGFjazEyOnBpZWNlIGxlbmd0aGk2NTUzNmVlMTI6cGllY2UgbGF5ZXJzZDMyOoqPK8CttXcMh8E88zPCs6PQk4Sng7tKke9CYkMCDb57NjQ6r+LQ2Lz3FcIJ1cQi6q6X4YTIEQUTmY2t7dE6weuOSHa0bO7FHRv5/FRxr08H8htG645PjlLY8BXIoUhIjS4AD2Vl"
    }
  },
  {
    "name": "one-byte",
    "torrentName": "Pack",
    "why": "a single byte: one leaf, one piece, one sha1",
    "pieceLength": 65536,
    "single": false,
    "files": [
      {
        "path": [
          "tiny.bin"
        ],
        "size": 1,
        "seed": "one-byte/tiny.bin",
        "root": "50868f20258bbc9cce0da2719e8654c108733dd2f663b8737c574ec0ead93eb3",
        "layer": []
      }
    ],
    "torrents": {
      "v1": "ZDQ6aW5mb2Q1OmZpbGVzbGQ2Omxlbmd0aGkxZTQ6cGF0aGw4OnRpbnkuYmluZWVlNDpuYW1lNDpQYWNrMTI6cGllY2UgbGVuZ3RoaTY1NTM2ZTY6cGllY2VzMjA6c7dHNmZK2Fgozhvi4p+0po0kQCtlZQ==",
      "hybrid": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ4OnRpbnkuYmluZDA6ZDY6bGVuZ3RoaTFlMTE6cGllY2VzIHJvb3QzMjpQho8gJYu8nM4NonGehlTBCHM90vZjuHN8V07A6tk+s2VlZTU6ZmlsZXNsZDY6bGVuZ3RoaTFlNDpwYXRobDg6dGlueS5iaW5lZWUxMjptZXRhIHZlcnNpb25pMmU0Om5hbWU0OlBhY2sxMjpwaWVjZSBsZW5ndGhpNjU1MzZlNjpwaWVjZXMyMDpzt0c2ZkrYWCjOG+Lin7SmjSRAK2UxMjpwaWVjZSBsYXllcnNkZWU=",
      "v2": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ4OnRpbnkuYmluZDA6ZDY6bGVuZ3RoaTFlMTE6cGllY2VzIHJvb3QzMjpQho8gJYu8nM4NonGehlTBCHM90vZjuHN8V07A6tk+s2VlZTEyOm1ldGEgdmVyc2lvbmkyZTQ6bmFtZTQ6UGFjazEyOnBpZWNlIGxlbmd0aGk2NTUzNmVlMTI6cGllY2UgbGF5ZXJzZGVl"
    }
  },
  {
    "name": "exact-block",
    "torrentName": "Pack",
    "why": "LEAF-LEVEL padding: file under one piece with a non-power-of-two leaf count",
    "pieceLength": 65536,
    "single": false,
    "files": [
      {
        "path": [
          "block.bin"
        ],
        "size": 16384,
        "seed": "exact-block/block.bin",
        "root": "9de554cdb06e3690303ceefa782166572fd0c228f87fad47d624ee8fc1991649",
        "layer": []
      },
      {
        "path": [
          "two-blocks.bin"
        ],
        "size": 32768,
        "seed": "exact-block/two-blocks.bin",
        "root": "0d9b9fc02951d49d42fe64320e199ed47947421d69e4e1f01a3cc73328800294",
        "layer": []
      },
      {
        "path": [
          "three-blocks.bin"
        ],
        "size": 49152,
        "seed": "exact-block/three-blocks.bin",
        "root": "0140298c33aa8f2d7380292a06c403c417497e04bf1277fead251aa633ec2eaf",
        "layer": []
      }
    ],
    "torrents": {
      "v1": "ZDQ6aW5mb2Q1OmZpbGVzbGQ2Omxlbmd0aGkxNjM4NGU0OnBhdGhsOTpibG9jay5iaW5lZWQ2Omxlbmd0aGkzMjc2OGU0OnBhdGhsMTQ6dHdvLWJsb2Nrcy5iaW5lZWQ2Omxlbmd0aGk0OTE1MmU0OnBhdGhsMTY6dGhyZWUtYmxvY2tzLmJpbmVlZTQ6bmFtZTQ6UGFjazEyOnBpZWNlIGxlbmd0aGk2NTUzNmU2OnBpZWNlczQwOmVkPDRizAbwRpCkUqgvHGMUSth8M9tbSJzY+v/LYyoY3tSW2YNc3tdlZQ==",
      "hybrid": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ5OmJsb2NrLmJpbmQwOmQ2Omxlbmd0aGkxNjM4NGUxMTpwaWVjZXMgcm9vdDMyOp3lVM2wbjaQMDzu+nghZlcv0MIo+H+tR9Yk7o/BmRZJZWUxNjp0aHJlZS1ibG9ja3MuYmluZDA6ZDY6bGVuZ3RoaTQ5MTUyZTExOnBpZWNlcyByb290MzI6AUApjDOqjy1zgCkqBsQDxBdJfgS/Enf+rSUapjPsLq9lZTE0OnR3by1ibG9ja3MuYmluZDA6ZDY6bGVuZ3RoaTMyNzY4ZTExOnBpZWNlcyByb290MzI6DZufwClR1J1C/mQyDhme1HlHQh1p5OHwGjzHMyiAApRlZWU1OmZpbGVzbGQ2Omxlbmd0aGkxNjM4NGU0OnBhdGhsOTpibG9jay5iaW5lZWQ0OmF0dHIxOnA2Omxlbmd0aGk0OTE1MmU0OnBhdGhsNDoucGFkNTo0OTE1MmVlZDY6bGVuZ3RoaTQ5MTUyZTQ6cGF0aGwxNjp0aHJlZS1ibG9ja3MuYmluZWVkNDphdHRyMTpwNjpsZW5ndGhpMTYzODRlNDpwYXRobDQ6LnBhZDU6MTYzODRlZWQ2Omxlbmd0aGkzMjc2OGU0OnBhdGhsMTQ6dHdvLWJsb2Nrcy5iaW5lZWQ0OmF0dHIxOnA2Omxlbmd0aGkzMjc2OGU0OnBhdGhsNDoucGFkNTozMjc2OGVlZTEyOm1ldGEgdmVyc2lvbmkyZTQ6bmFtZTQ6UGFjazEyOnBpZWNlIGxlbmd0aGk2NTUzNmU2OnBpZWNlczYwOowAvcGHfwyZPCMF0ErKVQ0Wut7qhuoA88helH2EwPF/e84NpdIeQbjPdCGhUzn5yKlzE1FvlsMwPMEKdWUxMjpwaWVjZSBsYXllcnNkZWU=",
      "v2": "ZDQ6aW5mb2Q5OmZpbGUgdHJlZWQ5OmJsb2NrLmJpbmQwOmQ2Omxlbmd0aGkxNjM4NGUxMTpwaWVjZXMgcm9vdDMyOp3lVM2wbjaQMDzu+nghZlcv0MIo+H+tR9Yk7o/BmRZJZWUxNjp0aHJlZS1ibG9ja3MuYmluZDA6ZDY6bGVuZ3RoaTQ5MTUyZTExOnBpZWNlcyByb290MzI6AUApjDOqjy1zgCkqBsQDxBdJfgS/Enf+rSUapjPsLq9lZTE0OnR3by1ibG9ja3MuYmluZDA6ZDY6bGVuZ3RoaTMyNzY4ZTExOnBpZWNlcyByb290MzI6DZufwClR1J1C/mQyDhme1HlHQh1p5OHwGjzHMyiAApRlZWUxMjptZXRhIHZlcnNpb25pMmU0Om5hbWU0OlBhY2sxMjpwaWVjZSBsZW5ndGhpNjU1MzZlZTEyOnBpZWNlIGxheWVyc2RlZQ=="
    }
  }
]

