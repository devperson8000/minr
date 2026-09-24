import hashlib
import unittest

import miner


class MinerProtocolTests(unittest.TestCase):
    def test_sha256d(self):
        data = b"knxcoin"
        expected = hashlib.sha256(hashlib.sha256(data).digest()).digest()
        self.assertEqual(miner.sha256d(data), expected)

    def test_header_is_bitcoin_sized(self):
        header = miner.header_bytes(
            1,
            "00" * 32,
            "11" * 32,
            1_700_000_000,
            0x1D00FFFF,
            42,
        )
        self.assertEqual(len(header), 80)

    def test_merkle_single_txid_is_same_txid(self):
        txid = "12" * 32
        self.assertEqual(miner.merkle_root([txid]), txid)

    def test_coinbase_is_deterministic_and_extra_nonce_sensitive(self):
        template = {
            "height": 10,
            "miner_address": "knx_test",
            "subsidy_shards": "500",
            "fees_shards": "20",
        }
        a = miner.coinbase_txid(template, "0000000000000001")
        b = miner.coinbase_txid(template, "0000000000000001")
        c = miner.coinbase_txid(template, "0000000000000002")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)
        self.assertEqual(len(a), 64)


if __name__ == "__main__":
    unittest.main()
