#!/usr/bin/env python3
"""Explicit one-time model download. Prompt hooks never download model files.

Downloads ms-marco-MiniLM-L-12-v2 into FLASHRANK_CACHE_DIR, else $ZOUROBOROS_CACHE_DIR/wayfinder,
else ~/.cache/wayfinder, and prints the directory. This is the only network step Wayfinder has.
"""
import sys
from pathlib import Path

if any(a in ('-h', '--help') for a in sys.argv[1:]):
    print(__doc__.strip())
    raise SystemExit(0)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
import local_rank  # noqa: E402
from flashrank import Ranker  # noqa: E402

cache = local_rank.model_cache()
Ranker(model_name=local_rank.CROSS_ENCODER, cache_dir=cache)
print(str(Path(cache).resolve()))
